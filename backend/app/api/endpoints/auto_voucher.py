"""
자동 전표 후보 검수 큐 API.

회계담당자 워크플로:
1. POST /auto-voucher/generate-candidates  - 기간 지정해 그랜터 거래 → 후보 일괄 생성
2. POST /auto-voucher/match-duplicates     - 카드↔통장 중복 매칭 (DUPLICATE 표시)
3. GET  /auto-voucher/list                 - 검수 큐 (신뢰도/유형/상태별 필터)
4. POST /auto-voucher/{id}/confirm         - 단건 확정 (Voucher 생성)
5. POST /auto-voucher/confirm-batch        - 다중 확정
6. POST /auto-voucher/{id}/reject          - 거절
7. PATCH /auto-voucher/{id}                - 라인/계정/금액 수정
"""
import json
import logging
from datetime import date, datetime
from decimal import Decimal
from typing import Optional, List, Dict

from fastapi import APIRouter, Depends, Query, HTTPException, Body
from pydantic import BaseModel, Field
from sqlalchemy import select, func, and_
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.models.accounting import (
    AutoVoucherCandidate, AutoVoucherSourceType, AutoVoucherStatus,
    Voucher, VoucherLine, VoucherStatus, TransactionType, Account,
)
from app.services.auto_voucher_service import (
    generate_candidates_for_period,
    generate_candidates_background,
    match_card_bank_duplicates,
    match_voucher_duplicates_core,
    match_voucher_duplicates_grouped,
    reject_candidates_in_confirmed_period,
    get_progress,
)
from app.services.journal_migration import (
    migrate_journal_uploads_to_vouchers,
    migrate_journal_uploads_background,
    list_journal_uploads,
    diagnose_journal_data,
    delete_wehago_import_vouchers,
    delete_wehago_imports_background,
)


import uuid as _uuid


async def _voucher_number(db: AsyncSession, vdate: date) -> str:
    """
    YYYYMMDD-G{uuid8} 형식 (Granter auto). UUID 기반이라 count 호출 없음.
    수기 입력은 NNNN 시퀀스, 위하고 import는 J{hex}, 그랜터 자동은 G{hex}로 구분.
    """
    return f"{vdate.strftime('%Y%m%d')}-G{_uuid.uuid4().hex[:8]}"


async def _resolve_account_id(
    db: AsyncSession, code: str, name: str = "",
    cache: Optional[Dict[str, int]] = None,
) -> Optional[int]:
    """account_code → accounts.id. 없으면 자동 생성. cache 전달 시 SELECT 1회로 단축."""
    if not code:
        return None
    if cache is not None and code in cache:
        return cache[code]
    acc = (await db.execute(
        select(Account).where(Account.code == code, Account.is_active == True)
    )).scalar_one_or_none()
    if acc:
        if cache is not None:
            cache[code] = acc.id
        return acc.id
    # 자동 생성 — 회계담당자가 더존에서 쓰던 코드를 그대로 받아쓸 수 있게
    from app.models.accounting import AccountCategory
    # 카테고리 추정 (1xx 자산 .. 9xx 영업외)
    first = code.lstrip("0")[:1] if code else "9"
    cat_code_map = {'1': '1', '2': '2', '3': '3', '4': '4', '5': '5',
                    '6': '5', '7': '5', '8': '5', '9': '5'}
    cat_code = cat_code_map.get(first, '5')
    cat = (await db.execute(
        select(AccountCategory).where(AccountCategory.code == cat_code)
    )).scalar_one_or_none()
    if not cat:
        cat = (await db.execute(select(AccountCategory).limit(1))).scalar_one_or_none()
    if not cat:
        return None  # 시드 데이터 부재 — 호출자가 에러 처리
    new_acc = Account(
        code=code, name=name or f"계정 {code}",
        category_id=cat.id, level=1, is_detail=True,
        is_vat_applicable=True, vat_rate=Decimal("10.00"), is_active=True,
    )
    db.add(new_acc)
    await db.flush()
    if cache is not None:
        cache[code] = new_acc.id
    return new_acc.id

logger = logging.getLogger(__name__)
router = APIRouter()


# ============ Schemas ============

class GenerateRequest(BaseModel):
    start_date: date
    end_date: date
    asset_id: Optional[int] = None
    auto_match_duplicates: bool = True


class CandidateLine(BaseModel):
    side: str  # 'debit' | 'credit'
    account_code: str
    account_name: str
    amount: Decimal
    memo: Optional[str] = ""


class DuplicateVoucherInfo(BaseModel):
    id: int
    voucher_number: str
    voucher_date: date
    transaction_date: date
    source: Optional[str]
    merchant_name: Optional[str]
    total_debit: Decimal
    description: Optional[str]


class CandidateOut(BaseModel):
    id: int
    source_type: str
    source_id: Optional[str]
    status: str
    transaction_date: date
    counterparty: Optional[str]
    description: Optional[str]
    supply_amount: Decimal
    vat_amount: Decimal
    total_amount: Decimal
    confidence: float
    suggested_account_code: Optional[str]
    suggested_account_name: Optional[str]
    debit_lines: List[CandidateLine]
    credit_lines: List[CandidateLine]
    duplicate_of_id: Optional[int]
    duplicate_voucher_id: Optional[int] = None
    duplicate_voucher: Optional[DuplicateVoucherInfo] = None
    confirmed_voucher_id: Optional[int]
    created_at: datetime


class CandidatePatch(BaseModel):
    debit_lines: Optional[List[CandidateLine]] = None
    credit_lines: Optional[List[CandidateLine]] = None
    counterparty: Optional[str] = None
    description: Optional[str] = None
    suggested_account_code: Optional[str] = None
    suggested_account_name: Optional[str] = None


def _candidate_to_out(
    c: AutoVoucherCandidate,
    voucher_map: Optional[Dict[int, Voucher]] = None,
) -> CandidateOut:
    def _parse_lines(s: Optional[str]) -> List[CandidateLine]:
        if not s:
            return []
        try:
            arr = json.loads(s)
            return [CandidateLine(**item) for item in arr]
        except Exception:
            return []

    dup_info = None
    if voucher_map and c.duplicate_voucher_id and c.duplicate_voucher_id in voucher_map:
        v = voucher_map[c.duplicate_voucher_id]
        dup_info = DuplicateVoucherInfo(
            id=v.id,
            voucher_number=v.voucher_number,
            voucher_date=v.voucher_date,
            transaction_date=v.transaction_date,
            source=v.source,
            merchant_name=v.merchant_name,
            total_debit=v.total_debit,
            description=v.description,
        )

    return CandidateOut(
        id=c.id,
        source_type=c.source_type.value if hasattr(c.source_type, 'value') else str(c.source_type),
        source_id=c.source_id,
        status=c.status.value if hasattr(c.status, 'value') else str(c.status),
        transaction_date=c.transaction_date,
        counterparty=c.counterparty,
        description=c.description,
        supply_amount=c.supply_amount,
        vat_amount=c.vat_amount,
        total_amount=c.total_amount,
        confidence=float(c.confidence or 0),
        suggested_account_code=c.suggested_account_code,
        suggested_account_name=c.suggested_account_name,
        debit_lines=_parse_lines(c.debit_lines),
        credit_lines=_parse_lines(c.credit_lines),
        duplicate_of_id=c.duplicate_of_id,
        duplicate_voucher_id=c.duplicate_voucher_id,
        duplicate_voucher=dup_info,
        confirmed_voucher_id=c.confirmed_voucher_id,
        created_at=c.created_at,
    )


