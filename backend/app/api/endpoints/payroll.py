"""
Smart Finance Core - Payroll API
급여(인건비) 관리 엔드포인트

prefix: /payroll
tags: ["급여관리"]

분개 계정 매핑 (K-GAAP 3자리 코드):
  801 → 급여 (판관비 SGA)
  504 → 노무비 (제조원가 COGS)
  254 → 예수금 (소득세·지방세·4대보험 공제)
  103 → 보통예금 (차인지급액 실지급)
"""
from __future__ import annotations

import logging
import uuid as _uuid
from datetime import datetime, date
from decimal import Decimal
from typing import Optional, List, Dict, Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import select, func, and_, delete
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.database import get_db
from app.core.security import get_current_user
from app.models.accounting import (
    Account, AccountCategory,
    Voucher, VoucherLine, VoucherStatus, TransactionType,
)
from app.models.payroll import PayrollBatch, PayrollRecord

logger = logging.getLogger(__name__)
router = APIRouter()

# ---------------------------------------------------------------------------
# 분개 계정 매핑 (K-GAAP 3자리 코드)
# ---------------------------------------------------------------------------
PAYROLL_ACCOUNT_MAP: Dict[str, str] = {
    "salary_sga": "801",   # 급여(판관)
    "salary_cogs": "504",  # 노무비(제조)
    "withholding": "254",  # 예수금(소득세·지방세·4대보험 공제)
    "net_pay_bank": "103", # 보통예금(실지급)
}

PAYROLL_ACCOUNT_NAMES: Dict[str, str] = {
    "801": "급여",
    "504": "노무비",
    "254": "예수금",
    "103": "보통예금",
}


# ---------------------------------------------------------------------------
# 내부 헬퍼
# ---------------------------------------------------------------------------

async def _resolve_account(
    db: AsyncSession,
    code: str,
    cache: Dict[str, int],
) -> int:
    """계정코드 → accounts.id. 없으면 자동 생성."""
    if code in cache:
        return cache[code]

    acc = (await db.execute(
        select(Account).where(Account.code == code, Account.is_active == True)
    )).scalar_one_or_none()
    if acc:
        cache[code] = acc.id
        return acc.id

    # 자동 생성 — 카테고리 추정
    first = code.lstrip("0")[:1] if code else "9"
    cat_code_map = {
        "1": "1", "2": "2", "3": "3", "4": "4",
        "5": "5", "6": "5", "7": "5", "8": "5", "9": "5",
    }
    cat_code = cat_code_map.get(first, "5")
    cat = (await db.execute(
        select(AccountCategory).where(AccountCategory.code == cat_code)
    )).scalar_one_or_none()
    if not cat:
        cat = (await db.execute(select(AccountCategory).limit(1))).scalar_one_or_none()
    if not cat:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"계정 자동 생성 실패: AccountCategory 시드 없음 (code={code})",
        )

    name = PAYROLL_ACCOUNT_NAMES.get(code, f"계정 {code}")
    new_acc = Account(
        code=code,
        name=name,
        category_id=cat.id,
        level=1,
        is_detail=True,
        is_vat_applicable=False,
        vat_rate=Decimal("0.00"),
        is_active=True,
    )
    db.add(new_acc)
    await db.flush()
    cache[code] = new_acc.id
    return new_acc.id


async def _recalc_batch_totals(db: AsyncSession, batch: PayrollBatch) -> None:
    """batch.records 기반으로 batch 합계 재계산."""
    result = await db.execute(
        select(
            func.coalesce(func.sum(PayrollRecord.gross_pay), Decimal("0")),
            func.coalesce(func.sum(PayrollRecord.total_deduction), Decimal("0")),
            func.coalesce(func.sum(PayrollRecord.net_pay), Decimal("0")),
        ).where(PayrollRecord.batch_id == batch.id)
    )
    row = result.one()
    batch.total_gross = row[0]
    batch.total_deduction = row[1]
    batch.total_net = row[2]
    batch.updated_at = datetime.utcnow()


