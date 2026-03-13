"""
Smart Finance Core - Financial Reports API
업로드된 계정별 원장 데이터 기반 재무보고서 (기간 기반)

변경: upload_id 단건 필터 → 기간(year) 기반 전체 데이터 조회
- 여러 파일을 나눠 업로드해도 같은 기간이면 합산
- 계정별 원장에서 source_account_code(원장계정)와 account_code(상대계정) 구분
"""
import math
import re
from decimal import Decimal
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, and_, or_

from app.core.database import get_db
from app.core.security import get_current_user
from app.models.user import User
from app.models.ai import AIRawTransactionData, AIDataUploadHistory
from app.models.accounting import Account, AccountCategory

router = APIRouter()


# ============ Helpers ============

def _date_filters(year: Optional[int], month: Optional[int]):
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


def _extract_month(date_str: str) -> Optional[str]:
    if not date_str:
        return None
    match = re.match(r'(\d{4})[.\-/](\d{1,2})', date_str.strip())
    if match:
        return f"{match.group(1)}-{match.group(2).zfill(2)}"
    return None


async def _resolve_names(db: AsyncSession, codes: list, mode: str = "multi") -> dict:
    """계정 코드 → 이름 매핑"""
    if not codes:
        return {}

    names = {}

    # 1) source_account_name에서 원장 계정명 조회 (multi 모드)
    if mode == "multi":
        raw_result = await db.execute(
            select(
                AIRawTransactionData.source_account_code,
                func.max(AIRawTransactionData.source_account_name).label("name"),
            )
            .where(
                AIRawTransactionData.source_account_code.in_(codes),
                AIRawTransactionData.source_account_name.isnot(None),
                AIRawTransactionData.source_account_name != "",
            )
            .group_by(AIRawTransactionData.source_account_code)
        )
        names.update({r.source_account_code: r.name for r in raw_result.all()})

    # 2) Account 테이블에서 보충
    missing = [c for c in codes if c not in names]
    if missing:
        result = await db.execute(
            select(Account.code, Account.name).where(Account.code.in_(missing))
        )
        names.update({r.code: r.name for r in result.all()})

    # 3) raw data의 account_code/account_name에서 보충
    missing = [c for c in codes if c not in names]
    if missing:
        raw_result = await db.execute(
            select(
                AIRawTransactionData.account_code,
                func.max(AIRawTransactionData.account_name).label("name"),
            )
            .where(
                AIRawTransactionData.account_code.in_(missing),
                AIRawTransactionData.account_name.isnot(None),
                AIRawTransactionData.account_name != "",
            )
            .group_by(AIRawTransactionData.account_code)
        )
        names.update({r.account_code: r.name for r in raw_result.all()})

    # 4) 최종 fallback
    for c in codes:
        if c not in names or not names[c]:
            names[c] = f"계정 {c}"
    return names


async def _detect_ledger_mode(db: AsyncSession, extra_filters: list = None) -> str:
    """원장 모드 감지: 'multi' (전체 계정별 원장) 또는 'single' (단일 계정 원장)"""
    filters = [
        AIRawTransactionData.source_account_code.isnot(None),
        AIRawTransactionData.source_account_code != "",
    ]
    if extra_filters:
        filters.extend(extra_filters)

    source_count = await db.scalar(
        select(func.count(func.distinct(AIRawTransactionData.source_account_code)))
        .where(*filters)
    ) or 0

    return "multi" if source_count >= 3 else "single"


async def _get_account_balances(
    db: AsyncSession, mode: str, extra_filters: list = None
) -> list:
    """계정별 잔액 집계 (기간 필터 적용)"""
    filters = []
    if extra_filters:
        filters.extend(extra_filters)

    if mode == "multi":
        filters.extend([
            AIRawTransactionData.source_account_code.isnot(None),
            AIRawTransactionData.source_account_code != "",
        ])
        group_col = AIRawTransactionData.source_account_code
    else:
        group_col = AIRawTransactionData.account_code

    q = select(
        group_col.label("code"),
        func.coalesce(func.sum(AIRawTransactionData.debit_amount), 0).label("debit_total"),
        func.coalesce(func.sum(AIRawTransactionData.credit_amount), 0).label("credit_total"),
        func.count(AIRawTransactionData.id).label("tx_count"),
    )
    if filters:
        q = q.where(*filters)
    q = q.group_by(group_col).order_by(group_col)

    result = await db.execute(q)
    return result.all()


