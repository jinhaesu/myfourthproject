"""
Smart Finance Core - Treasury Models
자금 관리, 채권/채무 관련 모델
"""
from datetime import datetime, date
from decimal import Decimal
from typing import Optional, List
from sqlalchemy import (
    Column, Integer, String, Boolean, DateTime, ForeignKey,
    Text, Numeric, Date, Enum as SQLEnum, Index
)
from sqlalchemy.orm import relationship, Mapped, mapped_column
import enum

from app.core.database import Base


class BankAccountType(enum.Enum):
    """계좌 유형"""
    OPERATING = "operating"  # 운영 계좌
    SAVINGS = "savings"  # 적금/예금
    PAYROLL = "payroll"  # 급여 계좌
    TAX = "tax"  # 세금 납부 계좌
    VIRTUAL = "virtual"  # 가상계좌


class TransactionDirection(enum.Enum):
    """거래 방향"""
    INBOUND = "inbound"  # 입금
    OUTBOUND = "outbound"  # 출금


class ReceivableStatus(enum.Enum):
    """매출채권 상태"""
    PENDING = "pending"  # 발생
    PARTIAL = "partial"  # 부분 입금
    COLLECTED = "collected"  # 전액 입금
    OVERDUE = "overdue"  # 연체
    BAD_DEBT = "bad_debt"  # 대손


class PayableStatus(enum.Enum):
    """매입채무 상태"""
    PENDING = "pending"  # 발생
    SCHEDULED = "scheduled"  # 지급 예정
    PARTIAL = "partial"  # 부분 지급
    PAID = "paid"  # 지급 완료
    OVERDUE = "overdue"  # 연체


class ReconciliationStatus(enum.Enum):
    """매칭 상태"""
    UNMATCHED = "unmatched"  # 미매칭
    AUTO_MATCHED = "auto_matched"  # 자동 매칭
    MANUAL_MATCHED = "manual_matched"  # 수동 매칭
    PARTIAL_MATCHED = "partial_matched"  # 부분 매칭
    DISPUTED = "disputed"  # 불일치


class BankAccount(Base):
    """은행 계좌"""
    __tablename__ = "bank_accounts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)

    # Bank info
    bank_code: Mapped[str] = mapped_column(String(20))  # 은행 코드
    bank_name: Mapped[str] = mapped_column(String(100))  # 은행명
    account_number: Mapped[str] = mapped_column(String(50), unique=True)  # 계좌번호 (암호화)
    account_holder: Mapped[str] = mapped_column(String(100))  # 예금주

    # Type
    account_type: Mapped[BankAccountType] = mapped_column(SQLEnum(BankAccountType))
    account_alias: Mapped[str] = mapped_column(String(100))  # 계좌 별칭

    # Balance
    current_balance: Mapped[Decimal] = mapped_column(
        Numeric(18, 2), default=Decimal("0")
    )
    available_balance: Mapped[Decimal] = mapped_column(
        Numeric(18, 2), default=Decimal("0")
    )
    last_balance_update: Mapped[Optional[datetime]] = mapped_column(
        DateTime, nullable=True
    )

    # Linked GL Account
    gl_account_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("accounts.id"), nullable=True
    )

    # Virtual account mapping (for AR)
    is_virtual_account_enabled: Mapped[bool] = mapped_column(Boolean, default=False)

    # API connection
    api_connected: Mapped[bool] = mapped_column(Boolean, default=False)
    api_last_sync: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )

    # Relationships
    transactions: Mapped[List["BankTransaction"]] = relationship(
        "BankTransaction", back_populates="bank_account"
    )

    def __repr__(self):
        return f"<BankAccount {self.account_alias} ({self.bank_name})>"


class BankTransaction(Base):
    """은행 거래 내역"""
    __tablename__ = "bank_transactions"
    __table_args__ = (
        Index("ix_bank_transactions_date", "transaction_date"),
        Index("ix_bank_transactions_account_date", "bank_account_id", "transaction_date"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    bank_account_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("bank_accounts.id")
    )

    # Transaction info
    transaction_date: Mapped[date] = mapped_column(Date, index=True)
    transaction_time: Mapped[Optional[str]] = mapped_column(String(8), nullable=True)  # HH:MM:SS
    direction: Mapped[TransactionDirection] = mapped_column(SQLEnum(TransactionDirection))

    # Amount
    amount: Mapped[Decimal] = mapped_column(Numeric(18, 2))
    balance_after: Mapped[Decimal] = mapped_column(Numeric(18, 2))

    # Description
    description: Mapped[str] = mapped_column(String(500))
    counterparty_name: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    counterparty_account: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)

    # Reference
    transaction_id: Mapped[Optional[str]] = mapped_column(
        String(100), unique=True, nullable=True
    )  # 은행 고유 거래ID

    # Reconciliation
    reconciliation_status: Mapped[ReconciliationStatus] = mapped_column(
        SQLEnum(ReconciliationStatus), default=ReconciliationStatus.UNMATCHED
    )
    matched_voucher_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("vouchers.id"), nullable=True
    )
    matched_receivable_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("receivables.id"), nullable=True
    )
    matched_payable_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("payables.id"), nullable=True
    )

    # Virtual account (for AR identification)
    virtual_account_number: Mapped[Optional[str]] = mapped_column(
        String(50), nullable=True
    )

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    # Relationships
    bank_account: Mapped["BankAccount"] = relationship(
        "BankAccount", back_populates="transactions"
    )

    def __repr__(self):
        return f"<BankTransaction {self.transaction_date} {self.direction.value} {self.amount}>"


