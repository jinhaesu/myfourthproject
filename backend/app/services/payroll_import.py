"""
급여 통합 임포트 — 외부 HR 시스템에서 확정 급여/노무비를 가져와 분류.

소스:
- 정규직 급여: hr.nuldam.com (myseventhproject) → 판관비(SGA)
- 정규직/사업소득/파견 노무비: aisystem.nuldam.com (mysixthproject) → 원가(COGS)

확정 기준: 매달 10일이 급여일. 조회일 기준 '가장 최근에 지난 급여일'의 대상 급여월을
확정 급여월로 본다 (예: 7/25 조회 → 7/10 급여일 지남 → 6월분 확정,
7/5 조회 → 아직 7/10 전 → 5월분 확정).

인증: 각 소스의 JWT_SECRET을 env로 받아 매 호출 시 단기 토큰 자체발행.
"""
from __future__ import annotations

import logging
import os
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

import httpx
from jose import jwt

logger = logging.getLogger(__name__)

PAYDAY = 10  # 매달 급여일

# 주의: hr.nuldam.com·aisystem.nuldam.com은 프론트(Next.js)라 /api 없음.
# 실제 백엔드 = Railway 도메인.
HR_BASE = os.getenv("HR_SALARY_BASE_URL", "https://proud-charm-production-be52.up.railway.app")
HR_JWT_SECRET = os.getenv("HR_JWT_SECRET", "")
HR_JARVIS_API_KEY = os.getenv("HR_JARVIS_API_KEY", "")

AISYSTEM_BASE = os.getenv("AISYSTEM_BASE_URL", "https://mysixthproject-production.up.railway.app")
AISYSTEM_JWT_SECRET = os.getenv("AISYSTEM_JWT_SECRET", "")

ADMIN_EMAIL = "lion9080@joinandjoin.com"


def confirmed_payroll_month(as_of: Optional[date] = None) -> str:
    """조회일 기준 확정 급여월(YYYY-MM) 계산.

    급여일(10일)이 지났으면 '전월'이 확정, 아직이면 '전전월'이 확정.
    (10일에 지급되는 급여는 전월 근무분)
    """
    d = as_of or date.today()
    # 지급 대상월 = 이번 달 10일이 지났으면 전월, 아니면 전전월
    base = d.replace(day=1)
    if d.day > PAYDAY:
        # 이번 달 10일 지남 → 지급된 건 전월분
        target = (base - timedelta(days=1)).replace(day=1)
    else:
        # 아직 이번 달 10일 전 → 마지막 지급은 전월 10일 = 전전월분
        prev = (base - timedelta(days=1)).replace(day=1)
        target = (prev - timedelta(days=1)).replace(day=1)
    return target.strftime("%Y-%m")


def _issue_token(secret: str, payload: Dict[str, Any]) -> str:
    body = {**payload, "iat": datetime.now(timezone.utc), "exp": datetime.now(timezone.utc) + timedelta(minutes=10)}
    return jwt.encode(body, secret, algorithm="HS256")


def _num(v: Any) -> float:
    try:
        return float(v or 0)
    except (ValueError, TypeError):
        return 0.0


# ==================== 정규직 급여 (hr.nuldam.com → 판관비) ====================

