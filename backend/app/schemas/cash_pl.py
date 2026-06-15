"""
Cash-Basis Profit & Loss Schemas — 현금주의 손익 분석
발생주의(accrual)가 아닌, 현금이 실제 들어오고 나간 시점 기준 손익
"""
from datetime import date
from decimal import Decimal
from typing import Optional, List, Literal
from pydantic import BaseModel


PeriodType = Literal["daily", "weekly", "monthly", "quarterly", "yearly"]
BasisType = Literal["cash", "accrual"]


class CashPLLineItem(BaseModel):
    """손익 라인 항목"""
    account_code: str
    account_name: str
    category: Literal["revenue", "cogs", "opex", "non_operating", "tax"]
    amount: Decimal
    pct_of_revenue: Optional[float] = None


class CashPLPeriodSummary(BaseModel):
    """기간별 손익 요약"""
    period_label: str  # "2026-04", "2026-W17"
    period_start: date
    period_end: date
    revenue: Decimal
    cogs: Decimal
    gross_profit: Decimal
    gross_margin_pct: float
    opex: Decimal
    operating_profit: Decimal
    operating_margin_pct: float
    non_operating_income: Decimal
    non_operating_expense: Decimal
    net_profit: Decimal
    net_margin_pct: float


class CashPLRequest(BaseModel):
    """현금주의 손익 요청"""
    from_date: date
    to_date: date
    basis: BasisType = "cash"
    period_type: PeriodType = "monthly"
    department_id: Optional[int] = None
    project_tag: Optional[str] = None


class CashPLResponse(BaseModel):
    """현금주의 손익 응답"""
    basis: BasisType
    period_type: PeriodType
    summaries: List[CashPLPeriodSummary]  # 기간별 요약 (시계열)
    line_items: List[CashPLLineItem]  # 전체 기간 합계 라인
    cash_vs_accrual_diff: Optional[Decimal] = None  # 발생주의와 차이 (참조용)
    generated_at: date


class CashPLComparisonResponse(BaseModel):
    """현금주의 vs 발생주의 비교"""
    period_label: str
    cash_basis: CashPLPeriodSummary
    accrual_basis: CashPLPeriodSummary
    difference_summary: dict  # 항목별 차이 dict
