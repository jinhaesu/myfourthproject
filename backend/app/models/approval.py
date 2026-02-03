"""
Smart Finance Core - Approval Workflow Models
결재 프로세스 관련 모델
"""
from datetime import datetime
from typing import Optional, List
from sqlalchemy import (
    Column, Integer, String, Boolean, DateTime, ForeignKey,
    Text, Enum as SQLEnum, Index
)
from sqlalchemy.orm import relationship, Mapped, mapped_column
import enum

from app.core.database import Base


class ApprovalStatus(enum.Enum):
    """결재 상태"""
    PENDING = "pending"  # 결재 대기
    IN_PROGRESS = "in_progress"  # 결재 진행 중
    APPROVED = "approved"  # 승인 완료
    REJECTED = "rejected"  # 반려
    CANCELLED = "cancelled"  # 취소
    RETURNED = "returned"  # 재상신 요청


class ApprovalActionType(enum.Enum):
    """결재 액션 유형"""
    APPROVE = "approve"  # 승인
    REJECT = "reject"  # 반려
    RETURN = "return"  # 재상신 요청
    DELEGATE = "delegate"  # 위임
    SKIP = "skip"  # 생략 (부재 시)


class ApprovalRequest(Base):
    """결재 요청 (기안서)"""
    __tablename__ = "approval_requests"
    __table_args__ = (
        Index("ix_approval_requests_status", "status"),
        Index("ix_approval_requests_requester", "requester_id", "status"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    request_number: Mapped[str] = mapped_column(
        String(50), unique=True, index=True
    )  # 기안번호

    # Reference
    voucher_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("vouchers.id"), unique=True
    )

    # Request info
    title: Mapped[str] = mapped_column(String(200))
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    # Requester
    requester_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id"))
    department_id: Mapped[int] = mapped_column(Integer, ForeignKey("departments.id"))

    # Status
    status: Mapped[ApprovalStatus] = mapped_column(
        SQLEnum(ApprovalStatus), default=ApprovalStatus.PENDING
    )
    current_step: Mapped[int] = mapped_column(Integer, default=1)  # 현재 결재 단계
    total_steps: Mapped[int] = mapped_column(Integer, default=1)  # 총 결재 단계

    # Priority
    is_urgent: Mapped[bool] = mapped_column(Boolean, default=False)

    # Budget check
    budget_checked: Mapped[bool] = mapped_column(Boolean, default=False)
    budget_available: Mapped[bool] = mapped_column(Boolean, default=True)
    budget_message: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)

    # Timestamps
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )
    submitted_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    completed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    # Relationships
    voucher: Mapped["Voucher"] = relationship("Voucher", back_populates="approval_request")
    requester: Mapped["User"] = relationship(
        "User", back_populates="created_approvals", foreign_keys=[requester_id]
    )
    steps: Mapped[List["ApprovalStep"]] = relationship(
        "ApprovalStep", back_populates="approval_request",
        cascade="all, delete-orphan", order_by="ApprovalStep.step_order"
    )
    history: Mapped[List["ApprovalHistory"]] = relationship(
        "ApprovalHistory", back_populates="approval_request",
        cascade="all, delete-orphan"
    )

    def __repr__(self):
        return f"<ApprovalRequest {self.request_number}>"


class ApprovalStep(Base):
    """결재 단계"""
    __tablename__ = "approval_steps"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    approval_request_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("approval_requests.id")
    )

    step_order: Mapped[int] = mapped_column(Integer)  # 결재 순서
    step_name: Mapped[str] = mapped_column(String(100))  # 단계명 (팀장, 부문장, 재무팀 등)

    # Approver
    approver_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id"))
    delegate_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("users.id"), nullable=True
    )  # 대리 결재자

    # Status
    status: Mapped[ApprovalStatus] = mapped_column(
        SQLEnum(ApprovalStatus), default=ApprovalStatus.PENDING
    )

    # Action
    action_type: Mapped[Optional[ApprovalActionType]] = mapped_column(
        SQLEnum(ApprovalActionType), nullable=True
    )
    action_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    comment: Mapped[Optional[str]] = mapped_column(Text, nullable=True)  # 결재 의견

    # Timestamps
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    notified_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    # Relationships
    approval_request: Mapped["ApprovalRequest"] = relationship(
        "ApprovalRequest", back_populates="steps"
    )
    approver: Mapped["User"] = relationship("User", foreign_keys=[approver_id])
    delegate: Mapped[Optional["User"]] = relationship("User", foreign_keys=[delegate_id])

    def __repr__(self):
        return f"<ApprovalStep {self.approval_request_id}:{self.step_order}>"


class ApprovalLine(Base):
    """결재선 템플릿"""
    __tablename__ = "approval_lines"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    name: Mapped[str] = mapped_column(String(100))  # 결재선 이름
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    # Scope
    department_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("departments.id"), nullable=True
    )  # 특정 부서용 (null이면 전사 공통)

    # Amount threshold
    min_amount: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    max_amount: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)

    # Line configuration (JSON)
    line_config: Mapped[str] = mapped_column(Text)  # JSON: [{step_order, role_type, ...}]

    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    is_default: Mapped[bool] = mapped_column(Boolean, default=False)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )
    created_by: Mapped[int] = mapped_column(Integer, ForeignKey("users.id"))

    def __repr__(self):
        return f"<ApprovalLine {self.name}>"


class ApprovalHistory(Base):
    """결재 이력 (감사 추적용)"""
    __tablename__ = "approval_history"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    approval_request_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("approval_requests.id")
    )

    # Actor
    user_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id"))

    # Action
    action: Mapped[str] = mapped_column(String(50))  # submit, approve, reject, cancel, etc.
    action_detail: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    # Previous/New status
    previous_status: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)
    new_status: Mapped[str] = mapped_column(String(50))

    # Context
    step_order: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    comment: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    # Metadata
    ip_address: Mapped[Optional[str]] = mapped_column(String(45), nullable=True)
    user_agent: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    # Relationships
    approval_request: Mapped["ApprovalRequest"] = relationship(
        "ApprovalRequest", back_populates="history"
    )
    user: Mapped["User"] = relationship("User")

    def __repr__(self):
        return f"<ApprovalHistory {self.approval_request_id}:{self.action}>"