# ============ Endpoints ============

@router.post("/generate-candidates")
async def generate_candidates(
    req: GenerateRequest,
    background: bool = Query(True, description="true: 즉시 task_id 반환 후 백그라운드 처리"),
    db: AsyncSession = Depends(get_db),
):
    """
    기간 내 그랜터 거래를 분개 후보로 일괄 생성.
    background=true (default): task_id 즉시 반환 → /progress/{task_id} 폴링으로 진행률 추적.
    background=false: 동기 처리 (소규모 기간용, 응답까지 대기).
    """
    if req.end_date < req.start_date:
        raise HTTPException(status_code=400, detail="end_date < start_date")
    if (req.end_date - req.start_date).days > 366:
        raise HTTPException(status_code=400, detail="기간이 1년을 초과할 수 없습니다.")

    if background:
        task_id = await generate_candidates_background(
            req.start_date, req.end_date,
            asset_id=req.asset_id,
            auto_match_duplicates=req.auto_match_duplicates,
        )
        return {
            "task_id": task_id,
            "status": "queued",
            "progress_url": f"/api/v1/auto-voucher/progress/{task_id}",
        }

    result = await generate_candidates_for_period(
        db, req.start_date, req.end_date, asset_id=req.asset_id,
    )
    if req.auto_match_duplicates:
        match_result = await match_card_bank_duplicates(
            db, req.start_date, req.end_date,
        )
        result["duplicate_matching"] = match_result
        voucher_dup = await match_voucher_duplicates_grouped(
            db, req.start_date, req.end_date,
        )
        result["voucher_duplicate_matching"] = voucher_dup
    return result


@router.get("/progress/{task_id}")
async def get_task_progress(task_id: str):
    """백그라운드 후보 생성 진행률 조회."""
    p = get_progress(task_id)
    if not p:
        raise HTTPException(status_code=404, detail="task를 찾을 수 없습니다 (만료 또는 잘못된 id).")
    return p


@router.post("/match-duplicates")
async def match_duplicates(
    start_date: date = Query(...),
    end_date: date = Query(...),
    day_window: int = Query(35, ge=1, le=90,
                            description="카드 사용일 → 통장 결제일 매칭 윈도우 일수"),
    db: AsyncSession = Depends(get_db),
):
    """기존 PENDING 후보 중 카드↔통장 중복 매칭."""
    return await match_card_bank_duplicates(db, start_date, end_date, day_window)


@router.get("/list")
async def list_candidates(
    status: Optional[str] = Query(None, description="pending|confirmed|rejected|duplicate"),
    source_type: Optional[str] = Query(None,
        description="sales_tax_invoice|purchase_tax_invoice|card|bank|cash_receipt|sales_invoice|purchase_invoice"),
    start_date: Optional[date] = None,
    end_date: Optional[date] = None,
    confidence_lt: Optional[float] = Query(None, description="신뢰도가 이 값 미만만"),
    confidence_gte: Optional[float] = Query(None, description="신뢰도가 이 값 이상만"),
    counterparty: Optional[str] = Query(None),
    sort: str = Query("date_desc", description="date_asc|date_desc|conf_asc|conf_desc"),
    page: int = Query(1, ge=1),
    size: int = Query(50, ge=1, le=50000),
    db: AsyncSession = Depends(get_db),
):
    """검수 큐 목록 — 신뢰도/유형/상태/기간/거래처별 필터."""
    filters = []
    if status:
        try:
            filters.append(AutoVoucherCandidate.status == AutoVoucherStatus(status))
        except ValueError:
            raise HTTPException(status_code=400, detail=f"invalid status: {status}")
    if source_type:
        try:
            filters.append(AutoVoucherCandidate.source_type == AutoVoucherSourceType(source_type))
        except ValueError:
            raise HTTPException(status_code=400, detail=f"invalid source_type: {source_type}")
    if start_date:
        filters.append(AutoVoucherCandidate.transaction_date >= start_date)
    if end_date:
        filters.append(AutoVoucherCandidate.transaction_date <= end_date)
    if confidence_lt is not None:
        filters.append(AutoVoucherCandidate.confidence < Decimal(str(confidence_lt)))
    if confidence_gte is not None:
        filters.append(AutoVoucherCandidate.confidence >= Decimal(str(confidence_gte)))
    if counterparty:
        filters.append(AutoVoucherCandidate.counterparty.ilike(f"%{counterparty}%"))

    where = and_(*filters) if filters else True

    total = await db.scalar(
        select(func.count(AutoVoucherCandidate.id)).where(where)
    ) or 0

    order_clause = {
        "date_desc": AutoVoucherCandidate.transaction_date.desc(),
        "date_asc": AutoVoucherCandidate.transaction_date.asc(),
        "conf_desc": AutoVoucherCandidate.confidence.desc(),
        "conf_asc": AutoVoucherCandidate.confidence.asc(),
    }.get(sort, AutoVoucherCandidate.transaction_date.desc())

    offset = (page - 1) * size
    rows = (await db.execute(
        select(AutoVoucherCandidate)
        .where(where)
        .order_by(order_clause)
        .offset(offset).limit(size)
    )).scalars().all()

    # 중복 매칭된 Voucher 일괄 조회 (N+1 회피)
    voucher_ids = [r.duplicate_voucher_id for r in rows if r.duplicate_voucher_id]
    voucher_map: Dict[int, Voucher] = {}
    if voucher_ids:
        v_rows = (await db.execute(
            select(Voucher).where(Voucher.id.in_(voucher_ids))
        )).scalars().all()
        voucher_map = {v.id: v for v in v_rows}

    # 상태별·유형별 카운트 (필터 적용 후 — 큐 요약)
    summary_rows = (await db.execute(
        select(
            AutoVoucherCandidate.status,
            AutoVoucherCandidate.source_type,
            func.count(AutoVoucherCandidate.id).label('cnt'),
        ).where(where).group_by(AutoVoucherCandidate.status, AutoVoucherCandidate.source_type)
    )).all()

    summary = {}
    for s, st, cnt in summary_rows:
        st_key = st.value if hasattr(st, 'value') else str(st)
        s_key = s.value if hasattr(s, 'value') else str(s)
        summary.setdefault(s_key, {})[st_key] = cnt

    return {
        "total": total,
        "page": page,
        "size": size,
        "items": [_candidate_to_out(c, voucher_map) for c in rows],
        "summary": summary,
    }


@router.get("/journal-uploads")
async def get_journal_uploads(db: AsyncSession = Depends(get_db)):
    """
    위하고/더존 분개장 업로드 목록 — 일괄 변환 모달 선택용.
    /{candidate_id} 라우트보다 앞서야 정상 매칭됨.
    """
    return {"uploads": await list_journal_uploads(db)}


