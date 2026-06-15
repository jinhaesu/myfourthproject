"""카드 관리 API"""
from datetime import date, timedelta
from typing import Optional, List

from fastapi import APIRouter, Depends, Body, Query
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.services.card_management import (
    list_cards, upsert_alias, get_card_analysis, get_monthly_summary,
)

router = APIRouter()


class AliasUpdate(BaseModel):
    nickname: Optional[str] = None
    color: Optional[str] = None
    memo: Optional[str] = None
    is_active: Optional[bool] = None


@router.get("/list")
async def list_cards_api(
    start_date: Optional[date] = Query(None),
    end_date: Optional[date] = Query(None),
    db: AsyncSession = Depends(get_db),
):
    """카드 목록 — 그랜터 EXPENSE_TICKET distinct cardName + alias 정보."""
    return {"cards": await list_cards(db, start_date, end_date)}


@router.put("/alias")
async def update_alias(
    card_key: str = Query(...),
    body: AliasUpdate = Body(...),
    db: AsyncSession = Depends(get_db),
):
    """카드 별명/색상/메모 저장."""
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
    }


@router.get("/analysis")
async def card_analysis(
    card_key: str = Query(...),
    start_date: Optional[date] = Query(None),
    end_date: Optional[date] = Query(None),
    db: AsyncSession = Depends(get_db),
):
    """카드별 가맹점/카테고리/일별 분석."""
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
):
    """월별 카드 사용액 — card_key=None면 전체 카드 합산."""
    return {"months": await get_monthly_summary(db, card_key, months)}
