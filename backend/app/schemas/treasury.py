"""
Smart Finance Core - Treasury Schemas
자금 관리 관련 API 스키마
"""
from datetime import datetime, date
from decimal import Decimal
from typing import Optional, List
from pydantic import BaseModel, Field


class BankAccountCreate(BaseModel):
    """은행 계좌 생성 스키마"""
    bank_code: str
    bank_name: str
    account_number: str
    account_holder: str
    account_type: str  # operating, savings, payroll, tax, virtual
    account_alias: str
    gl_account_id: Optional[int] = None
    is_virtual_account_enabled: bool = False


class BankAccountResponse(BaseModel):
    """은행 계좌 응답 스키마"""
    id: int
    bank_code: str
    bank_name: str
    account_number_masked: str  # 마스킹된 계좌번호
    account_holder: str
    account_type: str
    account_alias: str
    current_balance: Decimal
    available_balance: Decimal
    last_balance_update: Optional[datetime] = None
    gl_account_id: Optional[int] = None
    is_virtual_account_enabled: bool
    api_connected: bool
    api_last_sync: Optional[datetime] = None
    is_active: bool

    class Config:
        from_attributes = True


class BankTransactionResponse(BaseModel):
    """은행 거래 내역 응답 스키마"""
    id: int
    bank_account_id: int
    bank_alias: Optional[str] = None
    transaction_date: date
    transaction_time: Optional[str] = None
    direction: str  # inbound, outbound
    amount: Decimal
    balance_after: Decimal
    description: str
    counterparty_name: Optional[str] = None
    counterparty_account: Optional[str] = None
    reconciliation_status: str
    matched_voucher_id: Optional[int] = None
    matched_receivable_id: Optional[int] = None
    matched_payable_id: Optional[int] = None

    class Config:
        from_attributes = True


class ReceivableCreate(BaseModel):
    """매출채권 생성 스키마"""
    customer_name: str
    customer_business_number: Optional[str] = None
    invoice_number: Optional[str] = None
    tax_invoice_number: Optional[str] = None
    original_amount: Decimal = Field(..., gt=0)
    invoice_date: date
    due_date: date
    notes: Optional[str] = None


class ReceivableResponse(BaseModel):
    """매출채권 응답 스키마"""
    id: int
    customer_name: str
    customer_business_number: Optional[str] = None
    invoice_number: Optional[str] = None
    tax_invoice_number: Optional[str] = None
    original_amount: Decimal
    collected_amount: Decimal
    outstanding_amount: Decimal
    invoice_date: date
    due_date: date
    status: str
    assigned_virtual_account: Optional[str] = None
    days_overdue: int
    notes: Optional[str] = None
    created_at: datetime
    collected_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class PayableCreate(BaseModel):
    """매입채무 생성 스키마"""
    vendor_name: str
    vendor_business_number: Optional[str] = None
    invoice_number: Optional[str] = None
    tax_invoice_number: Optional[str] = None
    original_amount: Decimal = Field(..., gt=0)
    invoice_date: date
    due_date: date
    vendor_bank_account: Optional[str] = None
    notes: Optional[str] = None


class PayableResponse(BaseModel):
    """매입채무 응답 스키마"""
    id: int
    vendor_name: str
    vendor_business_number: Optional[str] = None
    invoice_number: Optional[str] = None
    tax_invoice_number: Optional[str] = None
    original_amount: Decimal
    paid_amount: Decimal
    outstanding_amount: Decimal
    invoice_date: date
    due_date: date
    status: str
    payment_bank_account_id: Optional[int] = None
    vendor_bank_account: Optional[str] = None
    days_overdue: int
    notes: Optional[str] = None
    created_at: datetime
    paid_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class PaymentScheduleCreate(BaseModel):
    """지급 스케줄 생성 스키마"""
    payable_id: int
    scheduled_date: date
    scheduled_amount: Decimal = Field(..., gt=0)
    bank_account_id: int


class PaymentScheduleResponse(BaseModel):
    """지급 스케줄 응답 스키마"""
    id: int
    payable_id: int
    vendor_name: Optional[str] = None
    scheduled_date: date
    scheduled_amount: Decimal
    bank_account_id: int
    bank_alias: Optional[str] = None
    is_executed: bool
    executed_at: Optional[datetime] = None
    executed_amount: Optional[Decimal] = None
    approved_by: Optional[int] = None
    approved_at: Optional[datetime] = None
    created_at: datetime

    class Config:
        from_attributes = True


class ReconciliationMatchResponse(BaseModel):
    """매칭 결과 응답 스키마"""
    id: int
    bank_transaction_id: int
    matched_type: str
    matched_id: int
    matched_name: Optional[str] = None
    match_method: str
    confidence_score: Optional[Decimal] = None
    matched_amount: Decimal
    created_at: datetime
    matched_by: Optional[int] = None

    class Config:
        from_attributes = True


class ReconciliationSuggestion(BaseModel):
    """매칭 추천 스키마"""
    bank_transaction_id: int
    suggested_type: str  # receivable, payable
    suggested_id: int
    suggested_name: str
    confidence_score: Decimal
    match_criteria: str  # amount, name, both


class ReconciliationAction(BaseModel):
    """매칭 액션 스키마"""
    bank_transaction_id: int
    match_type: str  # receivable, payable, voucher
    match_id: int


class AgingReportItem(BaseModel):
    """연령 분석 항목"""
    customer_or_vendor: str
    total_amount: Decimal
    current: Decimal  # 만기 전
    days_1_30: Decimal
    days_31_60: Decimal
    days_61_90: Decimal
    days_over_90: Decimal


class AgingReportResponse(BaseModel):
    """연령 분석 리포트"""
    report_type: str  # receivables, payables
    report_date: date
    items: List[AgingReportItem]
    summary: AgingReportItem
