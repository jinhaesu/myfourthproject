"""
Connect API — 클로브커넥트 (세무대리인 전용)
- 수임고객 통합관리
- 거래 내역 자동 수집
- 결산 자동화 (위하고 업로드)

NOTE: 라우트 스켈레톤.
"""
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Optional, List
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.schemas.connect import (
    TaxClient,
    TaxClientCreate,
    TaxClientUpdate,
    TaxClientListResponse,
    ClientStatus,
    CollectionStatus,
    ClosingStatus,
    CollectionSource,
    ClientCollectionStatus,
    PendingVoucher,
    PendingVoucherListResponse,
    ClosingPeriod,
    ClosingStartRequest,
    ClosingCompleteRequest,
    WehagoExportRequest,
    WehagoExportResponse,
)

router = APIRouter()


# ==================== 수임고객 통합관리 ====================

def _mock_client(idx: int) -> TaxClient:
    samples = [
        ("(주)알파푸드", "111-22-33333", "active", "healthy", 0.94, 12),
        ("베타다이닝", "222-33-44444", "active", "healthy", 0.91, 5),
        ("감마키친", "333-44-55555", "active", "stale", 0.85, 28),
        ("델타F&B", "444-55-66666", "onboarding", "not_connected", None, 0),
        ("입실론외식", "555-66-77777", "paused", "error", 0.72, 0),
        ("제타프랜차이즈", "666-77-88888", "active", "healthy", 0.96, 3),
    ]
    s = samples[idx % len(samples)]
    return TaxClient(
        id=idx + 1,
        company_name=s[0],
        business_number=s[1],
        representative_name=f"대표자{idx + 1}",
        contact_email=f"contact{idx + 1}@example.com",
        contact_phone=f"010-1234-{1000 + idx:04d}",
        industry="음식점/식품제조",
        client_status=s[2],  # type: ignore[arg-type]
        onboarded_at=date.today() - timedelta(days=30 + idx * 15),
        monthly_fee=Decimal("250000") + Decimal(str(idx * 50000)),
        notes=None,
        is_clobe_ai_connected=(idx % 2 == 0),
        auto_collection_status=s[3],  # type: ignore[arg-type]
        last_data_synced_at=datetime.utcnow() - timedelta(hours=idx * 2),
        pending_voucher_count=s[5],
        classification_rate=s[4],
        next_closing_due=date.today() + timedelta(days=10 - idx),
    )