def _calc_record_amounts(data: dict) -> dict:
    """gross_pay / total_deduction / net_pay 자동 계산."""
    gross = (
        Decimal(str(data.get("base_pay", 0)))
        + Decimal(str(data.get("meal_allowance", 0)))
        + Decimal(str(data.get("overtime_pay", 0)))
        + Decimal(str(data.get("bonus", 0)))
        + Decimal(str(data.get("other_allowance", 0)))
    )
    total_ded = (
        Decimal(str(data.get("income_tax", 0)))
        + Decimal(str(data.get("local_tax", 0)))
        + Decimal(str(data.get("national_pension", 0)))
        + Decimal(str(data.get("health_insurance", 0)))
        + Decimal(str(data.get("employment_insurance", 0)))
        + Decimal(str(data.get("longterm_care", 0)))
        + Decimal(str(data.get("other_deduction", 0)))
    )
    net = gross - total_ded

    # 입력에 없거나 0인 경우만 자동 계산
    if not data.get("gross_pay"):
        data["gross_pay"] = gross
    if not data.get("total_deduction"):
        data["total_deduction"] = total_ded
    if not data.get("net_pay"):
        data["net_pay"] = net
    return data


def _batch_to_dict(batch: PayrollBatch, include_records: bool = False) -> dict:
    d: dict = {
        "id": batch.id,
        "period": batch.period,
        "pay_date": batch.pay_date.isoformat() if batch.pay_date else None,
        "title": batch.title,
        "status": batch.status,
        "voucher_id": batch.voucher_id,
        "total_gross": batch.total_gross,
        "total_deduction": batch.total_deduction,
        "total_net": batch.total_net,
        "memo": batch.memo,
        "created_at": batch.created_at.isoformat() if batch.created_at else None,
        "updated_at": batch.updated_at.isoformat() if batch.updated_at else None,
    }
    if include_records:
        d["records"] = [_record_to_dict(r) for r in (batch.records or [])]
    return d


def _record_to_dict(r: PayrollRecord) -> dict:
    return {
        "id": r.id,
        "batch_id": r.batch_id,
        "employee_code": r.employee_code,
        "employee_name": r.employee_name,
        "department": r.department,
        "position": r.position,
        "cost_type": r.cost_type,
        "base_pay": r.base_pay,
        "meal_allowance": r.meal_allowance,
        "overtime_pay": r.overtime_pay,
        "bonus": r.bonus,
        "other_allowance": r.other_allowance,
        "gross_pay": r.gross_pay,
        "income_tax": r.income_tax,
        "local_tax": r.local_tax,
        "national_pension": r.national_pension,
        "health_insurance": r.health_insurance,
        "employment_insurance": r.employment_insurance,
        "longterm_care": r.longterm_care,
        "other_deduction": r.other_deduction,
        "total_deduction": r.total_deduction,
        "net_pay": r.net_pay,
        "raw_json": r.raw_json,
        "created_at": r.created_at.isoformat() if r.created_at else None,
    }


def _payroll_voucher_number(pay_date: date) -> str:
    return f"{pay_date.strftime('%Y%m%d')}-P{_uuid.uuid4().hex[:8]}"


# ---------------------------------------------------------------------------
# Pydantic 스키마
# ---------------------------------------------------------------------------

class BatchCreate(BaseModel):
    period: str = Field(..., pattern=r"^\d{4}-\d{2}$", description="귀속연월 YYYY-MM")
    pay_date: date
    title: Optional[str] = None
    memo: Optional[str] = None


class BatchUpdate(BaseModel):
    title: Optional[str] = None
    pay_date: Optional[date] = None
    memo: Optional[str] = None
    status: Optional[str] = None


