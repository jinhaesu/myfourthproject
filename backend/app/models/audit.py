"""
Smart Finance Core - Audit Models
감사 추적 및 데이터 아카이빙 모델
"""
from datetime import datetime, date
from typing import Optional
from sqlalchemy import (
    Column, Integer, String, Boolean, DateTime, ForeignKey,
    Text, Index
)
from sqlalchemy.orm import relationship, Mapped, mapped_column

from app.core.database import Base


class AuditLog(Base):
    """감사 로그 (Audit Trail)"""
    __tablename__ = "audit_logs"
    __table_args__ = (
        Index("ix_audit_logs_user_date", "user_id", "created_at"),
        Index("ix_audit_logs_resource", "resource_type", "resource_id"),
        Index("ix_audit_logs_action", "action"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)

    # Actor
    user_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id"))
    username: Mapped[str] = mapped_column(String(100))  # 삭제된 사용자도 추적 가능하도록

    # Action
    action: Mapped[str] = mapped_column(
        String(50)
    )  # CREATE, READ, UPDATE, DELETE, LOGIN, LOGOUT, APPROVE, REJECT, etc.
    action_category: Mapped[str] = mapped_column(
        String(50)
    )  # auth, voucher, approval, treasury, ai, system

    # Resource
    resource_type: Mapped[str] = mapped_column(
        String(100)
    )  # user, voucher, approval_request, etc.
    resource_id: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)
    resource_name: Mapped[Optional[str]] = mapped_column(
        String(200), nullable=True
    )  # 사람이 읽을 수 있는 이름

    # Change details
    old_value: Mapped[Optional[str]] = mapped_column(Text, nullable=True)  # JSON
    new_value: Mapped[Optional[str]] = mapped_column(Text, nullable=True)  # JSON
    changed_fields: Mapped[Optional[str]] = mapped_column(
        Text, nullable=True
    )  # JSON array of field names

    # Context
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    # Request metadata
    ip_address: Mapped[Optional[str]] = mapped_column(String(45), nullable=True)
    user_agent: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    request_id: Mapped[Optional[str]] = mapped_column(
        String(50), nullable=True
    )  # 요청 추적용
    session_id: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)

    # Status
    status: Mapped[str] = mapped_column(String(20), default="success")  # success, failed
    error_message: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    # Timestamp
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, index=True
    )

    # Relationships
    user: Mapped["User"] = relationship("User")

    def __repr__(self):
        return f"<AuditLog {self.action} {self.resource_type}:{self.resource_id}>"


class DataSnapshot(Base):
    """데이터 스냅샷 (일별/월별 백업)"""
    __tablename__ = "data_snapshots"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)

    # Snapshot info
    snapshot_type: Mapped[str] = mapped_column(
        String(20)
    )  # daily, monthly, yearly, manual
    snapshot_date: Mapped[date] = mapped_column(DateTime, index=True)

    # Scope
    data_type: Mapped[str] = mapped_column(
        String(50)
    )  # vouchers, approvals, treasury, full
    period_start: Mapped[datetime] = mapped_column(DateTime)
    period_end: Mapped[datetime] = mapped_column(DateTime)

    # Storage
    storage_type: Mapped[str] = mapped_column(String(20))  # local, s3
    file_path: Mapped[str] = mapped_column(String(500))
    file_size_bytes: Mapped[int] = mapped_column(Integer)
    file_checksum: Mapped[str] = mapped_column(String(64))  # SHA-256

    # Encryption
    is_encrypted: Mapped[bool] = mapped_column(Boolean, default=True)
    encryption_key_id: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)

    # Stats
    record_count: Mapped[int] = mapped_column(Integer, default=0)

    # Status
    status: Mapped[str] = mapped_column(String(20), default="completed")  # pending, completed, failed
    error_message: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    # Retention
    retention_days: Mapped[int] = mapped_column(Integer, default=365 * 10)  # 10년 보관
    expires_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    # Timestamps
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    created_by: Mapped[int] = mapped_column(Integer, ForeignKey("users.id"))

    def __repr__(self):
        return f"<DataSnapshot {self.snapshot_type} {self.snapshot_date}>"


class LoginAttempt(Base):
    """로그인 시도 기록 (보안)"""
    __tablename__ = "login_attempts"
    __table_args__ = (Index("ix_login_attempts_username_ip", "username", "ip_address"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)

    username: Mapped[str] = mapped_column(String(100), index=True)
    ip_address: Mapped[str] = mapped_column(String(45), index=True)
    user_agent: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)

    # Result
    success: Mapped[bool] = mapped_column(Boolean)
    failure_reason: Mapped[Optional[str]] = mapped_column(
        String(100), nullable=True
    )  # invalid_password, user_not_found, locked, 2fa_failed

    # 2FA
    two_factor_required: Mapped[bool] = mapped_column(Boolean, default=False)
    two_factor_passed: Mapped[Optional[bool]] = mapped_column(Boolean, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    def __repr__(self):
        return f"<LoginAttempt {self.username} {'success' if self.success else 'failed'}>"
