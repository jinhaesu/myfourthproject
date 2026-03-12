"""
Smart Finance Core - Financial Reports API
더존 계정별 원장 데이터 기반 재무제표 생성
시산표, 손익계산서, 재무상태표, 월별 추이, 계정별 상세
"""
import math
from datetime import date
from decimal import Decimal
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, case as sa_case, and_, cast, String

from app.core.database import get_db
from app.core.security import get_current_user
from app.models.user import User
from app.models.ai import AIRawTransactionData, AIDataUploadHistory
from app.models.accounting import Account

router = APIRouter()


# ============ Response Models ============

class TrialBalanceItem(BaseModel):
    account_code: str
    account_name: str
    debit_total: float
    credit_total: float
    balance: float


class TrialBalanceResponse(BaseModel):
    upload_id: int
    as_of_date: Optional[str] = None
    items: List[TrialBalanceItem]
    total_debit: float
    total_credit: float


class PnlLineItem(BaseModel):
    account_code: str
    account_name: str
    amount: float


class IncomeStatementResponse(BaseModel):
    upload_id: int
    from_date: Optional[str] = None
    to_date: Optional[str] = None
    revenues: List[PnlLineItem]
    expenses: List[PnlLineItem]
    total_revenue: float
    total_expense: float
    net_income: float


class BalanceSheetItem(BaseModel):
    account_code: str
    account_name: str
    amount: float


class BalanceSheetResponse(BaseModel):
    upload_id: int
    assets: List[BalanceSheetItem]
    liabilities: List[BalanceSheetItem]
    equity: List[BalanceSheetItem]
    total_assets: float
    total_liabilities: float
    total_equity: float


class MonthlyTrendItem(BaseModel):
    month: str
    debit_total: float
    credit_total: float
    net: float


class MonthlyTrendResponse(BaseModel):
    upload_id: int
    account_code: Optional[str] = None
    data: List[MonthlyTrendItem]


class AccountDetailItem(BaseModel):
    row_number: int
    transaction_date: Optional[str] = None
    description: str
    merchant_name: Optional[str] = None
    debit_amount: float
    credit_amount: float
    account_code: str
    source_account_code: Optional[str] = None


class AccountDetailResponse(BaseModel):
    upload_id: int
    account_code: str
    total: int
    page: int
    size: int
    total_pages: int
    items: List[AccountDetailItem]
    summary: dict


# ============ Helper functions ============

def _classify_account_type(source_account_code: Optional[str]) -> str:
    """
    Classify account type based on source_account_code (원장 계정).

    더존 계정별 원장에서:
    - source_account_code: 원장 계정 (보통예금 103 등)
    - account_code: 상대계정 (거래 상대방의 계정코드)

    분류 기준 (한국 표준 계정과목 체계):
    - 1xx: 자산 (Assets)
    - 2xx: 부채 (Liabilities)
    - 3xx: 자본 (Equity)
    - 4xx: 수익 (Revenue)
    - 5xx~9xx: 비용 (Expenses)

    더존 코드가 6자리인 경우 (예: 098000) 앞자리 기준:
    - 0xx: 자산으로 처리
    """
    if not source_account_code:
        return "unknown"

    code = source_account_code.strip()
    if not code:
        return "unknown"

    first_char = code[0]

    if first_char in ('0', '1'):
        return "asset"
    elif first_char == '2':
        return "liability"
    elif first_char == '3':
        return "equity"
    elif first_char == '4':
        return "revenue"
    elif first_char in ('5', '6', '7', '8', '9'):
        return "expense"
    else:
        return "unknown"


async def _get_account_name_map(
    db: AsyncSession, codes: list
) -> dict:
    """Build a map of account_code -> account_name from accounts table."""
    if not codes:
        return {}
    result = await db.execute(
        select(Account.code, Account.name).where(Account.code.in_(codes))
    )
    return {row.code: row.name for row in result.all()}


async def _get_raw_account_names(
    db: AsyncSession, upload_id: int, codes: list
) -> dict:
    """
    Fallback: get account names from raw data account_name column.
    Groups by account_code and picks the first non-empty account_name.
    """
    if not codes:
        return {}
    result = await db.execute(
        select(
            AIRawTransactionData.account_code,
            func.max(AIRawTransactionData.account_name).label("name")
        )
        .where(
            AIRawTransactionData.upload_id == upload_id,
            AIRawTransactionData.account_code.in_(codes),
            AIRawTransactionData.account_name.isnot(None),
            AIRawTransactionData.account_name != "",
        )
        .group_by(AIRawTransactionData.account_code)
    )
    return {row.account_code: row.name for row in result.all()}


