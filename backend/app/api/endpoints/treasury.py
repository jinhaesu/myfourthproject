"""
Smart Finance Core - Treasury API
자금 관리 API 엔드포인트
"""
from datetime import date
from typing import Optional, List
from fastapi import APIRouter, Depends, HTTPException, status, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.schemas.treasury import (
    BankAccountCreate, BankAccountResponse, BankTransactionResponse,
    ReceivableCreate, ReceivableResponse, PayableCreate, PayableResponse,
    PaymentScheduleCreate, PaymentScheduleResponse, ReconciliationMatchResponse,
    AgingReportResponse
)
from app.services.treasury_manager import TreasuryManager

router = APIRouter()


# ==================== 은행 계좌 ====================

@router.post("/accounts/", response_model=BankAccountResponse, status_code=status.HTTP_201_CREATED)
async def create_bank_account(
    account_data: BankAccountCreate,
    db: AsyncSession = Depends(get_db)
):
    """은행 계좌 등록"""
    from app.models.treasury import BankAccount

    account = BankAccount(**account_data.model_dump())
    db.add(account)
    await db.commit()

    return BankAccountResponse.model_validate(account)


@router.get("/accounts/", response_model=List[BankAccountResponse])
async def get_bank_accounts(
    db: AsyncSession = Depends(get_db)
):
    """은행 계좌 목록 조회"""
    from app.models.treasury import BankAccount
    from sqlalchemy import select

    result = await db.execute(
        select(BankAccount).where(BankAccount.is_active == True)
    )
    accounts = result.scalars().all()

    return [BankAccountResponse.model_validate(a) for a in accounts]


@router.get("/cash-position")
async def get_cash_position(
    db: AsyncSession = Depends(get_db)
):
    """현금 포지션 조회"""
    manager = TreasuryManager(db)
    return await manager.get_cash_position()


# ==================== 자동 매칭 ====================

@router.post("/reconcile")
async def auto_reconcile(
    bank_account_id: Optional[int] = None,
    from_date: Optional[date] = None,
    to_date: Optional[date] = None,
    db: AsyncSession = Depends(get_db)
):
    """
    자동 매칭 실행

    - 은행 거래 내역과 채권/채무를 자동으로 매칭합니다
    """
    manager = TreasuryManager(db)

    result = await manager.auto_reconcile_transactions(
        bank_account_id=bank_account_id,
        from_date=from_date,
        to_date=to_date
    )

    return result


# ==================== 매출채권 ====================

@router.post("/receivables/", response_model=ReceivableResponse, status_code=status.HTTP_201_CREATED)
async def create_receivable(
    receivable_data: ReceivableCreate,
    db: AsyncSession = Depends(get_db)
):
    """매출채권 등록"""
    from app.models.treasury import Receivable

    receivable = Receivable(
        **receivable_data.model_dump(),
        outstanding_amount=receivable_data.original_amount
    )
    db.add(receivable)
    await db.commit()

    return ReceivableResponse.model_validate(receivable)


@router.get("/receivables/", response_model=List[ReceivableResponse])
async def get_receivables(
    status: Optional[str] = None,
    customer_name: Optional[str] = None,
    db: AsyncSession = Depends(get_db)
):
    """매출채권 목록 조회"""
    from app.models.treasury import Receivable, ReceivableStatus
    from sqlalchemy import select

    query = select(Receivable)

    if status:
        query = query.where(Receivable.status == ReceivableStatus(status))
    if customer_name:
        query = query.where(Receivable.customer_name.ilike(f"%{customer_name}%"))

    query = query.order_by(Receivable.due_date)

    result = await db.execute(query)
    receivables = result.scalars().all()

    return [ReceivableResponse.model_validate(r) for r in receivables]


@router.get("/receivables/aging", response_model=AgingReportResponse)
async def get_ar_aging(
    as_of_date: Optional[date] = None,
    db: AsyncSession = Depends(get_db)
):
    """매출채권 연령 분석"""
    manager = TreasuryManager(db)
    report = await manager.get_ar_aging_report(as_of_date)

    return AgingReportResponse(
        report_type="receivables",
        report_date=as_of_date or date.today(),
        items=report["items"],
        summary=report["summary"]
    )


# ==================== 매입채무 ====================

@router.post("/payables/", response_model=PayableResponse, status_code=status.HTTP_201_CREATED)
async def create_payable(
    payable_data: PayableCreate,
    db: AsyncSession = Depends(get_db)
):
    """매입채무 등록"""
    from app.models.treasury import Payable

    payable = Payable(
        **payable_data.model_dump(),
        outstanding_amount=payable_data.original_amount
    )
    db.add(payable)
    await db.commit()

    return PayableResponse.model_validate(payable)


@router.get("/payables/", response_model=List[PayableResponse])
async def get_payables(
    status: Optional[str] = None,
    vendor_name: Optional[str] = None,
    db: AsyncSession = Depends(get_db)
):
    """매입채무 목록 조회"""
    from app.models.treasury import Payable, PayableStatus
    from sqlalchemy import select

    query = select(Payable)

    if status:
        query = query.where(Payable.status == PayableStatus(status))
    if vendor_name:
        query = query.where(Payable.vendor_name.ilike(f"%{vendor_name}%"))

    query = query.order_by(Payable.due_date)

    result = await db.execute(query)
    payables = result.scalars().all()

    return [PayableResponse.model_validate(p) for p in payables]


@router.get("/payables/aging", response_model=AgingReportResponse)
async def get_ap_aging(
    as_of_date: Optional[date] = None,
    db: AsyncSession = Depends(get_db)
):
    """매입채무 연령 분석"""
    manager = TreasuryManager(db)
    report = await manager.get_ap_aging_report(as_of_date)

    return AgingReportResponse(
        report_type="payables",
        report_date=as_of_date or date.today(),
        items=report["items"],
        summary=report["summary"]
    )


# ==================== 지급 스케줄 ====================

@router.post("/payment-schedules/", response_model=PaymentScheduleResponse, status_code=status.HTTP_201_CREATED)
async def create_payment_schedule(
    schedule_data: PaymentScheduleCreate,
    user_id: int = Query(..., description="현재 사용자 ID"),
    db: AsyncSession = Depends(get_db)
):
    """지급 스케줄 생성"""
    manager = TreasuryManager(db)

    try:
        schedule = await manager.create_payment_schedule(
            payable_id=schedule_data.payable_id,
            scheduled_date=schedule_data.scheduled_date,
            scheduled_amount=schedule_data.scheduled_amount,
            bank_account_id=schedule_data.bank_account_id,
            user_id=user_id
        )
        return PaymentScheduleResponse.model_validate(schedule)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))


@router.get("/payment-schedules/upcoming", response_model=List[PaymentScheduleResponse])
async def get_upcoming_payments(
    days_ahead: int = Query(30, ge=1, le=90),
    bank_account_id: Optional[int] = None,
    db: AsyncSession = Depends(get_db)
):
    """예정 지급 목록 조회"""
    manager = TreasuryManager(db)

    schedules = await manager.get_upcoming_payments(days_ahead, bank_account_id)

    return [PaymentScheduleResponse.model_validate(s) for s in schedules]
