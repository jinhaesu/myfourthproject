"""
Unified View API — 통합 데이터 실시간 조회
AI 분류 메뉴(ai_raw_transaction_data)에 업로드된 모든 거래를 한 화면에서 조회.
좌측 source(계좌/카드 등) 필터, 우측 시간순 통합 거래.

데이터 소스: ai_raw_transaction_data + ai_data_upload_history
"""
import re
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Optional, List, Literal
from fastapi import APIRouter, Depends, Query, HTTPException, status
from sqlalchemy import select, func, and_, or_, distinct
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.models.ai import AIRawTransactionData, AIDataUploadHistory
from app.schemas.unified import (
    UnifiedListResponse,
    UnifiedTransactionItem,
    UnifiedSummary,
    DataSource,
    DataSourceCreate,
    SourceType,
    DirectionType,
)

router = APIRouter()


# source_account_name 키워드로 source type 추정
def _guess_source(name: Optional[str], code: Optional[str]) -> SourceType:
    txt = (name or '').lower()
    if any(k in txt for k in ('카드', 'card', '신용', '체크')):
        return 'card'
    if any(k in txt for k in ('세금계산서', '계산서', '매출', '매입', 'tax')):
        return 'tax_invoice'
    return 'bank'


def _date_to_iso(s: Optional[str]) -> Optional[str]:
    if not s:
        return None
    s = s.strip()
    m = re.match(r'(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})', s)
    if m:
        y, mo, d = m.groups()
        return f"{int(y):04d}-{int(mo):02d}-{int(d):02d}"
    return None


def _direction_of(debit: Decimal, credit: Decimal) -> DirectionType:
    return 'inbound' if debit >= credit else 'outbound'


def _date_filters(period_start: Optional[date], period_end: Optional[date]):
    filters = []
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
    return filters


# ============ Summary ============

@router.get("/summary", response_model=UnifiedSummary)
async def get_unified_summary(
    from_date: Optional[date] = None,
    to_date: Optional[date] = None,
    db: AsyncSession = Depends(get_db),
):
    """
    통합 요약 카드 — ai_raw_transaction_data 기반
    - 차변 합계(inbound) / 대변 합계(outbound)
    - 분류된/미분류 건수
    - 연동된 source 종류 수
    """
    filters = _date_filters(from_date, to_date)

    base_q = select(
        func.coalesce(func.sum(AIRawTransactionData.debit_amount), 0).label('debit'),
        func.coalesce(func.sum(AIRawTransactionData.credit_amount), 0).label('credit'),
        func.count(AIRawTransactionData.id).label('cnt'),
    )
    if filters:
        base_q = base_q.where(and_(*filters))
    row = (await db.execute(base_q)).one()

    # source 분류 카운트 (source_account_name 키워드 기반)
    source_q = select(
        AIRawTransactionData.source_account_code,
        AIRawTransactionData.source_account_name,
    ).where(
        AIRawTransactionData.source_account_code.isnot(None),
        AIRawTransactionData.source_account_code != '',
    ).distinct()
    if filters:
        source_q = source_q.where(*filters)
    sources = (await db.execute(source_q)).all()

    bank, card, tax = 0, 0, 0
    for s in sources:
        t = _guess_source(s.source_account_name, s.source_account_code)
        if t == 'card':
            card += 1
        elif t == 'tax_invoice':
            tax += 1
        else:
            bank += 1

    # 미분류: account_code 없거나 비어있는 건수
    unclassified_q = select(func.count(AIRawTransactionData.id)).where(
        or_(
            AIRawTransactionData.account_code.is_(None),
            AIRawTransactionData.account_code == '',
        )
    )
    if filters:
        unclassified_q = unclassified_q.where(*filters)
    unclassified = await db.scalar(unclassified_q) or 0

    # 마지막 동기화 시간 = 가장 최근 업로드
    last_upload = await db.scalar(
        select(func.max(AIDataUploadHistory.created_at))
    )

    debit = Decimal(str(row.debit or 0))
    credit = Decimal(str(row.credit or 0))
    return UnifiedSummary(
        total_balance=debit - credit,  # 단순 net (실제 잔액은 ledger summary 참조)
        bank_count=bank,
        card_count=card,
        tax_invoice_count=tax,
        inbound_total=debit,
        outbound_total=credit,
        last_sync_at=last_upload,
        unclassified_count=unclassified,
    )


# ============ Transactions ============

