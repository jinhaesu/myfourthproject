"""
급여 세금 계산 기준 설정 + 확정 급여월 세금 오버라이드(외부 확인값 입력).
"""
from datetime import datetime
from typing import Optional
from sqlalchemy import Integer, String, Float, DateTime, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class PayrollTaxSetting(Base):
    """급여 세금/보험 요율 설정 (단일 행 — id=1 사용)."""
    __tablename__ = "payroll_tax_settings"
    __table_args__ = {"extend_existing": True}

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    # 4대보험 근로자 부담 요율 (%)
    national_pension_rate: Mapped[float] = mapped_column(Float, default=4.5)
    health_insurance_rate: Mapped[float] = mapped_column(Float, default=3.545)
    long_term_care_rate: Mapped[float] = mapped_column(Float, default=12.95)  # 건강보험료의 %
    employment_insurance_rate: Mapped[float] = mapped_column(Float, default=0.9)
    # 사업소득 원천징수 (%)
    freelance_withholding_rate: Mapped[float] = mapped_column(Float, default=3.3)
    # 지방소득세 = 소득세의 %
    local_tax_rate: Mapped[float] = mapped_column(Float, default=10.0)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow,
    )


class PayrollTaxOverride(Base):
    """확정 급여월·직원별 세금 외부 확인값 오버라이드 (세무사 확정값 입력)."""
    __tablename__ = "payroll_tax_overrides"
    __table_args__ = (
        UniqueConstraint("month", "worker_name", name="uq_payroll_tax_override"),
        {"extend_existing": True},
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    month: Mapped[str] = mapped_column(String(7), index=True)  # YYYY-MM
    worker_name: Mapped[str] = mapped_column(String(100))
    income_tax: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    local_tax: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    insurance: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    memo: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    updated_by: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow,
    )
