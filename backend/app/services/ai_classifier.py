"""
Smart Finance Core - AI Classifier Service
AI 기반 계정과목 자동 분류 엔진 (Active Learning Core)
- ML 모델 (TF-IDF + RandomForest): 과거 데이터 학습 기반
- LLM (Claude API): ML 신뢰도 낮을 때 보조 분류
"""
import json
import re
import logging
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
from sqlalchemy import select, text as sa_text

from app.core.config import settings
from app.models.accounting import Account
from app.models.ai import AIClassificationLog, AITrainingData, AIModelVersion, CustomTag

logger = logging.getLogger(__name__)

# 표준 계정과목 매핑 (LLM 분류 + ML fallback 공용)
STANDARD_ACCOUNTS = {
    "811000": "급여", "811100": "상여금", "812000": "퇴직급여",
    "813100": "복리후생비", "813200": "접대비", "813300": "여비교통비",
    "813400": "통신비", "813500": "소모품비", "813600": "광고선전비",
    "813700": "지급수수료", "813800": "교육훈련비", "813900": "도서인쇄비",
    "814000": "회의비", "814100": "보험료", "814200": "세금과공과",
    "814300": "감가상각비", "814400": "임차료", "814500": "수선비",
    "814600": "차량유지비", "814700": "운반비", "814800": "수도광열비",
    "814900": "외주용역비", "815000": "지급임차료", "815100": "잡비",
    "510000": "원재료비", "520000": "상품매입", "540000": "외주가공비",
}


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

        # 2) 모델 파일 없으면: DB 학습데이터로 빠른 재학습 시도, 없으면 기본 모델
        if not model_loaded:
            retrained = await self._quick_retrain_from_db(db)
            if not retrained:
                await self._create_default_model(db)

        # 계정과목 매핑 로드
        result = await db.execute(
            select(Account).where(Account.is_active == True, Account.is_detail == True)
        )
        accounts = result.scalars().all()
        self.account_mapping = {acc.id: {"code": acc.code, "name": acc.name} for acc in accounts}

        self._loaded = True

    async def _quick_retrain_from_db(self, db: AsyncSession) -> bool:
        """DB의 학습 데이터로 빠른 재학습 (배포 후 모델 복원용)
        최대 10,000건 샘플링하여 빠르게 학습"""
        try:
            result = await db.execute(
                select(AITrainingData)
                .where(AITrainingData.is_active == True)
                .limit(10000)
            )
            training_data = list(result.scalars().all())

            if len(training_data) < 50:
                logger.info(f"[QuickRetrain] 학습 데이터 부족 ({len(training_data)}건), 기본 모델 사용")
                return False

            texts = []
            labels = []
            for d in training_data:
                t = d.description_tokens or ""
                if d.merchant_name:
                    t += f" {d.merchant_name}"
                if t.strip():
                    texts.append(t)
                    labels.append(d.account_code)

            if len(texts) < 50:
                return False

            self.vectorizer = TfidfVectorizer(
                analyzer='char_wb', ngram_range=(2, 4), max_features=5000
            )
            X = self.vectorizer.fit_transform(texts)

            self.label_encoder = LabelEncoder()
            y = self.label_encoder.fit_transform(labels)

            self.model = RandomForestClassifier(
                n_estimators=100, max_depth=12, random_state=42, class_weight='balanced'
            )
            self.model.fit(X, y)
            self.model_version = f"auto_restored_{len(texts)}"

            # 파일로도 저장 (다음 요청 시 빠르게 로드)
            model_path = Path(settings.AI_MODEL_PATH) / self.model_version
            model_path.mkdir(parents=True, exist_ok=True)
            joblib.dump(self.model, model_path / "classifier.joblib")
            joblib.dump(self.vectorizer, model_path / "vectorizer.joblib")
            joblib.dump(self.label_encoder, model_path / "label_encoder.joblib")

            logger.info(f"[QuickRetrain] DB 학습데이터 {len(texts)}건으로 모델 복원 완료")
            return True
        except Exception as e:
            logger.warning(f"[QuickRetrain] 자동 복원 실패: {e}")
            return False

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

        # 기본 계정코드 → 계정명 매핑 (DB에 없을 때 fallback)
        _default_account_names = {
            "813100": "복리후생비", "813200": "접대비", "813300": "여비교통비",
            "813400": "통신비", "813500": "소모품비", "813600": "광고선전비",
            "813700": "지급수수료", "813800": "교육훈련비", "813900": "도서인쇄비",
            "814000": "회의비",
        }

        predictions = []
        for idx in top_indices:
            account_code = self.label_encoder.inverse_transform([idx])[0]
            confidence = float(probabilities[idx])

            # 계정과목 정보 조회 (DB 우선, 없으면 기본 매핑 사용)
            result = await db.execute(
                select(Account).where(Account.code == account_code)
            )
            account = result.scalar_one_or_none()

            account_name = (
                account.name if account
                else _default_account_names.get(account_code, f"계정 {account_code}")
            )
            predictions.append({
                "account_id": account.id if account else None,
                "account_code": account_code,
                "account_name": account_name,
                "confidence_score": Decimal(str(round(confidence, 4)))
            })

        ml_confidence = float(predictions[0]["confidence_score"]) if predictions else 0

        # ML 신뢰도 낮으면 LLM(Claude) 보조 분류
        llm_used = False
        if ml_confidence < 0.6:
            llm_result = await self._classify_with_llm(description, merchant_name, amount)
            if llm_result and llm_result.get("account_code"):
                llm_code = llm_result["account_code"]
                llm_name = llm_result["account_name"]
                llm_conf = llm_result["confidence"]
                llm_reasoning = llm_result.get("reasoning", "")

                # LLM 결과를 primary prediction으로 교체
                predictions.insert(0, {
                    "account_id": None,
                    "account_code": llm_code,
                    "account_name": llm_name or STANDARD_ACCOUNTS.get(llm_code, f"계정 {llm_code}"),
                    "confidence_score": Decimal(str(round(llm_conf, 4)))
                })
                llm_used = True
                logger.info(f"[Classify] LLM 보조: '{description}' → {llm_code} {llm_name} ({llm_conf:.0%})")

        primary_confidence = float(predictions[0]["confidence_score"]) if predictions else 0

        # 자동 확정/검토 필요 판단
        auto_confirm = primary_confidence >= settings.AI_AUTO_CONFIRM_THRESHOLD
        needs_review = primary_confidence < settings.AI_REVIEW_REQUIRED_THRESHOLD

        # 검토 사유 생성
        review_reasons = []
        if not llm_used and primary_confidence < 0.4:
            review_reasons.append("신뢰도 매우 낮음")
        elif not llm_used and primary_confidence < settings.AI_REVIEW_REQUIRED_THRESHOLD:
            review_reasons.append("신뢰도 낮음")

        if llm_used and primary_confidence < 0.7:
            review_reasons.append("AI 분석 (확인 권장)")
            needs_review = True

        # 1,2순위 예측이 비슷하면 분류 불확실
        if len(predictions) >= 2:
            p1 = float(predictions[0]["confidence_score"])
            p2 = float(predictions[1]["confidence_score"])
            if not llm_used and p1 - p2 < 0.1:
                review_reasons.append("분류 불확실")
                needs_review = True

        # 미확인 거래처
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
        if llm_used and llm_result:
            reasoning = f"[AI 분석] {llm_result.get('reasoning', '')} (ML 모델 신뢰도: {ml_confidence:.0%})"
        else:
            reasoning = self._generate_reasoning(
                description, merchant_name, amount, transaction_time,
                predictions[0] if predictions else None, primary_confidence
            )

        # 커스텀 태그 추천
        suggested_tags = await self._suggest_custom_tags(db, description, merchant_name)

        return {
            "primary_prediction": predictions[0] if predictions else None,
            "alternative_predictions": predictions[1:5],
            "auto_confirm": auto_confirm,
            "needs_review": needs_review,
            "review_reasons": review_reasons,
            "reasoning": reasoning,
            "suggested_tags": suggested_tags,
            "model_version": f"{self.model_version}{'+ LLM' if llm_used else ''}"
        }

    async def _classify_with_llm(
        self,
        description: str,
        merchant_name: Optional[str],
        amount: Decimal,
    ) -> Optional[dict]:
        """Claude API를 이용한 LLM 기반 분류 (ML 신뢰도 낮을 때 사용)"""
        if not settings.ANTHROPIC_API_KEY:
            return None

        try:
            import anthropic
            client = anthropic.Anthropic(api_key=settings.ANTHROPIC_API_KEY)

            account_list = "\n".join(
                f"- {code}: {name}" for code, name in STANDARD_ACCOUNTS.items()
            )

            prompt = f"""당신은 한국 기업 회계 전문가입니다. 신용카드 거래 내역을 보고 적절한 계정과목을 분류해주세요.

## 거래 정보
- 가맹점/적요: {description}
- 거래처명: {merchant_name or '없음'}
- 금액: {amount:,.0f}원

## 사용 가능한 계정과목
{account_list}

## 분류 규칙
- Facebook, Instagram, Google Ads, 네이버 등 온라인 플랫폼 결제 → 광고선전비 (813600)
- 음식점, 카페, 배달 → 복리후생비 (813100) 또는 접대비 (813200)
- 택시, 주유, 톨게이트, 주차 → 여비교통비 (813300) 또는 차량유지비 (814600)
- 사무용품, 문구 → 소모품비 (813500)
- 통신비, 인터넷, 클라우드 서비스 → 통신비 (813400)
- 학원, 교육, 세미나, 수강료 → 교육훈련비 (813800)
- AWS, Azure, 서버 호스팅 → 지급수수료 (813700) 또는 통신비 (813400)
- 보험 → 보험료 (814100)
- 택배, 배송 → 운반비 (814700)
- 임대료, 월세 → 임차료 (814400)

## 응답 형식 (반드시 JSON만 출력)
{{"account_code": "계정코드", "account_name": "계정과목명", "confidence": 0.0~1.0, "reasoning": "분류 근거 한 줄"}}"""

            response = client.messages.create(
                model=settings.ANTHROPIC_MODEL or "claude-sonnet-4-20250514",
                max_tokens=200,
                messages=[{"role": "user", "content": prompt}],
            )

            text = response.content[0].text.strip()
            # JSON 추출 (```json ... ``` 또는 { ... } 형태)
            if "```" in text:
                text = text.split("```")[1]
                if text.startswith("json"):
                    text = text[4:]
                text = text.strip()
            result = json.loads(text)

            code = result.get("account_code", "")
            name = result.get("account_name", "") or STANDARD_ACCOUNTS.get(code, "")
            confidence = min(float(result.get("confidence", 0.8)), 0.95)
            reasoning = result.get("reasoning", "LLM 분석")

            logger.info(f"[LLM] '{description}' → {code} {name} ({confidence:.0%})")
            return {
                "account_code": code,
                "account_name": name,
                "confidence": confidence,
                "reasoning": reasoning,
            }
        except Exception as e:
            logger.warning(f"[LLM] 분류 실패: {e}")
            return None

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
        """AIRawTransactionData에서 AITrainingData 자동 생성 (Account 테이블 의존 없음)"""
        from app.models.ai import AIRawTransactionData
        from sqlalchemy import insert as sa_insert
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

        # Account 테이블 캐시 (있으면 account_id 매핑, 없어도 진행)
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
                # account_code가 없으면 건너뛰기
                if not raw.account_code:
                    continue

                account = acct_cache.get(raw.account_code)

                training_bulk.append({
                    "description_tokens": self._preprocess_text(
                        raw.original_description, raw.merchant_name or ''
                    ),
                    "merchant_name": (raw.merchant_name or '')[:200],
                    "amount_range": self._get_amount_range(raw.amount or Decimal("0")),
                    "account_id": account.id if account else None,
                    "account_code": raw.account_code,
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
            sa_text("UPDATE ai_model_versions SET is_active = FALSE WHERE is_active = TRUE")
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
        db_factory,
        user_id: Optional[int] = None,
        min_samples: int = 100,
        progress: Optional[dict] = None,
        max_samples: Optional[int] = None,
        upload_ids: Optional[list] = None,
    ) -> Tuple[bool, str]:
        """진행 상태를 업데이트하며 모델 재학습

        DB 연결을 3단계로 분리: 로드 → ML(DB없이) → 저장
        Supabase 연결 타임아웃 방지
        """
        def _update(step: str, pct: int, msg: str):
            if progress:
                progress["step"] = step
                progress["progress"] = pct
                progress["message"] = msg

        # ========== 1단계: DB에서 데이터 로드 후 연결 닫기 ==========
        _update("데이터 변환", 5, "Raw 데이터에서 학습 데이터를 생성하고 있습니다...")

        async with db_factory() as db:
            generated = await self._generate_training_from_raw(db)
            await db.commit()

        _update("데이터 변환", 15, f"Raw 데이터 변환 완료 ({generated}건 새로 생성)")
        _update("데이터 로드", 20, "학습 데이터를 조회하고 있습니다...")

        async with db_factory() as db:
            query = select(AITrainingData).where(AITrainingData.is_active == True)

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

            # ORM 객체에서 순수 데이터 추출 (DB 연결 닫기 전에)
            raw_data = []
            for data in training_data:
                raw_data.append({
                    "tokens": data.description_tokens,
                    "merchant": data.merchant_name,
                    "amount": data.amount_range,
                    "account_code": data.account_code,
                    "weight": float(data.sample_weight),
                })

        # DB 연결 닫힌 상태 — 이후 ML 작업은 메모리에서만
        if len(raw_data) < min_samples:
            return False, f"학습 데이터가 부족합니다. (현재: {len(raw_data)}, 필요: {min_samples})"

        if max_samples and len(raw_data) > max_samples:
            import random
            random.shuffle(raw_data)
            raw_data = raw_data[:max_samples]

        total = len(raw_data)
        _update("데이터 준비", 25, f"학습 데이터 {total:,}건 준비 완료. 특성 추출 중...")

        # ========== 2단계: ML 작업 (DB 연결 불필요) ==========
        texts = []
        labels = []
        weights = []
        for i, d in enumerate(raw_data):
            t = d["tokens"]
            if d["merchant"]:
                t += f" {d['merchant']}"
            texts.append(t)
            labels.append(d["account_code"])
            weights.append(d["weight"])

        _update("벡터화", 45, f"TF-IDF 벡터화 중... ({total:,}건)")

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

        new_model = RandomForestClassifier(
            n_estimators=200,
            max_depth=15,
            random_state=42,
            class_weight='balanced'
        )
        new_model.fit(X, y, sample_weight=np.array(weights))

        _update("교차 검증", 80, "교차 검증으로 정확도 평가 중...")

        from sklearn.model_selection import cross_val_score
        n_classes = len(set(y))
        cv_folds = min(5, n_classes) if n_classes > 1 else 2
        scores = cross_val_score(new_model, X, y, cv=cv_folds)
        accuracy = float(np.mean(scores))

        _update("모델 저장", 90, f"정확도: {accuracy:.2%}. 모델 저장 중...")

        new_version = f"v{datetime.utcnow().strftime('%Y%m%d_%H%M%S')}"
        model_path = Path(settings.AI_MODEL_PATH) / new_version
        model_path.mkdir(parents=True, exist_ok=True)

        joblib.dump(new_model, model_path / "classifier.joblib")
        joblib.dump(new_vectorizer, model_path / "vectorizer.joblib")
        joblib.dump(new_label_encoder, model_path / "label_encoder.joblib")

        # ========== 3단계: 새 DB 연결로 결과 저장 ==========
        async with db_factory() as db:
            await db.execute(
                sa_text("UPDATE ai_model_versions SET is_active = FALSE WHERE is_active = TRUE")
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