@router.get("/transactions", response_model=UnifiedListResponse)
async def list_unified_transactions(
    from_date: Optional[date] = None,
    to_date: Optional[date] = None,
    sources: Optional[List[SourceType]] = Query(None),
    direction: Optional[DirectionType] = None,
    counterparty: Optional[str] = None,
    min_amount: Optional[Decimal] = None,
    max_amount: Optional[Decimal] = None,
    search: Optional[str] = None,
    only_unclassified: bool = False,
    page: int = Query(1, ge=1),
    size: int = Query(50, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
):
    """
    통합 거래 목록 — ai_raw_transaction_data 시간순.
    source 필터는 source_account_name 키워드로 추정.
    """
    filters = _date_filters(from_date, to_date)

    if counterparty:
        filters.append(AIRawTransactionData.merchant_name.ilike(f"%{counterparty}%"))
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
            AIRawTransactionData.source_account_name.ilike(like),
            AIRawTransactionData.account_name.ilike(like),
        ))
    if only_unclassified:
        filters.append(or_(
            AIRawTransactionData.account_code.is_(None),
            AIRawTransactionData.account_code == '',
        ))

    base_filter = and_(*filters) if filters else True

    total = await db.scalar(
        select(func.count(AIRawTransactionData.id)).where(base_filter)
    ) or 0

    rows = (await db.execute(
        select(AIRawTransactionData)
        .where(base_filter)
        .order_by(
            AIRawTransactionData.transaction_date.desc(),
            AIRawTransactionData.row_number.desc(),
            AIRawTransactionData.id.desc(),
        )
        .offset((page - 1) * size)
        .limit(size)
    )).scalars().all()

    items: List[UnifiedTransactionItem] = []
    for r in rows:
        src = _guess_source(r.source_account_name, r.source_account_code)
        if sources and src not in sources:
            continue
        debit = Decimal(str(r.debit_amount or 0))
        credit = Decimal(str(r.credit_amount or 0))
        amount = debit if debit >= credit else credit
        dir_ = _direction_of(debit, credit)
        if direction and dir_ != direction:
            continue
        iso_date = _date_to_iso(r.transaction_date)
        items.append(UnifiedTransactionItem(
            id=f"raw-{r.id}",
            source=src,
            source_label=r.source_account_name or f"계정 {r.source_account_code or '-'}",
            transaction_date=date.fromisoformat(iso_date) if iso_date else date.today(),
            transaction_time=None,
            direction=dir_,
            amount=amount,
            description=r.original_description or '',
            counterparty=r.merchant_name,
            category=r.account_name,
            is_classified=bool(r.account_code),
            memo=None,
        ))

    summary = await get_unified_summary(from_date=from_date, to_date=to_date, db=db)
    return UnifiedListResponse(
        items=items,
        total=total,
        page=page,
        size=size,
        summary=summary,
    )


# ============ Sources (연동된 데이터 소스) ============

@router.get("/sources", response_model=List[DataSource])
async def list_data_sources(
    db: AsyncSession = Depends(get_db),
):
    """
    연동된 데이터 소스 목록.
    AI 분류 메뉴에서 업로드한 source_account_code별 그룹.
    """
    rows = (await db.execute(
        select(
            AIRawTransactionData.source_account_code,
            func.max(AIRawTransactionData.source_account_name).label('name'),
            func.count(AIRawTransactionData.id).label('cnt'),
            func.max(AIRawTransactionData.created_at).label('last_synced'),
        )
        .where(
            AIRawTransactionData.source_account_code.isnot(None),
            AIRawTransactionData.source_account_code != '',
        )
        .group_by(AIRawTransactionData.source_account_code)
        .order_by(AIRawTransactionData.source_account_code)
    )).all()

    sources: List[DataSource] = []
    for idx, r in enumerate(rows, start=1):
        src_type = _guess_source(r.name, r.source_account_code)
        sources.append(DataSource(
            id=idx,
            type=src_type,
            name=r.name or f"계정 {r.source_account_code}",
            institution=r.name or f"계정 {r.source_account_code}",
            last_sync_at=r.last_synced,
            sync_status="ok",
            error_message=None,
            is_active=True,
        ))
    return sources


@router.post("/sources", response_model=DataSource, status_code=status.HTTP_201_CREATED)
async def create_data_source(
    source: DataSourceCreate,
    db: AsyncSession = Depends(get_db),
):
    """
    신규 데이터 소스 연동.
    - bank/card: 그랜터(Granter) 서비스 OAuth
    - tax_invoice: 홈택스 직접 연동
    """
    # TODO: source.type에 따라 그랜터/홈택스 분기. credential_token 검증 + 초기 동기화 큐잉.
    return DataSource(
        id=999,
        type=source.type,
        name=source.name or source.institution,
        institution=source.institution,
        last_sync_at=None,
        sync_status="pending",
        is_active=True,
    )


@router.post("/sources/{source_id}/sync")
async def trigger_sync(
    source_id: int,
    db: AsyncSession = Depends(get_db),
):
    """소스 즉시 동기화 (그랜터/홈택스 webhook trigger)"""
    # TODO: 그랜터 sync API 호출 또는 홈택스 스케줄러 트리거
    return {"source_id": source_id, "status": "syncing", "queued_at": datetime.utcnow().isoformat()}


@router.delete("/sources/{source_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_data_source(
    source_id: int,
    db: AsyncSession = Depends(get_db),
):
    """소스 연동 해제 (실제 거래 데이터는 유지)"""
    # TODO: 그랜터 토큰 폐기 + source 비활성화
    return
