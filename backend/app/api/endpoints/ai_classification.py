"""
Smart Finance Core - AI 계정 분류 API
더존 과거 데이터 학습 및 자동 분류 기능
"""
import json
import io
from datetime import datetime
from decimal import Decimal
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func
import pandas as pd

from app.core.database import get_db
from app.core.security import get_current_user
from app.models.user import User
from app.models.accounting import Account, AccountCategory
from app.models.ai import AIClassificationLog, AITrainingData, AIModelVersion
from app.services.ai_classifier import AIClassifierService

router = APIRouter(prefix="/ai-classification", tags=["AI 분류"])


# ============ Pydantic Models ============

class TrainingDataItem(BaseModel):
    """학습 데이터 항목"""
    description: str = Field(..., description="적요/거래내역")
    merchant_name: Optional[str] = Field(None, description="거래처명")
    amount: Decimal = Field(default=Decimal("0"), description="금액")
    account_code: str = Field(..., description="계정과목 코드")
    account_name: Optional[str] = Field(None, description="계정과목명")


class TrainingRequest(BaseModel):
    """학습 요청"""
    data: List[TrainingDataItem]
    retrain: bool = Field(default=False, description="모델 재학습 여부")


class ClassifyItem(BaseModel):
    """분류 요청 항목"""
    id: Optional[str] = Field(None, description="외부 참조 ID")
    description: str = Field(..., description="적요/거래내역")
    merchant_name: Optional[str] = Field(None, description="거래처명")
    amount: Decimal = Field(default=Decimal("0"), description="금액")
    transaction_date: Optional[str] = Field(None, description="거래일자")
    transaction_time: Optional[str] = Field(None, description="거래시간")


class ClassifyRequest(BaseModel):
    """분류 요청"""
    items: List[ClassifyItem]


class FeedbackItem(BaseModel):
    """피드백 항목"""
    classification_id: Optional[int] = Field(None, description="분류 로그 ID")
    description: str = Field(..., description="적요")
    merchant_name: Optional[str] = Field(None)
    amount: Decimal = Field(default=Decimal("0"))
    predicted_account_code: str = Field(..., description="AI 예측 코드")
    actual_account_code: str = Field(..., description="사용자 수정 코드")
    correction_reason: Optional[str] = Field(None, description="수정 사유")


class FeedbackRequest(BaseModel):
    """피드백 요청"""
    items: List[FeedbackItem]


class AccountMapping(BaseModel):
    """계정과목 매핑"""
    code: str
    name: str
    category: str


# ============ API Endpoints ============

