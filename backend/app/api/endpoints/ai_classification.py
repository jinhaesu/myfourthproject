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

from sqlalchemy import case as sa_case

from app.core.database import get_db
from app.core.security import get_current_user
from app.models.user import User
from app.models.accounting import Account, AccountCategory, AccountCodeMapping
from app.models.ai import AIClassificationLog, AITrainingData, AIModelVersion
from app.services.ai_classifier import AIClassifierService

router = APIRouter(prefix="/ai-classification", tags=["AI 분류"])


# ============ 계정별 원장 파싱 헬퍼 ============

def _is_account_ledger_format(df_raw: pd.DataFrame) -> bool:
    """더존/ERP '계정별 원장' 양식인지 감지"""
    if df_raw.shape[0] < 8:
        return False
    # 첫 몇 행의 모든 셀에서 "계정별 원장" 패턴 검색 (공백 제거 후)
    for r in range(min(3, df_raw.shape[0])):
        for c in range(df_raw.shape[1]):
            cell = df_raw.iloc[r, c]
            if pd.notna(cell):
                normalized = str(cell).replace(" ", "").strip()
                if "계정별" in normalized and "원장" in normalized:
                    return True
    return False


def _parse_account_ledger(df_raw: pd.DataFrame) -> pd.DataFrame:
    """
    '계정별 원장' 양식 파싱
    구조:
      Row 0: "계정별 원장"
      Row 2: 기간 (예: 2025.01.01 ~ 2025.12.31)
      Row 4: 회사명 ... [코드] 계정과목명
      Row 6: 헤더 (날짜, 적요란, 코드, 거래처, 차변, 대변, 잔액)
      Row 7: 전기이월
      Row 8+: 거래 데이터
      여러 계정이 연속되어 나올 수 있음
    """
    import re

    rows = []
    current_account_code = None
    header_row_idx = None
    col_map = {}  # column index -> field name

    for idx in range(df_raw.shape[0]):
        row_vals = [df_raw.iloc[idx, c] if c < df_raw.shape[1] else None for c in range(df_raw.shape[1])]

        # 계정 헤더 감지: "[코드] 계정명" 패턴 찾기
        for cell in row_vals:
            if pd.notna(cell):
                cell_str = str(cell).strip()
                match = re.search(r'\[(\d+)\]\s*(.+)', cell_str)
                if match:
                    current_account_code = match.group(1).strip()
                    break

        # 헤더 행 감지: "날짜" 컬럼 (공백 제거 후 비교)
        first_val = str(row_vals[0]).replace(" ", "").strip() if pd.notna(row_vals[0]) else ""
        if first_val == "날짜":
            header_row_idx = idx
            # 컬럼 매핑 구축
            col_map = {}
            for c_idx, val in enumerate(row_vals):
                if pd.notna(val):
                    col_name = str(val).replace(" ", "").strip()
                    if col_name == "날짜":
                        col_map[c_idx] = "date"
                    elif col_name in ("적요란", "적요"):
                        col_map[c_idx] = "description"
                    elif col_name == "코드":
                        col_map[c_idx] = "code"
                    elif col_name in ("거래처", "거래처명"):
                        col_map[c_idx] = "merchant"
                    elif col_name == "차변":
                        col_map[c_idx] = "debit"
                    elif col_name == "대변":
                        col_map[c_idx] = "credit"
                    elif col_name == "잔액":
                        col_map[c_idx] = "balance"
            continue

        if header_row_idx is None or not col_map:
            continue

        # 데이터 행 파싱: 전기이월, 월계, 누계, 빈 행 건너뛰기
        desc_val = None
        for c_idx, field_name in col_map.items():
            if field_name == "description" and c_idx < len(row_vals):
                desc_val = row_vals[c_idx]
                break

        if desc_val is None or pd.isna(desc_val):
            continue

        desc_str = str(desc_val).strip()
        if desc_str in ("", "전기이월", "전월이월", "월계", "누계", "합계", "이월잔액"):
            continue

        # 코드 필드 추출
        code_val = None
        merchant_val = None
        debit_val = 0
        credit_val = 0

        for c_idx, field_name in col_map.items():
            if c_idx >= len(row_vals):
                continue
            val = row_vals[c_idx]
            if field_name == "code" and pd.notna(val):
                code_val = str(val).strip()
            elif field_name == "merchant" and pd.notna(val):
                merchant_val = str(val).strip()
            elif field_name == "debit" and pd.notna(val):
                try:
                    debit_val = float(val)
                except (ValueError, TypeError):
                    debit_val = 0
            elif field_name == "credit" and pd.notna(val):
                try:
                    credit_val = float(val)
                except (ValueError, TypeError):
                    credit_val = 0

        # 날짜 추출
        date_val = None
        for c_idx, field_name in col_map.items():
            if field_name == "date" and c_idx < len(row_vals) and pd.notna(row_vals[c_idx]):
                date_val = str(row_vals[c_idx]).strip()
                break

        # account_code: 코드 열 사용 (상대 계정), 없으면 현재 계정 코드 사용
        account_code = code_val if code_val else current_account_code
        if not account_code:
            continue

        amount = debit_val if debit_val > 0 else credit_val

        rows.append({
            "적요란": desc_str,
            "거래처": merchant_val or "",
            "금액": amount,
            "코드": account_code,
            "차변": debit_val,
            "대변": credit_val,
            "날짜": date_val or "",
            "원장계정코드": current_account_code or "",
        })

    if not rows:
        raise ValueError("계정별 원장에서 유효한 거래 데이터를 찾을 수 없습니다.")

    return pd.DataFrame(rows)


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
    from app.models.ai import ClassificationResult
    log_stats = await db.execute(
        select(
            func.count(AIClassificationLog.id).label("total"),
            func.sum(
                sa_case(
                    (AIClassificationLog.classification_result == ClassificationResult.CORRECT, 1),
                    else_=0
                )
            ).label("correct"),
            func.sum(
                sa_case(
                    (AIClassificationLog.classification_result == ClassificationResult.CORRECTED, 1),
                    else_=0
                )
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

    from app.models.ai import AIDataUploadHistory, AIRawTransactionData, UploadStatus

    content = await file.read()

    # Step 1: 업로드 이력 생성
    file_ext = file.filename.rsplit('.', 1)[-1].lower() if '.' in file.filename else 'unknown'
    upload_history = AIDataUploadHistory(
        filename=file.filename,
        file_size=len(content),
        file_type=file_ext,
        upload_type="historical",
        uploaded_by=current_user.id,
        status=UploadStatus.PROCESSING,
    )
    db.add(upload_history)
    await db.flush()

    try:
        # Step 2: 파일 파싱
        is_ledger_format = False
        if file.filename.endswith('.csv'):
            df = pd.read_csv(io.BytesIO(content), encoding='utf-8-sig')
        else:
            engine = 'xlrd' if file.filename.endswith('.xls') else 'openpyxl'
            df_raw = pd.read_excel(io.BytesIO(content), header=None, engine=engine)

            if _is_account_ledger_format(df_raw):
                is_ledger_format = True
                df = _parse_account_ledger(df_raw)
            else:
                df = pd.read_excel(io.BytesIO(content), engine=engine)

        # 컬럼명 정규화
        column_mapping = {
            '적요': 'description',
            '적요란': 'description',
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
            '코드': 'account_code',
            '계정과목명': 'account_name',
            '계정명': 'account_name',
            '차변': 'debit',
            '대변': 'credit',
            '날짜': 'date',
            '원장계정코드': 'source_account_code',
        }

        df.columns = [column_mapping.get(str(col).strip(), str(col).strip()) for col in df.columns]

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

        upload_history.row_count = len(df)

        # Step 3: 배치 처리로 학습 데이터 저장 + 원본 데이터 보관
        from collections import Counter
        classifier = AIClassifierService()
        saved_count = 0
        error_count = 0
        auto_created_count = 0

        # ---- Phase A: 모든 고유 계정코드 수집 & 계정 사전 준비 ----
        unique_codes = df['account_code'].unique().tolist()

        # 기존 계정 전체 로드 (캐시)
        existing_accounts_result = await db.execute(
            select(Account).where(Account.is_active == True)
        )
        account_cache = {a.code: a for a in existing_accounts_result.scalars().all()}

        # 기존 매핑 로드
        existing_mappings_result = await db.execute(
            select(AccountCodeMapping).where(
                AccountCodeMapping.source_system == "douzone"
            )
        )
        mapping_cache = {m.source_code: m for m in existing_mappings_result.scalars().all()}

        # 카테고리 로드
        all_categories_result = await db.execute(
            select(AccountCategory).order_by(AccountCategory.code)
        )
        all_categories = {c.code: c for c in all_categories_result.scalars().all()}
        default_category_id = next(iter(all_categories.values())).id if all_categories else 1

        def _guess_category_id(code: str) -> int:
            if not code:
                return default_category_id
            digit_map = {'0': '1', '1': '1', '2': '2', '3': '3', '4': '4',
                         '5': '5', '6': '5', '7': '5', '8': '5', '9': '5'}
            cat_code = digit_map.get(code[0], '5')
            return all_categories[cat_code].id if cat_code in all_categories else default_category_id

        # 누락 계정 코드 일괄 자동 생성
        desc_patterns: dict = {}
        for _, row in df.iterrows():
            code = row['account_code']
            if code not in desc_patterns:
                desc_patterns[code] = []
            desc_patterns[code].append(row['description'])

        for code in unique_codes:
            code = str(code).strip()
            if code in account_cache:
                continue
            # zero-padded 체크
            code_padded = code.zfill(6)
            if code_padded in account_cache:
                account_cache[code] = account_cache[code_padded]
                continue
            # 매핑 체크
            if code in mapping_cache and mapping_cache[code].target_account_id:
                mapped_id = mapping_cache[code].target_account_id
                for a in account_cache.values():
                    if a.id == mapped_id:
                        account_cache[code] = a
                        break
                if code in account_cache:
                    continue

            # 자동 생성
            descs = desc_patterns.get(code, [])
            acct_name = f"더존계정 {code}"
            if descs:
                word_counter = Counter()
                for d in descs[:50]:
                    for w in str(d).split():
                        w = w.strip()
                        if len(w) >= 2:
                            word_counter[w] += 1
                if word_counter:
                    acct_name = f"{word_counter.most_common(1)[0][0]} (더존 {code})"

            account = Account(
                code=code, name=acct_name,
                category_id=_guess_category_id(code),
                level=1, is_detail=True,
                is_vat_applicable=True, vat_rate=Decimal("10.00"), is_active=True,
            )
            db.add(account)
            await db.flush()
            account_cache[code] = account

            if code not in mapping_cache:
                new_mapping = AccountCodeMapping(
                    source_system="douzone", source_code=code,
                    source_name=acct_name,
                    target_account_id=account.id,
                    target_account_code=account.code,
                    is_auto_created=True,
                )
                db.add(new_mapping)
                mapping_cache[code] = new_mapping

            auto_created_count += 1

        # 계정 생성 커밋
        await db.flush()

        # ---- Phase B: 원본 데이터 + 학습 데이터 배치 삽입 ----
        BATCH_SIZE = 500
        rows_list = df.to_dict('records')
        has_debit = 'debit' in df.columns
        has_credit = 'credit' in df.columns
        has_date = 'date' in df.columns
        has_account_name = 'account_name' in df.columns
        has_source_code = 'source_account_code' in df.columns

        for batch_start in range(0, len(rows_list), BATCH_SIZE):
            batch = rows_list[batch_start:batch_start + BATCH_SIZE]

            for i, row in enumerate(batch):
                row_idx = batch_start + i + 1
                code = str(row['account_code']).strip()

                # 원본 데이터
                raw_record = AIRawTransactionData(
                    upload_id=upload_history.id,
                    row_number=row_idx,
                    original_description=row['description'],
                    merchant_name=row.get('merchant_name', '') or '',
                    amount=Decimal(str(row.get('amount', 0))),
                    debit_amount=Decimal(str(row['debit'])) if has_debit and pd.notna(row.get('debit')) else Decimal("0"),
                    credit_amount=Decimal(str(row['credit'])) if has_credit and pd.notna(row.get('credit')) else Decimal("0"),
                    transaction_date=str(row['date']) if has_date and pd.notna(row.get('date')) else None,
                    account_code=code,
                    account_name=str(row['account_name']).strip() if has_account_name and pd.notna(row.get('account_name')) else None,
                    source_account_code=str(row['source_account_code']) if has_source_code and pd.notna(row.get('source_account_code')) else None,
                )
                db.add(raw_record)

                account = account_cache.get(code)
                if account:
                    training_data = AITrainingData(
                        description_tokens=classifier._preprocess_text(
                            row['description'], row.get('merchant_name', '') or ''
                        ),
                        merchant_name=row.get('merchant_name', '') or '',
                        amount_range=classifier._get_amount_range(Decimal(str(row.get('amount', 0)))),
                        account_id=account.id,
                        account_code=account.code,
                        source_type="historical",
                        dataset_version="douzone_import",
                        sample_weight=Decimal("1.0"),
                        is_active=True,
                    )
                    db.add(training_data)
                    saved_count += 1
                else:
                    error_count += 1

            # 배치 단위로 flush
            await db.flush()

        # Step 4: 업로드 이력 완료 처리
        upload_history.saved_count = saved_count
        upload_history.error_count = error_count
        upload_history.status = UploadStatus.COMPLETED

        await db.commit()

        return {
            "status": "success",
            "upload_id": upload_history.id,
            "total_rows": len(df),
            "saved_count": saved_count,
            "error_count": error_count,
            "auto_created_accounts": auto_created_count,
            "message": f"{saved_count}개의 학습 데이터가 저장되었습니다. (원본 {len(df)}건 보관, 자동생성 계정 {auto_created_count}개)"
        }

    except HTTPException:
        upload_history.status = UploadStatus.FAILED
        upload_history.error_message = "필수 컬럼 누락"
        await db.commit()
        raise
    except Exception as e:
        upload_history.status = UploadStatus.FAILED
        upload_history.error_message = str(e)[:500]
        await db.commit()
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
            engine = 'xlrd' if file.filename.endswith('.xls') else 'openpyxl'
            df = pd.read_excel(io.BytesIO(content), engine=engine)

        # 컬럼명 정규화
        column_mapping = {
            '적요': 'description',
            '적요란': 'description',
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

        df.columns = [column_mapping.get(str(col).strip(), str(col).strip()) for col in df.columns]

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


@router.get("/upload-history")
async def get_upload_history(
    limit: int = Query(default=20, description="조회 개수"),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """업로드 이력 조회"""
    from app.models.ai import AIDataUploadHistory

    result = await db.execute(
        select(AIDataUploadHistory)
        .order_by(AIDataUploadHistory.created_at.desc())
        .limit(limit)
    )
    uploads = result.scalars().all()

    return [
        {
            "id": u.id,
            "filename": u.filename,
            "file_size": u.file_size,
            "file_type": u.file_type,
            "upload_type": u.upload_type,
            "row_count": u.row_count,
            "saved_count": u.saved_count,
            "error_count": u.error_count,
            "status": u.status.value if hasattr(u.status, 'value') else str(u.status),
            "error_message": u.error_message,
            "created_at": u.created_at.isoformat() if u.created_at else None,
        }
        for u in uploads
    ]


@router.get("/upload/{upload_id}/raw-data")
async def get_upload_raw_data(
    upload_id: int,
    page: int = Query(default=1, ge=1),
    size: int = Query(default=50, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """업로드된 원본 데이터 조회"""
    from app.models.ai import AIDataUploadHistory, AIRawTransactionData

    # 업로드 이력 확인
    upload = await db.get(AIDataUploadHistory, upload_id)
    if not upload:
        raise HTTPException(status_code=404, detail="업로드 이력을 찾을 수 없습니다.")

    # 총 건수
    total = await db.scalar(
        select(func.count(AIRawTransactionData.id))
        .where(AIRawTransactionData.upload_id == upload_id)
    )

    # 페이지네이션
    offset = (page - 1) * size
    result = await db.execute(
        select(AIRawTransactionData)
        .where(AIRawTransactionData.upload_id == upload_id)
        .order_by(AIRawTransactionData.row_number)
        .offset(offset)
        .limit(size)
    )
    rows = result.scalars().all()

    return {
        "upload_id": upload_id,
        "filename": upload.filename,
        "total_rows": total,
        "page": page,
        "size": size,
        "data": [
            {
                "row_number": r.row_number,
                "description": r.original_description,
                "merchant_name": r.merchant_name,
                "amount": float(r.amount),
                "debit_amount": float(r.debit_amount),
                "credit_amount": float(r.credit_amount),
                "transaction_date": r.transaction_date,
                "account_code": r.account_code,
                "account_name": r.account_name,
                "source_account_code": r.source_account_code,
                "training_data_id": r.training_data_id,
            }
            for r in rows
        ],
    }
