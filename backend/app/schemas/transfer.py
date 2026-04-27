"""
Account Transfer Schemas — 계좌 이체
회사 내·외부 계좌 이체 신청, 예약 이체, 이체 이력
"""
from datetime import datetime, date
from decimal import Decimal
from typing import Optional, List, Literal
from pydantic import BaseModel, Field


TransferStatus = Literal["draft", "pending_approval", "approved", "scheduled", "executing", "completed", "failed", "cancelled"]
TransferType = Literal["normal", "scheduled", "recurring", "bulk"]


class TransferRequest(BaseModel):
    """단일 이체 요청"""
    from_bank_account_id: int
    to_bank_code: str
    to_account_number: str
    to_account_holder: str
    amount: Decimal = Field(..., gt=0)
    memo_outgoing: Optional[str] = None  # 보낸이 표시
    memo_incoming: Optional[str] = None  # 받는이 표시
    scheduled_date: Optional[date] = None  # 미래 날짜이면 예약 이체
    description: Optional[str] = None
    related_payable_id: Optional[int] = None  # 매입채무 결제용
    require_approval: bool = True


class BulkTransferItem(BaseModel):
    """대량 이체 개별 건"""
    line_no: int
    to_bank_code: str
    to_account_number: str
    to_account_holder: str
    amount: Decimal = Field(..., gt=0)
    memo_outgoing: Optional[str] = None
    memo_incoming: Optional[str] = None
    description: Optional[str] = None


class BulkTransferRequest(BaseModel):
    """대량 이체 요청"""
    from_bank_account_id: int
    items: List[BulkTransferItem] = Field(..., min_length=1)
    scheduled_date: Optional[date] = None
    description: Optional[str] = None
    require_approval: bool = True


class TransferResponse(BaseModel):
    """이체 응답"""
    id: int
    transfer_type: TransferType
    status: TransferStatus
    from_bank_account_id: int
    from_bank_name: str
    from_account_alias: str
    to_bank_code: str
    to_bank_name: str
    to_account_number_masked: str
    to_account_holder: str
    amount: Decimal
    fee: Decimal = Decimal("0")
    memo_outgoing: Optional[str] = None
    memo_incoming: Optional[str] = None
    scheduled_date: Optional[date] = None
    executed_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    failure_reason: Optional[str] = None
    bank_transaction_id: Optional[str] = None  # 은행 거래 고유번호
    requested_by_user_id: int
    approved_by_user_id: Optional[int] = None
    approved_at: Optional[datetime] = None
    related_payable_id: Optional[int] = None
    description: Optional[str] = None
    created_at: datetime


class TransferListFilter(BaseModel):
    """이체 목록 필터"""
    status: Optional[TransferStatus] = None
    from_bank_account_id: Optional[int] = None
    from_date: Optional[date] = None
    to_date: Optional[date] = None
    counterparty_search: Optional[str] = None
    min_amount: Optional[Decimal] = None
    max_amount: Optional[Decimal] = None
    page: int = 1
    size: int = 50


class TransferListResponse(BaseModel):
    """이체 목록 응답"""
    items: List[TransferResponse]
    total: int
    page: int
    size: int
    total_amount: Decimal


class TransferOTPVerifyRequest(BaseModel):
    """이체 실행 시 2차 인증"""
    transfer_id: int
    otp_code: str


class TransferRecipientBookmark(BaseModel):
    """자주 쓰는 입금 계좌"""
    id: int
    nickname: str
    bank_code: str
    bank_name: str
    account_number_masked: str
    account_holder: str
    last_used_at: Optional[datetime] = None
    usage_count: int = 0


class TransferRecipientBookmarkCreate(BaseModel):
    """자주 쓰는 입금 계좌 등록"""
    nickname: str
    bank_code: str
    account_number: str
    account_holder: str
