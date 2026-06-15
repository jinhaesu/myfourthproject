"""
Unified View Schemas — 통합 데이터 실시간 조회
계좌, 법인카드, 세금계산서를 한 화면에서 조회
"""
from datetime import datetime, date
from decimal import Decimal
from typing import Optional, List, Literal
from pydantic import BaseModel, Field


SourceType = Literal["bank", "card", "tax_invoice"]
DirectionType = Literal["inbound", "outbound"]


class UnifiedTransactionItem(BaseModel):
    """통합 거래 아이템 (계좌/카드/세금계산서를 동일 모델로 표현)"""
    id: str
    source: SourceType
    source_label: str  # "신한은행 운영계좌", "삼성카드 4342", "전자세금계산서"
    transaction_date: date
    transaction_time: Optional[str] = None
    direction: DirectionType
    amount: Decimal
    description: str
    counterparty: Optional[str] = None
    category: Optional[str] = None  # AI 분류 결과
    is_classified: bool = False
    memo: Optional[str] = None


class UnifiedFilter(BaseModel):
    """통합 조회 필터"""
    from_date: Optional[date] = None
    to_date: Optional[date] = None
    sources: Optional[List[SourceType]] = None
    direction: Optional[DirectionType] = None
    counterparty: Optional[str] = None
    min_amount: Optional[Decimal] = None
    max_amount: Optional[Decimal] = None
    search: Optional[str] = None
    only_unclassified: bool = False
    page: int = 1
    size: int = 50


class UnifiedSummary(BaseModel):
    """통합 요약 카드 데이터"""
    total_balance: Decimal  # 모든 계좌 잔액 합
    bank_count: int
    card_count: int
    tax_invoice_count: int
    inbound_total: Decimal  # 기간 내 입금 합계
    outbound_total: Decimal  # 기간 내 출금 합계
    last_sync_at: Optional[datetime] = None
    unclassified_count: int  # AI 분류 미처리 건수


class UnifiedListResponse(BaseModel):
    """통합 목록 응답"""
    items: List[UnifiedTransactionItem]
    total: int
    page: int
    size: int
    summary: UnifiedSummary


class DataSource(BaseModel):
    """연동된 데이터 소스 (계좌, 카드, 홈택스 인증서 등)"""
    id: int
    type: SourceType
    name: str
    institution: str  # 신한은행, 삼성카드, 홈택스
    last_sync_at: Optional[datetime] = None
    sync_status: Literal["ok", "error", "pending"]
    error_message: Optional[str] = None
    is_active: bool = True


class DataSourceCreate(BaseModel):
    """신규 데이터 소스 연동 요청"""
    type: SourceType
    institution: str
    credential_token: str  # 실제 구현에서는 OAuth/스크래핑 토큰
    name: Optional[str] = None
