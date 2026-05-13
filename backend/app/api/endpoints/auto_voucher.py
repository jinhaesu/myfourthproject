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
from typing import Optional, List

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
    get_progress,
)


async def _voucher_number(db: AsyncSession, vdate: date) -> str:
    """YYYYMMDD-NNNN 형식 전표번호. 일자별 시퀀스."""
    prefix = vdate.strftime('%Y%m%d')
    cnt = await db.scalar(
        select(func.count(Voucher.id)).where(Voucher.voucher_number.like(f"{prefix}-%"))
    ) or 0
    return f"{prefix}-{cnt + 1:04d}"


async def _resolve_account_id(db: AsyncSession, code: str, name: str = "") -> Optional[int]:
    """account_code → accounts.id. 없으면 자동 생성."""
    if not code:
        return None
    acc = (await db.execute(
        select(Account).where(Account.code == code, Account.is_active == True)
    )).scalar_one_or_none()
    if acc:
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
    confirmed_voucher_id: Optional[int]
    created_at: datetime


class CandidatePatch(BaseModel):
    debit_lines: Optional[List[CandidateLine]] = None
    credit_lines: Optional[List[CandidateLine]] = None
    counterparty: Optional[str] = None
    description: Optional[str] = None
    suggested_account_code: Optional[str] = None
    suggested_account_name: Optional[str] = None


def _candidate_to_out(c: AutoVoucherCandidate) -> CandidateOut:
    def _parse_lines(s: Optional[str]) -> List[CandidateLine]:
        if not s:
            return []
        try:
            arr = json.loads(s)
            return [CandidateLine(**item) for item in arr]
        except Exception:
            return []
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
    size: int = Query(50, ge=1, le=500),
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
        "items": [_candidate_to_out(c) for c in rows],
        "summary": summary,
    }


@router.get("/{candidate_id}")
async def get_candidate(
    candidate_id: int,
    db: AsyncSession = Depends(get_db),
):
    c = await db.get(AutoVoucherCandidate, candidate_id)
    if not c:
        raise HTTPException(status_code=404, detail="후보를 찾을 수 없습니다.")
    return _candidate_to_out(c)


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
    db: AsyncSession, c: AutoVoucherCandidate, user_id: int, department_id: int = 1
) -> Voucher:
    """후보 → Voucher + VoucherLine 변환."""
    if c.status != AutoVoucherStatus.PENDING:
        raise HTTPException(status_code=400,
                            detail=f"PENDING 상태가 아닙니다 (id={c.id}, status={c.status.value})")

    debit_lines = json.loads(c.debit_lines or "[]")
    credit_lines = json.loads(c.credit_lines or "[]")

    total_debit = sum(Decimal(str(l.get("amount", 0))) for l in debit_lines)
    total_credit = sum(Decimal(str(l.get("amount", 0))) for l in credit_lines)
    if total_debit != total_credit:
        raise HTTPException(status_code=400,
                            detail=f"차변 합({total_debit}) ≠ 대변 합({total_credit}). 라인 수정 필요.")

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

    line_no = 1
    for l in debit_lines + credit_lines:
        is_debit = l.get("side") == "debit"
        amt = Decimal(str(l.get("amount", 0)))
        account_id = await _resolve_account_id(
            db, l.get("account_code", ""), l.get("account_name", "")
        )
        if account_id is None:
            raise HTTPException(status_code=400,
                                detail=f"계정 매핑 실패: code={l.get('account_code')}")
        # 부가세대급금(135)·예수금(255) 라인은 vat_amount 보관 — 추후 부가세 신고용
        vat_acc = l.get("account_code") in ("135", "255")
        db.add(VoucherLine(
            voucher_id=voucher.id,
            line_number=line_no,
            account_id=account_id,
            debit_amount=amt if is_debit else Decimal("0"),
            credit_amount=amt if not is_debit else Decimal("0"),
            vat_amount=amt if vat_acc else Decimal("0"),
            supply_amount=amt if not vat_acc else Decimal("0"),
            description=l.get("memo", ""),
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


@router.post("/confirm-batch")
async def confirm_batch(
    candidate_ids: List[int] = Body(...),
    user_id: int = Body(1),
    db: AsyncSession = Depends(get_db),
):
    """다중 확정 — 라인 합이 안 맞는 후보는 실패 처리하고 나머지는 진행."""
    rows = (await db.execute(
        select(AutoVoucherCandidate).where(AutoVoucherCandidate.id.in_(candidate_ids))
    )).scalars().all()

    success = []
    failures = []
    for c in rows:
        try:
            voucher = await _confirm_candidate_inner(db, c, user_id)
            success.append({"candidate_id": c.id, "voucher_id": voucher.id})
        except HTTPException as e:
            failures.append({"candidate_id": c.id, "reason": e.detail})

    await db.commit()
    return {
        "total": len(rows),
        "success_count": len(success),
        "failure_count": len(failures),
        "success": success,
        "failures": failures,
    }
