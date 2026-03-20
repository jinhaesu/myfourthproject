"""
Smart Finance Core - AI 계정 분류 API
더존 과거 데이터 학습 및 자동 분류 기능
"""
import asyncio
import json
import io
import logging
import time
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor
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

from app.core.config import settings
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

# 분류 진행 상태 추적 (in-memory)
_classify_progress: dict = {
    "status": "idle",  # idle, running, completed, failed
    "step": "",
    "progress": 0,      # 0~100
    "message": "",
    "total_rows": 0,
    "processed_rows": 0,
    "low_confidence_count": 0,
}


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
    """AI 모델 상태 조회 (경량 — 모델 로드 없이 DB 쿼리만)"""
    from app.models.ai import AIDataUploadHistory, AIRawTransactionData, UploadStatus, ClassificationResult

    # 단일 쿼리로 여러 COUNT를 한번에 조회
    counts = await db.execute(
        select(
            func.count(AITrainingData.id).filter(AITrainingData.is_active == True).label("training"),
            func.count(AIClassificationLog.id).label("log_total"),
            func.sum(sa_case(
                (AIClassificationLog.classification_result == ClassificationResult.CORRECT, 1),
                else_=0
            )).label("correct"),
            func.sum(sa_case(
                (AIClassificationLog.classification_result == ClassificationResult.CORRECTED, 1),
                else_=0
            )).label("corrected"),
        )
    )
    c = counts.one()

    # 모델 버전 (가벼운 쿼리)
    model_result = await db.execute(
        select(AIModelVersion)
        .where(AIModelVersion.is_active == True)
        .order_by(AIModelVersion.created_at.desc())
        .limit(1)
    )
    active_model = model_result.scalar_one_or_none()

    accuracy_rate = 0
    if c.log_total and c.log_total > 0:
        accuracy_rate = (c.correct or 0) / c.log_total * 100

    # 업로드 통계 (단일 쿼리)
    upload_counts = await db.execute(
        select(
            func.count(AIDataUploadHistory.id).label("total"),
            func.count(AIDataUploadHistory.id).filter(
                AIDataUploadHistory.status == UploadStatus.COMPLETED
            ).label("completed"),
        )
    )
    uc = upload_counts.one()

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
        "training_samples": max(c.training or 0, total_raw_rows or 0),
        "total_classifications": c.log_total or 0,
        "correct_classifications": c.correct or 0,
        "corrected_classifications": c.corrected or 0,
        "accuracy_rate": round(accuracy_rate, 2),
        "last_trained_at": active_model.training_completed_at.isoformat() if active_model and active_model.training_completed_at else None,
        "model_accuracy": float(active_model.accuracy) if active_model and active_model.accuracy else None,
        "upload_count": uc.total or 0,
        "completed_uploads": uc.completed or 0,
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


