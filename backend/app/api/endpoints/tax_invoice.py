"""
Tax Invoice API — 세금계산서 발행/조회
홈택스 공동인증서 없이 직접 발행 (Clobe AI 모방)

NOTE: 라우트 스켈레톤.
"""
from datetime import date, datetime, timedelta
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
    TaxInvoiceItem,
    TaxInvoiceParty,
    InvoiceDirection,
    InvoiceStatus,
)

router = APIRouter()


def _mock_party(name: str, biz_no: str = "123-45-67890") -> TaxInvoiceParty:
    return TaxInvoiceParty(
        business_number=biz_no, company_name=name,
        representative_name="홍길동",
        address="서울특별시 강남구 테헤란로 100",
        business_type="제조업", business_item="식품",
        contact_email="contact@example.com", contact_phone="02-1234-5678",
    )


def _mock_invoice(idx: int, direction: InvoiceDirection = "sales") -> TaxInvoiceResponse:
    items = [
        TaxInvoiceItem(line_no=1, name="식자재 A", quantity=Decimal("100"),
                       unit_price=Decimal("50000"),
                       supply_amount=Decimal("5000000"), tax_amount=Decimal("500000")),
        TaxInvoiceItem(line_no=2, name="식자재 B", quantity=Decimal("50"),
                       unit_price=Decimal("30000"),
                       supply_amount=Decimal("1500000"), tax_amount=Decimal("150000")),
    ]
    supply_total = sum((i.supply_amount for i in items), Decimal("0"))
    tax_total = sum((i.tax_amount for i in items), Decimal("0"))
    return TaxInvoiceResponse(
        id=idx,
        invoice_number=f"2026{idx:08d}",
        direction=direction,
        invoice_type="tax",
        status="issued" if idx % 3 != 0 else "draft",
        issue_date=date.today() - timedelta(days=idx),
        supply_date=date.today() - timedelta(days=idx),
        supplier=_mock_party("우리회사", "111-22-33333"),
        receiver=_mock_party("(주)이마트", "123-45-67890"),
        items=items,
        total_supply_amount=supply_total,
        total_tax_amount=tax_total,
        total_amount=supply_total + tax_total,
        cash_amount=Decimal("0"),
        check_amount=Decimal("0"),
        note_amount=Decimal("0"),
        credit_amount=supply_total + tax_total,
        note=None,
        issued_at=datetime.utcnow() - timedelta(days=idx),
        sent_at=datetime.utcnow() - timedelta(days=idx),
        cancelled_at=None,
        nts_confirmation_number=f"NTS{idx:010d}",
        pdf_url=f"https://example.com/invoices/{idx}.pdf",
        issued_by_user_id=1,
        created_at=datetime.utcnow() - timedelta(days=idx),
    )


