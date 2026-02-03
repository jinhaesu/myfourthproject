"""
Smart Finance Core - Budget Schemas
예산 관련 API 스키마
"""
from datetime import datetime
from decimal import Decimal
from typing import Optional, List
from pydantic import BaseModel, Field


class BudgetLineCreate(BaseModel):
    """예산 라인 생성 스키마"""
    account_id: int
    jan_amount: Decimal = Field(default=Decimal("0"), ge=0)
    feb_amount: Decimal = Field(default=Decimal("0"), ge=0)
    mar_amount: Decimal = Field(default=Decimal("0"), ge=0)
    apr_amount: Decimal = Field(default=Decimal("0"), ge=0)
    may_amount: Decimal = Field(default=Decimal("0"), ge=0)
    jun_amount: Decimal = Field(default=Decimal("0"), ge=0)
    jul_amount: Decimal = Field(default=Decimal("0"), ge=0)
    aug_amount: Decimal = Field(default=Decimal("0"), ge=0)
    sep_amount: Decimal = Field(default=Decimal("0"), ge=0)
    oct_amount: Decimal = Field(default=Decimal("0"), ge=0)
    nov_amount: Decimal = Field(default=Decimal("0"), ge=0)
    dec_amount: Decimal = Field(default=Decimal("0"), ge=0)
    notes: Optional[str] = None


class BudgetLineResponse(BaseModel):
    """예산 라인 응답 스키마"""
    id: int
    account_id: int
    account_code: Optional[str] = None
    account_name: Optional[str] = None
    jan_amount: Decimal
    feb_amount: Decimal
    mar_amount: Decimal
    apr_amount: Decimal
    may_amount: Decimal
    jun_amount: Decimal
    jul_amount: Decimal
    aug_amount: Decimal
    sep_amount: Decimal
    oct_amount: Decimal
    nov_amount: Decimal
    dec_amount: Decimal
    annual_amount: Decimal
    used_amount: Decimal
    remaining_amount: Decimal
    usage_percentage: Optional[Decimal] = None
    notes: Optional[str] = None

    class Config:
        from_attributes = True


class BudgetCreate(BaseModel):
    """예산 생성 스키마"""
    fiscal_year: int = Field(..., ge=2000, le=2100)
    period_type: str = "yearly"  # monthly, quarterly, yearly
    period_number: int = Field(default=1, ge=1, le=12)
    department_id: int
    budget_name: str = Field(..., min_length=1, max_length=200)
    description: Optional[str] = None
    warning_threshold: Decimal = Field(default=Decimal("80.00"), ge=0, le=100)
    critical_threshold: Decimal = Field(default=Decimal("95.00"), ge=0, le=100)
    lines: List[BudgetLineCreate]


class BudgetUpdate(BaseModel):
    """예산 수정 스키마"""
    budget_name: Optional[str] = None
    description: Optional[str] = None
    warning_threshold: Optional[Decimal] = None
    critical_threshold: Optional[Decimal] = None
    lines: Optional[List[BudgetLineCreate]] = None


class BudgetResponse(BaseModel):
    """예산 응답 스키마"""
    id: int
    fiscal_year: int
    period_type: str
    period_number: int
    department_id: int
    department_name: Optional[str] = None
    budget_name: str
    total_amount: Decimal
    used_amount: Decimal
    remaining_amount: Decimal
    usage_percentage: Optional[Decimal] = None
    status: str
    warning_threshold: Decimal
    critical_threshold: Decimal
    description: Optional[str] = None
    lines: List[BudgetLineResponse] = []
    created_at: datetime
    approved_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class BudgetCheckResponse(BaseModel):
    """예산 체크 응답 스키마"""
    department_id: int
    department_name: str
    account_id: int
    account_name: str
    fiscal_year: int
    current_month: int

    # Annual budget
    annual_budget: Decimal
    annual_used: Decimal
    annual_remaining: Decimal
    annual_usage_percentage: Decimal

    # Monthly budget (current month)
    monthly_budget: Decimal
    monthly_used: Decimal
    monthly_remaining: Decimal
    monthly_usage_percentage: Decimal

    # Status
    is_available: bool
    requested_amount: Decimal
    alert_level: str  # normal, warning, critical, exceeded
    message: str


class BudgetSummaryResponse(BaseModel):
    """예산 요약 응답 스키마"""
    department_id: int
    department_name: str
    fiscal_year: int
    total_budget: Decimal
    total_used: Decimal
    total_remaining: Decimal
    usage_percentage: Decimal

    # By category
    expense_budget: Decimal
    expense_used: Decimal
    capex_budget: Decimal
    capex_used: Decimal

    # Trend
    monthly_trend: List[dict]  # [{month, budget, actual}, ...]

    # Top spending accounts
    top_accounts: List[dict]  # [{account_name, budget, used, percentage}, ...]


class BudgetVsActualResponse(BaseModel):
    """예산 대 실적 비교 응답"""
    fiscal_year: int
    department_id: Optional[int] = None
    items: List[dict]  # [{account_name, budget, actual, variance, variance_pct}, ...]
    totals: dict
