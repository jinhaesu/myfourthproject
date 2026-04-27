"""
Tax Invoice Schemas — 세금계산서 발행/조회
홈택스 공동인증서 없이 클로브AI 내에서 직접 발행하는 방식 모방
"""
from datetime import datetime, date
from decimal import Decimal
from typing import Optional, List, Literal
from pydantic import BaseModel, Field


InvoiceDirection = Literal["sales", "purchase"]  # 매출(발행), 매입(수취)
InvoiceType = Literal["tax", "tax_free"]  # 과세, 면세
InvoiceStatus = Literal["draft", "issued", "sent", "approved", "cancelled", "rejected"]


class TaxInvoiceItem(BaseModel):
    """세금계산서 품목"""
    line_no: int
    name: str  # 품명
    spec: Optional[str] = None  # 규격
    quantity: Optional[Decimal] = None
    unit_price: Optional[Decimal] = None
    supply_amount: Decimal  # 공급가액
    tax_amount: Decimal  # 세액
    description: Optional[str] = None


class TaxInvoiceParty(BaseModel):
    """세금계산서 공급자/공급받는자"""
    business_number: str  # 사업자등록번호 (123-45-67890)
    company_name: str
    representative_name: str
    address: Optional[str] = None
    business_type: Optional[str] = None  # 업태
    business_item: Optional[str] = None  # 종목
    contact_email: Optional[str] = None
    contact_phone: Optional[str] = None


class TaxInvoiceCreate(BaseModel):
    """세금계산서 발행 요청"""
    direction: InvoiceDirection = "sales"
    invoice_type: InvoiceType = "tax"
    issue_date: date
    supply_date: date
    supplier: TaxInvoiceParty
    receiver: TaxInvoiceParty
    items: List[TaxInvoiceItem] = Field(..., min_length=1)
    cash_amount: Decimal = Decimal("0")
    check_amount: Decimal = Decimal("0")
    note_amount: Decimal = Decimal("0")  # 어음
    credit_amount: Decimal = Decimal("0")  # 외상미수금
    note: Optional[str] = None
    auto_send_to_receiver: bool = True


class TaxInvoiceResponse(BaseModel):
    """세금계산서 응답"""
    id: int
    invoice_number: str  # 국세청 발급 번호
    direction: InvoiceDirection
    invoice_type: InvoiceType
    status: InvoiceStatus
    issue_date: date
    supply_date: date
    supplier: TaxInvoiceParty
    receiver: TaxInvoiceParty
    items: List[TaxInvoiceItem]
    total_supply_amount: Decimal
    total_tax_amount: Decimal
    total_amount: Decimal
    cash_amount: Decimal
    check_amount: Decimal
    note_amount: Decimal
    credit_amount: Decimal
    note: Optional[str] = None
    issued_at: Optional[datetime] = None
    sent_at: Optional[datetime] = None
    cancelled_at: Optional[datetime] = None
    nts_confirmation_number: Optional[str] = None  # 국세청 승인번호
    pdf_url: Optional[str] = None
    issued_by_user_id: Optional[int] = None
    created_at: datetime


class TaxInvoiceListFilter(BaseModel):
    """세금계산서 목록 필터"""
    direction: Optional[InvoiceDirection] = None
    status: Optional[InvoiceStatus] = None
    counterparty_business_number: Optional[str] = None
    from_date: Optional[date] = None
    to_date: Optional[date] = None
    page: int = 1
    size: int = 50


class TaxInvoiceListResponse(BaseModel):
    """세금계산서 목록 응답"""
    items: List[TaxInvoiceResponse]
    total: int
    page: int
    size: int
    total_supply_amount: Decimal
    total_tax_amount: Decimal


class TaxInvoiceCancelRequest(BaseModel):
    """세금계산서 취소"""
    reason: str
    cancel_date: date


class TaxInvoiceCounterpartyTemplate(BaseModel):
    """자주 쓰는 거래처 템플릿"""
    id: int
    nickname: str
    party: TaxInvoiceParty
    last_used_at: Optional[datetime] = None
    usage_count: int = 0
