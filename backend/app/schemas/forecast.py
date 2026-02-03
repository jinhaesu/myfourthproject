"""
Smart Finance Core - Forecast Schemas
예측 및 시뮬레이션 관련 API 스키마
"""
from datetime import date
from decimal import Decimal
from typing import Optional, List
from pydantic import BaseModel, Field


class PLLineItem(BaseModel):
    """손익계산서 항목"""
    account_code: str
    account_name: str
    category: str  # revenue, cogs, operating_expense, other_income, other_expense
    confirmed_amount: Decimal  # 확정된 금액
    pending_amount: Decimal  # 진행 중인 금액 (결재 대기 등)
    forecasted_amount: Decimal  # 예측 금액
    total_amount: Decimal
    ytd_amount: Decimal  # Year-to-date
    budget_amount: Decimal
    variance: Decimal
    variance_percentage: Optional[Decimal] = None


class PLForecastResponse(BaseModel):
    """손익 예측 응답 스키마"""
    period_type: str  # monthly, quarterly, yearly
    period_start: date
    period_end: date
    department_id: Optional[int] = None
    department_name: Optional[str] = None

    # Summary
    total_revenue: Decimal
    total_cogs: Decimal
    gross_profit: Decimal
    gross_profit_margin: Decimal
    total_operating_expense: Decimal
    operating_income: Decimal
    operating_income_margin: Decimal
    total_other_income: Decimal
    total_other_expense: Decimal
    net_income: Decimal
    net_income_margin: Decimal

    # Detail lines
    revenue_items: List[PLLineItem]
    cogs_items: List[PLLineItem]
    operating_expense_items: List[PLLineItem]
    other_items: List[PLLineItem]

    # Comparison
    previous_period: Optional[dict] = None
    budget_comparison: Optional[dict] = None

    # Forecast info
    forecast_confidence: Decimal
    last_updated: str


class CashFlowItem(BaseModel):
    """현금흐름 항목"""
    item_type: str  # inflow, outflow
    category: str  # operating, investing, financing
    description: str
    expected_date: date
    amount: Decimal
    confidence: Decimal
    source: str  # receivable, payable, scheduled, recurring, forecast


class CashFlowForecastResponse(BaseModel):
    """자금 수지 예측 응답"""
    forecast_date: date
    forecast_days: int

    # Current position
    opening_balance: Decimal

    # Summary by period
    daily_forecast: List[dict]  # [{date, opening, inflows, outflows, closing}, ...]
    weekly_summary: List[dict]

    # By category
    operating_inflows: Decimal
    operating_outflows: Decimal
    investing_inflows: Decimal
    investing_outflows: Decimal
    financing_inflows: Decimal
    financing_outflows: Decimal

    # Projected closing
    projected_closing_balance: Decimal
    minimum_balance_date: date
    minimum_balance_amount: Decimal

    # Details
    expected_inflows: List[CashFlowItem]
    expected_outflows: List[CashFlowItem]

    # Alerts
    cash_shortage_alerts: List[dict]  # [{date, shortage_amount, message}, ...]


class ScenarioVariable(BaseModel):
    """시나리오 변수"""
    variable_name: str  # revenue_growth, cogs_increase, expense_change, etc.
    change_type: str  # percentage, absolute
    change_value: Decimal
    apply_to: Optional[str] = None  # specific account or category


class ScenarioSimulationRequest(BaseModel):
    """시나리오 시뮬레이션 요청"""
    scenario_name: str = Field(..., min_length=1, max_length=100)
    base_period_start: date
    base_period_end: date
    forecast_periods: int = Field(default=12, ge=1, le=60)  # months
    variables: List[ScenarioVariable]
    description: Optional[str] = None


class ScenarioResult(BaseModel):
    """시나리오 결과 항목"""
    period: str
    revenue: Decimal
    cogs: Decimal
    gross_profit: Decimal
    operating_expense: Decimal
    operating_income: Decimal
    net_income: Decimal
    cash_flow: Decimal
    cumulative_cash_flow: Decimal


class ScenarioSimulationResponse(BaseModel):
    """시나리오 시뮬레이션 응답"""
    scenario_name: str
    description: Optional[str] = None
    variables_applied: List[ScenarioVariable]

    # Baseline
    baseline_summary: dict

    # Scenario results
    scenario_summary: dict
    period_results: List[ScenarioResult]

    # Comparison
    revenue_change: Decimal
    revenue_change_pct: Decimal
    operating_income_change: Decimal
    operating_income_change_pct: Decimal
    net_income_change: Decimal
    net_income_change_pct: Decimal
    cash_impact: Decimal

    # Visualization data
    chart_data: dict  # {labels, baseline_series, scenario_series}

    created_at: str


class DashboardKPIResponse(BaseModel):
    """대시보드 KPI 응답"""
    as_of_date: date

    # Revenue & Profit
    mtd_revenue: Decimal
    mtd_revenue_vs_budget: Decimal
    mtd_revenue_vs_ly: Decimal
    ytd_revenue: Decimal

    mtd_operating_income: Decimal
    mtd_operating_margin: Decimal
    ytd_operating_income: Decimal

    # Cash
    current_cash_balance: Decimal
    expected_cash_eom: Decimal
    ar_balance: Decimal
    ap_balance: Decimal

    # Efficiency
    dso: int  # Days Sales Outstanding
    dpo: int  # Days Payable Outstanding

    # Trends
    revenue_trend: List[dict]  # [{month, actual, budget}, ...]
    profit_trend: List[dict]
    cash_trend: List[dict]

    # Alerts
    budget_alerts: List[dict]
    cash_alerts: List[dict]
    approval_pending_count: int
