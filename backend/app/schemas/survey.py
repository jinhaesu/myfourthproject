"""
Smart Finance Core - Survey & Commute Schemas
설문조사, 출퇴근 관련 API 스키마
"""
from datetime import datetime, date
from typing import Optional, List, Any
from pydantic import BaseModel, Field


# ============================================================================
# SurveyQuestion Schemas
# ============================================================================

class SurveyQuestionCreate(BaseModel):
    """설문 문항 생성"""
    question_text: str = Field(..., min_length=1, max_length=500)
    question_type: str = Field(default="text")
    order: int = Field(default=0, ge=0)
    is_required: bool = False
    options: Optional[str] = None          # JSON string e.g. '["옵션1","옵션2"]'
    scale_min: Optional[int] = None
    scale_max: Optional[int] = None
    scale_min_label: Optional[str] = Field(None, max_length=50)
    scale_max_label: Optional[str] = Field(None, max_length=50)
    placeholder: Optional[str] = Field(None, max_length=200)


class SurveyQuestionUpdate(BaseModel):
    """설문 문항 수정"""
    question_text: Optional[str] = Field(None, min_length=1, max_length=500)
    question_type: Optional[str] = None
    order: Optional[int] = Field(None, ge=0)
    is_required: Optional[bool] = None
    options: Optional[str] = None
    scale_min: Optional[int] = None
    scale_max: Optional[int] = None
    scale_min_label: Optional[str] = Field(None, max_length=50)
    scale_max_label: Optional[str] = Field(None, max_length=50)
    placeholder: Optional[str] = Field(None, max_length=200)


class SurveyQuestionResponse(BaseModel):
    """설문 문항 응답"""
    id: int
    survey_id: int
    question_text: str
    question_type: str
    order: int
    is_required: bool
    options: Optional[str] = None
    scale_min: Optional[int] = None
    scale_max: Optional[int] = None
    scale_min_label: Optional[str] = None
    scale_max_label: Optional[str] = None
    placeholder: Optional[str] = None
    created_at: datetime

    class Config:
        from_attributes = True


# ============================================================================
# Survey Schemas
# ============================================================================

class SurveyCreate(BaseModel):
    """설문조사 생성"""
    title: str = Field(..., min_length=1, max_length=200)
    description: Optional[str] = None
    category: str = Field(default="general")
    target_department_id: Optional[int] = None
    is_anonymous: bool = False
    is_required: bool = False
    start_date: Optional[datetime] = None
    end_date: Optional[datetime] = None
    is_recurring: bool = False
    recurrence_type: Optional[str] = Field(None, max_length=20)
    questions: Optional[List[SurveyQuestionCreate]] = []


class SurveyUpdate(BaseModel):
    """설문조사 수정"""
    title: Optional[str] = Field(None, min_length=1, max_length=200)
    description: Optional[str] = None
    category: Optional[str] = None
    status: Optional[str] = None
    target_department_id: Optional[int] = None
    is_anonymous: Optional[bool] = None
    is_required: Optional[bool] = None
    start_date: Optional[datetime] = None
    end_date: Optional[datetime] = None
    is_recurring: Optional[bool] = None
    recurrence_type: Optional[str] = Field(None, max_length=20)
    questions: Optional[List[SurveyQuestionCreate]] = None  # None = no change, [] = clear all


class SurveyResponse(BaseModel):
    """설문조사 응답"""
    id: int
    title: str
    description: Optional[str] = None
    category: str
    status: str
    target_department_id: Optional[int] = None
    is_anonymous: bool
    is_required: bool
    start_date: Optional[datetime] = None
    end_date: Optional[datetime] = None
    is_recurring: bool
    recurrence_type: Optional[str] = None
    created_by: int
    created_at: datetime
    updated_at: datetime
    questions: Optional[List[SurveyQuestionResponse]] = []

    class Config:
        from_attributes = True


class SurveyListResponse(BaseModel):
    """설문조사 목록 응답"""
    id: int
    title: str
    category: str
    status: str
    is_anonymous: bool
    is_required: bool
    start_date: Optional[datetime] = None
    end_date: Optional[datetime] = None
    created_by: int
    created_at: datetime
    question_count: int = 0
    response_count: int = 0

    class Config:
        from_attributes = True


# ============================================================================
# SurveyAnswer Schemas
# ============================================================================

class SurveyAnswerCreate(BaseModel):
    """설문 답변 생성"""
    question_id: int
    answer_text: Optional[str] = None
    answer_number: Optional[int] = None
    answer_json: Optional[str] = None  # JSON string for multiple choice


class SurveyAnswerResponse(BaseModel):
    """설문 답변 응답"""
    id: int
    response_id: int
    question_id: int
    answer_text: Optional[str] = None
    answer_number: Optional[int] = None
    answer_json: Optional[str] = None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


