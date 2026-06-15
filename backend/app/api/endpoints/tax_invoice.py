"""
Tax Invoice API — 세금계산서 (스켈레톤)
홈택스 직접 연동 후 실제 데이터로 교체 예정. 현재는 mock 제거 + 빈 응답.
"""
from datetime import date, datetime
from decimal import Decimal
from typing import Optional, List
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.schemas.tax_invoice import (
    TaxInvoiceCreate,
    TaxInvoiceResponse,
    TaxInvoiceListResponse,
    TaxInvoiceCancelRequest,
    TaxInvoiceCounterpartyTemplate,
    TaxInvoiceParty,
    InvoiceDirection,
    InvoiceStatus,
)

router = APIRouter()


@router.post("/", response_model=TaxInvoiceResponse, status_code=status.HTTP_201_CREATED)
async def issue_tax_invoice(
    invoice: TaxInvoiceCreate,
    user_id: int = Query(...),
    db: AsyncSession = Depends(get_db),
):
    """세금계산서 발행 — TODO: 홈택스 API 연동."""
    raise HTTPException(
        status_code=501,
        detail="세금계산서 발행 기능은 홈택스 연동 후 활성화됩니다.",
    )


@router.get("/", response_model=TaxInvoiceListResponse)
async def list_tax_invoices(
    direction: Optional[InvoiceDirection] = None,
    status_filter: Optional[InvoiceStatus] = Query(None, alias="status"),
    counterparty_business_number: Optional[str] = None,
    from_date: Optional[date] = None,
    to_date: Optional[date] = None,
    page: int = Query(1, ge=1),
    size: int = Query(50, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
):
    """세금계산서 목록 — TODO: 홈택스 데이터 연결."""
    return TaxInvoiceListResponse(
        items=[],
        total=0,
        page=page,
        size=size,
        total_supply_amount=Decimal("0"),
        total_tax_amount=Decimal("0"),
    )


@router.get("/{invoice_id}", response_model=TaxInvoiceResponse)
async def get_tax_invoice(invoice_id: int, db: AsyncSession = Depends(get_db)):
    raise HTTPException(status_code=404, detail="세금계산서를 찾을 수 없습니다.")


@router.post("/{invoice_id}/cancel", response_model=TaxInvoiceResponse)
async def cancel_tax_invoice(
    invoice_id: int,
    req: TaxInvoiceCancelRequest,
    user_id: int = Query(...),
    db: AsyncSession = Depends(get_db),
):
    raise HTTPException(status_code=404, detail="세금계산서를 찾을 수 없습니다.")


@router.post("/{invoice_id}/send")
async def resend_tax_invoice(
    invoice_id: int,
    delivery_method: str = Query("email", pattern="^(email|kakao)$"),
    db: AsyncSession = Depends(get_db),
):
    return {
        "invoice_id": invoice_id,
        "delivery_method": delivery_method,
        "status": "queued",
    }


@router.get("/{invoice_id}/pdf")
async def download_tax_invoice_pdf(invoice_id: int, db: AsyncSession = Depends(get_db)):
    raise HTTPException(status_code=404, detail="PDF가 없습니다.")


@router.get("/templates/counterparties", response_model=List[TaxInvoiceCounterpartyTemplate])
async def list_counterparty_templates(db: AsyncSession = Depends(get_db)):
    return []


@router.post(
    "/templates/counterparties",
    response_model=TaxInvoiceCounterpartyTemplate,
    status_code=status.HTTP_201_CREATED,
)
async def create_counterparty_template(
    nickname: str,
    party: TaxInvoiceParty,
    db: AsyncSession = Depends(get_db),
):
    return TaxInvoiceCounterpartyTemplate(
        id=0,
        nickname=nickname,
        party=party,
        last_used_at=None,
        usage_count=0,
    )
