"""
이체 승인 서비스 — 매입채무 당겨오기(SCM)/엑셀 임포트, 旬별 이체리스트, 대표 승인, 지급완료(+SCM 통보).
"""
from __future__ import annotations

import logging
import os
from datetime import date, datetime
from typing import Any, Dict, List, Optional

from sqlalchemy import select, func, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.payable_transfer import (
    PayableItem, TransferApproval, TransferBatch, TransferBatchItem,
)

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
                   account: Optional[str] = None) -> str:
    # 안정키 — 거래처|채무기준일|금액. 계정과목(account)은 동기화마다 변동(/records 매칭)해
    # 과거엔 키에 포함돼 재동기화 때 중복 생성됐음 → 식별자에서 제외(보완필드로만 사용).
    return f"{(vendor or '').strip()}|{debt_date or ''}|{int(round(_num(amount)))}"


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


async def dedup_cleanup(db: AsyncSession) -> Dict[str, Any]:
    """기존 중복 매입채무 정리 — 안정키(거래처|기준일|금액) 기준 병합.
    배치에 담긴 건(referenced) 또는 최소 id를 keeper로 남기고 나머지 미참조건 삭제. 멱등."""
    rows = (await db.execute(select(PayableItem))).scalars().all()
    ref = set((await db.execute(
        select(TransferBatchItem.payable_id).where(TransferBatchItem.payable_id.isnot(None))
    )).scalars().all())
    groups: Dict[str, List[PayableItem]] = {}
    for it in rows:
        groups.setdefault(make_dedup_key(it.vendor, it.debt_date, _num(it.amount)), []).append(it)
    deleted = fixed = 0
    for k, items in groups.items():
        items.sort(key=lambda x: (x.id not in ref, x.id))  # 참조건 우선, 그다음 최소 id
        keeper = items[0]
        if keeper.dedup_key != k:
            keeper.dedup_key = k
            fixed += 1
        for dup in items[1:]:
            if dup.id in ref:
                continue  # 다른 배치가 참조 중 → 삭제 보류(FK 보호)
            await db.delete(dup)
            deleted += 1
    await db.commit()
    return {"ok": True, "groups": len(groups), "deleted": deleted, "fixed_keys": fixed}


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


# ==================== 이체 보고서 워크플로우 (회계팀 작성 → 대표 제출 → 대표 결재) ====================

def _batch_dict(b: TransferBatch, item_count: int = 0, total: float = 0.0) -> Dict[str, Any]:
    return {
        "id": b.id, "year": b.year, "month": b.month, "xun": b.xun, "title": b.title,
        "status": b.status, "note": b.note, "created_by": b.created_by,
        "submitted_at": b.submitted_at.isoformat() if b.submitted_at else None,
        "reviewed_at": b.reviewed_at.isoformat() if b.reviewed_at else None,
        "created_at": b.created_at.isoformat() if b.created_at else None,
        "item_count": item_count, "total_amount": total,
    }


def _item_dict(it: TransferBatchItem) -> Dict[str, Any]:
    return {
        "id": it.id, "batch_id": it.batch_id, "payable_id": it.payable_id,
        "vendor": it.vendor, "amount": _num(it.amount),
        "account_name": it.account_name, "bank_name": it.bank_name, "due_date": it.due_date,
        "disposition": it.disposition, "priority": it.priority,
        "dept_request": it.dept_request, "memo": it.memo,
        "ceo_action": it.ceo_action, "ceo_comment": it.ceo_comment,
        "ceo_acted_at": it.ceo_acted_at.isoformat() if it.ceo_acted_at else None,
        "paid": bool(getattr(it, "paid", False)),
        "paid_at": getattr(it, "paid_at", None).isoformat() if getattr(it, "paid_at", None) else None,
        "paid_by": getattr(it, "paid_by", None),
    }


_paid_cols_ensured = False


async def _ensure_paid_columns(db: AsyncSession) -> None:
    """기존 transfer_batch_item 테이블에 paid 컬럼 보장(create_all은 ALTER 안 함). Postgres IF NOT EXISTS 멱등."""
    global _paid_cols_ensured
    if _paid_cols_ensured:
        return
    for s in (
        "ALTER TABLE transfer_batch_item ADD COLUMN IF NOT EXISTS paid BOOLEAN DEFAULT FALSE",
        "ALTER TABLE transfer_batch_item ADD COLUMN IF NOT EXISTS paid_at TIMESTAMP",
        "ALTER TABLE transfer_batch_item ADD COLUMN IF NOT EXISTS paid_by VARCHAR(120)",
    ):
        try:
            await db.execute(text(s))
        except Exception:
            logger.exception("paid 컬럼 보장 실패(무시): %s", s)
    try:
        await db.commit()
    except Exception:
        await db.rollback()
    _paid_cols_ensured = True


