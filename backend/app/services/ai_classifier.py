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
        """모델 로드 (학습 데이터 있으면 자동 학습)"""
        if self._loaded:
            return

        from sqlalchemy import func as sa_func

        model_path = Path(settings.AI_MODEL_PATH)

        # 현재 활성 모델 버전 조회
        result = await db.execute(
            select(AIModelVersion).where(
                AIModelVersion.is_active == True
            ).order_by(AIModelVersion.created_at.desc())
        )
        model_version = result.scalar_one_or_none()

        model_loaded = False

        # 1) DB에 모델 버전 있고 파일도 있으면 로드
        if model_version and Path(model_version.model_path).exists():
            try:
                self.model = joblib.load(f"{model_version.model_path}/classifier.joblib")
                self.vectorizer = joblib.load(f"{model_version.model_path}/vectorizer.joblib")
                self.label_encoder = joblib.load(f"{model_version.model_path}/label_encoder.joblib")
                self.model_version = model_version.version
                model_loaded = True
            except Exception:
                pass

        # 2) 모델 파일 없으면 기본 모델 생성 (블로킹 방지 - 재학습은 /train에서 수동으로)
        if not model_loaded:
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

    async def load_known_merchants(self, db: AsyncSession):
        """학습 데이터에서 기존 거래처명 목록 로드"""
        if hasattr(self, '_known_merchants') and self._known_merchants:
            return
        from sqlalchemy import func as sa_func
        result = await db.execute(
            select(sa_func.distinct(AITrainingData.merchant_name)).where(
                AITrainingData.is_active == True,
                AITrainingData.merchant_name.isnot(None),
                AITrainingData.merchant_name != "",
            )
        )
        self._known_merchants = {
            r[0].lower().strip() for r in result.all() if r[0]
        }

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

        # 검토 사유 생성
        review_reasons = []
        if primary_confidence < 0.4:
            review_reasons.append("신뢰도 매우 낮음")
        elif primary_confidence < settings.AI_REVIEW_REQUIRED_THRESHOLD:
            review_reasons.append("신뢰도 낮음")

        # 1,2순위 예측이 비슷하면 분류 불확실
        if len(predictions) >= 2:
            second_confidence = float(predictions[1]["confidence_score"])
            if primary_confidence - second_confidence < 0.1:
                review_reasons.append("분류 불확실")
                needs_review = True

        # 미확인 거래처 (known_merchants가 설정되어 있으면 확인)
        if merchant_name and hasattr(self, '_known_merchants') and self._known_merchants:
            merchant_lower = merchant_name.lower().strip()
            if merchant_lower and not any(
                known in merchant_lower or merchant_lower in known
                for known in self._known_merchants
            ):
                review_reasons.append("미확인 거래처")
                needs_review = True

        if needs_review and not review_reasons:
            review_reasons.append("검토 권장")

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
            "review_reasons": review_reasons,
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

    async def _generate_training_from_raw(self, db: AsyncSession) -> int:
        """AIRawTransactionData에서 AITrainingData 자동 생성 (아직 변환 안 된 것만)"""
        from app.models.ai import AIRawTransactionData
        from sqlalchemy import insert as sa_insert, func as sa_func
        import logging
        logger = logging.getLogger(__name__)

        # 이미 학습 데이터가 있는 raw 데이터 ID 조회
        existing_raw_ids_q = select(AITrainingData.source_id).where(
            AITrainingData.source_type == "historical",
            AITrainingData.source_id.isnot(None),
        )

        # 아직 학습 데이터로 변환 안 된 raw 데이터 조회
        result = await db.execute(
            select(AIRawTransactionData).where(
                AIRawTransactionData.id.notin_(existing_raw_ids_q)
            )
        )
        raw_rows = result.scalars().all()

        if not raw_rows:
            return 0

        # 계정 캐시
        acct_result = await db.execute(
            select(Account).where(Account.is_active == True)
        )
        acct_cache = {a.code: a for a in acct_result.scalars().all()}

        # 배치로 학습 데이터 생성
        BATCH = 5000
        total_created = 0

        for start in range(0, len(raw_rows), BATCH):
            batch = raw_rows[start:start + BATCH]
            training_bulk = []

            for raw in batch:
                account = acct_cache.get(raw.account_code)
                if not account:
                    continue

                training_bulk.append({
                    "description_tokens": self._preprocess_text(
                        raw.original_description, raw.merchant_name or ''
                    ),
                    "merchant_name": (raw.merchant_name or '')[:200],
                    "amount_range": self._get_amount_range(raw.amount or Decimal("0")),
                    "account_id": account.id,
                    "account_code": account.code,
                    "source_type": "historical",
                    "source_id": raw.id,
                    "dataset_version": "douzone_import",
                    "sample_weight": 1.0,
                    "is_active": True,
                })

            if training_bulk:
                await db.execute(sa_insert(AITrainingData), training_bulk)
                total_created += len(training_bulk)

        if total_created > 0:
            await db.flush()
            logger.info(f"[Train] Raw → Training 변환: {total_created}건 생성")

        return total_created

    async def retrain_model(
        self,
        db: AsyncSession,
        user_id: Optional[int] = None,
        min_samples: int = 100
    ) -> Tuple[bool, str]:
        """
        모델 재학습

        Returns:
            (success, message)
        """
        # Raw 데이터에서 학습 데이터 자동 생성
        generated = await self._generate_training_from_raw(db)

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

    async def retrain_model_with_progress(
        self,
        db: AsyncSession,
        user_id: Optional[int] = None,
        min_samples: int = 100,
        progress: Optional[dict] = None,
        max_samples: Optional[int] = None,
        upload_ids: Optional[list] = None,
    ) -> Tuple[bool, str]:
        """진행 상태를 업데이트하며 모델 재학습"""
        def _update(step: str, pct: int, msg: str):
            if progress:
                progress["step"] = step
                progress["progress"] = pct
                progress["message"] = msg

        _update("데이터 변환", 5, "Raw 데이터에서 학습 데이터를 생성하고 있습니다...")

        # Raw 데이터 → 학습 데이터 변환
        generated = await self._generate_training_from_raw(db)
        _update("데이터 변환", 15, f"Raw 데이터 변환 완료 ({generated}건 새로 생성)")

        # 학습 데이터 조회
        _update("데이터 로드", 20, "학습 데이터를 조회하고 있습니다...")
        query = select(AITrainingData).where(AITrainingData.is_active == True)

        # 특정 업로드만 선택
        if upload_ids:
            from app.models.ai import AIRawTransactionData
            sub = select(AIRawTransactionData.id).where(
                AIRawTransactionData.upload_id.in_(upload_ids)
            )
            query = query.where(
                (AITrainingData.source_type == "historical")
                & (AITrainingData.source_id.in_(sub))
                | (AITrainingData.source_type != "historical")
            )

        result = await db.execute(query)
        training_data = list(result.scalars().all())

        if len(training_data) < min_samples:
            return False, f"학습 데이터가 부족합니다. (현재: {len(training_data)}, 필요: {min_samples})"

        # 최대 샘플 제한
        if max_samples and len(training_data) > max_samples:
            import random
            random.shuffle(training_data)
            training_data = training_data[:max_samples]

        total = len(training_data)
        _update("데이터 준비", 25, f"학습 데이터 {total:,}건 준비 완료. 특성 추출 중...")

        # 데이터 준비
        texts = []
        labels = []
        weights = []
        for i, data in enumerate(training_data):
            text = data.description_tokens
            if data.merchant_name:
                text += f" {data.merchant_name}"
            texts.append(text)
            labels.append(data.account_code)
            weights.append(float(data.sample_weight))
            if i % 5000 == 0 and i > 0:
                pct = 25 + int((i / total) * 15)
                _update("특성 추출", pct, f"데이터 준비 중... ({i:,}/{total:,})")

        _update("벡터화", 45, f"TF-IDF 벡터화 중... ({total:,}건)")

        # 벡터화
        new_vectorizer = TfidfVectorizer(
            analyzer='char_wb',
            ngram_range=(2, 4),
            max_features=5000
        )
        X = new_vectorizer.fit_transform(texts)

        _update("라벨 인코딩", 55, "라벨 인코딩 중...")

        new_label_encoder = LabelEncoder()
        y = new_label_encoder.fit_transform(labels)

        _update("모델 학습", 60, f"Random Forest 학습 중... ({total:,}건, 200 trees)")

        # 모델 학습
        new_model = RandomForestClassifier(
            n_estimators=200,
            max_depth=15,
            random_state=42,
            class_weight='balanced'
        )
        new_model.fit(X, y, sample_weight=np.array(weights))

        _update("교차 검증", 80, "5-fold 교차 검증으로 정확도 평가 중...")

        # 정확도 계산
        from sklearn.model_selection import cross_val_score
        scores = cross_val_score(new_model, X, y, cv=min(5, len(set(y))))
        accuracy = float(np.mean(scores))

        _update("모델 저장", 90, f"정확도: {accuracy:.2%}. 모델 저장 중...")

        # 모델 저장
        new_version = f"v{datetime.utcnow().strftime('%Y%m%d_%H%M%S')}"
        model_path = Path(settings.AI_MODEL_PATH) / new_version
        model_path.mkdir(parents=True, exist_ok=True)

        joblib.dump(new_model, model_path / "classifier.joblib")
        joblib.dump(new_vectorizer, model_path / "vectorizer.joblib")
        joblib.dump(new_label_encoder, model_path / "label_encoder.joblib")

        # DB 업데이트
        await db.execute(
            text("UPDATE ai_model_versions SET is_active = FALSE WHERE is_active = TRUE")
        )
        model_version_record = AIModelVersion(
            version=new_version,
            model_type="random_forest",
            training_samples=total,
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

        self.model = new_model
        self.vectorizer = new_vectorizer
        self.label_encoder = new_label_encoder
        self.model_version = new_version

        _update("완료", 100, f"학습 완료! 버전: {new_version}, 정확도: {accuracy:.2%}, 학습 데이터: {total:,}건")

        return True, f"모델 재학습 완료. 버전: {new_version}, 정확도: {accuracy:.2%}, 학습 데이터: {total:,}건"
