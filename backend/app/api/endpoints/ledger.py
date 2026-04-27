"""
Account Ledger API — 계정별 원장 (총계정원장)
AI 분류 메뉴에서 업로드된 거래 데이터(ai_raw_transaction_data)를
계정과목별로 좌측 리스트 + 우측 엑셀형 그리드로 제공.

데이터 소스: ai_raw_transaction_data
- source_account_code/source_account_name: 원장 계정 (좌측 리스트)
- account_code/account_name: 상대 계정 (우측 그리드의 상대계정 컬럼)
"""
import re
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Optional, List, Tuple
from fastapi import APIRouter, Depends, Query, HTTPException
from sqlalchemy import select, func, and_, or_
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.models.ai import AIRawTransactionData
from app.schemas.ledger import (
    LedgerAccount,
    LedgerAccountTreeNode,
    LedgerEntry,
    LedgerSummary,
    LedgerEntriesResponse,
    LedgerEntryUpdate,
    AccountCategory,
)

router = APIRouter()


# ============ 진단용 ============

@router.get("/diag")
async def diagnose(db: AsyncSession = Depends(get_db)):
    """
    원장 데이터 상태 진단 — 페이지에 데이터가 안 보일 때 빠른 확인용.
    """
    total = await db.scalar(select(func.count(AIRawTransactionData.id))) or 0
    with_source = await db.scalar(
        select(func.count(AIRawTransactionData.id)).where(
            AIRawTransactionData.source_account_code.isnot(None),
            AIRawTransactionData.source_account_code != '',
        )
    ) or 0
    distinct_accounts = await db.scalar(
        select(func.count(func.distinct(AIRawTransactionData.source_account_code))).where(
            AIRawTransactionData.source_account_code.isnot(None),
            AIRawTransactionData.source_account_code != '',
        )
    ) or 0
    min_date = await db.scalar(select(func.min(AIRawTransactionData.transaction_date)))
    max_date = await db.scalar(select(func.max(AIRawTransactionData.transaction_date)))

    return {
        "total_rows": total,
        "rows_with_source_account": with_source,
        "distinct_source_accounts": distinct_accounts,
        "earliest_transaction_date": min_date,
        "latest_transaction_date": max_date,
    }


@router.get("/years")
async def get_available_years(db: AsyncSession = Depends(get_db)):
    """
    데이터에 존재하는 회계연도 목록.
    프론트에서 가장 최신 년도를 default로 사용하도록 활용.
    """
    rows = (await db.execute(
        select(AIRawTransactionData.transaction_date)
        .where(
            AIRawTransactionData.transaction_date.isnot(None),
            AIRawTransactionData.transaction_date != '',
        )
        .distinct()
    )).all()

    years: set = set()
    for r in rows:
        s = r[0] or ''
        m = re.match(r'(\d{4})', s)
        if m:
            try:
                years.add(int(m.group(1)))
            except ValueError:
                pass

    years_list = sorted(years, reverse=True)
    return {
        "years": years_list,
        "latest": years_list[0] if years_list else None,
    }


# ============ 더존 6자리 코드 분류 (financial_reports와 동일) ============
DOUZONE_CATEGORY: dict = {
    '1': 'asset',
    '2': 'liability',
    '3': 'equity',
    '4': 'revenue',
    '5': 'expense',  # 매출원가
    '6': 'expense',  # 제조원가
    '7': 'expense',
    '8': 'expense',  # 판관비
    '9': 'non_operating',
}

CATEGORY_LABEL = {
    'asset': '자산',
    'liability': '부채',
    'equity': '자본',
    'revenue': '수익',
    'expense': '비용',
    'non_operating': '영업외',
}


def _strip_code(code: Optional[str]) -> str:
    if not code:
        return '0'
    return code.lstrip('0') or '0'


def _category_of(code: Optional[str]) -> str:
    stripped = _strip_code(code)
    first = stripped[0] if stripped else '0'
    return DOUZONE_CATEGORY.get(first, 'expense')


