"""
Account Transfer API — 계좌 이체 (사용자 요청으로 메뉴 비활성화)
실제 운영에서 전산 이체는 사용하지 않으므로 라우트는 유지하되 빈 응답 반환.
"""
from decimal import Decimal
from typing import Optional, List
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.schemas.transfer import (
    TransferRequest,
    BulkTransferRequest,
    TransferResponse,
    TransferListResponse,
    TransferOTPVerifyRequest,
    TransferRecipientBookmark,
    TransferRecipientBookmarkCreate,
    TransferStatus,
)

router = APIRouter()


def _disabled():
    raise HTTPException(
        status_code=501,
        detail="계좌 이체 기능은 비활성화되어 있습니다.",
    )


@router.post("/", response_model=TransferResponse, status_code=status.HTTP_201_CREATED)
async def create_transfer(req: TransferRequest, user_id: int = Query(...), db: AsyncSession = Depends(get_db)):
    _disabled()


@router.post("/bulk", response_model=List[TransferResponse], status_code=status.HTTP_201_CREATED)
async def create_bulk_transfer(req: BulkTransferRequest, user_id: int = Query(...), db: AsyncSession = Depends(get_db)):
    _disabled()


@router.get("/", response_model=TransferListResponse)
async def list_transfers(
    status_filter: Optional[TransferStatus] = Query(None, alias="status"),
    page: int = Query(1, ge=1),
    size: int = Query(50, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
):
    return TransferListResponse(items=[], total=0, page=page, size=size, total_amount=Decimal("0"))


@router.get("/{transfer_id}", response_model=TransferResponse)
async def get_transfer(transfer_id: int, db: AsyncSession = Depends(get_db)):
    raise HTTPException(status_code=404, detail="이체를 찾을 수 없습니다.")


@router.post("/{transfer_id}/execute", response_model=TransferResponse)
async def execute_transfer(
    transfer_id: int,
    otp: TransferOTPVerifyRequest,
    user_id: int = Query(...),
    db: AsyncSession = Depends(get_db),
):
    _disabled()


@router.post("/{transfer_id}/cancel", response_model=TransferResponse)
async def cancel_transfer(
    transfer_id: int,
    reason: str = Query(...),
    user_id: int = Query(...),
    db: AsyncSession = Depends(get_db),
):
    _disabled()


@router.get("/bookmarks/", response_model=List[TransferRecipientBookmark])
async def list_bookmarks(db: AsyncSession = Depends(get_db)):
    return []


@router.post("/bookmarks/", response_model=TransferRecipientBookmark, status_code=status.HTTP_201_CREATED)
async def create_bookmark(req: TransferRecipientBookmarkCreate, db: AsyncSession = Depends(get_db)):
    _disabled()


@router.delete("/bookmarks/{bookmark_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_bookmark(bookmark_id: int, db: AsyncSession = Depends(get_db)):
    return


@router.post("/{transfer_id}/request-otp")
async def request_otp(transfer_id: int, db: AsyncSession = Depends(get_db)):
    _disabled()
