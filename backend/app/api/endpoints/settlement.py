"""
Settlement API — 거래처 정산 (스켈레톤)
거래처 마스터 테이블 + 채권/채무 집계는 추후 보강. 현재는 mock 제거 + 빈 응답.
"""
from datetime import date, datetime
from decimal import Decimal
from typing import Optional
from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.schemas.settlement import (
    SettlementListResponse,
    SettlementDetailResponse,
    CounterpartyBalance,
    SettlementOffsetRequest,
    SettlementOffsetResponse,
    CounterpartyType,
    SettlementStatus,
)

router = APIRouter()


@router.get("/", response_model=SettlementListResponse)
async def list_settlements(
    counterparty_type: Optional[CounterpartyType] = None,
    status_filter: Optional[SettlementStatus] = Query(None, alias="status"),
    only_overdue: bool = False,
    search: Optional[str] = None,
    sort_by: str = "net_balance_desc",
    page: int = Query(1, ge=1),
    size: int = Query(50, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
):
    """
    거래처 정산 — TODO: ai_raw_transaction_data의 merchant_name별 GROUP BY로
    채권(108 외상매출금)/채무(251 외상매입금) 집계.
    """
    return SettlementListResponse(
        items=[],
        total_count=0,
        total_receivable=Decimal("0"),
        total_payable=Decimal("0"),
        total_net=Decimal("0"),
    )


@router.get("/{counterparty_id}", response_model=SettlementDetailResponse)
async def get_counterparty_settlement(
    counterparty_id: int,
    from_date: Optional[date] = None,
    to_date: Optional[date] = None,
    db: AsyncSession = Depends(get_db),
):
    """거래처 상세 — TODO: 실제 구현."""
    empty = CounterpartyBalance(
        counterparty_id=counterparty_id,
        counterparty_name="-",
        business_number=None,
        counterparty_type="customer",
        receivable_total=Decimal("0"),
        payable_total=Decimal("0"),
        net_balance=Decimal("0"),
        last_transaction_date=None,
        overdue_amount=Decimal("0"),
        status="pending",
        contact_person=None,
        contact_phone=None,
    )
    return SettlementDetailResponse(counterparty=empty, items=[])


@router.post("/offset", response_model=SettlementOffsetResponse)
async def create_offset(
    req: SettlementOffsetRequest,
    user_id: int = Query(...),
    db: AsyncSession = Depends(get_db),
):
    """상계 처리 — TODO."""
    return SettlementOffsetResponse(
        offset_id=0,
        counterparty_id=req.counterparty_id,
        offset_amount=req.offset_amount,
        affected_receivable_ids=req.receivable_ids,
        affected_payable_ids=req.payable_ids,
        new_net_balance=Decimal("0"),
        created_at=datetime.utcnow(),
    )


@router.post("/{counterparty_id}/send-statement")
async def send_settlement_statement(
    counterparty_id: int,
    delivery_method: str = Query("email", pattern="^(email|kakao|sms)$"),
    db: AsyncSession = Depends(get_db),
):
    return {
        "counterparty_id": counterparty_id,
        "delivery_method": delivery_method,
        "status": "queued",
    }


@router.get("/{counterparty_id}/aging")
async def get_counterparty_aging(
    counterparty_id: int,
    db: AsyncSession = Depends(get_db),
):
    return {
        "counterparty_id": counterparty_id,
        "current": "0",
        "days_1_30": "0",
        "days_31_60": "0",
        "days_61_90": "0",
        "days_over_90": "0",
        "total": "0",
    }