def _date_to_iso(s: Optional[str]) -> Optional[str]:
    """업로드 데이터의 transaction_date(string) → ISO yyyy-mm-dd로 정규화"""
    if not s:
        return None
    s = s.strip()
    m = re.match(r'(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})', s)
    if m:
        y, mo, d = m.groups()
        return f"{int(y):04d}-{int(mo):02d}-{int(d):02d}"
    return None


def _date_range_filters(period_start: Optional[date], period_end: Optional[date]):
    """transaction_date(string)에 대한 기간 필터 (yyyy-MM-dd / yyyy.MM.dd 모두 매칭)"""
    filters = []
    if period_start:
        s = period_start.strftime('%Y-%m-%d')
        s2 = period_start.strftime('%Y.%m.%d')
        filters.append(or_(
            AIRawTransactionData.transaction_date >= s,
            AIRawTransactionData.transaction_date >= s2,
        ))
    if period_end:
        e = period_end.strftime('%Y-%m-%d')
        e2 = period_end.strftime('%Y.%m.%d')
        filters.append(or_(
            AIRawTransactionData.transaction_date <= e + ' ~',
            AIRawTransactionData.transaction_date <= e2 + ' ~',
        ))
    return filters


def _signed_change(category: str, debit: Decimal, credit: Decimal) -> Decimal:
    """카테고리별 변동 부호: 자산·비용은 debit-credit, 그 외는 credit-debit"""
    if category in ('asset', 'expense'):
        return debit - credit
    return credit - debit


# ============ 계정 리스트 (좌측 사이드바) ============

@router.get("/accounts", response_model=List[LedgerAccount])
async def list_accounts(
    fiscal_year: Optional[int] = None,
    period_start: Optional[date] = None,
    period_end: Optional[date] = None,
    category: Optional[AccountCategory] = None,
    only_with_activity: bool = False,
    search: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
):
    """
    계정과목 리스트 — source_account_code 기준 GROUP BY.
    AI 분류 메뉴에 업로드된 데이터에서 원장 계정만 추출.
    """
    filters = [
        AIRawTransactionData.source_account_code.isnot(None),
        AIRawTransactionData.source_account_code != '',
    ]

    if fiscal_year and not period_start and not period_end:
        filters.append(or_(
            AIRawTransactionData.transaction_date.like(f"{fiscal_year}-%"),
            AIRawTransactionData.transaction_date.like(f"{fiscal_year}.%"),
        ))

    if period_start:
        s = period_start.strftime('%Y-%m-%d')
        s2 = period_start.strftime('%Y.%m.%d')
        filters.append(or_(
            AIRawTransactionData.transaction_date >= s,
            AIRawTransactionData.transaction_date >= s2,
        ))
    if period_end:
        e_next = (period_end + timedelta(days=1)).strftime('%Y-%m-%d')
        e_next2 = (period_end + timedelta(days=1)).strftime('%Y.%m.%d')
        filters.append(or_(
            AIRawTransactionData.transaction_date < e_next,
            AIRawTransactionData.transaction_date < e_next2,
        ))

    if search:
        like = f"%{search}%"
        filters.append(or_(
            AIRawTransactionData.source_account_code.like(like),
            AIRawTransactionData.source_account_name.like(like),
        ))

    result = await db.execute(
        select(
            AIRawTransactionData.source_account_code,
            func.max(AIRawTransactionData.source_account_name).label('name'),
            func.coalesce(func.sum(AIRawTransactionData.debit_amount), 0).label('debit'),
            func.coalesce(func.sum(AIRawTransactionData.credit_amount), 0).label('credit'),
            func.count(AIRawTransactionData.id).label('cnt'),
        )
        .where(and_(*filters))
        .group_by(AIRawTransactionData.source_account_code)
    )
    rows = result.all()

    accounts: List[LedgerAccount] = []
    for r in rows:
        cat = _category_of(r.source_account_code)
        if category and cat != category:
            continue
        debit = Decimal(str(r.debit or 0))
        credit = Decimal(str(r.credit or 0))
        change = _signed_change(cat, debit, credit)
        if only_with_activity and r.cnt == 0:
            continue
        accounts.append(LedgerAccount(
            account_code=r.source_account_code,
            account_name=r.name or f"계정 {_strip_code(r.source_account_code)}",
            category=cat,  # type: ignore[arg-type]
            parent_code=None,
            depth=0,
            period_debit=debit,
            period_credit=credit,
            period_change=change,
            closing_balance=change,  # 기초 0 가정 (기간 합계만 표시)
            transaction_count=r.cnt,
            has_children=False,
        ))

    accounts.sort(key=lambda a: (a.category, _strip_code(a.account_code)))
    return accounts


