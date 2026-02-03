"""
Smart Finance Core - Accounting Schemas
회계 전표 관련 API 스키마
"""
from datetime import datetime, date
from decimal import Decimal
from typing import Optional, List
from pydantic import BaseModel, Field, field_validator


class AccountResponse(BaseModel):
    """계정과목 응답 스키마"""
    id: int
    code: str
    name: str
    category_id: int
    category_name: Optional[str] = None
    parent_id: Optional[int] = None
    level: int
    is_detail: bool
    is_vat_applicable: bool
    vat_rate: Decimal
    is_active: bool

    class Config:
        from_attributes = True


class VoucherLineCreate(BaseModel):
    """전표 행 생성 스키마"""
    account_id: int
    debit_amount: Decimal = Field(default=Decimal("0"), ge=0)
    credit_amount: Decimal = Field(default=Decimal("0"), ge=0)
    vat_amount: Decimal = Field(default=Decimal("0"), ge=0)
    supply_amount: Decimal = Field(default=Decimal("0"), ge=0)
    description: Optional[str] = None
    counterparty_name: Optional[str] = None
    counterparty_business_number: Optional[str] = None
    cost_center_code: Optional[str] = None
    project_code: Optional[str] = None

    @field_validator('debit_amount', 'credit_amount')
    @classmethod
    def validate_amount(cls, v: Decimal) -> Decimal:
        if v < 0:
            raise ValueError('금액은 0 이상이어야 합니다')
        return v


class VoucherLineResponse(BaseModel):
    """전표 행 응답 스키마"""
    id: int
    line_number: int
    account_id: int
    account_code: Optional[str] = None
    account_name: Optional[str] = None
    debit_amount: Decimal
    credit_amount: Decimal
    vat_amount: Decimal
    supply_amount: Decimal
    description: Optional[str] = None
    counterparty_name: Optional[str] = None
    counterparty_business_number: Optional[str] = None
    cost_center_code: Optional[str] = None
    project_code: Optional[str] = None

    class Config:
        from_attributes = True


class VoucherCreate(BaseModel):
    """전표 생성 스키마"""
    voucher_date: date
    transaction_date: date
    description: str = Field(..., min_length=1, max_length=500)
    transaction_type: str  # card, bank_transfer, cash, tax_invoice, expense_report
    external_ref: Optional[str] = None
    department_id: int
    merchant_name: Optional[str] = None
    merchant_category: Optional[str] = None
    custom_tags: Optional[List[str]] = None
    lines: List[VoucherLineCreate]

    @field_validator('lines')
    @classmethod
    def validate_lines(cls, v: List[VoucherLineCreate]) -> List[VoucherLineCreate]:
        if not v:
            raise ValueError('최소 1개의 전표 행이 필요합니다')

        total_debit = sum(line.debit_amount for line in v)
        total_credit = sum(line.credit_amount for line in v)

        if total_debit != total_credit:
            raise ValueError(f'차변 합계({total_debit})와 대변 합계({total_credit})가 일치하지 않습니다')

        return v


class VoucherUpdate(BaseModel):
    """전표 수정 스키마"""
    voucher_date: Optional[date] = None
    transaction_date: Optional[date] = None
    description: Optional[str] = None
    merchant_name: Optional[str] = None
    custom_tags: Optional[List[str]] = None
    lines: Optional[List[VoucherLineCreate]] = None

    @field_validator('lines')
    @classmethod
    def validate_lines(cls, v: Optional[List[VoucherLineCreate]]) -> Optional[List[VoucherLineCreate]]:
        if v is None:
            return v

        if not v:
            raise ValueError('최소 1개의 전표 행이 필요합니다')

        total_debit = sum(line.debit_amount for line in v)
        total_credit = sum(line.credit_amount for line in v)

        if total_debit != total_credit:
            raise ValueError(f'차변 합계({total_debit})와 대변 합계({total_credit})가 일치하지 않습니다')

        return v


class VoucherResponse(BaseModel):
    """전표 응답 스키마"""
    id: int
    voucher_number: str
    voucher_date: date
    transaction_date: date
    description: str
    transaction_type: str
    external_ref: Optional[str] = None
    department_id: int
    department_name: Optional[str] = None
    created_by: int
    creator_name: Optional[str] = None
    total_debit: Decimal
    total_credit: Decimal
    status: str
    ai_classification_status: Optional[str] = None
    ai_confidence_score: Optional[Decimal] = None
    ai_suggested_account_id: Optional[int] = None
    ai_suggested_account_name: Optional[str] = None
    merchant_name: Optional[str] = None
    merchant_category: Optional[str] = None
    custom_tags: Optional[List[str]] = None
    lines: List[VoucherLineResponse] = []
    created_at: datetime
    updated_at: datetime
    confirmed_at: Optional[datetime] = None
    confirmed_by: Optional[int] = None

    class Config:
        from_attributes = True


class VoucherListResponse(BaseModel):
    """전표 목록 응답 스키마"""
    items: List[VoucherResponse]
    total: int
    page: int
    size: int
    pages: int


class CardTransactionImport(BaseModel):
    """카드 거래 내역 임포트 스키마"""
    transaction_date: date
    transaction_time: Optional[str] = None
    card_number_last4: str = Field(..., min_length=4, max_length=4)
    merchant_name: str
    merchant_category: Optional[str] = None
    amount: Decimal
    approval_number: str
    description: Optional[str] = None


class TaxInvoiceImport(BaseModel):
    """세금계산서 임포트 스키마"""
    invoice_number: str
    issue_date: date
    supplier_business_number: str
    supplier_name: str
    supply_amount: Decimal
    vat_amount: Decimal
    total_amount: Decimal
    description: Optional[str] = None
