"""
Daily Cash Report (AI 자금 다이제스트) 모델

clobe.ai 스타일 자금일보:
- 사용자별 설정 (어떤 섹션을 어떤 순서로 표시할지)
- 매일 발송된 자금일보 snapshot 보관 (재조회용)
- 섹션: cash_status, ai_cashflow, card_spending, card_usage
"""
from datetime import datetime, date
from typing import Optional
from sqlalchemy import Integer, String, Boolean, DateTime, Date, Text, ForeignKey, Index
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


# 기본 섹션 순서 (clobe.ai 예시 그대로)
DEFAULT_SECTIONS = [
    "ai_cashflow",      # AI 현금흐름 분석 — 잔액 추이 + 주요 입출금
    "card_spending",    # 카드 지출 분석 — 지출 추이 + 어제 결제
    "cash_status",      # 자금 현황 (필수) — 입출금 현황 + 잔액
    "card_usage",       # 카드 사용 현황 — 어제 결제 + 이번달 누적
]

SECTION_LABELS = {
    "ai_cashflow": "AI 현금흐름 분석",
    "card_spending": "카드 지출 분석",
    "cash_status": "자금 현황",
    "card_usage": "카드 사용 현황",
}

SECTION_DESCRIPTIONS = {
    "ai_cashflow": "우리 회사의 현금흐름을 AI가 요약해드려요",
    "card_spending": "주요 결제내역과 카드 지출 추이를 AI가 요약해드려요",
    "cash_status": "입금·출금 현황과 현 시점의 잔액과 가용자금을 알려드려요",
    "card_usage": "어제 결제된 카드 지출과 이번달 누적 카드 지출을 정리해드려요",
}

# 자금 현황은 필수 — UI에서 토글 불가
REQUIRED_SECTIONS = {"cash_status"}


class DailyCashReportConfig(Base):
    """사용자별 자금일보 설정"""
    __tablename__ = "daily_cash_report_configs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    user_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("users.id"), unique=True, index=True,
    )
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)

    # JSON 배열 — 섹션 키 순서대로
    sections: Mapped[str] = mapped_column(
        Text, default='["ai_cashflow","card_spending","cash_status","card_usage"]',
    )
    # JSON 배열 — 토글 비활성화 섹션 목록 (cash_status는 항상 활성)
    disabled_sections: Mapped[str] = mapped_column(Text, default="[]")

    # 발송 시각 (HH:MM, 기본 09:00)
    delivery_time: Mapped[str] = mapped_column(String(5), default="09:00")

    # 발송 채널 JSON 배열: ["email", "slack", "mobile"]
    delivery_channels: Mapped[str] = mapped_column(
        Text, default='["email"]',
    )

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow,
    )


class DailyCashReportSnapshot(Base):
    """발송된 자금일보 본문 보관 (재조회용)"""
    __tablename__ = "daily_cash_report_snapshots"
    __table_args__ = (
        Index("ix_dcr_snapshots_user_date", "user_id", "report_date", unique=True),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    user_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id"), index=True)
    report_date: Mapped[date] = mapped_column(Date, index=True)

    # JSON — 섹션별 콘텐츠 (key: section_id, value: dict)
    content: Mapped[str] = mapped_column(Text)

    # JSON 배열 — 발송된 채널
    sent_channels: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    sent_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