@router.get("/accounts/tree", response_model=List[LedgerAccountTreeNode])
async def get_account_tree(
    fiscal_year: Optional[int] = None,
    period_start: Optional[date] = None,
    period_end: Optional[date] = None,
    db: AsyncSession = Depends(get_db),
):
    """카테고리별 트리 (대분류 → 계정과목)"""
    flat = await list_accounts(
        fiscal_year=fiscal_year,
        period_start=period_start,
        period_end=period_end,
        only_with_activity=False,
        db=db,
    )

    grouped: dict = {}
    for a in flat:
        grouped.setdefault(a.category, []).append(a)

    nodes: List[LedgerAccountTreeNode] = []
    for cat, children in grouped.items():
        total_debit = sum((c.period_debit for c in children), Decimal('0'))
        total_credit = sum((c.period_credit for c in children), Decimal('0'))
        total_change = sum((c.period_change for c in children), Decimal('0'))
        total_count = sum(c.transaction_count for c in children)
        nodes.append(LedgerAccountTreeNode(
            account_code=f"_cat_{cat}",
            account_name=CATEGORY_LABEL.get(cat, cat),
            category=cat,  # type: ignore[arg-type]
            parent_code=None,
            depth=0,
            period_debit=total_debit,
            period_credit=total_credit,
            period_change=total_change,
            closing_balance=total_change,
            transaction_count=total_count,
            has_children=True,
            children=[
                LedgerAccountTreeNode(**c.model_dump(), children=[])
                for c in children
            ],
        ))
    return nodes


# ============ 선택 계정 요약 ============

