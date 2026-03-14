"""
Smart Finance Core - AI 계정 분류 API
더존 과거 데이터 학습 및 자동 분류 기능
"""
import asyncio
import json
import io
import logging
import traceback
from datetime import datetime
from decimal import Decimal
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, Integer
import pandas as pd

from sqlalchemy import case as sa_case

logger = logging.getLogger(__name__)

# 학습 진행 상태 추적 (in-memory)
_training_progress: dict = {
    "status": "idle",  # idle, running, completed, failed
    "step": "",
    "progress": 0,      # 0~100
    "message": "",
    "started_at": None,
    "completed_at": None,
}

from app.core.database import get_db, async_session_factory
from app.core.security import get_current_user
from app.models.user import User
from app.models.accounting import Account, AccountCategory, AccountCodeMapping
from app.models.ai import AIClassificationLog, AITrainingData, AIModelVersion
from app.services.ai_classifier import AIClassifierService

router = APIRouter(prefix="/ai-classification", tags=["AI 분류"])

# 백그라운드 태스크 참조 보관 (GC 방지) + 동시 업로드 제한
_background_tasks: set = set()
_MAX_CONCURRENT_UPLOADS = 1


# ============ 계정별 원장 파싱 헬퍼 ============

def _is_account_ledger_format(df_raw: pd.DataFrame) -> bool:
    """더존/ERP '계정별 원장' 양식인지 감지"""
    import re
    if df_raw.shape[0] < 3:
        return False
    # 1차: 첫 8행에서 "계정별 원장" 텍스트 검색 (공백 제거 후)
    for r in range(min(8, df_raw.shape[0])):
        for c in range(df_raw.shape[1]):
            cell = df_raw.iloc[r, c]
            if pd.notna(cell):
                normalized = str(cell).replace(" ", "").strip()
                if "계정별" in normalized and "원장" in normalized:
                    return True
    # 2차: [코드] 계정명 패턴 + 날짜/차변/대변 헤더가 있으면 원장으로 판단
    has_account_header = False
    has_table_header = False
    for r in range(min(15, df_raw.shape[0])):
        for c in range(df_raw.shape[1]):
            cell = df_raw.iloc[r, c]
            if pd.notna(cell):
                cell_str = str(cell).strip()
                if re.search(r'\[\d{1,6}\]\s*.+', cell_str):
                    has_account_header = True
                normalized = cell_str.replace(" ", "")
                if normalized == "날짜":
                    has_table_header = True
        if has_account_header and has_table_header:
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
    current_account_name = None
    header_row_idx = None
    col_map = {}  # column index -> field name
    ledger_year = None  # 기간 행에서 추출한 연도

    # 먼저 기간 행에서 연도 추출 (예: "2025.01.01 ~ 2025.12.31")
    for r in range(min(5, df_raw.shape[0])):
        for c in range(df_raw.shape[1]):
            cell = df_raw.iloc[r, c]
            if pd.notna(cell):
                year_match = re.search(r'(20\d{2})\s*[./-]', str(cell))
                if year_match:
                    ledger_year = year_match.group(1)
                    break
        if ledger_year:
            break

    for idx in range(df_raw.shape[0]):
        row_vals = [df_raw.iloc[idx, c] if c < df_raw.shape[1] else None for c in range(df_raw.shape[1])]

        # 계정 헤더 감지: "[코드] 계정명" 패턴 찾기
        for cell in row_vals:
            if pd.notna(cell):
                cell_str = str(cell).strip()
                match = re.search(r'\[(\d{1,6})\]\s*(.+)', cell_str)
                if match:
                    current_account_code = match.group(1).strip()
                    current_account_name = match.group(2).strip()
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

        # 날짜 추출 (연도 없으면 기간 행의 연도 추가)
        date_val = None
        for c_idx, field_name in col_map.items():
            if field_name == "date" and c_idx < len(row_vals) and pd.notna(row_vals[c_idx]):
                raw_date = str(row_vals[c_idx]).strip()
                # "01-15" 또는 "01.15" 형식이면 연도 추가
                if raw_date and ledger_year and not re.match(r'^\d{4}', raw_date):
                    date_val = f"{ledger_year}-{raw_date.replace('.', '-')}"
                else:
                    date_val = raw_date
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
            "원장계정명": current_account_name or "",
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

    # 업로드 통계
    from app.models.ai import AIDataUploadHistory, AIRawTransactionData, UploadStatus
    upload_count = await db.scalar(
        select(func.count(AIDataUploadHistory.id))
    ) or 0
    completed_uploads = await db.scalar(
        select(func.count(AIDataUploadHistory.id)).where(
            AIDataUploadHistory.status == UploadStatus.COMPLETED
        )
    ) or 0
    total_raw_rows = await db.scalar(
        select(func.count(AIRawTransactionData.id))
    ) or 0
    # 최근 업로드
    latest_upload_result = await db.execute(
        select(AIDataUploadHistory)
        .order_by(AIDataUploadHistory.created_at.desc())
        .limit(1)
    )
    latest_upload = latest_upload_result.scalar_one_or_none()

    return {
        "model_version": active_model.version if active_model else "default_v1.0",
        "is_trained": active_model is not None,
        "training_samples": max(training_count or 0, total_raw_rows or 0),
        "total_classifications": stats.total or 0,
        "correct_classifications": stats.correct or 0,
        "corrected_classifications": stats.corrected or 0,
        "accuracy_rate": round(accuracy_rate, 2),
        "last_trained_at": active_model.training_completed_at.isoformat() if active_model and active_model.training_completed_at else None,
        "model_accuracy": float(active_model.accuracy) if active_model and active_model.accuracy else None,
        # 업로드 통계
        "upload_count": upload_count,
        "completed_uploads": completed_uploads,
        "total_raw_transactions": total_raw_rows,
        "latest_upload": {
            "id": latest_upload.id,
            "filename": latest_upload.filename,
            "row_count": latest_upload.row_count,
            "saved_count": latest_upload.saved_count,
            "status": latest_upload.status.value if hasattr(latest_upload.status, 'value') else str(latest_upload.status),
            "created_at": latest_upload.created_at.isoformat() if latest_upload.created_at else None,
        } if latest_upload else None,
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


def _parse_file_sync(content: bytes, filename: str, upload_id: int):
    """동기 함수: 엑셀/CSV 파싱 (별도 스레드에서 실행)"""
    is_ledger_format = False
    all_sheets = None
    ledger_dfs = []
    normal_dfs = []
    sheet_errors = []

    if filename.endswith('.csv'):
        df = pd.read_csv(io.BytesIO(content), encoding='utf-8-sig')
    else:
        engine = 'xlrd' if filename.endswith('.xls') else 'openpyxl'
        all_sheets = pd.read_excel(io.BytesIO(content), header=None, engine=engine, sheet_name=None)
        logger.info(f"[BG Upload {upload_id}] 시트 수: {len(all_sheets)}")

        for sheet_name, df_raw in all_sheets.items():
            if df_raw.shape[0] < 2:
                continue
            if _is_account_ledger_format(df_raw):
                is_ledger_format = True
                try:
                    parsed = _parse_account_ledger(df_raw)
                    ledger_dfs.append(parsed)
                except Exception as e:
                    sheet_errors.append(f"시트 '{sheet_name}': {str(e)[:100]}")
            else:
                normal_dfs.append(pd.read_excel(
                    io.BytesIO(content), engine=engine, sheet_name=sheet_name
                ))

        if ledger_dfs:
            df = pd.concat(ledger_dfs, ignore_index=True)
        elif normal_dfs:
            df = pd.concat(normal_dfs, ignore_index=True)
        else:
            error_detail = "유효한 데이터가 있는 시트를 찾을 수 없습니다."
            if sheet_errors:
                error_detail += " 오류: " + "; ".join(sheet_errors)
            return {"error": error_detail}

    # 컬럼명 정규화
    column_mapping = {
        '적요': 'description', '적요란': 'description',
        '거래내역': 'description', '내역': 'description',
        '거래처명': 'merchant_name', '거래처': 'merchant_name',
        '가맹점': 'merchant_name',
        '금액': 'amount', '거래금액': 'amount',
        '계정과목코드': 'account_code', '계정코드': 'account_code',
        '계정과목': 'account_code', '코드': 'account_code',
        '계정과목명': 'account_name', '계정명': 'account_name',
        '차변': 'debit', '대변': 'credit', '날짜': 'date',
        '원장계정코드': 'source_account_code', '원장계정명': 'source_account_name',
    }

    original_columns = list(df.columns)
    df.columns = [column_mapping.get(str(col).strip(), str(col).strip()) for col in df.columns]
    logger.info(f"[BG Upload {upload_id}] 컬럼: {original_columns} → {list(df.columns)}, 행수(정제전): {len(df)}")

    if 'description' not in df.columns:
        return {"error": f"'적요' 컬럼 없음. 현재 컬럼: {original_columns}"}
    if 'account_code' not in df.columns:
        return {"error": f"'계정과목코드' 컬럼 없음. 현재 컬럼: {original_columns}"}

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

    logger.info(f"[BG Upload {upload_id}] 파싱 완료: {len(df)}행")

    return {
        "df": df,
        "is_ledger_format": is_ledger_format,
        "all_sheets": all_sheets,
        "ledger_dfs": ledger_dfs,
        "normal_dfs": normal_dfs,
        "sheet_errors": sheet_errors,
    }


async def _process_upload_background(upload_id: int, content: bytes, filename: str, user_id: int):
    """백그라운드에서 대용량 파일 처리 (자체 DB 세션 사용)"""
    from app.models.ai import AIDataUploadHistory, AIRawTransactionData, UploadStatus
    from sqlalchemy import insert as sa_insert
    from collections import Counter

    logger.info(f"[BG Upload {upload_id}] 백그라운드 처리 시작: {filename} ({len(content)} bytes)")

    # Step 1: 파일 파싱 (별도 스레드 - 이벤트루프 블로킹 방지)
    try:
        parse_result = await asyncio.to_thread(_parse_file_sync, content, filename, upload_id)
    except Exception as e:
        logger.error(f"[BG Upload {upload_id}] 파싱 스레드 오류: {e}")
        async with async_session_factory() as db:
            upload_history = await db.get(AIDataUploadHistory, upload_id)
            if upload_history:
                upload_history.status = UploadStatus.FAILED
                upload_history.error_message = f"파일 파싱 실패: {str(e)[:400]}"
                await db.commit()
        return

    if "error" in parse_result:
        async with async_session_factory() as db:
            upload_history = await db.get(AIDataUploadHistory, upload_id)
            if upload_history:
                upload_history.status = UploadStatus.FAILED
                upload_history.error_message = parse_result["error"][:500]
                await db.commit()
        return

    df = parse_result["df"]
    is_ledger_format = parse_result["is_ledger_format"]
    all_sheets = parse_result["all_sheets"]
    ledger_dfs = parse_result["ledger_dfs"]
    normal_dfs = parse_result["normal_dfs"]
    sheet_errors = parse_result["sheet_errors"]

    # Step 2: DB 작업 (파싱 완료 후 세션 열기)
    async with async_session_factory() as db:
        try:
            upload_history = await db.get(AIDataUploadHistory, upload_id)
            if not upload_history:
                logger.error(f"[BG Upload {upload_id}] 업로드 이력을 찾을 수 없음")
                return

            upload_history.row_count = len(df)
            await db.flush()
            logger.info(f"[BG Upload {upload_id}] row_count 업데이트: {len(df)}")

            # Phase A: 계정코드 준비
            saved_count = 0
            error_count = 0
            auto_created_count = 0

            unique_codes = df['account_code'].unique().tolist()
            has_source_code = 'source_account_code' in df.columns
            has_source_name = 'source_account_name' in df.columns
            source_name_map = {}
            if has_source_code:
                source_codes_unique = df['source_account_code'].dropna().unique().tolist()
                if has_source_name:
                    for _, row in df.drop_duplicates('source_account_code').iterrows():
                        sc = str(row.get('source_account_code', '')).strip()
                        sn = str(row.get('source_account_name', '')).strip()
                        if sc and sn:
                            source_name_map[sc] = sn
                for sc in source_codes_unique:
                    sc = str(sc).strip()
                    if sc and sc not in unique_codes:
                        unique_codes.append(sc)

            existing_accounts_result = await db.execute(
                select(Account).where(Account.is_active == True)
            )
            account_cache = {a.code: a for a in existing_accounts_result.scalars().all()}

            existing_mappings_result = await db.execute(
                select(AccountCodeMapping).where(AccountCodeMapping.source_system == "douzone")
            )
            mapping_cache = {m.source_code: m for m in existing_mappings_result.scalars().all()}

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

            desc_patterns: dict = {}
            for _, row in df.iterrows():
                code = row['account_code']
                if code not in desc_patterns:
                    desc_patterns[code] = []
                desc_patterns[code].append(row['description'])

            logger.info(f"[BG Upload {upload_id}] Phase A: {len(unique_codes)}개 고유 계정코드")

            for code in unique_codes:
                code = str(code).strip()
                if code in account_cache:
                    continue
                code_padded = code.zfill(6)
                if code_padded in account_cache:
                    account_cache[code] = account_cache[code_padded]
                    continue
                if code in mapping_cache and mapping_cache[code].target_account_id:
                    mapped_id = mapping_cache[code].target_account_id
                    for a in account_cache.values():
                        if a.id == mapped_id:
                            account_cache[code] = a
                            break
                    if code in account_cache:
                        continue

                acct_name = None
                if has_source_code and has_source_name and code in source_name_map:
                    acct_name = source_name_map[code]
                if not acct_name:
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

            await db.flush()
            logger.info(f"[BG Upload {upload_id}] Phase A 완료: {auto_created_count}개 계정 자동생성")

            # Phase B: Bulk Insert (원본 데이터만 - 학습 데이터는 모델 학습 시 자동 생성)
            BATCH_SIZE = 2000
            rows_list = df.to_dict('records')
            has_debit = 'debit' in df.columns
            has_credit = 'credit' in df.columns
            has_date = 'date' in df.columns
            has_account_name = 'account_name' in df.columns

            logger.info(f"[BG Upload {upload_id}] Phase B: {len(rows_list)}행, batch={BATCH_SIZE}")

            for batch_start in range(0, len(rows_list), BATCH_SIZE):
                batch = rows_list[batch_start:batch_start + BATCH_SIZE]
                raw_bulk = []

                for i, row in enumerate(batch):
                    row_idx = batch_start + i + 1
                    code = str(row['account_code']).strip()[:20]
                    desc_val = str(row['description'])[:500]
                    merchant_val = str(row.get('merchant_name', '') or '')[:200]

                    raw_bulk.append({
                        "upload_id": upload_id,
                        "row_number": row_idx,
                        "original_description": desc_val,
                        "merchant_name": merchant_val,
                        "amount": float(row.get('amount', 0)),
                        "debit_amount": float(row['debit']) if has_debit and pd.notna(row.get('debit')) else 0.0,
                        "credit_amount": float(row['credit']) if has_credit and pd.notna(row.get('credit')) else 0.0,
                        "transaction_date": str(row['date']) if has_date and pd.notna(row.get('date')) else None,
                        "account_code": code,
                        "account_name": str(row['account_name']).strip()[:100] if has_account_name and pd.notna(row.get('account_name')) else None,
                        "source_account_code": str(row['source_account_code'])[:20] if has_source_code and pd.notna(row.get('source_account_code')) else None,
                    })

                    if account_cache.get(code):
                        saved_count += 1
                    else:
                        error_count += 1

                if raw_bulk:
                    await db.execute(sa_insert(AIRawTransactionData), raw_bulk)
                await db.flush()

                if batch_start % 10000 == 0:
                    logger.info(f"[BG Upload {upload_id}] 진행: {batch_start + len(batch)}/{len(rows_list)}")

            # 완료 처리
            upload_history.saved_count = saved_count
            upload_history.error_count = error_count
            upload_history.status = UploadStatus.COMPLETED

            is_csv = filename.endswith('.csv')
            if is_csv:
                total_sheets = 1
                sheets_processed = 1
            else:
                total_sheets = len(all_sheets) if all_sheets else 1
                sheets_processed = len(ledger_dfs) if is_ledger_format else len(normal_dfs)

            upload_history.error_message = None

            logger.info(f"[BG Upload {upload_id}] 커밋: saved={saved_count}, error={error_count}, raw={len(rows_list)}")
            await db.commit()
            logger.info(f"[BG Upload {upload_id}] 완료!")

        except Exception as e:
            error_detail = f"{str(e)[:300]}\n{traceback.format_exc()[-200:]}"
            logger.error(f"[BG Upload {upload_id}] DB 처리 오류: {error_detail}")
            try:
                await db.rollback()
                upload_history = await db.get(AIDataUploadHistory, upload_id)
                if upload_history:
                    upload_history.status = UploadStatus.FAILED
                    upload_history.error_message = error_detail[:500]
                    await db.commit()
            except Exception as e2:
                logger.error(f"[BG Upload {upload_id}] 오류 상태 저장 실패: {e2}")


@router.post("/upload-historical")
async def upload_historical_data(
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    더존 과거 데이터 업로드 (학습용) - 백그라운드 처리
    파일을 수신하고 즉시 응답, 처리는 백그라운드에서 진행
    """
    if not file.filename.endswith(('.xlsx', '.xls', '.csv')):
        raise HTTPException(status_code=400, detail="엑셀 또는 CSV 파일만 업로드 가능합니다.")

    from app.models.ai import AIDataUploadHistory, UploadStatus

    try:
        # 동시 업로드 제한
        active_tasks = len(_background_tasks)
        if active_tasks >= _MAX_CONCURRENT_UPLOADS:
            raise HTTPException(
                status_code=429,
                detail=f"현재 {active_tasks}개 업로드가 처리 중입니다. 완료 후 다시 시도해주세요."
            )

        # 이전 PROCESSING 상태 업로드 정리 (10분 이상 지난 것)
        from datetime import timedelta
        cutoff = datetime.utcnow() - timedelta(minutes=10)
        stale_result = await db.execute(
            select(AIDataUploadHistory).where(
                AIDataUploadHistory.status == UploadStatus.PROCESSING,
                AIDataUploadHistory.created_at < cutoff
            )
        )
        for stale in stale_result.scalars().all():
            stale.status = UploadStatus.FAILED
            stale.error_message = "시간 초과로 자동 정리됨"
            logger.info(f"[Upload] 오래된 PROCESSING 업로드 정리: ID={stale.id}")
        await db.flush()

        content = await file.read()
        logger.info(f"[Upload] 파일 읽기 완료: {file.filename} ({len(content)} bytes)")

        # 업로드 이력 생성 (PROCESSING 상태로 즉시 커밋)
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
        upload_id = upload_history.id
        await db.commit()

        logger.info(f"[Upload {upload_id}] 업로드 접수 완료, 백그라운드 처리 시작: {file.filename}")

        # 백그라운드 태스크 시작 (별도 DB 세션 사용, 참조 보관으로 GC 방지)
        task = asyncio.create_task(
            _process_upload_background(upload_id, content, file.filename, current_user.id)
        )
        _background_tasks.add(task)

        def _task_done(t):
            _background_tasks.discard(t)
            if t.exception():
                logger.error(f"[Upload {upload_id}] 백그라운드 태스크 예외: {t.exception()}")
            else:
                logger.info(f"[Upload {upload_id}] 백그라운드 태스크 정상 종료")

        task.add_done_callback(_task_done)

        return {
            "status": "processing",
            "upload_id": upload_id,
            "message": f"파일 '{file.filename}'이 접수되었습니다. 백그라운드에서 처리 중입니다.",
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[Upload] 엔드포인트 오류: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"업로드 접수 실패: {str(e)[:200]}")


@router.get("/upload-status/{upload_id}")
async def get_upload_status(
    upload_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """업로드 처리 상태 조회 (폴링용)"""
    from app.models.ai import AIDataUploadHistory

    # 캐시된 결과 방지 - 최신 상태를 DB에서 직접 읽기
    result = await db.execute(
        select(AIDataUploadHistory).where(AIDataUploadHistory.id == upload_id)
    )
    upload = result.scalar_one_or_none()
    if not upload:
        raise HTTPException(status_code=404, detail="업로드를 찾을 수 없습니다.")

    return {
        "upload_id": upload.id,
        "status": upload.status.value if hasattr(upload.status, 'value') else str(upload.status),
        "filename": upload.filename,
        "row_count": upload.row_count or 0,
        "saved_count": upload.saved_count or 0,
        "error_count": upload.error_count or 0,
        "error_message": upload.error_message,
    }


class BatchUploadRow(BaseModel):
    description: str
    account_code: str
    merchant_name: str = ""
    amount: float = 0
    debit: float = 0
    credit: float = 0
    date: Optional[str] = None
    account_name: Optional[str] = None
    source_account_code: Optional[str] = None
    source_account_name: Optional[str] = None


class BatchUploadRequest(BaseModel):
    upload_id: Optional[int] = None
    filename: str
    file_size: int = 0
    batch_index: int
    total_batches: int
    total_rows: int = 0
    all_account_codes: Optional[List[str]] = None  # 첫 배치에서만 전송
    rows: List[BatchUploadRow]


@router.post("/ping")
async def ping_test():
    """POST 연결 테스트"""
    return {"ok": True, "ts": datetime.utcnow().isoformat()}


@router.post("/upload-historical-batch")
async def upload_historical_batch(
    data: BatchUploadRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """배치 데이터 수신 - 초경량: 업로드 이력 생성 + raw INSERT만"""
    from app.models.ai import AIDataUploadHistory, AIRawTransactionData, UploadStatus
    from sqlalchemy import insert as sa_insert

    logger.info(f"[Batch] 수신: batch={data.batch_index}, rows={len(data.rows)}, upload_id={data.upload_id}")

    try:
        # 첫 배치: 업로드 이력 생성
        if data.batch_index == 0 and not data.upload_id:
            file_ext = data.filename.rsplit('.', 1)[-1].lower() if '.' in data.filename else 'unknown'
            upload_history = AIDataUploadHistory(
                filename=data.filename,
                file_size=data.file_size,
                file_type=file_ext,
                upload_type="historical",
                uploaded_by=current_user.id,
                status=UploadStatus.PROCESSING,
                row_count=data.total_rows,
            )
            db.add(upload_history)
            await db.flush()
            upload_id = upload_history.id
            logger.info(f"[Batch {upload_id}] 새 업로드 생성: {data.filename}")
        else:
            upload_id = data.upload_id
            if not upload_id:
                raise HTTPException(status_code=400, detail="upload_id 필요")
            upload_history = await db.get(AIDataUploadHistory, upload_id)
            if not upload_history:
                raise HTTPException(status_code=404, detail="업로드 없음")

        # 순수 raw INSERT만 (계정 조회/생성 없음)
        raw_bulk = []
        for i, row in enumerate(data.rows):
            raw_bulk.append({
                "upload_id": upload_id,
                "row_number": data.batch_index * 500 + i + 1,
                "original_description": row.description[:500],
                "merchant_name": (row.merchant_name or '')[:200],
                "amount": row.amount or 0,
                "debit_amount": row.debit or 0,
                "credit_amount": row.credit or 0,
                "transaction_date": row.date if row.date else None,
                "account_code": row.account_code.strip()[:20],
                "account_name": (row.account_name or '')[:100] if row.account_name else None,
                "source_account_code": row.source_account_code[:20] if row.source_account_code else None,
                "source_account_name": (row.source_account_name or '')[:100] if row.source_account_name else None,
            })

        if raw_bulk:
            await db.execute(sa_insert(AIRawTransactionData), raw_bulk)

        upload_history.saved_count = (upload_history.saved_count or 0) + len(raw_bulk)

        is_last = data.batch_index >= data.total_batches - 1
        if is_last:
            upload_history.status = UploadStatus.COMPLETED
            upload_history.error_message = None
            logger.info(f"[Batch {upload_id}] 전체 완료! saved={upload_history.saved_count}")

        await db.commit()
        logger.info(f"[Batch {upload_id}] batch {data.batch_index} 저장 완료: {len(raw_bulk)}행")

        return {
            "upload_id": upload_id,
            "batch_index": data.batch_index,
            "saved_count": len(raw_bulk),
            "status": "completed" if is_last else "processing",
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[Batch] 오류: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"배치 오류: {str(e)[:200]}")


@router.post("/train")
async def train_model(
    min_samples: int = Query(default=50, description="최소 학습 샘플 수"),
    max_samples: Optional[int] = Query(default=None, description="최대 학습 샘플 수 (None=전체)"),
    upload_ids: Optional[str] = Query(default=None, description="특정 업로드 ID들 (쉼표 구분)"),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """AI 모델 학습/재학습 (백그라운드)"""
    global _training_progress

    if _training_progress["status"] == "running":
        raise HTTPException(status_code=409, detail="이미 학습이 진행 중입니다.")

    # 즉시 상태 설정
    _training_progress = {
        "status": "running",
        "step": "초기화",
        "progress": 0,
        "message": "학습을 시작합니다...",
        "started_at": datetime.utcnow().isoformat(),
        "completed_at": None,
    }

    parsed_upload_ids = None
    if upload_ids:
        try:
            parsed_upload_ids = [int(x.strip()) for x in upload_ids.split(",") if x.strip()]
        except ValueError:
            pass

    user_id = current_user.id

    async def _run_training():
        global _training_progress
        try:
            async with async_session_factory() as session:
                classifier = AIClassifierService()
                success, message = await classifier.retrain_model_with_progress(
                    session, user_id, min_samples, _training_progress,
                    max_samples=max_samples, upload_ids=parsed_upload_ids,
                )
                if success:
                    _training_progress["status"] = "completed"
                    _training_progress["progress"] = 100
                    _training_progress["message"] = message
                else:
                    _training_progress["status"] = "failed"
                    _training_progress["message"] = message
                _training_progress["completed_at"] = datetime.utcnow().isoformat()
        except Exception as e:
            logger.error(f"[Train] 백그라운드 학습 오류: {e}", exc_info=True)
            _training_progress["status"] = "failed"
            _training_progress["message"] = f"학습 오류: {str(e)[:200]}"
            _training_progress["completed_at"] = datetime.utcnow().isoformat()

    asyncio.create_task(_run_training())

    return {
        "status": "started",
        "message": "학습이 백그라운드에서 시작되었습니다. 진행 상태를 확인해주세요."
    }


@router.get("/train-progress")
async def get_training_progress(
    current_user: User = Depends(get_current_user)
):
    """학습 진행 상태 조회"""
    return _training_progress


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
        await classifier.load_known_merchants(db)

        results = []
        for idx, row in df.iterrows():
            classification = await classifier.classify(
                db=db,
                description=row['description'],
                merchant_name=row.get('merchant_name', ''),
                amount=Decimal(str(row.get('amount', 0)))
            )

            primary = classification.get('primary_prediction', {})
            review_reasons = classification.get('review_reasons', [])
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
                "review_reasons": review_reasons,
                "reasoning": classification.get('reasoning', ''),
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

        # 검토 사유별 통계
        reason_counts: dict = {}
        for r in results:
            for reason in r.get('review_reasons', []):
                reason_counts[reason] = reason_counts.get(reason, 0) + 1

        return {
            "status": "success",
            "total_rows": len(results),
            "auto_confirmed": auto_confirm_count,
            "needs_review": needs_review_count,
            "average_confidence": round(avg_confidence, 4),
            "review_reason_counts": reason_counts,
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


@router.delete("/upload/{upload_id}")
async def delete_upload(
    upload_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """업로드 데이터 삭제 (원본 거래 데이터 + 업로드 이력)"""
    from app.models.ai import AIDataUploadHistory

    upload = await db.get(AIDataUploadHistory, upload_id)
    if not upload:
        raise HTTPException(status_code=404, detail="업로드 이력을 찾을 수 없습니다.")

    filename = upload.filename
    row_count = upload.saved_count or upload.row_count or 0

    # cascade="all, delete-orphan" 설정으로 raw_transactions 자동 삭제
    await db.delete(upload)
    await db.commit()

    return {
        "status": "success",
        "message": f"'{filename}' 삭제 완료 ({row_count}건의 거래 데이터 삭제됨)"
    }


@router.delete("/data-by-year/{year}")
async def delete_data_by_year(
    year: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """특정 연도의 모든 업로드 데이터 삭제"""
    from app.models.ai import AIDataUploadHistory, AIRawTransactionData

    # 해당 연도 업로드 이력 조회
    result = await db.execute(
        select(AIDataUploadHistory).where(
            AIDataUploadHistory.user_id == current_user.id,
            func.extract('year', AIDataUploadHistory.uploaded_at).cast(Integer) == year
        )
    )
    uploads = result.scalars().all()

    if not uploads:
        raise HTTPException(status_code=404, detail=f"{year}년 데이터가 없습니다.")

    total_deleted = 0
    file_count = len(uploads)
    for upload in uploads:
        total_deleted += upload.saved_count or upload.row_count or 0
        await db.delete(upload)

    await db.commit()

    return {
        "status": "success",
        "message": f"{year}년 데이터 삭제 완료 ({file_count}개 파일, {total_deleted:,}건)"
    }


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