class Receivable(Base):
    """매출채권 (미수금)"""
    __tablename__ = "receivables"
    __table_args__ = (
        Index("ix_receivables_customer_status", "customer_name", "status"),
        Index("ix_receivables_due_date", "due_date"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)

    # Customer info
    customer_name: Mapped[str] = mapped_column(String(200), index=True)
    customer_business_number: Mapped[Optional[str]] = mapped_column(
        String(20), nullable=True
    )

    # Document reference
    invoice_number: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    tax_invoice_number: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    voucher_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("vouchers.id"), nullable=True
    )

    # Amounts
    original_amount: Mapped[Decimal] = mapped_column(Numeric(18, 2))
    collected_amount: Mapped[Decimal] = mapped_column(
        Numeric(18, 2), default=Decimal("0")
    )
    outstanding_amount: Mapped[Decimal] = mapped_column(Numeric(18, 2))

    # Dates
    invoice_date: Mapped[date] = mapped_column(Date)
    due_date: Mapped[date] = mapped_column(Date)

    # Status
    status: Mapped[ReceivableStatus] = mapped_column(
        SQLEnum(ReceivableStatus), default=ReceivableStatus.PENDING
    )

    # Virtual account for this receivable
    assigned_virtual_account: Mapped[Optional[str]] = mapped_column(
        String(50), nullable=True
    )

    # Aging
    days_overdue: Mapped[int] = mapped_column(Integer, default=0)

    # Notes
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )
    collected_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    def __repr__(self):
        return f"<Receivable {self.customer_name} {self.outstanding_amount}>"


class Payable(Base):
    """매입채무 (미지급금)"""
    __tablename__ = "payables"
    __table_args__ = (
        Index("ix_payables_vendor_status", "vendor_name", "status"),
        Index("ix_payables_due_date", "due_date"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)

    # Vendor info
    vendor_name: Mapped[str] = mapped_column(String(200), index=True)
    vendor_business_number: Mapped[Optional[str]] = mapped_column(
        String(20), nullable=True
    )

    # Document reference
    invoice_number: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    tax_invoice_number: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    voucher_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("vouchers.id"), nullable=True
    )

    # Amounts
    original_amount: Mapped[Decimal] = mapped_column(Numeric(18, 2))
    paid_amount: Mapped[Decimal] = mapped_column(Numeric(18, 2), default=Decimal("0"))
    outstanding_amount: Mapped[Decimal] = mapped_column(Numeric(18, 2))

    # Dates
    invoice_date: Mapped[date] = mapped_column(Date)
    due_date: Mapped[date] = mapped_column(Date)

    # Status
    status: Mapped[PayableStatus] = mapped_column(
        SQLEnum(PayableStatus), default=PayableStatus.PENDING
    )

    # Payment info
    payment_bank_account_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("bank_accounts.id"), nullable=True
    )
    vendor_bank_account: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)

    # Aging
    days_overdue: Mapped[int] = mapped_column(Integer, default=0)

    # Notes
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )
    paid_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    def __repr__(self):
        return f"<Payable {self.vendor_name} {self.outstanding_amount}>"


class PaymentSchedule(Base):
    """지급 스케줄"""
    __tablename__ = "payment_schedules"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    payable_id: Mapped[int] = mapped_column(Integer, ForeignKey("payables.id"))

    scheduled_date: Mapped[date] = mapped_column(Date, index=True)
    scheduled_amount: Mapped[Decimal] = mapped_column(Numeric(18, 2))

    # Source bank account
    bank_account_id: Mapped[int] = mapped_column(Integer, ForeignKey("bank_accounts.id"))

    # Status
    is_executed: Mapped[bool] = mapped_column(Boolean, default=False)
    executed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    executed_amount: Mapped[Optional[Decimal]] = mapped_column(
        Numeric(18, 2), nullable=True
    )

    # Approval
    approved_by: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("users.id"), nullable=True
    )
    approved_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    created_by: Mapped[int] = mapped_column(Integer, ForeignKey("users.id"))

    def __repr__(self):
        return f"<PaymentSchedule {self.scheduled_date} {self.scheduled_amount}>"


class ReconciliationMatch(Base):
    """매칭 기록"""
    __tablename__ = "reconciliation_matches"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)

    bank_transaction_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("bank_transactions.id")
    )

    # Matched to
    matched_type: Mapped[str] = mapped_column(String(50))  # receivable, payable, voucher
    matched_id: Mapped[int] = mapped_column(Integer)

    # Match info
    match_method: Mapped[str] = mapped_column(String(50))  # auto, manual
    confidence_score: Mapped[Optional[Decimal]] = mapped_column(
        Numeric(5, 4), nullable=True
    )
    match_criteria: Mapped[Optional[str]] = mapped_column(
        Text, nullable=True
    )  # JSON: 매칭 기준

    # Amounts
    matched_amount: Mapped[Decimal] = mapped_column(Numeric(18, 2))

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    matched_by: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("users.id"), nullable=True
    )

    def __repr__(self):
        return f"<ReconciliationMatch {self.bank_transaction_id} -> {self.matched_type}:{self.matched_id}>"
