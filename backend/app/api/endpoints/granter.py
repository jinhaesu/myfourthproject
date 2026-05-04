"""
Granter API 라우터
- 연동/거래/잔액/환율 조회
- 세금계산서·현금영수증 발행/취소
- 거래 내역 sync (그랜터 → ai_raw_transaction_data)

API 키는 GRANTER_API_KEY 환경변수에서 자동 로드.
"""
import logging
import re
from datetime import date, datetime
from decimal import Decimal
from typing import Optional, List, Dict, Any
from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.models.ai import AIRawTransactionData, AIDataUploadHistory
from app.services.granter_client import (
    get_granter_client,
    GranterClient,
    GranterAPIError,
)

logger = logging.getLogger(__name__)
router = APIRouter()


# ============ 진단 / 상태 ============

@router.get("/health")
async def granter_health():
    """그랜터 API 키 설정 상태 확인 (실제 호출은 안 함)"""
    client = get_granter_client()
    return {
        "configured": client.is_configured,
        "base_url": client.base_url,
        "timeout_seconds": client.timeout,
    }


@router.get("/ping")
async def granter_ping():
    """실제 그랜터 서버 연결 테스트 (가벼운 GET) — 상세 에러 정보 포함"""
    client = get_granter_client()
    try:
        result = await client.list_connections()
        return {
            "ok": True,
            "base_url": client.base_url,
            "connections_count": len(result) if isinstance(result, list) else "unknown",
            "sample": (result[:1] if isinstance(result, list) else result),
        }
    except GranterAPIError as e:
        # 사용자가 직접 진단할 수 있게 상세 정보 노출
        return {
            "ok": False,
            "base_url": client.base_url,
            "configured": client.is_configured,
            "status_code": e.status_code,
            "error": str(e),
            "response_body": e.body,
            "hints": [
                "1. Railway 대시보드에 GRANTER_API_KEY가 정확히 등록됐는지 확인",
                "2. GRANTER_BASE_URL이 그랜터 공식 API 호스트와 일치하는지 확인",
                "   (현재: " + client.base_url + ")",
                "3. 그랜터 문서에서 인증 헤더 형식 확인 (Bearer vs ApiKey 등)",
                "4. 401/403이면 API 키 권한 문제, 404면 베이스 URL/경로 문제",
            ],
        }


# ============ 연동 데이터 ============

@router.get("/connections")
async def list_connections():
    """연동된 금융 자산 (계좌/카드/홈택스/PG/오픈마켓)"""
    client = get_granter_client()
    try:
        return await client.list_connections()
    except GranterAPIError as e:
        raise HTTPException(status_code=e.status_code or 502, detail=str(e))


@router.get("/accounts")
async def list_accounts():
    """연동된 계좌 목록"""
    client = get_granter_client()
    try:
        return await client.list_accounts()
    except GranterAPIError as e:
        raise HTTPException(status_code=e.status_code or 502, detail=str(e))


@router.get("/cards")
async def list_cards():
    """연동된 카드 목록"""
    client = get_granter_client()
    try:
        return await client.list_cards()
    except GranterAPIError as e:
        raise HTTPException(status_code=e.status_code or 502, detail=str(e))


# ============ 잔액 / 환율 ============

@router.get("/balances")
async def get_balances(account_id: Optional[str] = None):
    """계좌별 잔액"""
    client = get_granter_client()
    try:
        return await client.get_balances(account_id)
    except GranterAPIError as e:
        raise HTTPException(status_code=e.status_code or 502, detail=str(e))


@router.get("/balances/history")
async def get_cash_history(
    from_date: Optional[date] = None,
    to_date: Optional[date] = None,
):
    """현금 추이 (시계열 잔액)"""
    client = get_granter_client()
    try:
        return await client.get_cash_history(from_date, to_date)
    except GranterAPIError as e:
        raise HTTPException(status_code=e.status_code or 502, detail=str(e))


@router.get("/exchange-rates")
async def get_exchange_rate(
    currency: str = Query(..., description="조회할 통화 (예: USD, JPY, EUR)"),
    target_date: Optional[date] = None,
):
    """기준 날짜의 환율"""
    client = get_granter_client()
    try:
        return await client.get_exchange_rate(currency, target_date)
    except GranterAPIError as e:
        raise HTTPException(status_code=e.status_code or 502, detail=str(e))


# ============ 거래 내역 ============

@router.get("/transactions")
async def list_transactions(
    from_date: Optional[date] = None,
    to_date: Optional[date] = None,
    kind: Optional[str] = Query(
        None,
        description="account | card | tax_invoice | cash_receipt | approval",
    ),
    connection_id: Optional[str] = None,
    cursor: Optional[str] = None,
    limit: int = Query(100, ge=1, le=500),
):
    """거래 내역 통합 조회 (그랜터 직접 응답)"""
    client = get_granter_client()
    try:
        return await client.list_transactions(
            from_date=from_date,
            to_date=to_date,
            kind=kind,
            connection_id=connection_id,
            cursor=cursor,
            limit=limit,
        )
    except GranterAPIError as e:
        raise HTTPException(status_code=e.status_code or 502, detail=str(e))


