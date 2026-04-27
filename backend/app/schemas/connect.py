"""
Connect Schemas — 클로브커넥트 (세무대리인 전용)
수임고객 통합관리, 자동 수집, 결산 자동화 (위하고 업로드)
"""
from datetime import datetime, date
from decimal import Decimal
from typing import Optional, List, Literal
from pydantic import BaseModel, Field


ClientStatus = Literal["active", "paused", "terminated", "onboarding"]
CollectionStatus = Literal["healthy", "stale", "error", "not_connected"]
ClosingStatus = Literal["not_started", "in_progress", "review", "completed"]


class TaxClient(BaseModel):
    """수임고객"""
    id: int
    company_name: str
    business_number: str
    representative_name: Optional[str] = None
    contact_email: Optional[str] = None
    contact_phone: Optional[str] = None
    industry: Optional[str] = None
    client_status: ClientStatus = "active"
    onboarded_at: Optional[date] = None
    monthly_fee: Optional[Decimal] = None
    notes: Optional[str] = None
    is_clobe_ai_connected: bool = False  # 수임고객이 클로브AI를 쓰는지
    auto_collection_status: CollectionStatus = "not_connected"
    last_data_synced_at: Optional[datetime] = None
    pending_voucher_count: int = 0
    classification_rate: Optional[float] = None  # 0~1
    next_closing_due: Optional[date] = None


class TaxClientCreate(BaseModel):
    """수임고객 등록"""
    company_name: str
    business_number: str
    representative_name: Optional[str] = None
    contact_email: Optional[str] = None
    contact_phone: Optional[str] = None
    industry: Optional[str] = None
    monthly_fee: Optional[Decimal] = None
    notes: Optional[str] = None


class TaxClientUpdate(BaseModel):
    """수임고객 수정"""
    company_name: Optional[str] = None
    representative_name: Optional[str] = None
    contact_email: Optional[str] = None
    contact_phone: Optional[str] = None
    industry: Optional[str] = None
    client_status: Optional[ClientStatus] = None
    monthly_fee: Optional[Decimal] = None
    notes: Optional[str] = None


class TaxClientListFilter(BaseModel):
    """수임고객 목록 필터"""
    client_status: Optional[ClientStatus] = None
    collection_status: Optional[CollectionStatus] = None
    only_pending_review: bool = False
    search: Optional[str] = None
    page: int = 1
    size: int = 50


class TaxClientListResponse(BaseModel):
    """수임고객 목록 응답"""
    items: List[TaxClient]
    total: int
    page: int
    size: int
    summary: dict  # active/paused/error counts


# ==================== 자동 수집 ====================

class CollectionSource(BaseModel):
    """수임고객 데이터 수집 소스"""
    id: int
    client_id: int
    source_type: Literal["bank", "card", "tax_invoice", "homtax_id"]
    institution_name: str
    label: str
    last_synced_at: Optional[datetime] = None
    sync_status: CollectionStatus
    error_message: Optional[str] = None
    is_active: bool = True


class ClientCollectionStatus(BaseModel):
    """클라이언트별 자동 수집 현황"""
    client_id: int
    client_name: str
    sources: List[CollectionSource]
    total_collected_today: int
    last_full_sync_at: Optional[datetime] = None
    next_scheduled_sync_at: Optional[datetime] = None


# ==================== 전표 검토 ====================

class PendingVoucher(BaseModel):
    """검토 대기 전표"""
    voucher_id: int
    client_id: int
    transaction_date: date
    description: str
    counterparty: Optional[str] = None
    amount: Decimal
    direction: Literal["debit", "credit"]
    suggested_account_code: str
    suggested_account_name: str
    confidence: float  # 0~1
    requires_review: bool


class PendingVoucherListResponse(BaseModel):
    """검토 대기 전표 목록"""
    items: List[PendingVoucher]
    total: int
    high_confidence_count: int
    low_confidence_count: int


# ==================== 결산 자동화 ====================

class ClosingPeriod(BaseModel):
    """결산 기간"""
    id: int
    client_id: int
    fiscal_year: int
    period_type: Literal["monthly", "quarterly", "yearly"]
    period_start: date
    period_end: date
    status: ClosingStatus
    voucher_total_count: int
    voucher_classified_count: int
    classification_rate: float
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    completed_by_user_id: Optional[int] = None
    wehago_uploaded_at: Optional[datetime] = None
    notes: Optional[str] = None


class ClosingStartRequest(BaseModel):
    """결산 시작 요청"""
    client_id: int
    fiscal_year: int
    period_type: Literal["monthly", "quarterly", "yearly"]
    period_start: date
    period_end: date


class ClosingCompleteRequest(BaseModel):
    """결산 완료 처리"""
    closing_period_id: int
    notes: Optional[str] = None


class WehagoExportRequest(BaseModel):
    """위하고 업로드용 파일 생성"""
    client_id: int
    closing_period_id: int
    file_format: Literal["wehago_csv", "wehago_xlsx", "wehago_xml"] = "wehago_xlsx"
    include_attachments: bool = False


class WehagoExportResponse(BaseModel):
    """위하고 export 결과"""
    export_id: int
    client_id: int
    file_url: str
    file_format: str
    voucher_count: int
    file_size_bytes: int
    expires_at: datetime
    generated_at: datetime