async def fetch_hr_salary(month: str) -> List[Dict[str, Any]]:
    """정규직 급여대장 — GET /api/salary/payroll?month=YYYY-MM."""
    if not HR_JWT_SECRET and not HR_JARVIS_API_KEY:
        logger.warning("HR_JWT_SECRET/HR_JARVIS_API_KEY 미설정 — 정규직 급여 스킵")
        return []

    if HR_JARVIS_API_KEY:
        auth = HR_JARVIS_API_KEY
    else:
        # verify는 {employeeId, ...} 또는 {isJarvis} 허용
        auth = _issue_token(HR_JWT_SECRET, {
            "employeeId": "accounting-import", "email": ADMIN_EMAIL,
            "name": "회계연동", "role": "admin",
        })

    try:
        async with httpx.AsyncClient(timeout=25.0) as client:
            r = await client.get(
                f"{HR_BASE}/api/salary/payroll",
                params={"month": month},
                headers={"Authorization": f"Bearer {auth}"},
            )
        if r.status_code != 200:
            logger.error(f"HR salary {r.status_code}: {r.text[:200]}")
            return []
        payroll = r.json().get("payroll", [])
    except Exception:
        logger.exception("HR salary 호출 실패")
        return []

    out = []
    for p in payroll:
        ded = p.get("deductions", {}) or {}
        insurance = (
            _num(ded.get("national_pension")) + _num(ded.get("health_insurance"))
            + _num(ded.get("long_term_care")) + _num(ded.get("employment_insurance"))
        )
        # 세전 급여 구성 상세 (드릴다운용)
        earnings = [
            ("기본급", _num(p.get("base_salary"))),
            ("직책수당", _num(p.get("position_allowance"))),
            ("연장수당", _num(p.get("overtime_allowance"))),
            ("식대", _num(p.get("meal_allowance"))),
            ("통신비", _num(p.get("communication_allowance"))),
            ("차량유지", _num(p.get("vehicle_allowance"))),
            ("상여", _num(p.get("bonus"))),
            ("기타수당", _num(p.get("other_allowance"))),
        ]
        deductions = [
            ("국민연금", _num(ded.get("national_pension"))),
            ("건강보험", _num(ded.get("health_insurance"))),
            ("장기요양", _num(ded.get("long_term_care"))),
            ("고용보험", _num(ded.get("employment_insurance"))),
            ("소득세", _num(ded.get("income_tax"))),
            ("지방소득세", _num(ded.get("local_income_tax"))),
        ]
        out.append({
            "source": "hr",
            "worker_type": "정규직",
            "cost_type": "SGA",  # 판관비
            "name": p.get("name"),
            "department": p.get("department_name") or "(부서없음)",
            "position": p.get("position") or "",
            "gross_pay": _num(p.get("gross_pay")),
            "income_tax": _num(ded.get("income_tax")),
            "local_tax": _num(ded.get("local_income_tax")),
            "insurance": insurance,
            "total_deduction": _num(ded.get("total")),
            "net_pay": _num(p.get("net_pay")),
            "tax_source": "hr_computed",  # 소스에서 이미 계산됨
            "non_taxable": _num(p.get("non_taxable")),
            "detail": {
                "earnings": [{"label": k, "amount": v} for k, v in earnings if v],
                "deductions": [{"label": k, "amount": v} for k, v in deductions if v],
                "note": "정규직 급여(간이세액표 기준 원천징수). 소스 확정값.",
            },
        })
    return out


# ==================== 노무비 (aisystem.nuldam.com → 원가) ====================

async def _aisystem_get(path: str, params: Dict[str, Any]) -> Any:
    if not AISYSTEM_JWT_SECRET:
        logger.warning("AISYSTEM_JWT_SECRET 미설정 — 노무비 스킵")
        return None
    token = _issue_token(AISYSTEM_JWT_SECRET, {"email": ADMIN_EMAIL, "type": "auth"})
    try:
        async with httpx.AsyncClient(timeout=25.0) as client:
            r = await client.get(
                f"{AISYSTEM_BASE}{path}", params=params,
                headers={"Authorization": f"Bearer {token}"},
            )
        if r.status_code != 200:
            logger.error(f"aisystem {path} {r.status_code}: {r.text[:200]}")
            return None
        return r.json()
    except Exception:
        logger.exception(f"aisystem {path} 호출 실패")
        return None