@router.get("/journal-diagnostic")
async def journal_diagnostic(
    upload_id: Optional[int] = Query(None, description="특정 업로드 ID만 진단 (없으면 전체)"),
    db: AsyncSession = Depends(get_db),
):
    """
    ai_raw 진단 — 분개장 데이터가 어떻게 저장됐는지 컬럼별 통계.
    분개장 식별이 왜 실패하는지 디버깅용. /{candidate_id}보다 앞서야 함.
    """
    return await diagnose_journal_data(db, upload_id=upload_id)


@router.get("/{candidate_id}")
async def get_candidate(
    candidate_id: int,
    db: AsyncSession = Depends(get_db),
):
    c = await db.get(AutoVoucherCandidate, candidate_id)
    if not c:
        raise HTTPException(status_code=404, detail="후보를 찾을 수 없습니다.")
    voucher_map: Dict[int, Voucher] = {}
    if c.duplicate_voucher_id:
        v = await db.get(Voucher, c.duplicate_voucher_id)
        if v:
            voucher_map[v.id] = v
    return _candidate_to_out(c, voucher_map)


@router.patch("/{candidate_id}")
async def patch_candidate(
    candidate_id: int,
    patch: CandidatePatch,
    db: AsyncSession = Depends(get_db),
):
    c = await db.get(AutoVoucherCandidate, candidate_id)
    if not c:
        raise HTTPException(status_code=404, detail="후보를 찾을 수 없습니다.")
    if c.status != AutoVoucherStatus.PENDING:
        raise HTTPException(status_code=400,
                            detail=f"PENDING 상태가 아닌 후보는 수정할 수 없습니다 (현재: {c.status.value})")

    if patch.debit_lines is not None:
        c.debit_lines = json.dumps(
            [l.model_dump(mode='json') for l in patch.debit_lines],
            ensure_ascii=False, default=str,
        )
    if patch.credit_lines is not None:
        c.credit_lines = json.dumps(
            [l.model_dump(mode='json') for l in patch.credit_lines],
            ensure_ascii=False, default=str,
        )
    if patch.counterparty is not None:
        c.counterparty = patch.counterparty
    if patch.description is not None:
        c.description = patch.description
    if patch.suggested_account_code is not None:
        c.suggested_account_code = patch.suggested_account_code
    if patch.suggested_account_name is not None:
        c.suggested_account_name = patch.suggested_account_name

    await db.commit()
    await db.refresh(c)
    return _candidate_to_out(c)


@router.post("/{candidate_id}/reject")
async def reject_candidate(
    candidate_id: int,
    reason: Optional[str] = Body(None, embed=True),
    db: AsyncSession = Depends(get_db),
):
    c = await db.get(AutoVoucherCandidate, candidate_id)
    if not c:
        raise HTTPException(status_code=404, detail="후보를 찾을 수 없습니다.")
    c.status = AutoVoucherStatus.REJECTED
    c.rejected_reason = reason
    await db.commit()
    return {"id": c.id, "status": c.status.value}


# ============ 확정 → Voucher 생성 ============

async def _confirm_candidate_inner(
    db: AsyncSession, c: AutoVoucherCandidate, user_id: int, department_id: int = 1,
    _seed_cache: Optional[Dict[str, int]] = None,
    _account_cache: Optional[Dict[str, int]] = None,
) -> Voucher:
    """후보 → Voucher + VoucherLine 변환.

    _seed_cache: {dept_id, user_id} 보장된 값 캐시 — batch 호출 시 매번 시드 안 함.
    _account_cache: account_code → accounts.id 캐시 — batch에서 SELECT 반복 절약.
    """
    if c.status == AutoVoucherStatus.CONFIRMED and c.confirmed_voucher_id:
        # 이미 처리됨 — idempotent하게 기존 voucher 반환 (성공으로 간주)
        existing = await db.get(Voucher, c.confirmed_voucher_id)
        if existing:
            return existing
    if c.status != AutoVoucherStatus.PENDING:
        raise HTTPException(status_code=400,
                            detail=f"PENDING 상태가 아닙니다 (id={c.id}, status={c.status.value})")

    # FK 보장 — departments/users 시드 데이터 부재 시 자동 생성 (별도 connection)
    if _seed_cache is None or "dept_id" not in _seed_cache:
        from app.services.journal_migration import _ensure_base_data
        seeded_dept_id, seeded_user_id = await _ensure_base_data()
        if _seed_cache is not None:
            _seed_cache["dept_id"] = seeded_dept_id
            _seed_cache["user_id"] = seeded_user_id
        department_id = seeded_dept_id
        user_id = seeded_user_id
    else:
        department_id = _seed_cache["dept_id"]
        user_id = _seed_cache["user_id"]

    debit_lines = json.loads(c.debit_lines or "[]")
    credit_lines = json.loads(c.credit_lines or "[]")

    total_debit = sum(Decimal(str(l.get("amount", 0))) for l in debit_lines)
    total_credit = sum(Decimal(str(l.get("amount", 0))) for l in credit_lines)

    # 자동 균형 조정 — 부가세 누락이 명확한 경우(차이/총액 8~11%)만 보정
    # 회계 안전성을 위해 좁은 범위만 자동 처리, 그 외는 사용자 수동 검토 요구
    if total_debit != total_credit:
        diff = total_credit - total_debit  # 양수면 차변 부족, 음수면 대변 부족
        total_abs = max(abs(total_debit), abs(total_credit), Decimal("1"))
        ratio = abs(diff) / total_abs
        # 부가세 = 총액의 약 9.09% (1/11). 0.08~0.11 범위면 부가세 누락 확실
        if Decimal("0.08") <= ratio <= Decimal("0.11"):
            if diff > 0:
                debit_lines.append({
                    "side": "debit", "account_code": "135", "account_name": "부가세대급금",
                    "amount": str(diff), "memo": "자동 보정 (부가세 추정)",
                })
            else:
                credit_lines.append({
                    "side": "credit", "account_code": "255", "account_name": "부가세예수금",
                    "amount": str(-diff), "memo": "자동 보정 (부가세 추정)",
                })
            total_debit = sum(Decimal(str(l.get("amount", 0))) for l in debit_lines)
            total_credit = sum(Decimal(str(l.get("amount", 0))) for l in credit_lines)

    if total_debit != total_credit:
        diff = total_credit - total_debit
        total_abs = max(abs(total_debit), abs(total_credit), Decimal("1"))
        ratio = float(abs(diff) / total_abs * 100)
        raise HTTPException(
            status_code=400,
            detail=(
                f"차변 합({total_debit:,}) ≠ 대변 합({total_credit:,}). "
                f"차이 {diff:,} ({ratio:.1f}%) — 부가세 범위(8~11%) 밖이라 자동 보정 안 됨. "
                f"수동으로 라인 추가/수정 필요."
            ),
        )

    txn_type_map = {
        AutoVoucherSourceType.CARD: TransactionType.CARD,
        AutoVoucherSourceType.BANK: TransactionType.BANK_TRANSFER,
        AutoVoucherSourceType.CASH_RECEIPT: TransactionType.CASH,
        AutoVoucherSourceType.SALES_TAX_INVOICE: TransactionType.TAX_INVOICE,
        AutoVoucherSourceType.PURCHASE_TAX_INVOICE: TransactionType.TAX_INVOICE,
        AutoVoucherSourceType.SALES_INVOICE: TransactionType.TAX_INVOICE,
        AutoVoucherSourceType.PURCHASE_INVOICE: TransactionType.TAX_INVOICE,
    }
    txn_type = txn_type_map.get(c.source_type, TransactionType.GENERAL)

    voucher = Voucher(
        voucher_number=await _voucher_number(db, c.transaction_date),
        voucher_date=c.transaction_date,
        transaction_date=c.transaction_date,
        description=(c.description or c.counterparty or "")[:500],
        transaction_type=txn_type,
        external_ref=c.source_id,
        source="granter_auto",
        department_id=department_id,
        created_by=user_id,
        total_debit=total_debit,
        total_credit=total_credit,
        status=VoucherStatus.CONFIRMED,
        merchant_name=c.counterparty,
        ai_confidence_score=c.confidence,
        confirmed_at=datetime.utcnow(),
        confirmed_by=user_id,
    )
    db.add(voucher)
    await db.flush()  # voucher.id 확보

    # 적요(description) 우선순위: 라인 메모 > candidate.description > counterparty
    candidate_desc = (c.description or c.counterparty or "")[:500]

    line_no = 1
    for l in debit_lines + credit_lines:
        is_debit = l.get("side") == "debit"
        amt = Decimal(str(l.get("amount", 0)))
        account_id = await _resolve_account_id(
            db, l.get("account_code", ""), l.get("account_name", ""),
            cache=_account_cache,
        )
        if account_id is None:
            raise HTTPException(status_code=400,
                                detail=f"계정 매핑 실패: code={l.get('account_code')}")
        vat_acc = l.get("account_code") in ("135", "255")
        line_memo = (l.get("memo") or "").strip()
        line_desc = line_memo or candidate_desc or l.get("account_name") or ""
        db.add(VoucherLine(
            voucher_id=voucher.id,
            line_number=line_no,
            account_id=account_id,
            debit_amount=amt if is_debit else Decimal("0"),
            credit_amount=amt if not is_debit else Decimal("0"),
            vat_amount=amt if vat_acc else Decimal("0"),
            supply_amount=amt if not vat_acc else Decimal("0"),
            description=line_desc[:500],
            counterparty_name=c.counterparty,
        ))
        line_no += 1

    c.status = AutoVoucherStatus.CONFIRMED
    c.confirmed_voucher_id = voucher.id
    c.confirmed_at = datetime.utcnow()
    c.confirmed_by = user_id

    return voucher


