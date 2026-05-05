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
async def list_all_assets(only_active: bool = True):
    """
    모든 자산 타입을 한 번에 병렬 호출.
    only_active=True (default): 활성 + 미숨김 + 비휴면 자산만, 홈택스는 인증서 만료 안 된 것만.
    """
    client = get_granter_client()
    try:
        return await client.list_all_assets(only_active=only_active)
    except GranterAPIError as e:
        raise _err(e)


@router.get("/asset-debug")
async def asset_debug(
    account_number: Optional[str] = Query(None, description="계좌번호(부분 일치)"),
    card_number: Optional[str] = Query(None, description="카드번호(부분 일치)"),
    asset_id: Optional[int] = Query(None, description="자산 ID 직접 지정"),
    include_inactive: bool = Query(True, description="비활성 자산 포함"),
):
    """
    특정 자산의 그랜터 raw 응답 + 분석.
    계좌번호/카드번호/asset_id 중 하나로 필터.
    잔액이 의심스러운 계좌의 정체 확인용.
    """
    client = get_granter_client()
    if not client.is_configured:
        raise HTTPException(status_code=500, detail="GRANTER_API_KEY 미설정")

    only_active = not include_inactive
    try:
        all_assets = await client.list_all_assets(only_active=only_active)
    except GranterAPIError as e:
        raise _err(e)

    matched = []
    for asset_type, items in all_assets.items():
        if not isinstance(items, list):
            continue
        for item in items:
            ba = item.get('bankAccount') or {}
            card = item.get('card') or {}
            number_in_asset = str(item.get('number') or '')
            account_no = str(ba.get('accountNumber') or '')
            card_no = number_in_asset

            hit = False
            if asset_id and item.get('id') == asset_id:
                hit = True
            if account_number and account_number.replace('-', '') in account_no.replace('-', ''):
                hit = True
            if card_number and card_number in card_no:
                hit = True
            if not hit:
                continue

            # 분석
            currency = ba.get('currencyCode') or 'KRW'
            account_balance = ba.get('accountBalance')
            original_balance = ba.get('originalBalance')

            analysis: Dict[str, Any] = {
                "currency": currency,
                "is_krw": str(currency).upper() == "KRW",
                "active_status": {
                    "isActive": item.get('isActive'),
                    "isHidden": item.get('isHidden'),
                    "isDormant": item.get('isDormant'),
                    "isPossibleDormant": item.get('isPossibleDormant'),
                    "shown_in_unified": (
                        bool(item.get('isActive')) and
                        not item.get('isHidden') and
                        not item.get('isDormant')
                    ),
                },
                "balance_fields": {
                    "accountBalance": account_balance,
                    "originalBalance": original_balance,
                    "are_equal": account_balance == original_balance,
                    "diff": (
                        (account_balance or 0) - (original_balance or 0)
                        if (account_balance is not None and original_balance is not None) else None
                    ),
                },
                "transaction_visible": ba.get('isTransactionVisible'),
                "card_amounts": (
                    {
                        "limitAmount": card.get('limitAmount'),
                        "usedAmount": card.get('usedAmount'),
                        "remainLimit": card.get('remainLimit'),
                    } if card else None
                ),
                "interpretation_hint": (
                    "외화 계좌입니다. accountBalance는 원화 환산값일 수 있고, originalBalance는 원본 통화 금액입니다."
                    if str(currency).upper() != "KRW"
                    else "원화 계좌입니다. 그랜터 표기 잔액이 실 잔액과 다르면, 그랜터 측 동기화 지연 또는 마이너스(차입성) 통장일 가능성이 있습니다."
                ),
            }

            matched.append({
                "asset_type": asset_type,
                "id": item.get('id'),
                "name": item.get('name'),
                "nickname": item.get('nickname'),
                "organization": item.get('organization'),
                "organizationName": item.get('organizationName'),
                "number": item.get('number'),
                "createdAt": item.get('createdAt'),
                "modifiedAt": item.get('modifiedAt'),
                "analysis": analysis,
                "raw": item,  # 전체 raw 데이터
            })

    if not matched:
        return {
            "matched": [],
            "hint": "조건에 맞는 자산을 찾지 못했습니다. include_inactive=true로 다시 시도하세요.",
        }

    return {
        "matched_count": len(matched),
        "matched": matched,
    }


@router.get("/recent-activity-period")
async def recent_activity_period(
    asset_id: Optional[int] = Query(None),
    max_lookback_months: int = Query(12, ge=1, le=24),
):
    """
    최근 거래가 있는 31일 구간을 자동 탐색.
    오늘부터 31일씩 거꾸로 가면서 첫 거래가 발견되는 구간 반환.

    Returns: { "start": "yyyy-MM-dd", "end": "yyyy-MM-dd", "count": N, "lookback_months": M }
    """
    from datetime import date, timedelta
    client = get_granter_client()
    if not client.is_configured:
        raise HTTPException(status_code=500, detail="GRANTER_API_KEY 미설정")

    today = date.today()
    ticket_types = ["EXPENSE_TICKET", "BANK_TRANSACTION_TICKET", "TAX_INVOICE_TICKET", "CASH_RECEIPT_TICKET"]

    for offset in range(0, max_lookback_months):
        end = today - timedelta(days=offset * 31)
        start = end - timedelta(days=31)
        # 자산 지정이면 그 자산이 속한 타입만 우선 시도, 아니면 모든 타입
        types_to_try = ticket_types
        for tt in types_to_try:
            payload = {
                "ticketType": tt,
                "startDate": start.strftime('%Y-%m-%d'),
                "endDate": end.strftime('%Y-%m-%d'),
            }
            if asset_id is not None:
                payload["assetId"] = asset_id
            try:
                r = await client.list_tickets(payload)
                items = r if isinstance(r, list) else (r.get("data", []) if isinstance(r, dict) else [])
                if items:
                    return {
                        "start": start.isoformat(),
                        "end": end.isoformat(),
                        "count": len(items),
                        "found_in_ticket_type": tt,
                        "months_back": offset,
                    }
            except GranterAPIError:
                continue

    return {"start": None, "end": None, "count": 0, "lookback_months": max_lookback_months}


@router.post("/tickets/all")
async def list_tickets_all_types(
    start_date: str = Query(..., description="yyyy-MM-dd"),
    end_date: str = Query(..., description="yyyy-MM-dd"),
    asset_id: Optional[int] = Query(None),
):
    """
    모든 ticketType을 병렬 호출해 합쳐서 반환.
    EXPENSE_TICKET / BANK_TRANSACTION_TICKET / TAX_INVOICE_TICKET / CASH_RECEIPT_TICKET
    그랜터 31일 제한 — 클라이언트에서 31일 이하 구간으로 호출.
    """
    client = get_granter_client()
    try:
        return await client.list_tickets_all_types(start_date, end_date, asset_id)
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
