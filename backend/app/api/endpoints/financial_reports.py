"""
Smart Finance Core - Financial Reports API
업로드된 계정별 원장 데이터 기반 재무보고서
- 손익계산서: 한국 회계 기준 (매출액→매출원가→매출총이익→판관비→영업이익...)
- 재무상태표: 자산/부채/자본 분류
- 시산표, 월별 추이
"""
import math
import re
from decimal import Decimal
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, and_

from app.core.database import get_db
from app.core.security import get_current_user
from app.models.user import User
from app.models.ai import AIRawTransactionData, AIDataUploadHistory
from app.models.accounting import Account, AccountCategory

router = APIRouter()


# ============ Helpers ============

async def _validate_upload(db: AsyncSession, upload_id: int) -> AIDataUploadHistory:
    upload = await db.get(AIDataUploadHistory, upload_id)
    if not upload:
        raise HTTPException(status_code=404, detail="업로드 이력을 찾을 수 없습니다.")
    return upload


def _extract_month(date_str: str) -> Optional[str]:
    """다양한 날짜 형식에서 YYYY-MM 추출"""
    if not date_str:
        return None
    match = re.match(r'(\d{4})[.\-/](\d{1,2})', date_str.strip())
    if match:
        return f"{match.group(1)}-{match.group(2).zfill(2)}"
    return None


def _date_filters(year: Optional[int], month: Optional[int]):
    """날짜 필터 생성"""
    filters = []
    if year and month:
        prefix = f"{year}-{str(month).zfill(2)}"
        prefix2 = f"{year}.{str(month).zfill(2)}"
        filters.append(
            (AIRawTransactionData.transaction_date.like(f"{prefix}%"))
            | (AIRawTransactionData.transaction_date.like(f"{prefix2}%"))
        )
    elif year:
        filters.append(
            (AIRawTransactionData.transaction_date.like(f"{year}-%"))
            | (AIRawTransactionData.transaction_date.like(f"{year}.%"))
        )
    return filters


async def _resolve_source_account_names(db: AsyncSession, upload_id: int, codes: list) -> dict:
    """원장 계정코드(source_account_code) → 이름 매핑
    1) Account 테이블 조회
    2) 없으면 '계정 {code}' 폴백
    """
    if not codes:
        return {}
    result = await db.execute(
        select(Account.code, Account.name).where(Account.code.in_(codes))
    )
    names = {r.code: r.name for r in result.all()}
    for c in codes:
        if c not in names or not names[c]:
            names[c] = f"계정 {c}"
    return names


async def _resolve_account_names(db: AsyncSession, upload_id: int, codes: list) -> dict:
    """계정 코드 → 이름 매핑 (accounts 테이블 → raw data fallback)"""
    if not codes:
        return {}
    result = await db.execute(
        select(Account.code, Account.name).where(Account.code.in_(codes))
    )
    names = {r.code: r.name for r in result.all()}
    missing = [c for c in codes if c not in names]
    if missing:
        raw_result = await db.execute(
            select(
                AIRawTransactionData.account_code,
                func.max(AIRawTransactionData.account_name).label("name"),
            )
            .where(
                AIRawTransactionData.upload_id == upload_id,
                AIRawTransactionData.account_code.in_(missing),
                AIRawTransactionData.account_name.isnot(None),
                AIRawTransactionData.account_name != "",
            )
            .group_by(AIRawTransactionData.account_code)
        )
        names.update({r.account_code: r.name for r in raw_result.all()})
    for c in codes:
        if c not in names or not names[c]:
            names[c] = f"계정 {c}"
    return names


# ============ Endpoints ============