@router.post("/{candidate_id}/confirm")
async def confirm_candidate(
    candidate_id: int,
    user_id: int = Query(1, description="확정 사용자 id (인증 도입 시 자동)"),
    db: AsyncSession = Depends(get_db),
):
    c = await db.get(AutoVoucherCandidate, candidate_id)
    if not c:
        raise HTTPException(status_code=404, detail="후보를 찾을 수 없습니다.")
    voucher = await _confirm_candidate_inner(db, c, user_id)
    await db.commit()
    return {"candidate_id": c.id, "voucher_id": voucher.id, "status": c.status.value}


class DirectVoucherLine(BaseModel):
    side: str  # 'debit' | 'credit'
    account_code: str
    account_name: str
    amount: Decimal
    memo: Optional[str] = ""


class DirectVoucherRequest(BaseModel):
    """매입매출 전표 직접 입력 — candidate 단계 skip, 즉시 Voucher 생성."""
    transaction_date: date
    source_type: str = Field(..., description="거래 유형 (sales_tax_invoice|purchase_tax_invoice|card|cash_receipt 등)")
    counterparty: Optional[str] = None
    description: Optional[str] = None
    supply_amount: Decimal = Decimal("0")
    vat_amount: Decimal = Decimal("0")
    debit_lines: List[DirectVoucherLine]
    credit_lines: List[DirectVoucherLine]
    external_ref: Optional[str] = None
    force: bool = Field(False, description="중복 후보가 있어도 강제 저장")


async def _find_duplicate_candidates(
    db: AsyncSession,
    transaction_date: date,
    total_amount: Decimal,
    counterparty: Optional[str],
    amount_tolerance: Decimal = Decimal("1"),
) -> List[dict]:
    """
    같은 (날짜±3일, 금액±tolerance, 거래처 일부일치)인 기존 거래 검색.
    그랜터 자동 후보 + 확정 Voucher 모두 검사.
    """
    from datetime import timedelta as _td
    results = []

    # 1) PENDING / CONFIRMED AutoVoucherCandidate
    q = select(AutoVoucherCandidate).where(
        AutoVoucherCandidate.transaction_date.between(
            transaction_date - _td(days=3), transaction_date + _td(days=3)
        ),
        AutoVoucherCandidate.status.in_([AutoVoucherStatus.PENDING, AutoVoucherStatus.CONFIRMED]),
        AutoVoucherCandidate.total_amount.between(
            total_amount - amount_tolerance, total_amount + amount_tolerance
        ),
    )
    if counterparty:
        q = q.where(AutoVoucherCandidate.counterparty.ilike(f"%{counterparty[:10]}%"))
    cands = (await db.execute(q.limit(5))).scalars().all()
    for c in cands:
        results.append({
            "kind": "auto_candidate",
            "id": c.id,
            "status": c.status.value,
            "transaction_date": c.transaction_date.isoformat(),
            "counterparty": c.counterparty,
            "total_amount": str(c.total_amount),
            "source_type": c.source_type.value,
        })

    # 2) 확정 Voucher
    vq = select(Voucher).where(
        Voucher.transaction_date.between(
            transaction_date - _td(days=3), transaction_date + _td(days=3)
        ),
        Voucher.status == VoucherStatus.CONFIRMED,
        Voucher.total_debit.between(
            total_amount - amount_tolerance, total_amount + amount_tolerance
        ),
    )
    if counterparty:
        vq = vq.where(Voucher.merchant_name.ilike(f"%{counterparty[:10]}%"))
    vouchers = (await db.execute(vq.limit(5))).scalars().all()
    for v in vouchers:
        results.append({
            "kind": "voucher",
            "id": v.id,
            "voucher_number": v.voucher_number,
            "transaction_date": v.transaction_date.isoformat(),
            "counterparty": v.merchant_name,
            "total_amount": str(v.total_debit),
            "source": v.source,
        })
    return results


@router.post("/check-duplicate")
async def check_duplicate(
    transaction_date: date = Body(...),
    total_amount: Decimal = Body(...),
    counterparty: Optional[str] = Body(None),
    db: AsyncSession = Depends(get_db),
):
    """수기 입력 화면에서 호출 — 같은 거래가 이미 있는지 사전 확인."""
    dups = await _find_duplicate_candidates(db, transaction_date, total_amount, counterparty)
    return {"duplicates": dups, "count": len(dups)}


