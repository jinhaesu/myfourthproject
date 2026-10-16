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


class TransferBatch(Base):
    """이체 보고서(배치) — 회계팀 작성 → 대표 제출 → 대표 결재.

    워크플로우: draft(회계팀 작성중) → submitted(대표 제출) → reviewed(대표 결재완료).
    """
    __tablename__ = "transfer_batch"
    __table_args__ = ({"extend_existing": True},)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    year: Mapped[int] = mapped_column(Integer, index=True)
    month: Mapped[int] = mapped_column(Integer, index=True)
    xun: Mapped[int] = mapped_column(Integer)                                     # 10 | 20 | 30
    title: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    status: Mapped[str] = mapped_column(String(12), default="draft", index=True)  # draft|submitted|reviewed
    created_by: Mapped[Optional[str]] = mapped_column(String(120), nullable=True)
    submitted_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    reviewed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    note: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class TransferBatchItem(Base):
    """이체 보고서 항목 — 회계팀이 분류(이체할곳/미룸/예정)·우선순위·부서요청을 작성,
    대표가 항목별 승인/질의/반려."""
    __tablename__ = "transfer_batch_item"
    __table_args__ = (
        Index("ix_transfer_batch_item_batch", "batch_id"),
        {"extend_existing": True},
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    batch_id: Mapped[int] = mapped_column(Integer, index=True)
    payable_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)     # PayableItem 참조(풀 출처)

    vendor: Mapped[str] = mapped_column(String(200))
    amount: Mapped[float] = mapped_column(Numeric(20, 2), default=0)
    account_name: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    bank_name: Mapped[Optional[str]] = mapped_column(String(60), nullable=True)
    due_date: Mapped[Optional[str]] = mapped_column(String(10), nullable=True)

    # 회계팀 작성
    disposition: Mapped[str] = mapped_column(String(10), default="pay")           # pay|defer|scheduled
    priority: Mapped[int] = mapped_column(Integer, default=2)                     # 1높음 2보통 3낮음
    dept_request: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    memo: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    # 대표 결재
    ceo_action: Mapped[str] = mapped_column(String(10), default="pending")        # pending|approved|rejected|query
    ceo_comment: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    ceo_acted_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
