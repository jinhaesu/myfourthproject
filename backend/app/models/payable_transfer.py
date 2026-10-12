"""
이체 승인(매입채무 → 旬별 이체리스트 → 대표 승인 → 지급완료) 모델.

소스: SCM(myfirstproject /api/purchase) 당겨오기 + 엑셀 임포트(중복제거).
旬: 10일(1~10)/20일(11~20)/30일(21~말). create_all 로 자동 생성.
"""
from datetime import datetime
from typing import Optional

from sqlalchemy import Integer, String, DateTime, Numeric, Text, Index, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class PayableItem(Base):
    """매입채무 1건(이체 대상). SCM/엑셀 통합 + 중복제거(dedup_key)."""
    __tablename__ = "payable_item"
    __table_args__ = (
        Index("ix_payable_item_due", "due_date"),
        Index("ix_payable_item_status", "status"),
        {"extend_existing": True},
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    source: Mapped[str] = mapped_column(String(10), default="scm")          # scm | excel
    dedup_key: Mapped[str] = mapped_column(String(300), unique=True, index=True)
    scm_record_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)

    vendor: Mapped[str] = mapped_column(String(200), index=True)
    debt_date: Mapped[Optional[str]] = mapped_column(String(10), nullable=True)   # 채무기준일 YYYY-MM-DD
    debt_month: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    account_code: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)
    account_name: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    bank_name: Mapped[Optional[str]] = mapped_column(String(60), nullable=True)   # 계좌은행(엑셀 보완)

    amount: Mapped[float] = mapped_column(Numeric(20, 2), default=0)              # 채무금액
    paid_amount: Mapped[float] = mapped_column(Numeric(20, 2), default=0)         # 지급완료액
    due_date: Mapped[Optional[str]] = mapped_column(String(10), nullable=True)    # 이체예정일 YYYY-MM-DD
    xun: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)            # 10 | 20 | 30
    manager: Mapped[Optional[str]] = mapped_column(String(60), nullable=True)

    status: Mapped[str] = mapped_column(String(12), default="pending")           # pending | approved | paid
    memo: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    synced_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class TransferApproval(Base):
    """旬별 이체 승인 스냅샷(대표 승인)."""
    __tablename__ = "transfer_approval"
    __table_args__ = (
        UniqueConstraint("year", "month", "xun", name="uq_transfer_approval_ymx"),
        {"extend_existing": True},
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    year: Mapped[int] = mapped_column(Integer, index=True)
    month: Mapped[int] = mapped_column(Integer)
    xun: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(12), default="approved")
    approved_by: Mapped[Optional[str]] = mapped_column(String(120), nullable=True)
    approved_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    note: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
