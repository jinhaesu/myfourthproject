"""
Smart Finance Core - Forecasting Engine
손익 예측 및 시뮬레이션 엔진 (FP&A)
"""
from datetime import datetime, date, timedelta
from decimal import Decimal
from typing import Optional, List, Dict
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, and_, func
from sqlalchemy.orm import selectinload
import numpy as np

from app.models.accounting import Voucher, VoucherLine, VoucherStatus, Account, AccountCategory
from app.models.approval import ApprovalRequest, ApprovalStatus
from app.models.treasury import Receivable, Payable, BankAccount, BankAccountType, PaymentSchedule
from app.models.budget import Budget, BudgetLine, BudgetStatus


class ForecastingEngine:
    """
    재무 예측 엔진
    - 실시간 추정 손익계산서
    - 자금 수지 예측 (Cash Flow Forecasting)
    - 시나리오 시뮬레이션 (What-If Analysis)
    """

    def __init__(self, db: AsyncSession):
        self.db = db

    # ==================== 손익계산서 예측 ====================

    async def get_estimated_pl(
        self,
        period_start: date,
        period_end: date,
        department_id: Optional[int] = None
    ) -> dict:
        """
        실시간 추정 손익계산서
        확정 전표 + 진행 중 기안 + 고정비 = 예상 마감 실적
        """
        # 1. 확정된 전표 금액
        confirmed_amounts = await self._get_confirmed_amounts(
            period_start, period_end, department_id
        )

        # 2. 결재 중인 금액
        pending_amounts = await self._get_pending_amounts(
            period_start, period_end, department_id
        )

        # 3. 고정비 예측 (월 기준)
        fixed_costs = await self._estimate_fixed_costs(period_start, period_end, department_id)

        # 4. 예산 정보
        budget_amounts = await self._get_budget_amounts(period_start, period_end, department_id)

        # 손익 항목 분류
        revenue_items = []
        cogs_items = []
        opex_items = []
        other_items = []

        # 계정과목별 집계
        all_accounts = set(confirmed_amounts.keys()) | set(pending_amounts.keys()) | set(fixed_costs.keys())

        for account_id in all_accounts:
            account = await self.db.get(Account, account_id)
            if not account:
                continue

            confirmed = confirmed_amounts.get(account_id, Decimal("0"))
            pending = pending_amounts.get(account_id, Decimal("0"))
            forecasted = fixed_costs.get(account_id, Decimal("0"))
            budget = budget_amounts.get(account_id, Decimal("0"))

            category = self._get_pl_category(account)

            # 금액 부호 보정:
            # 원장 데이터는 (차변 - 대변) 으로 집계됨.
            # 수익/영업외수익 계정은 대변이 정상 잔액이므로 음수로 나옴 -> 부호 반전 필요
            # 비용/원가 계정은 차변이 정상 잔액이므로 양수 그대로 사용
            if category in ("revenue", "other_income"):
                confirmed = -confirmed
                pending = -pending
                forecasted = -forecasted

            total = confirmed + pending + forecasted

            item = {
                "account_code": account.code,
                "account_name": account.name,
                "category": category,
                "confirmed_amount": confirmed,
                "pending_amount": pending,
                "forecasted_amount": forecasted,
                "total_amount": total,
                "budget_amount": budget,
                "variance": total - budget,
                "variance_percentage": ((total - budget) / budget * 100) if budget else None
            }

            if category == "revenue":
                revenue_items.append(item)
            elif category == "cogs":
                cogs_items.append(item)
            elif category == "operating_expense":
                opex_items.append(item)
            else:
                other_items.append(item)

        # 합계 계산
        total_revenue = sum(i["total_amount"] for i in revenue_items)
        total_cogs = sum(i["total_amount"] for i in cogs_items)
        gross_profit = total_revenue - total_cogs
        total_opex = sum(i["total_amount"] for i in opex_items)
        operating_income = gross_profit - total_opex

        other_income = sum(
            i["total_amount"] for i in other_items
            if i.get("category") == "other_income"
        )
        other_expense = sum(
            i["total_amount"] for i in other_items
            if i.get("category") == "other_expense"
        )
        net_income = operating_income + other_income - other_expense

        return {
            "period_type": "custom",
            "period_start": period_start.isoformat(),
            "period_end": period_end.isoformat(),
            "department_id": department_id,

            "total_revenue": total_revenue,
            "total_cogs": total_cogs,
            "gross_profit": gross_profit,
            "gross_profit_margin": (gross_profit / total_revenue * 100) if total_revenue else Decimal("0"),
            "total_operating_expense": total_opex,
            "operating_income": operating_income,
            "operating_income_margin": (operating_income / total_revenue * 100) if total_revenue else Decimal("0"),
            "total_other_income": other_income,
            "total_other_expense": other_expense,
            "net_income": net_income,
            "net_income_margin": (net_income / total_revenue * 100) if total_revenue else Decimal("0"),

            "revenue_items": revenue_items,
            "cogs_items": cogs_items,
            "operating_expense_items": opex_items,
            "other_items": other_items,

            "forecast_confidence": Decimal("0.85"),
            "last_updated": datetime.utcnow().isoformat()
        }

    async def _get_confirmed_amounts(
        self,
        period_start: date,
        period_end: date,
        department_id: Optional[int]
    ) -> Dict[int, Decimal]:
        """확정된 전표 금액 조회"""
        conditions = [
            Voucher.voucher_date >= period_start,
            Voucher.voucher_date <= period_end,
            Voucher.status == VoucherStatus.CONFIRMED
        ]
        if department_id:
            conditions.append(Voucher.department_id == department_id)

        result = await self.db.execute(
            select(
                VoucherLine.account_id,
                func.sum(VoucherLine.debit_amount - VoucherLine.credit_amount).label("amount")
            ).join(Voucher).where(and_(*conditions)).group_by(VoucherLine.account_id)
        )

        return {row.account_id: row.amount for row in result.all()}

    async def _get_pending_amounts(
        self,
        period_start: date,
        period_end: date,
        department_id: Optional[int]
    ) -> Dict[int, Decimal]:
        """결재 중인 금액 조회"""
        conditions = [
            Voucher.voucher_date >= period_start,
            Voucher.voucher_date <= period_end,
            Voucher.status.in_([VoucherStatus.PENDING_APPROVAL, VoucherStatus.APPROVED])
        ]
        if department_id:
            conditions.append(Voucher.department_id == department_id)

        result = await self.db.execute(
            select(
                VoucherLine.account_id,
                func.sum(VoucherLine.debit_amount - VoucherLine.credit_amount).label("amount")
            ).join(Voucher).where(and_(*conditions)).group_by(VoucherLine.account_id)
        )

        return {row.account_id: row.amount for row in result.all()}

    async def _estimate_fixed_costs(
        self,
        period_start: date,
        period_end: date,
        department_id: Optional[int]
    ) -> Dict[int, Decimal]:
        """
        고정비 예측 (과거 데이터 기반)
        과거 3개월간의 계정과목별 합계를 구한 후 월 평균을 산출하고,
        예측 기간의 월 수에 맞게 조정한다.
        """
        lookback_start = period_start - timedelta(days=90)
        lookback_end = period_start - timedelta(days=1)

        # 실제 lookback 기간의 월 수 계산
        lookback_months = max(1, (lookback_end - lookback_start).days // 30)

        conditions = [
            Voucher.voucher_date >= lookback_start,
            Voucher.voucher_date <= lookback_end,
            Voucher.status == VoucherStatus.CONFIRMED
        ]
        if department_id:
            conditions.append(Voucher.department_id == department_id)

        # 계정과목별 총액을 구한 후, lookback 월 수로 나눠서 월 평균 산출
        result = await self.db.execute(
            select(
                VoucherLine.account_id,
                func.sum(VoucherLine.debit_amount - VoucherLine.credit_amount).label("total_amount")
            ).join(Voucher).where(and_(*conditions)).group_by(VoucherLine.account_id)
        )

        # 예측 기간의 월 수
        months_in_period = max(1, (period_end - period_start).days // 30)

        return {
            row.account_id: Decimal(str(
                round(float(row.total_amount) / lookback_months * months_in_period, 2)
            ))
            for row in result.all()
        }

    async def _get_budget_amounts(
        self,
        period_start: date,
        period_end: date,
        department_id: Optional[int]
    ) -> Dict[int, Decimal]:
        """예산 금액 조회 (기간 내 모든 월의 예산 합산, 연도 넘김 지원)"""
        month_names = ['jan', 'feb', 'mar', 'apr', 'may', 'jun',
                       'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

        # 연도가 다른 경우를 처리하기 위해 (year, month) 쌍의 리스트 생성
        year_months = []
        current = period_start.replace(day=1)
        end = period_end.replace(day=1)
        while current <= end:
            year_months.append((current.year, current.month))
            if current.month == 12:
                current = current.replace(year=current.year + 1, month=1)
            else:
                current = current.replace(month=current.month + 1)

        # 관련 연도들의 예산을 조회
        fiscal_years = list(set(ym[0] for ym in year_months))

        conditions = [Budget.fiscal_year.in_(fiscal_years), Budget.status == BudgetStatus.ACTIVE]
        if department_id:
            conditions.append(Budget.department_id == department_id)

        result = await self.db.execute(
            select(Budget)
            .options(selectinload(Budget.lines))
            .where(and_(*conditions))
        )
        budgets = result.scalars().unique().all()

        budget_amounts: Dict[int, Decimal] = {}
        for budget in budgets:
            for line in budget.lines:
                total = Decimal("0")
                for yr, m in year_months:
                    if yr == budget.fiscal_year:
                        month_attr = f"{month_names[m - 1]}_amount"
                        total += getattr(line, month_attr, Decimal("0")) or Decimal("0")

                if total > 0:
                    if line.account_id in budget_amounts:
                        budget_amounts[line.account_id] += total
                    else:
                        budget_amounts[line.account_id] = total

        return budget_amounts

    def _get_pl_category(self, account: Account) -> str:
        """
        계정과목의 손익 카테고리 분류 (K-IFRS 6자리 코드 기준)

        코드 체계:
        - 41xxxx: 매출(수익)
        - 51xxxx~52xxxx: 매출원가(COGS)
        - 81xxxx~84xxxx: 판매비와관리비(Operating Expense)
        - 91xxxx: 영업외수익 (other_income)
        - 95xxxx: 영업외비용 (other_expense)
        """
        code = account.code

        # 매출/수익 (41xxxx)
        if code.startswith("41"):
            return "revenue"
        # 매출원가 (51xxxx, 52xxxx)
        elif code.startswith("51") or code.startswith("52"):
            return "cogs"
        # 판매비와관리비 (81xxxx ~ 84xxxx)
        elif code.startswith("8"):
            return "operating_expense"
        # 영업외수익 (91xxxx)
        elif code.startswith("91"):
            return "other_income"
        # 영업외비용 (95xxxx)
        elif code.startswith("95"):
            return "other_expense"
        return "other"

    # ==================== 자금 수지 예측 ====================

    async def get_cash_flow_forecast(
        self,
        forecast_days: int = 30,
        start_date: Optional[date] = None
    ) -> dict:
        """
        자금 수지 예측
        현재 잔액 - 지급 예정 + 입금 예정 = 월말 예상 자금
        """
        if not start_date:
            start_date = date.today()
        end_date = start_date + timedelta(days=forecast_days)

        # 1. 현재 현금 잔액
        result = await self.db.execute(
            select(func.sum(BankAccount.current_balance)).where(
                and_(
                    BankAccount.is_active == True,
                    BankAccount.account_type != BankAccountType.VIRTUAL
                )
            )
        )
        opening_balance = result.scalar() or Decimal("0")

        # 2. 예상 입금 (매출채권)
        result = await self.db.execute(
            select(Receivable).where(
                and_(
                    Receivable.due_date >= start_date,
                    Receivable.due_date <= end_date,
                    Receivable.outstanding_amount > 0
                )
            )
        )
        receivables = result.scalars().all()

        expected_inflows = []
        for r in receivables:
            expected_inflows.append({
                "item_type": "inflow",
                "category": "operating",
                "description": f"매출채권 입금 - {r.customer_name}",
                "expected_date": r.due_date.isoformat(),
                "amount": r.outstanding_amount,
                "confidence": Decimal("0.7"),
                "source": "receivable"
            })

        # 3. 예상 출금 (매입채무 + 지급 스케줄)
        result = await self.db.execute(
            select(Payable).where(
                and_(
                    Payable.due_date >= start_date,
                    Payable.due_date <= end_date,
                    Payable.outstanding_amount > 0
                )
            )
        )
        payables = result.scalars().all()

        expected_outflows = []
        for p in payables:
            expected_outflows.append({
                "item_type": "outflow",
                "category": "operating",
                "description": f"매입채무 지급 - {p.vendor_name}",
                "expected_date": p.due_date.isoformat(),
                "amount": p.outstanding_amount,
                "confidence": Decimal("0.9"),
                "source": "payable"
            })

        # 지급 스케줄
        result = await self.db.execute(
            select(PaymentSchedule).where(
                and_(
                    PaymentSchedule.scheduled_date >= start_date,
                    PaymentSchedule.scheduled_date <= end_date,
                    PaymentSchedule.is_executed == False
                )
            )
        )
        schedules = result.scalars().all()

        for s in schedules:
            expected_outflows.append({
                "item_type": "outflow",
                "category": "operating",
                "description": f"예정 지급 - 스케줄 #{s.id}",
                "expected_date": s.scheduled_date.isoformat(),
                "amount": s.scheduled_amount,
                "confidence": Decimal("0.95"),
                "source": "scheduled"
            })

        # 4. 일별 예측
        daily_forecast = []
        running_balance = opening_balance

        current_date = start_date
        while current_date <= end_date:
            day_inflows = sum(
                i["amount"] for i in expected_inflows
                if i["expected_date"] == current_date.isoformat()
            )
            day_outflows = sum(
                o["amount"] for o in expected_outflows
                if o["expected_date"] == current_date.isoformat()
            )

            closing = running_balance + day_inflows - day_outflows

            daily_forecast.append({
                "date": current_date.isoformat(),
                "opening": running_balance,
                "inflows": day_inflows,
                "outflows": day_outflows,
                "closing": closing
            })

            running_balance = closing
            current_date += timedelta(days=1)

        # 5. 최소 잔액 날짜 찾기
        min_balance_day = min(daily_forecast, key=lambda x: x["closing"])

        # 6. 현금 부족 알림
        cash_alerts = []
        for day in daily_forecast:
            if day["closing"] < 0:
                cash_alerts.append({
                    "date": day["date"],
                    "shortage_amount": abs(day["closing"]),
                    "message": f"{day['date']}에 {abs(day['closing']):,.0f}원 자금 부족 예상"
                })

        total_inflows = sum(i["amount"] for i in expected_inflows)
        total_outflows = sum(o["amount"] for o in expected_outflows)

        return {
            "forecast_date": start_date.isoformat(),
            "forecast_days": forecast_days,
            "opening_balance": opening_balance,
            "daily_forecast": daily_forecast,
            "projected_closing_balance": running_balance,
            "minimum_balance_date": min_balance_day["date"],
            "minimum_balance_amount": min_balance_day["closing"],
            "operating_inflows": total_inflows,
            "operating_outflows": total_outflows,
            "expected_inflows": expected_inflows,
            "expected_outflows": expected_outflows,
            "cash_shortage_alerts": cash_alerts
        }

    # ==================== 시나리오 시뮬레이션 ====================

    async def run_scenario_simulation(
        self,
        scenario_name: str,
        base_period_start: date,
        base_period_end: date,
        variables: List[dict],
        forecast_periods: int = 12,
        description: Optional[str] = None
    ) -> dict:
        """
        What-If 시나리오 시뮬레이션
        매출 변동, 원가 변동 등 시나리오 분석
        """
        # 기준 기간 데이터 조회
        baseline_pl = await self.get_estimated_pl(base_period_start, base_period_end)

        # 기준 값 추출
        baseline = {
            "revenue": float(baseline_pl["total_revenue"]),
            "cogs": float(baseline_pl["total_cogs"]),
            "gross_profit": float(baseline_pl["gross_profit"]),
            "operating_expense": float(baseline_pl["total_operating_expense"]),
            "operating_income": float(baseline_pl["operating_income"]),
            "net_income": float(baseline_pl["net_income"])
        }

        # 시나리오 적용 (복합 성장률 적용)
        scenario_results = []
        cumulative_cash = 0

        # 기간별 누적 성장 추적
        revenue = baseline["revenue"]
        cogs = baseline["cogs"]
        opex = baseline["operating_expense"]

        for period in range(1, forecast_periods + 1):
            # 변수 적용 (매 기간 누적 적용 - 복합 성장)
            for var in variables:
                change = float(var.get("change_value", 0))

                if var["variable_name"] == "revenue_growth":
                    if var["change_type"] == "percentage":
                        revenue *= (1 + change / 100)
                    else:
                        revenue += change

                elif var["variable_name"] == "cogs_increase":
                    if var["change_type"] == "percentage":
                        cogs *= (1 + change / 100)
                    else:
                        cogs += change

                elif var["variable_name"] == "expense_change":
                    if var["change_type"] == "percentage":
                        opex *= (1 + change / 100)
                    else:
                        opex += change

            gross_profit = revenue - cogs
            operating_income = gross_profit - opex
            net_income = operating_income  # 단순화

            # 현금흐름 (단순화: 순이익 + 감가상각 추정)
            cash_flow = net_income * 0.8  # 실제로는 더 정교한 계산 필요
            cumulative_cash += cash_flow

            scenario_results.append({
                "period": f"Month {period}",
                "revenue": Decimal(str(round(revenue, 2))),
                "cogs": Decimal(str(round(cogs, 2))),
                "gross_profit": Decimal(str(round(gross_profit, 2))),
                "operating_expense": Decimal(str(round(opex, 2))),
                "operating_income": Decimal(str(round(operating_income, 2))),
                "net_income": Decimal(str(round(net_income, 2))),
                "cash_flow": Decimal(str(round(cash_flow, 2))),
                "cumulative_cash_flow": Decimal(str(round(cumulative_cash, 2)))
            })

        # 시나리오 요약
        final_result = scenario_results[-1]

        total_scenario_revenue = sum(r["revenue"] for r in scenario_results)
        total_scenario_oi = sum(r["operating_income"] for r in scenario_results)
        total_scenario_ni = sum(r["net_income"] for r in scenario_results)

        scenario_summary = {
            "total_revenue": total_scenario_revenue,
            "total_operating_income": total_scenario_oi,
            "total_net_income": total_scenario_ni,
            "average_margin": (total_scenario_oi / total_scenario_revenue * 100) if total_scenario_revenue else Decimal("0")
        }

        baseline_total_revenue = baseline["revenue"] * forecast_periods
        baseline_total_oi = baseline["operating_income"] * forecast_periods
        baseline_total_ni = baseline["net_income"] * forecast_periods

        return {
            "scenario_name": scenario_name,
            "description": description,
            "variables_applied": variables,
            "baseline_summary": {
                "total_revenue": Decimal(str(round(baseline_total_revenue, 2))),
                "total_operating_income": Decimal(str(round(baseline_total_oi, 2))),
                "total_net_income": Decimal(str(round(baseline_total_ni, 2)))
            },
            "scenario_summary": scenario_summary,
            "period_results": scenario_results,
            "revenue_change": scenario_summary["total_revenue"] - Decimal(str(baseline_total_revenue)),
            "revenue_change_pct": ((float(scenario_summary["total_revenue"]) - baseline_total_revenue) / baseline_total_revenue * 100) if baseline_total_revenue else 0,
            "operating_income_change": scenario_summary["total_operating_income"] - Decimal(str(baseline_total_oi)),
            "operating_income_change_pct": (float(scenario_summary["total_operating_income"]) - baseline_total_oi) / baseline_total_oi * 100 if baseline_total_oi else 0,
            "net_income_change": scenario_summary["total_net_income"] - Decimal(str(baseline_total_ni)),
            "net_income_change_pct": (float(scenario_summary["total_net_income"]) - baseline_total_ni) / baseline_total_ni * 100 if baseline_total_ni else 0,
            "cash_impact": final_result["cumulative_cash_flow"],
            "chart_data": {
                "labels": [r["period"] for r in scenario_results],
                "baseline_revenue": [baseline["revenue"]] * forecast_periods,
                "scenario_revenue": [float(r["revenue"]) for r in scenario_results],
                "baseline_profit": [baseline["operating_income"]] * forecast_periods,
                "scenario_profit": [float(r["operating_income"]) for r in scenario_results]
            },
            "created_at": datetime.utcnow().isoformat()
        }
