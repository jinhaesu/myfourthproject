"""
Daily Cash Report Schemas — 실시간 자금일보
"""
from datetime import datetime, date
from decimal import Decimal
from typing import Optional, List, Literal
from pydantic import BaseModel, Field


class AccountBalanceSnapshot(BaseModel):
    """계좌별 잔액 스냅샷"""
    bank_account_id: int
    bank_name: str
    account_alias: str
    account_number_masked: str
    opening_balance: Decimal  # 전일 마감 잔액
    closing_balance: Decimal  # 당일 잔액
    change: Decimal  # 변동 금액
    inbound_total: Decimal
    outbound_total: Decimal


class CashFlowItem(BaseModel):
    """주요 입출금 항목 (TOP-N 표시용)"""
    transaction_id: int
    transaction_time: Optional[str] = None
    counterparty: str
    amount: Decimal
    direction: Literal["inbound", "outbound"]
    description: str


class DailyReportSummary(BaseModel):
    """자금일보 요약"""
    report_date: date
    total_balance: Decimal  # 전체 계좌 합계
    yesterday_balance: Decimal
    change_amount: Decimal
    change_pct: float
    inbound_total: Decimal
    outbound_total: Decimal
    net_cashflow: Decimal


class DailyReportResponse(BaseModel):
    """자금일보 전체 응답"""
    summary: DailyReportSummary
    accounts: List[AccountBalanceSnapshot]
    top_inbound: List[CashFlowItem]  # 상위 입금 5건
    top_outbound: List[CashFlowItem]  # 상위 출금 5건
    upcoming_payments_amount: Decimal  # 7일 내 예정 지급
    overdue_receivables_amount: Decimal  # 연체 매출채권
    generated_at: datetime


class DailyReportSubscription(BaseModel):
    """자금일보 구독 설정"""
    id: int
    user_id: int
    delivery_method: Literal["email", "kakao", "slack"]
    delivery_target: str  # email address / phone / webhook url
    schedule_time: str  # "09:00"
    is_active: bool = True
    include_attachments: bool = True


class DailyReportSubscriptionCreate(BaseModel):
    """구독 생성"""
    delivery_method: Literal["email", "kakao", "slack"]
    delivery_target: str
    schedule_time: str = "09:00"
    include_attachments: bool = True


class DailyReportHistoryItem(BaseModel):
    """발송 이력"""
    id: int
    report_date: date
    sent_at: datetime
    delivery_method: str
    delivery_target: str
    status: Literal["sent", "failed", "pending"]
    error_message: Optional[str] = None