async def _resolve_account_names(
    db: AsyncSession, upload_id: int, codes: list
) -> dict:
    """
    Resolve account code -> name. First checks accounts table,
    then falls back to raw data's account_name column,
    then uses generic label.
    """
    names = await _get_account_name_map(db, codes)
    missing = [c for c in codes if c not in names]
    if missing:
        raw_names = await _get_raw_account_names(db, upload_id, missing)
        names.update(raw_names)
    # Fill any remaining blanks
    for c in codes:
        if c not in names or not names[c]:
            names[c] = f"계정 {c}"
    return names


async def _validate_upload(db: AsyncSession, upload_id: int) -> AIDataUploadHistory:
    """Validate upload exists."""
    upload = await db.get(AIDataUploadHistory, upload_id)
    if not upload:
        raise HTTPException(
            status_code=404,
            detail=f"업로드 ID {upload_id}를 찾을 수 없습니다."
        )
    return upload


# ============ API Endpoints ============

@router.get("/trial-balance", response_model=TrialBalanceResponse)
async def get_trial_balance(
    upload_id: int = Query(..., description="업로드 ID"),
    as_of_date: Optional[str] = Query(None, description="기준일 (YYYY-MM-DD 또는 YYYY.MM.DD)"),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    시산표 (Trial Balance)

    계정코드별 차변/대변 합계를 집계합니다.
    source_account_code(원장 계정)와 account_code(상대 계정) 모두를 기준으로
    통합 시산표를 생성합니다.
    """
    await _validate_upload(db, upload_id)

    # Build date filter
    filters = [AIRawTransactionData.upload_id == upload_id]
    if as_of_date:
        # Normalize date format (handle both YYYY-MM-DD and YYYY.MM.DD)
        normalized_date = as_of_date.replace(".", "-")
        filters.append(AIRawTransactionData.transaction_date <= normalized_date)

    # Aggregate by source_account_code (원장 계정) - this is the primary ledger
    source_query = (
        select(
            AIRawTransactionData.source_account_code.label("code"),
            func.coalesce(func.sum(AIRawTransactionData.debit_amount), 0).label("debit_total"),
            func.coalesce(func.sum(AIRawTransactionData.credit_amount), 0).label("credit_total"),
        )
        .where(
            *filters,
            AIRawTransactionData.source_account_code.isnot(None),
            AIRawTransactionData.source_account_code != "",
        )
        .group_by(AIRawTransactionData.source_account_code)
    )
    source_result = await db.execute(source_query)
    source_rows = source_result.all()

    # Also aggregate by account_code (상대 계정) for counterpart view
    counter_query = (
        select(
            AIRawTransactionData.account_code.label("code"),
            func.coalesce(func.sum(AIRawTransactionData.debit_amount), 0).label("debit_total"),
            func.coalesce(func.sum(AIRawTransactionData.credit_amount), 0).label("credit_total"),
        )
        .where(*filters)
        .group_by(AIRawTransactionData.account_code)
    )
    counter_result = await db.execute(counter_query)
    counter_rows = counter_result.all()

    # Merge: source accounts first, then counterpart accounts not already present
    seen_codes = set()
    merged = {}

    for row in source_rows:
        code = row.code
        seen_codes.add(code)
        merged[code] = {
            "debit_total": float(row.debit_total),
            "credit_total": float(row.credit_total),
        }

    for row in counter_rows:
        code = row.code
        if code not in merged:
            merged[code] = {
                "debit_total": float(row.debit_total),
                "credit_total": float(row.credit_total),
            }
        # If the code already exists from source, we keep the source view
        # as the primary perspective

    all_codes = list(merged.keys())
    names = await _resolve_account_names(db, upload_id, all_codes)

    items = []
    total_debit = 0.0
    total_credit = 0.0

    for code in sorted(merged.keys()):
        d = merged[code]
        balance = d["debit_total"] - d["credit_total"]
        items.append(TrialBalanceItem(
            account_code=code,
            account_name=names.get(code, f"계정 {code}"),
            debit_total=d["debit_total"],
            credit_total=d["credit_total"],
            balance=balance,
        ))
        total_debit += d["debit_total"]
        total_credit += d["credit_total"]

    return TrialBalanceResponse(
        upload_id=upload_id,
        as_of_date=as_of_date,
        items=items,
        total_debit=total_debit,
        total_credit=total_credit,
    )


@router.get("/income-statement", response_model=IncomeStatementResponse)
async def get_income_statement(
    upload_id: int = Query(..., description="업로드 ID"),
    from_date: Optional[str] = Query(None, description="시작일"),
    to_date: Optional[str] = Query(None, description="종료일"),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    손익계산서 (Income Statement / P&L)

    더존 계정별 원장에서:
    - source_account_code의 첫 자리가 4 -> 수익 계정
    - source_account_code의 첫 자리가 5~9 -> 비용 계정
    - account_code(상대계정)도 참고하여 분류

    수익 계정: 대변이 수익 증가, 차변이 수익 감소
    비용 계정: 차변이 비용 증가, 대변이 비용 감소
    """
    await _validate_upload(db, upload_id)

    filters = [AIRawTransactionData.upload_id == upload_id]
    if from_date:
        normalized = from_date.replace(".", "-")
        filters.append(AIRawTransactionData.transaction_date >= normalized)
    if to_date:
        normalized = to_date.replace(".", "-")
        filters.append(AIRawTransactionData.transaction_date <= normalized)

    # Strategy: aggregate by source_account_code, classify by first digit
    query = (
        select(
            AIRawTransactionData.source_account_code.label("code"),
            func.coalesce(func.sum(AIRawTransactionData.debit_amount), 0).label("debit_total"),
            func.coalesce(func.sum(AIRawTransactionData.credit_amount), 0).label("credit_total"),
        )
        .where(
            *filters,
            AIRawTransactionData.source_account_code.isnot(None),
            AIRawTransactionData.source_account_code != "",
        )
        .group_by(AIRawTransactionData.source_account_code)
    )
    result = await db.execute(query)
    rows = result.all()

    # Also check account_code perspective for codes not in source_account_code
    counter_query = (
        select(
            AIRawTransactionData.account_code.label("code"),
            func.coalesce(func.sum(AIRawTransactionData.debit_amount), 0).label("debit_total"),
            func.coalesce(func.sum(AIRawTransactionData.credit_amount), 0).label("credit_total"),
        )
        .where(*filters)
        .group_by(AIRawTransactionData.account_code)
    )
    counter_result = await db.execute(counter_query)
    counter_rows = counter_result.all()

    # Combine source_account and account_code perspectives
    all_accounts = {}
    for row in rows:
        code = row.code
        acct_type = _classify_account_type(code)
        if acct_type in ("revenue", "expense"):
            all_accounts[code] = {
                "type": acct_type,
                "debit": float(row.debit_total),
                "credit": float(row.credit_total),
            }

    for row in counter_rows:
        code = row.code
        if code in all_accounts:
            continue  # already from source
        acct_type = _classify_account_type(code)
        if acct_type in ("revenue", "expense"):
            all_accounts[code] = {
                "type": acct_type,
                "debit": float(row.debit_total),
                "credit": float(row.credit_total),
            }

    all_codes = list(all_accounts.keys())
    names = await _resolve_account_names(db, upload_id, all_codes)

    revenues = []
    expenses = []
    total_revenue = 0.0
    total_expense = 0.0

    for code in sorted(all_accounts.keys()):
        data = all_accounts[code]
        if data["type"] == "revenue":
            # Revenue: credit increases, debit decreases -> net = credit - debit
            amount = data["credit"] - data["debit"]
            revenues.append(PnlLineItem(
                account_code=code,
                account_name=names.get(code, f"계정 {code}"),
                amount=amount,
            ))
            total_revenue += amount
        elif data["type"] == "expense":
            # Expense: debit increases, credit decreases -> net = debit - credit
            amount = data["debit"] - data["credit"]
            expenses.append(PnlLineItem(
                account_code=code,
                account_name=names.get(code, f"계정 {code}"),
                amount=amount,
            ))
            total_expense += amount

    return IncomeStatementResponse(
        upload_id=upload_id,
        from_date=from_date,
        to_date=to_date,
        revenues=revenues,
        expenses=expenses,
        total_revenue=total_revenue,
        total_expense=total_expense,
        net_income=total_revenue - total_expense,
    )


@router.get("/balance-sheet", response_model=BalanceSheetResponse)
async def get_balance_sheet(
    upload_id: int = Query(..., description="업로드 ID"),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    재무상태표 (Balance Sheet)

    source_account_code 기준:
    - 0xx/1xx: 자산 (Assets) -> 잔액 = 차변합 - 대변합
    - 2xx: 부채 (Liabilities) -> 잔액 = 대변합 - 차변합
    - 3xx: 자본 (Equity) -> 잔액 = 대변합 - 차변합
    """
    await _validate_upload(db, upload_id)

    filters = [AIRawTransactionData.upload_id == upload_id]

    # Aggregate by source_account_code
    query = (
        select(
            AIRawTransactionData.source_account_code.label("code"),
            func.coalesce(func.sum(AIRawTransactionData.debit_amount), 0).label("debit_total"),
            func.coalesce(func.sum(AIRawTransactionData.credit_amount), 0).label("credit_total"),
        )
        .where(
            *filters,
            AIRawTransactionData.source_account_code.isnot(None),
            AIRawTransactionData.source_account_code != "",
        )
        .group_by(AIRawTransactionData.source_account_code)
    )
    result = await db.execute(query)
    rows = result.all()

    # Also from account_code perspective
    counter_query = (
        select(
            AIRawTransactionData.account_code.label("code"),
            func.coalesce(func.sum(AIRawTransactionData.debit_amount), 0).label("debit_total"),
            func.coalesce(func.sum(AIRawTransactionData.credit_amount), 0).label("credit_total"),
        )
        .where(*filters)
        .group_by(AIRawTransactionData.account_code)
    )
    counter_result = await db.execute(counter_query)
    counter_rows = counter_result.all()

    all_accounts = {}
    for row in rows:
        code = row.code
        acct_type = _classify_account_type(code)
        if acct_type in ("asset", "liability", "equity"):
            all_accounts[code] = {
                "type": acct_type,
                "debit": float(row.debit_total),
                "credit": float(row.credit_total),
            }

    for row in counter_rows:
        code = row.code
        if code in all_accounts:
            continue
        acct_type = _classify_account_type(code)
        if acct_type in ("asset", "liability", "equity"):
            all_accounts[code] = {
                "type": acct_type,
                "debit": float(row.debit_total),
                "credit": float(row.credit_total),
            }

    all_codes = list(all_accounts.keys())
    names = await _resolve_account_names(db, upload_id, all_codes)

    assets = []
    liabilities = []
    equity_list = []
    total_assets = 0.0
    total_liabilities = 0.0
    total_equity = 0.0

    for code in sorted(all_accounts.keys()):
        data = all_accounts[code]

        if data["type"] == "asset":
            # Asset: normal balance is debit -> amount = debit - credit
            amount = data["debit"] - data["credit"]
            assets.append(BalanceSheetItem(
                account_code=code,
                account_name=names.get(code, f"계정 {code}"),
                amount=amount,
            ))
            total_assets += amount

        elif data["type"] == "liability":
            # Liability: normal balance is credit -> amount = credit - debit
            amount = data["credit"] - data["debit"]
            liabilities.append(BalanceSheetItem(
                account_code=code,
                account_name=names.get(code, f"계정 {code}"),
                amount=amount,
            ))
            total_liabilities += amount

        elif data["type"] == "equity":
            # Equity: normal balance is credit -> amount = credit - debit
            amount = data["credit"] - data["debit"]
            equity_list.append(BalanceSheetItem(
                account_code=code,
                account_name=names.get(code, f"계정 {code}"),
                amount=amount,
            ))
            total_equity += amount

    return BalanceSheetResponse(
        upload_id=upload_id,
        assets=assets,
        liabilities=liabilities,
        equity=equity_list,
        total_assets=total_assets,
        total_liabilities=total_liabilities,
        total_equity=total_equity,
    )


@router.get("/monthly-trend", response_model=MonthlyTrendResponse)
async def get_monthly_trend(
    upload_id: int = Query(..., description="업로드 ID"),
    account_code: Optional[str] = Query(None, description="계정코드 (생략 시 전체)"),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    월별 추이 (Monthly Trend)

    월별로 차변/대변 합계와 순액을 집계합니다.
    account_code를 지정하면 해당 계정만, 생략 시 전체 합산.

    transaction_date 형식: 다양한 형식 지원 (YYYY-MM-DD, YYYY.MM.DD, MM/DD 등)
    """
    await _validate_upload(db, upload_id)

    filters = [
        AIRawTransactionData.upload_id == upload_id,
        AIRawTransactionData.transaction_date.isnot(None),
        AIRawTransactionData.transaction_date != "",
    ]
    if account_code:
        # Match either source_account_code or account_code
        filters.append(
            (AIRawTransactionData.source_account_code == account_code)
            | (AIRawTransactionData.account_code == account_code)
        )

    # Since transaction_date is stored as string in various formats,
    # we extract the month portion. Common formats:
    # "2025-01-15", "2025.01.15", "01/15", "1/15"
    # We'll use substr approach: try to extract YYYY-MM
    # For dates like "2025-01-15" -> substr 1..7 -> "2025-01"
    # For dates like "2025.01.15" -> we'll need to handle in Python

    # Fetch all data and process in Python for date format flexibility
    query = (
        select(
            AIRawTransactionData.transaction_date,
            AIRawTransactionData.debit_amount,
            AIRawTransactionData.credit_amount,
        )
        .where(*filters)
    )
    result = await db.execute(query)
    rows = result.all()

    import re

    monthly_data: dict = {}  # month_key -> {debit, credit}

    for row in rows:
        date_str = str(row.transaction_date).strip()
        month_key = None

        # Try to extract YYYY-MM
        # Format: YYYY-MM-DD or YYYY.MM.DD or YYYY/MM/DD
        match = re.match(r'(\d{4})[.\-/](\d{1,2})', date_str)
        if match:
            year = match.group(1)
            month = match.group(2).zfill(2)
            month_key = f"{year}-{month}"
        else:
            # Format: MM/DD or M/D (no year)
            match2 = re.match(r'(\d{1,2})[/\-.](\d{1,2})', date_str)
            if match2:
                month = match2.group(1).zfill(2)
                month_key = f"????-{month}"

        if not month_key:
            continue

        if month_key not in monthly_data:
            monthly_data[month_key] = {"debit": 0.0, "credit": 0.0}

        monthly_data[month_key]["debit"] += float(row.debit_amount or 0)
        monthly_data[month_key]["credit"] += float(row.credit_amount or 0)

    data = []
    for month_key in sorted(monthly_data.keys()):
        d = monthly_data[month_key]
        data.append(MonthlyTrendItem(
            month=month_key,
            debit_total=d["debit"],
            credit_total=d["credit"],
            net=d["debit"] - d["credit"],
        ))

    return MonthlyTrendResponse(
        upload_id=upload_id,
        account_code=account_code,
        data=data,
    )


@router.get("/account-detail", response_model=AccountDetailResponse)
async def get_account_detail(
    upload_id: int = Query(..., description="업로드 ID"),
    account_code: str = Query(..., description="계정코드"),
    page: int = Query(default=1, ge=1, description="페이지"),
    size: int = Query(default=50, ge=1, le=500, description="페이지 크기"),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    계정별 상세 내역

    특정 계정코드의 모든 거래를 페이지네이션하여 조회합니다.
    source_account_code 또는 account_code가 일치하는 거래를 모두 반환합니다.
    """
    await _validate_upload(db, upload_id)

    base_filter = and_(
        AIRawTransactionData.upload_id == upload_id,
        (AIRawTransactionData.source_account_code == account_code)
        | (AIRawTransactionData.account_code == account_code),
    )

    # Total count
    total = await db.scalar(
        select(func.count(AIRawTransactionData.id)).where(base_filter)
    )
    if total is None:
        total = 0

    total_pages = max(1, math.ceil(total / size))

    # Summary
    summary_result = await db.execute(
        select(
            func.coalesce(func.sum(AIRawTransactionData.debit_amount), 0).label("debit_total"),
            func.coalesce(func.sum(AIRawTransactionData.credit_amount), 0).label("credit_total"),
        )
        .where(base_filter)
    )
    summary_row = summary_result.one()

    # Paginated data
    offset = (page - 1) * size
    data_result = await db.execute(
        select(AIRawTransactionData)
        .where(base_filter)
        .order_by(
            AIRawTransactionData.transaction_date,
            AIRawTransactionData.row_number,
        )
        .offset(offset)
        .limit(size)
    )
    rows = data_result.scalars().all()

    items = [
        AccountDetailItem(
            row_number=r.row_number,
            transaction_date=r.transaction_date,
            description=r.original_description,
            merchant_name=r.merchant_name,
            debit_amount=float(r.debit_amount),
            credit_amount=float(r.credit_amount),
            account_code=r.account_code,
            source_account_code=r.source_account_code,
        )
        for r in rows
    ]

    return AccountDetailResponse(
        upload_id=upload_id,
        account_code=account_code,
        total=total,
        page=page,
        size=size,
        total_pages=total_pages,
        items=items,
        summary={
            "debit_total": float(summary_row.debit_total),
            "credit_total": float(summary_row.credit_total),
            "balance": float(summary_row.debit_total) - float(summary_row.credit_total),
        },
    )
