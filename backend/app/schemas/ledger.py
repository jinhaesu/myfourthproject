"""
Account Ledger Schemas — 계정별 원장 (총계정원장)
좌측 계정 리스트 + 우측 엑셀형 거래 그리드
"""
from datetime import date, datetime
from decimal import Decimal
from typing import Optional, List, Literal
from pydantic import BaseModel


AccountCategory = Literal[
    "asset", "liability", "equity", "revenue", "expense", "non_operating"
]


class LedgerAccount(BaseModel):
    """계정과목 (좌측 리스트 항목)"""
    account_code: str
    account_name: str
    category: AccountCategory
    parent_code: Optional[str] = None
    depth: int = 0  # 0: 대분류, 1: 중분류, 2: 세분류
    period_debit: Decimal  # 기간 차변 합계
    period_credit: Decimal  # 기간 대변 합계
    period_change: Decimal  # 변동 (asset/expense는 debit-credit, liability/equity/revenue는 credit-debit)
    closing_balance: Decimal  # 기말 잔액
    transaction_count: int  # 기간 내 거래 건수
    has_children: bool = False


class LedgerAccountTreeNode(LedgerAccount):
    """계정과목 트리 노드 (재귀)"""
    children: List["LedgerAccountTreeNode"] = []


class LedgerEntry(BaseModel):
    """원장 거래 (우측 그리드 행)"""
    id: int
    voucher_id: Optional[int] = None
    transaction_date: date
    transaction_number: Optional[str] = None  # 전표번호
    counterparty: Optional[str] = None
    description: str  # 적요
    debit: Decimal  # 차변
    credit: Decimal  # 대변
    running_balance: Decimal  # 누적 잔액 (running)
    counterparty_account_code: Optional[str] = None  # 상대 계정
    counterparty_account_name: Optional[str] = None
    department_name: Optional[str] = None
    project_tag: Optional[str] = None
    memo: Optional[str] = None
    is_locked: bool = False  # 결산 락
    created_at: datetime


class LedgerSummary(BaseModel):
    """선택 계정의 요약 (그리드 상단 KPI)"""
    account_code: str
    account_name: str
    category: AccountCategory
    period_start: date
    period_end: date
    opening_balance: Decimal  # 기초 잔액
    period_debit: Decimal
    period_credit: Decimal
    period_change: Decimal
    closing_balance: Decimal
    transaction_count: int
    avg_per_month: Decimal
    largest_debit: Optional[Decimal] = None
    largest_credit: Optional[Decimal] = None


class LedgerListRequest(BaseModel):
    """계정 트리 조회 필터"""
    fiscal_year: int
    period_start: Optional[date] = None
    period_end: Optional[date] = None
    category: Optional[AccountCategory] = None
    only_with_activity: bool = False  # 거래 있는 계정만
    search: Optional[str] = None


class LedgerEntriesFilter(BaseModel):
    """원장 거래 조회 필터"""
    account_code: str
    period_start: date
    period_end: date
    counterparty: Optional[str] = None
    direction: Optional[Literal["debit", "credit"]] = None
    min_amount: Optional[Decimal] = None
    max_amount: Optional[Decimal] = None
    department_id: Optional[int] = None
    search: Optional[str] = None
    page: int = 1
    size: int = 200


class LedgerEntriesResponse(BaseModel):
    """원장 거래 응답"""
    summary: LedgerSummary
    entries: List[LedgerEntry]
    total: int
    page: int
    size: int


class LedgerEntryUpdate(BaseModel):
    """원장 거래 수정 (적요·메모·태그)"""
    description: Optional[str] = None
    memo: Optional[str] = None
    project_tag: Optional[str] = None
    counterparty: Optional[str] = None


# Forward reference resolution
LedgerAccountTreeNode.model_rebuild()
