"""
Smart Finance Core - Budget Service
예산 관리 서비스
"""
from datetime import datetime, date
from decimal import Decimal
from typing import Optional, List, Tuple
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, and_, func
from sqlalchemy.orm import selectinload

from app.models.budget import Budget, BudgetLine, BudgetUsage, BudgetStatus, BudgetPeriodType
from app.models.accounting import Account, Voucher, VoucherLine, VoucherStatus
from app.models.user import Department


class BudgetService:
    """
    예산 관리 서비스
    - 예산 생성/수정
    - 실시간 예산 체크
    - 예산 vs 실적 비교
    """

    def __init__(self, db: AsyncSession):
        self.db = db

    async def create_budget(
        self,
        fiscal_year: int,
        department_id: int,
        budget_name: str,
        lines: List[dict],
        user_id: int,
        period_type: str = "yearly",
        period_number: int = 1,
        description: Optional[str] = None,
        warning_threshold: Decimal = Decimal("80.00"),
        critical_threshold: Decimal = Decimal("95.00")
    ) -> Budget:
        """예산 생성"""
        # 총액 계산
        total_amount = sum(
            sum(
                line.get(f"{month}_amount", Decimal("0"))
                for month in ["jan", "feb", "mar", "apr", "may", "jun",
                             "jul", "aug", "sep", "oct", "nov", "dec"]
            )
            for line in lines
        )

        # Convert period_type string to enum
        if isinstance(period_type, str):
            period_type_enum = BudgetPeriodType(period_type)
        else:
            period_type_enum = period_type

        budget = Budget(
            fiscal_year=fiscal_year,
            period_type=period_type_enum,
            period_number=period_number,
            department_id=department_id,
            budget_name=budget_name,
            total_amount=total_amount,
            used_amount=Decimal("0"),
            remaining_amount=total_amount,
            status=BudgetStatus.DRAFT,
            warning_threshold=warning_threshold,
            critical_threshold=critical_threshold,
            description=description,
            created_by=user_id
        )
        self.db.add(budget)
        await self.db.flush()

        # 예산 라인 생성
        for line_data in lines:
            annual_amount = sum(
                line_data.get(f"{month}_amount", Decimal("0"))
                for month in ["jan", "feb", "mar", "apr", "may", "jun",
                             "jul", "aug", "sep", "oct", "nov", "dec"]
            )

            budget_line = BudgetLine(
                budget_id=budget.id,
                account_id=line_data["account_id"],
                jan_amount=line_data.get("jan_amount", Decimal("0")),
                feb_amount=line_data.get("feb_amount", Decimal("0")),
                mar_amount=line_data.get("mar_amount", Decimal("0")),
                apr_amount=line_data.get("apr_amount", Decimal("0")),
                may_amount=line_data.get("may_amount", Decimal("0")),
                jun_amount=line_data.get("jun_amount", Decimal("0")),
                jul_amount=line_data.get("jul_amount", Decimal("0")),
                aug_amount=line_data.get("aug_amount", Decimal("0")),
                sep_amount=line_data.get("sep_amount", Decimal("0")),
                oct_amount=line_data.get("oct_amount", Decimal("0")),
                nov_amount=line_data.get("nov_amount", Decimal("0")),
                dec_amount=line_data.get("dec_amount", Decimal("0")),
                annual_amount=annual_amount,
                used_amount=Decimal("0"),
                remaining_amount=annual_amount,
                notes=line_data.get("notes")
            )
            self.db.add(budget_line)

        await self.db.commit()

        # Reload with eager-loaded relationships for response
        result = await self.db.execute(
            select(Budget)
            .options(
                selectinload(Budget.lines).selectinload(BudgetLine.account),
                selectinload(Budget.department),
            )
            .where(Budget.id == budget.id)
        )
        return result.scalar_one_or_none()

    async def check_budget(
        self,
        department_id: int,
        account_id: int,
        amount: Decimal,
        voucher_date: Optional[date] = None
    ) -> dict:
        """
        실시간 예산 체크

        Returns:
            {
                "is_available": bool,
                "alert_level": str,  # normal, warning, critical, exceeded
                "message": str,
                "annual_budget": Decimal,
                "annual_used": Decimal,
                "monthly_budget": Decimal,
                "monthly_used": Decimal,
                ...
            }
        """
        if not voucher_date:
            voucher_date = date.today()

        fiscal_year = voucher_date.year
        current_month = voucher_date.month

        # 예산 조회
        result = await self.db.execute(
            select(Budget).where(
                and_(
                    Budget.department_id == department_id,
                    Budget.fiscal_year == fiscal_year,
                    Budget.status == BudgetStatus.ACTIVE
                )
            )
        )
        budget = result.scalars().first()

        if not budget:
            department = await self.db.get(Department, department_id)
            account = await self.db.get(Account, account_id)
            return {
                "department_id": department_id,
                "department_name": department.name if department else "",
                "account_id": account_id,
                "account_name": account.name if account else "",
                "fiscal_year": fiscal_year,
                "current_month": current_month,
                "is_available": True,
                "alert_level": "normal",
                "message": "예산이 설정되지 않았습니다.",
                "annual_budget": Decimal("0"),
                "annual_used": Decimal("0"),
                "annual_remaining": Decimal("0"),
                "annual_usage_percentage": Decimal("0"),
                "monthly_budget": Decimal("0"),
                "monthly_used": Decimal("0"),
                "monthly_remaining": Decimal("0"),
                "monthly_usage_percentage": Decimal("0"),
                "requested_amount": amount
            }

        # 예산 라인 조회
        result = await self.db.execute(
            select(BudgetLine).where(
                and_(
                    BudgetLine.budget_id == budget.id,
                    BudgetLine.account_id == account_id
                )
            )
        )
        budget_line = result.scalars().first()

        if not budget_line:
            department = await self.db.get(Department, department_id)
            account = await self.db.get(Account, account_id)
            return {
                "department_id": department_id,
                "department_name": department.name if department else "",
                "account_id": account_id,
                "account_name": account.name if account else "",
                "fiscal_year": fiscal_year,
                "current_month": current_month,
                "is_available": True,
                "alert_level": "normal",
                "message": f"해당 계정({account_id})에 대한 예산이 없습니다.",
                "annual_budget": Decimal("0"),
                "annual_used": Decimal("0"),
                "annual_remaining": Decimal("0"),
                "annual_usage_percentage": Decimal("0"),
                "monthly_budget": Decimal("0"),
                "monthly_used": Decimal("0"),
                "monthly_remaining": Decimal("0"),
                "monthly_usage_percentage": Decimal("0"),
                "requested_amount": amount
            }

        # 월별 예산
        month_attr = f"{['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'][current_month - 1]}_amount"
        monthly_budget = getattr(budget_line, month_attr, Decimal("0"))

        # 월별 사용량 조회
        monthly_used = await self._get_monthly_usage(
            department_id, account_id, fiscal_year, current_month
        )

        # 연간 사용량
        annual_used = budget_line.used_amount

        # 예산 체크
        annual_remaining = budget_line.annual_amount - annual_used
        monthly_remaining = monthly_budget - monthly_used

        # 요청 금액 반영 후 사용률
        new_annual_used = annual_used + amount
        new_monthly_used = monthly_used + amount

        annual_usage_pct = (new_annual_used / budget_line.annual_amount * 100) if budget_line.annual_amount else Decimal("0")
        monthly_usage_pct = (new_monthly_used / monthly_budget * 100) if monthly_budget else Decimal("0")

        # 알림 레벨 결정
        is_available = True
        if amount > annual_remaining:
            alert_level = "exceeded"
            is_available = False
            message = f"연간 예산 초과 (요청: {amount:,.0f}원, 잔액: {annual_remaining:,.0f}원)"
        elif amount > monthly_remaining:
            alert_level = "exceeded"
            is_available = False
            message = f"월간 예산 초과 (요청: {amount:,.0f}원, 잔액: {monthly_remaining:,.0f}원)"
        elif annual_usage_pct >= budget.critical_threshold:
            alert_level = "critical"
            message = f"연간 예산 사용률 위험 ({annual_usage_pct:.1f}%)"
        elif annual_usage_pct >= budget.warning_threshold:
            alert_level = "warning"
            message = f"연간 예산 사용률 경고 ({annual_usage_pct:.1f}%)"
        else:
            alert_level = "normal"
            message = f"예산 확인 완료 (연간 잔액: {annual_remaining:,.0f}원)"

        # 부서, 계정 정보
        department = await self.db.get(Department, department_id)
        account = await self.db.get(Account, account_id)

        return {
            "department_id": department_id,
            "department_name": department.name if department else "",
            "account_id": account_id,
            "account_name": account.name if account else "",
            "fiscal_year": fiscal_year,
            "current_month": current_month,
            "annual_budget": budget_line.annual_amount,
            "annual_used": annual_used,
            "annual_remaining": annual_remaining,
            "annual_usage_percentage": annual_usage_pct,
            "monthly_budget": monthly_budget,
            "monthly_used": monthly_used,
            "monthly_remaining": monthly_remaining,
            "monthly_usage_percentage": monthly_usage_pct,
            "is_available": is_available,
            "requested_amount": amount,
            "alert_level": alert_level,
            "message": message
        }

    async def _get_monthly_usage(
        self,
        department_id: int,
        account_id: int,
        year: int,
        month: int
    ) -> Decimal:
        """월별 사용량 조회"""
        start_date = date(year, month, 1)
        if month == 12:
            end_date = date(year + 1, 1, 1)
        else:
            end_date = date(year, month + 1, 1)

        # 순비용 = 차변 합계 - 대변 합계 (비용 환입 반영)
        result = await self.db.execute(
            select(
                func.coalesce(func.sum(VoucherLine.debit_amount), 0)
                - func.coalesce(func.sum(VoucherLine.credit_amount), 0)
            ).join(Voucher).where(
                and_(
                    Voucher.department_id == department_id,
                    VoucherLine.account_id == account_id,
                    Voucher.voucher_date >= start_date,
                    Voucher.voucher_date < end_date,
                    Voucher.status.in_([VoucherStatus.APPROVED, VoucherStatus.CONFIRMED])
                )
            )
        )
        net_amount = result.scalar() or Decimal("0")
        return max(net_amount, Decimal("0"))  # 음수는 0으로 처리

    async def record_budget_usage(
        self,
        budget_id: int,
        voucher_id: int,
        account_id: int,
        amount: Decimal,
        usage_date: date
    ):
        """예산 사용 기록"""
        # 예산 라인 조회
        result = await self.db.execute(
            select(BudgetLine).where(
                and_(
                    BudgetLine.budget_id == budget_id,
                    BudgetLine.account_id == account_id
                )
            )
        )
        budget_line = result.scalars().first()

        if not budget_line:
            return

        # 사용 기록 추가
        usage = BudgetUsage(
            budget_id=budget_id,
            budget_line_id=budget_line.id,
            voucher_id=voucher_id,
            amount=amount,
            usage_date=usage_date,
            usage_month=usage_date.month
        )
        self.db.add(usage)

        # 예산 라인 업데이트
        budget_line.used_amount += amount
        budget_line.remaining_amount = budget_line.annual_amount - budget_line.used_amount

        # 예산 헤더 업데이트
        budget = await self.db.get(Budget, budget_id)
        if budget:
            budget.used_amount += amount
            budget.remaining_amount = budget.total_amount - budget.used_amount

        await self.db.commit()

    async def get_budget_vs_actual(
        self,
        fiscal_year: int,
        department_id: Optional[int] = None
    ) -> dict:
        """예산 대 실적 비교"""
        conditions = [
            Budget.fiscal_year == fiscal_year,
            Budget.status == BudgetStatus.ACTIVE
        ]
        if department_id:
            conditions.append(Budget.department_id == department_id)

        result = await self.db.execute(
            select(Budget)
            .options(
                selectinload(Budget.lines).selectinload(BudgetLine.account),
                selectinload(Budget.department),
            )
            .where(and_(*conditions))
        )
        budgets = result.scalars().unique().all()

        items = []
        total_budget = Decimal("0")
        total_actual = Decimal("0")

        for budget in budgets:
            for line in budget.lines:
                account = line.account
                actual = line.used_amount
                variance = actual - line.annual_amount
                variance_pct = (variance / line.annual_amount * 100) if line.annual_amount else Decimal("0")

                items.append({
                    "department": budget.department.name if budget.department else "",
                    "account_code": account.code if account else "",
                    "account_name": account.name if account else "",
                    "budget": line.annual_amount,
                    "actual": actual,
                    "variance": variance,
                    "variance_pct": variance_pct
                })

                total_budget += line.annual_amount
                total_actual += actual

        total_variance = total_actual - total_budget
        total_variance_pct = (total_variance / total_budget * 100) if total_budget else Decimal("0")

        return {
            "fiscal_year": fiscal_year,
            "department_id": department_id,
            "items": items,
            "totals": {
                "budget": total_budget,
                "actual": total_actual,
                "variance": total_variance,
                "variance_pct": total_variance_pct
            }
        }

    async def get_budget_summary(
        self,
        department_id: int,
        fiscal_year: Optional[int] = None
    ) -> dict:
        """예산 요약"""
        if not fiscal_year:
            fiscal_year = date.today().year

        result = await self.db.execute(
            select(Budget)
            .options(
                selectinload(Budget.lines).selectinload(BudgetLine.account),
                selectinload(Budget.department),
            )
            .where(
                and_(
                    Budget.department_id == department_id,
                    Budget.fiscal_year == fiscal_year,
                    Budget.status == BudgetStatus.ACTIVE
                )
            )
        )
        budget = result.scalars().first()

        if not budget:
            return {
                "department_id": department_id,
                "fiscal_year": fiscal_year,
                "message": "예산이 설정되지 않았습니다."
            }

        department = budget.department

        usage_pct = (budget.used_amount / budget.total_amount * 100) if budget.total_amount else Decimal("0")

        # 월별 추이
        monthly_trend = []
        for month in range(1, 13):
            month_attr = f"{['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'][month - 1]}_amount"
            monthly_budget = sum(
                getattr(line, month_attr, Decimal("0")) for line in budget.lines
            )
            monthly_actual = await self._get_department_monthly_usage(
                department_id, fiscal_year, month
            )

            monthly_trend.append({
                "month": month,
                "budget": monthly_budget,
                "actual": monthly_actual
            })

        # 상위 지출 계정
        top_accounts = sorted(
            [
                {
                    "account_name": line.account.name if line.account else f"계정 {line.account_id}",
                    "budget": line.annual_amount,
                    "used": line.used_amount,
                    "percentage": (line.used_amount / line.annual_amount * 100) if line.annual_amount else Decimal("0")
                }
                for line in budget.lines
            ],
            key=lambda x: x["used"],
            reverse=True
        )[:10]

        # 비용/자본지출 구분 (계정코드 기준)
        expense_budget = Decimal("0")
        expense_used = Decimal("0")
        capex_budget = Decimal("0")
        capex_used = Decimal("0")

        for line in budget.lines:
            account_code = line.account.code if line.account else ""
            # 자본적 지출 (유형자산 16xxxx, 무형자산 17xxxx, 투자자산 15xxxx)
            if account_code.startswith("15") or account_code.startswith("16") or account_code.startswith("17"):
                capex_budget += line.annual_amount
                capex_used += line.used_amount
            else:
                expense_budget += line.annual_amount
                expense_used += line.used_amount

        return {
            "department_id": department_id,
            "department_name": department.name if department else "",
            "fiscal_year": fiscal_year,
            "total_budget": budget.total_amount,
            "total_used": budget.used_amount,
            "total_remaining": budget.remaining_amount,
            "usage_percentage": usage_pct,
            "expense_budget": expense_budget,
            "expense_used": expense_used,
            "capex_budget": capex_budget,
            "capex_used": capex_used,
            "monthly_trend": monthly_trend,
            "top_accounts": top_accounts
        }

    async def _get_department_monthly_usage(
        self,
        department_id: int,
        year: int,
        month: int
    ) -> Decimal:
        """부서 월별 총 사용량"""
        start_date = date(year, month, 1)
        if month == 12:
            end_date = date(year + 1, 1, 1)
        else:
            end_date = date(year, month + 1, 1)

        result = await self.db.execute(
            select(func.sum(VoucherLine.debit_amount)).join(Voucher).where(
                and_(
                    Voucher.department_id == department_id,
                    Voucher.voucher_date >= start_date,
                    Voucher.voucher_date < end_date,
                    Voucher.status.in_([VoucherStatus.APPROVED, VoucherStatus.CONFIRMED])
                )
            )
        )
        return result.scalar() or Decimal("0")
