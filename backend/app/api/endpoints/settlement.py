"""
Settlement API — 매출·매입·거래처 정산
거래처별로 받을 돈/줄 돈을 한 화면에서 정산

NOTE: 라우트 스켈레톤.
"""
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Optional, List
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.schemas.settlement import (
    SettlementListResponse,
    SettlementDetailResponse,
    CounterpartyBalance,
    SettlementDetailItem,
    SettlementOffsetRequest,
    SettlementOffsetResponse,
    CounterpartyType,
    SettlementStatus,
)

router = APIRouter()


def _mock_balance(idx: int) -> CounterpartyBalance:
    samples = [
        ("(주)이마트", "123-45-67890", "customer", 28500000, 0, "active"),
        ("(주)대상", "234-56-78901", "vendor", 0, 12400000, "pending"),
        ("롯데마트", "345-67-89012", "customer", 14200000, 3500000, "active"),
        ("(주)CJ제일제당", "456-78-90123", "vendor", 1500000, 8700000, "partial"),
        ("쿠팡", "567-89-01234", "both", 22000000, 5800000, "active"),
        ("스마트로PG", "678-90-12345", "customer", 6500000, 0, "active"),
    ]
    s = samples[idx % len(samples)]
    rec = Decimal(str(s[3])); pay = Decimal(str(s[4]))
    return CounterpartyBalance(
        counterparty_id=idx + 1,
        counterparty_name=s[0],
        business_number=s[1],
        counterparty_type=s[2],  # type: ignore[arg-type]
        receivable_total=rec,
        payable_total=pay,
        net_balance=rec - pay,
        last_transaction_date=date.today() - timedelta(days=idx % 14),
        overdue_amount=Decimal("0") if idx % 4 != 0 else Decimal("3200000"),
        status=s[5],  # type: ignore[arg-type]
        contact_person=f"담당자{idx + 1}",
        contact_phone=None,
    )


@router.get("/", response_model=SettlementListResponse)
async def list_settlements(
    counterparty_type: Optional[CounterpartyType] = None,
    status_filter: Optional[SettlementStatus] = Query(None, alias="status"),
    only_overdue: bool = False,
    search: Optional[str] = None,
    sort_by: str = Query("net_balance_desc",
                         description="net_balance_desc | net_balance_asc | last_tx_desc | overdue_desc"),
    page: int = Query(1, ge=1),
    size: int = Query(50, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
):
    """
    거래처별 정산 잔액 목록
    - 받을 돈 / 줄 돈 / 순잔액(net) 동시 표시
    - 연체 금액 별도 표시
    """
    # TODO: counterparties 테이블 + receivables + payables 집계
    items = [_mock_balance(i) for i in range(min(size, 6))]
    return SettlementListResponse(
        items=items,
        total_count=len(items),
        total_receivable=sum((i.receivable_total for i in items), Decimal("0")),
        total_payable=sum((i.payable_total for i in items), Decimal("0")),
        total_net=sum((i.net_balance for i in items), Decimal("0")),
    )


@router.get("/{counterparty_id}", response_model=SettlementDetailResponse)
async def get_counterparty_settlement(
    counterparty_id: int,
    from_date: Optional[date] = None,
    to_date: Optional[date] = None,
    db: AsyncSession = Depends(get_db),
):
    """거래처 상세 정산 (개별 거래 내역 포함)"""
    # TODO: 실제 거래 내역 조회 (receivables + payables + tax_invoices + bank_transactions)
    counterparty = _mock_balance(counterparty_id - 1)
    items = [
        SettlementDetailItem(
            id=1, transaction_date=date.today() - timedelta(days=10),
            document_type="tax_invoice", document_number="20260417-001",
            direction="receivable", amount=Decimal("8500000"),
            settled_amount=Decimal("0"), outstanding=Decimal("8500000"),
            due_date=date.today() + timedelta(days=20),
            status="pending",
            description="식자재 4월 1차 납품",
        ),
        SettlementDetailItem(
            id=2, transaction_date=date.today() - timedelta(days=5),
            document_type="tax_invoice", document_number="20260422-002",
            direction="receivable", amount=Decimal("12000000"),
            settled_amount=Decimal("0"), outstanding=Decimal("12000000"),
            due_date=date.today() + timedelta(days=25),
            status="pending",
            description="식자재 4월 2차 납품",
        ),
        SettlementDetailItem(
            id=3, transaction_date=date.today() - timedelta(days=2),
            document_type="payment", document_number=None,
            direction="receivable", amount=Decimal("8000000"),
            settled_amount=Decimal("8000000"), outstanding=Decimal("0"),
            due_date=None,
            status="settled",
            description="입금 (스마트로 PG)",
        ),
    ]
    return SettlementDetailResponse(counterparty=counterparty, items=items)


@router.post("/offset", response_model=SettlementOffsetResponse)
async def create_offset(
    req: SettlementOffsetRequest,
    user_id: int = Query(...),
    db: AsyncSession = Depends(get_db),
):
    """
    채권/채무 상계 처리
    같은 거래처의 받을 돈과 줄 돈을 상계하여 순잔액만 정산
    """
    # TODO: 실제 상계 거래 생성. receivables/payables 차감 + 상계 전표 생성.
    return SettlementOffsetResponse(
        offset_id=999,
        counterparty_id=req.counterparty_id,
        offset_amount=req.offset_amount,
        affected_receivable_ids=req.receivable_ids,
        affected_payable_ids=req.payable_ids,
        new_net_balance=Decimal("0"),
        created_at=datetime.utcnow(),
    )


@router.post("/{counterparty_id}/send-statement")
async def send_settlement_statement(
    counterparty_id: int,
    delivery_method: str = Query("email", pattern="^(email|kakao|sms)$"),
    db: AsyncSession = Depends(get_db),
):
    """거래처에 정산서 발송 (이메일/카카오)"""
    # TODO: PDF 생성 + 발송 큐잉
    return {
        "counterparty_id": counterparty_id,
        "delivery_method": delivery_method,
        "status": "queued",
        "queued_at": datetime.utcnow().isoformat(),
    }


@router.get("/{counterparty_id}/aging")
async def get_counterparty_aging(
    counterparty_id: int,
    db: AsyncSession = Depends(get_db),
):
    """거래처별 연령 분석 (overdue buckets)"""
    # TODO: 실제 aging 집계
    return {
        "counterparty_id": counterparty_id,
        "current": "8500000",
        "days_1_30": "12000000",
        "days_31_60": "0",
        "days_61_90": "0",
        "days_over_90": "3200000",
        "total": "23700000",
    }
