"""
Smart Finance Core - Financial Reports API
업로드된 계정별 원장 데이터 기반 재무보고서
- 손익계산서: 계정 카테고리별 분류 (수익/비용)
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
        select(func.count(func.distinct(AIRawTransactionData.account_code)))
        .where(AIRawTransactionData.upload_id == upload_id)
    ) or 0

    # 상위 출금(대변) 계정 Top 5
    top_outflow_result = await db.execute(
        select(
            AIRawTransactionData.account_code,
            func.sum(AIRawTransactionData.credit_amount).label("total"),
        )
        .where(AIRawTransactionData.upload_id == upload_id)
        .group_by(AIRawTransactionData.account_code)
        .order_by(func.sum(AIRawTransactionData.credit_amount).desc())
        .limit(5)
    )
    top_outflows = top_outflow_result.all()
    top_codes = [r.account_code for r in top_outflows]
    top_names = await _resolve_account_names(db, upload_id, top_codes)

    # 상위 입금(차변) 계정 Top 5
    top_inflow_result = await db.execute(
        select(
            AIRawTransactionData.account_code,
            func.sum(AIRawTransactionData.debit_amount).label("total"),
        )
        .where(AIRawTransactionData.upload_id == upload_id)
        .group_by(AIRawTransactionData.account_code)
        .order_by(func.sum(AIRawTransactionData.debit_amount).desc())
        .limit(5)
    )
    top_inflows = top_inflow_result.all()
    in_codes = [r.account_code for r in top_inflows]
    in_names = await _resolve_account_names(db, upload_id, in_codes)

    source_result = await db.execute(
        select(func.distinct(AIRawTransactionData.source_account_code))
        .where(
            AIRawTransactionData.upload_id == upload_id,
            AIRawTransactionData.source_account_code.isnot(None),
            AIRawTransactionData.source_account_code != "",
        )
    )
    source_codes = [r[0] for r in source_result.all()]

    return {
        "upload_id": upload_id,
        "filename": upload.filename,
        "source_accounts": source_codes,
        "total_inflow": float(t.total_debit),
        "total_outflow": float(t.total_credit),
        "net_balance": float(t.total_debit - t.total_credit),
        "total_transactions": t.tx_count,
        "account_count": acct_count,
        "top_inflows": [
            {"account_code": r.account_code, "account_name": in_names.get(r.account_code, ""), "amount": float(r.total)}
            for r in top_inflows if float(r.total) > 0
        ],
        "top_outflows": [
            {"account_code": r.account_code, "account_name": top_names.get(r.account_code, ""), "amount": float(r.total)}
            for r in top_outflows if float(r.total) > 0
        ],
    }


@router.get("/trial-balance")
async def get_trial_balance(
    upload_id: int = Query(...),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """시산표 - 계정별 차변/대변 합계 (카테고리 포함)"""
    await _validate_upload(db, upload_id)

    result = await db.execute(
        select(
            AIRawTransactionData.account_code,
            AccountCategory.code.label("cat_code"),
            AccountCategory.name.label("cat_name"),
            func.coalesce(func.sum(AIRawTransactionData.debit_amount), 0).label("debit_total"),
            func.coalesce(func.sum(AIRawTransactionData.credit_amount), 0).label("credit_total"),
            func.count(AIRawTransactionData.id).label("tx_count"),
        )
        .outerjoin(Account, AIRawTransactionData.account_code == Account.code)
        .outerjoin(AccountCategory, Account.category_id == AccountCategory.id)
        .where(AIRawTransactionData.upload_id == upload_id)
        .group_by(
            AIRawTransactionData.account_code,
            AccountCategory.code,
            AccountCategory.name,
        )
        .order_by(AccountCategory.code, AIRawTransactionData.account_code)
    )
    rows = result.all()

    codes = [r.account_code for r in rows]
    names = await _resolve_account_names(db, upload_id, codes)

    items = []
    total_debit = 0.0
    total_credit = 0.0
    for r in rows:
        d = float(r.debit_total)
        c = float(r.credit_total)
        total_debit += d
        total_credit += c
        items.append({
            "account_code": r.account_code,
            "account_name": names.get(r.account_code, f"계정 {r.account_code}"),
            "category_code": r.cat_code or "0",
            "category_name": r.cat_name or "미분류",
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
    손익계산서 - 계정 카테고리별 분류
    수익(4): 매출, 영업수익 등
    비용(5): 판매비, 관리비, 매출원가 등
    기타(1,2,3,0): 자산/부채/자본 관련 거래
    """
    await _validate_upload(db, upload_id)

    filters = [AIRawTransactionData.upload_id == upload_id]
    filters.extend(_date_filters(year, month))

    # JOIN with Account/AccountCategory for proper classification
    result = await db.execute(
        select(
            AIRawTransactionData.account_code,
            AccountCategory.code.label("cat_code"),
            AccountCategory.name.label("cat_name"),
            func.coalesce(func.sum(AIRawTransactionData.debit_amount), 0).label("debit_total"),
            func.coalesce(func.sum(AIRawTransactionData.credit_amount), 0).label("credit_total"),
            func.count(AIRawTransactionData.id).label("tx_count"),
        )
        .outerjoin(Account, AIRawTransactionData.account_code == Account.code)
        .outerjoin(AccountCategory, Account.category_id == AccountCategory.id)
        .where(*filters)
        .group_by(
            AIRawTransactionData.account_code,
            AccountCategory.code,
            AccountCategory.name,
        )
        .order_by(
            AccountCategory.code,
            func.coalesce(
                func.sum(AIRawTransactionData.debit_amount)
                + func.sum(AIRawTransactionData.credit_amount), 0
            ).desc()
        )
    )
    rows = result.all()

    codes = [r.account_code for r in rows]
    names = await _resolve_account_names(db, upload_id, codes)

    # Category ordering and Korean labels
    CATEGORY_ORDER = {
        "4": {"name": "수익 (매출)", "order": 1},
        "5": {"name": "비용 (판매비와관리비)", "order": 2},
        "1": {"name": "자산 관련", "order": 3},
        "2": {"name": "부채 관련", "order": 4},
        "3": {"name": "자본 관련", "order": 5},
        "0": {"name": "미분류", "order": 6},
    }

    sections = {}
    for r in rows:
        cat_code = r.cat_code or "0"
        cat_info = CATEGORY_ORDER.get(cat_code, {"name": r.cat_name or "기타", "order": 9})

        if cat_code not in sections:
            sections[cat_code] = {
                "category_code": cat_code,
                "category_name": cat_info["name"],
                "order": cat_info["order"],
                "items": [],
                "debit_total": 0.0,
                "credit_total": 0.0,
            }

        d = float(r.debit_total)
        c = float(r.credit_total)
        acct_name = names.get(r.account_code, f"계정 {r.account_code}")

        sections[cat_code]["items"].append({
            "account_code": r.account_code,
            "account_name": acct_name,
            "debit_amount": d,
            "credit_amount": c,
            "net_amount": d - c,
            "tx_count": r.tx_count,
        })
        sections[cat_code]["debit_total"] += d
        sections[cat_code]["credit_total"] += c

    # Sort sections by order
    sorted_sections = sorted(sections.values(), key=lambda x: x.pop("order"))

    # Calculate totals
    # Revenue: from bank ledger, revenue appears as debit (cash in)
    rev = sections.get("4", {"debit_total": 0.0, "credit_total": 0.0})
    total_revenue = rev["debit_total"]

    # Expenses: from bank ledger, expenses appear as credit (cash out)
    exp = sections.get("5", {"debit_total": 0.0, "credit_total": 0.0})
    total_expense = exp["credit_total"]

    # Total inflow/outflow across all categories
    total_inflow = sum(s["debit_total"] for s in sections.values())
    total_outflow = sum(s["credit_total"] for s in sections.values())

    return {
        "upload_id": upload_id,
        "year": year,
        "month": month,
        "sections": sorted_sections,
        "total_revenue": total_revenue,
        "total_expense": total_expense,
        "net_income": total_revenue - total_expense,
        "total_inflow": total_inflow,
        "total_outflow": total_outflow,
        "net_flow": total_inflow - total_outflow,
    }