@router.post("/direct-voucher")
async def create_direct_voucher(
    req: DirectVoucherRequest,
    user_id: int = Query(1),
    department_id: int = Query(1),
    db: AsyncSession = Depends(get_db),
):
    """
    매입매출 전표 입력 화면에서 사용 — 사용자가 입력한 라인을 바로 Voucher로 변환.
    AutoVoucherCandidate 단계를 거치지 않음 (audit 위해 raw_data만 보관).
    """
    total_debit = sum(Decimal(str(l.amount)) for l in req.debit_lines)
    total_credit = sum(Decimal(str(l.amount)) for l in req.credit_lines)
    if total_debit != total_credit:
        raise HTTPException(status_code=400,
                            detail=f"차변 합({total_debit}) ≠ 대변 합({total_credit})")
    if total_debit == 0:
        raise HTTPException(status_code=400, detail="금액이 0입니다.")

    # 중복 검사 — 그랜터 자동 후보·기존 확정 전표와 매칭
    if not req.force:
        dups = await _find_duplicate_candidates(
            db, req.transaction_date, total_debit, req.counterparty,
        )
        if dups:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "duplicate_candidates",
                    "message": f"비슷한 거래 {len(dups)}건이 이미 있습니다. 다시 등록하려면 force=true.",
                    "duplicates": dups,
                },
            )

    try:
        src = AutoVoucherSourceType(req.source_type)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"invalid source_type: {req.source_type}")

    txn_type_map = {
        AutoVoucherSourceType.CARD: TransactionType.CARD,
        AutoVoucherSourceType.BANK: TransactionType.BANK_TRANSFER,
        AutoVoucherSourceType.CASH_RECEIPT: TransactionType.CASH,
        AutoVoucherSourceType.SALES_TAX_INVOICE: TransactionType.TAX_INVOICE,
        AutoVoucherSourceType.PURCHASE_TAX_INVOICE: TransactionType.TAX_INVOICE,
        AutoVoucherSourceType.SALES_INVOICE: TransactionType.TAX_INVOICE,
        AutoVoucherSourceType.PURCHASE_INVOICE: TransactionType.TAX_INVOICE,
    }
    txn_type = txn_type_map.get(src, TransactionType.GENERAL)

    voucher = Voucher(
        voucher_number=await _voucher_number(db, req.transaction_date),
        voucher_date=req.transaction_date,
        transaction_date=req.transaction_date,
        description=(req.description or req.counterparty or "")[:500],
        transaction_type=txn_type,
        external_ref=req.external_ref,
        source="manual",
        department_id=department_id,
        created_by=user_id,
        total_debit=total_debit,
        total_credit=total_credit,
        status=VoucherStatus.CONFIRMED,
        merchant_name=req.counterparty,
        confirmed_at=datetime.utcnow(),
        confirmed_by=user_id,
    )
    db.add(voucher)
    await db.flush()

    line_no = 1
    for l in req.debit_lines + req.credit_lines:
        is_debit = l.side == "debit"
        amt = Decimal(str(l.amount))
        account_id = await _resolve_account_id(db, l.account_code, l.account_name)
        if account_id is None:
            raise HTTPException(status_code=400,
                                detail=f"계정 매핑 실패: code={l.account_code}")
        vat_acc = l.account_code in ("135", "255")
        db.add(VoucherLine(
            voucher_id=voucher.id,
            line_number=line_no,
            account_id=account_id,
            debit_amount=amt if is_debit else Decimal("0"),
            credit_amount=amt if not is_debit else Decimal("0"),
            vat_amount=amt if vat_acc else Decimal("0"),
            supply_amount=amt if not vat_acc else Decimal("0"),
            description=l.memo or "",
            counterparty_name=req.counterparty,
        ))
        line_no += 1

    await db.commit()
    return {
        "voucher_id": voucher.id,
        "voucher_number": voucher.voucher_number,
        "status": voucher.status.value,
        "total_debit": str(total_debit),
        "total_credit": str(total_credit),
    }


class MigrateJournalRequest(BaseModel):
    upload_ids: Optional[List[int]] = Field(None, description="특정 업로드만 (없으면 모든 분개장 업로드)")
    start_date: Optional[date] = Field(None, description="ai_raw.transaction_date 기간 필터 시작")
    end_date: Optional[date] = Field(None, description="ai_raw.transaction_date 기간 필터 종료")
    source_label: str = Field("wehago_import", description="Voucher.source 라벨")


@router.post("/delete-wehago-imports")
async def delete_wehago_imports(
    confirm_token: str = Query(..., description="확인 토큰: 'I_UNDERSTAND_DATA_LOSS' 필수"),
    source_label: str = Query("wehago_import"),
    background: bool = Query(True, description="기본 백그라운드 처리"),
):
    """
    위하고 import로 생성된 모든 Voucher 일괄 삭제 (회복 불가).
    background=true (default): task_id 즉시 반환, /progress/{task_id} 폴링.
    """
    if confirm_token != "I_UNDERSTAND_DATA_LOSS":
        raise HTTPException(status_code=400, detail="confirm_token 불일치")
    if background:
        task_id = await delete_wehago_imports_background(source_label=source_label)
        return {
            "task_id": task_id, "status": "queued",
            "progress_url": f"/api/v1/auto-voucher/progress/{task_id}",
        }
    return await delete_wehago_import_vouchers(source_label=source_label)


_MIGRATE_LOCK_ENABLED = False  # 정리 완료 — 변환 다시 허용


@router.post("/migrate-from-journal")
async def migrate_from_journal(
    req: MigrateJournalRequest,
    user_id: Optional[int] = Query(None, description="없으면 첫 번째 사용자 자동 사용"),
    department_id: Optional[int] = Query(None, description="없으면 첫 번째 부서 자동 사용"),
    background: bool = Query(True, description="true: task_id 즉시 반환 + 백그라운드 처리"),
    bypass_lock: bool = Query(False, description="LOCK 우회 (디버그용)"),
    db: AsyncSession = Depends(get_db),
):
    if _MIGRATE_LOCK_ENABLED and not bypass_lock:
        raise HTTPException(
            status_code=423,
            detail="분개장 변환이 일시 잠금 상태입니다 (데이터 정리 중). 잠시 후 다시 시도하세요.",
        )
    """
    위하고/더존 분개장 업로드(ai_raw)를 Voucher(CONFIRMED, source=wehago_import)로 일괄 변환.
    이미 변환된 그룹(external_ref 매칭)은 skip — idempotent.

    background=true (default): task_id 즉시 반환, /progress/{task_id} 폴링으로 진행률 추적.
    수천 개 그룹 처리 시 동기 요청은 timeout 됨.
    """
    if req.start_date and req.end_date and req.end_date < req.start_date:
        raise HTTPException(status_code=400, detail="end_date < start_date")

    if background:
        task_id = await migrate_journal_uploads_background(
            upload_ids=req.upload_ids,
            start_date=req.start_date,
            end_date=req.end_date,
            user_id=user_id,
            department_id=department_id,
            source_label=req.source_label,
        )
        return {
            "task_id": task_id,
            "status": "queued",
            "progress_url": f"/api/v1/auto-voucher/progress/{task_id}",
        }

    return await migrate_journal_uploads_to_vouchers(
        db,
        upload_ids=req.upload_ids,
        start_date=req.start_date,
        end_date=req.end_date,
        user_id=user_id,
        department_id=department_id,
        source_label=req.source_label,
    )


