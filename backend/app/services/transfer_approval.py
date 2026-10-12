"""
이체 승인 서비스 — 매입채무 당겨오기(SCM)/엑셀 임포트, 旬별 이체리스트, 대표 승인, 지급완료(+SCM 통보).
"""
from __future__ import annotations

import logging
import os
from datetime import date, datetime
from typing import Any, Dict, List, Optional

from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.payable_transfer import PayableItem, TransferApproval

logger = logging.getLogger(__name__)

SCM_API_BASE = os.getenv("SCM_API_BASE", "https://myfirstproject-api-557811875995.asia-northeast3.run.app")


def _num(v: Any) -> float:
    try:
        return float(v or 0)
    except (ValueError, TypeError):
        return 0.0


def xun_of_day(day: int) -> int:
    if day <= 10:
        return 10
    if day <= 20:
        return 20
    return 30


def _xun_from_date(d: Optional[str]) -> Optional[int]:
    if not d or len(d) < 10:
        return None
    try:
        return xun_of_day(int(d[8:10]))
    except ValueError:
        return None


def _month_from_date(d: Optional[str]) -> Optional[int]:
    if not d or len(d) < 7:
        return None
    try:
        return int(d[5:7])
    except ValueError:
        return None


def make_dedup_key(vendor: str, debt_date: Optional[str], amount: float,
                   account: Optional[str]) -> str:
    return f"{(vendor or '').strip()}|{debt_date or ''}|{int(round(_num(amount)))}|{(account or '').strip()}"


def _remaining(it: PayableItem) -> float:
    return _num(it.amount) - _num(it.paid_amount)


def _serialize(it: PayableItem) -> Dict[str, Any]:
    return {
        "id": it.id, "source": it.source, "vendor": it.vendor,
        "debt_date": it.debt_date, "debt_month": it.debt_month,
        "account_code": it.account_code, "account_name": it.account_name,
        "bank_name": it.bank_name,
        "amount": _num(it.amount), "paid_amount": _num(it.paid_amount),
        "remaining": _remaining(it),
        "due_date": it.due_date, "xun": it.xun, "manager": it.manager,
        "status": it.status, "memo": it.memo,
    }


async def _upsert(db: AsyncSession, *, dedup_key: str, source: str, vendor: str,
                  debt_date: Optional[str], amount: float, due_date: Optional[str],
                  scm_record_id: Optional[int] = None, account_code: Optional[str] = None,
                  account_name: Optional[str] = None, bank_name: Optional[str] = None,
                  manager: Optional[str] = None, paid_amount: Optional[float] = None) -> str:
    """dedup_key 기준 upsert. 기존건이면 비는 보완필드(계좌/계정/담당자)만 채움. 반환: 'new'|'update'."""
    row = (await db.execute(
        select(PayableItem).where(PayableItem.dedup_key == dedup_key)
    )).scalar_one_or_none()
    if row is None:
        row = PayableItem(
            dedup_key=dedup_key, source=source, vendor=vendor, debt_date=debt_date,
            debt_month=_month_from_date(debt_date), amount=amount, due_date=due_date,
            xun=_xun_from_date(due_date), scm_record_id=scm_record_id,
            account_code=account_code, account_name=account_name, bank_name=bank_name,
            manager=manager, paid_amount=paid_amount or 0, status="pending",
            synced_at=datetime.utcnow(),
        )
        db.add(row)
        return "new"
    # 보완 업서트 — 이미 있으면 금액/기준일은 유지, 빈 보완필드만 채움
    if account_code and not row.account_code:
        row.account_code = account_code
    if account_name and not row.account_name:
        row.account_name = account_name
    if bank_name and not row.bank_name:
        row.bank_name = bank_name
    if manager and not row.manager:
        row.manager = manager
    if scm_record_id and not row.scm_record_id:
        row.scm_record_id = scm_record_id
    if paid_amount is not None and row.status != "paid":
        row.paid_amount = paid_amount
    row.synced_at = datetime.utcnow()
    return "update"