@router.post("/", response_model=TaxInvoiceResponse, status_code=status.HTTP_201_CREATED)
async def issue_tax_invoice(
    invoice: TaxInvoiceCreate,
    user_id: int = Query(...),
    db: AsyncSession = Depends(get_db),
):
    """
    세금계산서 발행
    - 홈택스 API 연동을 통해 국세청 발급번호 수신
    - 발급 후 receiver의 contact_email로 자동 발송 (auto_send=True 시)
    """
    # TODO: 실제 발행 로직
    # 1) 입력 검증 (사업자번호 형식, 합계 일치)
    # 2) 홈택스 전자세금계산서 API 호출
    # 3) DB 저장
    # 4) PDF 생성
    # 5) auto_send_to_receiver면 이메일 발송

    supply_total = sum((i.supply_amount for i in invoice.items), Decimal("0"))
    tax_total = sum((i.tax_amount for i in invoice.items), Decimal("0"))
    return TaxInvoiceResponse(
        id=999,
        invoice_number="20260427000999",
        direction=invoice.direction,
        invoice_type=invoice.invoice_type,
        status="issued",
        issue_date=invoice.issue_date,
        supply_date=invoice.supply_date,
        supplier=invoice.supplier,
        receiver=invoice.receiver,
        items=invoice.items,
        total_supply_amount=supply_total,
        total_tax_amount=tax_total,
        total_amount=supply_total + tax_total,
        cash_amount=invoice.cash_amount,
        check_amount=invoice.check_amount,
        note_amount=invoice.note_amount,
        credit_amount=invoice.credit_amount,
        note=invoice.note,
        issued_at=datetime.utcnow(),
        sent_at=datetime.utcnow() if invoice.auto_send_to_receiver else None,
        cancelled_at=None,
        nts_confirmation_number="NTS9999999999",
        pdf_url="https://example.com/invoices/999.pdf",
        issued_by_user_id=user_id,
        created_at=datetime.utcnow(),
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
    """세금계산서 목록 조회"""
    # TODO: 실제 조회
    items = [_mock_invoice(i + 1, direction or "sales") for i in range(min(size, 10))]
    return TaxInvoiceListResponse(
        items=items,
        total=len(items),
        page=page, size=size,
        total_supply_amount=sum((i.total_supply_amount for i in items), Decimal("0")),
        total_tax_amount=sum((i.total_tax_amount for i in items), Decimal("0")),
    )


@router.get("/{invoice_id}", response_model=TaxInvoiceResponse)
async def get_tax_invoice(
    invoice_id: int,
    db: AsyncSession = Depends(get_db),
):
    """세금계산서 상세 조회"""
    # TODO: 실제 조회
    return _mock_invoice(invoice_id)


@router.post("/{invoice_id}/cancel", response_model=TaxInvoiceResponse)
async def cancel_tax_invoice(
    invoice_id: int,
    req: TaxInvoiceCancelRequest,
    user_id: int = Query(...),
    db: AsyncSession = Depends(get_db),
):
    """
    세금계산서 취소 (수정세금계산서 발행)
    - 홈택스 API로 -금액 수정세금계산서 발행
    """
    # TODO: 수정세금계산서 발행 로직
    inv = _mock_invoice(invoice_id)
    inv.status = "cancelled"
    inv.cancelled_at = datetime.utcnow()
    return inv


@router.post("/{invoice_id}/send")
async def resend_tax_invoice(
    invoice_id: int,
    delivery_method: str = Query("email", pattern="^(email|kakao)$"),
    db: AsyncSession = Depends(get_db),
):
    """세금계산서 재발송"""
    # TODO: 발송 큐잉
    return {
        "invoice_id": invoice_id,
        "delivery_method": delivery_method,
        "status": "queued",
        "queued_at": datetime.utcnow().isoformat(),
    }


@router.get("/{invoice_id}/pdf")
async def download_tax_invoice_pdf(
    invoice_id: int,
    db: AsyncSession = Depends(get_db),
):
    """PDF 다운로드 URL 발급 (서명된 임시 URL)"""
    # TODO: 실제 PDF 생성/조회
    return {
        "invoice_id": invoice_id,
        "url": f"https://example.com/invoices/{invoice_id}.pdf",
        "expires_at": (datetime.utcnow() + timedelta(hours=1)).isoformat(),
    }


# ==================== 거래처 템플릿 ====================

@router.get("/templates/counterparties", response_model=List[TaxInvoiceCounterpartyTemplate])
async def list_counterparty_templates(
    db: AsyncSession = Depends(get_db),
):
    """자주 쓰는 거래처 템플릿 목록"""
    # TODO: 실제 조회
    return [
        TaxInvoiceCounterpartyTemplate(
            id=1, nickname="이마트 본사",
            party=_mock_party("(주)이마트", "123-45-67890"),
            last_used_at=datetime.utcnow() - timedelta(days=2),
            usage_count=24,
        ),
        TaxInvoiceCounterpartyTemplate(
            id=2, nickname="롯데마트 본사",
            party=_mock_party("롯데마트", "345-67-89012"),
            last_used_at=datetime.utcnow() - timedelta(days=5),
            usage_count=18,
        ),
    ]


@router.post("/templates/counterparties",
             response_model=TaxInvoiceCounterpartyTemplate,
             status_code=status.HTTP_201_CREATED)
async def create_counterparty_template(
    nickname: str,
    party: TaxInvoiceParty,
    db: AsyncSession = Depends(get_db),
):
    """거래처 템플릿 등록"""
    # TODO: 실제 저장
    return TaxInvoiceCounterpartyTemplate(
        id=999, nickname=nickname, party=party,
        last_used_at=None, usage_count=0,
    )