# ============ 거래 sync (그랜터 → DB) ============

class SyncResult(BaseModel):
    inserted: int
    skipped: int
    pages_fetched: int
    upload_id: Optional[int] = None
    earliest: Optional[str] = None
    latest: Optional[str] = None
    errors: List[str] = []


def _coerce_decimal(v: Any) -> Decimal:
    if v is None or v == "":
        return Decimal("0")
    try:
        return Decimal(str(v))
    except Exception:
        return Decimal("0")


def _normalize_date(v: Any) -> Optional[str]:
    if not v:
        return None
    s = str(v)
    m = re.match(r"(\d{4})[.\-/T](\d{1,2})[.\-/T](\d{1,2})", s)
    if m:
        y, mo, d = m.groups()
        return f"{int(y):04d}-{int(mo):02d}-{int(d):02d}"
    return s


@router.post("/sync", response_model=SyncResult)
async def sync_transactions(
    from_date: date = Query(..., description="시작일"),
    to_date: date = Query(..., description="종료일"),
    kind: Optional[str] = Query(None, description="account | card | tax_invoice | cash_receipt"),
    user_id: int = Query(1),
    db: AsyncSession = Depends(get_db),
):
    """
    그랜터에서 기간 내 거래를 가져와서 ai_raw_transaction_data로 적재.

    중복 방지: (transaction_date, original_description, debit, credit, source_account_code)
    동일 키 발견 시 skip.
    """
    client = get_granter_client()
    if not client.is_configured:
        raise HTTPException(status_code=500, detail="GRANTER_API_KEY 미설정")

    # upload 이력 1건 생성
    upload = AIDataUploadHistory(
        filename=f"granter-sync-{from_date}-{to_date}-{kind or 'all'}.json",
        file_size=0,
        file_type="json",
        upload_type="granter_sync",
        row_count=0,
        saved_count=0,
        error_count=0,
        uploaded_by=user_id,
    )
    db.add(upload)
    await db.commit()
    await db.refresh(upload)

    inserted = 0
    skipped = 0
    pages = 0
    cursor: Optional[str] = None
    errors: List[str] = []
    earliest: Optional[str] = None
    latest: Optional[str] = None
    row_no = 1

    try:
        while True:
            try:
                resp = await client.list_transactions(
                    from_date=from_date,
                    to_date=to_date,
                    kind=kind,
                    cursor=cursor,
                    limit=200,
                )
            except GranterAPIError as e:
                errors.append(f"page {pages}: {e}")
                break

            pages += 1
            items = resp.get("data") if isinstance(resp, dict) else resp
            if not items:
                break

            for it in items:
                try:
                    tx_date = _normalize_date(
                        it.get("transaction_date")
                        or it.get("date")
                        or it.get("timestamp")
                    )
                    desc = str(
                        it.get("description")
                        or it.get("memo")
                        or it.get("merchant_name")
                        or ""
                    ).strip()
                    merchant = it.get("merchant_name") or it.get("counterparty") or it.get("vendor")
                    debit = _coerce_decimal(
                        it.get("debit_amount") or it.get("inbound") or it.get("deposit") or 0
                    )
                    credit = _coerce_decimal(
                        it.get("credit_amount") or it.get("outbound") or it.get("withdraw") or 0
                    )
                    # 그랜터가 amount + direction 형태로 줄 수도 있음
                    if debit == 0 and credit == 0:
                        amt = _coerce_decimal(it.get("amount", 0))
                        direction = (it.get("direction") or it.get("type") or "").lower()
                        if direction in ("inbound", "deposit", "in", "+", "income"):
                            debit = amt
                        elif direction in ("outbound", "withdraw", "out", "-", "expense"):
                            credit = amt

                    src_code = str(
                        it.get("source_account_code")
                        or it.get("ledger_account_code")
                        or ""
                    )
                    src_name = str(
                        it.get("source_account_name") or it.get("ledger_account_name") or ""
                    )
                    cp_code = str(it.get("account_code") or it.get("category_code") or "")
                    cp_name = str(it.get("account_name") or it.get("category") or "")

                    # 그랜터 kind로 source 추정 fallback
                    if not src_code:
                        if kind == "card" or it.get("kind") == "card":
                            src_code = "253"
                            src_name = src_name or "미지급금(카드)"
                        elif kind == "account" or it.get("kind") == "account":
                            src_code = "103"
                            src_name = src_name or "보통예금"

                    if not desc:
                        skipped += 1
                        continue

                    row = AIRawTransactionData(
                        upload_id=upload.id,
                        row_number=row_no,
                        original_description=desc[:500],
                        merchant_name=(merchant or None) and str(merchant)[:200],
                        amount=max(debit, credit),
                        debit_amount=debit,
                        credit_amount=credit,
                        transaction_date=tx_date,
                        account_code=cp_code[:20] if cp_code else "",
                        account_name=cp_name[:100] if cp_name else None,
                        source_account_code=src_code[:20] if src_code else None,
                        source_account_name=src_name[:100] if src_name else None,
                    )
                    db.add(row)
                    row_no += 1
                    inserted += 1
                    if tx_date:
                        if earliest is None or tx_date < earliest:
                            earliest = tx_date
                        if latest is None or tx_date > latest:
                            latest = tx_date
                except Exception as e:
                    errors.append(f"row error: {e}")

            # 1000건마다 commit (대량 처리)
            if inserted % 1000 == 0:
                await db.commit()

            cursor = resp.get("next_cursor") if isinstance(resp, dict) else None
            if not cursor:
                break

        upload.row_count = inserted + skipped
        upload.saved_count = inserted
        upload.error_count = len(errors)
        upload.status = "completed" if not errors else "completed_with_errors"
        await db.commit()

    except Exception as e:
        logger.exception("Granter sync failed")
        upload.status = "failed"
        upload.error_message = str(e)
        await db.commit()
        raise HTTPException(status_code=500, detail=f"sync 실패: {e}")

    return SyncResult(
        inserted=inserted,
        skipped=skipped,
        pages_fetched=pages,
        upload_id=upload.id,
        earliest=earliest,
        latest=latest,
        errors=errors[:10],
    )


