"""
카드 관리 — 그랜터 카드 식별자에 사용자 별명 부여.
"""
from datetime import datetime
from typing import Optional
from sqlalchemy import Integer, String, Boolean, DateTime
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class CardAlias(Base):
    """그랜터 카드 식별자 → 사용자 별명 매핑"""
    __tablename__ = "card_aliases"
    __table_args__ = {"extend_existing": True}

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    # 그랜터 카드 식별자 — cardName (예: '비씨카드(3917)')
    card_key: Mapped[str] = mapped_column(String(200), unique=True, index=True)
    # 사용자 별명 (예: '마케팅 법인카드')
    nickname: Mapped[str] = mapped_column(String(100))
    # 카드사 (자동 추출, 예: '비씨카드')
    issuer: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)
    # 카드번호 끝 4자리 등 (자동 추출)
    last4: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)
    # UI 색상 hex (예: '#3B82F6')
    color: Mapped[Optional[str]] = mapped_column(String(7), nullable=True)
    # 용도 메모 (예: '직원 식대용')
    memo: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow,
    )