@router.get("/accounts/{account_code}/summary", response_model=LedgerSummary)
async def get_account_summary(
    account_code: str,
    period_start: date = Query(...),
    period_end: date = Query(...),
    db: AsyncSession = Depends(get_db),
):
    """선택 계정의 기간 요약 (그리드 상단 KPI)"""
    cat = _category_of(account_code)

    # 기간 내 합계 (source 기준 — 원장 시점)
    end_next = (period_end + timedelta(days=1)).strftime('%Y-%m-%d')
    end_next2 = (period_end + timedelta(days=1)).strftime('%Y.%m.%d')
    start_iso = period_start.strftime('%Y-%m-%d')
    start_iso2 = period_start.strftime('%Y.%m.%d')

    period_filter = and_(
        AIRawTransactionData.source_account_code == account_code,
        or_(
            AIRawTransactionData.transaction_date >= start_iso,
            AIRawTransactionData.transaction_date >= start_iso2,
        ),
        or_(
            AIRawTransactionData.transaction_date < end_next,
            AIRawTransactionData.transaction_date < end_next2,
        ),
    )

    period_row = (await db.execute(
        select(
            func.max(AIRawTransactionData.source_account_name).label('name'),
            func.coalesce(func.sum(AIRawTransactionData.debit_amount), 0).label('debit'),
            func.coalesce(func.sum(AIRawTransactionData.credit_amount), 0).label('credit'),
            func.count(AIRawTransactionData.id).label('cnt'),
            func.max(AIRawTransactionData.debit_amount).label('max_debit'),
            func.max(AIRawTransactionData.credit_amount).label('max_credit'),
        ).where(period_filter)
    )).one()

    # 기초 잔액 (기간 시작 이전 누적)
    opening_filter = and_(
        AIRawTransactionData.source_account_code == account_code,
        or_(
            AIRawTransactionData.transaction_date < start_iso,
            AIRawTransactionData.transaction_date < start_iso2,
        ),
    )
    opening_row = (await db.execute(
        select(
            func.coalesce(func.sum(AIRawTransactionData.debit_amount), 0).label('debit'),
            func.coalesce(func.sum(AIRawTransactionData.credit_amount), 0).label('credit'),
        ).where(opening_filter)
    )).one()

    opening_balance = _signed_change(
        cat,
        Decimal(str(opening_row.debit or 0)),
        Decimal(str(opening_row.credit or 0)),
    )
    debit = Decimal(str(period_row.debit or 0))
    credit = Decimal(str(period_row.credit or 0))
    change = _signed_change(cat, debit, credit)

    # 기간 개월 수
    months = max(1, (period_end.year - period_start.year) * 12 + period_end.month - period_start.month + 1)

    return LedgerSummary(
        account_code=account_code,
        account_name=period_row.name or f"계정 {_strip_code(account_code)}",
        category=cat,  # type: ignore[arg-type]
        period_start=period_start,
        period_end=period_end,
        opening_balance=opening_balance,
        period_debit=debit,
        period_credit=credit,
        period_change=change,
        closing_balance=opening_balance + change,
        transaction_count=period_row.cnt or 0,
        avg_per_month=(change / months) if change else Decimal('0'),
        largest_debit=Decimal(str(period_row.max_debit or 0)) or None,
        largest_credit=Decimal(str(period_row.max_credit or 0)) or None,
    )


# ============ 선택 계정 거래 내역 ============

@router.get("/accounts/{account_code}/entries", response_model=LedgerEntriesResponse)
async def get_account_entries(
    account_code: str,
    period_start: date = Query(...),
    period_end: date = Query(...),
    counterparty: Optional[str] = None,
    direction: Optional[str] = Query(None, pattern="^(debit|credit)$"),
    min_amount: Optional[Decimal] = None,
    max_amount: Optional[Decimal] = None,
    search: Optional[str] = None,
    page: int = Query(1, ge=1),
    size: int = Query(200, ge=1, le=2000),
    db: AsyncSession = Depends(get_db),
):
    """
    선택 계정의 거래 내역 (엑셀형 그리드용)
    - 누적 잔액(running_balance) 함께 반환
    """
    summary = await get_account_summary(account_code, period_start, period_end, db)
    cat = summary.category

    end_next = (period_end + timedelta(days=1)).strftime('%Y-%m-%d')
    end_next2 = (period_end + timedelta(days=1)).strftime('%Y.%m.%d')
    start_iso = period_start.strftime('%Y-%m-%d')
    start_iso2 = period_start.strftime('%Y.%m.%d')

    filters = [
        AIRawTransactionData.source_account_code == account_code,
        or_(
            AIRawTransactionData.transaction_date >= start_iso,
            AIRawTransactionData.transaction_date >= start_iso2,
        ),
        or_(
            AIRawTransactionData.transaction_date < end_next,
            AIRawTransactionData.transaction_date < end_next2,
        ),
    ]
    if counterparty:
        filters.append(AIRawTransactionData.merchant_name.ilike(f"%{counterparty}%"))
    if direction == 'debit':
        filters.append(AIRawTransactionData.debit_amount > 0)
    elif direction == 'credit':
        filters.append(AIRawTransactionData.credit_amount > 0)
    if min_amount is not None:
        filters.append(or_(
            AIRawTransactionData.debit_amount >= min_amount,
            AIRawTransactionData.credit_amount >= min_amount,
        ))
    if max_amount is not None:
        filters.append(or_(
            AIRawTransactionData.debit_amount <= max_amount,
            AIRawTransactionData.credit_amount <= max_amount,
        ))
    if search:
        like = f"%{search}%"
        filters.append(or_(
            AIRawTransactionData.original_description.ilike(like),
            AIRawTransactionData.merchant_name.ilike(like),
            AIRawTransactionData.account_name.ilike(like),
        ))

    total = await db.scalar(
        select(func.count(AIRawTransactionData.id)).where(and_(*filters))
    ) or 0

    offset = (page - 1) * size
    rows = (await db.execute(
        select(AIRawTransactionData)
        .where(and_(*filters))
        .order_by(
            AIRawTransactionData.transaction_date.asc(),
            AIRawTransactionData.row_number.asc(),
            AIRawTransactionData.id.asc(),
        )
        .offset(offset)
        .limit(size)
    )).scalars().all()

    running = Decimal(str(summary.opening_balance))
    entries: List[LedgerEntry] = []
    for r in rows:
        debit_amt = Decimal(str(r.debit_amount or 0))
        credit_amt = Decimal(str(r.credit_amount or 0))
        running += _signed_change(cat, debit_amt, credit_amt)
        entries.append(LedgerEntry(
            id=r.id,
            voucher_id=None,
            transaction_date=date.fromisoformat(_date_to_iso(r.transaction_date) or period_start.isoformat()),
            transaction_number=f"#{r.row_number}",
            counterparty=r.merchant_name,
            description=r.original_description,
            debit=debit_amt,
            credit=credit_amt,
            running_balance=running,
            counterparty_account_code=r.account_code,
            counterparty_account_name=r.account_name,
            department_name=None,
            project_tag=None,
            memo=None,
            is_locked=False,
            created_at=r.created_at,
        ))

    return LedgerEntriesResponse(
        summary=summary,
        entries=entries,
        total=total,
        page=page,
        size=size,
    )


