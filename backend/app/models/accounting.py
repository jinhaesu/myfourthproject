"""
Smart Finance Core - Accounting Models
전표, 계정과목, 거래 관련 모델
"""
from datetime import datetime, date
from decimal import Decimal
from typing import Optional, List
from sqlalchemy import (
    Column, Integer, String, Boolean, DateTime, ForeignKey,
    Text, Numeric, Date, Enum as SQLEnum, Index
)
from sqlalchemy.orm import relationship, Mapped, mapped_column
import enum

from app.core.database import Base


class TransactionType(enum.Enum):
    """거래 유형"""
    CARD = "card"  # 법인카드
    BANK_TRANSFER = "bank_transfer"  # 계좌이체
    CASH = "cash"  # 현금
    TAX_INVOICE = "tax_invoice"  # 세금계산서
    EXPENSE_REPORT = "expense_report"  # 지출결의
    GENERAL = "general"  # 일반 (엑셀 업로드 등)


class VoucherStatus(enum.Enum):
    """전표 상태"""
    DRAFT = "draft"  # 임시저장
    PENDING_APPROVAL = "pending_approval"  # 결재 대기
    IN_APPROVAL = "in_approval"  # 결재 진행 중
    APPROVED = "approved"  # 결재 완료
    REJECTED = "rejected"  # 반려
    CONFIRMED = "confirmed"  # 확정 (회계처리 완료)
    CANCELLED = "cancelled"  # 취소


class AIClassificationStatus(enum.Enum):
    """AI 분류 상태"""
    AUTO_CONFIRMED = "auto_confirmed"  # 자동 확정 (높은 신뢰도)
    NEEDS_REVIEW = "needs_review"  # 검토 필요
    USER_CONFIRMED = "user_confirmed"  # 사용자 확인 완료
    USER_CORRECTED = "user_corrected"  # 사용자가 수정함


class AccountCategory(Base):
    """계정과목 대분류"""
    __tablename__ = "account_categories"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    code: Mapped[str] = mapped_column(String(10), unique=True)  # 1, 2, 3, 4, 5
    name: Mapped[str] = mapped_column(String(50))  # 자산, 부채, 자본, 수익, 비용
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    # Relationships
    accounts: Mapped[List["Account"]] = relationship(
        "Account", back_populates="category"
    )

    def __repr__(self):
        return f"<AccountCategory {self.code}: {self.name}>"


class Account(Base):
    """계정과목"""
    __tablename__ = "accounts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    code: Mapped[str] = mapped_column(String(20), unique=True, index=True)  # 예: 813100
    name: Mapped[str] = mapped_column(String(100))  # 예: 복리후생비

    category_id: Mapped[int] = mapped_column(Integer, ForeignKey("account_categories.id"))
    parent_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("accounts.id"), nullable=True
    )

    # Classification
    level: Mapped[int] = mapped_column(Integer, default=1)  # 계정 레벨 (대/중/소)
    is_detail: Mapped[bool] = mapped_column(Boolean, default=True)  # 세부 계정 여부

    # AI Learning hints
    keywords: Mapped[Optional[str]] = mapped_column(Text, nullable=True)  # AI 학습용 키워드
    common_merchants: Mapped[Optional[str]] = mapped_column(Text, nullable=True)  # 자주 사용되는 가맹점

    # Tax related
    is_vat_applicable: Mapped[bool] = mapped_column(Boolean, default=True)
    vat_rate: Mapped[Decimal] = mapped_column(Numeric(5, 2), default=Decimal("10.00"))

    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )

    # Relationships
    category: Mapped["AccountCategory"] = relationship(
        "AccountCategory", back_populates="accounts"
    )
    parent: Mapped[Optional["Account"]] = relationship(
        "Account", remote_side=[id], back_populates="children"
    )
    children: Mapped[List["Account"]] = relationship("Account", back_populates="parent")
    voucher_lines: Mapped[List["VoucherLine"]] = relationship(
        "VoucherLine", back_populates="account"
    )

    def __repr__(self):
        return f"<Account {self.code}: {self.name}>"


