"""
Smart Finance Core - Vouchers API
전표 관리 API 엔드포인트
"""
from datetime import date
from typing import Optional, List
from fastapi import APIRouter, Depends, HTTPException, status, Query, UploadFile, File
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.schemas.accounting import (
    VoucherCreate, VoucherUpdate, VoucherResponse, VoucherListResponse,
    AccountResponse
)
from app.services.voucher_service import VoucherService
from app.models.accounting import Account
from sqlalchemy import select

router = APIRouter()


@router.post("/", response_model=VoucherResponse, status_code=status.HTTP_201_CREATED)
async def create_voucher(
    voucher_data: VoucherCreate,
    user_id: int = Query(..., description="현재 사용자 ID"),  # 실제로는 인증에서 가져옴
    db: AsyncSession = Depends(get_db)
):
    """
    전표 생성

    - AI가 자동으로 계정과목을 분류합니다
    - 차변/대변 합계가 일치해야 합니다
    """
    service = VoucherService(db)

    try:
        voucher = await service.create_voucher(
            voucher_date=voucher_data.voucher_date,
            transaction_date=voucher_data.transaction_date,
            description=voucher_data.description,
            transaction_type=voucher_data.transaction_type,
            department_id=voucher_data.department_id,
            user_id=user_id,
            lines=[line.model_dump() for line in voucher_data.lines],
            external_ref=voucher_data.external_ref,
            merchant_name=voucher_data.merchant_name,
            merchant_category=voucher_data.merchant_category,
            custom_tags=voucher_data.custom_tags
        )
        return VoucherResponse.model_validate(voucher)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))


@router.get("/", response_model=VoucherListResponse)
async def list_vouchers(
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=100),
    department_id: Optional[int] = None,
    status: Optional[str] = None,
    from_date: Optional[date] = None,
    to_date: Optional[date] = None,
    search: Optional[str] = None,
    created_by: Optional[int] = None,
    db: AsyncSession = Depends(get_db)
):
    """전표 목록 조회"""
    service = VoucherService(db)

    vouchers, total = await service.get_vouchers(
        page=page,
        size=size,
        department_id=department_id,
        status=status,
        from_date=from_date,
        to_date=to_date,
        search=search,
        created_by=created_by
    )

    pages = (total + size - 1) // size

    return VoucherListResponse(
        items=[VoucherResponse.model_validate(v) for v in vouchers],
        total=total,
        page=page,
        size=size,
        pages=pages
    )


@router.get("/{voucher_id}", response_model=VoucherResponse)
async def get_voucher(
    voucher_id: int,
    db: AsyncSession = Depends(get_db)
):
    """전표 상세 조회"""
    service = VoucherService(db)
    voucher = await service.get_voucher(voucher_id)

    if not voucher:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="전표를 찾을 수 없습니다."
        )

    return VoucherResponse.model_validate(voucher)


@router.patch("/{voucher_id}", response_model=VoucherResponse)
async def update_voucher(
    voucher_id: int,
    voucher_data: VoucherUpdate,
    user_id: int = Query(..., description="현재 사용자 ID"),
    db: AsyncSession = Depends(get_db)
):
    """전표 수정"""
    service = VoucherService(db)

    try:
        updates = voucher_data.model_dump(exclude_unset=True)
        if "lines" in updates and updates["lines"]:
            updates["lines"] = [line.model_dump() for line in voucher_data.lines]

        voucher = await service.update_voucher(voucher_id, user_id, **updates)
        return VoucherResponse.model_validate(voucher)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))


@router.post("/{voucher_id}/confirm", response_model=VoucherResponse)
async def confirm_voucher(
    voucher_id: int,
    user_id: int = Query(..., description="현재 사용자 ID"),
    final_account_id: Optional[int] = None,
    db: AsyncSession = Depends(get_db)
):
    """
    전표 확정 (회계처리 완료)

    - 결재 완료된 전표만 확정 가능
    - AI 분류와 다른 계정을 선택하면 학습 데이터로 활용됩니다
    """
    service = VoucherService(db)

    try:
        voucher = await service.confirm_voucher(voucher_id, user_id, final_account_id)
        return VoucherResponse.model_validate(voucher)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))


@router.delete("/{voucher_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_voucher(
    voucher_id: int,
    db: AsyncSession = Depends(get_db)
):
    """전표 삭제"""
    service = VoucherService(db)

    try:
        await service.delete_voucher(voucher_id)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))


@router.post("/import/card")
async def import_card_transactions(
    transactions: List[dict],
    department_id: int,
    user_id: int = Query(..., description="현재 사용자 ID"),
    db: AsyncSession = Depends(get_db)
):
    """
    카드 거래 일괄 임포트

    - AI가 자동으로 계정과목을 분류합니다
    """
    service = VoucherService(db)

    result = await service.batch_import_card_transactions(
        transactions, department_id, user_id
    )

    return result


@router.get("/accounts/", response_model=List[AccountResponse])
async def get_accounts(
    category_id: Optional[int] = None,
    search: Optional[str] = None,
    db: AsyncSession = Depends(get_db)
):
    """계정과목 목록 조회"""
    query = select(Account).where(Account.is_active == True)

    if category_id:
        query = query.where(Account.category_id == category_id)

    if search:
        query = query.where(
            (Account.code.ilike(f"%{search}%")) |
            (Account.name.ilike(f"%{search}%"))
        )

    query = query.order_by(Account.code)

    result = await db.execute(query)
    accounts = result.scalars().all()

    return [AccountResponse.model_validate(a) for a in accounts]
