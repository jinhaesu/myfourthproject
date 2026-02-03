"""
Smart Finance Core - User Models
사용자, 역할, 부서 관리
"""
from datetime import datetime
from typing import Optional, List
from sqlalchemy import (
    Column, Integer, String, Boolean, DateTime, ForeignKey,
    Text, Enum as SQLEnum, UniqueConstraint
)
from sqlalchemy.orm import relationship, Mapped, mapped_column
import enum

from app.core.database import Base


class RoleType(enum.Enum):
    """사용자 역할 유형"""
    ADMIN = "admin"  # 시스템 관리자
    CFO = "cfo"  # 재무 책임자
    FINANCE_MANAGER = "finance_manager"  # 재무팀장
    FINANCE_STAFF = "finance_staff"  # 재무팀원
    DEPARTMENT_HEAD = "department_head"  # 부서장
    TEAM_LEADER = "team_leader"  # 팀장
    EMPLOYEE = "employee"  # 일반 직원


class User(Base):
    """사용자 모델"""
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    employee_id: Mapped[str] = mapped_column(String(50), unique=True, index=True)  # 사번
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    username: Mapped[str] = mapped_column(String(100), unique=True, index=True)
    hashed_password: Mapped[str] = mapped_column(String(255))

    # Personal info
    full_name: Mapped[str] = mapped_column(String(100))
    phone: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)

    # Organization
    department_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("departments.id"), nullable=True
    )
    role_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("roles.id"), nullable=True
    )
    position: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)  # 직위

    # Security
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    is_superuser: Mapped[bool] = mapped_column(Boolean, default=False)
    two_factor_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    two_factor_secret: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    failed_login_attempts: Mapped[int] = mapped_column(Integer, default=0)
    locked_until: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    # Timestamps
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )
    last_login: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    password_changed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    # Relationships
    department: Mapped[Optional["Department"]] = relationship(
        "Department", back_populates="users"
    )
    role: Mapped[Optional["Role"]] = relationship("Role", back_populates="users")
    sessions: Mapped[List["UserSession"]] = relationship(
        "UserSession", back_populates="user", cascade="all, delete-orphan"
    )

    # Approval relationships
    created_approvals: Mapped[List["ApprovalRequest"]] = relationship(
        "ApprovalRequest", back_populates="requester", foreign_keys="ApprovalRequest.requester_id"
    )

    def __repr__(self):
        return f"<User {self.username} ({self.employee_id})>"


class Role(Base):
    """역할/권한 모델"""
    __tablename__ = "roles"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    name: Mapped[str] = mapped_column(String(100), unique=True)
    role_type: Mapped[RoleType] = mapped_column(SQLEnum(RoleType))
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    # Permissions (JSON-like flags)
    can_create_voucher: Mapped[bool] = mapped_column(Boolean, default=True)
    can_approve_voucher: Mapped[bool] = mapped_column(Boolean, default=False)
    can_finalize_voucher: Mapped[bool] = mapped_column(Boolean, default=False)
    can_manage_budget: Mapped[bool] = mapped_column(Boolean, default=False)
    can_view_all_departments: Mapped[bool] = mapped_column(Boolean, default=False)
    can_manage_users: Mapped[bool] = mapped_column(Boolean, default=False)
    can_configure_ai: Mapped[bool] = mapped_column(Boolean, default=False)
    can_export_data: Mapped[bool] = mapped_column(Boolean, default=True)
    can_view_reports: Mapped[bool] = mapped_column(Boolean, default=True)
    can_manage_accounts: Mapped[bool] = mapped_column(Boolean, default=False)

    # Budget approval limits
    approval_limit: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)  # 결재 한도

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )

    # Relationships
    users: Mapped[List["User"]] = relationship("User", back_populates="role")

    def __repr__(self):
        return f"<Role {self.name}>"


class Department(Base):
    """부서 모델"""
    __tablename__ = "departments"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    code: Mapped[str] = mapped_column(String(20), unique=True, index=True)  # 부서 코드
    name: Mapped[str] = mapped_column(String(100))
    parent_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("departments.id"), nullable=True
    )

    # Cost center info
    cost_center_code: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)

    # Hierarchy level
    level: Mapped[int] = mapped_column(Integer, default=1)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)

    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )

    # Relationships
    users: Mapped[List["User"]] = relationship("User", back_populates="department")
    parent: Mapped[Optional["Department"]] = relationship(
        "Department", remote_side=[id], back_populates="children"
    )
    children: Mapped[List["Department"]] = relationship(
        "Department", back_populates="parent"
    )
    budgets: Mapped[List["Budget"]] = relationship("Budget", back_populates="department")

    def __repr__(self):
        return f"<Department {self.code}: {self.name}>"


class UserSession(Base):
    """사용자 세션 관리 (보안)"""
    __tablename__ = "user_sessions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    user_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id"))

    session_token: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    refresh_token: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)

    ip_address: Mapped[Optional[str]] = mapped_column(String(45), nullable=True)
    user_agent: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    device_info: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime)
    last_activity: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

    # Relationships
    user: Mapped["User"] = relationship("User", back_populates="sessions")

    def __repr__(self):
        return f"<UserSession {self.id} for User {self.user_id}>"