# ============================================================================
# SurveyResponseRecord Schemas (설문 응답 레코드)
# ============================================================================

class SurveyResponseCreate(BaseModel):
    """설문 응답 제출"""
    survey_id: int
    user_id: Optional[int] = None  # None이면 current_user 사용
    response_date: Optional[date] = None  # None이면 오늘
    answers: List[SurveyAnswerCreate] = []


class SurveyResponseUpdate(BaseModel):
    """설문 응답 수정"""
    answers: List[SurveyAnswerCreate] = []
    response_date: Optional[date] = None


class SurveyResponseRecord(BaseModel):
    """설문 응답 레코드 응답"""
    id: int
    survey_id: int
    user_id: int
    response_date: date
    submitted_at: datetime
    updated_at: datetime
    answers: Optional[List[SurveyAnswerResponse]] = []

    class Config:
        from_attributes = True


class SurveyResponseListItem(BaseModel):
    """설문 응답 목록 아이템"""
    id: int
    survey_id: int
    survey_title: Optional[str] = None
    user_id: int
    user_name: Optional[str] = None
    response_date: date
    submitted_at: datetime
    updated_at: datetime
    answer_count: int = 0

    class Config:
        from_attributes = True


# ============================================================================
# CommuteRecord Schemas
# ============================================================================

class CommuteRecordCreate(BaseModel):
    """출퇴근 기록 생성"""
    user_id: Optional[int] = None
    record_date: Optional[date] = None
    check_in_time: Optional[str] = Field(None, max_length=5, description="HH:MM")
    check_out_time: Optional[str] = Field(None, max_length=5, description="HH:MM")
    departure_time: Optional[str] = Field(None, max_length=5, description="HH:MM")
    arrival_time: Optional[str] = Field(None, max_length=5, description="HH:MM")
    transport_method: Optional[str] = None
    commute_duration_minutes: Optional[int] = Field(None, ge=0)
    note: Optional[str] = None
    survey_response_id: Optional[int] = None
    is_late: bool = False
    is_early_leave: bool = False
    is_absent: bool = False


class CommuteRecordUpdate(BaseModel):
    """출퇴근 기록 수정"""
    check_in_time: Optional[str] = Field(None, max_length=5)
    check_out_time: Optional[str] = Field(None, max_length=5)
    departure_time: Optional[str] = Field(None, max_length=5)
    arrival_time: Optional[str] = Field(None, max_length=5)
    transport_method: Optional[str] = None
    commute_duration_minutes: Optional[int] = Field(None, ge=0)
    note: Optional[str] = None
    is_late: Optional[bool] = None
    is_early_leave: Optional[bool] = None
    is_absent: Optional[bool] = None


class CommuteRecordResponse(BaseModel):
    """출퇴근 기록 응답"""
    id: int
    user_id: int
    record_date: date
    record_year: int
    record_month: int
    check_in_time: Optional[str] = None
    check_out_time: Optional[str] = None
    departure_time: Optional[str] = None
    arrival_time: Optional[str] = None
    transport_method: Optional[str] = None
    commute_duration_minutes: Optional[int] = None
    note: Optional[str] = None
    survey_response_id: Optional[int] = None
    is_late: bool
    is_early_leave: bool
    is_absent: bool
    created_at: datetime
    updated_at: datetime
    user_name: Optional[str] = None
    department_name: Optional[str] = None

    class Config:
        from_attributes = True


class CommuteSummaryItem(BaseModel):
    """출퇴근 요약 아이템"""
    user_id: int
    user_name: str
    department_name: Optional[str] = None
    year: int
    month: int
    total_days: int
    late_count: int
    early_leave_count: int
    absent_count: int
    avg_commute_minutes: Optional[float] = None


class CheckInRequest(BaseModel):
    """출근 체크인 요청"""
    note: Optional[str] = None
    transport_method: Optional[str] = None
    departure_time: Optional[str] = Field(None, max_length=5)


class CheckOutRequest(BaseModel):
    """퇴근 체크아웃 요청"""
    note: Optional[str] = None


# ============================================================================
# Template Schemas
# ============================================================================

class SurveyTemplateInfo(BaseModel):
    """설문 템플릿 정보"""
    template_type: str
    title: str
    description: str
    category: str
    question_count: int


class TemplateCreateRequest(BaseModel):
    """템플릿에서 설문 생성 요청"""
    title: Optional[str] = None
    target_department_id: Optional[int] = None
    start_date: Optional[datetime] = None
    end_date: Optional[datetime] = None
    is_recurring: bool = False
    recurrence_type: Optional[str] = None
