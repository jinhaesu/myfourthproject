"""
이체 승인 API — 매입채무(SCM/엑셀) → 旬별 이체리스트 → 대표 승인 → 지급완료(+SCM 통보).

- GET  /transfer-approval/payables           : 매입채무 목록(year?,month?,status?)
- GET  /transfer-approval/transfer-list       : 旬별 이체리스트(year,month,xun?)
- POST /transfer-approval/sync-scm            : SCM 당겨오기
- POST /transfer-approval/import              : 엑셀 임포트 {rows:[...]}
- POST /transfer-approval/approve             : 旬 승인 {year,month,xun}  (?by=이메일)
- POST /transfer-approval/payables/{id}/paid  : 지급완료 {paid_amount?}
"""
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.models.payable_transfer import PayableItem
from app.services import transfer_approval as svc

router = APIRouter()


@router.get("/payables")
async def payables(year: Optional[int] = Query(default=None), month: Optional[int] = Query(default=None),
                   status: Optional[str] = Query(default=None), db: AsyncSession = Depends(get_db)):
    q = select(PayableItem)
    if status:
        q = q.where(PayableItem.status == status)
    if year and month:
        q = q.where(PayableItem.due_date.like(f"{year}-{month:02d}-%"))
    elif year:
        q = q.where(PayableItem.due_date.like(f"{year}-%"))
    q = q.order_by(PayableItem.due_date, PayableItem.vendor)
    rows = (await db.execute(q)).scalars().all()
    return {"items": [svc._serialize(r) for r in rows], "count": len(rows)}


@router.get("/transfer-list")
async def transfer_list(year: int = Query(...), month: int = Query(...),
                        xun: Optional[int] = Query(default=None), db: AsyncSession = Depends(get_db)):
    return await svc.list_transfer_list(db, year, month, xun)


@router.post("/sync-scm")
async def sync_scm(db: AsyncSession = Depends(get_db)):
    return await svc.sync_from_scm(db)


class ImportReq(BaseModel):
    rows: List[Dict[str, Any]]


@router.post("/import")
async def import_rows(req: ImportReq, db: AsyncSession = Depends(get_db)):
    return await svc.import_rows(db, req.rows)


class ApproveReq(BaseModel):
    year: int
    month: int
    xun: int


@router.post("/approve")
async def approve(req: ApproveReq, by: Optional[str] = Query(default=None), db: AsyncSession = Depends(get_db)):
    return await svc.approve(db, req.year, req.month, req.xun, by)


class PaidReq(BaseModel):
    paid_amount: Optional[float] = None


@router.post("/payables/{item_id}/paid")
async def mark_paid(item_id: int, req: PaidReq, db: AsyncSession = Depends(get_db)):
    return await svc.mark_paid(db, item_id, req.paid_amount)


# ===== 이체 보고서 워크플로우 (회계팀 작성 → 대표 제출 → 대표 승인/질의/반려) =====

class BatchReq(BaseModel):
    year: int
    month: int
    xun: int
    title: Optional[str] = None


@router.post("/batches")
async def create_batch(req: BatchReq, by: Optional[str] = Query(default=None), db: AsyncSession = Depends(get_db)):
    return await svc.create_batch(db, req.year, req.month, req.xun, req.title, by)


@router.get("/batches")
async def list_batches(year: Optional[int] = Query(default=None), month: Optional[int] = Query(default=None),
                       status: Optional[str] = Query(default=None), db: AsyncSession = Depends(get_db)):
    return await svc.list_batches(db, year, month, status)


@router.get("/batches/{batch_id}")
async def get_batch(batch_id: int, db: AsyncSession = Depends(get_db)):
    return await svc.get_batch(db, batch_id)


@router.get("/batches/{batch_id}/report")
async def batch_report(batch_id: int, db: AsyncSession = Depends(get_db)):
    return await svc.batch_report(db, batch_id)


class AddReq(BaseModel):
    payable_ids: Optional[List[int]] = None
    items: Optional[List[Dict[str, Any]]] = None


@router.post("/batches/{batch_id}/add")
async def add_to_batch(batch_id: int, req: AddReq, db: AsyncSession = Depends(get_db)):
    return await svc.add_to_batch(db, batch_id, req.payable_ids, req.items)


@router.post("/batches/{batch_id}/submit")
async def submit_batch(batch_id: int, by: Optional[str] = Query(default=None), db: AsyncSession = Depends(get_db)):
    return await svc.submit_batch(db, batch_id, by)


@router.post("/batches/{batch_id}/review")
async def review_batch(batch_id: int, by: Optional[str] = Query(default=None), db: AsyncSession = Depends(get_db)):
    return await svc.review_batch(db, batch_id, by)


class ItemPatch(BaseModel):
    disposition: Optional[str] = None
    priority: Optional[int] = None
    dept_request: Optional[str] = None
    memo: Optional[str] = None
    amount: Optional[float] = None
    account_name: Optional[str] = None
    bank_name: Optional[str] = None
    due_date: Optional[str] = None


@router.put("/batch-items/{item_id}")
async def update_batch_item(item_id: int, req: ItemPatch, db: AsyncSession = Depends(get_db)):
    return await svc.update_batch_item(db, item_id, req.model_dump(exclude_unset=True))


@router.delete("/batch-items/{item_id}")
async def delete_batch_item(item_id: int, db: AsyncSession = Depends(get_db)):
    return await svc.delete_batch_item(db, item_id)


class ActionReq(BaseModel):
    action: str
    comment: Optional[str] = None


@router.post("/batch-items/{item_id}/action")
async def item_action(item_id: int, req: ActionReq, by: Optional[str] = Query(default=None), db: AsyncSession = Depends(get_db)):
    return await svc.item_action(db, item_id, req.action, req.comment, by)
