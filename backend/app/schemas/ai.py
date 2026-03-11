"""
Smart Finance Core - AI Schemas
AI 분류 관련 API 스키마
"""
from datetime import datetime
from decimal import Decimal
from typing import Optional, List
from pydantic import BaseModel, Field


class AIClassificationRequest(BaseModel):
    """AI 분류 요청 스키마"""
    description: str = Field(..., min_length=1, max_length=500)
    merchant_name: Optional[str] = None
    merchant_category: Optional[str] = None
    amount: Decimal
    transaction_time: Optional[str] = None  # HH:MM:SS
    transaction_date: Optional[str] = None  # YYYY-MM-DD


class AIClassificationPrediction(BaseModel):
    """AI 분류 예측 결과"""
    account_id: int
    account_code: str
    account_name: str
    confidence_score: Decimal


class AIClassificationResponse(BaseModel):
    """AI 분류 응답 스키마"""
    primary_prediction: AIClassificationPrediction
    alternative_predictions: List[AIClassificationPrediction]
    auto_confirm: bool  # 자동 확정 여부
    needs_review: bool  # 검토 필요 여부
    reasoning: Optional[str] = None  # AI 판단 근거
    suggested_tags: List[str] = []  # 추천 커스텀 태그
    model_version: str


class AIFeedbackRequest(BaseModel):
    """AI 피드백 요청 스키마 (사용자가 수정 시)"""
    classification_log_id: Optional[int] = None
    voucher_id: Optional[int] = None

    # Original input
    description: str
    merchant_name: Optional[str] = None
    amount: Decimal

    # AI prediction
    predicted_account_id: int

    # User correction
    actual_account_id: int
    correction_reason: Optional[str] = None

    # Custom tags (optional)
    custom_tags: List[str] = []


class AIFeedbackResponse(BaseModel):
    """AI 피드백 응답 스키마"""
    success: bool
    message: str
    classification_log_id: int
    will_retrain: bool  # 재학습 예정 여부


class CustomTagCreate(BaseModel):
    """커스텀 태그 생성 스키마"""
    code: str = Field(..., min_length=1, max_length=50)
    name: str = Field(..., min_length=1, max_length=100)
    description: Optional[str] = None
    tag_type: str  # project, tf, campaign, etc.
    color: Optional[str] = None
    department_id: Optional[int] = None
    start_date: Optional[datetime] = None
    end_date: Optional[datetime] = None
    budget_amount: Optional[Decimal] = None
    ai_keywords: List[str] = []


class CustomTagResponse(BaseModel):
    """커스텀 태그 응답 스키마"""
    id: int
    code: str
    name: str
    description: Optional[str] = None
    tag_type: str
    color: Optional[str] = None
    department_id: Optional[int] = None
    department_name: Optional[str] = None
    start_date: Optional[datetime] = None
    end_date: Optional[datetime] = None
    budget_amount: Optional[Decimal] = None
    used_amount: Decimal
    remaining_amount: Optional[Decimal] = None
    is_active: bool
    ai_keywords: List[str] = []
    created_at: datetime

    class Config:
        from_attributes = True


class AIModelStatusResponse(BaseModel):
    """AI 모델 상태 응답"""
    current_version: str
    model_type: str
    accuracy: Optional[Decimal] = None
    f1_score: Optional[Decimal] = None
    training_samples: int
    last_trained: Optional[datetime] = None
    is_production: bool
    pending_feedback_count: int
    next_retrain_at: Optional[datetime] = None


class AITrainingTriggerRequest(BaseModel):
    """AI 재학습 트리거 요청"""
    force: bool = False  # 강제 재학습
    include_recent_feedback: bool = True


class AITrainingStatusResponse(BaseModel):
    """AI 학습 상태 응답"""
    status: str  # idle, training, completed, failed
    current_version: str
    new_version: Optional[str] = None
    progress_percentage: Optional[int] = None
    training_samples: Optional[int] = None
    started_at: Optional[datetime] = None
    estimated_completion: Optional[datetime] = None
    error_message: Optional[str] = None
