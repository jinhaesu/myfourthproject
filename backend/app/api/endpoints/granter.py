"""
Granter Public API 라우터
공식 가이드(granter-public-api): https://app.granter.biz/api/public-docs/

주요 엔드포인트:
- /granter/tickets : 거래(카드·계좌·세금계산서·현금영수증) 통합 조회
- /granter/assets : 연동 자산
- /granter/balances : 잔액 시계열
- /granter/daily-report : 일일 재무 리포트
- /granter/exchange-rates : 환율
- /granter/tax-invoices/issue|modify|cancel : 세금계산서 발행/수정/취소
- /granter/cash-receipts/issue|cancel : 현금영수증 발행/취소
- /granter/tags, /granter/categories : 분류 기준
"""
import logging
from typing import Optional, Dict, Any
from fastapi import APIRouter, Body, HTTPException, Query
from pydantic import BaseModel

from app.services.granter_client import get_granter_client, GranterAPIError

logger = logging.getLogger(__name__)
router = APIRouter()


def _err(e: GranterAPIError):
    return HTTPException(status_code=e.status_code or 502, detail={"error": str(e), "body": e.body})


# ============ 진단 ============

@router.get("/health")
async def granter_health():
    client = get_granter_client()
    masked = (client.api_key[:8] + "...") if client.api_key else ""
    return {
        "configured": client.is_configured,
        "base_url": client.base_url,
        "masked_api_key": masked,
        "auth_method": "HTTP Basic (BASE64(API_KEY:))",
    }


@router.get("/ping")
async def granter_ping():
    """간단한 호출 — BANK_ACCOUNT 자산 조회로 인증 확인"""
    client = get_granter_client()
    try:
        result = await client.list_assets({"assetType": "BANK_ACCOUNT"})
        count = len(result) if isinstance(result, list) else "unknown"
        return {"ok": True, "base_url": client.base_url, "bank_assets_count": count}
    except GranterAPIError as e:
        return {
            "ok": False,
            "base_url": client.base_url,
            "status_code": e.status_code,
            "error": str(e)[:300],
            "response_body": e.body,
        }


@router.get("/assets/all")
async def list_all_assets():
    """모든 자산 타입을 한 번에 (CARD/BANK/HOME_TAX 등 병렬 호출)"""
    client = get_granter_client()
    try:
        return await client.list_all_assets()
    except GranterAPIError as e:
        raise _err(e)


# ============ 거래 (tickets) ============

@router.post("/tickets")
async def list_tickets(payload: Dict[str, Any] = Body(default_factory=dict)):
    """
    카드·계좌·세금계산서·현금영수증·결재 등 모든 거래/증빙 통합 조회.

    예시 payload:
    {
      "fromDate": "2026-04-01",
      "toDate": "2026-04-30",
      "ticketTypes": ["CARD_TICKET","BANK_TICKET","TAX_INVOICE_TICKET","CASH_RECEIPT_TICKET"],
      "limit": 100
    }
    실제 필드는 그랜터 가이드의 Request Fields 참조.
    """
    client = get_granter_client()
    try:
        return await client.list_tickets(payload)
    except GranterAPIError as e:
        raise _err(e)


@router.post("/tickets/bulk-update")
async def bulk_update_tickets(payload: Dict[str, Any] = Body(...)):
    """거래 일괄 수정 (분류/태그/메모)"""
    client = get_granter_client()
    try:
        return await client.bulk_update_tickets(payload)
    except GranterAPIError as e:
        raise _err(e)


# ============ 자산 (assets) ============

@router.post("/assets")
async def list_assets(payload: Dict[str, Any] = Body(default_factory=dict)):
    """
    연동 자산 목록 (카드/계좌/홈택스/PG/오픈마켓).

    예시: {"assetType": "BANK_ACCOUNT"} 또는 {"assetType": "CARD"} 등.
    """
    client = get_granter_client()
    try:
        return await client.list_assets(payload)
    except GranterAPIError as e:
        raise _err(e)