async def _detect_years(db: AsyncSession) -> List[int]:
    """DB에 있는 모든 연도 감지"""
    result = await db.execute(
        select(AIRawTransactionData.transaction_date)
        .where(
            AIRawTransactionData.transaction_date.isnot(None),
            AIRawTransactionData.transaction_date != "",
        )
        .distinct()
        .limit(1000)
    )
    years = set()
    for row in result.all():
        m = re.match(r'(\d{4})', str(row.transaction_date).strip())
        if m:
            years.add(int(m.group(1)))
    return sorted(years, reverse=True)


# ============ Endpoints ============

@router.get("/available-years")
async def get_available_years(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """조회 가능한 연도 목록"""
    years = await _detect_years(db)

    # 업로드 이력도 함께 반환
    from app.models.ai import UploadStatus
    uploads_result = await db.execute(
        select(AIDataUploadHistory)
        .where(AIDataUploadHistory.status == UploadStatus.COMPLETED)
        .order_by(AIDataUploadHistory.created_at.desc())
        .limit(50)
    )
    uploads = uploads_result.scalars().all()

    total_rows = await db.scalar(
        select(func.count(AIRawTransactionData.id))
    ) or 0

    return {
        "years": years,
        "total_raw_rows": total_rows,
        "uploads": [
            {
                "id": u.id,
                "filename": u.filename,
                "saved_count": u.saved_count or 0,
                "created_at": u.created_at.isoformat() if u.created_at else None,
            }
            for u in uploads
        ],
    }


@router.get("/summary")
async def get_financial_summary(
    year: Optional[int] = Query(None),
    upload_id: Optional[int] = Query(None),  # 하위호환
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """재무 요약 (기간 기반)"""
    filters = []
    if year:
        filters.extend(_date_filters(year, None))

    q = select(
        func.coalesce(func.sum(AIRawTransactionData.debit_amount), 0).label("total_debit"),
        func.coalesce(func.sum(AIRawTransactionData.credit_amount), 0).label("total_credit"),
        func.count(AIRawTransactionData.id).label("tx_count"),
    )
    if filters:
        q = q.where(*filters)

    totals = await db.execute(q)
    t = totals.one()

    mode = await _detect_ledger_mode(db, filters)
    years = await _detect_years(db)

    return {
        "year": year,
        "total_debit": float(t.total_debit),
        "total_credit": float(t.total_credit),
        "total_transactions": t.tx_count,
        "ledger_mode": mode,
        "available_years": years,
    }


@router.get("/trial-balance")
async def get_trial_balance(
    year: Optional[int] = Query(None),
    upload_id: Optional[int] = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """시산표 - 계정별 차변/대변 합계 (기간 기반)"""
    filters = _date_filters(year, None) if year else []
    mode = await _detect_ledger_mode(db, filters)
    rows = await _get_account_balances(db, mode, filters)

    codes = [r.code for r in rows]
    names = await _resolve_names(db, codes, mode)

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
        code = r.code
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
        "year": year,
        "items": items,
        "total_debit": total_debit,
        "total_credit": total_credit,
        "ledger_mode": mode,
    }


@router.get("/income-statement")
async def get_income_statement(
    year: Optional[int] = Query(None),
    month: Optional[int] = Query(None),
    upload_id: Optional[int] = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """손익계산서 - 한국 회계 기준 (기간 기반)"""
    # 연도 미지정시 최신 연도 자동
    if year is None:
        years = await _detect_years(db)
        if years:
            year = years[0]

    extra_filters = _date_filters(year, month)
    mode = await _detect_ledger_mode(db, extra_filters)
    rows = await _get_account_balances(db, mode, extra_filters)

    codes = [r.code for r in rows]
    names = await _resolve_names(db, codes, mode)

    revenue_items = []
    cogs_items = []
    sga_items = []
    non_op_income_items = []
    non_op_expense_items = []

    for r in rows:
        code = r.code
        d = float(r.debit_total)
        c = float(r.credit_total)
        first_digit = code[0] if code else '0'
        acct_name = names.get(code, f"계정 {code}")

        item = {"code": code, "name": acct_name, "debit": d, "credit": c, "tx_count": r.tx_count}

        if mode == "multi":
            if first_digit == '4':
                item["amount"] = c - d
                revenue_items.append(item)
            elif first_digit == '5':
                item["amount"] = d - c
                cogs_items.append(item)
            elif first_digit in ('6', '7', '8'):
                # 6xx, 7xx, 8xx 모두 판관비/비용으로 처리
                item["amount"] = d - c
                sga_items.append(item)
            elif first_digit == '9':
                net = c - d
                if net >= 0:
                    item["amount"] = net
                    non_op_income_items.append(item)
                else:
                    item["amount"] = -net
                    non_op_expense_items.append(item)
        else:
            if first_digit == '4':
                item["amount"] = d
                revenue_items.append(item)
            elif first_digit == '5':
                item["amount"] = c
                cogs_items.append(item)
            elif first_digit in ('6', '7', '8'):
                item["amount"] = c
                sga_items.append(item)
            elif first_digit == '9':
                if d > c:
                    item["amount"] = d - c
                    non_op_income_items.append(item)
                elif c > d:
                    item["amount"] = c - d
                    non_op_expense_items.append(item)

    for arr in [revenue_items, cogs_items, sga_items, non_op_income_items, non_op_expense_items]:
        arr.sort(key=lambda x: x["amount"], reverse=True)

    revenue_total = sum(i["amount"] for i in revenue_items)
    cogs_total = sum(i["amount"] for i in cogs_items)
    gross_profit = revenue_total - cogs_total
    sga_total = sum(i["amount"] for i in sga_items)
    operating_income = gross_profit - sga_total
    non_op_income_total = sum(i["amount"] for i in non_op_income_items)
    non_op_expense_total = sum(i["amount"] for i in non_op_expense_items)
    pre_tax_income = operating_income + non_op_income_total - non_op_expense_total
    tax = 0
    net_income = pre_tax_income - tax

    def pct(val):
        return round(val / revenue_total * 100, 2) if revenue_total else 0.0

    def make_items(arr):
        return [{"code": i["code"], "name": i["name"], "amount": i["amount"]} for i in arr]

    sections = [
        {"id": "I", "name": "매출액", "items": make_items(revenue_items), "total": revenue_total, "pct": 100.0 if revenue_total > 0 else 0.0},
        {"id": "II", "name": "매출원가", "items": make_items(cogs_items), "total": cogs_total, "pct": pct(cogs_total)},
        {"id": "III", "name": "매출총이익", "items": [], "total": gross_profit, "pct": pct(gross_profit), "is_subtotal": True},
        {"id": "IV", "name": "판매비와관리비", "items": make_items(sga_items), "total": sga_total, "pct": pct(sga_total)},
        {"id": "V", "name": "영업이익", "items": [], "total": operating_income, "pct": pct(operating_income), "is_subtotal": True},
        {"id": "VI", "name": "영업외수익", "items": make_items(non_op_income_items), "total": non_op_income_total, "pct": pct(non_op_income_total)},
        {"id": "VII", "name": "영업외비용", "items": make_items(non_op_expense_items), "total": non_op_expense_total, "pct": pct(non_op_expense_total)},
        {"id": "VIII", "name": "법인세차감전순이익", "items": [], "total": pre_tax_income, "pct": pct(pre_tax_income), "is_subtotal": True},
        {"id": "IX", "name": "법인세등", "items": [], "total": tax, "pct": pct(tax)},
        {"id": "X", "name": "당기순이익", "items": [], "total": net_income, "pct": pct(net_income), "is_subtotal": True},
    ]

    return {
        "year": year,
        "month": month,
        "ledger_mode": mode,
        "sections": sections,
        "revenue_total": revenue_total,
        "net_income": net_income,
    }


@router.get("/balance-sheet")
async def get_balance_sheet(
    year: Optional[int] = Query(None),
    upload_id: Optional[int] = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """재무상태표 (기간 기반)"""
    filters = _date_filters(year, None) if year else []
    mode = await _detect_ledger_mode(db, filters)
    rows = await _get_account_balances(db, mode, filters)

    codes = [r.code for r in rows]
    names = await _resolve_names(db, codes, mode)

    current_asset_items = []
    noncurrent_asset_items = []
    current_liab_items = []
    noncurrent_liab_items = []
    equity_items = []

    for r in rows:
        code = r.code
        d = float(r.debit_total)
        c = float(r.credit_total)
        first_digit = code[0] if code else '0'
        second_digit = int(code[1]) if code and len(code) > 1 and code[1].isdigit() else 0
        acct_name = names.get(code, f"계정 {code}")

        if first_digit == '1':
            amount = d - c if mode == "multi" else c - d
            item = {"code": code, "name": acct_name, "amount": amount}
            if second_digit <= 5:
                current_asset_items.append(item)
            else:
                noncurrent_asset_items.append(item)
        elif first_digit == '2':
            amount = c - d if mode == "multi" else d - c
            item = {"code": code, "name": acct_name, "amount": amount}
            if second_digit <= 4:
                current_liab_items.append(item)
            else:
                noncurrent_liab_items.append(item)
        elif first_digit == '3':
            amount = c - d if mode == "multi" else d - c
            equity_items.append({"code": code, "name": acct_name, "amount": amount})

    current_asset_total = sum(i["amount"] for i in current_asset_items)
    noncurrent_asset_total = sum(i["amount"] for i in noncurrent_asset_items)
    total_assets = current_asset_total + noncurrent_asset_total
    current_liab_total = sum(i["amount"] for i in current_liab_items)
    noncurrent_liab_total = sum(i["amount"] for i in noncurrent_liab_items)
    total_liabilities = current_liab_total + noncurrent_liab_total
    equity_total = sum(i["amount"] for i in equity_items)

    sections = [
        {"id": "assets", "name": "자산", "subsections": [
            {"name": "I. 유동자산", "items": current_asset_items, "total": current_asset_total},
            {"name": "II. 비유동자산", "items": noncurrent_asset_items, "total": noncurrent_asset_total},
        ], "total": total_assets},
        {"id": "liabilities", "name": "부채", "subsections": [
            {"name": "I. 유동부채", "items": current_liab_items, "total": current_liab_total},
            {"name": "II. 비유동부채", "items": noncurrent_liab_items, "total": noncurrent_liab_total},
        ], "total": total_liabilities},
        {"id": "equity", "name": "자본", "subsections": [
            {"name": "자본 항목", "items": equity_items, "total": equity_total},
        ], "total": equity_total},
    ]

    return {
        "year": year,
        "ledger_mode": mode,
        "sections": sections,
        "total_assets": total_assets,
        "total_liabilities": total_liabilities,
        "total_equity": equity_total,
    }


@router.get("/monthly-trend")
async def get_monthly_trend(
    year: Optional[int] = Query(None),
    account_code: Optional[str] = Query(None),
    upload_id: Optional[int] = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """월별 추이 (기간 기반)"""
    filters = [
        AIRawTransactionData.transaction_date.isnot(None),
        AIRawTransactionData.transaction_date != "",
    ]
    if year:
        filters.extend(_date_filters(year, None))
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
        "year": year,
        "account_code": account_code,
        "data": data,
    }


@router.get("/account-detail")
async def get_account_detail(
    account_code: str = Query(...),
    year: Optional[int] = Query(None),
    upload_id: Optional[int] = Query(None),
    page: int = Query(default=1, ge=1),
    size: int = Query(default=50, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """계정별 거래 상세 조회 (기간 기반)"""
    filters = [
        (AIRawTransactionData.source_account_code == account_code)
        | (AIRawTransactionData.account_code == account_code),
    ]
    if year:
        filters.extend(_date_filters(year, None))

    base_filter = and_(*filters)

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
        "account_code": account_code,
        "year": year,
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