async def create_batch(db: AsyncSession, year: int, month: int, xun: int,
                       title: Optional[str] = None, created_by: Optional[str] = None) -> Dict[str, Any]:
    """draft 배치 생성 — 같은 (year,month,xun) draft 있으면 재사용."""
    existing = (await db.execute(
        select(TransferBatch).where(
            TransferBatch.year == year, TransferBatch.month == month,
            TransferBatch.xun == xun, TransferBatch.status == "draft",
        )
    )).scalar_one_or_none()
    if existing:
        return {"ok": True, "batch_id": existing.id, "reused": True}
    b = TransferBatch(year=year, month=month, xun=xun,
                      title=title or f"{year}-{month:02d} {xun}일 이체리스트",
                      status="draft", created_by=created_by)
    db.add(b)
    await db.commit()
    await db.refresh(b)
    return {"ok": True, "batch_id": b.id, "reused": False}


async def _batch_totals(db: AsyncSession, batch_id: int) -> tuple:
    items = (await db.execute(
        select(TransferBatchItem).where(TransferBatchItem.batch_id == batch_id)
    )).scalars().all()
    return len(items), sum(_num(i.amount) for i in items)


async def list_batches(db: AsyncSession, year: Optional[int] = None,
                       month: Optional[int] = None, status: Optional[str] = None) -> Dict[str, Any]:
    q = select(TransferBatch)
    if year is not None:
        q = q.where(TransferBatch.year == year)
    if month is not None:
        q = q.where(TransferBatch.month == month)
    if status:
        q = q.where(TransferBatch.status == status)
    batches = (await db.execute(q.order_by(TransferBatch.year.desc(), TransferBatch.month.desc(), TransferBatch.xun))).scalars().all()
    out = []
    for b in batches:
        cnt, tot = await _batch_totals(db, b.id)
        out.append(_batch_dict(b, cnt, tot))
    return {"items": out}


async def get_batch(db: AsyncSession, batch_id: int) -> Dict[str, Any]:
    b = (await db.execute(select(TransferBatch).where(TransferBatch.id == batch_id))).scalar_one_or_none()
    if b is None:
        return {"ok": False, "error": "배치 없음"}
    items = (await db.execute(
        select(TransferBatchItem).where(TransferBatchItem.batch_id == batch_id)
        .order_by(TransferBatchItem.priority, TransferBatchItem.id)
    )).scalars().all()
    cnt, tot = len(items), sum(_num(i.amount) for i in items)
    return {"batch": _batch_dict(b, cnt, tot), "items": [_item_dict(i) for i in items]}


