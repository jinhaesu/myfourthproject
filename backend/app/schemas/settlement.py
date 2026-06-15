"""
Settlement Schemas — 매출·매입·거래처 정산
거래처별로 매출(받을 돈)과 매입(줄 돈)을 한곳에서 정산
"""
from datetime import datetime, date
from decimal import Decimal
from typing import Optional, List, Literal
from pydantic import BaseModel


CounterpartyType = Literal["customer", "vendor", "both"]
SettlementStatus = Literal["pending", "partial", "settled", "overdue"]


class CounterpartyBalance(BaseModel):
    """거래처별 정산 잔액"""
    counterparty_id: int
    counterparty_name: str
    business_number: Optional[str] = None
    counterparty_type: CounterpartyType
    receivable_total: Decimal  # 받을 금액 (매출채권)
    payable_total: Decimal  # 줄 금액 (매입채무)
    net_balance: Decimal  # receivable - payable
    last_transaction_date: Optional[date] = None
    overdue_amount: Decimal = Decimal("0")
    status: SettlementStatus
    contact_person: Optional[str] = None
    contact_phone: Optional[str] = None


class SettlementListResponse(BaseModel):
    """정산 목록 응답"""
    items: List[CounterpartyBalance]
    total_count: int
    total_receivable: Decimal
    total_payable: Decimal
    total_net: Decimal


class SettlementDetailItem(BaseModel):
    """거래처 상세의 개별 거래 내역"""
    id: int
    transaction_date: date
    document_type: Literal["tax_invoice", "receivable", "payable", "payment"]
    document_number: Optional[str] = None
    direction: Literal["receivable", "payable"]
    amount: Decimal
    settled_amount: Decimal
    outstanding: Decimal
    due_date: Optional[date] = None
    status: SettlementStatus
    description: Optional[str] = None


class SettlementDetailResponse(BaseModel):
    """거래처 상세 정산"""
    counterparty: CounterpartyBalance
    items: List[SettlementDetailItem]


class SettlementOffsetRequest(BaseModel):
    """채권/채무 상계 요청"""
    counterparty_id: int
    receivable_ids: List[int]
    payable_ids: List[int]
    offset_amount: Decimal
    note: Optional[str] = None


class SettlementOffsetResponse(BaseModel):
    """상계 처리 결과"""
    offset_id: int
    counterparty_id: int
    offset_amount: Decimal
    affected_receivable_ids: List[int]
    affected_payable_ids: List[int]
    new_net_balance: Decimal
    created_at: datetime