@router.post("/backfill-line-descriptions")
async def backfill_line_descriptions(
    confirm_token: str = Query(..., description="확인 토큰: 'I_UNDERSTAND' 필수"),
    db: AsyncSession = Depends(get_db),
):
    """
    voucher_lines.description이 비어있거나 거래처와 동일한 행을 더 풍부하게 보정.

    v2 알고리즘:
    - candidate.raw_data가 있으면 카드명/가맹점/카테고리 추출 → 적요 재구성
    - 그 외엔 voucher.description + ' · ' + 계정명으로 차별화
    """
    from sqlalchemy import text as _text
    if confirm_token != "I_UNDERSTAND":
        raise HTTPException(status_code=400, detail="confirm_token 불일치 (I_UNDERSTAND 필수)")

    # 1단계: candidate.raw_data 활용해서 풍부한 description으로 재구성
    candidates = (await db.execute(
        select(AutoVoucherCandidate).where(
            AutoVoucherCandidate.confirmed_voucher_id.isnot(None),
            AutoVoucherCandidate.raw_data.isnot(None),
        )
    )).scalars().all()

    enriched_descs: Dict[int, str] = {}  # voucher_id → rich_desc
    for c in candidates:
        try:
            raw = json.loads(c.raw_data) if c.raw_data else {}
        except Exception:
            raw = {}
        cu = raw.get("cardUsage") or {}
        bt = raw.get("bankTransaction") or {}
        ti = raw.get("taxInvoice") or {}
        cr = raw.get("cashReceipt") or {}

        parts = []
        if cu:
            card = cu.get("card") or {}
            cn = (card.get("nickname") or card.get("name") or "").split('|')[0].strip()
            store = cu.get("storeName") or ""
            cat = cu.get("category") or ""
            if cn: parts.append(cn)
            if store: parts.append(store)
            if cat: parts.append(f"({cat})")
        elif bt:
            opp = bt.get("opponent") or bt.get("counterparty") or ""
            content = bt.get("content") or ""
            if opp: parts.append(opp)
            if content and content != opp: parts.append(content)
        elif ti:
            party = (ti.get("contractor") or ti.get("supplier") or {}).get("companyName", "")
            if party: parts.append(f"세금계산서 · {party}")
        elif cr:
            issuer = (cr.get("issuer") or {}).get("companyName", "")
            if issuer: parts.append(f"현금영수증 · {issuer}")

        rich = " · ".join(parts) if parts else (c.description or c.counterparty or "")
        if rich:
            enriched_descs[c.confirmed_voucher_id] = rich[:500]

    # 2단계: voucher_line별 적요 = (rich_desc 또는 voucher.description) + " · " + 계정명
    # 한 번에 SQL로 처리 (CTE 활용)
    updated = 0
    if enriched_descs:
        # voucher_id → rich_desc dict를 SQL VALUES로 전달
        from sqlalchemy import bindparam
        chunks = list(enriched_descs.items())
        CHUNK = 500
        for i in range(0, len(chunks), CHUNK):
            batch = chunks[i:i + CHUNK]
            values_sql = ", ".join(f"({v_id}, :d_{idx})" for idx, (v_id, _) in enumerate(batch))
            params = {f"d_{idx}": d for idx, (_, d) in enumerate(batch)}
            stmt = _text(f"""
                WITH new_desc(voucher_id, rich) AS (VALUES {values_sql})
                UPDATE voucher_lines vl
                SET description = nd.rich || ' · ' || COALESCE(a.name, '')
                FROM new_desc nd
                JOIN accounts a ON a.id = vl.account_id
                WHERE vl.voucher_id = nd.voucher_id
            """)
            r = await db.execute(stmt, params)
            updated += r.rowcount or 0
        await db.commit()

    # 3단계: 나머지 (raw_data 없는 voucher 등) — voucher.description + 계정명
    fallback_result = await db.execute(_text("""
        UPDATE voucher_lines vl
        SET description = COALESCE(NULLIF(v.description, ''), '거래') || ' · ' || COALESCE(a.name, '')
        FROM vouchers v
        JOIN accounts a ON a.id = vl.account_id
        WHERE vl.voucher_id = v.id
          AND v.id = vl.voucher_id
          AND (
            vl.description IS NULL OR vl.description = '' OR vl.description = v.description
            OR vl.description = COALESCE(v.merchant_name, '')
          )
    """))
    fallback_updated = fallback_result.rowcount or 0
    await db.commit()

    return {
        "enriched_from_raw": updated,
        "fallback_updated": fallback_updated,
        "total_candidates_processed": len(candidates),
    }


@router.post("/reject-confirmed-period")
async def reject_confirmed_period(
    start_date: date = Query(...),
    end_date: date = Query(...),
    db: AsyncSession = Depends(get_db),
):
    """
    확정 분개장(위하고/더존 import) 기간의 PENDING 후보를 모두 REJECTED 처리.
    이미 회계 완료된 거래라 별도 voucher 생성 불필요.
    """
    return await reject_candidates_in_confirmed_period(db, start_date, end_date)


@router.post("/match-voucher-duplicates")
async def match_voucher_duplicates(
    start_date: date = Query(...),
    end_date: date = Query(...),
    mode: str = Query("grouped", description="grouped(분개 묶음 매칭, 추천) | strict(1:1 amount 비교)"),
    db: AsyncSession = Depends(get_db),
):
    """
    PENDING 후보 중 기존 Voucher (위하고 import 등)와 중복인 것 매칭.

    mode=grouped (default): 분개 단위 묶음 매칭 — 위하고 voucher 1개가 그랜터 거래 N개를 묶음.
      매칭 조건: 날짜±3, 정규화 거래처 일치만 (amount 비교 없음).
      위하고 분개장이 회계 처리 완료된 거래만 모아 합산되어 있어 amount 1:1 매칭 안 됨.
    mode=strict: 1:1 amount 매칭 (기존).
    """
    if mode == "grouped":
        return await match_voucher_duplicates_grouped(db, start_date, end_date)
    return await match_voucher_duplicates_core(db, start_date, end_date)


