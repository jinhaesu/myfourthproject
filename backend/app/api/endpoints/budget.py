"""
Smart Finance Core - Budget API
예산 관리 API 엔드포인트
"""
from datetime import date
from decimal import Decimal
from typing import Optional, List
from fastapi import APIRouter, Depends, HTTPException, status, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.schemas.budget import (
    BudgetCreate, BudgetUpdate, BudgetResponse,
    BudgetCheckResponse, BudgetSummaryResponse, BudgetVsActualResponse
)
from app.services.budget_service import BudgetService

router = APIRouter()


@router.post("/", response_model=BudgetResponse, status_code=status.HTTP_201_CREATED)
async def create_budget(
    budget_data: BudgetCreate,
    user_id: int = Query(..., description="현재 사용자 ID"),
    db: AsyncSession = Depends(get_db)
):
    """
    예산 생성

    - 부서별 연간/월간 예산을 설정합니다
    """
    service = BudgetService(db)

    try:
        budget = await service.create_budget(
            fiscal_year=budget_data.fiscal_year,
            department_id=budget_data.department_id,
            budget_name=budget_data.budget_name,
            lines=[line.model_dump() for line in budget_data.lines],
            user_id=user_id,
            period_type=budget_data.period_type,
            period_number=budget_data.period_number,
            description=budget_data.description,
            warning_threshold=budget_data.warning_threshold,
            critical_threshold=budget_data.critical_threshold
        )
        return BudgetResponse.model_validate(budget)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))


@router.get("/", response_model=List[BudgetResponse])
async def get_budgets(
    fiscal_year: Optional[int] = None,
    department_id: Optional[int] = None,
    status: Optional[str] = None,
    db: AsyncSession = Depends(get_db)
):
    """예산 목록 조회"""
    from app.models.budget import Budget, BudgetStatus
    from sqlalchemy import select, and_

    conditions = []

    if fiscal_year:
        conditions.append(Budget.fiscal_year == fiscal_year)
    if department_id:
        conditions.append(Budget.department_id == department_id)
    if status:
        conditions.append(Budget.status == BudgetStatus(status))

    query = select(Budget)
    if conditions:
        query = query.where(and_(*conditions))
    query = query.order_by(Budget.fiscal_year.desc(), Budget.department_id)

    result = await db.execute(query)
    budgets = result.scalars().all()

    return [BudgetResponse.model_validate(b) for b in budgets]


@router.get("/{budget_id}", response_model=BudgetResponse)
async def get_budget(
    budget_id: int,
    db: AsyncSession = Depends(get_db)
):
    """예산 상세 조회"""
    from app.models.budget import Budget

    budget = await db.get(Budget, budget_id)

    if not budget:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="예산을 찾을 수 없습니다."
        )

    return BudgetResponse.model_validate(budget)


@router.post("/check", response_model=BudgetCheckResponse)
async def check_budget(
    department_id: int,
    account_id: int,
    amount: Decimal,
    voucher_date: Optional[date] = None,
    db: AsyncSession = Depends(get_db)
):
    """
    예산 체크

    - 지출 전 예산 잔액을 확인합니다
    """
    service = BudgetService(db)

    result = await service.check_budget(
        department_id=department_id,
        account_id=account_id,
        amount=amount,
        voucher_date=voucher_date
    )

    return BudgetCheckResponse(**result)


@router.get("/summary/{department_id}", response_model=BudgetSummaryResponse)
async def get_budget_summary(
    department_id: int,
    fiscal_year: Optional[int] = None,
    db: AsyncSession = Depends(get_db)
):
    """부서 예산 요약 조회"""
    service = BudgetService(db)

    result = await service.get_budget_summary(department_id, fiscal_year)

    if "message" in result:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=result["message"]
        )

    return BudgetSummaryResponse(**result)


@router.get("/vs-actual", response_model=BudgetVsActualResponse)
async def get_budget_vs_actual(
    fiscal_year: int,
    department_id: Optional[int] = None,
    db: AsyncSession = Depends(get_db)
):
    """예산 대 실적 비교"""
    service = BudgetService(db)

    result = await service.get_budget_vs_actual(fiscal_year, department_id)

    return BudgetVsActualResponse(**result)


@router.post("/{budget_id}/activate")
async def activate_budget(
    budget_id: int,
    user_id: int = Query(..., description="현재 사용자 ID"),
    db: AsyncSession = Depends(get_db)
):
    """예산 활성화"""
    from app.models.budget import Budget, BudgetStatus
    from datetime import datetime

    budget = await db.get(Budget, budget_id)

    if not budget:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="예산을 찾을 수 없습니다."
        )

    budget.status = BudgetStatus.ACTIVE
    budget.approved_at = datetime.utcnow()
    budget.approved_by = user_id

    await db.commit()

    return {"message": "예산이 활성화되었습니다."}