async def sync_from_scm(db: AsyncSession) -> Dict[str, Any]:
    """SCM(myfirstproject) 매입채무 당겨오기 — ap-aging 미지급 open_items 기준 upsert."""
    try:
        import httpx
    except Exception:
        return {"ok": False, "error": "httpx 미설치", "new": 0, "updated": 0}

    asof = date.today().isoformat()
    new_ct = upd_ct = 0
    errors: List[str] = []
    async with httpx.AsyncClient(timeout=40) as c:
        try:
            r = await c.get(f"{SCM_API_BASE}/api/purchase/ap-aging", params={"asof": asof})
            r.raise_for_status()
            aging = r.json()
        except Exception as e:
            logger.exception("SCM ap-aging 조회 실패")
            return {"ok": False, "error": f"ap-aging: {str(e)[:200]}", "new": 0, "updated": 0}

        # 라인상세(품목/계정명 보완) — best effort
        records_by_vendor: Dict[str, List[Dict[str, Any]]] = {}
        try:
            rr = await c.get(f"{SCM_API_BASE}/api/purchase/records", params={"start": f"{date.today().year}-01-01", "end": asof, "limit": 500})
            if rr.status_code == 200:
                for rec in (rr.json().get("rows") or rr.json().get("records") or []):
                    records_by_vendor.setdefault((rec.get("vendor") or "").strip(), []).append(rec)
        except Exception as e:
            errors.append(f"records 보완 실패(무시): {str(e)[:80]}")

    for v in (aging.get("vendors") or []):
        vendor = (v.get("vendor") or "").strip()
        if not vendor:
            continue
        open_items = v.get("open_items") or []
        if not open_items and _num(v.get("balance")) > 0:
            # open_items 없으면 vendor 잔액 1건으로
            open_items = [{"pdate": None, "amount": _num(v.get("balance")), "due": v.get("earliest_due")}]
        recs = records_by_vendor.get(vendor, [])
        for oi in open_items:
            amount = _num(oi.get("amount"))
            if amount <= 0:
                continue
            debt_date = oi.get("pdate")
            due = oi.get("due") or v.get("earliest_due")
            # 같은 pdate 레코드에서 품목명 보완
            acc_name = None
            if debt_date:
                for rec in recs:
                    if rec.get("pdate") == debt_date:
                        acc_name = rec.get("item_name") or rec.get("mclass")
                        break
            key = make_dedup_key(vendor, debt_date, amount, acc_name)
            res = await _upsert(db, dedup_key=key, source="scm", vendor=vendor,
                                debt_date=debt_date, amount=amount, due_date=due,
                                account_name=acc_name)
            new_ct += res == "new"
            upd_ct += res == "update"
    await db.commit()
    return {"ok": True, "new": new_ct, "updated": upd_ct, "asof": asof, "warnings": errors}


