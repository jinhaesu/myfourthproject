"""
4대보험 기준 API — 회계팀 편집(요율·비자규칙·근로자설정) + 미리보기.
급여 산정(payroll_import)은 여기 헬퍼로 DB기준을 로드해 insurance_policy.assess 를 호출한다.
"""
from datetime import date
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.models.insurance import InsuranceRate, InsuranceVisaRule, InsuranceWorkerOverride
from app.services import insurance_policy as pol

router = APIRouter()


# ───────── 로더/시드 (payroll_import 에서도 재사용) ─────────
async def load_rates(db: AsyncSession, year: int) -> Dict[str, float]:
    row = (await db.execute(select(InsuranceRate).where(InsuranceRate.year == year))).scalar_one_or_none()
    if not row:
        return dict(pol.DEFAULT_RATES)
    return {
        "pension_emp": row.pension_emp, "health_emp": row.health_emp,
        "ltc_on_health": row.ltc_on_health, "employment_ui_emp": row.employment_ui_emp,
        "pension_base_min": row.pension_base_min, "pension_base_max": row.pension_base_max,
    }


async def load_visa_rules(db: AsyncSession) -> Dict[str, Dict[str, Any]]:
    rows = (await db.execute(select(InsuranceVisaRule))).scalars().all()
    if not rows:
        return dict(pol.DEFAULT_VISA_RULES)
    return {
        r.visa_type: {"pension": r.pension, "health": r.health, "employment": r.employment,
                      "ltc_exclusion_eligible": r.ltc_exclusion_eligible, "label": r.label}
        for r in rows
    }


async def load_override(db: AsyncSession, worker_key: Optional[str]) -> Optional[InsuranceWorkerOverride]:
    if not worker_key:
        return None
    return (await db.execute(
        select(InsuranceWorkerOverride).where(InsuranceWorkerOverride.worker_key == worker_key)
    )).scalar_one_or_none()


async def ensure_seed(db: AsyncSession) -> None:
    """올해 요율·비자규칙이 비어있으면 코드 기본값으로 멱등 시드."""
    y = date.today().year
    has_rate = (await db.execute(select(InsuranceRate.id).where(InsuranceRate.year == y))).first()
    if not has_rate:
        db.add(InsuranceRate(year=y, **{k: float(v) for k, v in pol.DEFAULT_RATES.items()}))
    has_rule = (await db.execute(select(InsuranceVisaRule.id))).first()
    if not has_rule:
        for visa, r in pol.DEFAULT_VISA_RULES.items():
            db.add(InsuranceVisaRule(
                visa_type=visa, pension=r["pension"], health=r["health"],
                employment=r["employment"], ltc_exclusion_eligible=r["ltc_exclusion_eligible"],
                label=r.get("label"),
            ))
    await db.commit()


# ───────── 조회/편집 ─────────
@router.get("/policy")
async def get_policy(db: AsyncSession = Depends(get_db)):
    await ensure_seed(db)
    y = date.today().year
    rates = await load_rates(db, y)
    rules = (await db.execute(select(InsuranceVisaRule).order_by(InsuranceVisaRule.visa_type))).scalars().all()
    return {
        "year": y,
        "rates": rates,
        "visa_rules": [{
            "visa_type": r.visa_type, "pension": r.pension, "health": r.health,
            "employment": r.employment, "ltc_exclusion_eligible": r.ltc_exclusion_eligible, "label": r.label,
        } for r in rules],
        "sources": pol.SOURCES,
        "status_options": {
            "pension": ["mandatory", "excluded", "reciprocity", "optional"],
            "health": ["mandatory", "excluded"],
            "employment": ["mandatory", "e9h2", "optional", "excluded"],
        },
    }


class RatesReq(BaseModel):
    year: int
    pension_emp: Optional[float] = None
    health_emp: Optional[float] = None
    ltc_on_health: Optional[float] = None
    employment_ui_emp: Optional[float] = None
    pension_base_min: Optional[float] = None
    pension_base_max: Optional[float] = None


@router.put("/rates")
async def put_rates(req: RatesReq, db: AsyncSession = Depends(get_db)):
    row = (await db.execute(select(InsuranceRate).where(InsuranceRate.year == req.year))).scalar_one_or_none()
    if not row:
        row = InsuranceRate(year=req.year, **{k: float(v) for k, v in pol.DEFAULT_RATES.items()})
        db.add(row)
    for f in ("pension_emp", "health_emp", "ltc_on_health", "employment_ui_emp", "pension_base_min", "pension_base_max"):
        v = getattr(req, f)
        if v is not None:
            setattr(row, f, float(v))
    await db.commit()
    return {"ok": True}


class VisaRuleReq(BaseModel):
    visa_type: str
    pension: str
    health: str
    employment: str
    ltc_exclusion_eligible: bool = False
    label: Optional[str] = None


@router.put("/visa-rule")
async def put_visa_rule(req: VisaRuleReq, db: AsyncSession = Depends(get_db)):
    vt = req.visa_type.strip().upper().replace(" ", "")
    row = (await db.execute(select(InsuranceVisaRule).where(InsuranceVisaRule.visa_type == vt))).scalar_one_or_none()
    if not row:
        row = InsuranceVisaRule(visa_type=vt)
        db.add(row)
    row.pension, row.health, row.employment = req.pension, req.health, req.employment
    row.ltc_exclusion_eligible, row.label = req.ltc_exclusion_eligible, req.label
    await db.commit()
    return {"ok": True}


class WorkerOverrideReq(BaseModel):
    worker_key: str
    nationality_country: Optional[str] = None
    pension_country_excluded: bool = False
    ltc_exclusion_applied: bool = False
    ui_opt_in: bool = False
    memo: Optional[str] = None


@router.put("/worker-override")
async def put_worker_override(req: WorkerOverrideReq, db: AsyncSession = Depends(get_db)):
    row = (await db.execute(
        select(InsuranceWorkerOverride).where(InsuranceWorkerOverride.worker_key == req.worker_key)
    )).scalar_one_or_none()
    if not row:
        row = InsuranceWorkerOverride(worker_key=req.worker_key)
        db.add(row)
    row.nationality_country = req.nationality_country
    row.pension_country_excluded = req.pension_country_excluded
    row.ltc_exclusion_applied = req.ltc_exclusion_applied
    row.ui_opt_in = req.ui_opt_in
    row.memo = req.memo
    await db.commit()
    return {"ok": True}


@router.get("/preview")
async def preview(
    nationality: str = Query("FOREIGN"), visa: Optional[str] = Query(None),
    gross: float = Query(3_000_000), age: Optional[int] = Query(None),
    ltc_applied: bool = Query(False), ui_opt_in: bool = Query(False),
    country_excluded: bool = Query(False),
    db: AsyncSession = Depends(get_db),
):
    await ensure_seed(db)
    rates = await load_rates(db, date.today().year)
    rules = await load_visa_rules(db)
    return pol.assess(
        nationality=nationality, visa_type=visa, gross_monthly=gross, age=age,
        rates=rates, db_rules=rules,
        ltc_exclusion_applied=ltc_applied, ui_opt_in=ui_opt_in,
        pension_country_excluded=country_excluded,
    )
