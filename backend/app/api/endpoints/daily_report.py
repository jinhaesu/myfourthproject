"""
Daily Cash Report API — 실시간 자금일보
매일 아침 발송하는 일일 자금 리포트 + 구독 관리

NOTE: 라우트 스켈레톤.
"""
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Optional, List
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.schemas.daily_report import (
    DailyReportResponse,
    DailyReportSummary,
    AccountBalanceSnapshot,
    CashFlowItem,
    DailyReportSubscription,
    DailyReportSubscriptionCreate,
    DailyReportHistoryItem,
)

router = APIRouter()


def _mock_report(report_date: date) -> DailyReportResponse:
    """TODO: 실제 일일 리포트 집계 로직으로 대체"""
    summary = DailyReportSummary(
        report_date=report_date,
        total_balance=Decimal("327540000"),
        yesterday_balance=Decimal("315420000"),
        change_amount=Decimal("12120000"),
        change_pct=3.84,
        inbound_total=Decimal("17820000"),
        outbound_total=Decimal("5700000"),
        net_cashflow=Decimal("12120000"),
    )

    accounts = [
        AccountBalanceSnapshot(
            bank_account_id=1, bank_name="신한은행", account_alias="운영계좌",
            account_number_masked="****-****-1234",
            opening_balance=Decimal("180000000"),
            closing_balance=Decimal("192000000"),
            change=Decimal("12000000"),
            inbound_total=Decimal("12000000"),
            outbound_total=Decimal("0"),
        ),
        AccountBalanceSnapshot(
            bank_account_id=2, bank_name="국민은행", account_alias="결제계좌",
            account_number_masked="****-****-5678",
            opening_balance=Decimal("85000000"),
            closing_balance=Decimal("82400000"),
            change=Decimal("-2600000"),
            inbound_total=Decimal("0"),
            outbound_total=Decimal("2600000"),
        ),
        AccountBalanceSnapshot(
            bank_account_id=3, bank_name="우리은행", account_alias="급여계좌",
            account_number_masked="****-****-9012",
            opening_balance=Decimal("50420000"),
            closing_balance=Decimal("53140000"),
            change=Decimal("2720000"),
            inbound_total=Decimal("5820000"),
            outbound_total=Decimal("3100000"),
        ),
    ]

    top_inbound = [
        CashFlowItem(transaction_id=101, transaction_time="09:42",
                     counterparty="(주)이마트", amount=Decimal("8500000"),
                     direction="inbound", description="식자재 납품 정산"),
        CashFlowItem(transaction_id=102, transaction_time="11:30",
                     counterparty="스마트로 PG", amount=Decimal("5820000"),
                     direction="inbound", description="카드 매출 정산"),
        CashFlowItem(transaction_id=103, transaction_time="14:08",
                     counterparty="롯데마트", amount=Decimal("3500000"),
                     direction="inbound", description="식자재 정산"),
    ]
    top_outbound = [
        CashFlowItem(transaction_id=201, transaction_time="10:15",
                     counterparty="강남빌딩", amount=Decimal("3200000"),
                     direction="outbound", description="4월 임대료"),
        CashFlowItem(transaction_id=202, transaction_time="13:50",
                     counterparty="삼성카드", amount=Decimal("1850000"),
                     direction="outbound", description="법인카드 결제"),
        CashFlowItem(transaction_id=203, transaction_time="16:22",
                     counterparty="(주)대상", amount=Decimal("650000"),
                     direction="outbound", description="원재료 매입"),
    ]

    return DailyReportResponse(
        summary=summary,
        accounts=accounts,
        top_inbound=top_inbound,
        top_outbound=top_outbound,
        upcoming_payments_amount=Decimal("18500000"),
        overdue_receivables_amount=Decimal("4200000"),
        generated_at=datetime.utcnow(),
    )


@router.get("/today", response_model=DailyReportResponse)
async def get_today_report(
    db: AsyncSession = Depends(get_db),
):
    """오늘 자금일보"""
    # TODO: 실제 집계 (계좌별 입출금 + TOP-N + 예정/연체)
    return _mock_report(date.today())


@router.get("/by-date", response_model=DailyReportResponse)
async def get_report_by_date(
    report_date: date = Query(..., description="조회 날짜"),
    db: AsyncSession = Depends(get_db),
):
    """특정 날짜 자금일보"""
    # TODO: report_date 시점 잔액 + 거래 집계
    return _mock_report(report_date)


@router.post("/send-now")
async def send_report_now(
    report_date: Optional[date] = None,
    db: AsyncSession = Depends(get_db),
):
    """즉시 발송 (구독자 전체)"""
    # TODO: SubscriptionService.dispatch_all(report_date)
    target_date = report_date or date.today()
    return {
        "status": "queued",
        "report_date": target_date.isoformat(),
        "queued_at": datetime.utcnow().isoformat(),
        "subscriber_count": 3,
    }


@router.get("/subscriptions", response_model=List[DailyReportSubscription])
async def list_subscriptions(
    db: AsyncSession = Depends(get_db),
):
    """현재 사용자의 구독 목록"""
    # TODO: 실제 구독 조회
    return [
        DailyReportSubscription(
            id=1, user_id=1, delivery_method="email",
            delivery_target="ceo@example.com", schedule_time="09:00",
            is_active=True, include_attachments=True,
        ),
    ]


@router.post("/subscriptions", response_model=DailyReportSubscription, status_code=status.HTTP_201_CREATED)
async def create_subscription(
    sub: DailyReportSubscriptionCreate,
    user_id: int = Query(...),
    db: AsyncSession = Depends(get_db),
):
    """자금일보 구독 추가"""
    # TODO: 구독 생성. 카카오/슬랙 발송 토큰 검증.
    return DailyReportSubscription(
        id=999, user_id=user_id,
        delivery_method=sub.delivery_method,
        delivery_target=sub.delivery_target,
        schedule_time=sub.schedule_time,
        is_active=True,
        include_attachments=sub.include_attachments,
    )


@router.delete("/subscriptions/{sub_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_subscription(
    sub_id: int,
    db: AsyncSession = Depends(get_db),
):
    """구독 해제"""
    # TODO: 구독 삭제
    return


@router.get("/history", response_model=List[DailyReportHistoryItem])
async def list_send_history(
    limit: int = Query(30, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
):
    """발송 이력"""
    # TODO: 발송 이력 조회
    today = date.today()
    return [
        DailyReportHistoryItem(
            id=i,
            report_date=today - timedelta(days=i - 1),
            sent_at=datetime.utcnow() - timedelta(days=i - 1),
            delivery_method="email",
            delivery_target="ceo@example.com",
            status="sent",
        )
        for i in range(1, min(limit, 7) + 1)
    ]