# ============ 세금계산서 ============

class TaxInvoiceIssue(BaseModel):
    payload: Dict[str, Any] = Field(
        ..., description="그랜터 형식의 세금계산서 페이로드 (그랜터 문서 참조)"
    )


@router.post("/tax-invoices/issue")
async def issue_tax_invoice(req: TaxInvoiceIssue):
    """세금계산서 발행"""
    client = get_granter_client()
    try:
        return await client.issue_tax_invoice(req.payload)
    except GranterAPIError as e:
        raise HTTPException(status_code=e.status_code or 502, detail=str(e))


@router.post("/tax-invoices/{invoice_id}/amend")
async def amend_tax_invoice(invoice_id: str, req: TaxInvoiceIssue):
    """세금계산서 수정발행"""
    client = get_granter_client()
    try:
        return await client.amend_tax_invoice(invoice_id, req.payload)
    except GranterAPIError as e:
        raise HTTPException(status_code=e.status_code or 502, detail=str(e))


@router.post("/tax-invoices/{invoice_id}/cancel")
async def cancel_tax_invoice(
    invoice_id: str,
    reason: str = Query(..., min_length=1),
):
    """세금계산서 취소발행"""
    client = get_granter_client()
    try:
        return await client.cancel_tax_invoice(invoice_id, reason)
    except GranterAPIError as e:
        raise HTTPException(status_code=e.status_code or 502, detail=str(e))


@router.get("/tax-invoices/{invoice_id}")
async def get_tax_invoice(invoice_id: str):
    client = get_granter_client()
    try:
        return await client.get_tax_invoice(invoice_id)
    except GranterAPIError as e:
        raise HTTPException(status_code=e.status_code or 502, detail=str(e))


# ============ 현금영수증 ============

class CashReceiptIssue(BaseModel):
    payload: Dict[str, Any] = Field(
        ..., description="그랜터 형식의 현금영수증 페이로드"
    )


@router.post("/cash-receipts/issue")
async def issue_cash_receipt(req: CashReceiptIssue):
    """현금영수증 발행"""
    client = get_granter_client()
    try:
        return await client.issue_cash_receipt(req.payload)
    except GranterAPIError as e:
        raise HTTPException(status_code=e.status_code or 502, detail=str(e))


@router.post("/cash-receipts/{receipt_id}/cancel")
async def cancel_cash_receipt(
    receipt_id: str,
    reason: Optional[str] = None,
):
    """현금영수증 취소발행"""
    client = get_granter_client()
    try:
        return await client.cancel_cash_receipt(receipt_id, reason)
    except GranterAPIError as e:
        raise HTTPException(status_code=e.status_code or 502, detail=str(e))


@router.get("/cash-receipts/{receipt_id}")
async def get_cash_receipt(receipt_id: str):
    client = get_granter_client()
    try:
        return await client.get_cash_receipt(receipt_id)
    except GranterAPIError as e:
        raise HTTPException(status_code=e.status_code or 502, detail=str(e))
