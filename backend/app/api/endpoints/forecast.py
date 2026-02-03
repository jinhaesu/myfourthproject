"""
Smart Finance Core - Forecast API
예측 및 시뮬레이션 API 엔드포인트
"""
from datetime import date
from typing import Optional
from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.schemas.forecast import (
    PLForecastResponse, CashFlowForecastResponse,
    ScenarioSimulationRequest, ScenarioSimulationResponse,
    DashboardKPIResponse
)
from app.services.forecasting_engine import ForecastingEngine

router = APIRouter()


@router.get("/pl", response_model=PLForecastResponse)
async def get_pl_forecast(
    period_start: date,
    period_end: date,
    department_id: Optional[int] = None,
    db: AsyncSession = Depends(get_db)
):
    """
    실시간 추정 손익계산서

    - 확정된 전표 + 진행 중인 기안 + 고정비 예측을 합산합니다
    - 예산 대비 실적을 비교합니다
    """
    engine = ForecastingEngine(db)

    result = await engine.get_estimated_pl(
        period_start=period_start,
        period_end=period_end,
        department_id=department_id
    )

    return PLForecastResponse(**result)


@router.get("/cashflow", response_model=CashFlowForecastResponse)
async def get_cash_flow_forecast(
    forecast_days: int = Query(30, ge=1, le=90),
    start_date: Optional[date] = None,
    db: AsyncSession = Depends(get_db)
):
    """
    자금 수지 예측

    - 현재 잔액 + 예상 입금 - 예상 출금 = 월말 예상 자금
    - 일별 현금 흐름을 예측합니다
    """
    engine = ForecastingEngine(db)

    result = await engine.get_cash_flow_forecast(
        forecast_days=forecast_days,
        start_date=start_date
    )

    return CashFlowForecastResponse(**result)


@router.post("/scenario", response_model=ScenarioSimulationResponse)
async def run_scenario_simulation(
    scenario: ScenarioSimulationRequest,
    db: AsyncSession = Depends(get_db)
):
    """
    시나리오 시뮬레이션 (What-If Analysis)

    - 매출 변동, 원가 변동 등 다양한 변수를 적용하여 미래를 예측합니다
    - 그래프 시각화를 위한 데이터를 반환합니다
    """
    engine = ForecastingEngine(db)

    result = await engine.run_scenario_simulation(
        scenario_name=scenario.scenario_name,
        base_period_start=scenario.base_period_start,
        base_period_end=scenario.base_period_end,
        variables=[v.model_dump() for v in scenario.variables],
        forecast_periods=scenario.forecast_periods,
        description=scenario.description
    )

    return ScenarioSimulationResponse(**result)


@router.get("/dashboard", response_model=DashboardKPIResponse)
async def get_dashboard_kpis(
    db: AsyncSession = Depends(get_db)
):
    """
    대시보드 KPI

    - CFO/대표를 위한 핵심 지표를 한눈에 보여줍니다
    """
    from datetime import date, timedelta
    from decimal import Decimal

    engine = ForecastingEngine(db)
    today = date.today()
    month_start = today.replace(day=1)

    # 당월 손익
    pl = await engine.get_estimated_pl(month_start, today)

    # 현금 예측
    cash_forecast = await engine.get_cash_flow_forecast(30)

    # 채권/채무 잔액
    from app.services.treasury_manager import TreasuryManager
    treasury = TreasuryManager(db)
    cash_position = await treasury.get_cash_position()

    return DashboardKPIResponse(
        as_of_date=today,

        mtd_revenue=pl.get("total_revenue", Decimal("0")),
        mtd_revenue_vs_budget=Decimal("0"),
        mtd_revenue_vs_ly=Decimal("0"),
        ytd_revenue=Decimal("0"),

        mtd_operating_income=pl.get("operating_income", Decimal("0")),
        mtd_operating_margin=pl.get("operating_income_margin", Decimal("0")),
        ytd_operating_income=Decimal("0"),

        current_cash_balance=cash_position.get("total_balance", Decimal("0")),
        expected_cash_eom=cash_forecast.get("projected_closing_balance", Decimal("0")),
        ar_balance=Decimal("0"),
        ap_balance=Decimal("0"),

        dso=30,
        dpo=45,

        revenue_trend=[],
        profit_trend=[],
        cash_trend=[],

        budget_alerts=[],
        cash_alerts=cash_forecast.get("cash_shortage_alerts", []),
        approval_pending_count=0
    )
