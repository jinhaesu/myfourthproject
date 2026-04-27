"""
Cash-Basis P&L API — 현금주의 손익 분석
발생주의(이미 financial_reports에 있음)와 별도로, 현금이 실제 들어오고 나간 시점 기준의 손익

NOTE: 라우트 스켈레톤.
"""
from datetime import date, timedelta
from decimal import Decimal
from typing import Optional, List
from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.schemas.cash_pl import (
    CashPLRequest,
    CashPLResponse,
    CashPLPeriodSummary,
    CashPLLineItem,
    CashPLComparisonResponse,
    PeriodType,
    BasisType,
)

router = APIRouter()


def _mock_period_summary(start: date, end: date, label: str, basis: BasisType) -> CashPLPeriodSummary:
    base = Decimal("100000000") if basis == "cash" else Decimal("110000000")
    revenue = base
    cogs = revenue * Decimal("0.62")
    gross = revenue - cogs
    opex = revenue * Decimal("0.20")
    op = gross - opex
    nop_inc = Decimal("500000")
    nop_exp = Decimal("1200000")
    net = op + nop_inc - nop_exp
    return CashPLPeriodSummary(
        period_label=label,
        period_start=start, period_end=end,
        revenue=revenue, cogs=cogs, gross_profit=gross,
        gross_margin_pct=float(gross / revenue * 100),
        opex=opex, operating_profit=op,
        operating_margin_pct=float(op / revenue * 100),
        non_operating_income=nop_inc, non_operating_expense=nop_exp,
        net_profit=net,
        net_margin_pct=float(net / revenue * 100),
    )


def _mock_line_items() -> List[CashPLLineItem]:
    return [
        CashPLLineItem(account_code="411", account_name="제품매출", category="revenue",
                       amount=Decimal("85000000"), pct_of_revenue=85.0),
        CashPLLineItem(account_code="412", account_name="용역매출", category="revenue",
                       amount=Decimal("15000000"), pct_of_revenue=15.0),
        CashPLLineItem(account_code="451", account_name="원재료비", category="cogs",
                       amount=Decimal("48000000"), pct_of_revenue=48.0),
        CashPLLineItem(account_code="452", account_name="상품매입", category="cogs",
                       amount=Decimal("14000000"), pct_of_revenue=14.0),
        CashPLLineItem(account_code="811", account_name="급여", category="opex",
                       amount=Decimal("12000000"), pct_of_revenue=12.0),
        CashPLLineItem(account_code="819", account_name="임차료", category="opex",
                       amount=Decimal("3200000"), pct_of_revenue=3.2),
        CashPLLineItem(account_code="831", account_name="복리후생비", category="opex",
                       amount=Decimal("1800000"), pct_of_revenue=1.8),
        CashPLLineItem(account_code="832", account_name="여비교통비", category="opex",
                       amount=Decimal("980000"), pct_of_revenue=0.98),
        CashPLLineItem(account_code="930", account_name="이자비용", category="non_operating",
                       amount=Decimal("1200000"), pct_of_revenue=1.2),
    ]


@router.post("/", response_model=CashPLResponse)
async def get_cash_pl(
    req: CashPLRequest,
    db: AsyncSession = Depends(get_db),
):
    """
    현금주의 손익 조회
    - basis=cash: 실제 입출금 기준
    - basis=accrual: 세금계산서/매출인식 기준 (참조용)
    - period_type에 따라 일/주/월/분기/연 단위 시계열 반환
    """
    # TODO: 실제 손익 계산
    # 1) basis=cash → bank_transactions + card_transactions에서 매출/비용 계정 분류
    # 2) basis=accrual → tax_invoices + 발생 전표 기준
    # 3) period_type에 맞춰 그룹핑

    summaries = []
    cur = req.from_date
    while cur <= req.to_date:
        if req.period_type == "monthly":
            label = cur.strftime("%Y-%m")
            month_end = (cur.replace(day=28) + timedelta(days=4)).replace(day=1) - timedelta(days=1)
            period_end = min(month_end, req.to_date)
            summaries.append(_mock_period_summary(cur, period_end, label, req.basis))
            cur = period_end + timedelta(days=1)
        elif req.period_type == "weekly":
            period_end = min(cur + timedelta(days=6), req.to_date)
            label = f"{cur.isocalendar().year}-W{cur.isocalendar().week:02d}"
            summaries.append(_mock_period_summary(cur, period_end, label, req.basis))
            cur = period_end + timedelta(days=1)
        else:  # daily/quarterly/yearly fallback
            period_end = req.to_date
            summaries.append(_mock_period_summary(cur, period_end, f"{cur} ~ {period_end}", req.basis))
            cur = period_end + timedelta(days=1)

    return CashPLResponse(
        basis=req.basis,
        period_type=req.period_type,
        summaries=summaries,
        line_items=_mock_line_items(),
        cash_vs_accrual_diff=Decimal("-10000000") if req.basis == "cash" else None,
        generated_at=date.today(),
    )


@router.get("/comparison", response_model=CashPLComparisonResponse)
async def compare_cash_vs_accrual(
    from_date: date,
    to_date: date,
    db: AsyncSession = Depends(get_db),
):
    """
    현금주의 vs 발생주의 비교
    - 두 기준의 차이를 한눈에 보여주어 의사결정에 활용
    """
    # TODO: 실제 두 방식 동시 계산
    label = f"{from_date} ~ {to_date}"
    cash = _mock_period_summary(from_date, to_date, label, "cash")
    accrual = _mock_period_summary(from_date, to_date, label, "accrual")
    diff = {
        "revenue": float(cash.revenue - accrual.revenue),
        "cogs": float(cash.cogs - accrual.cogs),
        "operating_profit": float(cash.operating_profit - accrual.operating_profit),
        "net_profit": float(cash.net_profit - accrual.net_profit),
    }
    return CashPLComparisonResponse(
        period_label=label,
        cash_basis=cash,
        accrual_basis=accrual,
        difference_summary=diff,
    )


@router.get("/snapshot")
async def get_quick_snapshot(
    db: AsyncSession = Depends(get_db),
):
    """
    빠른 현황 스냅샷 (홈 대시보드 카드용)
    당월 매출/비용/이익을 1번 API로 가볍게 조회
    """
    # TODO: 실제 당월 집계
    return {
        "this_month": {
            "revenue": "100000000",
            "cogs": "62000000",
            "operating_profit": "18000000",
            "net_profit": "17300000",
            "operating_margin_pct": 18.0,
        },
        "last_month": {
            "revenue": "92000000",
            "operating_profit": "15600000",
            "operating_margin_pct": 16.96,
        },
        "yoy": {
            "revenue_pct": 12.5,
            "operating_profit_pct": 18.2,
        },
    }
