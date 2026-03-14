"""
Smart Finance Core - AI Models
AI 학습 및 분류 관련 모델
"""
from datetime import datetime
from decimal import Decimal
from typing import Optional, List
from sqlalchemy import (
    Column, Integer, String, Boolean, DateTime, ForeignKey,
    Text, Numeric, Enum as SQLEnum, Index
)
from sqlalchemy.orm import relationship, Mapped, mapped_column
import enum

from app.core.database import Base


class ClassificationResult(enum.Enum):
    """분류 결과"""
    CORRECT = "correct"  # AI 분류 정확
    CORRECTED = "corrected"  # 사용자가 수정
    UNKNOWN = "unknown"  # 아직 확인 안됨


class AIClassificationLog(Base):
    """AI 분류 로그 (학습 데이터 수집용)"""
    __tablename__ = "ai_classification_logs"
    __table_args__ = (
        Index("ix_ai_classification_logs_merchant", "merchant_name"),
        Index("ix_ai_classification_logs_result", "classification_result"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)

    # Source data
    voucher_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("vouchers.id"), nullable=True
    )

    # Input features
    description: Mapped[str] = mapped_column(String(500))  # 적요
    merchant_name: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    merchant_category: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    amount: Mapped[Decimal] = mapped_column(Numeric(18, 2))
    transaction_time: Mapped[Optional[str]] = mapped_column(
        String(8), nullable=True
    )  # HH:MM:SS
    day_of_week: Mapped[Optional[int]] = mapped_column(
        Integer, nullable=True
    )  # 0=Mon, 6=Sun

    # AI prediction
    predicted_account_id: Mapped[int] = mapped_column(Integer, ForeignKey("accounts.id"))
    confidence_score: Mapped[Decimal] = mapped_column(Numeric(5, 4))  # 0.0000 ~ 1.0000

    # Top N predictions
    top_predictions: Mapped[Optional[str]] = mapped_column(
        Text, nullable=True
    )  # JSON: [{account_id, score}, ...]

    # Actual result
    actual_account_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("accounts.id"), nullable=True
    )
    classification_result: Mapped[ClassificationResult] = mapped_column(
        SQLEnum(ClassificationResult, native_enum=False), default=ClassificationResult.UNKNOWN
    )

    # User feedback
    corrected_by: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("users.id"), nullable=True
    )
    corrected_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    correction_reason: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    # Custom tags
    custom_tags: Mapped[Optional[str]] = mapped_column(Text, nullable=True)  # JSON array

    # Model version
    model_version: Mapped[str] = mapped_column(String(50))

    # Timestamp
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    # Used for retraining
    used_for_training: Mapped[bool] = mapped_column(Boolean, default=False)
    training_batch_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)

    def __repr__(self):
        return f"<AIClassificationLog {self.id} ({self.classification_result.value})>"


class AITrainingData(Base):
    """AI 학습 데이터셋"""
    __tablename__ = "ai_training_data"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)

    # Features
    description_tokens: Mapped[str] = mapped_column(Text)  # 토큰화된 적요
    merchant_name: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    merchant_category: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    amount_range: Mapped[str] = mapped_column(String(50))  # low, medium, high, very_high
    time_category: Mapped[Optional[str]] = mapped_column(
        String(50), nullable=True
    )  # morning, lunch, afternoon, evening, night
    is_weekend: Mapped[bool] = mapped_column(Boolean, default=False)

    # Label
    account_id: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("accounts.id"), nullable=True)
    account_code: Mapped[str] = mapped_column(String(20))

    # Weight (for class balancing)
    sample_weight: Mapped[Decimal] = mapped_column(Numeric(5, 2), default=Decimal("1.00"))

    # Source
    source_type: Mapped[str] = mapped_column(String(50))  # initial, user_feedback, manual
    source_id: Mapped[Optional[int]] = mapped_column(
        Integer, nullable=True
    )  # classification_log_id if from feedback

    # Version
    dataset_version: Mapped[str] = mapped_column(String(50))

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

    def __repr__(self):
        return f"<AITrainingData {self.id} -> {self.account_code}>"


class AIModelVersion(Base):
    """AI 모델 버전 관리"""
    __tablename__ = "ai_model_versions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)

    version: Mapped[str] = mapped_column(String(50), unique=True, index=True)
    model_type: Mapped[str] = mapped_column(String(100))  # random_forest, transformer, etc.

    # Training info
    training_samples: Mapped[int] = mapped_column(Integer)
    training_started_at: Mapped[datetime] = mapped_column(DateTime)
    training_completed_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime, nullable=True
    )

    # Metrics
    accuracy: Mapped[Optional[Decimal]] = mapped_column(Numeric(5, 4), nullable=True)
    precision: Mapped[Optional[Decimal]] = mapped_column(Numeric(5, 4), nullable=True)
    recall: Mapped[Optional[Decimal]] = mapped_column(Numeric(5, 4), nullable=True)
    f1_score: Mapped[Optional[Decimal]] = mapped_column(Numeric(5, 4), nullable=True)

    # Hyperparameters
    hyperparameters: Mapped[Optional[str]] = mapped_column(Text, nullable=True)  # JSON

    # Model file
    model_path: Mapped[str] = mapped_column(String(500))
    model_size_bytes: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)

    # Status
    is_active: Mapped[bool] = mapped_column(Boolean, default=False)  # 현재 사용 중인 버전
    is_production: Mapped[bool] = mapped_column(Boolean, default=False)

    # Notes
    release_notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    created_by: Mapped[int] = mapped_column(Integer, ForeignKey("users.id"))

    def __repr__(self):
        return f"<AIModelVersion {self.version}>"