async def _confirm_batch_background(candidate_ids: List[int], user_id: int) -> str:
    """
    대량 확정 백그라운드 — bulk INSERT로 5~10배 빠르게.

    핵심 최적화:
    1. account preload (단일 SELECT)
    2. candidate 일괄 fetch
    3. in-memory validation (차변=대변, 부가세 자동 보정)
    4. Voucher INSERT 단일 SQL (RETURNING id)
    5. VoucherLine INSERT 단일 SQL
    6. AutoVoucherCandidate UPDATE 단일 SQL
    """
    import asyncio, time as _time
    from sqlalchemy import insert as sa_insert, update as sa_update
    from app.services.auto_voucher_service import _new_task, _update
    from app.core.database import async_session_factory
    from app.services.journal_migration import _ensure_base_data

    task_id = _new_task(f"{len(candidate_ids)}건 일괄 확정 시작…")

    async def _runner():
        try:
            # 0. FK 시드 보장 (별도 connection)
            dept_id, uid = await _ensure_base_data()

            async with async_session_factory() as db:
                # 1. account preload
                account_cache: Dict[str, int] = {}
                preload = (await db.execute(
                    select(Account.code, Account.id).where(Account.is_active == True)
                )).all()
                for code, aid in preload:
                    if code:
                        account_cache[code] = aid

                # account_categories 캐시 (자동 생성 시 사용)
                from app.models.accounting import AccountCategory
                cat_rows = (await db.execute(
                    select(AccountCategory.code, AccountCategory.id)
                )).all()
                cat_map = {code: cid for code, cid in cat_rows}
                cat_code_lookup = {'1': '1', '2': '2', '3': '3', '4': '4',
                                   '5': '5', '6': '5', '7': '5', '8': '5', '9': '5'}

                txn_type_map = {
                    AutoVoucherSourceType.CARD: TransactionType.CARD,
                    AutoVoucherSourceType.BANK: TransactionType.BANK_TRANSFER,
                    AutoVoucherSourceType.CASH_RECEIPT: TransactionType.CASH,
                    AutoVoucherSourceType.SALES_TAX_INVOICE: TransactionType.TAX_INVOICE,
                    AutoVoucherSourceType.PURCHASE_TAX_INVOICE: TransactionType.TAX_INVOICE,
                    AutoVoucherSourceType.SALES_INVOICE: TransactionType.TAX_INVOICE,
                    AutoVoucherSourceType.PURCHASE_INVOICE: TransactionType.TAX_INVOICE,
                }

                success_count = 0
                failure_count = 0
                failures: List[Dict[str, Any]] = []
                CHUNK = 200
                total = len(candidate_ids)

                for start in range(0, total, CHUNK):
                    chunk_ids = candidate_ids[start:start + CHUNK]
                    cands = (await db.execute(
                        select(AutoVoucherCandidate).where(AutoVoucherCandidate.id.in_(chunk_ids))
                    )).scalars().all()

                    # === in-memory validation + 새 account 식별 ===
                    voucher_rows: List[Dict[str, Any]] = []
                    line_specs_per_voucher: List[List[Dict[str, Any]]] = []
                    candidate_ids_ok: List[int] = []
                    new_account_codes: Dict[str, str] = {}  # code → name

                    for c in cands:
                        # 이미 confirmed면 성공 카운트 (idempotent — 다른 task가 먼저 처리)
                        if c.status == AutoVoucherStatus.CONFIRMED:
                            success_count += 1
                            continue
                        if c.status != AutoVoucherStatus.PENDING:
                            # rejected/duplicate 등은 skip (실패 아님)
                            continue
                        try:
                            debit_lines = json.loads(c.debit_lines or "[]")
                            credit_lines = json.loads(c.credit_lines or "[]")
                            td = sum(Decimal(str(l.get("amount", 0))) for l in debit_lines)
                            tc = sum(Decimal(str(l.get("amount", 0))) for l in credit_lines)

                            if td != tc:
                                diff = tc - td
                                total_abs = max(abs(td), abs(tc), Decimal("1"))
                                ratio = abs(diff) / total_abs
                                if Decimal("0.08") <= ratio <= Decimal("0.11"):
                                    if diff > 0:
                                        debit_lines.append({
                                            "side": "debit", "account_code": "135",
                                            "account_name": "부가세대급금",
                                            "amount": str(diff), "memo": "자동 보정 (부가세 추정)",
                                        })
                                    else:
                                        credit_lines.append({
                                            "side": "credit", "account_code": "255",
                                            "account_name": "부가세예수금",
                                            "amount": str(-diff), "memo": "자동 보정 (부가세 추정)",
                                        })
                                    td = sum(Decimal(str(l.get("amount", 0))) for l in debit_lines)
                                    tc = sum(Decimal(str(l.get("amount", 0))) for l in credit_lines)

                            if td != tc:
                                failure_count += 1
                                failures.append({
                                    "candidate_id": c.id,
                                    "reason": f"차변({td}) ≠ 대변({tc}). 차이 {tc-td}",
                                })
                                continue

                            # 새 account 식별 (preload 안 된 것)
                            line_specs = []
                            ok = True
                            for l in debit_lines + credit_lines:
                                code = (l.get("account_code") or "").strip()
                                if not code:
                                    continue
                                if code not in account_cache:
                                    new_account_codes[code] = l.get("account_name") or f"계정 {code}"
                                line_specs.append({
                                    "side": l.get("side"),
                                    "code": code,
                                    "amount": Decimal(str(l.get("amount", 0))),
                                    "memo": l.get("memo", ""),
                                })
                            if not line_specs:
                                failure_count += 1
                                failures.append({"candidate_id": c.id, "reason": "유효한 라인 없음"})
                                continue

                            voucher_rows.append({
                                "candidate": c,
                                "txn_type": txn_type_map.get(c.source_type, TransactionType.GENERAL),
                                "total_debit": td,
                                "total_credit": tc,
                                "line_specs": line_specs,
                            })
                            line_specs_per_voucher.append(line_specs)
                            candidate_ids_ok.append(c.id)
                        except Exception as e:
                            failure_count += 1
                            failures.append({"candidate_id": c.id, "reason": str(e)[:200]})

                    # === 새 account 일괄 생성 ===
                    if new_account_codes:
                        new_acc_rows = []
                        for code, name in new_account_codes.items():
                            first = code.lstrip("0")[:1] if code else "9"
                            cat_code = cat_code_lookup.get(first, '5')
                            cat_id = cat_map.get(cat_code) or (list(cat_map.values())[0] if cat_map else None)
                            if cat_id is None:
                                continue
                            new_acc_rows.append({
                                "code": code, "name": name, "category_id": cat_id,
                                "level": 1, "is_detail": True,
                                "is_vat_applicable": True, "vat_rate": Decimal("10.00"),
                                "is_active": True,
                                "created_at": datetime.utcnow(), "updated_at": datetime.utcnow(),
                            })
                        if new_acc_rows:
                            try:
                                inserted = await db.execute(
                                    sa_insert(Account).returning(Account.code, Account.id),
                                    new_acc_rows,
                                )
                                for code, aid in inserted.all():
                                    account_cache[code] = aid
                            except Exception:
                                logger.exception("account bulk insert 실패")

                    # === Voucher ORM bulk add (add_all + flush — enum 자동 변환) ===
                    now = datetime.utcnow()
                    voucher_objs: List[Voucher] = []
                    for v in voucher_rows:
                        c = v["candidate"]
                        voucher_objs.append(Voucher(
                            voucher_number=f"{c.transaction_date.strftime('%Y%m%d')}-G{_uuid.uuid4().hex[:8]}",
                            voucher_date=c.transaction_date,
                            transaction_date=c.transaction_date,
                            description=(c.description or c.counterparty or "")[:500],
                            transaction_type=v["txn_type"],
                            external_ref=c.source_id,
                            source="granter_auto",
                            department_id=dept_id,
                            created_by=uid,
                            total_debit=v["total_debit"],
                            total_credit=v["total_credit"],
                            status=VoucherStatus.CONFIRMED,
                            merchant_name=c.counterparty,
                            ai_confidence_score=c.confidence,
                            confirmed_at=now,
                            confirmed_by=uid,
                        ))

                    if voucher_objs:
                        try:
                            db.add_all(voucher_objs)
                            await db.flush()  # 모든 voucher.id 채워짐
                        except Exception as e:
                            logger.exception("Voucher bulk add 실패")
                            for c_id in candidate_ids_ok:
                                failure_count += 1
                                failures.append({"candidate_id": c_id, "reason": f"voucher 실패: {str(e)[:150]}"})
                            try: await db.rollback()
                            except Exception: pass
                            voucher_objs = []

                    # === VoucherLine bulk add ===
                    if voucher_objs:
                        line_objs: List[VoucherLine] = []
                        for voucher_idx, (voucher, specs) in enumerate(zip(voucher_objs, line_specs_per_voucher)):
                            v_row = voucher_rows[voucher_idx]
                            cand = v_row["candidate"]
                            # 적요 fallback: line.memo > candidate.description > counterparty
                            cand_desc = (cand.description or cand.counterparty or "")[:500]
                            line_no = 1
                            for spec in specs:
                                acc_id = account_cache.get(spec["code"])
                                if not acc_id:
                                    continue
                                is_debit = spec["side"] == "debit"
                                amt = spec["amount"]
                                vat_acc = spec["code"] in ("135", "255")
                                line_memo = (spec.get("memo") or "").strip()
                                line_desc = (line_memo or cand_desc or "")[:500]
                                line_objs.append(VoucherLine(
                                    voucher_id=voucher.id,
                                    line_number=line_no,
                                    account_id=acc_id,
                                    debit_amount=amt if is_debit else Decimal("0"),
                                    credit_amount=amt if not is_debit else Decimal("0"),
                                    vat_amount=amt if vat_acc else Decimal("0"),
                                    supply_amount=amt if not vat_acc else Decimal("0"),
                                    description=line_desc,
                                    counterparty_name=cand.counterparty,
                                ))
                                line_no += 1
                        if line_objs:
                            db.add_all(line_objs)

                        # Candidate UPDATE — bulk
                        candidate_to_voucher = {
                            voucher_rows[i]["candidate"].id: voucher_objs[i].id
                            for i in range(len(voucher_objs))
                        }
                        for c_id, v_id in candidate_to_voucher.items():
                            await db.execute(
                                sa_update(AutoVoucherCandidate)
                                .where(AutoVoucherCandidate.id == c_id)
                                .values(
                                    status=AutoVoucherStatus.CONFIRMED,
                                    confirmed_voucher_id=v_id,
                                    confirmed_at=now,
                                    confirmed_by=uid,
                                )
                            )
                        success_count += len(voucher_objs)

                    try:
                        await db.commit()
                    except Exception:
                        logger.exception("청크 commit 실패")
                        try: await db.rollback()
                        except Exception: pass

                    processed = start + len(chunk_ids)
                    pct = 10 + int(85 * processed / max(total, 1))
                    _update(
                        task_id, percent=pct,
                        message=f"진행 {processed}/{total} — 확정 {success_count}건, 실패 {failure_count}건",
                        success_count=success_count,
                        failure_count=failure_count,
                        recent_failures=[f["reason"] for f in failures[-5:]],
                    )
                    await asyncio.sleep(0)

                _update(
                    task_id, status="completed", percent=100,
                    message=f"완료 — 확정 {success_count}건, 실패 {failure_count}건",
                    result={
                        "total": total,
                        "success_count": success_count,
                        "failure_count": failure_count,
                        "failures": failures[:50],
                    },
                    finished_at=_time.time(),
                )
        except Exception as e:
            logger.exception("confirm-batch 백그라운드 실패")
            _update(
                task_id, status="failed",
                message=f"실패: {str(e)[:300]}",
                finished_at=_time.time(),
            )

    asyncio.create_task(_runner())
    return task_id


