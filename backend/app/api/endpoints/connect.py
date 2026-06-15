"""
Connect API — 클로브커넥트 (스켈레톤)
세무대리인 기능은 별도 데이터 모델 필요. 현재는 mock 제거 + 빈 응답.
"""
from datetime import date, datetime
from decimal import Decimal
from typing import Optional, List
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.schemas.connect import (
    TaxClient,
    TaxClientCreate,
    TaxClientUpdate,
    TaxClientListResponse,
    ClientStatus,
    CollectionStatus,
    ClosingStatus,
    CollectionSource,
    ClientCollectionStatus,
    PendingVoucherListResponse,
    ClosingPeriod,
    ClosingStartRequest,
    ClosingCompleteRequest,
    WehagoExportRequest,
    WehagoExportResponse,
)

router = APIRouter()


@router.get("/clients", response_model=TaxClientListResponse)
async def list_clients(
    client_status: Optional[ClientStatus] = None,
    collection_status: Optional[CollectionStatus] = None,
    only_pending_review: bool = False,
    search: Optional[str] = None,
    page: int = Query(1, ge=1),
    size: int = Query(50, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
):
    return TaxClientListResponse(
        items=[],
        total=0,
        page=page,
        size=size,
        summary={"active": 0, "paused": 0, "onboarding": 0, "errors": 0, "total_pending_vouchers": 0},
    )


@router.get("/clients/{client_id}", response_model=TaxClient)
async def get_client(client_id: int, db: AsyncSession = Depends(get_db)):
    raise HTTPException(status_code=404, detail="수임고객을 찾을 수 없습니다.")


@router.post("/clients", response_model=TaxClient, status_code=status.HTTP_201_CREATED)
async def create_client(req: TaxClientCreate, db: AsyncSession = Depends(get_db)):
    raise HTTPException(status_code=501, detail="수임고객 등록은 추후 활성화됩니다.")


@router.patch("/clients/{client_id}", response_model=TaxClient)
async def update_client(client_id: int, req: TaxClientUpdate, db: AsyncSession = Depends(get_db)):
    raise HTTPException(status_code=404, detail="수임고객을 찾을 수 없습니다.")


@router.delete("/clients/{client_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_client(client_id: int, db: AsyncSession = Depends(get_db)):
    return


@router.get("/clients/{client_id}/collection", response_model=ClientCollectionStatus)
async def get_collection_status(client_id: int, db: AsyncSession = Depends(get_db)):
    return ClientCollectionStatus(
        client_id=client_id,
        client_name="-",
        sources=[],
        total_collected_today=0,
        last_full_sync_at=None,
        next_scheduled_sync_at=None,
    )


@router.post("/clients/{client_id}/collection/trigger")
async def trigger_collection(
    client_id: int,
    source_id: Optional[int] = None,
    db: AsyncSession = Depends(get_db),
):
    return {"client_id": client_id, "status": "queued"}


@router.get("/clients/{client_id}/pending-vouchers", response_model=PendingVoucherListResponse)
async def list_pending_vouchers(
    client_id: int,
    only_low_confidence: bool = False,
    page: int = Query(1, ge=1),
    size: int = Query(50, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
):
    return PendingVoucherListResponse(items=[], total=0, high_confidence_count=0, low_confidence_count=0)


@router.post("/vouchers/{voucher_id}/approve")
async def approve_pending_voucher(
    voucher_id: int,
    user_id: int = Query(...),
    db: AsyncSession = Depends(get_db),
):
    return {"voucher_id": voucher_id, "status": "approved"}


@router.post("/vouchers/{voucher_id}/reclassify")
async def reclassify_voucher(
    voucher_id: int,
    new_account_code: str,
    user_id: int = Query(...),
    db: AsyncSession = Depends(get_db),
):
    return {"voucher_id": voucher_id, "new_account_code": new_account_code}


@router.get("/clients/{client_id}/closing-periods", response_model=List[ClosingPeriod])
async def list_closing_periods(
    client_id: int,
    fiscal_year: Optional[int] = None,
    status_filter: Optional[ClosingStatus] = Query(None, alias="status"),
    db: AsyncSession = Depends(get_db),
):
    return []


@router.post("/closing", response_model=ClosingPeriod, status_code=status.HTTP_201_CREATED)
async def start_closing(
    req: ClosingStartRequest,
    user_id: int = Query(...),
    db: AsyncSession = Depends(get_db),
):
    raise HTTPException(status_code=501, detail="결산 기능은 추후 활성화됩니다.")


@router.post("/closing/{closing_id}/complete", response_model=ClosingPeriod)
async def complete_closing(
    closing_id: int,
    req: ClosingCompleteRequest,
    user_id: int = Query(...),
    db: AsyncSession = Depends(get_db),
):
    raise HTTPException(status_code=404, detail="결산 기간을 찾을 수 없습니다.")


@router.post("/closing/{closing_id}/wehago-export", response_model=WehagoExportResponse)
async def export_to_wehago(
    closing_id: int,
    req: WehagoExportRequest,
    db: AsyncSession = Depends(get_db),
):
    raise HTTPException(status_code=501, detail="위하고 export는 추후 활성화됩니다.")


@router.get("/closing/{closing_id}/exports")
async def list_exports(closing_id: int, db: AsyncSession = Depends(get_db)):
    return {"closing_id": closing_id, "exports": []}