# ============ 거래 수정 ============

@router.patch("/entries/{entry_id}", response_model=LedgerEntry)
async def update_entry(
    entry_id: int,
    update: LedgerEntryUpdate,
    user_id: int = Query(...),
    db: AsyncSession = Depends(get_db),
):
    """원장 거래 수정 (적요/거래처 등 — raw 데이터 직접 수정)"""
    row = await db.get(AIRawTransactionData, entry_id)
    if not row:
        raise HTTPException(status_code=404, detail="거래를 찾을 수 없습니다.")

    if update.description is not None:
        row.original_description = update.description
    if update.counterparty is not None:
        row.merchant_name = update.counterparty
    # memo, project_tag는 raw 테이블에 컬럼 없음 — TODO: 별도 ledger_entry_meta 테이블

    await db.commit()
    await db.refresh(row)

    cat = _category_of(row.source_account_code)
    return LedgerEntry(
        id=row.id,
        voucher_id=None,
        transaction_date=date.fromisoformat(_date_to_iso(row.transaction_date) or date.today().isoformat()),
        transaction_number=f"#{row.row_number}",
        counterparty=row.merchant_name,
        description=row.original_description,
        debit=Decimal(str(row.debit_amount or 0)),
        credit=Decimal(str(row.credit_amount or 0)),
        running_balance=Decimal('0'),
        counterparty_account_code=row.account_code,
        counterparty_account_name=row.account_name,
        department_name=None,
        project_tag=update.project_tag,
        memo=update.memo,
        is_locked=False,
        created_at=row.created_at,
    )


# ============ 엑셀 내보내기 (TODO: 실제 xlsx 생성) ============

@router.get("/accounts/{account_code}/export")
async def export_ledger_excel(
    account_code: str,
    period_start: date = Query(...),
    period_end: date = Query(...),
    db: AsyncSession = Depends(get_db),
):
    """원장 엑셀 내보내기 — 추후 financial_reports의 export 패턴 재사용 예정"""
    return {
        "account_code": account_code,
        "period": f"{period_start} ~ {period_end}",
        "url": f"/api/v1/financial/account-detail/export/excel?account_code={account_code}",
        "note": "기존 /financial/account-detail/export/excel 사용 권장",
    }
