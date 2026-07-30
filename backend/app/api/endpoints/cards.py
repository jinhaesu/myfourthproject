"""카드 관리 API

권한:
- 회계 관리자(ADMIN_EMAILS): 전체 카드 조회/별명 수정/배정 관리
- 일반 직원: 본인에게 배정된 카드만 조회 + 사용내역 분류 입력
"""
from datetime import date, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, Body, Query, HTTPException, status
from pydantic import BaseModel, EmailStr
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import get_current_user, is_accounting_admin
from app.services.card_management import (
    list_cards, upsert_alias, get_card_analysis, get_monthly_summary,
    assign_card, list_transactions, classify_transaction, get_assigned_card_keys,
    get_closing, close_month, list_closings, reopen_closing, _month_range,
    migrate_card_keys,
)

router = APIRouter()


class AliasUpdate(BaseModel):
    nickname: Optional[str] = None
    color: Optional[str] = None
    memo: Optional[str] = None
    is_active: Optional[bool] = None


class AssignBody(BaseModel):
    card_key: str
    email: Optional[EmailStr] = None  # None이면 배정 해제


class ClassifyBody(BaseModel):
    ticket_id: str
    card_key: str
    category: str                        # 원장 계정명 (표시용) — account_name과 동일
    account_code: Optional[str] = None   # 원장 계정 코드
    account_name: Optional[str] = None   # 원장 계정명
    memo: Optional[str] = None
    transact_at: Optional[str] = None
    store_name: Optional[str] = None
    amount: Optional[float] = None


class CloseMonthBody(BaseModel):
    card_key: str
    month: str  # 'YYYY-MM'


async def _ensure_card_access(db: AsyncSession, user, card_key: str):
    """직원은 배정된 카드만 접근 가능. 관리자는 전체."""
    if is_accounting_admin(user):
        return
    assigned = await get_assigned_card_keys(db, user.email)
    if card_key not in assigned:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="본인에게 배정된 카드가 아닙니다.",
        )


@router.get("/accounts")
async def list_accounts_for_classify(
    q: Optional[str] = Query(None, description="계정 코드/명 검색"),
    db: AsyncSession = Depends(get_db),
    user=Depends(get_current_user),
):
    """카드 사용 분류용 원장 계정과목 목록 (코드+명) — 직원도 접근 가능."""
    from sqlalchemy import select as _select
    from app.models.accounting import Account
    stmt = _select(Account).where(Account.is_active == True)  # noqa: E712
    if q:
        like = f"%{q}%"
        stmt = stmt.where(Account.code.ilike(like) | Account.name.ilike(like))
    stmt = stmt.order_by(Account.code)
    rows = (await db.execute(stmt)).scalars().all()
    return {"accounts": [{"code": a.code, "name": a.name} for a in rows]}


@router.get("/list")
async def list_cards_api(
    start_date: Optional[date] = Query(None),
    end_date: Optional[date] = Query(None),
    mine_only: bool = Query(False, description="본인 배정 카드만 (직원용 화면 — 관리자도 적용)"),
    db: AsyncSession = Depends(get_db),
    user=Depends(get_current_user),
):
    """카드 목록 — 관리자: 전체 / 직원: 본인 배정 카드만. mine_only=true면 관리자도 본인 카드만."""
    if mine_only or not is_accounting_admin(user):
        only = user.email
    else:
        only = None
    return {
        "cards": await list_cards(db, start_date, end_date, only_assigned_to=only),
        "is_admin": is_accounting_admin(user),
    }


@router.post("/admin/migrate-keys")
async def migrate_keys_api(
    body: dict = Body(default_factory=dict),
    db: AsyncSession = Depends(get_db),
    user=Depends(get_current_user),
):
    """
    기존 card_key(legacy 'org (last4)') → 그랜터 카드 id로 일괄 이관 (관리자 전용, 멱등).
    뒷4자리 충돌 방지용 키 체계 전환 시 1회 실행. 별칭/배정/마감/구매요청 카드키 보존.
    body.manual_map {legacy_key: id} 로 뒷4자리 충돌(모호) 건을 수동 해소 가능.
    """
    if not is_accounting_admin(user):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="관리자 전용")
    manual_map = body.get("manual_map") if isinstance(body, dict) else None
    report = await migrate_card_keys(db, manual_map=manual_map)
    return {"ok": True, "report": report}


@router.put("/alias")
async def update_alias(
    card_key: str = Query(...),
    body: AliasUpdate = Body(...),
    db: AsyncSession = Depends(get_db),
    user=Depends(get_current_user),
):
    """카드 별명/색상/메모 저장 (관리자 전용)."""
    if not is_accounting_admin(user):
        raise HTTPException(status_code=403, detail="회계 관리자 권한이 필요합니다.")
    alias = await upsert_alias(
        db, card_key,
        nickname=body.nickname,
        color=body.color,
        memo=body.memo,
        is_active=body.is_active,
    )
    return {
        "card_key": alias.card_key,
        "nickname": alias.nickname,
        "color": alias.color,
        "memo": alias.memo,
        "is_active": alias.is_active,
        "assigned_email": alias.assigned_email,
    }


@router.put("/assign")
async def assign_card_api(
    body: AssignBody,
    db: AsyncSession = Depends(get_db),
    user=Depends(get_current_user),
):
    """카드를 이메일에 배정/해제 (관리자 전용)."""
    if not is_accounting_admin(user):
        raise HTTPException(status_code=403, detail="회계 관리자 권한이 필요합니다.")
    alias = await assign_card(db, body.card_key, body.email)
    return {
        "card_key": alias.card_key,
        "assigned_email": alias.assigned_email,
    }