async def add_to_batch(db: AsyncSession, batch_id: int,
                       payable_ids: Optional[List[int]] = None,
                       items: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
    """풀(PayableItem)에서 복사 추가 + 수동항목 추가. payable_id 중복은 skip."""
    b = (await db.execute(select(TransferBatch).where(TransferBatch.id == batch_id))).scalar_one_or_none()
    if b is None:
        return {"ok": False, "error": "배치 없음"}
    existing_pids = set((await db.execute(
        select(TransferBatchItem.payable_id).where(
            TransferBatchItem.batch_id == batch_id, TransferBatchItem.payable_id.isnot(None))
    )).scalars().all())
    added = 0
    for pid in (payable_ids or []):
        if pid in existing_pids:
            continue
        p = (await db.execute(select(PayableItem).where(PayableItem.id == pid))).scalar_one_or_none()
        if p is None:
            continue
        db.add(TransferBatchItem(
            batch_id=batch_id, payable_id=p.id, vendor=p.vendor,
            amount=_remaining(p) if _remaining(p) > 0 else _num(p.amount),
            account_name=p.account_name, bank_name=p.bank_name, due_date=p.due_date,
            disposition="pay", priority=2,
        ))
        existing_pids.add(pid)
        added += 1
    for m in (items or []):
        vendor = (m.get("vendor") or "").strip()
        if not vendor:
            continue
        db.add(TransferBatchItem(
            batch_id=batch_id, payable_id=None, vendor=vendor, amount=_num(m.get("amount")),
            account_name=m.get("account_name"), bank_name=m.get("bank_name"), due_date=m.get("due_date"),
            disposition=m.get("disposition") or "pay", priority=int(m.get("priority") or 2),
            dept_request=m.get("dept_request"), memo=m.get("memo"),
        ))
        added += 1
    await db.commit()
    return {"ok": True, "added": added}


async def update_batch_item(db: AsyncSession, item_id: int, patch: Dict[str, Any]) -> Dict[str, Any]:
    it = (await db.execute(select(TransferBatchItem).where(TransferBatchItem.id == item_id))).scalar_one_or_none()
    if it is None:
        return {"ok": False, "error": "항목 없음"}
    for f in ("disposition", "dept_request", "memo", "account_name", "bank_name", "due_date"):
        if f in patch and patch[f] is not None:
            setattr(it, f, patch[f])
    if patch.get("priority") is not None:
        it.priority = int(patch["priority"])
    if patch.get("amount") is not None:
        it.amount = _num(patch["amount"])
    await db.commit()
    return {"ok": True}


async def delete_batch_item(db: AsyncSession, item_id: int) -> Dict[str, Any]:
    it = (await db.execute(select(TransferBatchItem).where(TransferBatchItem.id == item_id))).scalar_one_or_none()
    if it is None:
        return {"ok": False, "error": "항목 없음"}
    await db.delete(it)
    await db.commit()
    return {"ok": True}


async def submit_batch(db: AsyncSession, batch_id: int, by: Optional[str] = None) -> Dict[str, Any]:
    b = (await db.execute(select(TransferBatch).where(TransferBatch.id == batch_id))).scalar_one_or_none()
    if b is None:
        return {"ok": False, "error": "배치 없음"}
    b.status = "submitted"
    b.submitted_at = datetime.utcnow()
    await db.commit()
    return {"ok": True, "status": b.status}


async def item_action(db: AsyncSession, item_id: int, action: str,
                      comment: Optional[str] = None, by: Optional[str] = None) -> Dict[str, Any]:
    if action not in ("approved", "rejected", "query"):
        return {"ok": False, "error": f"unknown action: {action}"}
    it = (await db.execute(select(TransferBatchItem).where(TransferBatchItem.id == item_id))).scalar_one_or_none()
    if it is None:
        return {"ok": False, "error": "항목 없음"}
    it.ceo_action = action
    it.ceo_comment = comment
    it.ceo_acted_at = datetime.utcnow()
    await db.commit()
    return {"ok": True, "id": it.id, "ceo_action": action}


async def review_batch(db: AsyncSession, batch_id: int, by: Optional[str] = None) -> Dict[str, Any]:
    b = (await db.execute(select(TransferBatch).where(TransferBatch.id == batch_id))).scalar_one_or_none()
    if b is None:
        return {"ok": False, "error": "배치 없음"}
    b.status = "reviewed"
    b.reviewed_at = datetime.utcnow()
    await db.commit()
    return {"ok": True, "status": b.status}


async def batch_report(db: AsyncSession, batch_id: int) -> Dict[str, Any]:
    """대표용 커스텀 보고서 — 이체할곳/미룸/예정 그룹 + 결재상태 집계."""
    b = (await db.execute(select(TransferBatch).where(TransferBatch.id == batch_id))).scalar_one_or_none()
    if b is None:
        return {"ok": False, "error": "배치 없음"}
    items = (await db.execute(
        select(TransferBatchItem).where(TransferBatchItem.batch_id == batch_id)
        .order_by(TransferBatchItem.priority, TransferBatchItem.id)
    )).scalars().all()
    groups = {"pay": [], "defer": [], "scheduled": []}
    totals = {"pay": 0.0, "defer": 0.0, "scheduled": 0.0,
              "approved": 0, "rejected": 0, "query": 0, "pending": 0, "paid": 0}
    for it in items:
        d = _item_dict(it)
        grp = it.disposition if it.disposition in groups else "pay"
        groups[grp].append(d)
        totals[grp] += _num(it.amount)
        totals[it.ceo_action] = totals.get(it.ceo_action, 0) + 1
        if bool(getattr(it, "paid", False)):
            totals["paid"] += 1
    cnt, tot = len(items), sum(_num(i.amount) for i in items)
    return {"batch": _batch_dict(b, cnt, tot), "groups": groups, "totals": totals, "count": cnt}


async def mark_batch_item_paid(db: AsyncSession, item_id: int, paid: bool = True,
                               by: Optional[str] = None) -> Dict[str, Any]:
    """대표 승인된 항목을 회계팀이 은행이체 후 이체완료 처리. 승인 안 된 항목은 거부."""
    await _ensure_paid_columns(db)
    it = (await db.execute(select(TransferBatchItem).where(TransferBatchItem.id == item_id))).scalar_one_or_none()
    if it is None:
        return {"ok": False, "error": "항목 없음"}
    if paid and it.ceo_action != "approved":
        return {"ok": False, "error": "대표 승인된 항목만 이체완료 처리할 수 있습니다", "code": 400}
    it.paid = bool(paid)
    it.paid_at = datetime.utcnow() if paid else None
    it.paid_by = by if paid else None
    await db.commit()
    return {"ok": True, "id": it.id, "paid": bool(it.paid)}


async def pay_all(db: AsyncSession, batch_id: int, by: Optional[str] = None) -> Dict[str, Any]:
    """배치 내 승인완료·미이체 항목 일괄 이체완료."""
    await _ensure_paid_columns(db)
    items = (await db.execute(
        select(TransferBatchItem).where(TransferBatchItem.batch_id == batch_id,
                                        TransferBatchItem.ceo_action == "approved")
    )).scalars().all()
    n = 0
    for it in items:
        if not bool(getattr(it, "paid", False)):
            it.paid = True
            it.paid_at = datetime.utcnow()
            it.paid_by = by
            n += 1
    await db.commit()
    return {"ok": True, "count": n}


async def history(db: AsyncSession, year: Optional[int] = None, month: Optional[int] = None,
                  status: Optional[str] = None) -> Dict[str, Any]:
    """지난 내역 — 제출/검토완료 배치 목록 + 각 배치 결재·이체완료 집계."""
    await _ensure_paid_columns(db)
    q = select(TransferBatch).where(TransferBatch.status != "draft")
    if year is not None:
        q = q.where(TransferBatch.year == year)
    if month is not None:
        q = q.where(TransferBatch.month == month)
    if status:
        q = q.where(TransferBatch.status == status)
    batches = (await db.execute(
        q.order_by(TransferBatch.year.desc(), TransferBatch.month.desc(), TransferBatch.xun)
    )).scalars().all()
    out = []
    for b in batches:
        items = (await db.execute(
            select(TransferBatchItem).where(TransferBatchItem.batch_id == b.id)
        )).scalars().all()
        d = _batch_dict(b, len(items), sum(_num(i.amount) for i in items))
        d["approved_count"] = sum(1 for i in items if i.ceo_action == "approved")
        d["rejected_count"] = sum(1 for i in items if i.ceo_action == "rejected")
        d["query_count"] = sum(1 for i in items if i.ceo_action == "query")
        d["paid_count"] = sum(1 for i in items if bool(getattr(i, "paid", False)))
        out.append(d)
    return {"items": out}


async def completed(db: AsyncSession, year: Optional[int] = None,
                    month: Optional[int] = None) -> Dict[str, Any]:
    """이체완료된 항목 평면 리스트."""
    await _ensure_paid_columns(db)
    bq = select(TransferBatch)
    if year is not None:
        bq = bq.where(TransferBatch.year == year)
    if month is not None:
        bq = bq.where(TransferBatch.month == month)
    batches = {b.id: b for b in (await db.execute(bq)).scalars().all()}
    if not batches:
        return {"items": []}
    items = (await db.execute(
        select(TransferBatchItem).where(TransferBatchItem.batch_id.in_(list(batches.keys())))
    )).scalars().all()
    out = []
    for it in items:
        if not bool(getattr(it, "paid", False)):
            continue
        b = batches.get(it.batch_id)
        out.append({
            "id": it.id, "vendor": it.vendor, "amount": _num(it.amount),
            "account_name": it.account_name, "bank_name": it.bank_name, "due_date": it.due_date,
            "paid_at": getattr(it, "paid_at", None).isoformat() if getattr(it, "paid_at", None) else None,
            "paid_by": getattr(it, "paid_by", None),
            "batch_title": b.title if b else None, "batch_id": it.batch_id,
        })
    out.sort(key=lambda r: (r["paid_at"] or ""), reverse=True)
    return {"items": out}
