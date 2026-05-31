"""
Smart Finance Core - Payroll Models
급여(인건비) 관리 모델
"""
from datetime import datetime, date
from decimal import Decimal
from typing import Optional, List

from sqlalchemy import (
    Integer, String, Boolean, DateTime, ForeignKey,
    Text, Numeric, Date, Index
)
from sqlalchemy.orm import relationship, Mapped, mapped_column

from app.core.database import Base


class PayrollBatch(Base):
    """급여 배치 — 귀속월 단위 급여 묶음"""
    __tablename__ = "payroll_batches"
    __table_args__ = (
        Index("ix_payroll_batches_period", "period"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    period: Mapped[str] = mapped_column(String(7), nullable=False, index=True)  # "YYYY-MM"
    pay_date: Mapped[date] = mapped_column(Date, nullable=False)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="DRAFT")
    # DRAFT / CONFIRMED / POSTED

    # 분개 전표 연결 (POSTED 상태일 때 설정)
    voucher_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("vouchers.id", ondelete="SET NULL"), nullable=True
    )

    # 합계 (records 합산 후 갱신)
    total_gross: Mapped[Decimal] = mapped_column(Numeric(18, 2), default=Decimal("0"))
    total_deduction: Mapped[Decimal] = mapped_column(Numeric(18, 2), default=Decimal("0"))
    total_net: Mapped[Decimal] = mapped_column(Numeric(18, 2), default=Decimal("0"))

    memo: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )

    # Relationships
    records: Mapped[List["PayrollRecord"]] = relationship(
        "PayrollRecord",
        back_populates="batch",
        cascade="all, delete-orphan",
        lazy="selectin",
    )

    def __repr__(self):
        return f"<PayrollBatch {self.period} {self.title} [{self.status}]>"


class PayrollRecord(Base):
    """사원별 급여 명세"""
    __tablename__ = "payroll_records"
    __table_args__ = (
        Index("ix_payroll_records_batch_id", "batch_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    batch_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("payroll_batches.id", ondelete="CASCADE"),
        nullable=False, index=True
    )

    # 사원 정보
    employee_code: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)
    employee_name: Mapped[str] = mapped_column(String(100), nullable=False)
    department: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    position: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    cost_type: Mapped[str] = mapped_column(String(10), nullable=False, default="SGA")
    # "COGS"(제조원가/노무비) / "SGA"(판관비/급여)

    # 지급항목
    base_pay: Mapped[Decimal] = mapped_column(Numeric(18, 2), default=Decimal("0"))
    meal_allowance: Mapped[Decimal] = mapped_column(Numeric(18, 2), default=Decimal("0"))
    overtime_pay: Mapped[Decimal] = mapped_column(Numeric(18, 2), default=Decimal("0"))
    bonus: Mapped[Decimal] = mapped_column(Numeric(18, 2), default=Decimal("0"))
    other_allowance: Mapped[Decimal] = mapped_column(Numeric(18, 2), default=Decimal("0"))
    gross_pay: Mapped[Decimal] = mapped_column(Numeric(18, 2), default=Decimal("0"))

    # 공제항목
    income_tax: Mapped[Decimal] = mapped_column(Numeric(18, 2), default=Decimal("0"))
    local_tax: Mapped[Decimal] = mapped_column(Numeric(18, 2), default=Decimal("0"))
    national_pension: Mapped[Decimal] = mapped_column(Numeric(18, 2), default=Decimal("0"))
    health_insurance: Mapped[Decimal] = mapped_column(Numeric(18, 2), default=Decimal("0"))
    employment_insurance: Mapped[Decimal] = mapped_column(Numeric(18, 2), default=Decimal("0"))
    longterm_care: Mapped[Decimal] = mapped_column(Numeric(18, 2), default=Decimal("0"))
    other_deduction: Mapped[Decimal] = mapped_column(Numeric(18, 2), default=Decimal("0"))
    total_deduction: Mapped[Decimal] = mapped_column(Numeric(18, 2), default=Decimal("0"))

    # 차인지급액
    net_pay: Mapped[Decimal] = mapped_column(Numeric(18, 2), default=Decimal("0"))

    # 원본 행 보관 (양식 확정 전 유연성)
    raw_json: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    # Relationships
    batch: Mapped["PayrollBatch"] = relationship(
        "PayrollBatch", back_populates="records"
    )

    def __repr__(self):
        return f"<PayrollRecord {self.employee_name} batch={self.batch_id}>"
