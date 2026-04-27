"""
Unified View API — 통합 데이터 실시간 조회
계좌·법인카드·세금계산서를 동일 모델로 한 화면에서 조회

NOTE: 본 파일은 라우트 스켈레톤. 비즈니스 로직은 별도 작업.
"""
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Optional, List
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
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


def _mock_summary() -> UnifiedSummary:
    """TODO: 실제 DB 집계로 대체"""
    return UnifiedSummary(
        total_balance=Decimal("327540000"),
        bank_count=4,
        card_count=3,
        tax_invoice_count=128,
        inbound_total=Decimal("89400000"),
        outbound_total=Decimal("62100000"),
        last_sync_at=datetime.utcnow(),
        unclassified_count=12,
    )


def _mock_items(size: int = 50) -> List[UnifiedTransactionItem]:
    """TODO: bank_transactions + card_transactions + tax_invoices UNION 쿼리로 대체"""
    base = datetime.utcnow().date()
    samples = [
        ("bank", "신한은행 운영계좌", "inbound", 12000000, "스마트로 PG 정산", "스마트로", "매출"),
        ("card", "삼성카드 4342", "outbound", 87000, "쿠팡 사무용품", "쿠팡", "소모품비"),
        ("tax_invoice", "전자세금계산서 매출", "inbound", 5500000, "(주)이마트 식자재 납품", "이마트", "매출"),
        ("bank", "국민은행 결제계좌", "outbound", 3200000, "임대료 송금", "강남빌딩", "임차료"),
        ("card", "현대카드 8821", "outbound", 25400, "스타벅스 강남점", "스타벅스", "복리후생비"),
    ]
    items: List[UnifiedTransactionItem] = []
    for i in range(min(size, 50)):
        s = samples[i % len(samples)]
        items.append(
            UnifiedTransactionItem(
                id=f"{s[0]}-{i+1}",
                source=s[0],  # type: ignore[arg-type]
                source_label=s[1],
                transaction_date=base - timedelta(days=i // 5),
                transaction_time=f"{9 + (i % 8):02d}:{(i * 13) % 60:02d}",
                direction=s[2],  # type: ignore[arg-type]
                amount=Decimal(str(s[3])),
                description=s[4],
                counterparty=s[5],
                category=s[6],
                is_classified=(i % 4 != 0),
                memo=None,
            )
        )
    return items


@router.get("/summary", response_model=UnifiedSummary)
async def get_unified_summary(
    from_date: Optional[date] = None,
    to_date: Optional[date] = None,
    db: AsyncSession = Depends(get_db),
):
    """
    통합 요약 카드
    - 전체 계좌 잔액 합
    - 연동된 소스 수
    - 기간 내 입출금 합계
    - 미분류 건수
    """
    # TODO: 실제 집계 쿼리
    return _mock_summary()


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
    통합 거래 내역 조회
    bank_transactions + card_transactions + tax_invoices를 단일 모델로 합쳐 반환
    """
    # TODO: UNION ALL 쿼리로 대체. 현재는 목 데이터 반환.
    items = _mock_items(size)
    return UnifiedListResponse(
        items=items,
        total=len(items),
        page=page,
        size=size,
        summary=_mock_summary(),
    )


@router.get("/sources", response_model=List[DataSource])
async def list_data_sources(
    db: AsyncSession = Depends(get_db),
):
    """연동된 데이터 소스 목록 (계좌·카드·홈택스)"""
    # TODO: 실제 데이터 소스 조회
    now = datetime.utcnow()
    return [
        DataSource(id=1, type="bank", name="신한은행 운영계좌", institution="신한은행",
                   last_sync_at=now, sync_status="ok", is_active=True),
        DataSource(id=2, type="bank", name="국민은행 결제계좌", institution="국민은행",
                   last_sync_at=now, sync_status="ok", is_active=True),
        DataSource(id=3, type="card", name="삼성카드 4342", institution="삼성카드",
                   last_sync_at=now, sync_status="ok", is_active=True),
        DataSource(id=4, type="tax_invoice", name="홈택스 전자세금계산서", institution="국세청 홈택스",
                   last_sync_at=now, sync_status="ok", is_active=True),
    ]


@router.post("/sources", response_model=DataSource, status_code=status.HTTP_201_CREATED)
async def create_data_source(
    source: DataSourceCreate,
    db: AsyncSession = Depends(get_db),
):
    """신규 데이터 소스 연동 (스크래핑/오픈뱅킹 OAuth)"""
    # TODO: 실제 연동 처리. 외부 인증 토큰 검증 + 초기 동기화 큐잉.
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
    """특정 소스 즉시 동기화"""
    # TODO: 백그라운드 태스크 큐잉
    return {"source_id": source_id, "status": "syncing", "queued_at": datetime.utcnow().isoformat()}


@router.delete("/sources/{source_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_data_source(
    source_id: int,
    db: AsyncSession = Depends(get_db),
):
    """소스 연동 해제 (실제 거래 데이터는 유지)"""
    # TODO: source.is_active=False 처리
    return
