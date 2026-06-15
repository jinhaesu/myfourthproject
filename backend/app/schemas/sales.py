"""
Smart Finance Core - Sales Schemas
매출 자동화 & 전표 전환 관련 API 스키마
"""
from datetime import datetime
from decimal import Decimal
from typing import Optional, List
from pydantic import BaseModel, Field


# ============================================================================
# SalesChannel Schemas
# ============================================================================

class SalesChannelCreate(BaseModel):
    """판매 채널 생성 스키마"""
    code: str = Field(..., min_length=1, max_length=50, description="채널 코드 (e.g. COUPANG)")
    name: str = Field(..., min_length=1, max_length=100, description="채널명 (e.g. 쿠팡)")
    channel_type: str = Field(..., description="online_marketplace, own_website, offline, wholesale")
    platform_url: Optional[str] = None
    api_type: str = Field(..., description="api, scraping, manual")
    api_endpoint: Optional[str] = None
    api_key: Optional[str] = None
    api_secret: Optional[str] = None
    seller_id: Optional[str] = None
    commission_rate: Decimal = Field(default=Decimal("0.00"), ge=0, le=100)
    settlement_day: Optional[int] = Field(None, ge=1, le=31)
    login_id: Optional[str] = None
    login_password: Optional[str] = None
    is_active: bool = True


class SalesChannelUpdate(BaseModel):
    """판매 채널 수정 스키마"""
    name: Optional[str] = None
    channel_type: Optional[str] = None
    platform_url: Optional[str] = None
    api_type: Optional[str] = None
    api_endpoint: Optional[str] = None
    api_key: Optional[str] = None
    api_secret: Optional[str] = None
    seller_id: Optional[str] = None
    commission_rate: Optional[Decimal] = Field(None, ge=0, le=100)
    settlement_day: Optional[int] = Field(None, ge=1, le=31)
    login_id: Optional[str] = None
    login_password: Optional[str] = None
    is_active: Optional[bool] = None


class SalesChannelResponse(BaseModel):
    """판매 채널 응답 스키마"""
    id: int
    code: str
    name: str
    channel_type: str
    platform_url: Optional[str] = None
    api_type: str
    api_endpoint: Optional[str] = None
    seller_id: Optional[str] = None
    commission_rate: Decimal
    settlement_day: Optional[int] = None
    is_active: bool
    last_sync_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


# ============================================================================
# SalesRecord Schemas
# ============================================================================

class SalesRecordCreate(BaseModel):
    """매출 기록 생성 스키마"""
    channel_id: int
    period_year: int = Field(..., ge=2000, le=2100)
    period_month: int = Field(..., ge=1, le=12)
    gross_sales: Decimal = Field(default=Decimal("0"), ge=0)
    returns: Decimal = Field(default=Decimal("0"), ge=0)
    net_sales: Decimal = Field(default=Decimal("0"), ge=0)
    commission: Decimal = Field(default=Decimal("0"), ge=0)
    settlement_amount: Decimal = Field(default=Decimal("0"), ge=0)
    order_count: int = Field(default=0, ge=0)
    cancel_count: int = Field(default=0, ge=0)
    notes: Optional[str] = None
    raw_data: Optional[dict] = None


class SalesRecordUpdate(BaseModel):
    """매출 기록 수정 스키마"""
    gross_sales: Optional[Decimal] = Field(None, ge=0)
    returns: Optional[Decimal] = Field(None, ge=0)
    net_sales: Optional[Decimal] = Field(None, ge=0)
    commission: Optional[Decimal] = Field(None, ge=0)
    settlement_amount: Optional[Decimal] = Field(None, ge=0)
    order_count: Optional[int] = Field(None, ge=0)
    cancel_count: Optional[int] = Field(None, ge=0)
    notes: Optional[str] = None
    raw_data: Optional[dict] = None


class SalesRecordResponse(BaseModel):
    """매출 기록 응답 스키마"""
    id: int
    channel_id: int
    channel_code: Optional[str] = None
    channel_name: Optional[str] = None
    period_year: int
    period_month: int
    gross_sales: Decimal
    returns: Decimal
    net_sales: Decimal
    commission: Decimal
    settlement_amount: Decimal
    order_count: int
    cancel_count: int
    status: str
    notes: Optional[str] = None
    synced_at: Optional[datetime] = None
    confirmed_at: Optional[datetime] = None
    converted_at: Optional[datetime] = None
    voucher_id: Optional[int] = None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


# ============================================================================
# SalesAutomationSchedule Schemas
# ============================================================================