@router.get("/status")
async def get_ai_status(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """AI 모델 상태 조회"""
    classifier = AIClassifierService()
    await classifier.load_model(db)

    # 학습 데이터 통계
    training_count = await db.scalar(
        select(func.count(AITrainingData.id)).where(AITrainingData.is_active == True)
    )

    # 분류 로그 통계
    log_stats = await db.execute(
        select(
            func.count(AIClassificationLog.id).label("total"),
            func.sum(
                func.case((AIClassificationLog.classification_result == "correct", 1), else_=0)
            ).label("correct"),
            func.sum(
                func.case((AIClassificationLog.classification_result == "corrected", 1), else_=0)
            ).label("corrected")
        )
    )
    stats = log_stats.one()

    # 최신 모델 버전 조회
    model_result = await db.execute(
        select(AIModelVersion)
        .where(AIModelVersion.is_active == True)
        .order_by(AIModelVersion.created_at.desc())
        .limit(1)
    )
    active_model = model_result.scalar_one_or_none()

    accuracy_rate = 0
    if stats.total and stats.total > 0:
        accuracy_rate = (stats.correct or 0) / stats.total * 100

    return {
        "model_version": active_model.version if active_model else "default_v1.0",
        "is_trained": active_model is not None,
        "training_samples": training_count or 0,
        "total_classifications": stats.total or 0,
        "correct_classifications": stats.correct or 0,
        "corrected_classifications": stats.corrected or 0,
        "accuracy_rate": round(accuracy_rate, 2),
        "last_trained_at": active_model.training_completed_at.isoformat() if active_model and active_model.training_completed_at else None,
        "model_accuracy": float(active_model.accuracy) if active_model and active_model.accuracy else None
    }


@router.get("/accounts")
async def get_account_list(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """계정과목 목록 조회 (분류용)"""
    result = await db.execute(
        select(Account, AccountCategory)
        .join(AccountCategory, Account.category_id == AccountCategory.id)
        .where(Account.is_active == True, Account.is_detail == True)
        .order_by(Account.code)
    )
    accounts = result.all()

    return [
        {
            "id": acc.Account.id,
            "code": acc.Account.code,
            "name": acc.Account.name,
            "category": acc.AccountCategory.name,
            "keywords": acc.Account.keywords
        }
        for acc in accounts
    ]


@router.post("/upload-historical")
async def upload_historical_data(
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    더존 과거 데이터 업로드 (학습용)

    엑셀 파일 형식:
    - 적요 (필수): 거래 내역
    - 거래처명 (선택)
    - 금액 (선택)
    - 계정과목코드 (필수): 더존에서 분류된 계정코드
    - 계정과목명 (선택)
    """
    if not file.filename.endswith(('.xlsx', '.xls', '.csv')):
        raise HTTPException(status_code=400, detail="엑셀 또는 CSV 파일만 업로드 가능합니다.")

    try:
        content = await file.read()

        if file.filename.endswith('.csv'):
            df = pd.read_csv(io.BytesIO(content), encoding='utf-8-sig')
        else:
            df = pd.read_excel(io.BytesIO(content))

        # 컬럼명 정규화
        column_mapping = {
            '적요': 'description',
            '거래내역': 'description',
            '내역': 'description',
            '거래처명': 'merchant_name',
            '거래처': 'merchant_name',
            '가맹점': 'merchant_name',
            '금액': 'amount',
            '거래금액': 'amount',
            '계정과목코드': 'account_code',
            '계정코드': 'account_code',
            '계정과목': 'account_code',
            '계정과목명': 'account_name',
            '계정명': 'account_name'
        }

        df.columns = [column_mapping.get(col.strip(), col.strip()) for col in df.columns]

        # 필수 컬럼 확인
        if 'description' not in df.columns:
            raise HTTPException(status_code=400, detail="'적요' 또는 '거래내역' 컬럼이 필요합니다.")
        if 'account_code' not in df.columns:
            raise HTTPException(status_code=400, detail="'계정과목코드' 컬럼이 필요합니다.")

        # 데이터 정제
        df = df.dropna(subset=['description', 'account_code'])
        df['description'] = df['description'].astype(str).str.strip()
        df['account_code'] = df['account_code'].astype(str).str.strip()

        if 'merchant_name' in df.columns:
            df['merchant_name'] = df['merchant_name'].fillna('').astype(str).str.strip()

        if 'amount' in df.columns:
            df['amount'] = pd.to_numeric(df['amount'], errors='coerce').fillna(0)
        else:
            df['amount'] = 0

        # 학습 데이터 저장
        classifier = AIClassifierService()
        saved_count = 0
        error_count = 0

        for _, row in df.iterrows():
            try:
                # 계정과목 확인
                account_result = await db.execute(
                    select(Account).where(Account.code == row['account_code'])
                )
                account = account_result.scalar_one_or_none()

                if not account:
                    # 계정과목이 없으면 6자리로 시도
                    code_padded = str(row['account_code']).zfill(6)
                    account_result = await db.execute(
                        select(Account).where(Account.code == code_padded)
                    )
                    account = account_result.scalar_one_or_none()

                if account:
                    training_data = AITrainingData(
                        description_tokens=classifier._preprocess_text(
                            row['description'],
                            row.get('merchant_name', '')
                        ),
                        merchant_name=row.get('merchant_name', ''),
                        amount_range=classifier._get_amount_range(Decimal(str(row['amount']))),
                        account_id=account.id,
                        account_code=account.code,
                        source_type="historical",
                        dataset_version="douzone_import",
                        sample_weight=Decimal("1.0"),
                        is_active=True
                    )
                    db.add(training_data)
                    saved_count += 1
                else:
                    error_count += 1

            except Exception as e:
                error_count += 1
                continue

        await db.commit()

        return {
            "status": "success",
            "total_rows": len(df),
            "saved_count": saved_count,
            "error_count": error_count,
            "message": f"{saved_count}개의 학습 데이터가 저장되었습니다."
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"파일 처리 중 오류: {str(e)}")


@router.post("/train")
async def train_model(
    min_samples: int = Query(default=50, description="최소 학습 샘플 수"),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """AI 모델 학습/재학습"""
    # 관리자 권한 확인
    if current_user.role_id not in [1, 2]:  # 관리자 또는 재무담당자
        raise HTTPException(status_code=403, detail="모델 학습 권한이 없습니다.")

    classifier = AIClassifierService()
    success, message = await classifier.retrain_model(db, current_user.id, min_samples)

    if not success:
        raise HTTPException(status_code=400, detail=message)

    return {
        "status": "success",
        "message": message
    }


@router.post("/classify")
async def classify_transactions(
    request: ClassifyRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """거래 내역 분류"""
    classifier = AIClassifierService()
    await classifier.load_model(db)

    results = []

    for item in request.items:
        classification = await classifier.classify(
            db=db,
            description=item.description,
            merchant_name=item.merchant_name,
            amount=item.amount,
            transaction_time=item.transaction_time
        )

        results.append({
            "id": item.id,
            "original": {
                "description": item.description,
                "merchant_name": item.merchant_name,
                "amount": float(item.amount),
                "transaction_date": item.transaction_date
            },
            "classification": classification
        })

    return {
        "status": "success",
        "count": len(results),
        "results": results
    }


@router.post("/classify-file")
async def classify_file(
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    엑셀 파일 자동 분류

    엑셀 파일 형식:
    - 적요 (필수)
    - 거래처명 (선택)
    - 금액 (선택)
    - 거래일자 (선택)
    """
    if not file.filename.endswith(('.xlsx', '.xls', '.csv')):
        raise HTTPException(status_code=400, detail="엑셀 또는 CSV 파일만 업로드 가능합니다.")

    try:
        content = await file.read()

        if file.filename.endswith('.csv'):
            df = pd.read_csv(io.BytesIO(content), encoding='utf-8-sig')
        else:
            df = pd.read_excel(io.BytesIO(content))

        # 컬럼명 정규화
        column_mapping = {
            '적요': 'description',
            '거래내역': 'description',
            '내역': 'description',
            '거래처명': 'merchant_name',
            '거래처': 'merchant_name',
            '가맹점': 'merchant_name',
            '금액': 'amount',
            '거래금액': 'amount',
            '거래일자': 'transaction_date',
            '일자': 'transaction_date'
        }

        df.columns = [column_mapping.get(col.strip(), col.strip()) for col in df.columns]

        if 'description' not in df.columns:
            raise HTTPException(status_code=400, detail="'적요' 또는 '거래내역' 컬럼이 필요합니다.")

        # 데이터 정제
        df['description'] = df['description'].fillna('').astype(str).str.strip()
        df = df[df['description'] != '']

        if 'merchant_name' in df.columns:
            df['merchant_name'] = df['merchant_name'].fillna('').astype(str).str.strip()
        else:
            df['merchant_name'] = ''

        if 'amount' in df.columns:
            df['amount'] = pd.to_numeric(df['amount'], errors='coerce').fillna(0)
        else:
            df['amount'] = 0

        # AI 분류 수행
        classifier = AIClassifierService()
        await classifier.load_model(db)

        results = []
        for idx, row in df.iterrows():
            classification = await classifier.classify(
                db=db,
                description=row['description'],
                merchant_name=row.get('merchant_name', ''),
                amount=Decimal(str(row.get('amount', 0)))
            )

            primary = classification.get('primary_prediction', {})
            results.append({
                "row_index": int(idx),
                "description": row['description'],
                "merchant_name": row.get('merchant_name', ''),
                "amount": float(row.get('amount', 0)),
                "predicted_account_code": primary.get('account_code', ''),
                "predicted_account_name": primary.get('account_name', ''),
                "confidence": float(primary.get('confidence_score', 0)),
                "auto_confirm": classification.get('auto_confirm', False),
                "needs_review": classification.get('needs_review', True),
                "alternatives": [
                    {
                        "account_code": alt.get('account_code', ''),
                        "account_name": alt.get('account_name', ''),
                        "confidence": float(alt.get('confidence_score', 0))
                    }
                    for alt in classification.get('alternative_predictions', [])[:2]
                ]
            })

        # 통계
        auto_confirm_count = sum(1 for r in results if r['auto_confirm'])
        needs_review_count = sum(1 for r in results if r['needs_review'])
        avg_confidence = sum(r['confidence'] for r in results) / len(results) if results else 0

        return {
            "status": "success",
            "total_rows": len(results),
            "auto_confirmed": auto_confirm_count,
            "needs_review": needs_review_count,
            "average_confidence": round(avg_confidence, 4),
            "results": results
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"파일 처리 중 오류: {str(e)}")


@router.post("/feedback")
async def submit_feedback(
    request: FeedbackRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """사용자 피드백 제출 (수정된 분류)"""
    classifier = AIClassifierService()
    await classifier.load_model(db)

    success_count = 0
    error_count = 0

    for item in request.items:
        try:
            # 계정과목 조회
            predicted_result = await db.execute(
                select(Account).where(Account.code == item.predicted_account_code)
            )
            predicted_account = predicted_result.scalar_one_or_none()

            actual_result = await db.execute(
                select(Account).where(Account.code == item.actual_account_code)
            )
            actual_account = actual_result.scalar_one_or_none()

            if predicted_account and actual_account:
                await classifier.record_feedback(
                    db=db,
                    voucher_id=None,
                    description=item.description,
                    merchant_name=item.merchant_name,
                    amount=item.amount,
                    predicted_account_id=predicted_account.id,
                    actual_account_id=actual_account.id,
                    user_id=current_user.id,
                    correction_reason=item.correction_reason
                )
                success_count += 1
            else:
                error_count += 1

        except Exception as e:
            error_count += 1
            continue

    return {
        "status": "success",
        "submitted": success_count,
        "errors": error_count,
        "message": f"{success_count}개의 피드백이 저장되었습니다."
    }


@router.get("/download-results")
async def download_classification_results(
    results: str = Query(..., description="분류 결과 JSON"),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """분류 결과 엑셀 다운로드"""
    try:
        data = json.loads(results)

        df = pd.DataFrame([
            {
                '적요': r.get('description', ''),
                '거래처명': r.get('merchant_name', ''),
                '금액': r.get('amount', 0),
                '분류 계정코드': r.get('predicted_account_code', ''),
                '분류 계정명': r.get('predicted_account_name', ''),
                '신뢰도': f"{r.get('confidence', 0) * 100:.1f}%",
                '자동확정': '예' if r.get('auto_confirm') else '아니오',
                '검토필요': '예' if r.get('needs_review') else '아니오'
            }
            for r in data
        ])

        output = io.BytesIO()
        with pd.ExcelWriter(output, engine='openpyxl') as writer:
            df.to_excel(writer, index=False, sheet_name='분류결과')

        output.seek(0)

        filename = f"classification_results_{datetime.now().strftime('%Y%m%d_%H%M%S')}.xlsx"

        return StreamingResponse(
            output,
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": f"attachment; filename={filename}"}
        )

    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="잘못된 결과 데이터 형식입니다.")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"다운로드 중 오류: {str(e)}")


@router.get("/template")
async def download_template(
    template_type: str = Query(default="historical", description="템플릿 타입: historical 또는 classify"),
    current_user: User = Depends(get_current_user)
):
    """학습/분류용 템플릿 다운로드"""
    if template_type == "historical":
        df = pd.DataFrame({
            '적요': ['스타벅스 코엑스점', '택시비 (강남->여의도)', '네이버 광고비'],
            '거래처명': ['스타벅스', '카카오택시', '네이버'],
            '금액': [15000, 25000, 500000],
            '계정과목코드': ['813100', '813300', '813600'],
            '계정과목명': ['복리후생비', '여비교통비', '광고선전비']
        })
        filename = "historical_data_template.xlsx"
    else:
        df = pd.DataFrame({
            '적요': ['스타벅스 코엑스점', '택시비', '구글 광고비'],
            '거래처명': ['스타벅스', '카카오택시', '구글'],
            '금액': [15000, 25000, 300000],
            '거래일자': ['2024-01-15', '2024-01-15', '2024-01-16']
        })
        filename = "classify_template.xlsx"

    output = io.BytesIO()
    with pd.ExcelWriter(output, engine='openpyxl') as writer:
        df.to_excel(writer, index=False, sheet_name='데이터')

    output.seek(0)

    return StreamingResponse(
        output,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f"attachment; filename={filename}"}
    )


@router.get("/training-history")
async def get_training_history(
    limit: int = Query(default=10, description="조회 개수"),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """학습 이력 조회"""
    result = await db.execute(
        select(AIModelVersion)
        .order_by(AIModelVersion.created_at.desc())
        .limit(limit)
    )
    versions = result.scalars().all()

    return [
        {
            "version": v.version,
            "model_type": v.model_type,
            "training_samples": v.training_samples,
            "accuracy": float(v.accuracy) if v.accuracy else None,
            "precision": float(v.precision) if v.precision else None,
            "recall": float(v.recall) if v.recall else None,
            "f1_score": float(v.f1_score) if v.f1_score else None,
            "is_active": v.is_active,
            "trained_at": v.training_completed_at.isoformat() if v.training_completed_at else None,
            "created_at": v.created_at.isoformat()
        }
        for v in versions
    ]