async def fetch_aisystem_regular(month: str) -> List[Dict[str, Any]]:
    """aisystem 정규직 급여대장 — GET /api/regular/payroll-calc?year_month=YYYY-MM.
    마감(is_closed)된 경우만 확정으로 인정."""
    data = await _aisystem_get("/api/regular/payroll-calc", {"year_month": month})
    if not data:
        return []
    if not data.get("is_closed"):
        logger.info(f"aisystem 정규직 {month} 미마감 — 제외")
        return []
    out = []
    for p in data.get("results", []):
        insurance = (
            _num(p.get("national_pension")) + _num(p.get("health_insurance"))
            + _num(p.get("long_term_care")) + _num(p.get("employment_insurance"))
        )
        earnings = [
            ("기본급", _num(p.get("base_pay"))),
            ("직책수당", _num(p.get("position_allowance"))),
            ("연장수당", _num(p.get("overtime_pay"))),
            ("휴일수당", _num(p.get("holiday_pay"))),
            ("식대", _num(p.get("meal_allowance"))),
            ("상여", _num(p.get("bonus"))),
            ("기타수당", _num(p.get("other_allowance"))),
            ("조정", _num(p.get("adjustment_amount"))),
        ]
        deductions = [
            ("국민연금", _num(p.get("national_pension"))),
            ("건강보험", _num(p.get("health_insurance"))),
            ("장기요양", _num(p.get("long_term_care"))),
            ("고용보험", _num(p.get("employment_insurance"))),
            ("소득세", _num(p.get("income_tax"))),
            ("지방소득세", _num(p.get("local_tax"))),
        ]
        ot_h = _num(p.get("overtime_hours"))
        note = f"현장직 노무비. 근무 연장 {ot_h:.0f}h" if ot_h else "현장직 노무비."
        out.append({
            "source": "aisystem",
            "worker_type": "정규직(노무)",
            "job_type": "현장직",
            "cost_type": "COGS",  # 노무비=원가
            "name": p.get("name"),
            "department": p.get("department") or "(부서없음)",
            "gross_pay": _num(p.get("gross_pay")),
            "income_tax": _num(p.get("income_tax")),
            "local_tax": _num(p.get("local_tax")),
            "insurance": insurance,
            "total_deduction": _num(p.get("total_deductions")),
            "net_pay": _num(p.get("net_pay")),
            "tax_source": "aisystem_computed",
            "detail": {
                "earnings": [{"label": k, "amount": v} for k, v in earnings if v],
                "deductions": [{"label": k, "amount": v} for k, v in deductions if v],
                "note": note,
            },
        })
    return out


async def fetch_aisystem_settlement(month: str, worker_type: str) -> List[Dict[str, Any]]:
    """사업소득/파견 노무비 — GET /api/survey/settlement (시간만 반환, 금액은 시급×시간).
    3.3% 원천징수는 사업소득만 적용."""
    api_type = "dispatch" if worker_type == "파견" else "alba"
    data = await _aisystem_get("/api/survey/settlement", {"year_month": month, "type": api_type})
    if not data:
        return []

    # 시급 조회
    rates: Dict[str, float] = {}
    lite = await _aisystem_get("/api/workers/lite", {})
    if isinstance(lite, dict):
        workers = lite.get("workers") or lite.get("data") or []
    elif isinstance(lite, list):
        workers = lite
    else:
        workers = []
    for w in workers:
        nm = (w.get("name") or "").strip()
        if nm:
            rates[nm] = _num(w.get("hourly_rate"))

    out = []
    for p in data.get("results", []):
        name = (p.get("name") or "").strip()
        rate = rates.get(name, 0.0)
        hours = (
            _num(p.get("regular_hours")) + _num(p.get("overtime_hours")) * 1.5
            + _num(p.get("night_hours")) * 0.5 + _num(p.get("weekly_holiday_hours"))
            + _num(p.get("holiday_pay_hours")) * 1.5
        )
        gross = round(rate * hours)
        is_freelance = worker_type != "파견"  # 사업소득만 3.3%
        # 사업소득 3.3% = 소득세 3% + 지방소득세 0.3%
        income_tax = round(gross * 0.03) if is_freelance else 0
        local_tax = round(gross * 0.003) if is_freelance else 0
        withhold = income_tax + local_tax
        hour_parts = [
            ("기본근무", _num(p.get("regular_hours"))),
            ("연장(×1.5)", _num(p.get("overtime_hours"))),
            ("야간(×0.5)", _num(p.get("night_hours"))),
            ("주휴", _num(p.get("weekly_holiday_hours"))),
            ("휴일(×1.5)", _num(p.get("holiday_pay_hours"))),
        ]
        if is_freelance:
            note = (f"사업소득(우리가 3.3% 원천징수·신고). 시급 {rate:,.0f}원 × 환산 {hours:.0f}h. "
                    f"근무 {_num(p.get('work_days')):.0f}일.")
            wt = "사업소득(알바)"
        else:
            note = (f"파견 노무비(거래처에 지급 — 세금 원천징수 없음, 파견업체가 처리). "
                    f"시급 {rate:,.0f}원 × 환산 {hours:.0f}h.")
            wt = "파견(거래처지급)"
        out.append({
            "source": "aisystem",
            "worker_type": wt,
            "job_type": "현장직",
            "cost_type": "COGS",  # 노무비=원가
            "name": name,
            "department": p.get("department") or p.get("division") or "(부서없음)",
            "gross_pay": gross,
            "income_tax": income_tax,
            "local_tax": local_tax,
            "insurance": 0.0,
            "total_deduction": withhold,
            "net_pay": gross - withhold,
            "hours": hours,
            "hourly_rate": rate,
            "work_days": _num(p.get("work_days")),
            "tax_source": "freelance_3.3" if is_freelance else "dispatch_vendor",
            "detail": {
                "earnings": [{"label": "노무비(시급×시간)", "amount": gross}],
                "deductions": ([{"label": "소득세(3%)", "amount": income_tax},
                                {"label": "지방소득세(0.3%)", "amount": local_tax}]
                               if is_freelance else []),
                "hours": [{"label": k, "amount": v} for k, v in hour_parts if v],
                "note": note,
            },
        })
    return out