class SalesAutomationScheduleCreate(BaseModel):
    """자동화 스케줄 생성 스키마"""
    name: str = Field(..., min_length=1, max_length=200)
    schedule_type: str = Field(..., description="daily, weekly, monthly")
    schedule_day: Optional[int] = Field(None, ge=1, le=31)
    schedule_time: Optional[str] = Field(None, pattern=r"^\d{2}:\d{2}$")
    target_channels: Optional[List[int]] = None
    email_recipients: Optional[List[str]] = None
    email_subject_template: Optional[str] = None
    include_excel: bool = True
    is_active: bool = True


class SalesAutomationScheduleUpdate(BaseModel):
    """자동화 스케줄 수정 스키마"""
    name: Optional[str] = Field(None, min_length=1, max_length=200)
    schedule_type: Optional[str] = None
    schedule_day: Optional[int] = Field(None, ge=1, le=31)
    schedule_time: Optional[str] = Field(None, pattern=r"^\d{2}:\d{2}$")
    target_channels: Optional[List[int]] = None
    email_recipients: Optional[List[str]] = None
    email_subject_template: Optional[str] = None
    include_excel: Optional[bool] = None
    is_active: Optional[bool] = None


class SalesAutomationScheduleResponse(BaseModel):
    """자동화 스케줄 응답 스키마"""
    id: int
    name: str
    schedule_type: str
    schedule_day: Optional[int] = None
    schedule_time: Optional[str] = None
    target_channels: Optional[List[int]] = None
    email_recipients: Optional[List[str]] = None
    email_subject_template: Optional[str] = None
    include_excel: bool
    is_active: bool
    last_run_at: Optional[datetime] = None
    next_run_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


# ============================================================================
# Summary & Report Schemas
# ============================================================================

class MonthlySalesSummary(BaseModel):
    """채널별 월간 요약"""
    channel_id: int
    channel_code: str
    channel_name: str
    channel_type: str
    period_year: int
    period_month: int
    gross_sales: Decimal
    returns: Decimal
    net_sales: Decimal
    commission: Decimal
    commission_rate: Decimal
    settlement_amount: Decimal
    order_count: int
    cancel_count: int
    status: str


class SalesReportData(BaseModel):
    """리포트용 집계 데이터"""
    period_year: int
    period_month: int
    total_gross_sales: Decimal
    total_returns: Decimal
    total_net_sales: Decimal
    total_commission: Decimal
    total_settlement: Decimal
    total_orders: int
    total_cancels: int
    channel_summaries: List[MonthlySalesSummary]


class ChannelTrendItem(BaseModel):
    """채널별 추이 아이템"""
    period_year: int
    period_month: int
    gross_sales: Decimal
    net_sales: Decimal
    commission: Decimal
    settlement_amount: Decimal
    order_count: int


class ChannelTrendResponse(BaseModel):
    """채널별 추이 응답"""
    channel_id: int
    channel_code: str
    channel_name: str
    trend: List[ChannelTrendItem]


class YearlySummaryItem(BaseModel):
    """연간 채널별 집계 아이템"""
    channel_id: int
    channel_code: str
    channel_name: str
    total_gross_sales: Decimal
    total_returns: Decimal
    total_net_sales: Decimal
    total_commission: Decimal
    total_settlement: Decimal
    total_orders: int
    total_cancels: int


class YearlySummaryResponse(BaseModel):
    """연간 집계 응답"""
    year: int
    grand_total_gross_sales: Decimal
    grand_total_net_sales: Decimal
    grand_total_commission: Decimal
    grand_total_settlement: Decimal
    channels: List[YearlySummaryItem]


# ============================================================================
# Voucher Conversion Schemas
# ============================================================================

class VoucherConversionRequest(BaseModel):
    """전표 전환 요청"""
    record_ids: List[int] = Field(..., min_length=1, description="전환할 매출 기록 ID 목록")
    user_id: int = Field(..., description="전환 요청 사용자 ID")
    department_id: int = Field(..., description="전표 부서 ID")
    description: Optional[str] = Field(None, description="전표 적요")


class VoucherConversionResponse(BaseModel):
    """전표 전환 응답"""
    converted_count: int
    voucher_ids: List[int]
    message: str


# ============================================================================
# Import Schema
# ============================================================================

class SalesExcelImportResponse(BaseModel):
    """엑셀 임포트 응답"""
    created_count: int
    updated_count: int
    error_count: int
    errors: List[dict] = []


# ============================================================================
# Report Email Schema
# ============================================================================

class SendReportRequest(BaseModel):
    """리포트 메일 발송 요청"""
    year: int = Field(..., ge=2000, le=2100)
    month: int = Field(..., ge=1, le=12)
    recipients: List[str] = Field(..., min_length=1, description="수신자 이메일 목록")
    subject: Optional[str] = None
