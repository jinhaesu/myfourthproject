"""
Smart Finance Core - Survey & Commute Models
설문조사, 출퇴근 관련 모델
"""
from datetime import datetime, date
from typing import Optional, List
from sqlalchemy import (
    Column, Integer, String, Boolean, DateTime, ForeignKey,
    Text, Date, Enum as SQLEnum, Index, UniqueConstraint
)
from sqlalchemy.orm import relationship, Mapped, mapped_column
import enum

from app.core.database import Base


# ============================================================================
# Enums
# ============================================================================

class SurveyCategory(str, enum.Enum):
    COMMUTE = "commute"
    SATISFACTION = "satisfaction"
    GENERAL = "general"
    HR = "hr"
    CUSTOM = "custom"


class SurveyStatus(str, enum.Enum):
    DRAFT = "draft"
    ACTIVE = "active"
    CLOSED = "closed"
    ARCHIVED = "archived"


class QuestionType(str, enum.Enum):
    TEXT = "text"
    TEXTAREA = "textarea"
    SINGLE_CHOICE = "single_choice"
    MULTIPLE_CHOICE = "multiple_choice"
    SCALE = "scale"
    DATE = "date"
    TIME = "time"
    DATETIME = "datetime"
    NUMBER = "number"


class TransportMethod(str, enum.Enum):
    CAR = "car"
    BUS = "bus"
    SUBWAY = "subway"
    BICYCLE = "bicycle"
    WALK = "walk"
    TAXI = "taxi"
    OTHER = "other"


# ============================================================================
# Models
# ============================================================================

class Survey(Base):
    """설문조사"""
    __tablename__ = "surveys"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    category: Mapped[SurveyCategory] = mapped_column(
        SQLEnum(SurveyCategory, native_enum=False), default=SurveyCategory.GENERAL
    )
    status: Mapped[SurveyStatus] = mapped_column(
        SQLEnum(SurveyStatus, native_enum=False), default=SurveyStatus.DRAFT
    )
    target_department_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("departments.id"), nullable=True
    )
    is_anonymous: Mapped[bool] = mapped_column(Boolean, default=False)
    is_required: Mapped[bool] = mapped_column(Boolean, default=False)
    start_date: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    end_date: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    is_recurring: Mapped[bool] = mapped_column(Boolean, default=False)
    recurrence_type: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)  # daily/weekly/monthly

    created_by: Mapped[int] = mapped_column(Integer, ForeignKey("users.id"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )

    # Relationships
    questions: Mapped[List["SurveyQuestion"]] = relationship(
        "SurveyQuestion", back_populates="survey", cascade="all, delete-orphan",
        order_by="SurveyQuestion.order"
    )
    responses: Mapped[List["SurveyResponse"]] = relationship(
        "SurveyResponse", back_populates="survey", cascade="all, delete-orphan"
    )
    creator: Mapped["User"] = relationship("User", foreign_keys=[created_by])
    target_department: Mapped[Optional["Department"]] = relationship(
        "Department", foreign_keys=[target_department_id]
    )

    def __repr__(self):
        return f"<Survey {self.id}: {self.title}>"


class SurveyQuestion(Base):
    """설문 문항"""
    __tablename__ = "survey_questions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    survey_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("surveys.id"), nullable=False, index=True
    )
    question_text: Mapped[str] = mapped_column(String(500), nullable=False)
    question_type: Mapped[QuestionType] = mapped_column(
        SQLEnum(QuestionType, native_enum=False), default=QuestionType.TEXT
    )
    order: Mapped[int] = mapped_column(Integer, default=0)
    is_required: Mapped[bool] = mapped_column(Boolean, default=False)
    options: Mapped[Optional[str]] = mapped_column(Text, nullable=True)  # JSON string
    scale_min: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    scale_max: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    scale_min_label: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)
    scale_max_label: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)
    placeholder: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    # Relationships
    survey: Mapped["Survey"] = relationship("Survey", back_populates="questions")
    answers: Mapped[List["SurveyAnswer"]] = relationship(
        "SurveyAnswer", back_populates="question", cascade="all, delete-orphan"
    )

    def __repr__(self):
        return f"<SurveyQuestion {self.id}: {self.question_text[:50]}>"


