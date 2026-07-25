"""
카드 사용내역 분류 — 직원이 본인 카드 사용 건별로 용도/분류를 입력.

그랜터 EXPENSE_TICKET은 DB에 저장하지 않으므로(실시간 조회),
분류 결과만 ticket_id 기준으로 저장하고 조회 시 조인한다.
스냅샷 필드(가맹점/금액/일시)는 관리자가 그랜터 재조회 없이 분류 현황을 볼 수 있게 함께 저장.
"""
from datetime import datetime
from typing import Optional
from sqlalchemy import Integer, String, Float, DateTime, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class CardUsageClassification(Base):
    """카드 사용 건별 분류 (직원 입력)"""
    __tablename__ = "card_usage_classifications"
    __table_args__ = {"extend_existing": True}

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    # 그랜터 티켓 ID (EXPENSE_TICKET id) — 건별 유일
    ticket_id: Mapped[str] = mapped_column(String(100), unique=True, index=True)
    card_key: Mapped[str] = mapped_column(String(200), index=True)

    # 스냅샷 (그랜터 재조회 없이 분류 현황 표시용)
    transact_at: Mapped[Optional[str]] = mapped_column(String(30), nullable=True)
    store_name: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    amount: Mapped[Optional[float]] = mapped_column(Float, nullable=True)

    # 분류 입력값
    category: Mapped[str] = mapped_column(String(100))  # 용도 분류 (예: 식대, 소모품, 교통비)
    memo: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)

    classified_by: Mapped[str] = mapped_column(String(255), index=True)  # 분류한 사용자 이메일
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow,
    )


class CardMonthlyClosing(Base):
    """카드 월별 분류 마감 — 직원이 그 달 사용내역 전건 분류 후 제출.

    마감되면 해당 카드·월의 분류는 잠금(관리자만 해제 가능),
    관리자 카드관리 화면에 월별 분류 완료 자료로 표시된다.
    """
    __tablename__ = "card_monthly_closings"
    __table_args__ = (
        UniqueConstraint("card_key", "month", name="uq_card_monthly_closing"),
        {"extend_existing": True},
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    card_key: Mapped[str] = mapped_column(String(200), index=True)
    month: Mapped[str] = mapped_column(String(7), index=True)  # 'YYYY-MM'

    transaction_count: Mapped[int] = mapped_column(Integer, default=0)
    total_amount: Mapped[float] = mapped_column(Float, default=0.0)
    # 분류 카테고리별 합계 JSON (예: {"식대": 120000, "소모품": 43000})
    category_summary: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    closed_by: Mapped[str] = mapped_column(String(255))
    closed_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