@router.post("/confirm-batch")
async def confirm_batch(
    candidate_ids: List[int] = Body(...),
    user_id: int = Body(1),
    background: bool = Body(False, description="true: task_id 즉시 반환 + 백그라운드 처리"),
    db: AsyncSession = Depends(get_db),
):
    """다중 확정 — 라인 합이 안 맞는 후보는 실패 처리하고 나머지는 진행.

    응답:
      success_count — 새로 confirmed
      already_confirmed_count — 이번 호출 이전에 이미 confirmed (idempotent 성공)
      skipped_count — rejected/duplicate (실패 아님)
      failure_count — 실제 처리 실패 (분개 오류 등)

    background=true (또는 200건 초과): task_id 반환 + 폴링.
    """
    if background or len(candidate_ids) > 200:
        task_id = await _confirm_batch_background(candidate_ids, user_id)
        return {
            "task_id": task_id,
            "status": "queued",
            "total": len(candidate_ids),
            "progress_url": f"/api/v1/auto-voucher/progress/{task_id}",
        }

    rows = (await db.execute(
        select(AutoVoucherCandidate).where(AutoVoucherCandidate.id.in_(candidate_ids))
    )).scalars().all()

    seed_cache: Dict[str, int] = {}
    success = []
    already_confirmed = []
    skipped = []
    failures = []
    for c in rows:
        # 사전 분기 — 이미 confirmed면 idempotent 성공
        if c.status == AutoVoucherStatus.CONFIRMED:
            already_confirmed.append({
                "candidate_id": c.id, "voucher_id": c.confirmed_voucher_id,
            })
            continue
        # rejected/duplicate은 skip (실패 아님)
        if c.status != AutoVoucherStatus.PENDING:
            skipped.append({"candidate_id": c.id, "status": c.status.value})
            continue

        savepoint = await db.begin_nested()
        try:
            voucher = await _confirm_candidate_inner(db, c, user_id, _seed_cache=seed_cache)
            await savepoint.commit()
            success.append({"candidate_id": c.id, "voucher_id": voucher.id})
        except HTTPException as e:
            try: await savepoint.rollback()
            except Exception: pass
            failures.append({"candidate_id": c.id, "reason": str(e.detail)[:200]})
        except Exception as e:
            try: await savepoint.rollback()
            except Exception: pass
            logger.exception(f"confirm-batch 항목 실패 (id={c.id})")
            failures.append({"candidate_id": c.id, "reason": str(e)[:200]})

    await db.commit()
    return {
        "total": len(rows),
        "success_count": len(success),
        "already_confirmed_count": len(already_confirmed),
        "skipped_count": len(skipped),
        "failure_count": len(failures),
        "success": success,
        "already_confirmed": already_confirmed,
        "skipped": skipped,
        "failures": failures,
    }