async def import_rows(db: AsyncSession, rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    """엑셀 파싱결과 upsert(source='excel'). 이미 SCM건이면 계좌/계정만 보완(중복생성 금지)."""
    new_ct = upd_ct = skip = 0
    for row in rows or []:
        vendor = (row.get("vendor") or "").strip()
        amount = _num(row.get("amount"))
        if not vendor or amount <= 0:
            skip += 1
            continue
        debt_date = row.get("debt_date")
        account = row.get("account_code") or row.get("account_name")
        key = make_dedup_key(vendor, debt_date, amount, account)
        res = await _upsert(
            db, dedup_key=key, source="excel", vendor=vendor, debt_date=debt_date,
            amount=amount, due_date=row.get("due_date"),
            account_code=row.get("account_code"), account_name=row.get("account_name"),
            bank_name=row.get("bank_name"), manager=row.get("manager"),
        )
        new_ct += res == "new"
        upd_ct += res == "update"
    await db.commit()
    return {"ok": True, "new": new_ct, "updated": upd_ct, "skipped": skip}


async def _approval_map(db: AsyncSession, year: int, month: int) -> Dict[int, str]:
    rows = (await db.execute(
        select(TransferApproval).where(TransferApproval.year == year, TransferApproval.month == month)
    )).scalars().all()
    return {r.xun: r.status for r in rows}


async def list_transfer_list(db: AsyncSession, year: int, month: int,
                             xun: Optional[int] = None) -> Dict[str, Any]:
    """미지급(잔여>0) 매입채무를 旬별로 묶은 이체리스트 + 합계 + 旬 승인상태."""
    like = f"{year}-{month:02d}-%"
    rows = (await db.execute(
        select(PayableItem).where(
            PayableItem.status != "paid",
            PayableItem.due_date.like(like),
        ).order_by(PayableItem.due_date, PayableItem.vendor)
    )).scalars().all()
    rows = [r for r in rows if _remaining(r) > 0 and (xun is None or r.xun == xun)]

    approvals = await _approval_map(db, year, month)
    groups: Dict[int, Dict[str, Any]] = {}
    for it in rows:
        gx = it.xun or 30
        g = groups.setdefault(gx, {"xun": gx, "items": [], "subtotal": 0.0, "count": 0,
                                   "approval": approvals.get(gx, "pending")})
        g["items"].append(_serialize(it))
        g["subtotal"] += _remaining(it)
        g["count"] += 1
    group_list = [groups[k] for k in sorted(groups.keys())]
    total = sum(g["subtotal"] for g in group_list)
    return {"year": year, "month": month, "groups": group_list,
            "total": total, "count": sum(g["count"] for g in group_list),
            "approvals": approvals}


async def approve(db: AsyncSession, year: int, month: int, xun: int,
                  approved_by: Optional[str]) -> Dict[str, Any]:
    row = (await db.execute(
        select(TransferApproval).where(
            TransferApproval.year == year, TransferApproval.month == month, TransferApproval.xun == xun)
    )).scalar_one_or_none()
    if row is None:
        row = TransferApproval(year=year, month=month, xun=xun)
        db.add(row)
    row.status = "approved"
    row.approved_by = approved_by
    row.approved_at = datetime.utcnow()

    like = f"{year}-{month:02d}-%"
    items = (await db.execute(
        select(PayableItem).where(PayableItem.due_date.like(like), PayableItem.xun == xun)
    )).scalars().all()
    n = 0
    for it in items:
        if it.status == "pending":
            it.status = "approved"
            n += 1
    await db.commit()
    return {"ok": True, "year": year, "month": month, "xun": xun, "approved_items": n}


async def mark_paid(db: AsyncSession, item_id: int,
                    paid_amount: Optional[float] = None) -> Dict[str, Any]:
    it = (await db.execute(select(PayableItem).where(PayableItem.id == item_id))).scalar_one_or_none()
    if it is None:
        return {"ok": False, "error": "항목 없음"}
    it.paid_amount = _num(paid_amount) if paid_amount is not None else _num(it.amount)
    it.status = "paid"
    await db.commit()

    # SCM 통보 — 키 있을 때만
    scm_key = os.getenv("SCM_API_KEY")
    scm_notified = False
    note = None
    if scm_key:
        try:
            import httpx
            async with httpx.AsyncClient(timeout=30) as c:
                resp = await c.post(
                    f"{SCM_API_BASE}/api/purchase/payments",
                    headers={"Authorization": f"Bearer {scm_key}", "Content-Type": "application/json"},
                    json={"vendor": it.vendor, "pay_date": date.today().isoformat(),
                          "amount": _num(it.paid_amount), "method": "이체",
                          "memo": f"회계ERP 이체승인 #{it.id}"},
                )
                scm_notified = resp.status_code < 300
                if not scm_notified:
                    note = f"SCM 통보 실패 {resp.status_code}"
        except Exception as e:
            note = f"SCM 통보 예외: {str(e)[:120]}"
    else:
        note = "SCM 통보 대기(SCM_API_KEY 미설정) — 로컬 지급완료만 처리됨"
    return {"ok": True, "id": it.id, "paid_amount": _num(it.paid_amount),
            "status": it.status, "scm_notified": scm_notified, "note": note}
