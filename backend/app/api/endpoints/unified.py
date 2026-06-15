"""
Unified View API — 통합 데이터 실시간 조회

2026-06 단일화:
  모든 집계/목록은 unified_ledger(CONFIRMED Voucher 단일 소스)를 사용.
  ai_raw_transaction_data는 분개장 업로드 스테이징 전용이므로 이 파일에서 직접 쿼리 금지.
  (ai_raw를 직접 읽으면 위하고 분개장이 2025년 voucher와 2배 중복 집계되는 버그가 있었음)

응답 JSON 스키마는 기존과 동일하게 유지.
날짜 비교는 'YYYY-MM-DD' 문자열로 통일.
"""
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Optional, List, Literal
from fastapi import APIRouter, Depends, Query, HTTPException, status
from sqlalchemy import select, func, and_, or_
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.models.ai import AIDataUploadHistory
from app.services.unified_ledger import (
    unified_aggregation_subquery,
    unified_rows_subquery,
)
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


def _direction_of(debit: Decimal, credit: Decimal) -> DirectionType:
    return 'inbound' if debit >= credit else 'outbound'


# ============ Summary ============

@router.get("/summary", response_model=UnifiedSummary)
async def get_unified_summary(
    from_date: Optional[date] = None,
    to_date: Optional[date] = None,
    db: AsyncSession = Depends(get_db),
):
    """
    통합 요약 카드 — unified_ledger(CONFIRMED Voucher) 기반.
    - 차변 합계(inbound) / 대변 합계(outbound)
    - 분류된/미분류 건수
    - 연동된 source 종류 수
    """
    sub = unified_aggregation_subquery(
        period_start=from_date,
        period_end=to_date,
    )

    # 차·대변 합계 및 건수
    agg_row = (await db.execute(
        select(
            func.coalesce(func.sum(sub.c.debit_amount), 0).label('debit'),
            func.coalesce(func.sum(sub.c.credit_amount), 0).label('credit'),
            func.count().label('cnt'),
        )
    )).one()

    # source_account_code 기준 소스 분류 카운트
    source_rows = (await db.execute(
        select(
            sub.c.source_account_code,
            sub.c.source_account_name,
        ).distinct().where(
            sub.c.source_account_code.isnot(None),
            sub.c.source_account_code != '',
        )
    )).all()

    bank_count, card_count, tax_count = 0, 0, 0
    for s in source_rows:
        t = _guess_source(s.source_account_name, s.source_account_code)
        if t == 'card':
            card_count += 1
        elif t == 'tax_invoice':
            tax_count += 1
        else:
            bank_count += 1

    # 미분류: source_account_code 없는 행 (voucher 기반에서는 account_code가 보통 존재하나 스키마 호환 유지)
    rows_sub = unified_rows_subquery(period_start=from_date, period_end=to_date)
    unclassified = await db.scalar(
        select(func.count()).select_from(rows_sub).where(
            or_(
                rows_sub.c.source_account_code.is_(None),
                rows_sub.c.source_account_code == '',
            )
        )
    ) or 0

    # 마지막 동기화 시간 = 가장 최근 업로드 (스테이징 기록 참조 — 메타데이터 용도만)
    last_upload = await db.scalar(
        select(func.max(AIDataUploadHistory.created_at))
    )

    debit = Decimal(str(agg_row.debit or 0))
    credit = Decimal(str(agg_row.credit or 0))
    return UnifiedSummary(
        total_balance=debit - credit,
        bank_count=bank_count,
        card_count=card_count,
        tax_invoice_count=tax_count,
        inbound_total=debit,
        outbound_total=credit,
        last_sync_at=last_upload,
        unclassified_count=int(unclassified),
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
    통합 거래 목록 — unified_ledger(CONFIRMED Voucher) 시간순.
    source 필터는 source_account_name 키워드로 추정.
    날짜는 'YYYY-MM-DD' 문자열 비교.
    """
    rows_sub = unified_rows_subquery(period_start=from_date, period_end=to_date)

    filters = []
    if counterparty:
        filters.append(rows_sub.c.merchant_name.ilike(f"%{counterparty}%"))
    if min_amount is not None:
        filters.append(or_(
            rows_sub.c.debit_amount >= min_amount,
            rows_sub.c.credit_amount >= min_amount,
        ))
    if max_amount is not None:
        filters.append(or_(
            rows_sub.c.debit_amount <= max_amount,
            rows_sub.c.credit_amount <= max_amount,
        ))
    if search:
        like = f"%{search}%"
        filters.append(or_(
            rows_sub.c.description.ilike(like),
            rows_sub.c.merchant_name.ilike(like),
            rows_sub.c.source_account_name.ilike(like),
        ))
    if only_unclassified:
        filters.append(or_(
            rows_sub.c.source_account_code.is_(None),
            rows_sub.c.source_account_code == '',
        ))

    base_filter = and_(*filters) if filters else True

    total = await db.scalar(
        select(func.count()).select_from(rows_sub).where(base_filter)
    ) or 0

    db_rows = (await db.execute(
        select(rows_sub).where(base_filter)
        .order_by(
            rows_sub.c.transaction_date.desc(),
            rows_sub.c.row_number.desc(),
            rows_sub.c.id.desc(),
        )
        .offset((page - 1) * size)
        .limit(size)
    )).all()

    items: List[UnifiedTransactionItem] = []
    for r in db_rows:
        src = _guess_source(r.source_account_name, r.source_account_code)
        if sources and src not in sources:
            continue
        debit = Decimal(str(r.debit_amount or 0))
        credit = Decimal(str(r.credit_amount or 0))
        amount = debit if debit >= credit else credit
        dir_ = _direction_of(debit, credit)
        if direction and dir_ != direction:
            continue

        # transaction_date는 unified_ledger에서 'YYYY-MM-DD' 형식으로 반환됨
        txn_date_str = r.transaction_date or ''
        try:
            txn_date = date.fromisoformat(txn_date_str[:10]) if txn_date_str else date.today()
        except ValueError:
            txn_date = date.today()

        items.append(UnifiedTransactionItem(
            id=f"voucher-{r.id}",
            source=src,
            source_label=r.source_account_name or f"계정 {r.source_account_code or '-'}",
            transaction_date=txn_date,
            transaction_time=None,
            direction=dir_,
            amount=amount,
            description=r.description or '',
            counterparty=r.merchant_name,
            category=r.source_account_name,
            is_classified=bool(r.source_account_code),
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
    CONFIRMED Voucher의 source_account_code별 그룹.
    """
    sub = unified_aggregation_subquery()
    rows = (await db.execute(
        select(
            sub.c.source_account_code,
            func.max(sub.c.source_account_name).label('name'),
            func.count().label('cnt'),
        )
        .where(
            sub.c.source_account_code.isnot(None),
            sub.c.source_account_code != '',
        )
        .group_by(sub.c.source_account_code)
        .order_by(sub.c.source_account_code)
    )).all()

    # 마지막 동기화 시간 (업로드 메타)
    last_upload = await db.scalar(
        select(func.max(AIDataUploadHistory.created_at))
    )

    sources: List[DataSource] = []
    for idx, r in enumerate(rows, start=1):
        src_type = _guess_source(r.name, r.source_account_code)
        sources.append(DataSource(
            id=idx,
            type=src_type,
            name=r.name or f"계정 {r.source_account_code}",
            institution=r.name or f"계정 {r.source_account_code}",
            last_sync_at=last_upload,
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


# ============ Dashboard (사이드바 카드용 종합 데이터) ============

# 카테고리 코드 추정 (더존 6자리 또는 표준 3자리 기준)
_CASH_CODES = ('101', '102', '103', '104')  # 현금성 자산
_AR_CODES = ('108', '120')  # 외상매출금/매출채권
_AP_CODES = ('251',)  # 외상매입금
_PAYABLE_CODES = ('253',)  # 미지급금 (카드 결제대금)
_VAT_OUT = ('255',)  # 부가세예수금
_VAT_IN = ('135',)  # 부가세대급금


def _strip(code):
    if not code:
        return ''
    return code.lstrip('0') or '0'


def _is_cash_code(code: Optional[str]) -> bool:
    return _strip(code) in _CASH_CODES


@router.get("/dashboard")
async def get_unified_dashboard(
    period_start: Optional[date] = None,
    period_end: Optional[date] = None,
    db: AsyncSession = Depends(get_db),
):
    """
    통합 조회 좌측 사이드바용 종합 데이터.
    unified_ledger(CONFIRMED Voucher) 기반 — ai_raw 직접 참조 제거.
    가용자금 / 통장별 / 카드사별 / 세금계산서 요약 한 번에 반환.
    """
    sub = unified_aggregation_subquery(period_start=period_start, period_end=period_end)

    # 1) source_account_code별 집계
    cash_rows = (await db.execute(
        select(
            sub.c.source_account_code,
            func.max(sub.c.source_account_name).label('name'),
            func.coalesce(func.sum(sub.c.debit_amount), 0).label('debit'),
            func.coalesce(func.sum(sub.c.credit_amount), 0).label('credit'),
            func.count().label('cnt'),
        )
        .where(sub.c.source_account_code.isnot(None))
        .group_by(sub.c.source_account_code)
    )).all()

    cash_breakdown = []
    cash_total = Decimal('0')
    for r in cash_rows:
        if not _is_cash_code(r.source_account_code):
            continue
        debit = Decimal(str(r.debit or 0))
        credit = Decimal(str(r.credit or 0))
        balance = debit - credit
        cash_total += balance
        cash_breakdown.append({
            "code": r.source_account_code,
            "name": r.name or '',
            "balance": float(balance),
            "debit_total": float(debit),
            "credit_total": float(credit),
            "count": r.cnt,
        })

    # 통장별: cash 코드 + merchant_name 그룹
    bank_sub = unified_aggregation_subquery(period_start=period_start, period_end=period_end)
    bank_rows = (await db.execute(
        select(
            bank_sub.c.merchant_name,
            bank_sub.c.source_account_code,
            func.max(bank_sub.c.source_account_name).label('source_name'),
            func.coalesce(func.sum(bank_sub.c.debit_amount), 0).label('debit'),
            func.coalesce(func.sum(bank_sub.c.credit_amount), 0).label('credit'),
            func.count().label('cnt'),
        )
        .where(
            bank_sub.c.source_account_code.in_(_CASH_CODES),
            bank_sub.c.merchant_name.isnot(None),
        )
        .group_by(bank_sub.c.merchant_name, bank_sub.c.source_account_code)
        .order_by(func.count().desc())
        .limit(20)
    )).all()

    bank_accounts = []
    for r in bank_rows:
        debit = Decimal(str(r.debit or 0))
        credit = Decimal(str(r.credit or 0))
        bank_accounts.append({
            "merchant_name": r.merchant_name,
            "source_code": r.source_account_code,
            "source_name": r.source_name,
            "balance": float(debit - credit),
            "debit_total": float(debit),
            "credit_total": float(credit),
            "count": r.cnt,
        })

    # 2) 카드 (미지급금 253 — merchant_name별)
    card_sub = unified_aggregation_subquery(period_start=period_start, period_end=period_end)
    card_rows = (await db.execute(
        select(
            card_sub.c.merchant_name,
            card_sub.c.source_account_code,
            func.max(card_sub.c.source_account_name).label('source_name'),
            func.coalesce(func.sum(card_sub.c.debit_amount), 0).label('debit'),
            func.coalesce(func.sum(card_sub.c.credit_amount), 0).label('credit'),
            func.count().label('cnt'),
        )
        .where(
            card_sub.c.source_account_code.in_(_PAYABLE_CODES),
            card_sub.c.merchant_name.isnot(None),
        )
        .group_by(card_sub.c.merchant_name, card_sub.c.source_account_code)
        .order_by(func.count().desc())
        .limit(20)
    )).all()

    cards = []
    for r in card_rows:
        debit = Decimal(str(r.debit or 0))
        credit = Decimal(str(r.credit or 0))
        # 미지급금은 부채 — 사용액 = credit (대변에 발생), 결제 = debit (차변)
        cards.append({
            "merchant_name": r.merchant_name,
            "source_code": r.source_account_code,
            "source_name": r.source_name,
            "usage": float(credit),
            "payment": float(debit),
            "outstanding": float(credit - debit),
            "count": r.cnt,
        })

    # 3) 세금계산서 매출/매입 요약
    async def _agg_codes(codes: tuple):
        s = unified_aggregation_subquery(period_start=period_start, period_end=period_end)
        return (await db.execute(
            select(
                func.coalesce(func.sum(s.c.debit_amount), 0).label('debit'),
                func.coalesce(func.sum(s.c.credit_amount), 0).label('credit'),
                func.count().label('cnt'),
            ).where(s.c.source_account_code.in_(codes))
        )).one()

    ar = await _agg_codes(_AR_CODES)
    ap = await _agg_codes(_AP_CODES)
    vat_out = await _agg_codes(_VAT_OUT)
    vat_in = await _agg_codes(_VAT_IN)

    return {
        "period": {
            "start": period_start.isoformat() if period_start else None,
            "end": period_end.isoformat() if period_end else None,
        },
        "available_cash": {
            "total": float(cash_total),
            "breakdown": cash_breakdown,
        },
        "bank_accounts": bank_accounts,
        "cards": cards,
        "tax_invoice": {
            "sales": {
                "issued": float(ar.debit or 0),
                "collected": float(ar.credit or 0),
                "outstanding": float((ar.debit or 0) - (ar.credit or 0)),
                "count": ar.cnt,
                "vat": float(vat_out.credit or 0),
            },
            "purchase": {
                "received": float(ap.credit or 0),
                "paid": float(ap.debit or 0),
                "outstanding": float((ap.credit or 0) - (ap.debit or 0)),
                "count": ap.cnt,
                "vat": float(vat_in.debit or 0),
            },
        },
    }


@router.get("/source-transactions")
async def get_source_transactions(
    source_account_code: Optional[str] = None,
    merchant_name: Optional[str] = None,
    period_start: Optional[date] = None,
    period_end: Optional[date] = None,
    page: int = Query(1, ge=1),
    size: int = Query(100, ge=1, le=1000),
    db: AsyncSession = Depends(get_db),
):
    """
    통합 조회 우측 패널용 — 특정 통장/카드의 거래 내역.
    unified_ledger 기반.
    """
    rows_sub = unified_rows_subquery(period_start=period_start, period_end=period_end)

    filters = []
    if source_account_code:
        filters.append(rows_sub.c.source_account_code == source_account_code)
    if merchant_name:
        filters.append(rows_sub.c.merchant_name == merchant_name)

    base_filter = and_(*filters) if filters else True

    total = await db.scalar(
        select(func.count()).select_from(rows_sub).where(base_filter)
    ) or 0

    db_rows = (await db.execute(
        select(rows_sub)
        .where(base_filter)
        .order_by(
            rows_sub.c.transaction_date.desc(),
            rows_sub.c.id.desc(),
        )
        .offset((page - 1) * size)
        .limit(size)
    )).all()

    return {
        "total": total,
        "page": page,
        "size": size,
        "items": [
            {
                "id": r.id,
                "transaction_date": r.transaction_date,  # 이미 'YYYY-MM-DD' 형식
                "description": r.description,
                "merchant_name": r.merchant_name,
                "counterparty_account_code": r.counterparty_account_code,
                "counterparty_account_name": r.counterparty_account_name,
                "debit": float(r.debit_amount or 0),
                "credit": float(r.credit_amount or 0),
            }
            for r in db_rows
        ],
    }