@router.get("/clients", response_model=TaxClientListResponse)
async def list_clients(
    client_status: Optional[ClientStatus] = None,
    collection_status: Optional[CollectionStatus] = None,
    only_pending_review: bool = False,
    search: Optional[str] = None,
    page: int = Query(1, ge=1),
    size: int = Query(50, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
):
    """수임고객 목록 (대시보드용)"""
    # TODO: 실제 조회 + 집계
    items = [_mock_client(i) for i in range(min(size, 6))]
    summary = {
        "active": sum(1 for c in items if c.client_status == "active"),
        "paused": sum(1 for c in items if c.client_status == "paused"),
        "onboarding": sum(1 for c in items if c.client_status == "onboarding"),
        "errors": sum(1 for c in items if c.auto_collection_status == "error"),
        "total_pending_vouchers": sum(c.pending_voucher_count for c in items),
    }
    return TaxClientListResponse(
        items=items,
        total=len(items),
        page=page, size=size,
        summary=summary,
    )


@router.get("/clients/{client_id}", response_model=TaxClient)
async def get_client(
    client_id: int,
    db: AsyncSession = Depends(get_db),
):
    """수임고객 상세"""
    # TODO: 실제 조회
    return _mock_client(client_id - 1)


@router.post("/clients", response_model=TaxClient, status_code=status.HTTP_201_CREATED)
async def create_client(
    req: TaxClientCreate,
    db: AsyncSession = Depends(get_db),
):
    """수임고객 등록"""
    # TODO: 실제 등록 + 클로브AI 초대 메일 발송
    return TaxClient(
        id=999,
        company_name=req.company_name,
        business_number=req.business_number,
        representative_name=req.representative_name,
        contact_email=req.contact_email,
        contact_phone=req.contact_phone,
        industry=req.industry,
        client_status="onboarding",
        onboarded_at=date.today(),
        monthly_fee=req.monthly_fee,
        notes=req.notes,
        is_clobe_ai_connected=False,
        auto_collection_status="not_connected",
        last_data_synced_at=None,
        pending_voucher_count=0,
        classification_rate=None,
        next_closing_due=None,
    )


@router.patch("/clients/{client_id}", response_model=TaxClient)
async def update_client(
    client_id: int,
    req: TaxClientUpdate,
    db: AsyncSession = Depends(get_db),
):
    """수임고객 수정"""
    # TODO: 실제 수정
    cli = _mock_client(client_id - 1)
    if req.company_name:
        cli.company_name = req.company_name
    if req.client_status:
        cli.client_status = req.client_status
    return cli


@router.delete("/clients/{client_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_client(
    client_id: int,
    db: AsyncSession = Depends(get_db),
):
    """수임고객 해지"""
    # TODO: client_status='terminated'
    return


# ==================== 자동 수집 ====================

@router.get("/clients/{client_id}/collection", response_model=ClientCollectionStatus)
async def get_collection_status(
    client_id: int,
    db: AsyncSession = Depends(get_db),
):
    """클라이언트별 자동 수집 현황"""
    # TODO: 실제 collection 상태 조회
    sources = [
        CollectionSource(
            id=1, client_id=client_id, source_type="bank",
            institution_name="신한은행", label="운영계좌",
            last_synced_at=datetime.utcnow() - timedelta(hours=2),
            sync_status="healthy", is_active=True,
        ),
        CollectionSource(
            id=2, client_id=client_id, source_type="card",
            institution_name="삼성카드", label="법인카드 4342",
            last_synced_at=datetime.utcnow() - timedelta(hours=4),
            sync_status="healthy", is_active=True,
        ),
        CollectionSource(
            id=3, client_id=client_id, source_type="tax_invoice",
            institution_name="홈택스", label="전자세금계산서",
            last_synced_at=datetime.utcnow() - timedelta(days=2),
            sync_status="stale", is_active=True,
            error_message="홈택스 인증서 만료 임박",
        ),
    ]
    return ClientCollectionStatus(
        client_id=client_id,
        client_name=_mock_client(client_id - 1).company_name,
        sources=sources,
        total_collected_today=42,
        last_full_sync_at=datetime.utcnow() - timedelta(hours=2),
        next_scheduled_sync_at=datetime.utcnow() + timedelta(hours=1),
    )


@router.post("/clients/{client_id}/collection/trigger")
async def trigger_collection(
    client_id: int,
    source_id: Optional[int] = None,
    db: AsyncSession = Depends(get_db),
):
    """수집 즉시 실행 (전체 또는 특정 소스)"""
    # TODO: 백그라운드 수집 큐잉
    return {
        "client_id": client_id,
        "source_id": source_id,
        "status": "queued",
        "queued_at": datetime.utcnow().isoformat(),
    }


# ==================== 검토 대기 전표 ====================

def _mock_pending_voucher(idx: int, client_id: int) -> PendingVoucher:
    samples = [
        ("스타벅스 강남점", "스타벅스", 25400, "복리후생비", "831", 0.97),
        ("쿠팡 사무용품", "쿠팡", 87000, "소모품비", "830", 0.92),
        ("강남빌딩 임대료", "강남빌딩", 3200000, "임차료", "819", 0.99),
        ("불명 입금", None, 1500000, "가수금", "263", 0.51),  # low confidence
        ("(주)이마트 정산", "이마트", 8500000, "제품매출", "411", 0.94),
    ]
    s = samples[idx % len(samples)]
    return PendingVoucher(
        voucher_id=10000 + idx,
        client_id=client_id,
        transaction_date=date.today() - timedelta(days=idx % 7),
        description=s[0],
        counterparty=s[1],
        amount=Decimal(str(s[2])),
        direction="debit",
        suggested_account_code=s[4],
        suggested_account_name=s[3],
        confidence=s[5],
        requires_review=s[5] < 0.8,
    )


@router.get("/clients/{client_id}/pending-vouchers", response_model=PendingVoucherListResponse)
async def list_pending_vouchers(
    client_id: int,
    only_low_confidence: bool = False,
    page: int = Query(1, ge=1),
    size: int = Query(50, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
):
    """검토 대기 전표 목록 (AI 분류 결과 검증용)"""
    # TODO: 실제 조회
    items = [_mock_pending_voucher(i, client_id) for i in range(min(size, 5))]
    if only_low_confidence:
        items = [it for it in items if it.confidence < 0.8]
    return PendingVoucherListResponse(
        items=items,
        total=len(items),
        high_confidence_count=sum(1 for it in items if it.confidence >= 0.8),
        low_confidence_count=sum(1 for it in items if it.confidence < 0.8),
    )


@router.post("/vouchers/{voucher_id}/approve")
async def approve_pending_voucher(
    voucher_id: int,
    user_id: int = Query(...),
    db: AsyncSession = Depends(get_db),
):
    """검토 대기 전표 승인 (AI 분류 그대로 확정)"""
    # TODO: 실제 승인 처리
    return {"voucher_id": voucher_id, "status": "approved",
            "approved_by": user_id, "approved_at": datetime.utcnow().isoformat()}


@router.post("/vouchers/{voucher_id}/reclassify")
async def reclassify_voucher(
    voucher_id: int,
    new_account_code: str,
    user_id: int = Query(...),
    db: AsyncSession = Depends(get_db),
):
    """전표 계정과목 재지정 (AI 학습용 피드백 자동 생성)"""
    # TODO: 재분류 + 피드백 학습 데이터 적재
    return {"voucher_id": voucher_id, "new_account_code": new_account_code,
            "feedback_recorded": True}


# ==================== 결산 자동화 ====================

def _mock_closing(idx: int, client_id: int) -> ClosingPeriod:
    statuses: List[ClosingStatus] = ["completed", "review", "in_progress", "not_started"]
    return ClosingPeriod(
        id=idx + 1,
        client_id=client_id,
        fiscal_year=2026,
        period_type="monthly",
        period_start=date(2026, max(1, 4 - idx), 1),
        period_end=date(2026, max(1, 4 - idx), 28),
        status=statuses[idx % 4],
        voucher_total_count=320 - idx * 20,
        voucher_classified_count=290 - idx * 15,
        classification_rate=0.92 - idx * 0.03,
        started_at=datetime.utcnow() - timedelta(days=idx * 30),
        completed_at=datetime.utcnow() - timedelta(days=idx * 30 - 5) if idx == 0 else None,
        completed_by_user_id=1 if idx == 0 else None,
        wehago_uploaded_at=datetime.utcnow() - timedelta(days=idx * 30 - 7) if idx == 0 else None,
        notes=None,
    )


@router.get("/clients/{client_id}/closing-periods", response_model=List[ClosingPeriod])
async def list_closing_periods(
    client_id: int,
    fiscal_year: Optional[int] = None,
    status_filter: Optional[ClosingStatus] = Query(None, alias="status"),
    db: AsyncSession = Depends(get_db),
):
    """수임고객 결산 기간 목록"""
    # TODO: 실제 조회
    return [_mock_closing(i, client_id) for i in range(4)]


@router.post("/closing", response_model=ClosingPeriod, status_code=status.HTTP_201_CREATED)
async def start_closing(
    req: ClosingStartRequest,
    user_id: int = Query(...),
    db: AsyncSession = Depends(get_db),
):
    """결산 시작 (해당 기간 전표 락 + 분류율 집계 시작)"""
    # TODO: 실제 결산 시작
    return ClosingPeriod(
        id=999,
        client_id=req.client_id,
        fiscal_year=req.fiscal_year,
        period_type=req.period_type,
        period_start=req.period_start,
        period_end=req.period_end,
        status="in_progress",
        voucher_total_count=0,
        voucher_classified_count=0,
        classification_rate=0.0,
        started_at=datetime.utcnow(),
        completed_at=None,
        completed_by_user_id=None,
        wehago_uploaded_at=None,
        notes=None,
    )


@router.post("/closing/{closing_id}/complete", response_model=ClosingPeriod)
async def complete_closing(
    closing_id: int,
    req: ClosingCompleteRequest,
    user_id: int = Query(...),
    db: AsyncSession = Depends(get_db),
):
    """결산 완료 처리"""
    # TODO: 실제 완료 처리
    closing = _mock_closing(0, 1)
    closing.id = closing_id
    closing.status = "completed"
    closing.completed_at = datetime.utcnow()
    closing.completed_by_user_id = user_id
    closing.notes = req.notes
    return closing


@router.post("/closing/{closing_id}/wehago-export", response_model=WehagoExportResponse)
async def export_to_wehago(
    closing_id: int,
    req: WehagoExportRequest,
    db: AsyncSession = Depends(get_db),
):
    """
    위하고(Wehago) 업로드용 파일 생성
    - wehago_xlsx: 위하고 전표 일괄등록 양식
    - wehago_csv: 위하고 거래처/계정과목 등록용
    - wehago_xml: 위하고 통합 백업 양식
    """
    # TODO: 실제 위하고 양식 변환 + 파일 생성
    return WehagoExportResponse(
        export_id=999,
        client_id=req.client_id,
        file_url=f"https://example.com/wehago/{closing_id}/wehago_export.xlsx",
        file_format=req.file_format,
        voucher_count=320,
        file_size_bytes=512000,
        expires_at=datetime.utcnow() + timedelta(hours=24),
        generated_at=datetime.utcnow(),
    )


@router.get("/closing/{closing_id}/exports")
async def list_exports(
    closing_id: int,
    db: AsyncSession = Depends(get_db),
):
    """결산기간의 export 이력"""
    # TODO: 실제 조회
    return {
        "closing_id": closing_id,
        "exports": [
            {
                "export_id": 1,
                "file_format": "wehago_xlsx",
                "voucher_count": 320,
                "generated_at": (datetime.utcnow() - timedelta(days=2)).isoformat(),
                "file_url": "https://example.com/wehago/1/wehago_export.xlsx",
            }
        ],
    }