class Voucher(Base):
    """전표 (회계 거래 문서)"""
    __tablename__ = "vouchers"
    __table_args__ = (
        Index("ix_vouchers_date_status", "voucher_date", "status"),
        Index("ix_vouchers_department_date", "department_id", "voucher_date"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    voucher_number: Mapped[str] = mapped_column(
        String(50), unique=True, index=True
    )  # 전표번호 (자동생성)

    # Basic info
    voucher_date: Mapped[date] = mapped_column(Date, index=True)  # 전표일자
    transaction_date: Mapped[date] = mapped_column(Date)  # 거래일자
    description: Mapped[str] = mapped_column(String(500))  # 적요

    # Transaction source
    transaction_type: Mapped[TransactionType] = mapped_column(SQLEnum(TransactionType, native_enum=False))
    external_ref: Mapped[Optional[str]] = mapped_column(
        String(100), nullable=True
    )  # 외부 참조번호 (카드승인번호 등)

    # Organization
    department_id: Mapped[int] = mapped_column(Integer, ForeignKey("departments.id"))
    created_by: Mapped[int] = mapped_column(Integer, ForeignKey("users.id"))

    # Amounts
    total_debit: Mapped[Decimal] = mapped_column(Numeric(18, 2), default=Decimal("0"))
    total_credit: Mapped[Decimal] = mapped_column(Numeric(18, 2), default=Decimal("0"))

    # Status
    status: Mapped[VoucherStatus] = mapped_column(
        SQLEnum(VoucherStatus, native_enum=False), default=VoucherStatus.DRAFT
    )

    # AI Classification
    ai_classification_status: Mapped[Optional[AIClassificationStatus]] = mapped_column(
        SQLEnum(AIClassificationStatus, native_enum=False), nullable=True
    )
    ai_confidence_score: Mapped[Optional[Decimal]] = mapped_column(
        Numeric(5, 4), nullable=True
    )  # 0.0000 ~ 1.0000
    ai_suggested_account_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("accounts.id"), nullable=True
    )

    # Custom tags (프로젝트, TF 등)
    custom_tags: Mapped[Optional[str]] = mapped_column(Text, nullable=True)  # JSON array

    # Merchant info (for card transactions)
    merchant_name: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    merchant_category: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)

    # Timestamps
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )
    confirmed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    confirmed_by: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("users.id"), nullable=True
    )

    # Relationships
    department: Mapped[Optional["Department"]] = relationship("Department")
    lines: Mapped[List["VoucherLine"]] = relationship(
        "VoucherLine", back_populates="voucher", cascade="all, delete-orphan"
    )
    attachments: Mapped[List["VoucherAttachment"]] = relationship(
        "VoucherAttachment", back_populates="voucher", cascade="all, delete-orphan"
    )
    approval_request: Mapped[Optional["ApprovalRequest"]] = relationship(
        "ApprovalRequest", back_populates="voucher", uselist=False
    )

    def __repr__(self):
        return f"<Voucher {self.voucher_number}>"


class VoucherLine(Base):
    """전표 행 (차변/대변)"""
    __tablename__ = "voucher_lines"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    voucher_id: Mapped[int] = mapped_column(Integer, ForeignKey("vouchers.id"))
    line_number: Mapped[int] = mapped_column(Integer)

    # Account
    account_id: Mapped[int] = mapped_column(Integer, ForeignKey("accounts.id"))

    # Amounts
    debit_amount: Mapped[Decimal] = mapped_column(Numeric(18, 2), default=Decimal("0"))
    credit_amount: Mapped[Decimal] = mapped_column(Numeric(18, 2), default=Decimal("0"))

    # VAT
    vat_amount: Mapped[Decimal] = mapped_column(Numeric(18, 2), default=Decimal("0"))
    supply_amount: Mapped[Decimal] = mapped_column(Numeric(18, 2), default=Decimal("0"))

    # Description
    description: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)

    # Counterparty
    counterparty_name: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    counterparty_business_number: Mapped[Optional[str]] = mapped_column(
        String(20), nullable=True
    )  # 사업자번호

    # Cost center / Project
    cost_center_code: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)
    project_code: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    # Relationships
    voucher: Mapped["Voucher"] = relationship("Voucher", back_populates="lines")
    account: Mapped["Account"] = relationship("Account", back_populates="voucher_lines")

    def __repr__(self):
        return f"<VoucherLine {self.voucher_id}:{self.line_number}>"


class VoucherAttachment(Base):
    """전표 첨부파일"""
    __tablename__ = "voucher_attachments"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    voucher_id: Mapped[int] = mapped_column(Integer, ForeignKey("vouchers.id"))

    file_name: Mapped[str] = mapped_column(String(255))
    file_path: Mapped[str] = mapped_column(String(500))
    file_type: Mapped[str] = mapped_column(String(50))  # pdf, jpg, png, xlsx
    file_size: Mapped[int] = mapped_column(Integer)  # bytes

    # OCR result (for receipts)
    ocr_text: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    ocr_processed: Mapped[bool] = mapped_column(Boolean, default=False)

    # Duplicate check
    file_hash: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)  # SHA-256

    uploaded_by: Mapped[int] = mapped_column(Integer, ForeignKey("users.id"))
    uploaded_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    # Relationships
    voucher: Mapped["Voucher"] = relationship("Voucher", back_populates="attachments")

    def __repr__(self):
        return f"<VoucherAttachment {self.file_name}>"