# ==================== 통합 + 분류 ====================

async def build_payroll_summary(month: Optional[str] = None) -> Dict[str, Any]:
    """확정 급여월의 전체 리스트 + 부서별/원가판관비 분류."""
    target = month or confirmed_payroll_month()

    import asyncio
    hr, ai_reg, ai_alba, ai_disp = await asyncio.gather(
        fetch_hr_salary(target),
        fetch_aisystem_regular(target),
        fetch_aisystem_settlement(target, "사업소득"),
        fetch_aisystem_settlement(target, "파견"),
    )
    records = [*hr, *ai_reg, *ai_alba, *ai_disp]

    # 부서별 집계
    by_dept: Dict[str, Dict[str, Any]] = {}
    by_cost: Dict[str, Dict[str, Any]] = {
        "COGS": {"cost_type": "COGS", "label": "노무비(원가)", "gross": 0.0, "count": 0},
        "SGA": {"cost_type": "SGA", "label": "급여(판관비)", "gross": 0.0, "count": 0},
    }
    by_type: Dict[str, Dict[str, Any]] = {}
    total_gross = total_net = total_tax = total_insurance = 0.0
    for r in records:
        wt = r.get("worker_type", "기타")
        bt = by_type.setdefault(wt, {"worker_type": wt, "cost_type": r["cost_type"], "gross": 0.0, "net": 0.0, "count": 0})
        bt["gross"] += r["gross_pay"]; bt["net"] += r["net_pay"]; bt["count"] += 1
        d = by_dept.setdefault(r["department"], {
            "department": r["department"], "gross": 0.0, "net": 0.0,
            "tax": 0.0, "insurance": 0.0, "count": 0,
            "cogs": 0.0, "sga": 0.0,
        })
        d["gross"] += r["gross_pay"]
        d["net"] += r["net_pay"]
        d["tax"] += r["income_tax"] + r["local_tax"]
        d["insurance"] += r["insurance"]
        d["count"] += 1
        d["cogs" if r["cost_type"] == "COGS" else "sga"] += r["gross_pay"]

        by_cost[r["cost_type"]]["gross"] += r["gross_pay"]
        by_cost[r["cost_type"]]["count"] += 1
        total_gross += r["gross_pay"]
        total_net += r["net_pay"]
        total_tax += r["income_tax"] + r["local_tax"]
        total_insurance += r["insurance"]

    return {
        "month": target,
        "payday": f"{target}-{PAYDAY:02d} 기준 확정",
        "records": records,
        "by_department": sorted(by_dept.values(), key=lambda x: x["gross"], reverse=True),
        "by_cost_type": list(by_cost.values()),
        "by_worker_type": sorted(by_type.values(), key=lambda x: x["gross"], reverse=True),
        "totals": {
            "gross": total_gross, "net": total_net,
            "tax": total_tax, "insurance": total_insurance,
            "count": len(records),
        },
        "sources": {
            "hr_regular": len(hr),
            "aisystem_regular": len(ai_reg),
            "aisystem_freelance": len(ai_alba),
            "aisystem_dispatch": len(ai_disp),
        },
    }
