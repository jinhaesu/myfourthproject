"""
현금흐름(Cash Flow) API — 통장내역 기반 旬×월 현금흐름표 + 거래 재분류.

데이터 소스: hyphen_bank_tx (통장 거래) − 내부거래. (사용자 지시 2026-10-12)
- GET  /cashflow/pivot?year=        : 旬×월 현금흐름 피벗
- GET  /cashflow/transactions       : 특정 (월·旬) 거래 목록(분류 재지정용)
- PUT  /cashflow/classify           : 거래 1건 라인 재분류(영속)
- POST /cashflow/classify/bulk      : 여러 건 일괄 재분류
- PUT  /cashflow/opening            : 연초 기초잔액 수동보정
"""
from datetime import date
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.models.cashflow import CF_LINES
from app.services import cashflow_statement as svc

router = APIRouter()


@router.get("/lines")
async def lines():
    """현금흐름 라인 정의(프론트 드롭다운용)."""
    return {"lines": [{"key": k, "label": label, "dir": d} for k, label, d in CF_LINES]}


@router.get("/pivot")
async def pivot(year: Optional[int] = Query(default=None), db: AsyncSession = Depends(get_db)):
    y = year or date.today().year
    return await svc.build_pivot(db, y)


@router.get("/transactions")
async def transactions(
    year: int = Query(...), month: int = Query(...),
    xun: Optional[int] = Query(default=None),
    line: Optional[str] = Query(default=None), db: AsyncSession = Depends(get_db),
):
    return {"items": await svc.list_bucket_txs(db, year, month, xun, line)}


class ClassifyReq(BaseModel):
    tx_hash: str
    cf_line: str
    cf_sub: Optional[str] = None


@router.put("/classify")
async def classify(req: ClassifyReq, by: Optional[str] = Query(default=None),
                   db: AsyncSession = Depends(get_db)):
    try:
        await svc.set_class(db, req.tx_hash, req.cf_line, req.cf_sub, by)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"ok": True}


class BulkClassifyReq(BaseModel):
    tx_hashes: List[str]
    cf_line: str


@router.post("/classify/bulk")
async def classify_bulk(req: BulkClassifyReq, by: Optional[str] = Query(default=None),
                        db: AsyncSession = Depends(get_db)):
    n = 0
    for h in req.tx_hashes:
        try:
            await svc.set_class(db, h, req.cf_line, None, by)
            n += 1
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
    return {"ok": True, "updated": n}


class OpeningReq(BaseModel):
    year: int
    opening_balance: Optional[float] = None


@router.put("/opening")
async def opening(req: OpeningReq, db: AsyncSession = Depends(get_db)):
    await svc.set_opening(db, req.year, req.opening_balance)
    return {"ok": True}
