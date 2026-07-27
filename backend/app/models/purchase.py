"""
구매·지출 통제 모듈 모델

흐름: 링크 → 카탈로그(상품 인식·가격추이) → 구매요청 → 승인 → 결제(담당자 수동)
      → 그랜터 카드전표 대사(금액+시각 매칭) → 품목 붙은 지출로 전환
무인 자동구매는 하지 않음 (플랫폼 정책상 불가) — 통제·대사만 시스템이 담당.
"""
import enum
from datetime import datetime
from typing import Optional

from sqlalchemy import Integer, String, Float, DateTime, Text, Boolean, ForeignKey
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base


class PurchaseRequestStatus(str, enum.Enum):
    PENDING = "PENDING"        # 승인 대기
    APPROVED = "APPROVED"      # 승인됨 (결제 대기)
    REJECTED = "REJECTED"      # 반려
    PURCHASED = "PURCHASED"    # 결제 완료 (주문번호·최종금액 등록)
    MATCHED = "MATCHED"        # 카드전표 대사 완료
    CANCELED = "CANCELED"      # 요청자 취소


class CatalogItem(Base):
    """상품 카탈로그 — 링크 붙여넣기로 인식된 상품"""
    __tablename__ = "purchase_catalog_items"
    __table_args__ = {"extend_existing": True}

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    url: Mapped[str] = mapped_column(Text)
    platform: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)  # 네이버/쿠팡/기타
    title: Mapped[str] = mapped_column(String(500))
    price: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    seller: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    image_url: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    tags: Mapped[Optional[str]] = mapped_column(String(300), nullable=True)  # 쉼표 구분 태그
    folder: Mapped[Optional[str]] = mapped_column(String(100), nullable=True, index=True)  # 폴더 분류(부서 등)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_by: Mapped[str] = mapped_column(String(255), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow,
    )

    price_history: Mapped[list["CatalogPriceHistory"]] = relationship(
        back_populates="item", cascade="all, delete-orphan", lazy="noload",
    )


class CatalogPriceHistory(Base):
    """카탈로그 상품 가격 추이"""
    __tablename__ = "purchase_catalog_price_history"
    __table_args__ = {"extend_existing": True}

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    item_id: Mapped[int] = mapped_column(
        ForeignKey("purchase_catalog_items.id", ondelete="CASCADE"), index=True,
    )
    price: Mapped[float] = mapped_column(Float)
    checked_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    item: Mapped["CatalogItem"] = relationship(back_populates="price_history")


class PurchaseRequest(Base):
    """구매 요청 (품의) — 승인 후 담당자가 결제, 카드전표와 대사"""
    __tablename__ = "purchase_requests"
    __table_args__ = {"extend_existing": True}

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    requester_email: Mapped[str] = mapped_column(String(255), index=True)
    title: Mapped[str] = mapped_column(String(300))
    reason: Mapped[Optional[str]] = mapped_column(Text, nullable=True)  # 구매 사유
    status: Mapped[str] = mapped_column(
        String(20), default=PurchaseRequestStatus.PENDING.value, index=True,
    )
    total_amount: Mapped[float] = mapped_column(Float, default=0.0)

    # 승인/반려
    approved_by: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    approved_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    reject_reason: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)

    # 구매 진행 채널 + 계정 ID (예: 쿠팡 / company@id) — 재사용 위해 저장
    channel: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)
    channel_account_id: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)

    # 결제 완료 정보 (담당자 입력)
    purchased_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    order_no: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    final_amount: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    card_key: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)

    # 카드전표 대사
    matched_ticket_id: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    matched_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow,
    )

    items: Mapped[list["PurchaseRequestItem"]] = relationship(
        back_populates="request", cascade="all, delete-orphan", lazy="selectin",
    )


class PurchaseRequestItem(Base):
    """구매 요청 품목"""
    __tablename__ = "purchase_request_items"
    __table_args__ = {"extend_existing": True}

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    request_id: Mapped[int] = mapped_column(
        ForeignKey("purchase_requests.id", ondelete="CASCADE"), index=True,
    )
    catalog_item_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("purchase_catalog_items.id", ondelete="SET NULL"), nullable=True,
    )
    title: Mapped[str] = mapped_column(String(500))
    unit_price: Mapped[float] = mapped_column(Float, default=0.0)
    quantity: Mapped[int] = mapped_column(Integer, default=1)
    line_total: Mapped[float] = mapped_column(Float, default=0.0)

    request: Mapped["PurchaseRequest"] = relationship(back_populates="items")
