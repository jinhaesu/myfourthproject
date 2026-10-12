"""
4대보험 기준 저장 — 회계팀이 화면에서 요율·비자규칙·근로자개별설정을 편집하고,
급여 산정(insurance_policy.assess)이 이 값을 읽어 동작한다. create_all 자동생성.
"""
from datetime import datetime
from typing import Optional

from sqlalchemy import Integer, String, Float, Boolean, DateTime, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class InsuranceRate(Base):
    """연도별 4대보험 요율/기준(근로자부담). 회계팀 편집."""
    __tablename__ = "insurance_rate"
    __table_args__ = ({"extend_existing": True},)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    year: Mapped[int] = mapped_column(Integer, unique=True, index=True)
    pension_emp: Mapped[float] = mapped_column(Float, default=0.0475)
    health_emp: Mapped[float] = mapped_column(Float, default=0.03595)
    ltc_on_health: Mapped[float] = mapped_column(Float, default=0.1314)
    employment_ui_emp: Mapped[float] = mapped_column(Float, default=0.009)
    pension_base_min: Mapped[float] = mapped_column(Float, default=410000)
    pension_base_max: Mapped[float] = mapped_column(Float, default=6590000)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class InsuranceVisaRule(Base):
    """체류자격(비자)별 4대보험 가입규칙. 회계팀 편집."""
    __tablename__ = "insurance_visa_rule"
    __table_args__ = ({"extend_existing": True},)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    visa_type: Mapped[str] = mapped_column(String(20), unique=True, index=True)  # 'KR','F-5','E-9' …
    pension: Mapped[str] = mapped_column(String(20), default="reciprocity")   # mandatory/excluded/reciprocity/optional
    health: Mapped[str] = mapped_column(String(20), default="mandatory")      # mandatory/excluded
    employment: Mapped[str] = mapped_column(String(20), default="optional")   # mandatory/e9h2/optional/excluded
    ltc_exclusion_eligible: Mapped[bool] = mapped_column(Boolean, default=False)
    label: Mapped[Optional[str]] = mapped_column(String(60), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class InsuranceWorkerOverride(Base):
    """근로자 개별 확정설정 — 국적 상호주의/장기요양 제외신청/실업급여 임의가입 등."""
    __tablename__ = "insurance_worker_override"
    __table_args__ = ({"extend_existing": True},)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    worker_key: Mapped[str] = mapped_column(String(120), unique=True, index=True)  # 이름 또는 id_number
    nationality_country: Mapped[Optional[str]] = mapped_column(String(60), nullable=True)
    pension_country_excluded: Mapped[bool] = mapped_column(Boolean, default=False)   # 상호주의 적용제외국 확정
    ltc_exclusion_applied: Mapped[bool] = mapped_column(Boolean, default=False)      # 장기요양 제외신청 완료
    ui_opt_in: Mapped[bool] = mapped_column(Boolean, default=False)                  # 실업급여 임의가입 신청
    memo: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
