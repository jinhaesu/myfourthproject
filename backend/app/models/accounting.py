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


class AccountCodeMapping(Base):
    """ERP 계정코드 매핑 (더존 등 외부 시스템 코드 → 시스템 계정코드)"""
    __tablename__ = "account_code_mappings"
    __table_args__ = (
        Index(
            "ix_account_code_mappings_source",
            "source_system", "source_code",
            unique=True,
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    source_system: Mapped[str] = mapped_column(
        String(50), nullable=False
    )  # e.g. "douzone"
    source_code: Mapped[str] = mapped_column(
        String(20), nullable=False
    )  # ERP 코드 (예: 098000)
    source_name: Mapped[Optional[str]] = mapped_column(
        String(100), nullable=True
    )  # 원래 계정명 (있을 경우)

    target_account_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("accounts.id"), nullable=True
    )
    target_account_code: Mapped[Optional[str]] = mapped_column(
        String(20), nullable=True
    )

    is_auto_created: Mapped[bool] = mapped_column(
        Boolean, default=False
    )  # 자동 생성 여부

    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow
    )

    # Relationships
    target_account: Mapped[Optional["Account"]] = relationship(
        "Account", foreign_keys=[target_account_id]
    )

    def __repr__(self):
        return f"<AccountCodeMapping {self.source_system}:{self.source_code} -> {self.target_account_code}>"


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


class AutoVoucherSourceType(enum.Enum):
    """자동 전표 후보의 원본 거래 유형"""
    SALES_TAX_INVOICE = "sales_tax_invoice"      # 매출 세금계산서
    PURCHASE_TAX_INVOICE = "purchase_tax_invoice"  # 매입 세금계산서
    SALES_INVOICE = "sales_invoice"               # 매출 전자계산서(영세율/면세)
    PURCHASE_INVOICE = "purchase_invoice"         # 매입 전자계산서
    CARD = "card"                                 # 신용카드 매입
    BANK = "bank"                                 # 통장 거래
    CASH_RECEIPT = "cash_receipt"                 # 현금영수증


class AutoVoucherStatus(enum.Enum):
    PENDING = "pending"
    CONFIRMED = "confirmed"
    REJECTED = "rejected"
    DUPLICATE = "duplicate"  # 카드↔통장 중복 매칭으로 제외


class AutoVoucherCandidate(Base):
    """
    자동 생성된 분개 후보 — 그랜터 수집 거래 + AI 분류 결과를 묶어
    회계담당자 검수 큐에 올리고, 확정 시 Voucher로 전환.
    """
    __tablename__ = "auto_voucher_candidates"
    __table_args__ = (
        Index("ix_avc_status_date", "status", "transaction_date"),
        Index("ix_avc_source", "source_type", "source_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)

    source_type: Mapped[AutoVoucherSourceType] = mapped_column(
        SQLEnum(AutoVoucherSourceType, name="auto_voucher_source_type")
    )
    source_id: Mapped[Optional[str]] = mapped_column(
        String(100), nullable=True,
        comment="원본 거래 식별자 (그랜터 ticket id, ai_raw row_id 등)"
    )

    status: Mapped[AutoVoucherStatus] = mapped_column(
        SQLEnum(AutoVoucherStatus, name="auto_voucher_status"),
        default=AutoVoucherStatus.PENDING,
    )

    # 거래 기본
    transaction_date: Mapped[date] = mapped_column(Date)
    counterparty: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    description: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    supply_amount: Mapped[Decimal] = mapped_column(Numeric(18, 2), default=Decimal("0"))
    vat_amount: Mapped[Decimal] = mapped_column(Numeric(18, 2), default=Decimal("0"))
    total_amount: Mapped[Decimal] = mapped_column(Numeric(18, 2), default=Decimal("0"))

    # AI 분류 결과
    confidence: Mapped[float] = mapped_column(Numeric(5, 4), default=0.0,
                                              comment="0~1, 1에 가까울수록 정확도 ↑")
    suggested_account_code: Mapped[Optional[str]] = mapped_column(String(20), nullable=True,
                                                                  comment="AI가 제안한 비용·자산·수익 계정 (반대편은 거래유형으로 결정)")
    suggested_account_name: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)

    # 분개 라인 (확정 시 VoucherLine으로 변환)
    # JSON 포맷: [{"side": "debit"|"credit", "account_code": "...", "account_name": "...",
    #             "amount": "...", "memo": "..."}]
    debit_lines: Mapped[Optional[dict]] = mapped_column(
        Text, nullable=True, comment="JSON 배열, 차변 라인들"
    )
    credit_lines: Mapped[Optional[dict]] = mapped_column(
        Text, nullable=True, comment="JSON 배열, 대변 라인들"
    )

    # 중복 매칭 (카드↔통장)
    duplicate_of_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("auto_voucher_candidates.id"), nullable=True,
        comment="이 후보가 다른 후보의 중복일 때 그 후보 id (카드 사용→통장 결제 매칭)"
    )

    # 확정 시 생성된 Voucher 연결
    confirmed_voucher_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("vouchers.id"), nullable=True
    )

    # 메타
    raw_data: Mapped[Optional[dict]] = mapped_column(
        Text, nullable=True, comment="원본 거래 JSON 스냅샷 (트레이스용)"
    )
    rejected_reason: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    confirmed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    confirmed_by: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("users.id"), nullable=True
    )

    def __repr__(self):
        return f"<AutoVoucherCandidate {self.id} {self.source_type.value} {self.status.value}>"


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
