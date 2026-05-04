"""
Daily Cash Report API — 실시간 자금일보 (스켈레톤)
실제 일일 리포트 집계 로직은 추후 ai_raw_transaction_data 기반으로 보강 예정.
현재는 mock 제거 + 빈 응답으로 단순화.
"""
from datetime import date, datetime
from decimal import Decimal
from typing import Optional, List
from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.schemas.daily_report import (
    DailyReportResponse,
    DailyReportSummary,
    DailyReportSubscription,
    DailyReportSubscriptionCreate,
    DailyReportHistoryItem,
)

router = APIRouter()


def _empty_report(report_date: date) -> DailyReportResponse:
    return DailyReportResponse(
        summary=DailyReportSummary(
            report_date=report_date,
            total_balance=Decimal("0"),
            yesterday_balance=Decimal("0"),
            change_amount=Decimal("0"),
            change_pct=0.0,
            inbound_total=Decimal("0"),
            outbound_total=Decimal("0"),
            net_cashflow=Decimal("0"),
        ),
        accounts=[],
        top_inbound=[],
        top_outbound=[],
        upcoming_payments_amount=Decimal("0"),
        overdue_receivables_amount=Decimal("0"),
        generated_at=datetime.utcnow(),
    )


@router.get("/today", response_model=DailyReportResponse)
async def get_today_report(db: AsyncSession = Depends(get_db)):
    """오늘 자금일보 — TODO: ai_raw_transaction_data 기반 집계로 보강."""
    return _empty_report(date.today())


@router.get("/by-date", response_model=DailyReportResponse)
async def get_report_by_date(
    report_date: date = Query(...),
    db: AsyncSession = Depends(get_db),
):
    return _empty_report(report_date)


@router.post("/send-now")
async def send_report_now(
    report_date: Optional[date] = None,
    db: AsyncSession = Depends(get_db),
):
    """즉시 발송 — TODO: 실제 발송 큐 연결."""
    return {
        "status": "queued",
        "report_date": (report_date or date.today()).isoformat(),
        "subscriber_count": 0,
    }


@router.get("/subscriptions", response_model=List[DailyReportSubscription])
async def list_subscriptions(db: AsyncSession = Depends(get_db)):
    return []


@router.post("/subscriptions", response_model=DailyReportSubscription, status_code=status.HTTP_201_CREATED)
async def create_subscription(
    sub: DailyReportSubscriptionCreate,
    user_id: int = Query(...),
    db: AsyncSession = Depends(get_db),
):
    """구독 생성 — TODO: 실제 저장 로직."""
    return DailyReportSubscription(
        id=0,
        user_id=user_id,
        delivery_method=sub.delivery_method,
        delivery_target=sub.delivery_target,
        schedule_time=sub.schedule_time,
        is_active=True,
        include_attachments=sub.include_attachments,
    )


@router.delete("/subscriptions/{sub_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_subscription(sub_id: int, db: AsyncSession = Depends(get_db)):
    return


@router.get("/history", response_model=List[DailyReportHistoryItem])
async def list_send_history(
    limit: int = Query(30, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
):
    return []