class SurveyResponse(Base):
    """설문 응답 (한 사용자의 한 설문에 대한 전체 응답)"""
    __tablename__ = "survey_responses"
    __table_args__ = (
        Index("ix_survey_responses_survey_user", "survey_id", "user_id"),
        Index("ix_survey_responses_response_date", "response_date"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    survey_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("surveys.id"), nullable=False
    )
    user_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("users.id"), nullable=False
    )
    response_date: Mapped[date] = mapped_column(Date, nullable=False)
    submitted_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )

    # Relationships
    survey: Mapped["Survey"] = relationship("Survey", back_populates="responses")
    user: Mapped["User"] = relationship("User", foreign_keys=[user_id])
    answers: Mapped[List["SurveyAnswer"]] = relationship(
        "SurveyAnswer", back_populates="response", cascade="all, delete-orphan"
    )
    commute_record: Mapped[Optional["CommuteRecord"]] = relationship(
        "CommuteRecord", back_populates="survey_response"
    )

    def __repr__(self):
        return f"<SurveyResponse {self.id}: survey={self.survey_id} user={self.user_id}>"


class SurveyAnswer(Base):
    """설문 개별 답변 (문항별)"""
    __tablename__ = "survey_answers"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    response_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("survey_responses.id"), nullable=False, index=True
    )
    question_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("survey_questions.id"), nullable=False, index=True
    )
    answer_text: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    answer_number: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    answer_json: Mapped[Optional[str]] = mapped_column(Text, nullable=True)  # JSON string for multiple choice
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )

    # Relationships
    response: Mapped["SurveyResponse"] = relationship("SurveyResponse", back_populates="answers")
    question: Mapped["SurveyQuestion"] = relationship("SurveyQuestion", back_populates="answers")

    def __repr__(self):
        return f"<SurveyAnswer {self.id}: response={self.response_id} question={self.question_id}>"


class CommuteRecord(Base):
    """출퇴근 기록"""
    __tablename__ = "commute_records"
    __table_args__ = (
        UniqueConstraint("user_id", "record_date", name="uq_commute_records_user_date"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    user_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("users.id"), nullable=False, index=True
    )
    record_date: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    record_year: Mapped[int] = mapped_column(Integer, nullable=False)
    record_month: Mapped[int] = mapped_column(Integer, nullable=False)

    # 근무 시간
    check_in_time: Mapped[Optional[str]] = mapped_column(String(5), nullable=True)   # "09:00"
    check_out_time: Mapped[Optional[str]] = mapped_column(String(5), nullable=True)  # "18:00"

    # 출퇴근 시간 (집 ↔ 회사)
    departure_time: Mapped[Optional[str]] = mapped_column(String(5), nullable=True)
    arrival_time: Mapped[Optional[str]] = mapped_column(String(5), nullable=True)

    transport_method: Mapped[Optional[TransportMethod]] = mapped_column(
        SQLEnum(TransportMethod, native_enum=False), nullable=True
    )
    commute_duration_minutes: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    note: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    # 연결된 설문 응답
    survey_response_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("survey_responses.id"), nullable=True
    )

    # 특이 사항
    is_late: Mapped[bool] = mapped_column(Boolean, default=False)
    is_early_leave: Mapped[bool] = mapped_column(Boolean, default=False)
    is_absent: Mapped[bool] = mapped_column(Boolean, default=False)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )

    # Relationships
    user: Mapped["User"] = relationship("User", foreign_keys=[user_id])
    survey_response: Mapped[Optional["SurveyResponse"]] = relationship(
        "SurveyResponse", back_populates="commute_record"
    )

    def __repr__(self):
        return f"<CommuteRecord {self.id}: user={self.user_id} date={self.record_date}>"