@router.get("/standard-accounts")
async def get_standard_accounts(
    current_user: User = Depends(get_current_user)
):
    """시산표 기반 표준 계정과목 목록 (DB 무관, 항상 반환)"""
    from app.services.ai_classifier import STANDARD_ACCOUNTS, EXPENSE_ACCOUNTS

    # 계정 분류 그룹핑
    groups = {
        "1": "자산", "2": "부채/유형자산", "3": "자본",
        "4": "수익/매출원가", "5": "매출원가(제조)", "8": "판관비", "9": "영업외"
    }

    def group_label(code: str) -> str:
        return groups.get(code[0], "기타") if code else "기타"

    return {
        "standard_accounts": [
            {"code": code, "name": name, "group": group_label(code)}
            for code, name in sorted(STANDARD_ACCOUNTS.items())
        ],
        "expense_accounts": [
            {"code": code, "name": name, "group": group_label(code)}
            for code, name in sorted(EXPENSE_ACCOUNTS.items())
        ],
    }


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
            classifier = AIClassifierService()
            success, message = await classifier.retrain_model_with_progress(
                async_session_factory, user_id, min_samples, _training_progress,
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


@router.get("/classify-progress")
async def get_classify_progress(
    current_user: User = Depends(get_current_user)
):
    """분류 진행 상태 조회"""
    return _classify_progress


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

    global _classify_progress
    _classify_progress = {
        "status": "running", "step": "파일 읽기",
        "progress": 5, "message": "파일을 읽고 있습니다...",
        "total_rows": 0, "processed_rows": 0, "low_confidence_count": 0,
    }

    try:
        content = await file.read()

        if file.filename.endswith('.csv'):
            df = pd.read_csv(io.BytesIO(content), encoding='utf-8-sig')
        else:
            engine = 'xlrd' if file.filename.endswith('.xls') else 'openpyxl'
            df = pd.read_excel(io.BytesIO(content), engine=engine)

        # 컬럼명 정규화 (일반 + 위하고 신용카드 매입 형식 지원)
        column_mapping = {
            # 적요/설명
            '적요': 'description', '적요란': 'description',
            '거래내역': 'description', '내역': 'description', '비고': 'description',
            # 거래처/가맹점
            '거래처명': 'merchant_name', '거래처': 'merchant_name',
            '가맹점': 'merchant_name', '가맹점명': 'merchant_name', '상호': 'merchant_name',
            # 금액
            '금액': 'amount', '거래금액': 'amount',
            '매입금액': 'amount', '결제금액': 'amount', '이용금액': 'amount',
            '합계금액': 'amount', '합계': 'amount',
            # 부가세/공급가액
            '부가세': 'vat_amount', '세액': 'vat_amount', 'VAT': 'vat_amount',
            '공급가액': 'supply_amount', '과세표준': 'supply_amount',
            # 날짜
            '거래일자': 'transaction_date', '일자': 'transaction_date',
            '거래일': 'transaction_date', '결제일': 'transaction_date',
            '매입일자': 'transaction_date', '승인일자': 'transaction_date',
            # 카드 관련
            '카드번호': 'card_number', '카드NO': 'card_number', '카드': 'card_number',
            '승인번호': 'approval_number', '승인NO': 'approval_number',
        }

        df.columns = [column_mapping.get(str(col).strip(), str(col).strip()) for col in df.columns]
        logger.info(f"[Classify] 매핑된 컬럼: {list(df.columns)}")

        # 위하고 카드 형식: '적요' 없으면 '가맹점명'을 description으로 사용
        if 'description' not in df.columns:
            if 'merchant_name' in df.columns:
                df['description'] = df['merchant_name']
                logger.info("[Classify] '적요' 없음 → '가맹점명'을 적요로 사용 (카드 형식)")
            else:
                raise HTTPException(
                    status_code=400,
                    detail=f"'적요' 또는 '가맹점명' 컬럼이 필요합니다. 현재 컬럼: {list(df.columns)}"
                )

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

        if 'vat_amount' in df.columns:
            df['vat_amount'] = pd.to_numeric(df['vat_amount'], errors='coerce').fillna(0)
        if 'supply_amount' in df.columns:
            df['supply_amount'] = pd.to_numeric(df['supply_amount'], errors='coerce').fillna(0)

        # AI 분류 수행
        total_rows = len(df)
        _classify_progress.update({
            "step": "모델 로드", "progress": 10,
            "message": f"AI 모델 로딩 중... ({total_rows}행 감지)",
            "total_rows": total_rows,
        })
        classifier = AIClassifierService()
        await classifier.load_model(db)
        await classifier.load_known_merchants(db)

        # 카드 형식 감지
        is_card_format = 'card_number' in df.columns or 'approval_number' in df.columns or 'vat_amount' in df.columns

        # DataFrame → 분류 입력 리스트 변환
        row_meta = []
        for idx, row in df.iterrows():
            desc = row['description']
            merchant = row.get('merchant_name', '') if row.get('merchant_name', '') != desc else ''
            amount = float(row.get('amount', 0))
            vat = float(row.get('vat_amount', 0)) if 'vat_amount' in df.columns else 0
            supply = float(row.get('supply_amount', 0)) if 'supply_amount' in df.columns else 0
            txn_date = ''
            if 'transaction_date' in df.columns and pd.notna(row.get('transaction_date')):
                txn_date = str(row['transaction_date']).strip()
            row_meta.append({
                "idx": int(idx), "desc": desc, "merchant": merchant or desc,
                "amount": amount, "vat": vat, "supply": supply, "txn_date": txn_date,
            })

        # ===== LLM(Claude) 기본 분류기 → ML fallback =====
        llm_used = False
        llm_map: dict = {}  # index → {account_code, account_name, confidence, reasoning}

        if settings.ANTHROPIC_API_KEY:
            _classify_progress.update({
                "step": "AI 분류", "progress": 20,
                "message": f"Claude AI로 {total_rows}건 분류 중...",
            })
            try:
                llm_items = [
                    {"idx": i, "desc": m["desc"], "merchant": m["merchant"], "amount": m["amount"]}
                    for i, m in enumerate(row_meta)
                ]
                llm_results = await classifier.classify_batch_with_llm(llm_items)

                success_count = 0
                for i, llm in enumerate(llm_results):
                    if llm and llm.get("account_code"):
                        llm_map[i] = llm
                        success_count += 1

                llm_used = success_count > 0
                logger.info(f"[Classify] LLM 분류: {success_count}/{total_rows}건 성공")

                _classify_progress.update({
                    "progress": 65,
                    "message": f"AI 분류 완료 ({success_count}/{total_rows}건)",
                })
            except Exception as llm_err:
                logger.warning(f"[Classify] LLM 분류 실패, ML fallback: {llm_err}")
                _classify_progress.update({
                    "step": "ML fallback", "progress": 30,
                    "message": f"AI 분류 실패. ML 모델로 분류 중...",
                })
        else:
            logger.warning("[Classify] ANTHROPIC_API_KEY 미설정 — ML 모델만 사용")

        # LLM 실패한 항목은 ML fallback
        ml_needed_indices = [i for i in range(total_rows) if i not in llm_map]
        if ml_needed_indices:
            _classify_progress.update({
                "step": "ML 분류" if not llm_used else "ML 보충",
                "progress": 70 if llm_used else 20,
                "message": f"ML 모델로 {len(ml_needed_indices)}건 분류 중...",
            })
            ml_items = [
                {"description": row_meta[i]["desc"],
                 "merchant_name": row_meta[i]["merchant"],
                 "amount": row_meta[i]["amount"]}
                for i in ml_needed_indices
            ]
            try:
                ml_results = classifier.classify_batch_ml_pure(ml_items)
            except Exception:
                ml_results = [classifier._empty_classification() for _ in ml_items]

        # 결과 조립
        _classify_progress.update({
            "step": "결과 조립", "progress": 75,
            "message": f"결과 정리 중...",
        })
        results = []
        ml_result_idx = 0

        for i, meta in enumerate(row_meta):
            if i in llm_map:
                # LLM 결과 사용
                llm = llm_map[i]
                debit_code = llm["account_code"]
                debit_name = llm["account_name"]
                confidence = llm["confidence"]
                reasoning = f"[AI 분석] {llm.get('reasoning', '')}"
                review_reasons = ["AI 분석 (확인 권장)"] if confidence < 0.85 else []
                auto_confirm = confidence >= 0.85
                needs_review = confidence < 0.85
            else:
                # ML fallback
                classification = ml_results[ml_result_idx] if ml_needed_indices else classifier._empty_classification()
                ml_result_idx += 1
                primary = classification.get('primary_prediction') or {}
                debit_code = primary.get('account_code', '')
                debit_name = primary.get('account_name', '')
                confidence = float(primary.get('confidence_score', 0))
                reasoning = classification.get('reasoning', '')
                review_reasons = classification.get('review_reasons') or []
                auto_confirm = classification.get('auto_confirm', False)
                needs_review = classification.get('needs_review', True)

            memo = f"{meta['desc']} 카드결제" if is_card_format else meta['desc']

            result_item = {
                "row_index": meta['idx'],
                "description": meta['desc'],
                "merchant_name": meta['merchant'],
                "amount": meta['amount'],
                "transaction_date": meta['txn_date'],
                "memo": memo,
                "predicted_account_code": debit_code,
                "predicted_account_name": debit_name,
                "confidence": confidence,
                "auto_confirm": auto_confirm,
                "needs_review": needs_review,
                "review_reasons": review_reasons,
                "reasoning": reasoning,
                "alternatives": [],
                "journal_entry": {
                    "debit_account_code": debit_code,
                    "debit_account_name": debit_name,
                    "debit_amount": meta['amount'],
                    "credit_account_code": "253",
                    "credit_account_name": "미지급금",
                    "credit_amount": meta['amount'],
                    "vat_amount": meta['vat'],
                    "supply_amount": meta['supply'] if meta['supply'] else meta['amount'] - meta['vat'],
                    "is_balanced": True,
                },
            }
            results.append(result_item)

        # 통계
        _classify_progress.update({
            "step": "결과 저장", "progress": 90,
            "message": f"분류 완료. 결과 저장 중...",
        })
        auto_confirm_count = sum(1 for r in results if r['auto_confirm'])
        needs_review_count = sum(1 for r in results if r['needs_review'])
        avg_confidence = sum(r['confidence'] for r in results) / len(results) if results else 0
        total_amount = sum(r['amount'] for r in results)

        # 검토 사유별 통계
        reason_counts: dict = {}
        for r in results:
            for reason in r.get('review_reasons', []):
                reason_counts[reason] = reason_counts.get(reason, 0) + 1

        # DB에 분류 결과 저장 (새로고침/배포 후에도 유지)
        try:
            from app.models.ai import AIDataUploadHistory, UploadStatus
            upload_history = AIDataUploadHistory(
                filename=file.filename,
                file_size=len(content),
                file_type=file.filename.rsplit('.', 1)[-1] if '.' in file.filename else 'unknown',
                upload_type="classification",
                uploaded_by=current_user.id,
                status=UploadStatus.COMPLETED,
                row_count=len(results),
                saved_count=len(results),
                result_json=json.dumps({
                    "results": results,
                    "stats": {
                        "total_rows": len(results),
                        "auto_confirmed": auto_confirm_count,
                        "needs_review": needs_review_count,
                        "average_confidence": round(avg_confidence, 4),
                        "total_amount": total_amount,
                        "is_card_format": is_card_format,
                        "review_reason_counts": reason_counts,
                    }
                }, ensure_ascii=False, default=str),
            )
            db.add(upload_history)
            await db.flush()
            upload_id = upload_history.id
            logger.info(f"[Classify] 분류 결과 DB 저장 완료 (upload_id={upload_id}, {len(results)}건)")
        except Exception as save_err:
            logger.warning(f"[Classify] 분류 결과 DB 저장 실패 (결과는 정상 반환): {save_err}")
            upload_id = None

        _classify_progress.update({
            "status": "completed", "step": "완료", "progress": 100,
            "message": f"분류 완료! {len(results)}건 (자동확정: {auto_confirm_count}, 검토필요: {needs_review_count})",
            "processed_rows": len(results),
        })

        return {
            "status": "success",
            "upload_id": upload_id,
            "total_rows": len(results),
            "auto_confirmed": auto_confirm_count,
            "needs_review": needs_review_count,
            "average_confidence": round(avg_confidence, 4),
            "total_amount": total_amount,
            "is_card_format": is_card_format,
            "review_reason_counts": reason_counts,
            "results": results,
        }

    except HTTPException:
        _classify_progress.update({"status": "failed", "message": "파일 형식 오류"})
        raise
    except Exception as e:
        _classify_progress.update({
            "status": "failed", "step": "오류",
            "message": f"분류 오류: {str(e)[:200]}",
        })
        raise HTTPException(status_code=500, detail=f"파일 처리 중 오류: {str(e)}")


class JournalEntryItem(BaseModel):
    """확정된 분개 항목"""
    description: str
    merchant_name: Optional[str] = None
    memo: str = ""
    transaction_date: Optional[str] = None
    amount: float
    debit_account_code: str
    debit_account_name: Optional[str] = None
    credit_account_code: str = "253000"
    credit_account_name: Optional[str] = "미지급금(신용카드)"
    vat_amount: float = 0
    supply_amount: float = 0


class ConfirmJournalRequest(BaseModel):
    """분개 확정 요청"""
    entries: List[JournalEntryItem]
    source_filename: Optional[str] = None
    selected_indices: Optional[List[int]] = None


@router.post("/confirm-journal")
async def confirm_journal_entries(
    request: ConfirmJournalRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    확정된 분개를 장부에 반영 (ai_raw_transaction_data에 저장)
    - 차변/대변 각각 한 행씩 저장
    - 재무제표에 바로 반영됨
    """
    from app.models.ai import AIDataUploadHistory, AIRawTransactionData, UploadStatus

    try:
        # selected_indices가 지정된 경우 해당 인덱스만 필터링
        if request.selected_indices is not None:
            # 유효한 인덱스만 필터링
            valid_indices = [
                idx for idx in request.selected_indices
                if 0 <= idx < len(request.entries)
            ]
            if not valid_indices:
                raise HTTPException(
                    status_code=400,
                    detail="유효한 선택 인덱스가 없습니다."
                )
            entries_to_save = [request.entries[idx] for idx in valid_indices]
        else:
            entries_to_save = request.entries

        # 업로드 이력 생성
        upload_history = AIDataUploadHistory(
            filename=request.source_filename or "AI자동분개",
            file_size=0,
            file_type="journal",
            upload_type="journal_entry",
            uploaded_by=current_user.id,
            status=UploadStatus.COMPLETED,
            row_count=len(entries_to_save) * 2,
            saved_count=0,
        )
        db.add(upload_history)
        await db.flush()
        upload_id = upload_history.id

        saved_count = 0
        for i, entry in enumerate(entries_to_save):
            row_base = i * 2 + 1

            # 차변 (비용 계정)
            debit_row = AIRawTransactionData(
                upload_id=upload_id,
                row_number=row_base,
                original_description=entry.memo or entry.description,
                merchant_name=entry.merchant_name or entry.description,
                amount=Decimal(str(entry.amount)),
                debit_amount=Decimal(str(entry.amount)),
                credit_amount=Decimal("0"),
                transaction_date=entry.transaction_date,
                account_code=entry.debit_account_code,
                account_name=entry.debit_account_name,
                source_account_code=entry.credit_account_code,
                source_account_name=entry.credit_account_name,
            )
            db.add(debit_row)

            # 대변 (미지급금)
            credit_row = AIRawTransactionData(
                upload_id=upload_id,
                row_number=row_base + 1,
                original_description=entry.memo or entry.description,
                merchant_name=entry.merchant_name or entry.description,
                amount=Decimal(str(entry.amount)),
                debit_amount=Decimal("0"),
                credit_amount=Decimal(str(entry.amount)),
                transaction_date=entry.transaction_date,
                account_code=entry.credit_account_code,
                account_name=entry.credit_account_name,
                source_account_code=entry.debit_account_code,
                source_account_name=entry.debit_account_name,
            )
            db.add(credit_row)
            saved_count += 2

        upload_history.saved_count = saved_count

        # AI 학습 데이터 자동 저장 (확정된 분개 = 정답 데이터)
        from app.models.ai import AITrainingData
        training_count = 0
        for entry in entries_to_save:
            if entry.debit_account_code and entry.description:
                training_row = AITrainingData(
                    description_tokens=entry.description.lower(),
                    merchant_name=entry.merchant_name,
                    amount_range=(
                        "small" if entry.amount < 50000 else "medium" if entry.amount < 500000 else "large"
                    ),
                    account_code=entry.debit_account_code,
                    source_type="journal_confirm",
                    dataset_version="auto",
                    is_active=True,
                    sample_weight=Decimal("1.50"),
                )
                db.add(training_row)
                training_count += 1

        await db.commit()

        logger.info(f"[Journal] {len(entries_to_save)}건 분개 확정 → {saved_count}행 장부 반영 + {training_count}건 AI 학습 (upload_id={upload_id})")

        return {
            "status": "success",
            "upload_id": upload_id,
            "entries_count": len(entries_to_save),
            "saved_rows": saved_count,
            "training_saved": training_count,
            "message": f"{len(entries_to_save)}건 분개가 장부에 반영되었습니다. ({training_count}건 AI 학습 데이터 저장)",
        }

    except Exception as e:
        logger.error(f"[Journal] 확정 오류: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"분개 확정 오류: {str(e)[:200]}")


@router.delete("/journal/{upload_id}")
async def delete_journal_entries(
    upload_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    반영된 분개 삭제 (journal_entry 타입만)
    - AIDataUploadHistory 삭제 (cascade로 AIRawTransactionData 자동 삭제)
    - 연관된 AITrainingData (source_type="journal_confirm") 삭제
    """
    from app.models.ai import AIDataUploadHistory, AIRawTransactionData, AITrainingData
    from sqlalchemy import delete as sa_delete

    try:
        # 업로드 이력 조회
        upload = await db.get(AIDataUploadHistory, upload_id)
        if not upload:
            raise HTTPException(status_code=404, detail="해당 업로드 이력을 찾을 수 없습니다.")

        # journal_entry 타입만 삭제 가능
        if upload.upload_type != "journal_entry":
            raise HTTPException(
                status_code=400,
                detail=f"journal_entry 타입만 삭제할 수 있습니다. (현재: {upload.upload_type})"
            )

        # 삭제할 AIRawTransactionData 행 수 조회
        raw_count_result = await db.execute(
            select(func.count(AIRawTransactionData.id))
            .where(AIRawTransactionData.upload_id == upload_id)
        )
        raw_count = raw_count_result.scalar() or 0

        # 연관된 AITrainingData 삭제 (source_type="journal_confirm")
        # description_tokens 기반으로 매칭 (해당 upload의 raw 데이터와 연결)
        raw_descriptions_result = await db.execute(
            select(AIRawTransactionData.original_description)
            .where(AIRawTransactionData.upload_id == upload_id)
            .where(AIRawTransactionData.debit_amount > 0)
        )
        raw_descriptions = [row[0].lower() for row in raw_descriptions_result.fetchall()]

        training_deleted = 0
        if raw_descriptions:
            training_count_result = await db.execute(
                select(func.count(AITrainingData.id))
                .where(
                    AITrainingData.source_type == "journal_confirm",
                    AITrainingData.description_tokens.in_(raw_descriptions)
                )
            )
            training_deleted = training_count_result.scalar() or 0

            await db.execute(
                sa_delete(AITrainingData)
                .where(
                    AITrainingData.source_type == "journal_confirm",
                    AITrainingData.description_tokens.in_(raw_descriptions)
                )
            )

        # AIDataUploadHistory 삭제 (cascade로 AIRawTransactionData 자동 삭제)
        await db.delete(upload)
        await db.commit()

        deleted_entries = raw_count // 2  # 차변/대변 쌍이므로 2로 나눔

        logger.info(f"[Journal] 삭제 완료: upload_id={upload_id}, entries={deleted_entries}, raw_rows={raw_count}, training={training_deleted}")

        return {
            "status": "success",
            "deleted_entries": deleted_entries,
            "message": f"분개 {deleted_entries}건이 삭제되었습니다. (장부 {raw_count}행, AI학습 {training_deleted}건 삭제)",
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[Journal] 삭제 오류: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"분개 삭제 오류: {str(e)[:200]}")


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
    limit: int = Query(default=50, description="조회 개수"),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """업로드 이력 조회"""
    from app.models.ai import AIDataUploadHistory

    try:
        result = await db.execute(
            select(AIDataUploadHistory)
            .order_by(AIDataUploadHistory.created_at.desc())
            .limit(limit)
        )
        uploads = result.scalars().all()
        logger.info(f"[upload-history] {len(uploads)}건 조회 (user={current_user.id})")

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
    except Exception as e:
        logger.error(f"[upload-history] 조회 오류: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"업로드 이력 조회 실패: {str(e)[:200]}")


@router.get("/classify-result/{upload_id}")
async def get_classification_result(
    upload_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """저장된 분류 결과 불러오기"""
    from app.models.ai import AIDataUploadHistory

    upload = await db.get(AIDataUploadHistory, upload_id)
    if not upload:
        raise HTTPException(status_code=404, detail="분류 이력을 찾을 수 없습니다.")
    if not upload.result_json:
        raise HTTPException(status_code=404, detail="저장된 분류 결과가 없습니다.")

    try:
        data = json.loads(upload.result_json)
        stats = data.get("stats", {})
        results = data.get("results", [])
        banks = data.get("banks", None)

        # 통장 분류와 카드 분류 모두 호환되도록 통일
        total_rows = (
            stats.get("total_rows") or
            stats.get("total_transactions") or
            data.get("total_rows") or
            len(results)
        )

        resp = {
            "upload_id": upload.id,
            "filename": upload.filename,
            "file_type": upload.file_type,
            "created_at": upload.created_at.isoformat() if upload.created_at else None,
            "total_rows": total_rows,
            "auto_confirmed": stats.get("auto_confirmed", 0),
            "needs_review": stats.get("needs_review", 0),
            "average_confidence": stats.get("average_confidence", 0),
            "total_amount": stats.get("total_amount", 0),
            "results": results,
        }
        # 통장 분류인 경우 은행 정보 포함
        if banks is not None:
            resp["banks"] = banks
            resp["inter_bank_transfers"] = stats.get("inter_bank_transfers", 0)
            resp["is_bank_statement"] = True
        return resp
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"결과 파싱 실패: {str(e)[:200]}")


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


# ============ 통장 거래 내역 분류 ============

def _parse_bank_statement_xls(content: bytes, filename: str) -> dict:
    """
    통장 거래 내역 엑셀(.xls/.xlsx) 파싱

    Returns:
        {
            "bank_name": str, "account_number": str,
            "date_range": str, "year": str,
            "transactions": [{"date": ..., "description": ..., ...}, ...],
            "total_deposit": float, "total_withdrawal": float,
        }
    """
    import re

    try:
        import xlrd
    except ImportError:
        raise ValueError("xlrd 패키지가 필요합니다: pip install xlrd>=2.0.1")

    if filename.endswith('.xls'):
        wb = xlrd.open_workbook(file_contents=content)
        sheet = wb.sheet_by_index(0)
        nrows = sheet.nrows
        ncols = sheet.ncols

        def cell_value(r, c):
            if r < nrows and c < ncols:
                return sheet.cell_value(r, c)
            return ""
    else:
        # .xlsx
        import openpyxl
        wb_xlsx = openpyxl.load_workbook(io.BytesIO(content), read_only=True, data_only=True)
        ws = wb_xlsx.active
        rows_data = list(ws.iter_rows(values_only=True))
        nrows = len(rows_data)
        ncols = max(len(r) for r in rows_data) if rows_data else 0

        def cell_value(r, c):
            if r < nrows and c < len(rows_data[r]):
                return rows_data[r][c] if rows_data[r][c] is not None else ""
            return ""

    # Row 2: date range (e.g., "2026.01.01~2026.02.27")
    date_range_str = ""
    year_str = ""
    for c in range(ncols):
        val = str(cell_value(2, c)).strip()
        if val and re.search(r'\d{4}\.\d{2}\.\d{2}', val):
            date_range_str = val
            year_match = re.search(r'(\d{4})', val)
            if year_match:
                year_str = year_match.group(1)
            break

    # Row 4: Company name in col A; Bank/account info in col I
    bank_name = ""
    account_number = ""
    # Try col I (index 8) first, then search all columns
    for c in [8] + list(range(ncols)):
        val = str(cell_value(4, c)).strip()
        bank_match = re.search(r'\[(\d+)\](.+?)\((.+?)\)', val)
        if bank_match:
            bank_name = bank_match.group(2).strip()
            account_number = bank_match.group(3).strip()
            break

    if not year_str:
        # fallback: try to find year anywhere in first 5 rows
        for r in range(min(5, nrows)):
            for c in range(ncols):
                val = str(cell_value(r, c))
                ym = re.search(r'(20\d{2})', val)
                if ym:
                    year_str = ym.group(1)
                    break
            if year_str:
                break

    # Row 7+: Data rows
    transactions = []
    total_deposit = 0.0
    total_withdrawal = 0.0

    def safe_float(val):
        if val == "" or val is None:
            return 0.0
        try:
            return float(str(val).replace(",", "").strip())
        except (ValueError, TypeError):
            return 0.0

    for r in range(7, nrows):
        col0 = str(cell_value(r, 0)).strip()

        # Skip repeated header rows (col 0 == "거래일시")
        if col0 == "거래일시":
            continue

        # Skip summary rows (contains "합" and "계")
        if "합" in col0 and "계" in col0:
            continue

        # Skip empty rows
        if not col0:
            continue

        # Parse date: MM-DD → YYYY-MM-DD
        date_raw = col0.replace(".", "-")
        if year_str and not re.match(r'^\d{4}', date_raw):
            transaction_date = f"{year_str}-{date_raw}"
        else:
            transaction_date = date_raw

        description = str(cell_value(r, 1)).strip()  # 적요
        content_val = str(cell_value(r, 2)).strip()   # 내용

        deposit = safe_float(cell_value(r, 3))      # 입금액
        withdrawal = safe_float(cell_value(r, 4))    # 출금액
        balance = safe_float(cell_value(r, 5))        # 잔액
        branch = str(cell_value(r, 6)).strip()         # 취급점
        counterparty = str(cell_value(r, 7)).strip()   # 거래처
        remarks = str(cell_value(r, 8)).strip()        # 비고

        # Skip rows that are clearly not data
        if deposit == 0 and withdrawal == 0 and not description:
            continue

        total_deposit += deposit
        total_withdrawal += withdrawal

        transactions.append({
            "transaction_date": transaction_date,
            "description": description,
            "content": content_val,
            "deposit": deposit,
            "withdrawal": withdrawal,
            "balance": balance,
            "branch": branch,
            "counterparty": counterparty,
            "remarks": remarks,
        })

    return {
        "bank_name": bank_name or "알수없음",
        "account_number": account_number or "",
        "date_range": date_range_str,
        "year": year_str,
        "transactions": transactions,
        "total_deposit": total_deposit,
        "total_withdrawal": total_withdrawal,
    }


def _detect_inter_bank_transfers(all_transactions: List[dict]) -> List[tuple]:
    """
    은행 간 이체 감지: 출금(Bank A) ↔ 입금(Bank B) 매칭

    - 같은 날짜 또는 +1일
    - 같은 금액
    - 적요/내용에 은행 관련 키워드 포함
    """
    from datetime import timedelta

    transfer_keywords = [
        "이체", "자금이체", "타행이체", "당행이체", "계좌이체",
        "신한", "국민", "우리", "하나", "기업", "농협", "수협", "SC",
        "대구", "부산", "광주", "전북", "제주", "경남",
    ]

    withdrawals = []
    deposits = []

    for txn in all_transactions:
        if txn["withdrawal"] > 0:
            withdrawals.append(txn)
        if txn["deposit"] > 0:
            deposits.append(txn)

    matched_pairs = set()  # (withdrawal_idx, deposit_idx) in all_transactions
    used_deposit_indices = set()

    for w in withdrawals:
        w_amount = w["withdrawal"]
        w_date_str = w["transaction_date"]
        w_bank = w.get("_bank_name", "")
        w_text = f"{w['description']} {w['content']} {w.get('counterparty', '')}"

        # Check if this withdrawal looks like a transfer
        has_keyword = any(kw in w_text for kw in transfer_keywords)
        if not has_keyword:
            continue

        try:
            w_date = datetime.strptime(w_date_str, "%Y-%m-%d").date()
        except (ValueError, TypeError):
            continue

        for d in deposits:
            d_global_idx = d.get("_global_idx")
            if d_global_idx in used_deposit_indices:
                continue
            if d.get("_bank_name", "") == w_bank:
                continue  # same bank, skip
            if d["deposit"] != w_amount:
                continue  # amount mismatch

            try:
                d_date = datetime.strptime(d["transaction_date"], "%Y-%m-%d").date()
            except (ValueError, TypeError):
                continue

            # Same day or +1 day
            diff = (d_date - w_date).days
            if diff < 0 or diff > 1:
                continue

            # Found a match
            w_global_idx = w.get("_global_idx")

            if w_global_idx is not None and d_global_idx is not None:
                if w_global_idx not in {p[0] for p in matched_pairs}:
                    matched_pairs.add((w_global_idx, d_global_idx))
                    used_deposit_indices.add(d_global_idx)
                    break  # one match per withdrawal

    return list(matched_pairs)


# ── Rule-based bank transaction pre-classifier ──────────────────────
# Returns a classification dict or None if unsure (fallback to LLM).
# This eliminates 60-70% of LLM calls for typical bank statements.
def _rule_classify_bank_txn(txn: dict) -> Optional[dict]:
    desc = (txn.get("description", "") or "").lower()
    content = (txn.get("content", "") or "").lower()
    counterparty = (txn.get("counterparty", "") or "").lower()
    is_deposit = txn.get("deposit", 0) > 0
    combined = f"{desc} {content} {counterparty}"

    # ---- 입금 (Deposits) ----
    if is_deposit:
        # Interest income
        if any(k in combined for k in ["이자", "예금이자"]):
            return {"account_code": "901", "account_name": "이자수익",
                    "confidence": 0.95, "reasoning": "규칙: 이자 키워드"}

        # Loan disbursement
        if any(k in combined for k in ["대출", "여신실행", "한도대출"]):
            return {"account_code": "260", "account_name": "단기차입금",
                    "confidence": 0.85, "reasoning": "규칙: 대출 실행"}

        # Card sales deposit
        if any(k in combined for k in ["카드입금", "카드매출", "van", "pg입금",
                                        "나이스", "페이", "ksnet", "kicc"]):
            return {"account_code": "108", "account_name": "외상매출금",
                    "confidence": 0.85, "reasoning": "규칙: 카드매출 입금"}

        # Generic sales deposit (large amounts via bank transfer)
        if txn.get("deposit", 0) >= 1000000 and content in [
            "타행이체", "fb이체", "당행이체", "bz뱅크", "인터넷이체",
            "cms입금", "지로입금", "무통장입금",
        ]:
            return {"account_code": "401", "account_name": "상품매출",
                    "confidence": 0.70, "reasoning": "규칙: 거래처 입금 추정"}

        return None  # Deposit not matched — send to LLM

    # ---- 출금 (Withdrawals) ----
    # Interest expense
    if any(k in combined for k in ["대출이자", "이자출금", "여신이자", "이자납입"]):
        return {"account_code": "931", "account_name": "이자비용",
                "confidence": 0.95, "reasoning": "규칙: 대출이자 키워드"}

    # Salary / wages
    if any(k in combined for k in ["급여", "상여", "월급", "보너스"]):
        return {"account_code": "802", "account_name": "직원급여",
                "confidence": 0.93, "reasoning": "규칙: 급여 키워드"}
    if "급여이체" in content:
        return {"account_code": "802", "account_name": "직원급여",
                "confidence": 0.95, "reasoning": "규칙: 급여이체 채널"}

    # 4대보험
    if any(k in combined for k in ["국민건강보험", "국민연금", "근로복지공단",
                                     "고용보험", "건강보험", "산재보험"]):
        return {"account_code": "811", "account_name": "복리후생비",
                "confidence": 0.93, "reasoning": "규칙: 4대보험"}

    # Tax payments — VAT / withholding
    if any(k in combined for k in ["부가세", "부가가치세", "원천세", "소득세"]):
        return {"account_code": "254", "account_name": "예수금",
                "confidence": 0.90, "reasoning": "규칙: 세금 납부"}

    # Tax payments — property / local
    if any(k in combined for k in ["재산세", "자동차세", "주민세", "지방세",
                                     "등록면허세", "종합부동산세"]):
        return {"account_code": "817", "account_name": "세금과공과금",
                "confidence": 0.92, "reasoning": "규칙: 지방세/기타세금"}

    # Corporate tax
    if "법인세" in combined:
        return {"account_code": "817", "account_name": "세금과공과금",
                "confidence": 0.90, "reasoning": "규칙: 법인세 납부"}

    # Rent
    if any(k in combined for k in ["임대료", "월세", "관리비", "임차료"]):
        return {"account_code": "819", "account_name": "지급임차료",
                "confidence": 0.92, "reasoning": "규칙: 임대료 키워드"}

    # Insurance (excluding 4대보험)
    if (any(k in combined for k in ["보험료", "화재보험", "배상책임보험",
                                      "자동차보험", "상해보험"])
            and not any(k in combined for k in ["건강보험", "고용보험"])):
        return {"account_code": "821", "account_name": "보험료",
                "confidence": 0.90, "reasoning": "규칙: 보험료 키워드"}

    # Utilities — electricity
    if any(k in combined for k in ["전기료", "전력", "한전", "한국전력"]):
        return {"account_code": "816", "account_name": "전력비",
                "confidence": 0.93, "reasoning": "규칙: 전기료"}

    # Utilities — water / gas
    if any(k in combined for k in ["수도", "가스", "도시가스", "상수도"]):
        return {"account_code": "815", "account_name": "수도광열비",
                "confidence": 0.93, "reasoning": "규칙: 수도/가스"}

    # Telecom
    if any(k in combined for k in ["통신", "kt ", "skt", "lg u+", "인터넷",
                                     "케이티", "에스케이", "엘지유플러스"]):
        return {"account_code": "814", "account_name": "통신비",
                "confidence": 0.92, "reasoning": "규칙: 통신비 키워드"}

    # Fees / commissions
    if any(k in combined for k in ["수수료", "이체수수료", "송금수수료",
                                     "카드수수료", "인지세"]):
        return {"account_code": "831", "account_name": "지급수수료",
                "confidence": 0.93, "reasoning": "규칙: 수수료 키워드"}

    # Loan repayment
    if any(k in combined for k in ["대출상환", "원금상환", "원리금"]):
        return {"account_code": "260", "account_name": "단기차입금",
                "confidence": 0.88, "reasoning": "규칙: 대출상환 키워드"}

    # Credit card bill payment
    if ("cc" in content or any(k in combined for k in [
        "카드대금", "신한카드", "삼성카드", "현대카드", "롯데카드",
        "국민카드", "bc카드", "비씨카드", "하나카드", "우리카드",
        "농협카드", "씨티카드",
    ])):
        return {"account_code": "253", "account_name": "미지급금",
                "confidence": 0.92, "reasoning": "규칙: 카드대금 결제"}

    # Delivery / transport
    if any(k in combined for k in ["택배", "운반", "배송", "화물", "물류",
                                     "cj대한통운", "한진", "로젠", "우체국택배"]):
        return {"account_code": "824", "account_name": "운반비",
                "confidence": 0.90, "reasoning": "규칙: 운반/택배 키워드"}

    # Generic purchase payment (large amounts via bank transfer)
    if txn.get("withdrawal", 0) >= 1000000 and content in [
        "타행이체", "fb이체", "당행이체", "bz뱅크", "인터넷이체",
    ]:
        return {"account_code": "251", "account_name": "외상매입금",
                "confidence": 0.65, "reasoning": "규칙: 거래처 지급 추정"}

    return None  # Can't determine — send to LLM


# Thread pool for parallel LLM calls (3 workers)
_bank_llm_executor = ThreadPoolExecutor(max_workers=3)


# 통장 분류 진행 상태 추적 (in-memory, backward compat)
_bank_classify_progress: dict = {
    "status": "idle",
    "step": "",
    "progress": 0,
    "message": "",
    "total_rows": 0,
    "processed_rows": 0,
}


@router.get("/bank-classify-progress")
async def get_bank_classify_progress(
    current_user: User = Depends(get_current_user)
):
    """통장 분류 진행 상태 조회 (backward compat)"""
    return _bank_classify_progress


@router.post("/classify-bank-statements")
async def classify_bank_statements(
    files: List[UploadFile] = File(...),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    통장 거래 내역 다중 파일 업로드 및 AI 분류 (SSE 스트리밍 응답)

    - 1~10개의 은행 통장 거래 내역 엑셀 파일(.xls/.xlsx) 동시 업로드
    - Server-Sent Events로 진행 상태와 최종 결과를 스트리밍 반환
    """
    global _bank_classify_progress

    # Validate file count
    if len(files) < 1 or len(files) > 10:
        raise HTTPException(status_code=400, detail="1~10개의 파일만 업로드 가능합니다.")

    # Validate file types
    for f in files:
        if not f.filename.endswith(('.xls', '.xlsx')):
            raise HTTPException(
                status_code=400,
                detail=f"엑셀 파일(.xls, .xlsx)만 업로드 가능합니다: {f.filename}"
            )

    # Read all file contents NOW (UploadFile objects expire after response starts)
    file_data = []
    for f in files:
        content = await f.read()
        file_data.append({"content": content, "filename": f.filename})

    user_id = current_user.id

    async def event_stream():
        import re

        # SSE 시작 직후, 분류 이력 레코드를 먼저 생성 (status=processing)
        pre_upload_id = None
        try:
            from app.models.ai import AIDataUploadHistory, UploadStatus
            filenames = ", ".join(fd["filename"] for fd in file_data)
            async with async_session_factory() as pre_db:
                pre_upload = AIDataUploadHistory(
                    filename=f"통장분류: {filenames}"[:500],
                    file_size=sum(len(fd["content"]) for fd in file_data),
                    file_type="bank_statement",
                    upload_type="classification",
                    uploaded_by=user_id,
                    status=UploadStatus.PROCESSING,
                    row_count=0,
                    saved_count=0,
                )
                pre_db.add(pre_upload)
                await pre_db.flush()
                pre_upload_id = pre_upload.id
                await pre_db.commit()
            logger.info(f"[BankStatement SSE] 이력 레코드 사전 생성 (upload_id={pre_upload_id})")
        except Exception as pre_err:
            logger.error(f"[BankStatement SSE] 이력 사전 생성 실패: {pre_err}", exc_info=True)

        try:
            num_files = len(file_data)

            _bank_classify_progress.update({
                "status": "running", "step": "파일 파싱", "progress": 5,
                "message": f"{num_files}개 파일 파싱 중...",
                "total_rows": 0, "processed_rows": 0,
            })
            yield f"data: {json.dumps({'type': 'progress', 'step': '파일 파싱', 'progress': 5, 'message': f'{num_files}개 파일 파싱 중...'}, ensure_ascii=False)}\n\n"

            # ===== Phase 1: Parse all files =====
            banks_info = []
            all_transactions = []
            global_idx = 0

            for fd in file_data:
                try:
                    parsed = await asyncio.to_thread(
                        _parse_bank_statement_xls, fd["content"], fd["filename"]
                    )
                except Exception as parse_err:
                    logger.error(f"[BankStatement SSE] 파싱 실패: {fd['filename']} - {parse_err}")
                    err_msg = f"파일 파싱 실패 ({fd['filename']}): {str(parse_err)[:200]}"
                    _bank_classify_progress.update({
                        "status": "failed", "step": "오류",
                        "message": err_msg,
                    })
                    yield f"data: {json.dumps({'type': 'error', 'message': err_msg}, ensure_ascii=False)}\n\n"
                    return

                bank_info = {
                    "bank_name": parsed["bank_name"],
                    "account_number": parsed["account_number"],
                    "date_range": parsed["date_range"],
                    "total_rows": len(parsed["transactions"]),
                    "total_deposit": parsed["total_deposit"],
                    "total_withdrawal": parsed["total_withdrawal"],
                }
                banks_info.append(bank_info)

                for txn in parsed["transactions"]:
                    txn["_bank_name"] = parsed["bank_name"]
                    txn["_account_number"] = parsed["account_number"]
                    txn["_global_idx"] = global_idx
                    all_transactions.append(txn)
                    global_idx += 1

            total_transactions = len(all_transactions)
            _bank_classify_progress.update({
                "step": "파싱 완료", "progress": 15,
                "message": f"{num_files}개 파일, {total_transactions:,}건 거래 파싱 완료",
                "total_rows": total_transactions,
            })
            yield f"data: {json.dumps({'type': 'progress', 'step': '파싱 완료', 'progress': 15, 'message': f'{num_files}개 파일, {total_transactions:,}건 거래 파싱 완료'}, ensure_ascii=False)}\n\n"
            logger.info(f"[BankStatement SSE] 파싱 완료: {num_files}개 파일, {total_transactions}건")

            # ===== Phase 2: Detect inter-bank transfers =====
            _bank_classify_progress.update({
                "step": "은행간 이체 감지", "progress": 20,
                "message": "은행 간 이체를 감지하고 있습니다...",
            })
            yield f"data: {json.dumps({'type': 'progress', 'step': '은행간 이체 감지', 'progress': 20, 'message': '은행 간 이체를 감지하고 있습니다...'}, ensure_ascii=False)}\n\n"

            matched_pairs = _detect_inter_bank_transfers(all_transactions)
            transfer_set = set()
            transfer_match_map = {}
            for w_idx, d_idx in matched_pairs:
                transfer_set.add(w_idx)
                transfer_set.add(d_idx)
                transfer_match_map[w_idx] = d_idx
                transfer_match_map[d_idx] = w_idx

            inter_bank_count = len(matched_pairs)
            logger.info(f"[BankStatement SSE] 은행간 이체 감지: {inter_bank_count}쌍")

            _bank_classify_progress.update({
                "step": "AI 분류 준비", "progress": 25,
                "message": f"은행간 이체 {inter_bank_count}쌍 감지. AI 분류 준비 중...",
            })
            yield f"data: {json.dumps({'type': 'progress', 'step': 'AI 분류 준비', 'progress': 25, 'message': f'은행간 이체 {inter_bank_count}쌍 감지. AI 분류 준비 중...'}, ensure_ascii=False)}\n\n"

            # ===== Phase 3: Classify (rules -> LLM fallback, parallel) =====
            phase3_start = time.time()
            normal_indices = [i for i in range(total_transactions) if i not in transfer_set]
            transfer_indices = list(transfer_set)

            # Auto-classify inter-bank transfers as 보통예금(103)
            classification_map = {}
            for idx in transfer_indices:
                partner_idx = transfer_match_map.get(idx)
                partner_bank = all_transactions[partner_idx]["_bank_name"] if partner_idx is not None else ""
                txn = all_transactions[idx]
                is_withdrawal = txn["withdrawal"] > 0

                classification_map[idx] = {
                    "account_code": "103",
                    "account_name": f"보통예금({partner_bank})" if partner_bank else "보통예금",
                    "confidence": 0.98,
                    "reasoning": f"은행간 이체 ({'출금→' + partner_bank if is_withdrawal else partner_bank + '→입금'})",
                }

            # -- Step 3a: Rule-based pre-classification --
            rule_classified_count = 0
            llm_needed_indices = []
            for gi in normal_indices:
                rule_result = _rule_classify_bank_txn(all_transactions[gi])
                if rule_result is not None:
                    classification_map[gi] = rule_result
                    rule_classified_count += 1
                else:
                    llm_needed_indices.append(gi)

            logger.info(
                f"[BankStatement SSE] 규칙 분류: {rule_classified_count}건, "
                f"LLM 필요: {len(llm_needed_indices)}건 "
                f"(전체 {len(normal_indices)}건 중 {rule_classified_count/max(len(normal_indices),1)*100:.0f}% 규칙 처리)"
            )

            rule_msg = (
                f"규칙 분류 {rule_classified_count:,}건 완료. "
                f"Claude AI로 나머지 {len(llm_needed_indices):,}건 분류 중..."
            )
            _bank_classify_progress.update({
                "step": "AI 분류", "progress": 30,
                "message": rule_msg,
                "rule_classified": rule_classified_count,
                "llm_classified": 0,
                "total_to_classify": len(normal_indices),
                "elapsed_seconds": round(time.time() - phase3_start, 1),
            })
            yield f"data: {json.dumps({'type': 'progress', 'step': 'AI 분류', 'progress': 30, 'message': rule_msg, 'rule_classified': rule_classified_count, 'llm_classified': 0}, ensure_ascii=False)}\n\n"

            # -- Step 3b: LLM classification (batch=200, 3-way parallel) --
            if llm_needed_indices and settings.ANTHROPIC_API_KEY:
                try:
                    from app.services.ai_classifier import STANDARD_ACCOUNTS

                    import anthropic
                    client = anthropic.Anthropic(api_key=settings.ANTHROPIC_API_KEY)

                    account_list = "\n".join(
                        f"- {code}: {name}" for code, name in sorted(STANDARD_ACCOUNTS.items())
                    )

                    BATCH_SIZE = 200
                    llm_classified_so_far = 0

                    all_batches = []
                    for batch_start in range(0, len(llm_needed_indices), BATCH_SIZE):
                        batch_indices = llm_needed_indices[batch_start:batch_start + BATCH_SIZE]
                        all_batches.append(batch_indices)

                    total_batches = len(all_batches)
                    LLM_MODEL = "claude-sonnet-4-20250514"

                    def _call_llm_for_batch(batch_indices, batch_num):
                        """Synchronous LLM call for one batch (runs in thread pool)."""
                        txn_lines = []
                        for i, gi in enumerate(batch_indices):
                            txn = all_transactions[gi]
                            txn_type = "입금" if txn["deposit"] > 0 else "출금"
                            amount = txn["deposit"] if txn["deposit"] > 0 else txn["withdrawal"]
                            txn_lines.append(
                                f"{i+1}. [{txn['_bank_name']}] {txn_type} | 적요: {txn['description']} | "
                                f"내용: {txn['content']} | 거래처: {txn['counterparty']} | 금액: {amount:,.0f}원"
                            )
                        txn_text = "\n".join(txn_lines)

                        prompt = f"""한국 식품제조회사(조인앤조인) 통장 거래 내역의 계정과목을 분류하세요.
**반드시 아래 계정과목 목록에 있는 코드만 사용하세요. 목록에 없는 코드 금지.**

## 계정과목 목록
{account_list}

## 통장 거래 분류 기준
- 입금(매출): 상품매출(401), 제품매출(404)
- 입금(이자): 이자수익(901)
- 입금(기타): 잡이익(930), 미수금 회수(120), 선수금(259)
- 출금(원재료/부재료 구매): 원재료비(501), 부재료비(502)
- 출금(급여): 직원급여(802) 또는 급여(503)
- 출금(4대보험, 세금): 예수금(254), 세금과공과금(817)
- 출금(임대/월세): 지급임차료(819)
- 출금(대출이자): 이자비용(931)
- 출금(대출상환): 단기차입금(260), 장기차입금(293)
- 출금(외상대금 지급): 외상매입금(251)
- 출금(카드대금): 미지급금(253)
- 출금(보험료): 보험료(821)
- 출금(수수료): 지급수수료(831)
- 출금(운반/택배): 운반비(824)
- 출금(전기/수도/가스): 전력비(816), 수도광열비(815)
- 출금(통신): 통신비(814)
- 출금(기타): 적요/거래처 내용으로 판단

## 거래 ({len(batch_indices)}건)
{txn_text}

## 응답 (JSON 배열만 출력, 다른 텍스트 금지)
[{{"no":1,"account_code":"401","account_name":"상품매출","confidence":0.9,"reasoning":"매출 입금"}},...]"""

                        try:
                            response = client.messages.create(
                                model=LLM_MODEL,
                                max_tokens=16000,
                                messages=[{"role": "user", "content": prompt}],
                            )

                            text = response.content[0].text.strip()
                            if "```" in text:
                                text = text.split("```")[1]
                                if text.startswith("json"):
                                    text = text[4:]
                                text = text.strip()

                            batch_results = json.loads(text)

                            mapped = {}
                            for item_result in batch_results:
                                no = item_result.get("no", 0) - 1
                                if 0 <= no < len(batch_indices):
                                    gi = batch_indices[no]
                                    code = item_result.get("account_code", "")
                                    name = item_result.get("account_name", "") or STANDARD_ACCOUNTS.get(code, "")
                                    conf = min(float(item_result.get("confidence", 0.8)), 0.95)
                                    mapped[gi] = {
                                        "account_code": code,
                                        "account_name": name,
                                        "confidence": conf,
                                        "reasoning": item_result.get("reasoning", "AI 분석"),
                                    }

                            logger.info(f"[BankStatement LLM] 배치 {batch_num}/{total_batches} 완료 ({len(mapped)}건)")
                            return mapped

                        except Exception as llm_err:
                            logger.warning(f"[BankStatement LLM] 배치 {batch_num} 실패: {llm_err}")
                            return {}

                    # Run batches in parallel groups of 3
                    PARALLEL = 3
                    loop = asyncio.get_running_loop()

                    for group_start in range(0, total_batches, PARALLEL):
                        group_end = min(group_start + PARALLEL, total_batches)
                        group_tasks = []
                        for b_idx in range(group_start, group_end):
                            group_tasks.append(
                                loop.run_in_executor(
                                    _bank_llm_executor,
                                    _call_llm_for_batch,
                                    all_batches[b_idx],
                                    b_idx + 1,
                                )
                            )

                        group_results = await asyncio.gather(*group_tasks, return_exceptions=True)

                        for res in group_results:
                            if isinstance(res, dict):
                                classification_map.update(res)
                                llm_classified_so_far += len(res)
                            elif isinstance(res, Exception):
                                logger.warning(f"[BankStatement LLM] 병렬 배치 예외: {res}")

                        # Update progress after each parallel group
                        elapsed = time.time() - phase3_start
                        done_batches = min(group_end, total_batches)
                        remaining_batches = total_batches - done_batches
                        avg_per_batch = elapsed / max(done_batches, 1)
                        remaining_groups = (remaining_batches + PARALLEL - 1) // PARALLEL if remaining_batches > 0 else 0
                        est_remaining = remaining_groups * avg_per_batch

                        progress_pct = 30 + int(55 * (done_batches / max(total_batches, 1)))
                        llm_msg = (
                            f"AI 분류 중... 배치 {done_batches}/{total_batches} "
                            f"(규칙: {rule_classified_count:,}, AI: {llm_classified_so_far:,}, "
                            f"경과: {elapsed:.0f}초, 남은 예상: {est_remaining:.0f}초)"
                        )
                        _bank_classify_progress.update({
                            "progress": progress_pct,
                            "message": llm_msg,
                            "processed_rows": len(transfer_indices) + rule_classified_count + llm_classified_so_far,
                            "rule_classified": rule_classified_count,
                            "llm_classified": llm_classified_so_far,
                            "total_to_classify": len(normal_indices),
                            "elapsed_seconds": round(elapsed, 1),
                            "estimated_remaining": round(est_remaining, 1),
                        })
                        yield f"data: {json.dumps({'type': 'progress', 'step': 'AI 분류', 'progress': progress_pct, 'message': llm_msg, 'rule_classified': rule_classified_count, 'llm_classified': llm_classified_so_far, 'elapsed_seconds': round(elapsed, 1), 'estimated_remaining': round(est_remaining, 1)}, ensure_ascii=False)}\n\n"

                    logger.info(
                        f"[BankStatement SSE] LLM 분류 완료: {llm_classified_so_far}건, "
                        f"총 소요: {time.time() - phase3_start:.1f}초"
                    )

                except Exception as llm_setup_err:
                    logger.warning(f"[BankStatement SSE] LLM 분류 실패: {llm_setup_err}")
            elif llm_needed_indices and not settings.ANTHROPIC_API_KEY:
                logger.warning("[BankStatement SSE] ANTHROPIC_API_KEY 미설정 — LLM 분류 생략")

            phase3_elapsed = time.time() - phase3_start
            logger.info(
                f"[BankStatement SSE] Phase 3 총 소요: {phase3_elapsed:.1f}초 "
                f"(이체: {len(transfer_indices)}, 규칙: {rule_classified_count}, "
                f"LLM: {len(llm_needed_indices)}건)"
            )

            # ===== Phase 4: Build results =====
            _bank_classify_progress.update({
                "step": "결과 조립", "progress": 88,
                "message": "결과를 정리하고 있습니다...",
            })
            yield f"data: {json.dumps({'type': 'progress', 'step': '결과 조립', 'progress': 88, 'message': '결과를 정리하고 있습니다...'}, ensure_ascii=False)}\n\n"

            results = []
            for i, txn in enumerate(all_transactions):
                cls = classification_map.get(i)
                is_transfer = i in transfer_set
                partner_idx = transfer_match_map.get(i)

                transfer_match_info = None
                if partner_idx is not None:
                    partner = all_transactions[partner_idx]
                    transfer_match_info = {
                        "matched_index": partner_idx,
                        "matched_bank": partner["_bank_name"],
                        "matched_account": partner["_account_number"],
                        "matched_type": "입금" if partner["deposit"] > 0 else "출금",
                    }

                amount = txn["deposit"] if txn["deposit"] > 0 else txn["withdrawal"]

                result_item = {
                    "bank_name": txn["_bank_name"],
                    "account_number": txn["_account_number"],
                    "row_index": i,
                    "transaction_date": txn["transaction_date"],
                    "description": txn["description"],
                    "content": txn["content"],
                    "deposit": txn["deposit"],
                    "withdrawal": txn["withdrawal"],
                    "balance": txn["balance"],
                    "branch": txn.get("branch", ""),
                    "counterparty": txn.get("counterparty", ""),
                    "remarks": txn.get("remarks", ""),
                    "is_inter_bank_transfer": is_transfer,
                    "transfer_match": transfer_match_info,
                    "predicted_account_code": cls["account_code"] if cls else "",
                    "predicted_account_name": cls["account_name"] if cls else "",
                    "confidence": cls["confidence"] if cls else 0.0,
                    "reasoning": cls.get("reasoning", "") if cls else "",
                    "auto_confirm": (cls["confidence"] >= 0.85) if cls else False,
                    "needs_review": (cls["confidence"] < 0.85) if cls else True,
                    "amount": amount,
                    "journal_entry": {
                        "debit_account_code": cls["account_code"] if cls and txn["withdrawal"] > 0 else "103",
                        "debit_account_name": cls["account_name"] if cls and txn["withdrawal"] > 0 else f"보통예금({txn['_bank_name']})",
                        "debit_amount": amount,
                        "credit_account_code": "103" if txn["withdrawal"] > 0 else (cls["account_code"] if cls else ""),
                        "credit_account_name": f"보통예금({txn['_bank_name']})" if txn["withdrawal"] > 0 else (cls["account_name"] if cls else ""),
                        "credit_amount": amount,
                        "is_balanced": True,
                    } if cls else None,
                }
                results.append(result_item)

            # ===== Phase 5: Save to DB and respond =====
            _bank_classify_progress.update({
                "step": "결과 저장", "progress": 92,
                "message": "분류 결과를 저장하고 있습니다...",
            })
            yield f"data: {json.dumps({'type': 'progress', 'step': '결과 저장', 'progress': 92, 'message': '분류 결과를 저장하고 있습니다...'}, ensure_ascii=False)}\n\n"

            # Statistics
            auto_confirm_count = sum(1 for r in results if r.get("auto_confirm"))
            needs_review_count = sum(1 for r in results if r.get("needs_review"))
            avg_confidence = sum(r["confidence"] for r in results) / len(results) if results else 0

            # Save to DB — 사전 생성된 레코드를 업데이트 (또는 새로 생성)
            upload_id = pre_upload_id
            try:
                from app.models.ai import AIDataUploadHistory, UploadStatus

                result_json_str = json.dumps({
                    "banks": banks_info,
                    "results": results,
                    "stats": {
                        "total_transactions": total_transactions,
                        "inter_bank_transfers": inter_bank_count,
                        "auto_confirmed": auto_confirm_count,
                        "needs_review": needs_review_count,
                        "average_confidence": round(avg_confidence, 4),
                    }
                }, ensure_ascii=False, default=str)

                async with async_session_factory() as save_db:
                    if pre_upload_id:
                        # 사전 생성 레코드 업데이트
                        upload_rec = await save_db.get(AIDataUploadHistory, pre_upload_id)
                        if upload_rec:
                            upload_rec.status = UploadStatus.COMPLETED
                            upload_rec.row_count = total_transactions
                            upload_rec.saved_count = total_transactions
                            upload_rec.result_json = result_json_str
                            upload_rec.error_message = None
                            await save_db.commit()
                            logger.info(f"[BankStatement SSE] 기존 레코드 업데이트 완료 (upload_id={pre_upload_id})")
                        else:
                            logger.warning(f"[BankStatement SSE] 사전 레코드 조회 실패, 새로 생성")
                            pre_upload_id = None  # fallback to create new

                    if not pre_upload_id:
                        # 사전 생성 실패했으면 새로 생성
                        filenames = ", ".join(fd["filename"] for fd in file_data)
                        new_upload = AIDataUploadHistory(
                            filename=f"통장분류: {filenames}"[:500],
                            file_size=sum(len(fd["content"]) for fd in file_data),
                            file_type="bank_statement",
                            upload_type="classification",
                            uploaded_by=user_id,
                            status=UploadStatus.COMPLETED,
                            row_count=total_transactions,
                            saved_count=total_transactions,
                            result_json=result_json_str,
                        )
                        save_db.add(new_upload)
                        await save_db.flush()
                        upload_id = new_upload.id
                        await save_db.commit()
                        logger.info(f"[BankStatement SSE] 새 레코드 생성 완료 (upload_id={upload_id})")

            except Exception as save_err:
                logger.error(f"[BankStatement SSE] DB 저장 실패: {save_err}", exc_info=True)
                # result_json이 너무 크면 결과 없이 이력만 저장 시도
                if pre_upload_id:
                    try:
                        async with async_session_factory() as fallback_db:
                            upload_rec = await fallback_db.get(AIDataUploadHistory, pre_upload_id)
                            if upload_rec:
                                upload_rec.status = UploadStatus.COMPLETED
                                upload_rec.row_count = total_transactions
                                upload_rec.saved_count = total_transactions
                                upload_rec.error_message = f"결과 JSON 저장 실패: {str(save_err)[:200]}"
                                await fallback_db.commit()
                                logger.info(f"[BankStatement SSE] 폴백: 이력만 저장 (result_json 없이)")
                    except Exception as fb_err:
                        logger.error(f"[BankStatement SSE] 폴백 저장도 실패: {fb_err}")

            _bank_classify_progress.update({
                "status": "completed", "step": "완료", "progress": 100,
                "message": f"분류 완료! {total_transactions:,}건 (자동확정: {auto_confirm_count:,}, 검토필요: {needs_review_count:,}, 은행간이체: {inter_bank_count}쌍)",
                "processed_rows": total_transactions,
            })

            # Send final result
            final_result = {
                "status": "completed",
                "upload_id": upload_id,
                "banks": banks_info,
                "total_transactions": total_transactions,
                "inter_bank_transfers": inter_bank_count,
                "auto_confirmed": auto_confirm_count,
                "needs_review": needs_review_count,
                "average_confidence": round(avg_confidence, 4),
                "results": results,
            }
            yield f"data: {json.dumps({'type': 'result', 'data': final_result}, ensure_ascii=False, default=str)}\n\n"
            yield "data: {\"type\": \"done\"}\n\n"

        except Exception as e:
            logger.error(f"[BankStatement SSE] Error: {e}", exc_info=True)
            _bank_classify_progress.update({
                "status": "failed", "step": "오류",
                "message": f"처리 오류: {str(e)[:200]}",
            })
            # 사전 생성 레코드를 실패 상태로 업데이트
            if pre_upload_id:
                try:
                    from app.models.ai import AIDataUploadHistory, UploadStatus
                    async with async_session_factory() as err_db:
                        upload_rec = await err_db.get(AIDataUploadHistory, pre_upload_id)
                        if upload_rec:
                            upload_rec.status = UploadStatus.FAILED
                            upload_rec.error_message = str(e)[:500]
                            await err_db.commit()
                except Exception:
                    pass
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)[:500]}, ensure_ascii=False)}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


# ══════════════════════════════════════════════════════════════════════════════
# TAX INVOICE (세금계산서) CLASSIFICATION
# ══════════════════════════════════════════════════════════════════════════════

# Thread pool for parallel LLM calls (3 workers)
_tax_llm_executor = ThreadPoolExecutor(max_workers=3)

# 세금계산서 분류 진행 상태 추적 (in-memory)
_tax_classify_progress: dict = {
    "status": "idle",
    "step": "",
    "progress": 0,
    "message": "",
    "total_rows": 0,
    "processed_rows": 0,
}


def _parse_tax_invoice_xls(content: bytes, filename: str) -> dict:
    """
    전자세금계산서 엑셀 파일을 파싱한다.

    컬럼: 일자, Code, 거래처, 유형, 품명, 공급가액, 부가세, 합계,
           차변계정, 대변계정, 관리, 전표상태
    헤더 행을 첫 5행에서 자동 탐지한다.
    """
    header_keywords = {"일자", "거래처", "공급가액", "부가세", "합계"}

    xls_io = io.BytesIO(content)
    try:
        df_raw = pd.read_excel(xls_io, header=None, dtype=str)
    except Exception:
        xls_io.seek(0)
        df_raw = pd.read_excel(xls_io, header=None, dtype=str, engine="xlrd")

    # Detect header row in first 5 rows
    header_row_idx = None
    for row_i in range(min(5, len(df_raw))):
        row_vals = set(str(v).strip() for v in df_raw.iloc[row_i] if pd.notna(v))
        if len(header_keywords & row_vals) >= 3:
            header_row_idx = row_i
            break

    if header_row_idx is None:
        # Fall back: just use row 0
        header_row_idx = 0

    # Re-read with detected header
    xls_io = io.BytesIO(content)
    try:
        df = pd.read_excel(xls_io, header=header_row_idx, dtype=str)
    except Exception:
        xls_io.seek(0)
        df = pd.read_excel(xls_io, header=header_row_idx, dtype=str, engine="xlrd")

    # Normalise column names (strip whitespace)
    df.columns = [str(c).strip() for c in df.columns]

    # Column name mapping (handle slight variations)
    col_map = {}
    for col in df.columns:
        cl = col.lower().replace(" ", "")
        if "일자" in col:
            col_map["date"] = col
        elif col == "Code" or cl == "code" or "코드" in col:
            col_map["vendor_code"] = col
        elif "거래처" in col and "vendor_name" not in col_map:
            col_map["vendor_name"] = col
        elif "유형" in col:
            col_map["tax_type"] = col
        elif "품명" in col:
            col_map["item_description"] = col
        elif "공급가액" in col:
            col_map["supply_amount"] = col
        elif "부가세" in col:
            col_map["vat_amount"] = col
        elif "합계" in col and "total_amount" not in col_map:
            col_map["total_amount"] = col
        elif "차변" in col:
            col_map["debit_account"] = col
        elif "대변" in col:
            col_map["credit_account"] = col
        elif "관리" in col:
            col_map["management"] = col
        elif "전표" in col:
            col_map["voucher_status"] = col

    def _safe_float(val) -> float:
        try:
            if pd.isna(val):
                return 0.0
            s = str(val).replace(",", "").replace(" ", "").strip()
            return float(s) if s else 0.0
        except (ValueError, TypeError):
            return 0.0

    transactions = []
    total_supply = 0.0
    total_vat = 0.0
    total_amount = 0.0

    for _, row in df.iterrows():
        # Skip rows that look like subtotals / totals (no vendor name)
        vendor_name = str(row.get(col_map.get("vendor_name", ""), "") or "").strip()
        if not vendor_name or vendor_name in ("nan", "None", "합계", "소계", "합 계"):
            continue

        supply = _safe_float(row.get(col_map.get("supply_amount", ""), 0))
        vat = _safe_float(row.get(col_map.get("vat_amount", ""), 0))
        total = _safe_float(row.get(col_map.get("total_amount", ""), 0))

        # Skip zero-amount rows
        if supply == 0 and total == 0:
            continue

        date_raw = str(row.get(col_map.get("date", ""), "") or "").strip()
        if date_raw in ("nan", "None"):
            date_raw = ""

        txn = {
            "date": date_raw,
            "vendor_code": str(row.get(col_map.get("vendor_code", ""), "") or "").strip(),
            "vendor_name": vendor_name,
            "tax_type": str(row.get(col_map.get("tax_type", ""), "") or "").strip(),
            "item_description": str(row.get(col_map.get("item_description", ""), "") or "").strip(),
            "supply_amount": supply,
            "vat_amount": vat,
            "total_amount": total if total > 0 else (supply + vat),
        }
        transactions.append(txn)
        total_supply += supply
        total_vat += vat
        total_amount += txn["total_amount"]

    return {
        "transactions": transactions,
        "total_supply": total_supply,
        "total_vat": total_vat,
        "total_amount": total_amount,
        "row_count": len(transactions),
    }


def _rule_classify_tax_invoice(txn: dict) -> Optional[dict]:
    """
    규칙 기반 세금계산서 계정 분류.
    거래처명과 품명의 키워드로 판단하며,
    확실한 경우에만 결과를 반환하고 불확실하면 None을 반환해 LLM에 위임한다.
    """
    vendor = (txn.get("vendor_name", "") or "").lower()
    item = (txn.get("item_description", "") or "").lower()
    combined = f"{vendor} {item}"

    def _match(keywords):
        return any(k in combined for k in keywords)

    # 통신비 (523)
    if _match(["통신", "전화", "인터넷", "kt", "skt", "lgu+", "엘지유플러스", "sk텔레콤", "케이티"]):
        return {"account_code": "523", "account_name": "통신비",
                "confidence": 0.90, "reasoning": "규칙: 통신/전화/인터넷 키워드"}

    # 수도광열비 (522) — 전기
    if _match(["전기", "전력", "한국전력", "한전", "kepco"]):
        return {"account_code": "522", "account_name": "수도광열비",
                "confidence": 0.92, "reasoning": "규칙: 전기/한전 키워드"}

    # 수도광열비 (522) — 수도/가스
    if _match(["수도", "상하수도", "도시가스", "가스", "lng", "lpg"]):
        return {"account_code": "522", "account_name": "수도광열비",
                "confidence": 0.90, "reasoning": "규칙: 수도/가스 키워드"}

    # 임차료 (519)
    if _match(["임대", "임차", "월세", "관리비", "임차료", "임대료"]):
        return {"account_code": "519", "account_name": "임차료",
                "confidence": 0.92, "reasoning": "규칙: 임대/임차/월세 키워드"}

    # 보험료 (524)
    if _match(["보험"]):
        return {"account_code": "524", "account_name": "보험료",
                "confidence": 0.90, "reasoning": "규칙: 보험 키워드"}

    # 지급수수료 (518)
    if _match(["세무", "회계", "법무", "컨설팅", "자문", "법인세", "세무사", "회계사"]):
        return {"account_code": "518", "account_name": "지급수수료",
                "confidence": 0.90, "reasoning": "규칙: 세무/회계/법무/컨설팅 키워드"}

    # 운반비 (516)
    if _match(["택배", "운송", "배송", "물류", "화물", "운반"]):
        return {"account_code": "516", "account_name": "운반비",
                "confidence": 0.90, "reasoning": "규칙: 택배/운송/배송 키워드"}

    # 수선비 (521)
    if _match(["수리", "유지", "보수", "정비", "수선"]):
        return {"account_code": "521", "account_name": "수선비",
                "confidence": 0.88, "reasoning": "규칙: 수리/유지/보수 키워드"}

    # 소모품비 (514)
    if _match(["소모품", "사무용품", "사무", "문구", "청소용품"]):
        return {"account_code": "514", "account_name": "소모품비",
                "confidence": 0.88, "reasoning": "규칙: 소모품/사무용품 키워드"}

    # 포장비 (528)
    if _match(["포장", "용기", "박스", "패키지", "케이스"]):
        return {"account_code": "528", "account_name": "포장비",
                "confidence": 0.88, "reasoning": "규칙: 포장/용기 키워드"}

    # 광고선전비 (517)
    if _match(["광고", "홍보", "마케팅", "촬영", "디자인", "인쇄"]):
        return {"account_code": "517", "account_name": "광고선전비",
                "confidence": 0.88, "reasoning": "규칙: 광고/홍보 키워드"}

    # 차량유지비 (526)
    if _match(["차량", "주유", "경유", "휘발유", "엔진오일", "자동차", "차량유지"]):
        return {"account_code": "526", "account_name": "차량유지비",
                "confidence": 0.90, "reasoning": "규칙: 차량/주유 키워드"}

    # 교육훈련비 (530)
    if _match(["교육", "연수", "훈련", "세미나", "강의"]):
        return {"account_code": "530", "account_name": "교육훈련비",
                "confidence": 0.88, "reasoning": "규칙: 교육/연수 키워드"}

    # 원재료비 (451) — 식재료/식품 원료
    if _match(["식재료", "원료", "원재료", "재료", "농산물", "축산물", "수산물"]):
        return {"account_code": "451", "account_name": "원재료비",
                "confidence": 0.85, "reasoning": "규칙: 식재료/원료 키워드"}

    # 상품매입 (404) — 식품 완제품 매입
    if _match(["식품", "가공식품", "완제품", "상품"]):
        return {"account_code": "404", "account_name": "상품매입",
                "confidence": 0.82, "reasoning": "규칙: 식품/상품 키워드"}

    return None  # 불확실 → LLM 위임


@router.get("/classify-tax-progress")
async def get_tax_classify_progress(
    current_user: User = Depends(get_current_user)
):
    """세금계산서 분류 진행 상태 조회"""
    return _tax_classify_progress


@router.post("/classify-tax-invoices")
async def classify_tax_invoices(
    files: List[UploadFile] = File(...),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    전자세금계산서 다중 파일 업로드 및 AI 분류 (SSE 스트리밍 응답)

    - 1~5개의 전자세금계산서 엑셀 파일(.xls/.xlsx) 동시 업로드
    - Server-Sent Events로 진행 상태와 최종 결과를 스트리밍 반환
    """
    global _tax_classify_progress

    # Validate file count
    if len(files) < 1 or len(files) > 5:
        raise HTTPException(status_code=400, detail="1~5개의 파일만 업로드 가능합니다.")

    # Validate file types
    for f in files:
        if not f.filename.endswith(('.xls', '.xlsx')):
            raise HTTPException(
                status_code=400,
                detail=f"엑셀 파일(.xls, .xlsx)만 업로드 가능합니다: {f.filename}"
            )

    # Read all file contents NOW (UploadFile objects expire after response starts)
    file_data = []
    for f in files:
        content = await f.read()
        file_data.append({"content": content, "filename": f.filename})

    user_id = current_user.id

    async def event_stream():
        # SSE 시작 직후, 분류 이력 레코드를 먼저 생성 (status=processing)
        pre_upload_id = None
        try:
            from app.models.ai import AIDataUploadHistory, UploadStatus
            filenames = ", ".join(fd["filename"] for fd in file_data)
            async with async_session_factory() as pre_db:
                pre_upload = AIDataUploadHistory(
                    filename=f"세금계산서: {filenames}"[:500],
                    file_size=sum(len(fd["content"]) for fd in file_data),
                    file_type="tax_invoice",
                    upload_type="classification",
                    uploaded_by=user_id,
                    status=UploadStatus.PROCESSING,
                    row_count=0,
                    saved_count=0,
                )
                pre_db.add(pre_upload)
                await pre_db.flush()
                pre_upload_id = pre_upload.id
                await pre_db.commit()
            logger.info(f"[TaxInvoice SSE] 이력 레코드 사전 생성 (upload_id={pre_upload_id})")
        except Exception as pre_err:
            logger.error(f"[TaxInvoice SSE] 이력 사전 생성 실패: {pre_err}", exc_info=True)

        try:
            num_files = len(file_data)

            _tax_classify_progress.update({
                "status": "running", "step": "파일 파싱", "progress": 5,
                "message": f"{num_files}개 파일 파싱 중...",
                "total_rows": 0, "processed_rows": 0,
            })
            yield f"data: {json.dumps({'type': 'progress', 'step': '파일 파싱', 'progress': 5, 'message': f'{num_files}개 파일 파싱 중...'}, ensure_ascii=False)}\n\n"

            # ===== Phase 1: Parse all files =====
            files_info = []
            all_transactions = []

            for fd in file_data:
                try:
                    parsed = await asyncio.to_thread(
                        _parse_tax_invoice_xls, fd["content"], fd["filename"]
                    )
                except Exception as parse_err:
                    logger.error(f"[TaxInvoice SSE] 파싱 실패: {fd['filename']} - {parse_err}")
                    err_msg = f"파일 파싱 실패 ({fd['filename']}): {str(parse_err)[:200]}"
                    _tax_classify_progress.update({
                        "status": "failed", "step": "오류",
                        "message": err_msg,
                    })
                    yield f"data: {json.dumps({'type': 'error', 'message': err_msg}, ensure_ascii=False)}\n\n"
                    return

                file_info = {
                    "filename": fd["filename"],
                    "row_count": parsed["row_count"],
                    "total_supply": parsed["total_supply"],
                    "total_vat": parsed["total_vat"],
                    "total_amount": parsed["total_amount"],
                }
                files_info.append(file_info)

                for txn in parsed["transactions"]:
                    txn["_filename"] = fd["filename"]
                    all_transactions.append(txn)

            total_transactions = len(all_transactions)
            _tax_classify_progress.update({
                "step": "파싱 완료", "progress": 15,
                "message": f"{num_files}개 파일, {total_transactions:,}건 세금계산서 파싱 완료",
                "total_rows": total_transactions,
            })
            yield f"data: {json.dumps({'type': 'progress', 'step': '파싱 완료', 'progress': 15, 'message': f'{num_files}개 파일, {total_transactions:,}건 세금계산서 파싱 완료'}, ensure_ascii=False)}\n\n"
            logger.info(f"[TaxInvoice SSE] 파싱 완료: {num_files}개 파일, {total_transactions}건")

            # ===== Phase 2 & 3: Rule-based + LLM classification =====
            phase3_start = time.time()

            _tax_classify_progress.update({
                "step": "규칙 분류", "progress": 15,
                "message": "규칙 기반 분류 중...",
            })
            yield f"data: {json.dumps({'type': 'progress', 'step': '규칙 분류', 'progress': 15, 'message': '규칙 기반 분류 중...'}, ensure_ascii=False)}\n\n"

            classification_map = {}  # global_idx -> cls_dict
            llm_needed_indices = []
            rule_classified_count = 0

            for gi, txn in enumerate(all_transactions):
                rule_result = _rule_classify_tax_invoice(txn)
                if rule_result is not None:
                    classification_map[gi] = rule_result
                    rule_classified_count += 1
                else:
                    llm_needed_indices.append(gi)

            logger.info(
                f"[TaxInvoice SSE] 규칙 분류: {rule_classified_count}건, "
                f"LLM 필요: {len(llm_needed_indices)}건 "
                f"(전체 {total_transactions}건 중 {rule_classified_count/max(total_transactions,1)*100:.0f}% 규칙 처리)"
            )

            rule_msg = (
                f"규칙 분류 {rule_classified_count:,}건 완료. "
                f"Claude AI로 나머지 {len(llm_needed_indices):,}건 분류 중..."
            )
            _tax_classify_progress.update({
                "step": "AI 분류", "progress": 30,
                "message": rule_msg,
                "rule_classified": rule_classified_count,
                "llm_classified": 0,
                "total_to_classify": total_transactions,
                "elapsed_seconds": round(time.time() - phase3_start, 1),
            })
            yield f"data: {json.dumps({'type': 'progress', 'step': 'AI 분류', 'progress': 30, 'message': rule_msg, 'rule_classified': rule_classified_count, 'llm_classified': 0}, ensure_ascii=False)}\n\n"

            # -- LLM classification (batch=200, 3-way parallel) --
            if llm_needed_indices and settings.ANTHROPIC_API_KEY:
                try:
                    from app.services.ai_classifier import STANDARD_ACCOUNTS

                    import anthropic
                    client = anthropic.Anthropic(api_key=settings.ANTHROPIC_API_KEY)

                    account_list = "\n".join(
                        f"- {code}: {name}" for code, name in sorted(STANDARD_ACCOUNTS.items())
                    )

                    BATCH_SIZE = 200
                    llm_classified_so_far = 0

                    all_batches = []
                    for batch_start in range(0, len(llm_needed_indices), BATCH_SIZE):
                        batch_indices = llm_needed_indices[batch_start:batch_start + BATCH_SIZE]
                        all_batches.append(batch_indices)

                    total_batches = len(all_batches)
                    LLM_MODEL = "claude-sonnet-4-20250514"

                    def _call_llm_for_tax_batch(batch_indices, batch_num):
                        """Synchronous LLM call for one tax invoice batch (runs in thread pool)."""
                        txn_lines = []
                        for i, gi in enumerate(batch_indices):
                            txn = all_transactions[gi]
                            txn_lines.append(
                                f"{i+1}. 거래처: {txn['vendor_name']} | "
                                f"품명: {txn['item_description']} | "
                                f"유형: {txn['tax_type']} | "
                                f"공급가액: {txn['supply_amount']:,.0f}원 | "
                                f"부가세: {txn['vat_amount']:,.0f}원"
                            )
                        txn_text = "\n".join(txn_lines)

                        prompt = f"""한국 식품제조회사(조인앤조인) 전자세금계산서(매입)의 계정과목을 분류하세요.
**반드시 아래 계정과목 목록에 있는 코드만 사용하세요. 목록에 없는 코드 금지.**

## 계정과목 목록
{account_list}

## 세금계산서 분류 기준
- 식재료/원료/부재료 구매: 원재료비(451) 또는 부재료비(502)
- 완제품/상품 매입: 상품매입(404)
- 포장재/용기: 포장비(528)
- 소모품/사무용품: 소모품비(514)
- 임대료/월세/관리비: 임차료(519)
- 전기/수도/가스: 수도광열비(522)
- 통신비(전화/인터넷): 통신비(523)
- 보험료: 보험료(524)
- 차량유지/주유: 차량유지비(526)
- 수리/보수/유지: 수선비(521)
- 운반/택배/물류: 운반비(516)
- 광고/홍보/마케팅: 광고선전비(517)
- 세무/회계/법무/컨설팅: 지급수수료(518)
- 교육/연수: 교육훈련비(530)
- 기타 경비: 거래처/품명으로 판단

## 세금계산서 거래 ({len(batch_indices)}건)
{txn_text}

## 응답 (JSON 배열만 출력, 다른 텍스트 금지)
[{{"no":1,"account_code":"451","account_name":"원재료비","confidence":0.9,"reasoning":"식재료 매입"}},...]"""

                        try:
                            response = client.messages.create(
                                model=LLM_MODEL,
                                max_tokens=16000,
                                messages=[{"role": "user", "content": prompt}],
                            )

                            text = response.content[0].text.strip()
                            if "```" in text:
                                text = text.split("```")[1]
                                if text.startswith("json"):
                                    text = text[4:]
                                text = text.strip()

                            batch_results = json.loads(text)

                            mapped = {}
                            for item_result in batch_results:
                                no = item_result.get("no", 0) - 1
                                if 0 <= no < len(batch_indices):
                                    gi = batch_indices[no]
                                    code = item_result.get("account_code", "")
                                    name = item_result.get("account_name", "") or STANDARD_ACCOUNTS.get(code, "")
                                    conf = min(float(item_result.get("confidence", 0.8)), 0.95)
                                    mapped[gi] = {
                                        "account_code": code,
                                        "account_name": name,
                                        "confidence": conf,
                                        "reasoning": item_result.get("reasoning", "AI 분석"),
                                    }

                            logger.info(f"[TaxInvoice LLM] 배치 {batch_num}/{total_batches} 완료 ({len(mapped)}건)")
                            return mapped

                        except Exception as llm_err:
                            logger.warning(f"[TaxInvoice LLM] 배치 {batch_num} 실패: {llm_err}")
                            return {}

                    # Run batches in parallel groups of 3
                    PARALLEL = 3
                    loop = asyncio.get_running_loop()

                    for group_start in range(0, total_batches, PARALLEL):
                        group_end = min(group_start + PARALLEL, total_batches)
                        group_tasks = []
                        for b_idx in range(group_start, group_end):
                            group_tasks.append(
                                loop.run_in_executor(
                                    _tax_llm_executor,
                                    _call_llm_for_tax_batch,
                                    all_batches[b_idx],
                                    b_idx + 1,
                                )
                            )

                        group_results = await asyncio.gather(*group_tasks, return_exceptions=True)

                        for res in group_results:
                            if isinstance(res, dict):
                                classification_map.update(res)
                                llm_classified_so_far += len(res)
                            elif isinstance(res, Exception):
                                logger.warning(f"[TaxInvoice LLM] 병렬 배치 예외: {res}")

                        # Update progress after each parallel group
                        elapsed = time.time() - phase3_start
                        done_batches = min(group_end, total_batches)
                        remaining_batches = total_batches - done_batches
                        avg_per_batch = elapsed / max(done_batches, 1)
                        remaining_groups = (remaining_batches + PARALLEL - 1) // PARALLEL if remaining_batches > 0 else 0
                        est_remaining = remaining_groups * avg_per_batch

                        progress_pct = 30 + int(55 * (done_batches / max(total_batches, 1)))
                        llm_msg = (
                            f"AI 분류 중... 배치 {done_batches}/{total_batches} "
                            f"(규칙: {rule_classified_count:,}, AI: {llm_classified_so_far:,}, "
                            f"경과: {elapsed:.0f}초, 남은 예상: {est_remaining:.0f}초)"
                        )
                        _tax_classify_progress.update({
                            "progress": progress_pct,
                            "message": llm_msg,
                            "processed_rows": rule_classified_count + llm_classified_so_far,
                            "rule_classified": rule_classified_count,
                            "llm_classified": llm_classified_so_far,
                            "total_to_classify": total_transactions,
                            "elapsed_seconds": round(elapsed, 1),
                            "estimated_remaining": round(est_remaining, 1),
                        })
                        yield f"data: {json.dumps({'type': 'progress', 'step': 'AI 분류', 'progress': progress_pct, 'message': llm_msg, 'rule_classified': rule_classified_count, 'llm_classified': llm_classified_so_far, 'elapsed_seconds': round(elapsed, 1), 'estimated_remaining': round(est_remaining, 1)}, ensure_ascii=False)}\n\n"

                    logger.info(
                        f"[TaxInvoice SSE] LLM 분류 완료: {llm_classified_so_far}건, "
                        f"총 소요: {time.time() - phase3_start:.1f}초"
                    )

                except Exception as llm_setup_err:
                    logger.warning(f"[TaxInvoice SSE] LLM 분류 실패: {llm_setup_err}")
            elif llm_needed_indices and not settings.ANTHROPIC_API_KEY:
                logger.warning("[TaxInvoice SSE] ANTHROPIC_API_KEY 미설정 — LLM 분류 생략")

            phase3_elapsed = time.time() - phase3_start
            logger.info(
                f"[TaxInvoice SSE] Phase 3 총 소요: {phase3_elapsed:.1f}초 "
                f"(규칙: {rule_classified_count}, LLM: {len(llm_needed_indices)}건)"
            )

            # ===== Phase 4: Build results =====
            _tax_classify_progress.update({
                "step": "결과 조립", "progress": 88,
                "message": "결과를 정리하고 있습니다...",
            })
            yield f"data: {json.dumps({'type': 'progress', 'step': '결과 조립', 'progress': 88, 'message': '결과를 정리하고 있습니다...'}, ensure_ascii=False)}\n\n"

            results = []
            for i, txn in enumerate(all_transactions):
                cls = classification_map.get(i)
                result_item = {
                    "row_index": i,
                    "date": txn["date"],
                    "vendor_code": txn["vendor_code"],
                    "vendor_name": txn["vendor_name"],
                    "tax_type": txn["tax_type"],
                    "item_description": txn["item_description"],
                    "supply_amount": txn["supply_amount"],
                    "vat_amount": txn["vat_amount"],
                    "total_amount": txn["total_amount"],
                    "predicted_account_code": cls["account_code"] if cls else "",
                    "predicted_account_name": cls["account_name"] if cls else "",
                    "confidence": cls["confidence"] if cls else 0.0,
                    "reasoning": cls.get("reasoning", "") if cls else "",
                    "auto_confirm": cls["confidence"] >= 0.85 if cls else False,
                    "needs_review": cls["confidence"] < 0.85 if cls else True,
                    "journal_entry": {
                        "debit_account_code": cls["account_code"] if cls else "",
                        "debit_account_name": cls["account_name"] if cls else "",
                        "debit_amount": txn["supply_amount"],
                        "credit_account_code": "253",
                        "credit_account_name": "미지급금",
                        "credit_amount": txn["supply_amount"],
                        "vat_amount": txn["vat_amount"],
                        "supply_amount": txn["supply_amount"],
                        "is_balanced": True,
                    } if cls else None,
                }
                results.append(result_item)

            # ===== Phase 5: Save to DB and respond =====
            _tax_classify_progress.update({
                "step": "결과 저장", "progress": 92,
                "message": "분류 결과를 저장하고 있습니다...",
            })
            yield f"data: {json.dumps({'type': 'progress', 'step': '결과 저장', 'progress': 92, 'message': '분류 결과를 저장하고 있습니다...'}, ensure_ascii=False)}\n\n"

            # Statistics
            auto_confirm_count = sum(1 for r in results if r.get("auto_confirm"))
            needs_review_count = sum(1 for r in results if r.get("needs_review"))
            avg_confidence = sum(r["confidence"] for r in results) / len(results) if results else 0

            total_supply_sum = sum(t["supply_amount"] for t in all_transactions)
            total_vat_sum = sum(t["vat_amount"] for t in all_transactions)
            total_amount_sum = sum(t["total_amount"] for t in all_transactions)

            # Save to DB
            upload_id = pre_upload_id
            try:
                from app.models.ai import AIDataUploadHistory, UploadStatus

                result_json_str = json.dumps({
                    "files": files_info,
                    "results": results,
                    "stats": {
                        "total_transactions": total_transactions,
                        "auto_confirmed": auto_confirm_count,
                        "needs_review": needs_review_count,
                        "average_confidence": round(avg_confidence, 4),
                        "total_supply": total_supply_sum,
                        "total_vat": total_vat_sum,
                        "total_amount": total_amount_sum,
                    }
                }, ensure_ascii=False, default=str)

                async with async_session_factory() as save_db:
                    if pre_upload_id:
                        # 사전 생성 레코드 업데이트
                        upload_rec = await save_db.get(AIDataUploadHistory, pre_upload_id)
                        if upload_rec:
                            upload_rec.status = UploadStatus.COMPLETED
                            upload_rec.row_count = total_transactions
                            upload_rec.saved_count = total_transactions
                            upload_rec.result_json = result_json_str
                            upload_rec.error_message = None
                            await save_db.commit()
                            logger.info(f"[TaxInvoice SSE] 기존 레코드 업데이트 완료 (upload_id={pre_upload_id})")
                        else:
                            logger.warning(f"[TaxInvoice SSE] 사전 레코드 조회 실패, 새로 생성")
                            pre_upload_id = None  # fallback to create new

                    if not pre_upload_id:
                        # 사전 생성 실패했으면 새로 생성
                        filenames = ", ".join(fd["filename"] for fd in file_data)
                        new_upload = AIDataUploadHistory(
                            filename=f"세금계산서: {filenames}"[:500],
                            file_size=sum(len(fd["content"]) for fd in file_data),
                            file_type="tax_invoice",
                            upload_type="classification",
                            uploaded_by=user_id,
                            status=UploadStatus.COMPLETED,
                            row_count=total_transactions,
                            saved_count=total_transactions,
                            result_json=result_json_str,
                        )
                        save_db.add(new_upload)
                        await save_db.flush()
                        upload_id = new_upload.id
                        await save_db.commit()
                        logger.info(f"[TaxInvoice SSE] 새 레코드 생성 완료 (upload_id={upload_id})")

            except Exception as save_err:
                logger.error(f"[TaxInvoice SSE] DB 저장 실패: {save_err}", exc_info=True)
                if pre_upload_id:
                    try:
                        async with async_session_factory() as fallback_db:
                            upload_rec = await fallback_db.get(AIDataUploadHistory, pre_upload_id)
                            if upload_rec:
                                upload_rec.status = UploadStatus.COMPLETED
                                upload_rec.row_count = total_transactions
                                upload_rec.saved_count = total_transactions
                                upload_rec.error_message = f"결과 JSON 저장 실패: {str(save_err)[:200]}"
                                await fallback_db.commit()
                                logger.info(f"[TaxInvoice SSE] 폴백: 이력만 저장 (result_json 없이)")
                    except Exception as fb_err:
                        logger.error(f"[TaxInvoice SSE] 폴백 저장도 실패: {fb_err}")

            _tax_classify_progress.update({
                "status": "completed", "step": "완료", "progress": 100,
                "message": f"분류 완료! {total_transactions:,}건 (자동확정: {auto_confirm_count:,}, 검토필요: {needs_review_count:,})",
                "processed_rows": total_transactions,
            })

            # Send final result
            final_result = {
                "status": "completed",
                "upload_id": upload_id,
                "files": files_info,
                "total_transactions": total_transactions,
                "auto_confirmed": auto_confirm_count,
                "needs_review": needs_review_count,
                "average_confidence": round(avg_confidence, 4),
                "total_supply": total_supply_sum,
                "total_vat": total_vat_sum,
                "total_amount": total_amount_sum,
                "results": results,
            }
            yield f"data: {json.dumps({'type': 'result', 'data': final_result}, ensure_ascii=False, default=str)}\n\n"
            yield "data: {\"type\": \"done\"}\n\n"

        except Exception as e:
            logger.error(f"[TaxInvoice SSE] Error: {e}", exc_info=True)
            _tax_classify_progress.update({
                "status": "failed", "step": "오류",
                "message": f"처리 오류: {str(e)[:200]}",
            })
            # 사전 생성 레코드를 실패 상태로 업데이트
            if pre_upload_id:
                try:
                    from app.models.ai import AIDataUploadHistory, UploadStatus
                    async with async_session_factory() as err_db:
                        upload_rec = await err_db.get(AIDataUploadHistory, pre_upload_id)
                        if upload_rec:
                            upload_rec.status = UploadStatus.FAILED
                            upload_rec.error_message = str(e)[:500]
                            await err_db.commit()
                except Exception:
                    pass
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)[:500]}, ensure_ascii=False)}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")