class RecordIn(BaseModel):
    employee_code: Optional[str] = None
    employee_name: str
    department: Optional[str] = None
    position: Optional[str] = None
    cost_type: str = "SGA"
    # 지급항목
    base_pay: Decimal = Decimal("0")
    meal_allowance: Decimal = Decimal("0")
    overtime_pay: Decimal = Decimal("0")
    bonus: Decimal = Decimal("0")
    other_allowance: Decimal = Decimal("0")
    gross_pay: Optional[Decimal] = None
    # 공제항목
    income_tax: Decimal = Decimal("0")
    local_tax: Decimal = Decimal("0")
    national_pension: Decimal = Decimal("0")
    health_insurance: Decimal = Decimal("0")
    employment_insurance: Decimal = Decimal("0")
    longterm_care: Decimal = Decimal("0")
    other_deduction: Decimal = Decimal("0")
    total_deduction: Optional[Decimal] = None
    net_pay: Optional[Decimal] = None
    raw_json: Optional[str] = None


class RecordsBulkIn(BaseModel):
    records: List[RecordIn]
    replace: bool = False


# ---------------------------------------------------------------------------
# Batch endpoints
# ---------------------------------------------------------------------------

@router.post("/batches", status_code=status.HTTP_201_CREATED)
async def create_batch(
    body: BatchCreate,
    db: AsyncSession = Depends(get_db),
    current_user=Depends(get_current_user),
) -> dict:
    """급여 배치(귀속월) 생성."""
    title = body.title or f"{body.period} 급여"
    batch = PayrollBatch(
        period=body.period,
        pay_date=body.pay_date,
        title=title,
        status="DRAFT",
        memo=body.memo,
    )
    db.add(batch)
    await db.flush()
    await db.refresh(batch)
    return _batch_to_dict(batch)


@router.get("/batches")
async def list_batches(
    year: Optional[int] = Query(None, description="연도 필터 (예: 2026)"),
    db: AsyncSession = Depends(get_db),
    current_user=Depends(get_current_user),
) -> dict:
    """급여 배치 목록 (records 제외, period DESC 정렬)."""
    stmt = select(PayrollBatch)
    if year:
        stmt = stmt.where(PayrollBatch.period.like(f"{year}-%"))
    stmt = stmt.order_by(PayrollBatch.period.desc())
    result = await db.execute(stmt)
    batches = result.scalars().all()
    return {"items": [_batch_to_dict(b) for b in batches], "total": len(batches)}


@router.get("/batches/{batch_id}")
async def get_batch(
    batch_id: int,
    db: AsyncSession = Depends(get_db),
    current_user=Depends(get_current_user),
) -> dict:
    """급여 배치 상세 + records 배열."""
    result = await db.execute(
        select(PayrollBatch)
        .options(selectinload(PayrollBatch.records))
        .where(PayrollBatch.id == batch_id)
    )
    batch = result.scalar_one_or_none()
    if not batch:
        raise HTTPException(status_code=404, detail="급여 배치를 찾을 수 없습니다.")
    return _batch_to_dict(batch, include_records=True)


@router.put("/batches/{batch_id}")
async def update_batch(
    batch_id: int,
    body: BatchUpdate,
    db: AsyncSession = Depends(get_db),
    current_user=Depends(get_current_user),
) -> dict:
    """급여 배치 수정."""
    result = await db.execute(
        select(PayrollBatch).where(PayrollBatch.id == batch_id)
    )
    batch = result.scalar_one_or_none()
    if not batch:
        raise HTTPException(status_code=404, detail="급여 배치를 찾을 수 없습니다.")

    if body.title is not None:
        batch.title = body.title
    if body.pay_date is not None:
        batch.pay_date = body.pay_date
    if body.memo is not None:
        batch.memo = body.memo
    if body.status is not None:
        allowed = {"DRAFT", "CONFIRMED", "POSTED"}
        if body.status not in allowed:
            raise HTTPException(
                status_code=400,
                detail=f"유효하지 않은 status. 허용값: {allowed}",
            )
        batch.status = body.status
    batch.updated_at = datetime.utcnow()
    return _batch_to_dict(batch)