class CustomTag(Base):
    """사용자 정의 태그 (프로젝트, TF 등)"""
    __tablename__ = "custom_tags"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)

    code: Mapped[str] = mapped_column(String(50), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(100))
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    # Category
    tag_type: Mapped[str] = mapped_column(String(50))  # project, tf, campaign, etc.
    color: Mapped[Optional[str]] = mapped_column(String(7), nullable=True)  # #RRGGBB

    # Scope
    department_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("departments.id"), nullable=True
    )  # null = 전사 공통

    # Period
    start_date: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    end_date: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    # Budget (optional)
    budget_amount: Mapped[Optional[Decimal]] = mapped_column(
        Numeric(18, 2), nullable=True
    )
    used_amount: Mapped[Decimal] = mapped_column(Numeric(18, 2), default=Decimal("0"))

    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )
    created_by: Mapped[int] = mapped_column(Integer, ForeignKey("users.id"))

    # AI learning - keywords associated with this tag
    ai_keywords: Mapped[Optional[str]] = mapped_column(Text, nullable=True)  # JSON array

    def __repr__(self):
        return f"<CustomTag {self.code}: {self.name}>"


# ============ 업로드 이력 & 원본 데이터 보관 ============

class UploadStatus(enum.Enum):
    """업로드 상태"""
    PROCESSING = "processing"
    COMPLETED = "completed"
    FAILED = "failed"


class AIDataUploadHistory(Base):
    """AI 데이터 업로드 이력"""
    __tablename__ = "ai_data_upload_history"
    __table_args__ = (
        Index("ix_ai_upload_history_uploaded_by", "uploaded_by"),
        Index("ix_ai_upload_history_created_at", "created_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)

    filename: Mapped[str] = mapped_column(String(500))
    file_size: Mapped[int] = mapped_column(Integer)  # bytes
    file_type: Mapped[str] = mapped_column(String(10))  # xls, xlsx, csv
    upload_type: Mapped[str] = mapped_column(String(20))  # historical, classify

    row_count: Mapped[int] = mapped_column(Integer, default=0)
    saved_count: Mapped[int] = mapped_column(Integer, default=0)
    error_count: Mapped[int] = mapped_column(Integer, default=0)

    uploaded_by: Mapped[int] = mapped_column(Integer, ForeignKey("users.id"))

    status: Mapped[UploadStatus] = mapped_column(
        SQLEnum(UploadStatus, native_enum=False), default=UploadStatus.PROCESSING
    )
    error_message: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    # Relationships
    raw_transactions: Mapped[List["AIRawTransactionData"]] = relationship(
        "AIRawTransactionData", back_populates="upload", cascade="all, delete-orphan"
    )

    def __repr__(self):
        return f"<AIDataUploadHistory {self.id} {self.filename} ({self.status.value})>"


class AIRawTransactionData(Base):
    """업로드된 원본 거래 데이터 보관"""
    __tablename__ = "ai_raw_transaction_data"
    __table_args__ = (
        Index("ix_ai_raw_txn_upload_id", "upload_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)

    upload_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("ai_data_upload_history.id", ondelete="CASCADE")
    )
    row_number: Mapped[int] = mapped_column(Integer)

    # 원본 데이터
    original_description: Mapped[str] = mapped_column(String(500))
    merchant_name: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    amount: Mapped[Decimal] = mapped_column(Numeric(18, 2), default=Decimal("0"))
    debit_amount: Mapped[Decimal] = mapped_column(Numeric(18, 2), default=Decimal("0"))
    credit_amount: Mapped[Decimal] = mapped_column(Numeric(18, 2), default=Decimal("0"))
    transaction_date: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)

    # 계정 정보
    account_code: Mapped[str] = mapped_column(String(20))
    account_name: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    source_account_code: Mapped[Optional[str]] = mapped_column(
        String(20), nullable=True, comment="원장 계정코드 (예: 103)"
    )
    source_account_name: Mapped[Optional[str]] = mapped_column(
        String(100), nullable=True, comment="원장 계정명 (예: 보통예금)"
    )

    # 학습 데이터 연결
    training_data_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("ai_training_data.id"), nullable=True
    )

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    # Relationships
    upload: Mapped["AIDataUploadHistory"] = relationship(
        "AIDataUploadHistory", back_populates="raw_transactions"
    )

    def __repr__(self):
        return f"<AIRawTransactionData {self.id} row={self.row_number}>"
