"""
Smart Finance Core - Budget Models
예산 관리 모델
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


class BudgetPeriodType(enum.Enum):
    """예산 기간 유형"""
    MONTHLY = "monthly"
    QUARTERLY = "quarterly"
    YEARLY = "yearly"


class BudgetStatus(enum.Enum):
    """예산 상태"""
    DRAFT = "draft"  # 초안
    PENDING_APPROVAL = "pending_approval"  # 승인 대기
    APPROVED = "approved"  # 승인됨
    ACTIVE = "active"  # 활성 (집행 중)
    CLOSED = "closed"  # 마감


class Budget(Base):
    """예산 (헤더)"""
    __tablename__ = "budgets"
    __table_args__ = (
        Index("ix_budgets_department_year", "department_id", "fiscal_year"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)

    # Period
    fiscal_year: Mapped[int] = mapped_column(Integer, index=True)  # 회계연도
    period_type: Mapped[BudgetPeriodType] = mapped_column(
        SQLEnum(BudgetPeriodType, native_enum=False), default=BudgetPeriodType.YEARLY
    )
    period_number: Mapped[int] = mapped_column(Integer, default=1)  # 월/분기 번호

    # Organization
    department_id: Mapped[int] = mapped_column(Integer, ForeignKey("departments.id"))
    budget_name: Mapped[str] = mapped_column(String(200))

    # Amounts
    total_amount: Mapped[Decimal] = mapped_column(Numeric(18, 2), default=Decimal("0"))
    used_amount: Mapped[Decimal] = mapped_column(Numeric(18, 2), default=Decimal("0"))
    remaining_amount: Mapped[Decimal] = mapped_column(
        Numeric(18, 2), default=Decimal("0")
    )

    # Status
    status: Mapped[BudgetStatus] = mapped_column(
        SQLEnum(BudgetStatus, native_enum=False), default=BudgetStatus.DRAFT
    )

    # Alert thresholds
    warning_threshold: Mapped[Decimal] = mapped_column(
        Numeric(5, 2), default=Decimal("80.00")
    )  # 80%
    critical_threshold: Mapped[Decimal] = mapped_column(
        Numeric(5, 2), default=Decimal("95.00")
    )  # 95%

    # Notes
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    # Timestamps
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )
    approved_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    approved_by: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("users.id"), nullable=True
    )
    created_by: Mapped[int] = mapped_column(Integer, ForeignKey("users.id"))

    # Relationships
    department: Mapped["Department"] = relationship("Department", back_populates="budgets")
    lines: Mapped[List["BudgetLine"]] = relationship(
        "BudgetLine", back_populates="budget", cascade="all, delete-orphan"
    )
    usage_history: Mapped[List["BudgetUsage"]] = relationship(
        "BudgetUsage", back_populates="budget"
    )

    def __repr__(self):
        return f"<Budget {self.budget_name} ({self.fiscal_year})>"


class BudgetLine(Base):
    """예산 상세 (계정과목별)"""
    __tablename__ = "budget_lines"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    budget_id: Mapped[int] = mapped_column(Integer, ForeignKey("budgets.id"))
    account_id: Mapped[int] = mapped_column(Integer, ForeignKey("accounts.id"))

    # Monthly breakdown (optional)
    jan_amount: Mapped[Decimal] = mapped_column(Numeric(18, 2), default=Decimal("0"))
    feb_amount: Mapped[Decimal] = mapped_column(Numeric(18, 2), default=Decimal("0"))
    mar_amount: Mapped[Decimal] = mapped_column(Numeric(18, 2), default=Decimal("0"))
    apr_amount: Mapped[Decimal] = mapped_column(Numeric(18, 2), default=Decimal("0"))
    may_amount: Mapped[Decimal] = mapped_column(Numeric(18, 2), default=Decimal("0"))
    jun_amount: Mapped[Decimal] = mapped_column(Numeric(18, 2), default=Decimal("0"))
    jul_amount: Mapped[Decimal] = mapped_column(Numeric(18, 2), default=Decimal("0"))
    aug_amount: Mapped[Decimal] = mapped_column(Numeric(18, 2), default=Decimal("0"))
    sep_amount: Mapped[Decimal] = mapped_column(Numeric(18, 2), default=Decimal("0"))
    oct_amount: Mapped[Decimal] = mapped_column(Numeric(18, 2), default=Decimal("0"))
    nov_amount: Mapped[Decimal] = mapped_column(Numeric(18, 2), default=Decimal("0"))
    dec_amount: Mapped[Decimal] = mapped_column(Numeric(18, 2), default=Decimal("0"))

    # Total
    annual_amount: Mapped[Decimal] = mapped_column(Numeric(18, 2), default=Decimal("0"))
    used_amount: Mapped[Decimal] = mapped_column(Numeric(18, 2), default=Decimal("0"))
    remaining_amount: Mapped[Decimal] = mapped_column(
        Numeric(18, 2), default=Decimal("0")
    )

    # Notes
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )

    # Relationships
    budget: Mapped["Budget"] = relationship("Budget", back_populates="lines")
    account: Mapped["Account"] = relationship("Account")

    def __repr__(self):
        return f"<BudgetLine {self.budget_id}:{self.account_id}>"


class BudgetUsage(Base):
    """예산 사용 기록"""
    __tablename__ = "budget_usage"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    budget_id: Mapped[int] = mapped_column(Integer, ForeignKey("budgets.id"))
    budget_line_id: Mapped[int] = mapped_column(Integer, ForeignKey("budget_lines.id"))

    # Reference
    voucher_id: Mapped[int] = mapped_column(Integer, ForeignKey("vouchers.id"))

    # Amount
    amount: Mapped[Decimal] = mapped_column(Numeric(18, 2))

    # Usage date
    usage_date: Mapped[date] = mapped_column(Date)
    usage_month: Mapped[int] = mapped_column(Integer)  # 1-12

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    # Relationships
    budget: Mapped["Budget"] = relationship("Budget", back_populates="usage_history")
    budget_line: Mapped["BudgetLine"] = relationship("BudgetLine")

    def __repr__(self):
        return f"<BudgetUsage {self.budget_id} {self.amount}>"
