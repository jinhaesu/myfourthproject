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


def _mask_account_number(account_number: str) -> str:
    """계좌번호 마스킹"""
    if not account_number or len(account_number) < 4:
        return account_number or ""
    return "*" * (len(account_number) - 4) + account_number[-4:]


def bank_account_to_response(account) -> dict:
    """BankAccount ORM을 BankAccountResponse 호환 dict로 변환"""
    return {
        "id": account.id,
        "bank_code": account.bank_code,
        "bank_name": account.bank_name,
        "account_number_masked": _mask_account_number(account.account_number),
        "account_holder": account.account_holder,
        "account_type": account.account_type.value if hasattr(account.account_type, 'value') else str(account.account_type),
        "account_alias": account.account_alias,
        "current_balance": account.current_balance,
        "available_balance": account.available_balance,
        "last_balance_update": account.last_balance_update,
        "gl_account_id": account.gl_account_id,
        "is_virtual_account_enabled": account.is_virtual_account_enabled,
        "api_connected": account.api_connected,
        "api_last_sync": account.api_last_sync,
        "is_active": account.is_active,
    }


# ==================== 은행 계좌 ====================

@router.post("/accounts/", response_model=BankAccountResponse, status_code=status.HTTP_201_CREATED)
async def create_bank_account(
    account_data: BankAccountCreate,
    db: AsyncSession = Depends(get_db)
):
    """은행 계좌 등록"""
    from app.models.treasury import BankAccount, BankAccountType

    account = BankAccount(
        **{**account_data.model_dump(), "account_type": BankAccountType(account_data.account_type)}
    )
    db.add(account)
    await db.commit()

    return bank_account_to_response(account)


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

    return [bank_account_to_response(a) for a in accounts]


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

def receivable_to_response(r) -> dict:
    """Receivable ORM을 ReceivableResponse 호환 dict로 변환"""
    return {
        "id": r.id,
        "customer_name": r.customer_name,
        "customer_business_number": r.customer_business_number,
        "invoice_number": r.invoice_number,
        "tax_invoice_number": r.tax_invoice_number,
        "original_amount": r.original_amount,
        "collected_amount": r.collected_amount,
        "outstanding_amount": r.outstanding_amount,
        "invoice_date": r.invoice_date,
        "due_date": r.due_date,
        "status": r.status.value if hasattr(r.status, 'value') else str(r.status),
        "assigned_virtual_account": r.assigned_virtual_account,
        "days_overdue": r.days_overdue,
        "notes": r.notes,
        "created_at": r.created_at,
        "collected_at": r.collected_at,
    }


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

    return receivable_to_response(receivable)


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

    return [receivable_to_response(r) for r in receivables]


@router.get("/receivables/aging", response_model=AgingReportResponse)
async def get_ar_aging(
    as_of_date: Optional[date] = None,
    db: AsyncSession = Depends(get_db)
):
    """매출채권 연령 분석"""
    manager = TreasuryManager(db)
    report = await manager.get_ar_aging_report(as_of_date)

    # items를 AgingReportItem 형식으로 변환
    items = [
        {
            "customer_or_vendor": item.get("customer", ""),
            "total_amount": item.get("total", 0),
            "current": item.get("current", 0),
            "days_1_30": item.get("days_1_30", 0),
            "days_31_60": item.get("days_31_60", 0),
            "days_61_90": item.get("days_61_90", 0),
            "days_over_90": item.get("days_over_90", 0),
        }
        for item in report["items"]
    ]
    summary_data = report["summary"]
    summary = {
        "customer_or_vendor": "합계",
        "total_amount": summary_data.get("total", 0),
        "current": summary_data.get("current", 0),
        "days_1_30": summary_data.get("days_1_30", 0),
        "days_31_60": summary_data.get("days_31_60", 0),
        "days_61_90": summary_data.get("days_61_90", 0),
        "days_over_90": summary_data.get("days_over_90", 0),
    }

    return AgingReportResponse(
        report_type="receivables",
        report_date=as_of_date or date.today(),
        items=items,
        summary=summary
    )


# ==================== 매입채무 ====================

def payable_to_response(p) -> dict:
    """Payable ORM을 PayableResponse 호환 dict로 변환"""
    return {
        "id": p.id,
        "vendor_name": p.vendor_name,
        "vendor_business_number": p.vendor_business_number,
        "invoice_number": p.invoice_number,
        "tax_invoice_number": p.tax_invoice_number,
        "original_amount": p.original_amount,
        "paid_amount": p.paid_amount,
        "outstanding_amount": p.outstanding_amount,
        "invoice_date": p.invoice_date,
        "due_date": p.due_date,
        "status": p.status.value if hasattr(p.status, 'value') else str(p.status),
        "payment_bank_account_id": p.payment_bank_account_id,
        "vendor_bank_account": p.vendor_bank_account,
        "days_overdue": p.days_overdue,
        "notes": p.notes,
        "created_at": p.created_at,
        "paid_at": p.paid_at,
    }


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

    return payable_to_response(payable)


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

    return [payable_to_response(p) for p in payables]


@router.get("/payables/aging", response_model=AgingReportResponse)
async def get_ap_aging(
    as_of_date: Optional[date] = None,
    db: AsyncSession = Depends(get_db)
):
    """매입채무 연령 분석"""
    manager = TreasuryManager(db)
    report = await manager.get_ap_aging_report(as_of_date)

    # items를 AgingReportItem 형식으로 변환
    items = [
        {
            "customer_or_vendor": item.get("vendor", ""),
            "total_amount": item.get("total", 0),
            "current": item.get("current", 0),
            "days_1_30": item.get("days_1_30", 0),
            "days_31_60": item.get("days_31_60", 0),
            "days_61_90": item.get("days_61_90", 0),
            "days_over_90": item.get("days_over_90", 0),
        }
        for item in report["items"]
    ]
    summary_data = report["summary"]
    summary = {
        "customer_or_vendor": "합계",
        "total_amount": summary_data.get("total", 0),
        "current": summary_data.get("current", 0),
        "days_1_30": summary_data.get("days_1_30", 0),
        "days_31_60": summary_data.get("days_31_60", 0),
        "days_61_90": summary_data.get("days_61_90", 0),
        "days_over_90": summary_data.get("days_over_90", 0),
    }

    return AgingReportResponse(
        report_type="payables",
        report_date=as_of_date or date.today(),
        items=items,
        summary=summary
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
        error_msg = str(e)
        if "찾을 수 없" in error_msg or "not found" in error_msg.lower():
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=error_msg)
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=error_msg)


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