@router.get("/summary")
async def get_financial_summary(
    upload_id: int = Query(...),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """재무 요약 - 대시보드용 핵심 지표"""
    upload = await _validate_upload(db, upload_id)

    totals = await db.execute(
        select(
            func.coalesce(func.sum(AIRawTransactionData.debit_amount), 0).label("total_debit"),
            func.coalesce(func.sum(AIRawTransactionData.credit_amount), 0).label("total_credit"),
            func.count(AIRawTransactionData.id).label("tx_count"),
        ).where(AIRawTransactionData.upload_id == upload_id)
    )
    t = totals.one()

    acct_count = await db.scalar(
        select(func.count(func.distinct(AIRawTransactionData.source_account_code)))
        .where(
            AIRawTransactionData.upload_id == upload_id,
            AIRawTransactionData.source_account_code.isnot(None),
        )
    ) or 0

    return {
        "upload_id": upload_id,
        "filename": upload.filename,
        "total_debit": float(t.total_debit),
        "total_credit": float(t.total_credit),
        "total_transactions": t.tx_count,
        "account_count": acct_count,
    }


@router.get("/trial-balance")
async def get_trial_balance(
    upload_id: int = Query(...),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """시산표 - 원장 계정(source_account_code)별 차변/대변 합계"""
    await _validate_upload(db, upload_id)

    # 원장 계정별 집계
    result = await db.execute(
        select(
            AIRawTransactionData.source_account_code,
            func.coalesce(func.sum(AIRawTransactionData.debit_amount), 0).label("debit_total"),
            func.coalesce(func.sum(AIRawTransactionData.credit_amount), 0).label("credit_total"),
            func.count(AIRawTransactionData.id).label("tx_count"),
        )
        .where(
            AIRawTransactionData.upload_id == upload_id,
            AIRawTransactionData.source_account_code.isnot(None),
            AIRawTransactionData.source_account_code != "",
        )
        .group_by(AIRawTransactionData.source_account_code)
        .order_by(AIRawTransactionData.source_account_code)
    )
    rows = result.all()

    codes = [r.source_account_code for r in rows]
    names = await _resolve_source_account_names(db, upload_id, codes)

    # 카테고리 매핑 (첫 자리 기준)
    DIGIT_CATEGORY = {
        '1': '자산', '2': '부채', '3': '자본',
        '4': '수익', '5': '매출원가', '6': '비용',
        '7': '비용', '8': '판관비', '9': '영업외',
    }

    items = []
    total_debit = 0.0
    total_credit = 0.0
    for r in rows:
        d = float(r.debit_total)
        c = float(r.credit_total)
        total_debit += d
        total_credit += c
        code = r.source_account_code
        cat_name = DIGIT_CATEGORY.get(code[0], '미분류') if code else '미분류'
        items.append({
            "account_code": code,
            "account_name": names.get(code, f"계정 {code}"),
            "category_name": cat_name,
            "debit_total": d,
            "credit_total": c,
            "balance": d - c,
            "tx_count": r.tx_count,
        })

    return {
        "upload_id": upload_id,
        "items": items,
        "total_debit": total_debit,
        "total_credit": total_credit,
    }


@router.get("/income-statement")
async def get_income_statement(
    upload_id: int = Query(...),
    year: Optional[int] = Query(None),
    month: Optional[int] = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    손익계산서 - 한국 회계 기준
    원장 계정(source_account_code) 기준으로 분류:
      4xx = 매출액 (수익: 대변-차변)
      5xx = 매출원가 (비용: 차변-대변)
      8xx = 판매비와관리비 (비용: 차변-대변)
      9xx = 영업외손익 (방향에 따라 수익/비용)
    """
    await _validate_upload(db, upload_id)

    filters = [
        AIRawTransactionData.upload_id == upload_id,
        AIRawTransactionData.source_account_code.isnot(None),
        AIRawTransactionData.source_account_code != "",
    ]
    filters.extend(_date_filters(year, month))

    # 원장 계정별 차변/대변 합계
    result = await db.execute(
        select(
            AIRawTransactionData.source_account_code,
            func.coalesce(func.sum(AIRawTransactionData.debit_amount), 0).label("debit_total"),
            func.coalesce(func.sum(AIRawTransactionData.credit_amount), 0).label("credit_total"),
            func.count(AIRawTransactionData.id).label("tx_count"),
        )
        .where(*filters)
        .group_by(AIRawTransactionData.source_account_code)
        .order_by(AIRawTransactionData.source_account_code)
    )
    rows = result.all()

    codes = [r.source_account_code for r in rows]
    names = await _resolve_source_account_names(db, upload_id, codes)

    # 분류
    revenue_items = []       # I. 매출액 (4xx)
    cogs_items = []          # II. 매출원가 (5xx)
    sga_items = []           # IV. 판매비와관리비 (8xx)
    non_op_income_items = [] # VI. 영업외수익 (9xx 대변>차변)
    non_op_expense_items = []# VII. 영업외비용 (9xx 차변>대변)

    for r in rows:
        code = r.source_account_code
        d = float(r.debit_total)
        c = float(r.credit_total)
        first_digit = code[0] if code else '0'
        acct_name = names.get(code, f"계정 {code}")

        item = {
            "code": code,
            "name": acct_name,
            "debit": d,
            "credit": c,
            "tx_count": r.tx_count,
        }

        if first_digit == '4':
            # 수익 계정: 정상잔액 = 대변. 금액 = 대변 - 차변
            item["amount"] = c - d
            revenue_items.append(item)
        elif first_digit == '5':
            # 매출원가: 정상잔액 = 차변. 금액 = 차변 - 대변
            item["amount"] = d - c
            cogs_items.append(item)
        elif first_digit == '8':
            # 판관비: 정상잔액 = 차변. 금액 = 차변 - 대변
            item["amount"] = d - c
            sga_items.append(item)
        elif first_digit == '9':
            # 영업외: 순액 방향에 따라 수익/비용 분류
            net = c - d  # 대변 > 차변이면 수익
            if net >= 0:
                item["amount"] = net
                non_op_income_items.append(item)
            else:
                item["amount"] = -net  # 양수로 표시
                non_op_expense_items.append(item)
        # 1xx, 2xx, 3xx는 재무상태표 항목이므로 손익계산서에서 제외

    # 금액 기준 내림차순 정렬
    revenue_items.sort(key=lambda x: x["amount"], reverse=True)
    cogs_items.sort(key=lambda x: x["amount"], reverse=True)
    sga_items.sort(key=lambda x: x["amount"], reverse=True)
    non_op_income_items.sort(key=lambda x: x["amount"], reverse=True)
    non_op_expense_items.sort(key=lambda x: x["amount"], reverse=True)

    # 합계 계산
    revenue_total = sum(i["amount"] for i in revenue_items)        # I. 매출액
    cogs_total = sum(i["amount"] for i in cogs_items)              # II. 매출원가
    gross_profit = revenue_total - cogs_total                       # III. 매출총이익
    sga_total = sum(i["amount"] for i in sga_items)                # IV. 판관비
    operating_income = gross_profit - sga_total                     # V. 영업이익
    non_op_income_total = sum(i["amount"] for i in non_op_income_items)   # VI. 영업외수익
    non_op_expense_total = sum(i["amount"] for i in non_op_expense_items) # VII. 영업외비용
    pre_tax_income = operating_income + non_op_income_total - non_op_expense_total  # VIII
    tax = 0  # 법인세 (별도 계정 있으면 추출)
    net_income = pre_tax_income - tax  # X. 당기순이익

    # 비율 계산 (매출액 대비 %)
    def pct(val: float) -> float:
        if revenue_total == 0:
            return 0.0
        return round(val / revenue_total * 100, 2)

    sections = [
        {
            "id": "I",
            "name": "매출액",
            "items": [{"code": i["code"], "name": i["name"], "amount": i["amount"]} for i in revenue_items],
            "total": revenue_total,
            "pct": 100.0 if revenue_total > 0 else 0.0,
        },
        {
            "id": "II",
            "name": "매출원가",
            "items": [{"code": i["code"], "name": i["name"], "amount": i["amount"]} for i in cogs_items],
            "total": cogs_total,
            "pct": pct(cogs_total),
        },
        {
            "id": "III",
            "name": "매출총이익",
            "items": [],
            "total": gross_profit,
            "pct": pct(gross_profit),
            "is_subtotal": True,
        },
        {
            "id": "IV",
            "name": "판매비와관리비",
            "items": [{"code": i["code"], "name": i["name"], "amount": i["amount"]} for i in sga_items],
            "total": sga_total,
            "pct": pct(sga_total),
        },
        {
            "id": "V",
            "name": "영업이익",
            "items": [],
            "total": operating_income,
            "pct": pct(operating_income),
            "is_subtotal": True,
        },
        {
            "id": "VI",
            "name": "영업외수익",
            "items": [{"code": i["code"], "name": i["name"], "amount": i["amount"]} for i in non_op_income_items],
            "total": non_op_income_total,
            "pct": pct(non_op_income_total),
        },
        {
            "id": "VII",
            "name": "영업외비용",
            "items": [{"code": i["code"], "name": i["name"], "amount": i["amount"]} for i in non_op_expense_items],
            "total": non_op_expense_total,
            "pct": pct(non_op_expense_total),
        },
        {
            "id": "VIII",
            "name": "법인세차감전순이익",
            "items": [],
            "total": pre_tax_income,
            "pct": pct(pre_tax_income),
            "is_subtotal": True,
        },
        {
            "id": "IX",
            "name": "법인세등",
            "items": [],
            "total": tax,
            "pct": pct(tax),
        },
        {
            "id": "X",
            "name": "당기순이익",
            "items": [],
            "total": net_income,
            "pct": pct(net_income),
            "is_subtotal": True,
        },
    ]

    return {
        "upload_id": upload_id,
        "year": year,
        "month": month,
        "sections": sections,
        "revenue_total": revenue_total,
        "net_income": net_income,
    }


@router.get("/balance-sheet")
async def get_balance_sheet(
    upload_id: int = Query(...),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    재무상태표 - 한국 회계 기준
    원장 계정(source_account_code) 기준 분류:
      1xx = 자산 (차변-대변)
      2xx = 부채 (대변-차변)
      3xx = 자본 (대변-차변)
    """
    upload = await _validate_upload(db, upload_id)

    result = await db.execute(
        select(
            AIRawTransactionData.source_account_code,
            func.coalesce(func.sum(AIRawTransactionData.debit_amount), 0).label("debit_total"),
            func.coalesce(func.sum(AIRawTransactionData.credit_amount), 0).label("credit_total"),
            func.count(AIRawTransactionData.id).label("tx_count"),
        )
        .where(
            AIRawTransactionData.upload_id == upload_id,
            AIRawTransactionData.source_account_code.isnot(None),
            AIRawTransactionData.source_account_code != "",
        )
        .group_by(AIRawTransactionData.source_account_code)
        .order_by(AIRawTransactionData.source_account_code)
    )
    rows = result.all()

    codes = [r.source_account_code for r in rows]
    names = await _resolve_source_account_names(db, upload_id, codes)

    # 분류
    current_asset_items = []     # 유동자산 (10x~15x)
    noncurrent_asset_items = []  # 비유동자산 (16x~19x)
    current_liab_items = []      # 유동부채 (20x~24x)
    noncurrent_liab_items = []   # 비유동부채 (25x~29x)
    equity_items = []            # 자본 (3xx)

    for r in rows:
        code = r.source_account_code
        d = float(r.debit_total)
        c = float(r.credit_total)
        first_digit = code[0] if code else '0'
        second_digit = int(code[1]) if code and len(code) > 1 and code[1].isdigit() else 0
        acct_name = names.get(code, f"계정 {code}")

        if first_digit == '1':
            # 자산: 정상잔액 = 차변. 금액 = 차변 - 대변
            item = {"code": code, "name": acct_name, "amount": d - c}
            if second_digit <= 5:
                current_asset_items.append(item)
            else:
                noncurrent_asset_items.append(item)
        elif first_digit == '2':
            # 부채: 정상잔액 = 대변. 금액 = 대변 - 차변
            item = {"code": code, "name": acct_name, "amount": c - d}
            if second_digit <= 4:
                current_liab_items.append(item)
            else:
                noncurrent_liab_items.append(item)
        elif first_digit == '3':
            # 자본: 정상잔액 = 대변. 금액 = 대변 - 차변
            equity_items.append({"code": code, "name": acct_name, "amount": c - d})
        # 4xx~9xx는 손익계산서 항목

    # 합계
    current_asset_total = sum(i["amount"] for i in current_asset_items)
    noncurrent_asset_total = sum(i["amount"] for i in noncurrent_asset_items)
    total_assets = current_asset_total + noncurrent_asset_total

    current_liab_total = sum(i["amount"] for i in current_liab_items)
    noncurrent_liab_total = sum(i["amount"] for i in noncurrent_liab_items)
    total_liabilities = current_liab_total + noncurrent_liab_total

    equity_total = sum(i["amount"] for i in equity_items)

    sections = [
        {
            "id": "assets",
            "name": "자산",
            "subsections": [
                {
                    "name": "I. 유동자산",
                    "items": current_asset_items,
                    "total": current_asset_total,
                },
                {
                    "name": "II. 비유동자산",
                    "items": noncurrent_asset_items,
                    "total": noncurrent_asset_total,
                },
            ],
            "total": total_assets,
        },
        {
            "id": "liabilities",
            "name": "부채",
            "subsections": [
                {
                    "name": "I. 유동부채",
                    "items": current_liab_items,
                    "total": current_liab_total,
                },
                {
                    "name": "II. 비유동부채",
                    "items": noncurrent_liab_items,
                    "total": noncurrent_liab_total,
                },
            ],
            "total": total_liabilities,
        },
        {
            "id": "equity",
            "name": "자본",
            "subsections": [
                {
                    "name": "자본 항목",
                    "items": equity_items,
                    "total": equity_total,
                },
            ],
            "total": equity_total,
        },
    ]

    return {
        "upload_id": upload_id,
        "filename": upload.filename,
        "sections": sections,
        "total_assets": total_assets,
        "total_liabilities": total_liabilities,
        "total_equity": equity_total,
    }


@router.get("/monthly-trend")
async def get_monthly_trend(
    upload_id: int = Query(...),
    account_code: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """월별 추이 - 원장 계정별 월간 집계"""
    await _validate_upload(db, upload_id)

    filters = [
        AIRawTransactionData.upload_id == upload_id,
        AIRawTransactionData.transaction_date.isnot(None),
        AIRawTransactionData.transaction_date != "",
    ]
    if account_code:
        filters.append(
            (AIRawTransactionData.source_account_code == account_code)
            | (AIRawTransactionData.account_code == account_code)
        )

    result = await db.execute(
        select(
            AIRawTransactionData.transaction_date,
            AIRawTransactionData.debit_amount,
            AIRawTransactionData.credit_amount,
        ).where(*filters)
    )
    rows = result.all()

    monthly: dict = {}
    for r in rows:
        month_key = _extract_month(str(r.transaction_date))
        if not month_key:
            continue
        if month_key not in monthly:
            monthly[month_key] = {"debit": 0.0, "credit": 0.0, "count": 0}
        monthly[month_key]["debit"] += float(r.debit_amount or 0)
        monthly[month_key]["credit"] += float(r.credit_amount or 0)
        monthly[month_key]["count"] += 1

    data = []
    for key in sorted(monthly.keys()):
        m = monthly[key]
        data.append({
            "month": key,
            "debit_total": m["debit"],
            "credit_total": m["credit"],
            "net": m["debit"] - m["credit"],
            "tx_count": m["count"],
        })

    return {
        "upload_id": upload_id,
        "account_code": account_code,
        "data": data,
    }


@router.get("/account-detail")
async def get_account_detail(
    upload_id: int = Query(...),
    account_code: str = Query(...),
    page: int = Query(default=1, ge=1),
    size: int = Query(default=50, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """계정별 거래 상세 조회"""
    await _validate_upload(db, upload_id)

    base_filter = and_(
        AIRawTransactionData.upload_id == upload_id,
        (AIRawTransactionData.source_account_code == account_code)
        | (AIRawTransactionData.account_code == account_code),
    )

    total = await db.scalar(
        select(func.count(AIRawTransactionData.id)).where(base_filter)
    ) or 0

    total_pages = max(1, math.ceil(total / size))

    summary_result = await db.execute(
        select(
            func.coalesce(func.sum(AIRawTransactionData.debit_amount), 0).label("debit_total"),
            func.coalesce(func.sum(AIRawTransactionData.credit_amount), 0).label("credit_total"),
        ).where(base_filter)
    )
    s = summary_result.one()

    offset = (page - 1) * size
    data_result = await db.execute(
        select(AIRawTransactionData)
        .where(base_filter)
        .order_by(AIRawTransactionData.transaction_date, AIRawTransactionData.row_number)
        .offset(offset)
        .limit(size)
    )
    rows = data_result.scalars().all()

    return {
        "upload_id": upload_id,
        "account_code": account_code,
        "total": total,
        "page": page,
        "size": size,
        "total_pages": total_pages,
        "items": [
            {
                "row_number": r.row_number,
                "transaction_date": r.transaction_date,
                "description": r.original_description,
                "merchant_name": r.merchant_name,
                "debit_amount": float(r.debit_amount),
                "credit_amount": float(r.credit_amount),
                "account_code": r.account_code,
                "source_account_code": r.source_account_code,
            }
            for r in rows
        ],
        "summary": {
            "debit_total": float(s.debit_total),
            "credit_total": float(s.credit_total),
            "balance": float(s.debit_total) - float(s.credit_total),
        },
    }