@router.get("/balance-sheet")
async def get_balance_sheet(
    upload_id: int = Query(...),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    재무상태표 - 자산/부채/자본 분류
    자산(1): 유동자산, 비유동자산
    부채(2): 유동부채, 비유동부채
    자본(3): 자본금, 이익잉여금 등
    """
    upload = await _validate_upload(db, upload_id)

    # 원장 계정(source_account_code)별 잔액
    source_result = await db.execute(
        select(
            AIRawTransactionData.source_account_code,
            func.coalesce(func.sum(AIRawTransactionData.debit_amount), 0).label("total_debit"),
            func.coalesce(func.sum(AIRawTransactionData.credit_amount), 0).label("total_credit"),
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
    source_rows = source_result.all()
    source_codes = [r.source_account_code for r in source_rows]
    source_names = await _resolve_account_names(db, upload_id, source_codes)

    # 상대 계정별 잔액 - 카테고리 포함
    counter_result = await db.execute(
        select(
            AIRawTransactionData.account_code,
            AccountCategory.code.label("cat_code"),
            AccountCategory.name.label("cat_name"),
            func.coalesce(func.sum(AIRawTransactionData.debit_amount), 0).label("total_debit"),
            func.coalesce(func.sum(AIRawTransactionData.credit_amount), 0).label("total_credit"),
            func.count(AIRawTransactionData.id).label("tx_count"),
        )
        .outerjoin(Account, AIRawTransactionData.account_code == Account.code)
        .outerjoin(AccountCategory, Account.category_id == AccountCategory.id)
        .where(AIRawTransactionData.upload_id == upload_id)
        .group_by(
            AIRawTransactionData.account_code,
            AccountCategory.code,
            AccountCategory.name,
        )
        .order_by(
            AccountCategory.code,
            func.coalesce(
                func.sum(AIRawTransactionData.debit_amount)
                + func.sum(AIRawTransactionData.credit_amount), 0
            ).desc()
        )
    )
    counter_rows = counter_result.all()
    counter_codes = [r.account_code for r in counter_rows]
    counter_names = await _resolve_account_names(db, upload_id, counter_codes)

    BS_CATEGORY = {
        "1": {"name": "자산", "order": 1},
        "2": {"name": "부채", "order": 2},
        "3": {"name": "자본", "order": 3},
        "4": {"name": "수익 (손익)", "order": 4},
        "5": {"name": "비용 (손익)", "order": 5},
        "0": {"name": "미분류", "order": 6},
    }

    sections = {}
    for r in counter_rows:
        cat_code = r.cat_code or "0"
        cat_info = BS_CATEGORY.get(cat_code, {"name": r.cat_name or "기타", "order": 9})

        if cat_code not in sections:
            sections[cat_code] = {
                "category_code": cat_code,
                "category_name": cat_info["name"],
                "order": cat_info["order"],
                "items": [],
                "debit_total": 0.0,
                "credit_total": 0.0,
            }

        d = float(r.total_debit)
        c = float(r.total_credit)
        sections[cat_code]["items"].append({
            "account_code": r.account_code,
            "account_name": counter_names.get(r.account_code, f"계정 {r.account_code}"),
            "debit_total": d,
            "credit_total": c,
            "balance": d - c,
            "tx_count": r.tx_count,
        })
        sections[cat_code]["debit_total"] += d
        sections[cat_code]["credit_total"] += c

    sorted_sections = sorted(sections.values(), key=lambda x: x.pop("order"))

    # Source account (원장) totals
    ledger_accounts = []
    total_debit = 0.0
    total_credit = 0.0
    for r in source_rows:
        d = float(r.total_debit)
        c = float(r.total_credit)
        total_debit += d
        total_credit += c
        ledger_accounts.append({
            "account_code": r.source_account_code,
            "account_name": source_names.get(r.source_account_code, f"계정 {r.source_account_code}"),
            "debit_total": d,
            "credit_total": c,
            "balance": d - c,
            "tx_count": r.tx_count,
        })

    # Calculate balance sheet totals
    asset_section = sections.get("1", {"debit_total": 0, "credit_total": 0})
    liability_section = sections.get("2", {"debit_total": 0, "credit_total": 0})
    equity_section = sections.get("3", {"debit_total": 0, "credit_total": 0})

    return {
        "upload_id": upload_id,
        "filename": upload.filename,
        "ledger_accounts": ledger_accounts,
        "sections": sorted_sections,
        "total_debit": total_debit,
        "total_credit": total_credit,
        "net_balance": total_debit - total_credit,
        "total_assets": asset_section["debit_total"] - asset_section["credit_total"],
        "total_liabilities": liability_section["credit_total"] - liability_section["debit_total"],
        "total_equity": equity_section["credit_total"] - equity_section["debit_total"],
    }


@router.get("/monthly-trend")
async def get_monthly_trend(
    upload_id: int = Query(...),
    account_code: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """월별 추이 - 입금/출금 월별 집계"""
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