@router.get("/transactions")
async def card_transactions(
    card_key: str = Query(...),
    start_date: Optional[date] = Query(None),
    end_date: Optional[date] = Query(None),
    db: AsyncSession = Depends(get_db),
    user=Depends(get_current_user),
):
    """카드 사용내역 건별 목록 + 분류 상태. 직원은 배정 카드만."""
    await _ensure_card_access(db, user, card_key)
    if not end_date:
        end_date = date.today()
    if not start_date:
        start_date = end_date - timedelta(days=30)
    return {
        "card_key": card_key,
        "transactions": await list_transactions(db, card_key, start_date, end_date),
    }


@router.put("/transactions/classify")
async def classify_transaction_api(
    body: ClassifyBody,
    db: AsyncSession = Depends(get_db),
    user=Depends(get_current_user),
):
    """카드 사용 건 분류 저장. 직원은 배정 카드 건만. 마감된 월은 잠금(관리자 제외)."""
    await _ensure_card_access(db, user, body.card_key)
    if body.transact_at and len(body.transact_at) >= 7:
        closing = await get_closing(db, body.card_key, body.transact_at[:7])
        if closing and not is_accounting_admin(user):
            raise HTTPException(
                status_code=400,
                detail=f"{body.transact_at[:7]}월은 마감되어 수정할 수 없습니다. 관리자에게 마감 해제를 요청하세요.",
            )
    cls = await classify_transaction(
        db,
        ticket_id=body.ticket_id,
        card_key=body.card_key,
        category=body.category,
        account_code=body.account_code,
        account_name=body.account_name or body.category,
        memo=body.memo,
        classified_by=user.email,
        transact_at=body.transact_at,
        store_name=body.store_name,
        amount=body.amount,
    )
    return {
        "ticket_id": cls.ticket_id,
        "category": cls.category,
        "account_code": cls.account_code,
        "account_name": cls.account_name,
        "memo": cls.memo,
        "classified_by": cls.classified_by,
    }


@router.get("/closings")
async def list_closings_api(
    month: Optional[str] = Query(None, description="YYYY-MM"),
    db: AsyncSession = Depends(get_db),
    user=Depends(get_current_user),
):
    """월별 마감 목록 — 관리자: 전체 / 직원: 본인 배정 카드만."""
    only_keys = None
    if not is_accounting_admin(user):
        only_keys = await get_assigned_card_keys(db, user.email)
    return {"closings": await list_closings(db, month=month, only_card_keys=only_keys)}


@router.post("/closings")
async def close_month_api(
    body: CloseMonthBody,
    db: AsyncSession = Depends(get_db),
    user=Depends(get_current_user),
):
    """월 마감 제출 — 해당 월 전건 분류 필수. 직원은 배정 카드만."""
    await _ensure_card_access(db, user, body.card_key)
    try:
        closing = await close_month(db, body.card_key, body.month, user.email)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {
        "id": closing.id,
        "card_key": closing.card_key,
        "month": closing.month,
        "transaction_count": closing.transaction_count,
        "total_amount": closing.total_amount,
        "closed_by": closing.closed_by,
        "closed_at": closing.closed_at.isoformat() if closing.closed_at else None,
    }


@router.delete("/closings/{closing_id}")
async def reopen_closing_api(
    closing_id: int,
    db: AsyncSession = Depends(get_db),
    user=Depends(get_current_user),
):
    """마감 해제 (관리자 전용)."""
    if not is_accounting_admin(user):
        raise HTTPException(status_code=403, detail="회계 관리자 권한이 필요합니다.")
    if not await reopen_closing(db, closing_id):
        raise HTTPException(status_code=404, detail="마감 기록을 찾을 수 없습니다.")
    return {"ok": True}


@router.get("/closings/detail")
async def closing_detail(
    card_key: str = Query(...),
    month: str = Query(..., description="YYYY-MM"),
    db: AsyncSession = Depends(get_db),
    user=Depends(get_current_user),
):
    """마감 상세 — 그 달 건별 내역 + 분류 (관리자 검토용)."""
    await _ensure_card_access(db, user, card_key)
    start, end = _month_range(month)
    return {
        "card_key": card_key,
        "month": month,
        "closing": next(iter(await list_closings(db, month=month, only_card_keys=[card_key])), None),
        "transactions": await list_transactions(db, card_key, start, end),
    }


@router.get("/analysis")
async def card_analysis(
    card_key: str = Query(...),
    start_date: Optional[date] = Query(None),
    end_date: Optional[date] = Query(None),
    db: AsyncSession = Depends(get_db),
    user=Depends(get_current_user),
):
    """카드별 가맹점/카테고리/일별 분석. 직원은 배정 카드만."""
    await _ensure_card_access(db, user, card_key)
    if not end_date:
        end_date = date.today()
    if not start_date:
        start_date = end_date - timedelta(days=30)
    return await get_card_analysis(db, card_key, start_date, end_date)


@router.get("/monthly")
async def monthly_summary(
    card_key: Optional[str] = Query(None),
    months: int = Query(6, ge=1, le=12),
    db: AsyncSession = Depends(get_db),
    user=Depends(get_current_user),
):
    """월별 카드 사용액 — card_key=None면 전체 카드 합산 (전체 합산은 관리자 전용)."""
    if card_key:
        await _ensure_card_access(db, user, card_key)
    elif not is_accounting_admin(user):
        raise HTTPException(status_code=403, detail="회계 관리자 권한이 필요합니다.")
    return {"months": await get_monthly_summary(db, card_key, months)}