@router.delete("/batches/{batch_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_batch(
    batch_id: int,
    db: AsyncSession = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """급여 배치 + records 삭제 (POSTED 상태면 400)."""
    result = await db.execute(
        select(PayrollBatch).where(PayrollBatch.id == batch_id)
    )
    batch = result.scalar_one_or_none()
    if not batch:
        raise HTTPException(status_code=404, detail="급여 배치를 찾을 수 없습니다.")
    if batch.status == "POSTED":
        raise HTTPException(
            status_code=400,
            detail="POSTED 상태의 배치는 삭제할 수 없습니다. 먼저 unpost를 실행하세요.",
        )
    await db.delete(batch)


# ---------------------------------------------------------------------------
# Records endpoints
# ---------------------------------------------------------------------------

@router.post("/batches/{batch_id}/records", status_code=status.HTTP_201_CREATED)
async def upsert_records(
    batch_id: int,
    body: RecordsBulkIn,
    db: AsyncSession = Depends(get_db),
    current_user=Depends(get_current_user),
) -> dict:
    """사원 급여 일괄 추가/교체.

    replace=true: 기존 records 삭제 후 교체.
    gross_pay / total_deduction / net_pay 미입력 시 자동 계산.
    """
    result = await db.execute(
        select(PayrollBatch).where(PayrollBatch.id == batch_id)
    )
    batch = result.scalar_one_or_none()
    if not batch:
        raise HTTPException(status_code=404, detail="급여 배치를 찾을 수 없습니다.")

    if body.replace:
        await db.execute(
            delete(PayrollRecord).where(PayrollRecord.batch_id == batch_id)
        )
        await db.flush()

    created = []
    for rec_in in body.records:
        data = rec_in.model_dump()
        data = _calc_record_amounts(data)
        rec = PayrollRecord(
            batch_id=batch_id,
            employee_code=data.get("employee_code"),
            employee_name=data["employee_name"],
            department=data.get("department"),
            position=data.get("position"),
            cost_type=data.get("cost_type", "SGA"),
            base_pay=Decimal(str(data.get("base_pay", 0))),
            meal_allowance=Decimal(str(data.get("meal_allowance", 0))),
            overtime_pay=Decimal(str(data.get("overtime_pay", 0))),
            bonus=Decimal(str(data.get("bonus", 0))),
            other_allowance=Decimal(str(data.get("other_allowance", 0))),
            gross_pay=Decimal(str(data["gross_pay"])),
            income_tax=Decimal(str(data.get("income_tax", 0))),
            local_tax=Decimal(str(data.get("local_tax", 0))),
            national_pension=Decimal(str(data.get("national_pension", 0))),
            health_insurance=Decimal(str(data.get("health_insurance", 0))),
            employment_insurance=Decimal(str(data.get("employment_insurance", 0))),
            longterm_care=Decimal(str(data.get("longterm_care", 0))),
            other_deduction=Decimal(str(data.get("other_deduction", 0))),
            total_deduction=Decimal(str(data["total_deduction"])),
            net_pay=Decimal(str(data["net_pay"])),
            raw_json=data.get("raw_json"),
        )
        db.add(rec)
        created.append(rec)

    await db.flush()
    await _recalc_batch_totals(db, batch)

    return {
        "batch_id": batch_id,
        "created": len(created),
        "total_gross": batch.total_gross,
        "total_deduction": batch.total_deduction,
        "total_net": batch.total_net,
    }


@router.put("/records/{record_id}")
async def update_record(
    record_id: int,
    body: RecordIn,
    db: AsyncSession = Depends(get_db),
    current_user=Depends(get_current_user),
) -> dict:
    """사원 급여 단건 수정 (금액 변경 시 합계 재계산)."""
    result = await db.execute(
        select(PayrollRecord).where(PayrollRecord.id == record_id)
    )
    rec = result.scalar_one_or_none()
    if not rec:
        raise HTTPException(status_code=404, detail="급여 레코드를 찾을 수 없습니다.")

    data = body.model_dump()
    data = _calc_record_amounts(data)

    rec.employee_code = data.get("employee_code", rec.employee_code)
    rec.employee_name = data.get("employee_name", rec.employee_name)
    rec.department = data.get("department", rec.department)
    rec.position = data.get("position", rec.position)
    rec.cost_type = data.get("cost_type", rec.cost_type)
    rec.base_pay = Decimal(str(data.get("base_pay", rec.base_pay)))
    rec.meal_allowance = Decimal(str(data.get("meal_allowance", rec.meal_allowance)))
    rec.overtime_pay = Decimal(str(data.get("overtime_pay", rec.overtime_pay)))
    rec.bonus = Decimal(str(data.get("bonus", rec.bonus)))
    rec.other_allowance = Decimal(str(data.get("other_allowance", rec.other_allowance)))
    rec.gross_pay = Decimal(str(data["gross_pay"]))
    rec.income_tax = Decimal(str(data.get("income_tax", rec.income_tax)))
    rec.local_tax = Decimal(str(data.get("local_tax", rec.local_tax)))
    rec.national_pension = Decimal(str(data.get("national_pension", rec.national_pension)))
    rec.health_insurance = Decimal(str(data.get("health_insurance", rec.health_insurance)))
    rec.employment_insurance = Decimal(str(data.get("employment_insurance", rec.employment_insurance)))
    rec.longterm_care = Decimal(str(data.get("longterm_care", rec.longterm_care)))
    rec.other_deduction = Decimal(str(data.get("other_deduction", rec.other_deduction)))
    rec.total_deduction = Decimal(str(data["total_deduction"]))
    rec.net_pay = Decimal(str(data["net_pay"]))
    if data.get("raw_json") is not None:
        rec.raw_json = data["raw_json"]

    await db.flush()

    # batch 합계 재계산
    batch_result = await db.execute(
        select(PayrollBatch).where(PayrollBatch.id == rec.batch_id)
    )
    batch = batch_result.scalar_one_or_none()
    if batch:
        await _recalc_batch_totals(db, batch)

    return _record_to_dict(rec)


@router.delete("/records/{record_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_record(
    record_id: int,
    db: AsyncSession = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """사원 급여 단건 삭제 + batch 합계 갱신."""
    result = await db.execute(
        select(PayrollRecord).where(PayrollRecord.id == record_id)
    )
    rec = result.scalar_one_or_none()
    if not rec:
        raise HTTPException(status_code=404, detail="급여 레코드를 찾을 수 없습니다.")

    batch_id = rec.batch_id
    await db.delete(rec)
    await db.flush()

    batch_result = await db.execute(
        select(PayrollBatch).where(PayrollBatch.id == batch_id)
    )
    batch = batch_result.scalar_one_or_none()
    if batch:
        await _recalc_batch_totals(db, batch)


# ---------------------------------------------------------------------------
# 분개 미리보기 / 전표 생성 / 전표 취소
# ---------------------------------------------------------------------------

def _build_journal_preview(batch: PayrollBatch, records: list) -> dict:
    """분개 미리보기 계산 — 실제 DB 저장 없음."""
    sga_records = [r for r in records if r.cost_type != "COGS"]
    cogs_records = [r for r in records if r.cost_type == "COGS"]

    sga_gross = sum(Decimal(str(r.gross_pay)) for r in sga_records)
    cogs_gross = sum(Decimal(str(r.gross_pay)) for r in cogs_records)
    total_withholding = sum(Decimal(str(r.total_deduction)) for r in records)
    total_net = sum(Decimal(str(r.net_pay)) for r in records)
    headcount = len(records)

    debit_lines = []
    if sga_gross > 0:
        debit_lines.append({
            "account_code": PAYROLL_ACCOUNT_MAP["salary_sga"],
            "account_name": PAYROLL_ACCOUNT_NAMES[PAYROLL_ACCOUNT_MAP["salary_sga"]],
            "amount": sga_gross,
            "memo": f"판관 급여 {len(sga_records)}명",
        })
    if cogs_gross > 0:
        debit_lines.append({
            "account_code": PAYROLL_ACCOUNT_MAP["salary_cogs"],
            "account_name": PAYROLL_ACCOUNT_NAMES[PAYROLL_ACCOUNT_MAP["salary_cogs"]],
            "amount": cogs_gross,
            "memo": f"제조 노무비 {len(cogs_records)}명",
        })

    credit_lines = []
    if total_withholding > 0:
        credit_lines.append({
            "account_code": PAYROLL_ACCOUNT_MAP["withholding"],
            "account_name": PAYROLL_ACCOUNT_NAMES[PAYROLL_ACCOUNT_MAP["withholding"]],
            "amount": total_withholding,
            "memo": "소득세·4대보험 공제",
        })
    if total_net > 0:
        credit_lines.append({
            "account_code": PAYROLL_ACCOUNT_MAP["net_pay_bank"],
            "account_name": PAYROLL_ACCOUNT_NAMES[PAYROLL_ACCOUNT_MAP["net_pay_bank"]],
            "amount": total_net,
            "memo": "차인지급액",
        })

    total_debit = sga_gross + cogs_gross
    total_credit = total_withholding + total_net
    # 부동소수점 오차 허용 범위(0.01원 이내) 내 균형 확인
    balanced = abs(total_debit - total_credit) < Decimal("0.02")

    return {
        "period": batch.period,
        "balanced": balanced,
        "debit_lines": debit_lines,
        "credit_lines": credit_lines,
        "total_debit": total_debit,
        "total_credit": total_credit,
        "summary": {
            "sga_salary": sga_gross,
            "cogs_salary": cogs_gross,
            "withholding": total_withholding,
            "net_pay": total_net,
            "headcount": headcount,
        },
    }


@router.get("/batches/{batch_id}/journal-preview")
async def journal_preview(
    batch_id: int,
    db: AsyncSession = Depends(get_db),
    current_user=Depends(get_current_user),
) -> dict:
    """분개 미리보기 (저장하지 않음)."""
    result = await db.execute(
        select(PayrollBatch)
        .options(selectinload(PayrollBatch.records))
        .where(PayrollBatch.id == batch_id)
    )
    batch = result.scalar_one_or_none()
    if not batch:
        raise HTTPException(status_code=404, detail="급여 배치를 찾을 수 없습니다.")
    if not batch.records:
        raise HTTPException(status_code=400, detail="급여 records가 없습니다. 먼저 records를 등록하세요.")

    return _build_journal_preview(batch, batch.records)


@router.post("/batches/{batch_id}/post")
async def post_batch(
    batch_id: int,
    user_id: int = Query(1, description="전표 작성자 user_id"),
    db: AsyncSession = Depends(get_db),
    current_user=Depends(get_current_user),
) -> dict:
    """분개 전표 생성 (POSTED 처리).

    - journal-preview와 동일한 로직으로 Voucher + VoucherLine 생성
    - Voucher: status=CONFIRMED, source="payroll", transaction_type=GENERAL
    - batch.status = "POSTED", batch.voucher_id 연결
    - 이미 POSTED면 400
    """
    result = await db.execute(
        select(PayrollBatch)
        .options(selectinload(PayrollBatch.records))
        .where(PayrollBatch.id == batch_id)
    )
    batch = result.scalar_one_or_none()
    if not batch:
        raise HTTPException(status_code=404, detail="급여 배치를 찾을 수 없습니다.")
    if batch.status == "POSTED":
        raise HTTPException(status_code=400, detail="이미 POSTED 상태입니다. 재분개 전 unpost 먼저 실행하세요.")
    if not batch.records:
        raise HTTPException(status_code=400, detail="급여 records가 없습니다. 먼저 records를 등록하세요.")

    preview = _build_journal_preview(batch, batch.records)
    if not preview["balanced"]:
        raise HTTPException(
            status_code=400,
            detail=f"차변({preview['total_debit']}) ≠ 대변({preview['total_credit']}) — 분개 불균형. records를 확인하세요.",
        )

    # department_id 결정: user 의 department 혹은 1 폴백
    dept_id: int = 1
    if hasattr(current_user, "department_id") and current_user.department_id:
        dept_id = current_user.department_id
    elif hasattr(current_user, "department") and current_user.department:
        dept_id = current_user.department.id

    account_cache: Dict[str, int] = {}

    total_debit = preview["total_debit"]
    total_credit = preview["total_credit"]

    voucher = Voucher(
        voucher_number=_payroll_voucher_number(batch.pay_date),
        voucher_date=batch.pay_date,
        transaction_date=batch.pay_date,
        description=f"{batch.period} 급여 지급",
        transaction_type=TransactionType.GENERAL,
        external_ref=f"payroll:{batch_id}",
        source="payroll",
        department_id=dept_id,
        created_by=user_id,
        total_debit=total_debit,
        total_credit=total_credit,
        status=VoucherStatus.CONFIRMED,
        confirmed_at=datetime.utcnow(),
        confirmed_by=user_id,
    )
    db.add(voucher)
    await db.flush()  # voucher.id 확보

    line_num = 1
    # 차변 라인
    for dl in preview["debit_lines"]:
        acc_id = await _resolve_account(db, dl["account_code"], account_cache)
        db.add(VoucherLine(
            voucher_id=voucher.id,
            line_number=line_num,
            account_id=acc_id,
            debit_amount=Decimal(str(dl["amount"])),
            credit_amount=Decimal("0"),
            vat_amount=Decimal("0"),
            supply_amount=Decimal(str(dl["amount"])),
            description=dl.get("memo", ""),
        ))
        line_num += 1

    # 대변 라인
    for cl in preview["credit_lines"]:
        acc_id = await _resolve_account(db, cl["account_code"], account_cache)
        db.add(VoucherLine(
            voucher_id=voucher.id,
            line_number=line_num,
            account_id=acc_id,
            debit_amount=Decimal("0"),
            credit_amount=Decimal(str(cl["amount"])),
            vat_amount=Decimal("0"),
            supply_amount=Decimal(str(cl["amount"])),
            description=cl.get("memo", ""),
        ))
        line_num += 1

    # batch 상태 갱신
    batch.status = "POSTED"
    batch.voucher_id = voucher.id
    batch.updated_at = datetime.utcnow()

    await db.flush()

    return {
        "batch_id": batch_id,
        "voucher_id": voucher.id,
        "voucher_number": voucher.voucher_number,
        "status": "POSTED",
        "total_debit": total_debit,
        "total_credit": total_credit,
        "balanced": preview["balanced"],
        "summary": preview["summary"],
    }


@router.post("/batches/{batch_id}/unpost")
async def unpost_batch(
    batch_id: int,
    db: AsyncSession = Depends(get_db),
    current_user=Depends(get_current_user),
) -> dict:
    """분개 전표 취소 (POSTED → DRAFT).

    - 연결된 Voucher + VoucherLine 삭제
    - batch.status = "DRAFT", voucher_id = None
    """
    result = await db.execute(
        select(PayrollBatch).where(PayrollBatch.id == batch_id)
    )
    batch = result.scalar_one_or_none()
    if not batch:
        raise HTTPException(status_code=404, detail="급여 배치를 찾을 수 없습니다.")
    if batch.status != "POSTED":
        raise HTTPException(status_code=400, detail="POSTED 상태가 아닙니다. unpost 불필요.")

    if batch.voucher_id:
        # VoucherLine 삭제 후 Voucher 삭제
        voucher_result = await db.execute(
            select(Voucher).where(Voucher.id == batch.voucher_id)
        )
        voucher = voucher_result.scalar_one_or_none()
        if voucher:
            await db.execute(
                delete(VoucherLine).where(VoucherLine.voucher_id == voucher.id)
            )
            await db.delete(voucher)
            await db.flush()

    batch.status = "DRAFT"
    batch.voucher_id = None
    batch.updated_at = datetime.utcnow()

    return {"batch_id": batch_id, "status": "DRAFT", "message": "분개 전표가 취소되었습니다."}
