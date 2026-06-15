"""
Smart Finance Core - Sales Models
매출 자동화 & 전표 전환 관련 모델
"""
from datetime import datetime
from decimal import Decimal
from typing import Optional, List
from sqlalchemy import (
    Column, Integer, String, Boolean, DateTime, ForeignKey,
    Text, Numeric, Date, Enum as SQLEnum, Index, UniqueConstraint, JSON
)
from sqlalchemy.orm import relationship, Mapped, mapped_column
import enum

from app.core.database import Base


class ChannelType(enum.Enum):
    """판매 채널 유형"""
    ONLINE_MARKETPLACE = "online_marketplace"
    OWN_WEBSITE = "own_website"
    OFFLINE = "offline"
    WHOLESALE = "wholesale"


class ApiType(enum.Enum):
    """데이터 수집 방식"""
    API = "api"
    SCRAPING = "scraping"
    MANUAL = "manual"


class SalesRecordStatus(enum.Enum):
    """매출 기록 상태"""
    PENDING = "pending"
    CONFIRMED = "confirmed"
    SETTLED = "settled"
    CONVERTED = "converted"


class ScheduleType(enum.Enum):
    """자동화 스케줄 유형"""
    DAILY = "daily"
    WEEKLY = "weekly"
    MONTHLY = "monthly"


class SalesChannel(Base):
    """판매 채널 관리"""
    __tablename__ = "sales_channels"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    code: Mapped[str] = mapped_column(String(50), unique=True, index=True)  # e.g. "COUPANG"
    name: Mapped[str] = mapped_column(String(100))  # e.g. "쿠팡"

    channel_type: Mapped[ChannelType] = mapped_column(
        SQLEnum(ChannelType, native_enum=False)
    )

    platform_url: Mapped[Optional[str]] = mapped_column(
        String(500), nullable=True
    )  # 셀러센터 URL

    # 데이터 수집 방식
    api_type: Mapped[ApiType] = mapped_column(
        SQLEnum(ApiType, native_enum=False)
    )

    # API 연동 정보
    api_endpoint: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    api_key: Mapped[Optional[str]] = mapped_column(Text, nullable=True)  # encrypted
    api_secret: Mapped[Optional[str]] = mapped_column(Text, nullable=True)  # encrypted
    seller_id: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)

    # 수수료 및 정산
    commission_rate: Mapped[Decimal] = mapped_column(
        Numeric(5, 2), default=Decimal("0.00")
    )  # 수수료율 (%)
    settlement_day: Mapped[Optional[int]] = mapped_column(
        Integer, nullable=True
    )  # 정산일 (매월 N일)

    # 스크래핑용 로그인 정보
    login_id: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    login_password: Mapped[Optional[str]] = mapped_column(Text, nullable=True)  # encrypted

    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    last_sync_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )

    # Relationships
    sales_records: Mapped[List["SalesRecord"]] = relationship(
        "SalesRecord", back_populates="channel"
    )

    def __repr__(self):
        return f"<SalesChannel {self.code}: {self.name}>"


class SalesRecord(Base):
    """채널별 월간 매출 기록"""
    __tablename__ = "sales_records"
    __table_args__ = (
        UniqueConstraint("channel_id", "period_year", "period_month", name="uq_sales_records_channel_period"),
        Index("ix_sales_records_period", "period_year", "period_month"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    channel_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("sales_channels.id"), index=True
    )

    # 기간
    period_year: Mapped[int] = mapped_column(Integer)
    period_month: Mapped[int] = mapped_column(Integer)

    # 매출 데이터
    gross_sales: Mapped[Decimal] = mapped_column(
        Numeric(18, 2), default=Decimal("0")
    )  # 총매출
    returns: Mapped[Decimal] = mapped_column(
        Numeric(18, 2), default=Decimal("0")
    )  # 반품/환불
    net_sales: Mapped[Decimal] = mapped_column(
        Numeric(18, 2), default=Decimal("0")
    )  # 순매출
    commission: Mapped[Decimal] = mapped_column(
        Numeric(18, 2), default=Decimal("0")
    )  # 수수료
    settlement_amount: Mapped[Decimal] = mapped_column(
        Numeric(18, 2), default=Decimal("0")
    )  # 정산금액

    # 건수
    order_count: Mapped[int] = mapped_column(Integer, default=0)  # 주문건수
    cancel_count: Mapped[int] = mapped_column(Integer, default=0)  # 취소건수

    # 상태
    status: Mapped[SalesRecordStatus] = mapped_column(
        SQLEnum(SalesRecordStatus, native_enum=False),
        default=SalesRecordStatus.PENDING
    )

    # 원본 데이터
    raw_data: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)

    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    # 타임스탬프
    synced_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    confirmed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    converted_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    # 전표 연결
    voucher_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("vouchers.id"), nullable=True
    )

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )

    # Relationships
    channel: Mapped["SalesChannel"] = relationship(
        "SalesChannel", back_populates="sales_records"
    )

    def __repr__(self):
        return f"<SalesRecord {self.channel_id} {self.period_year}-{self.period_month:02d}>"


class SalesAutomationSchedule(Base):
    """자동화 스케줄 설정"""
    __tablename__ = "sales_automation_schedules"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    name: Mapped[str] = mapped_column(String(200))  # 작업명

    schedule_type: Mapped[ScheduleType] = mapped_column(
        SQLEnum(ScheduleType, native_enum=False)
    )
    schedule_day: Mapped[Optional[int]] = mapped_column(
        Integer, nullable=True
    )  # 매월 N일
    schedule_time: Mapped[Optional[str]] = mapped_column(
        String(5), nullable=True
    )  # HH:MM

    # 대상 채널
    target_channels: Mapped[Optional[list]] = mapped_column(
        JSON, nullable=True
    )  # 대상 채널 ID 목록

    # 이메일 발송 설정
    email_recipients: Mapped[Optional[list]] = mapped_column(
        JSON, nullable=True
    )  # 수신자 이메일 목록
    email_subject_template: Mapped[Optional[str]] = mapped_column(
        String(500), nullable=True
    )
    include_excel: Mapped[bool] = mapped_column(Boolean, default=True)  # 엑셀 첨부 여부

    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

    last_run_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    next_run_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )

    def __repr__(self):
        return f"<SalesAutomationSchedule {self.name}>"
