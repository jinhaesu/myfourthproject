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
from typing import Optional, List, Tuple, Any
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
async def diagnose(
    sample_account_code: Optional[str] = None,
    sample_size: int = 5,
    db: AsyncSession = Depends(get_db),
):
    """
    원장 데이터 상태 진단 — 차변/대변 mismatch 등 검증용.

    sample_account_code 지정 시 해당 계정의 raw 데이터 5건 반환 (더존 화면과 직접 비교).
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

    # 샘플 row (DB raw 그대로 — 더존 원본과 직접 비교용)
    sample_q = select(AIRawTransactionData)
    if sample_account_code:
        sample_q = sample_q.where(
            AIRawTransactionData.source_account_code == sample_account_code
        )
    sample_q = sample_q.order_by(AIRawTransactionData.id.asc()).limit(sample_size)
    sample_rows = (await db.execute(sample_q)).scalars().all()

    samples = [
        {
            "id": r.id,
            "row_number": r.row_number,
            "transaction_date": r.transaction_date,
            "description": r.original_description,
            "merchant_name": r.merchant_name,
            "source_account_code": r.source_account_code,
            "source_account_name": r.source_account_name,
            "account_code": r.account_code,
            "account_name": r.account_name,
            "debit_amount": float(r.debit_amount or 0),
            "credit_amount": float(r.credit_amount or 0),
            "amount": float(r.amount or 0),
        }
        for r in sample_rows
    ]

    # source_account_code별 row 수 (상위 20개)
    by_account = (await db.execute(
        select(
            AIRawTransactionData.source_account_code,
            func.max(AIRawTransactionData.source_account_name).label('name'),
            func.count(AIRawTransactionData.id).label('cnt'),
        )
        .where(
            AIRawTransactionData.source_account_code.isnot(None),
            AIRawTransactionData.source_account_code != '',
        )
        .group_by(AIRawTransactionData.source_account_code)
        .order_by(func.count(AIRawTransactionData.id).desc())
        .limit(20)
    )).all()

    return {
        "total_rows": total,
        "rows_with_source_account": with_source,
        "distinct_source_accounts": distinct_accounts,
        "earliest_transaction_date": min_date,
        "latest_transaction_date": max_date,
        "top_accounts_by_volume": [
            {"code": a.source_account_code, "name": a.name, "count": a.cnt}
            for a in by_account
        ],
        "samples": samples,
        "samples_for_account": sample_account_code,
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


# ============ 카테고리 분류 (코드 + 이름 기반) ============
CATEGORY_LABEL = {
    'asset': '자산',
    'liability': '부채',
    'equity': '자본',
    'revenue': '수익',
    'expense': '비용',
    'non_operating': '영업외',
}

# 이름 키워드 기반 분류
_NAME_RULES = [
    (('매출원가', '제조원가', '상품매출원가', '제품매출원가', '용역매출원가'), 'expense'),
    (('이자수익', '이자비용', '외환차익', '외환차손', '외화환산이익', '외화환산손실',
      '잡이익', '잡손실', '유형자산처분', '무형자산처분', '기부금', '재해손실'), 'non_operating'),
    (('상품매출', '제품매출', '용역매출', '공사매출', '임대료수익', '수출매출'), 'revenue'),
]


def _strip_code(code: Optional[str]) -> str:
    if not code:
        return '0'
    return code.lstrip('0') or '0'


def _category_of(code: Optional[str], name: str = '') -> str:
    """
    코드 + 이름 둘 다 보고 정확히 분류.
    - 이름 우선: '매출원가'는 expense로 (45x인 4xx여도)
    - 4xx 세분화: 45x~49x는 expense(원가), 40x~44x는 revenue
    """
    n = (name or '').strip()

    for keywords, cat in _NAME_RULES:
        if any(k in n for k in keywords):
            return cat

    s = _strip_code(code)
    first = s[0] if s else '0'

    if first == '4':
        if len(s) >= 2 and s[1] in ('5', '6', '7', '8', '9'):
            return 'expense'
        return 'revenue'

    return {
        '1': 'asset',
        '2': 'liability',
        '3': 'equity',
        '5': 'expense',
        '6': 'expense',
        '7': 'expense',
        '8': 'expense',
        '9': 'non_operating',
    }.get(first, 'expense')


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
        cat = _category_of(r.source_account_code, r.name)
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
    # 임시로 코드만 — 아래에서 name 받아온 후 재분류
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

    # 이름 받아온 후 카테고리 재분류 (이름 우선)
    cat = _category_of(account_code, period_row.name or '')

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
    """
    원장 거래 수정 — 구분/금액/계정/거래처/적요까지 한 번에.
    - direction='debit' + amount=N → debit_amount=N, credit_amount=0
    - direction='credit' + amount=N → debit_amount=0, credit_amount=N
    - 또는 debit_amount/credit_amount 직접 지정
    """
    row = await db.get(AIRawTransactionData, entry_id)
    if not row:
        raise HTTPException(status_code=404, detail="거래를 찾을 수 없습니다.")

    # 1) 적요
    if update.description is not None:
        row.original_description = update.description

    # 2) 거래처
    if update.counterparty is not None:
        row.merchant_name = update.counterparty

    # 3) 원장 계정 (source) — 변경 시 다른 원장으로 이동됨
    if update.source_account_code is not None:
        row.source_account_code = update.source_account_code
    if update.source_account_name is not None:
        row.source_account_name = update.source_account_name

    # 4) 상대 계정
    if update.account_code is not None:
        row.account_code = update.account_code
    if update.account_name is not None:
        row.account_name = update.account_name

    # 5) 차변/대변 — direction + amount 우선 적용
    if update.direction and update.amount is not None:
        amt = update.amount
        if update.direction == 'debit':
            row.debit_amount = amt
            row.credit_amount = Decimal('0')
        else:
            row.debit_amount = Decimal('0')
            row.credit_amount = amt
    else:
        if update.debit_amount is not None:
            row.debit_amount = update.debit_amount
        if update.credit_amount is not None:
            row.credit_amount = update.credit_amount

    # amount 동기화 (raw 데이터의 amount 컬럼)
    if (
        update.direction and update.amount is not None
    ) or update.debit_amount is not None or update.credit_amount is not None:
        row.amount = max(row.debit_amount or Decimal('0'), row.credit_amount or Decimal('0'))

    # 6) 거래처 코드 / 메모 / 프로젝트 태그
    # raw 테이블엔 별도 컬럼 없음 — TODO: ledger_entry_meta 테이블 추가 후 분리 저장
    # 현재는 무시 (프론트엔드 전용 임시 저장 가능)

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


# ============ 매출채권 / 매입채무 거래처별 요약 ============

# 매출채권: 외상매출금(108), 받을어음(110)
# 매입채무: 외상매입금(251), 미지급금(253) — 미지급금은 매입성 부채라 함께
AR_CODES = ["108", "110"]
AP_CODES = ["251", "253"]


@router.get("/ar-ap/summary")
async def get_ar_ap_summary(
    fiscal_year: int = Query(..., ge=2020, le=2030, description="회계연도"),
    type: str = Query(..., regex="^(receivable|payable)$", description="receivable=매출채권 / payable=매입채무"),
    db: AsyncSession = Depends(get_db),
):
    """
    매출채권(108/110) 또는 매입채무(251/253) 의 거래처별·월별 요약.

    응답:
    - opening_balance / closing_balance: 회계연도 기초/기말 총잔액
    - period_debit / period_credit / period_change: 기간 차/대변 합계, 순증감
    - monthly: 월별 차/대변·기말잔액 시계열
    - counterparties: 거래처별 기초/차/대/기말잔액 + 거래건수 + 최근거래일
    """
    codes = AR_CODES if type == "receivable" else AP_CODES
    start = date(fiscal_year, 1, 1)
    end = date(fiscal_year, 12, 31)
    start_iso = start.strftime('%Y-%m-%d')
    start_iso2 = start.strftime('%Y.%m.%d')
    end_next = (end + timedelta(days=1))
    end_next_iso = end_next.strftime('%Y-%m-%d')
    end_next_iso2 = end_next.strftime('%Y.%m.%d')

    # 부호 처리: 자산은 차변=증가/대변=감소, 부채는 반대
    def signed(d: Any, c: Any) -> Decimal:
        d, c = Decimal(str(d or 0)), Decimal(str(c or 0))
        return (d - c) if type == "receivable" else (c - d)

    base_filter = AIRawTransactionData.source_account_code.in_(codes)
    opening_filter = and_(
        base_filter,
        or_(
            AIRawTransactionData.transaction_date < start_iso,
            AIRawTransactionData.transaction_date < start_iso2,
        ),
    )
    period_filter = and_(
        base_filter,
        or_(
            AIRawTransactionData.transaction_date >= start_iso,
            AIRawTransactionData.transaction_date >= start_iso2,
        ),
        or_(
            AIRawTransactionData.transaction_date < end_next_iso,
            AIRawTransactionData.transaction_date < end_next_iso2,
        ),
    )

    # 기초 총잔액
    opening_row = (await db.execute(
        select(
            func.coalesce(func.sum(AIRawTransactionData.debit_amount), 0).label('d'),
            func.coalesce(func.sum(AIRawTransactionData.credit_amount), 0).label('c'),
        ).where(opening_filter)
    )).one()
    opening_balance = signed(opening_row.d, opening_row.c)

    # 거래처별 기초 잔액
    cp_open_rows = (await db.execute(
        select(
            AIRawTransactionData.merchant_name.label('cp'),
            func.coalesce(func.sum(AIRawTransactionData.debit_amount), 0).label('d'),
            func.coalesce(func.sum(AIRawTransactionData.credit_amount), 0).label('c'),
        ).where(opening_filter)
         .group_by(AIRawTransactionData.merchant_name)
    )).all()
    cp_opening = {(r.cp or '(미지정)'): signed(r.d, r.c) for r in cp_open_rows}

    # 거래처별 기간 합계
    cp_rows = (await db.execute(
        select(
            AIRawTransactionData.merchant_name.label('cp'),
            func.coalesce(func.sum(AIRawTransactionData.debit_amount), 0).label('d'),
            func.coalesce(func.sum(AIRawTransactionData.credit_amount), 0).label('c'),
            func.count(AIRawTransactionData.id).label('cnt'),
            func.max(AIRawTransactionData.transaction_date).label('latest'),
            func.min(AIRawTransactionData.transaction_date).label('earliest'),
        ).where(period_filter)
         .group_by(AIRawTransactionData.merchant_name)
    )).all()

    counterparties = []
    total_debit = Decimal('0')
    total_credit = Decimal('0')
    total_count = 0
    for r in cp_rows:
        name = r.cp or '(미지정)'
        cp_open = cp_opening.get(name, Decimal('0'))
        cp_d = Decimal(str(r.d or 0))
        cp_c = Decimal(str(r.c or 0))
        cp_change = signed(cp_d, cp_c)
        total_debit += cp_d
        total_credit += cp_c
        total_count += r.cnt or 0
        counterparties.append({
            'name': name,
            'opening_balance': float(cp_open),
            'period_debit': float(cp_d),
            'period_credit': float(cp_c),
            'period_change': float(cp_change),
            'closing_balance': float(cp_open + cp_change),
            'transaction_count': r.cnt or 0,
            'latest_date': str(r.latest) if r.latest else None,
            'earliest_date': str(r.earliest) if r.earliest else None,
        })

    # 기초만 있고 기간내 거래 없는 거래처도 포함 (잔액 carry-over)
    period_cp_names = {r.cp or '(미지정)' for r in cp_rows}
    for name, bal in cp_opening.items():
        if name in period_cp_names:
            continue
        if bal == 0:
            continue
        counterparties.append({
            'name': name,
            'opening_balance': float(bal),
            'period_debit': 0.0,
            'period_credit': 0.0,
            'period_change': 0.0,
            'closing_balance': float(bal),
            'transaction_count': 0,
            'latest_date': None,
            'earliest_date': None,
        })

    counterparties.sort(key=lambda x: -abs(x['closing_balance']))

    # 월별 시계열 — transaction_date의 앞 7자리(YYYY-MM 또는 YYYY.MM)
    # PostgreSQL은 GROUP BY/ORDER BY에 SELECT의 표현식과 정확히 같은 객체를 요구하므로 변수로 통일
    ym_expr = func.substr(AIRawTransactionData.transaction_date, 1, 7)
    month_rows = (await db.execute(
        select(
            ym_expr.label('ym'),
            func.coalesce(func.sum(AIRawTransactionData.debit_amount), 0).label('d'),
            func.coalesce(func.sum(AIRawTransactionData.credit_amount), 0).label('c'),
            func.count(AIRawTransactionData.id).label('cnt'),
        ).where(period_filter)
         .group_by(ym_expr)
         .order_by(ym_expr)
    )).all()

    monthly = []
    running = opening_balance
    for r in month_rows:
        change = signed(r.d, r.c)
        running = running + change
        ym_raw = (r.ym or '')[:7].replace('.', '-')
        monthly.append({
            'month': ym_raw,
            'period_debit': float(Decimal(str(r.d or 0))),
            'period_credit': float(Decimal(str(r.c or 0))),
            'period_change': float(change),
            'closing_balance': float(running),
            'transaction_count': r.cnt or 0,
        })

    period_change = signed(total_debit, total_credit)
    return {
        'fiscal_year': fiscal_year,
        'type': type,
        'account_codes': codes,
        'opening_balance': float(opening_balance),
        'closing_balance': float(opening_balance + period_change),
        'period_debit': float(total_debit),
        'period_credit': float(total_credit),
        'period_change': float(period_change),
        'counterparty_count': len(counterparties),
        'transaction_count': total_count,
        'monthly': monthly,
        'counterparties': counterparties,
    }