# ============ 잔액 / 일일 리포트 / 환율 ============

@router.post("/balances")
async def list_balances(payload: Dict[str, Any] = Body(...)):
    """계좌별 잔액 시계열"""
    client = get_granter_client()
    try:
        return await client.list_balances(payload)
    except GranterAPIError as e:
        raise _err(e)


@router.post("/daily-report")
async def get_daily_report(payload: Dict[str, Any] = Body(...)):
    """일일 재무 리포트"""
    client = get_granter_client()
    try:
        return await client.get_daily_financial_report(payload)
    except GranterAPIError as e:
        raise _err(e)


@router.post("/exchange-rates")
async def get_exchange_rates(payload: Dict[str, Any] = Body(...)):
    """환율"""
    client = get_granter_client()
    try:
        return await client.get_exchange_rates(payload)
    except GranterAPIError as e:
        raise _err(e)


# ============ 세금계산서 ============

@router.post("/tax-invoices/issue")
async def issue_tax_invoice(
    payload: Dict[str, Any] = Body(...),
    idempotency_key: Optional[str] = Query(None),
):
    """세금계산서 즉시발행/예약발행/반복발행"""
    client = get_granter_client()
    try:
        return await client.issue_tax_invoice(payload, idempotency_key=idempotency_key)
    except GranterAPIError as e:
        raise _err(e)


@router.post("/tax-invoices/modify")
async def modify_tax_invoice(
    payload: Dict[str, Any] = Body(...),
    idempotency_key: Optional[str] = Query(None),
):
    """세금계산서 수정발행"""
    client = get_granter_client()
    try:
        return await client.modify_tax_invoice(payload, idempotency_key=idempotency_key)
    except GranterAPIError as e:
        raise _err(e)


@router.post("/tax-invoices/cancel")
async def cancel_tax_invoice(
    payload: Dict[str, Any] = Body(...),
    idempotency_key: Optional[str] = Query(None),
):
    """세금계산서 취소발행"""
    client = get_granter_client()
    try:
        return await client.cancel_tax_invoice(payload, idempotency_key=idempotency_key)
    except GranterAPIError as e:
        raise _err(e)


# ============ 현금영수증 ============

@router.post("/cash-receipts/issue")
async def issue_cash_receipt(
    payload: Dict[str, Any] = Body(...),
    idempotency_key: Optional[str] = Query(None),
):
    """현금영수증 발행"""
    client = get_granter_client()
    try:
        return await client.issue_cash_receipt(payload, idempotency_key=idempotency_key)
    except GranterAPIError as e:
        raise _err(e)


@router.post("/cash-receipts/cancel")
async def cancel_cash_receipt(
    payload: Dict[str, Any] = Body(...),
    idempotency_key: Optional[str] = Query(None),
):
    """현금영수증 취소발행"""
    client = get_granter_client()
    try:
        return await client.cancel_cash_receipt(payload, idempotency_key=idempotency_key)
    except GranterAPIError as e:
        raise _err(e)


# ============ 분류 기준 (tags / categories) ============

@router.get("/tags")
async def list_tags():
    client = get_granter_client()
    try:
        return await client.list_tags()
    except GranterAPIError as e:
        raise _err(e)


@router.post("/tags")
async def create_tag(payload: Dict[str, Any] = Body(...)):
    client = get_granter_client()
    try:
        return await client.create_tag(payload)
    except GranterAPIError as e:
        raise _err(e)


@router.put("/tags")
async def update_tag(payload: Dict[str, Any] = Body(...)):
    client = get_granter_client()
    try:
        return await client.update_tag(payload)
    except GranterAPIError as e:
        raise _err(e)


@router.get("/tag-details")
async def list_tag_details():
    client = get_granter_client()
    try:
        return await client.list_tag_details()
    except GranterAPIError as e:
        raise _err(e)


@router.get("/categories")
async def list_categories():
    client = get_granter_client()
    try:
        return await client.list_categories()
    except GranterAPIError as e:
        raise _err(e)
