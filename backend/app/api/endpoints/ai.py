"""
Smart Finance Core - AI API
AI 분류 관련 API 엔드포인트
"""
from typing import List
from fastapi import APIRouter, Depends, HTTPException, status, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.schemas.ai import (
    AIClassificationRequest, AIClassificationResponse, AIClassificationPrediction,
    AIFeedbackRequest, AIFeedbackResponse,
    CustomTagCreate, CustomTagResponse,
    AIModelStatusResponse, AITrainingStatusResponse
)
from app.services.ai_classifier import AIClassifierService

router = APIRouter()


@router.post("/classify", response_model=AIClassificationResponse)
async def classify_transaction(
    request: AIClassificationRequest,
    db: AsyncSession = Depends(get_db)
):
    """
    거래 분류

    - 적요, 가맹점명, 금액 등을 분석하여 계정과목을 자동 분류합니다
    - 신뢰도 점수와 함께 최대 5개의 추천 계정을 반환합니다
    """
    classifier = AIClassifierService()

    result = await classifier.classify(
        db=db,
        description=request.description,
        merchant_name=request.merchant_name,
        merchant_category=request.merchant_category,
        amount=request.amount,
        transaction_time=request.transaction_time
    )

    return AIClassificationResponse(
        primary_prediction=AIClassificationPrediction(**result["primary_prediction"]),
        alternative_predictions=[
            AIClassificationPrediction(**p) for p in result["alternative_predictions"]
        ],
        auto_confirm=result["auto_confirm"],
        needs_review=result["needs_review"],
        reasoning=result["reasoning"],
        suggested_tags=result["suggested_tags"],
        model_version=result["model_version"]
    )


@router.post("/feedback", response_model=AIFeedbackResponse)
async def submit_feedback(
    feedback: AIFeedbackRequest,
    user_id: int = Query(..., description="현재 사용자 ID"),
    db: AsyncSession = Depends(get_db)
):
    """
    AI 피드백 제출

    - 사용자가 AI 분류를 수정하면 학습 데이터로 활용됩니다
    - 이 데이터는 모델 재학습에 사용됩니다
    """
    classifier = AIClassifierService()

    log_id = await classifier.record_feedback(
        db=db,
        voucher_id=feedback.voucher_id,
        description=feedback.description,
        merchant_name=feedback.merchant_name,
        amount=feedback.amount,
        predicted_account_id=feedback.predicted_account_id,
        actual_account_id=feedback.actual_account_id,
        user_id=user_id,
        correction_reason=feedback.correction_reason,
        custom_tags=feedback.custom_tags
    )

    return AIFeedbackResponse(
        success=True,
        message="피드백이 기록되었습니다.",
        classification_log_id=log_id,
        will_retrain=True
    )


@router.post("/retrain", response_model=AITrainingStatusResponse)
async def trigger_retraining(
    user_id: int = Query(..., description="현재 사용자 ID"),
    force: bool = False,
    db: AsyncSession = Depends(get_db)
):
    """
    모델 재학습 트리거

    - 축적된 피드백 데이터로 모델을 재학습합니다
    - 관리자 권한 필요
    """
    classifier = AIClassifierService()

    success, message = await classifier.retrain_model(db, user_id)

    if not success:
        return AITrainingStatusResponse(
            status="failed",
            current_version=classifier.model_version or "unknown",
            error_message=message
        )

    return AITrainingStatusResponse(
        status="completed",
        current_version=classifier.model_version,
        new_version=classifier.model_version
    )


@router.get("/model-status", response_model=AIModelStatusResponse)
async def get_model_status(
    db: AsyncSession = Depends(get_db)
):
    """AI 모델 상태 조회"""
    from app.models.ai import AIModelVersion, AIClassificationLog
    from sqlalchemy import select, func

    # 현재 활성 모델
    result = await db.execute(
        select(AIModelVersion).where(
            AIModelVersion.is_active == True
        )
    )
    model = result.scalar_first()

    # 대기 중인 피드백 수
    result = await db.execute(
        select(func.count(AIClassificationLog.id)).where(
            AIClassificationLog.used_for_training == False
        )
    )
    pending_count = result.scalar() or 0

    if model:
        return AIModelStatusResponse(
            current_version=model.version,
            model_type=model.model_type,
            accuracy=model.accuracy,
            f1_score=model.f1_score,
            training_samples=model.training_samples,
            last_trained=model.training_completed_at,
            is_production=model.is_production,
            pending_feedback_count=pending_count
        )
    else:
        from datetime import datetime
        return AIModelStatusResponse(
            current_version="default_v1.0",
            model_type="random_forest",
            accuracy=None,
            f1_score=None,
            training_samples=0,
            last_trained=datetime.utcnow(),
            is_production=False,
            pending_feedback_count=pending_count
        )


# ==================== 커스텀 태그 ====================

@router.post("/tags/", response_model=CustomTagResponse, status_code=status.HTTP_201_CREATED)
async def create_custom_tag(
    tag_data: CustomTagCreate,
    user_id: int = Query(..., description="현재 사용자 ID"),
    db: AsyncSession = Depends(get_db)
):
    """
    커스텀 태그 생성

    - 프로젝트, TF, 캠페인 등 사용자 정의 태그를 생성합니다
    - AI가 자동으로 태깅할 수 있도록 키워드를 설정할 수 있습니다
    """
    import json
    from app.models.ai import CustomTag

    tag = CustomTag(
        code=tag_data.code,
        name=tag_data.name,
        description=tag_data.description,
        tag_type=tag_data.tag_type,
        color=tag_data.color,
        department_id=tag_data.department_id,
        start_date=tag_data.start_date,
        end_date=tag_data.end_date,
        budget_amount=tag_data.budget_amount,
        ai_keywords=json.dumps(tag_data.ai_keywords) if tag_data.ai_keywords else None,
        created_by=user_id
    )

    db.add(tag)
    await db.commit()

    return CustomTagResponse.model_validate(tag)


@router.get("/tags/", response_model=List[CustomTagResponse])
async def get_custom_tags(
    tag_type: str = None,
    department_id: int = None,
    active_only: bool = True,
    db: AsyncSession = Depends(get_db)
):
    """커스텀 태그 목록 조회"""
    from app.models.ai import CustomTag
    from sqlalchemy import select, and_, or_

    conditions = []

    if active_only:
        conditions.append(CustomTag.is_active == True)
    if tag_type:
        conditions.append(CustomTag.tag_type == tag_type)
    if department_id:
        conditions.append(
            or_(
                CustomTag.department_id == department_id,
                CustomTag.department_id.is_(None)
            )
        )

    query = select(CustomTag)
    if conditions:
        query = query.where(and_(*conditions))
    query = query.order_by(CustomTag.tag_type, CustomTag.code)

    result = await db.execute(query)
    tags = result.scalars().all()

    return [CustomTagResponse.model_validate(t) for t in tags]
