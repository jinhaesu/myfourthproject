"""
Smart Finance Core - AI Classifier Service
AI 기반 계정과목 자동 분류 엔진 (Active Learning Core)
"""
import json
import re
from datetime import datetime
from decimal import Decimal
from typing import Optional, List, Tuple
from pathlib import Path

import joblib
import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.ensemble import RandomForestClassifier
from sklearn.preprocessing import LabelEncoder
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, text

from app.core.config import settings
from app.models.accounting import Account
from app.models.ai import AIClassificationLog, AITrainingData, AIModelVersion, CustomTag


class AIClassifierService:
    """
    AI 기반 계정과목 분류 서비스
    - 자연어 처리(NLP)를 이용한 적요 분석
    - 신뢰도 점수 기반 자동 확정/검토 필요 판단
    - 사용자 피드백 기반 재학습 (Active Learning)
    """

    def __init__(self):
        self.model = None
        self.vectorizer = None
        self.label_encoder = None
        self.model_version = None
        self.account_mapping = {}
        self._loaded = False

    async def load_model(self, db: AsyncSession):
        """모델 로드"""
        if self._loaded:
            return

        model_path = Path(settings.AI_MODEL_PATH)

        # 현재 활성 모델 버전 조회
        result = await db.execute(
            select(AIModelVersion).where(
                AIModelVersion.is_active == True
            ).order_by(AIModelVersion.created_at.desc())
        )
        model_version = result.scalar_one_or_none()

        if model_version and Path(model_version.model_path).exists():
            self.model = joblib.load(f"{model_version.model_path}/classifier.joblib")
            self.vectorizer = joblib.load(f"{model_version.model_path}/vectorizer.joblib")
            self.label_encoder = joblib.load(f"{model_version.model_path}/label_encoder.joblib")
            self.model_version = model_version.version
        else:
            # 기본 모델 생성
            await self._create_default_model(db)

        # 계정과목 매핑 로드
        result = await db.execute(
            select(Account).where(Account.is_active == True, Account.is_detail == True)
        )
        accounts = result.scalars().all()
        self.account_mapping = {acc.id: {"code": acc.code, "name": acc.name} for acc in accounts}

        self._loaded = True

    async def _create_default_model(self, db: AsyncSession):
        """기본 모델 생성 (초기 학습 데이터 기반)"""
        # 기본 학습 데이터
        default_training_data = [
            # 복리후생비
            ("스타벅스", "복리후생비", "813100"),
            ("이디야커피", "복리후생비", "813100"),
            ("투썸플레이스", "복리후생비", "813100"),
            ("팀 회식", "복리후생비", "813100"),
            ("직원 간식", "복리후생비", "813100"),
            ("야근 식대", "복리후생비", "813100"),

            # 접대비
            ("거래처 식사", "접대비", "813200"),
            ("고객사 미팅", "접대비", "813200"),
            ("바이어 접대", "접대비", "813200"),
            ("VIP 고객 선물", "접대비", "813200"),

            # 여비교통비
            ("택시비", "여비교통비", "813300"),
            ("KTX", "여비교통비", "813300"),
            ("출장 교통비", "여비교통비", "813300"),
            ("주차비", "여비교통비", "813300"),
            ("고속도로 통행료", "여비교통비", "813300"),

            # 통신비
            ("KT 통신료", "통신비", "813400"),
            ("SKT 요금", "통신비", "813400"),
            ("인터넷 요금", "통신비", "813400"),

            # 소모품비
            ("사무용품", "소모품비", "813500"),
            ("문구류", "소모품비", "813500"),
            ("복사용지", "소모품비", "813500"),
            ("토너 카트리지", "소모품비", "813500"),

            # 광고선전비
            ("네이버 광고", "광고선전비", "813600"),
            ("구글 애드워즈", "광고선전비", "813600"),
            ("페이스북 광고", "광고선전비", "813600"),
            ("전단지 제작", "광고선전비", "813600"),

            # 지급수수료
            ("송금 수수료", "지급수수료", "813700"),
            ("카드 수수료", "지급수수료", "813700"),
            ("중개 수수료", "지급수수료", "813700"),

            # 교육훈련비
            ("직원 교육", "교육훈련비", "813800"),
            ("세미나 참가비", "교육훈련비", "813800"),
            ("온라인 강의", "교육훈련비", "813800"),

            # 도서인쇄비
            ("도서 구입", "도서인쇄비", "813900"),
            ("명함 인쇄", "도서인쇄비", "813900"),
            ("회사 소개서", "도서인쇄비", "813900"),

            # 회의비
            ("회의실 대여", "회의비", "814000"),
            ("회의 다과", "회의비", "814000"),
            ("프로젝터 대여", "회의비", "814000"),
        ]

        texts = [item[0] for item in default_training_data]
        labels = [item[2] for item in default_training_data]  # account code

        self.vectorizer = TfidfVectorizer(
            analyzer='char_wb',
            ngram_range=(2, 4),
            max_features=5000
        )
        X = self.vectorizer.fit_transform(texts)

        self.label_encoder = LabelEncoder()
        y = self.label_encoder.fit_transform(labels)

        self.model = RandomForestClassifier(
            n_estimators=100,
            max_depth=10,
            random_state=42,
            class_weight='balanced'
        )
        self.model.fit(X, y)

        self.model_version = "default_v1.0"

        # 모델 저장
        model_path = Path(settings.AI_MODEL_PATH) / self.model_version
        model_path.mkdir(parents=True, exist_ok=True)

        joblib.dump(self.model, model_path / "classifier.joblib")
        joblib.dump(self.vectorizer, model_path / "vectorizer.joblib")
        joblib.dump(self.label_encoder, model_path / "label_encoder.joblib")

    def _preprocess_text(self, text: str, merchant_name: Optional[str] = None) -> str:
        """텍스트 전처리"""
        # 정규화
        text = text.lower()
        text = re.sub(r'[0-9]+', ' ', text)  # 숫자 제거
        text = re.sub(r'[^\w\s가-힣]', ' ', text)  # 특수문자 제거
        text = re.sub(r'\s+', ' ', text).strip()

        if merchant_name:
            merchant_name = merchant_name.lower()
            merchant_name = re.sub(r'[^\w\s가-힣]', ' ', merchant_name)
            text = f"{text} {merchant_name}"

        return text

    def _get_time_category(self, transaction_time: Optional[str]) -> str:
        """시간대 카테고리 반환"""
        if not transaction_time:
            return "unknown"

        try:
            hour = int(transaction_time.split(":")[0])
            if 6 <= hour < 11:
                return "morning"
            elif 11 <= hour < 14:
                return "lunch"
            elif 14 <= hour < 18:
                return "afternoon"
            elif 18 <= hour < 22:
                return "evening"
            else:
                return "night"
        except (ValueError, IndexError):
            return "unknown"

    def _get_amount_range(self, amount: Decimal) -> str:
        """금액 범위 카테고리 반환"""
        amount_float = float(amount)
        if amount_float < 10000:
            return "very_low"
        elif amount_float < 50000:
            return "low"
        elif amount_float < 200000:
            return "medium"
        elif amount_float < 1000000:
            return "high"
        else:
            return "very_high"

    async def classify(
        self,
        db: AsyncSession,
        description: str,
        merchant_name: Optional[str] = None,
        merchant_category: Optional[str] = None,
        amount: Decimal = Decimal("0"),
        transaction_time: Optional[str] = None,
        top_n: int = 5
    ) -> dict:
        """
        계정과목 분류 수행

        Returns:
            {
                "primary_prediction": {...},
                "alternative_predictions": [...],
                "auto_confirm": bool,
                "needs_review": bool,
                "reasoning": str,
                "suggested_tags": [...],
                "model_version": str
            }
        """
        await self.load_model(db)

        # 텍스트 전처리
        processed_text = self._preprocess_text(description, merchant_name)

        # 특징 추출
        X = self.vectorizer.transform([processed_text])

        # 예측
        probabilities = self.model.predict_proba(X)[0]
        top_indices = np.argsort(probabilities)[::-1][:top_n]

        predictions = []
        for idx in top_indices:
            account_code = self.label_encoder.inverse_transform([idx])[0]
            confidence = float(probabilities[idx])

            # 계정과목 정보 조회
            result = await db.execute(
                select(Account).where(Account.code == account_code)
            )
            account = result.scalar_one_or_none()

            if account:
                predictions.append({
                    "account_id": account.id,
                    "account_code": account.code,
                    "account_name": account.name,
                    "confidence_score": Decimal(str(round(confidence, 4)))
                })

        primary_confidence = float(predictions[0]["confidence_score"]) if predictions else 0

        # 자동 확정/검토 필요 판단
        auto_confirm = primary_confidence >= settings.AI_AUTO_CONFIRM_THRESHOLD
        needs_review = primary_confidence < settings.AI_REVIEW_REQUIRED_THRESHOLD

        # 추론 근거 생성
        reasoning = self._generate_reasoning(
            description, merchant_name, amount, transaction_time,
            predictions[0] if predictions else None, primary_confidence
        )

        # 커스텀 태그 추천
        suggested_tags = await self._suggest_custom_tags(db, description, merchant_name)

        return {
            "primary_prediction": predictions[0] if predictions else None,
            "alternative_predictions": predictions[1:],
            "auto_confirm": auto_confirm,
            "needs_review": needs_review,
            "reasoning": reasoning,
            "suggested_tags": suggested_tags,
            "model_version": self.model_version
        }

    def _generate_reasoning(
        self,
        description: str,
        merchant_name: Optional[str],
        amount: Decimal,
        transaction_time: Optional[str],
        prediction: Optional[dict],
        confidence: float
    ) -> str:
        """AI 판단 근거 생성"""
        if not prediction:
            return "분류 정보 없음"

        reasons = []

        # 적요 기반 판단
        reasons.append(f"적요 '{description}'")

        if merchant_name:
            reasons.append(f"가맹점 '{merchant_name}'")

        # 시간대 기반 판단
        time_cat = self._get_time_category(transaction_time)
        if time_cat in ["lunch", "evening"] and "복리후생비" in prediction.get("account_name", ""):
            reasons.append("식사 시간대 거래")
        elif time_cat == "night" and "접대비" in prediction.get("account_name", ""):
            reasons.append("야간 시간대 거래")

        # 금액 기반 판단
        amount_range = self._get_amount_range(amount)
        if amount_range == "very_high" and "접대비" in prediction.get("account_name", ""):
            reasons.append("고액 지출")

        confidence_level = "높은" if confidence >= 0.85 else "중간" if confidence >= 0.6 else "낮은"

        return f"{', '.join(reasons)} 분석 결과 [{prediction.get('account_name')}]으로 분류됨 (신뢰도: {confidence_level} {confidence:.1%})"

    async def _suggest_custom_tags(
        self,
        db: AsyncSession,
        description: str,
        merchant_name: Optional[str]
    ) -> List[str]:
        """커스텀 태그 추천"""
        suggested = []

        # 활성 커스텀 태그 조회
        result = await db.execute(
            select(CustomTag).where(
                CustomTag.is_active == True
            )
        )
        custom_tags = result.scalars().all()

        search_text = f"{description} {merchant_name or ''}".lower()

        for tag in custom_tags:
            if tag.ai_keywords:
                keywords = json.loads(tag.ai_keywords) if isinstance(tag.ai_keywords, str) else tag.ai_keywords
                for keyword in keywords:
                    if keyword.lower() in search_text:
                        suggested.append(tag.code)
                        break

        return list(set(suggested))

    async def record_feedback(
        self,
        db: AsyncSession,
        voucher_id: Optional[int],
        description: str,
        merchant_name: Optional[str],
        amount: Decimal,
        predicted_account_id: int,
        actual_account_id: int,
        user_id: int,
        correction_reason: Optional[str] = None,
        custom_tags: Optional[List[str]] = None
    ) -> int:
        """
        사용자 피드백 기록 (Active Learning)
        """
        # 기존 분류 로그 조회 또는 생성
        log = AIClassificationLog(
            voucher_id=voucher_id,
            description=description,
            merchant_name=merchant_name,
            amount=amount,
            predicted_account_id=predicted_account_id,
            confidence_score=Decimal("0"),  # 피드백이므로 confidence는 0으로
            actual_account_id=actual_account_id,
            classification_result=(
                "correct" if predicted_account_id == actual_account_id else "corrected"
            ),
            corrected_by=user_id if predicted_account_id != actual_account_id else None,
            corrected_at=datetime.utcnow() if predicted_account_id != actual_account_id else None,
            correction_reason=correction_reason,
            custom_tags=json.dumps(custom_tags) if custom_tags else None,
            model_version=self.model_version or "unknown"
        )

        db.add(log)
        await db.flush()

        # 학습 데이터에 추가
        account = await db.get(Account, actual_account_id)
        if account:
            training_data = AITrainingData(
                description_tokens=self._preprocess_text(description, merchant_name),
                merchant_name=merchant_name,
                amount_range=self._get_amount_range(amount),
                account_id=actual_account_id,
                account_code=account.code,
                source_type="user_feedback",
                source_id=log.id,
                dataset_version="feedback_v1",
                sample_weight=Decimal("1.5")  # 사용자 피드백은 가중치 높게
            )
            db.add(training_data)

        await db.commit()

        return log.id

    async def retrain_model(
        self,
        db: AsyncSession,
        user_id: int,
        min_samples: int = 100
    ) -> Tuple[bool, str]:
        """
        모델 재학습

        Returns:
            (success, message)
        """
        # 학습 데이터 조회
        result = await db.execute(
            select(AITrainingData).where(AITrainingData.is_active == True)
        )
        training_data = result.scalars().all()

        if len(training_data) < min_samples:
            return False, f"학습 데이터가 부족합니다. (현재: {len(training_data)}, 필요: {min_samples})"

        # 데이터 준비
        texts = []
        labels = []
        weights = []

        for data in training_data:
            text = data.description_tokens
            if data.merchant_name:
                text += f" {data.merchant_name}"
            texts.append(text)
            labels.append(data.account_code)
            weights.append(float(data.sample_weight))

        # 벡터화
        new_vectorizer = TfidfVectorizer(
            analyzer='char_wb',
            ngram_range=(2, 4),
            max_features=5000
        )
        X = new_vectorizer.fit_transform(texts)

        # 라벨 인코딩
        new_label_encoder = LabelEncoder()
        y = new_label_encoder.fit_transform(labels)

        # 모델 학습
        new_model = RandomForestClassifier(
            n_estimators=200,
            max_depth=15,
            random_state=42,
            class_weight='balanced'
        )
        new_model.fit(X, y, sample_weight=np.array(weights))

        # 새 버전 생성
        new_version = f"v{datetime.utcnow().strftime('%Y%m%d_%H%M%S')}"
        model_path = Path(settings.AI_MODEL_PATH) / new_version
        model_path.mkdir(parents=True, exist_ok=True)

        # 모델 저장
        joblib.dump(new_model, model_path / "classifier.joblib")
        joblib.dump(new_vectorizer, model_path / "vectorizer.joblib")
        joblib.dump(new_label_encoder, model_path / "label_encoder.joblib")

        # 정확도 계산 (간단한 교차 검증)
        from sklearn.model_selection import cross_val_score
        scores = cross_val_score(new_model, X, y, cv=5)
        accuracy = float(np.mean(scores))

        # 이전 버전 비활성화
        await db.execute(
            text("UPDATE ai_model_versions SET is_active = FALSE WHERE is_active = TRUE")
        )

        # 새 버전 등록
        model_version_record = AIModelVersion(
            version=new_version,
            model_type="random_forest",
            training_samples=len(training_data),
            training_started_at=datetime.utcnow(),
            training_completed_at=datetime.utcnow(),
            accuracy=Decimal(str(round(accuracy, 4))),
            model_path=str(model_path),
            is_active=True,
            is_production=True,
            created_by=user_id
        )
        db.add(model_version_record)
        await db.commit()

        # 현재 인스턴스 업데이트
        self.model = new_model
        self.vectorizer = new_vectorizer
        self.label_encoder = new_label_encoder
        self.model_version = new_version

        return True, f"모델 재학습 완료. 버전: {new_version}, 정확도: {accuracy:.2%}"
