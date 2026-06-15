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


@router.post("/cache/clear")
async def granter_cache_clear():
    """그랜터 메모리 캐시 강제 무효화 — 빈 응답 고착 회복용"""
    client = get_granter_client()
    cleared = client.clear_cache()
    return {"ok": True, "cleared_entries": cleared}


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


@router.get("/diag-tickets")
async def diag_tickets(
    start_date: str = Query(..., description="yyyy-MM-dd"),
    end_date: str = Query(..., description="yyyy-MM-dd"),
):
    """
    모든 ticketType별 그랜터 응답 건수 + 샘플 (어느 타입에 데이터 있는지 즉시 확인).
    세금계산서/현금영수증 조회 안 될 때 사용.
    """
    client = get_granter_client()
    if not client.is_configured:
        raise HTTPException(status_code=500, detail="GRANTER_API_KEY 미설정")

    types = [
        "EXPENSE_TICKET",
        "BANK_TRANSACTION_TICKET",
        "TAX_INVOICE_TICKET",
        "CASH_RECEIPT_TICKET",
        "WORKFLOW",
        "MERCHANT_CARD_TRANSACTION_TICKET",
        "ECOMMERCE_SETTLEMENT",
        "PG_SETTLEMENT",
        "SALARY_HISTORY",
        "MANUAL_TRANSACTION_TICKET",
    ]

    results = {}
    for t in types:
        try:
            r = await client.list_tickets({
                "ticketType": t,
                "startDate": start_date,
                "endDate": end_date,
            })
            items = r if isinstance(r, list) else (r.get("data", []) if isinstance(r, dict) else [])
            results[t] = {
                "count": len(items),
                "sample_keys": list(items[0].keys()) if items else None,
                "sample_first": items[0] if items else None,
            }
        except GranterAPIError as e:
            results[t] = {"error": str(e)[:200], "status_code": e.status_code}

    return {
        "period": {"start": start_date, "end": end_date},
        "ticket_types": results,
        "hint": "count > 0인 타입은 데이터 존재. 모두 0이면 그랜터에 해당 자산 미연동 또는 기간 외 데이터.",
    }


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


def _slim_ticket(t: Dict[str, Any]) -> Dict[str, Any]:
    """
    캐시플로우 패턴 분석에 필요한 핵심 필드만 추출.
    원본 ticket은 카드사 raw response, 첨부, 메시지 등 무거운 필드를 포함하므로
    6개월치를 그대로 보내면 응답이 수백 MB가 된다 → slim으로 ~5MB 수준으로 축소.

    유지 필드 (frontend의 extractContact + filterOutInternalTransfers + analyzeContactPatterns가 사용하는 것 전부):
    - id, ticketType, transactionType, amount, transactAt, createdAt
    - contact (그랜터 직접 입력값)
    - bankTransaction.{counterparty, content, counterpartyAccountNumber, opponent, opponentAccountNumber, counterpartyName}
    - cardUsage.{storeName}
    - taxInvoice.{contractor, supplier} 의 companyName + registrationNumber/businessNumber
    - cashReceipt.issuer.companyName
    """
    out: Dict[str, Any] = {
        "id": t.get("id"),
        "ticketType": t.get("ticketType"),
        "transactionType": t.get("transactionType"),
        "amount": t.get("amount"),
        "transactAt": t.get("transactAt"),
        "createdAt": t.get("createdAt"),
        "contact": t.get("contact"),
    }
    bt = t.get("bankTransaction")
    if isinstance(bt, dict):
        out["bankTransaction"] = {
            "counterparty": bt.get("counterparty"),
            "content": bt.get("content"),
            "counterpartyAccountNumber": bt.get("counterpartyAccountNumber"),
            "opponent": bt.get("opponent"),
            "opponentAccountNumber": bt.get("opponentAccountNumber"),
            "counterpartyName": bt.get("counterpartyName"),
        }
    cu = t.get("cardUsage")
    if isinstance(cu, dict):
        out["cardUsage"] = {"storeName": cu.get("storeName")}
    ti = t.get("taxInvoice")
    if isinstance(ti, dict):
        def _slim_party(p: Any) -> Dict[str, Any]:
            if not isinstance(p, dict):
                return {}
            return {
                "companyName": p.get("companyName"),
                "registrationNumber": p.get("registrationNumber"),
                "businessNumber": p.get("businessNumber"),
            }
        out["taxInvoice"] = {
            "contractor": _slim_party(ti.get("contractor")),
            "supplier": _slim_party(ti.get("supplier")),
        }
    cr = t.get("cashReceipt")
    if isinstance(cr, dict):
        issuer = cr.get("issuer") if isinstance(cr.get("issuer"), dict) else {}
        out["cashReceipt"] = {"issuer": {"companyName": issuer.get("companyName")}}
    return out


@router.get("/tickets/extended")
async def list_tickets_extended(
    months: int = Query(6, ge=1, le=12),
    slim: bool = Query(False, description="패턴 분석용 핵심 필드만 반환 (응답 크기 ~98% 축소)"),
):
    """
    지난 N개월(default 6) 거래 데이터를 31일씩 분할 호출 후 합쳐서 반환.
    캐시플로우 예측 등 장기 패턴 분석용. semaphore가 동시 호출 1로 직렬화.

    slim=true: 거래처/금액/날짜/방향 등 패턴 분석에 필요한 필드만 (raw 카드사 응답·첨부·메시지 제외).
    응답: { EXPENSE_TICKET: [...], BANK_TRANSACTION_TICKET: [...], TAX_INVOICE_TICKET: [...], CASH_RECEIPT_TICKET: [...] }
    """
    from datetime import date, timedelta

    client = get_granter_client()
    if not client.is_configured:
        raise HTTPException(status_code=500, detail="GRANTER_API_KEY 미설정")

    today = date.today()
    chunks = []
    cursor = today
    for _ in range(months):
        chunk_end = cursor
        chunk_start = chunk_end - timedelta(days=30)
        chunks.append((chunk_start.isoformat(), chunk_end.isoformat()))
        cursor = chunk_start - timedelta(days=1)

    # 각 chunk마다 list_tickets_all_types 호출 (semaphore가 동시성 제어)
    merged: Dict[str, list] = {
        "EXPENSE_TICKET": [],
        "BANK_TRANSACTION_TICKET": [],
        "TAX_INVOICE_TICKET": [],
        "CASH_RECEIPT_TICKET": [],
    }
    seen_ids: Dict[str, set] = {k: set() for k in merged}

    for start, end in chunks:
        try:
            chunk_result = await client.list_tickets_all_types(start, end)
            for ticket_type, items in chunk_result.items():
                if not isinstance(items, list):
                    continue
                bucket = merged.setdefault(ticket_type, [])
                ids = seen_ids.setdefault(ticket_type, set())
                for t in items:
                    tid = t.get("id") if isinstance(t, dict) else None
                    if tid is not None and tid in ids:
                        continue
                    if tid is not None:
                        ids.add(tid)
                    bucket.append(_slim_ticket(t) if slim else t)
        except GranterAPIError as e:
            logger.warning("tickets/extended chunk %s~%s failed: %s", start, end, e)

    return merged


@router.post("/tickets/all")
async def list_tickets_all_types(
    start_date: str = Query(..., description="yyyy-MM-dd"),
    end_date: str = Query(..., description="yyyy-MM-dd"),
    asset_id: Optional[int] = Query(None),
    slim: bool = Query(False, description="패턴 분석용 핵심 필드만 (응답 ~90% 축소)"),
):
    """
    모든 ticketType을 병렬 호출해 합쳐서 반환.
    EXPENSE_TICKET / BANK_TRANSACTION_TICKET / TAX_INVOICE_TICKET / CASH_RECEIPT_TICKET
    그랜터 31일 제한 — 클라이언트에서 31일 이하 구간으로 호출.

    slim=true: 거래처/금액/날짜/방향 등 패턴 분석 필요 필드만 반환.
    """
    client = get_granter_client()
    try:
        result = await client.list_tickets_all_types(start_date, end_date, asset_id)
        if slim:
            slimmed: Dict[str, list] = {}
            for ticket_type, items in result.items():
                if isinstance(items, list):
                    slimmed[ticket_type] = [_slim_ticket(t) if isinstance(t, dict) else t for t in items]
                else:
                    slimmed[ticket_type] = items
            return slimmed
        return result
    except GranterAPIError as e:
        raise _err(e)


# ============ 거래 (tickets) ============

@router.post("/tickets")
async def list_tickets(payload: Dict[str, Any] = Body(default_factory=dict)):
    """
    카드·계좌·세금계산서·현금영수증·결재 등 모든 거래/증빙 통합 조회.
    그랜터 31일 한도 자동 우회 — startDate/endDate 차이가 31일 초과면 31일씩 분할 호출 후 합침.

    예시 payload:
    {
      "ticketType": "TAX_INVOICE_TICKET",
      "startDate": "2026-04-01",
      "endDate": "2026-04-30"
    }
    """
    from datetime import date as _date, timedelta

    client = get_granter_client()

    # 자동 분할 (startDate/endDate 명시 + 31일 초과 시)
    sd_str = payload.get("startDate")
    ed_str = payload.get("endDate")
    if sd_str and ed_str:
        try:
            sd = _date.fromisoformat(sd_str)
            ed = _date.fromisoformat(ed_str)
            span = (ed - sd).days + 1
        except Exception:
            sd = ed = None
            span = 0

        if sd and ed and span > 31:
            chunks = []
            cursor_end = ed
            while cursor_end >= sd:
                cursor_start = max(sd, cursor_end - timedelta(days=30))
                chunks.append((cursor_start.isoformat(), cursor_end.isoformat()))
                cursor_end = cursor_start - timedelta(days=1)

            merged: list = []
            seen_ids: set = set()
            for s, e in chunks:
                chunk_payload = dict(payload)
                chunk_payload["startDate"] = s
                chunk_payload["endDate"] = e
                try:
                    r = await client.list_tickets(chunk_payload)
                    items = r if isinstance(r, list) else (r.get("data", []) if isinstance(r, dict) else [])
                    for t in items:
                        tid = t.get("id") if isinstance(t, dict) else None
                        if tid is not None and tid in seen_ids:
                            continue
                        if tid is not None:
                            seen_ids.add(tid)
                        merged.append(t)
                except GranterAPIError as ex:
                    logger.warning("list_tickets chunk %s~%s failed: %s", s, e, ex)
            logger.info("list_tickets auto-split %d chunks → %d items", len(chunks), len(merged))
            return merged

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


# ============ 거래처 풀 (지난 N개월 세금계산서에서 거래처 정보 추출) ============

@router.get("/contractors-pool")
async def get_contractors_pool(months: int = Query(12, ge=1, le=24)):
    """
    지난 N개월(default 12) 세금계산서 데이터에서 거래처(contractor + supplier) 풀 구성.
    그랜터 31일 한도 때문에 31일씩 분할 호출.
    각 거래처 정보: 사업자번호 / 회사명 / 대표자 / 주소 / 이메일 + 등장 빈도

    응답: { count: int, contractors: [{businessNumber, companyName, ...}, ...] }
    """
    import asyncio
    from datetime import date, timedelta

    client = get_granter_client()
    if not client.is_configured:
        raise HTTPException(status_code=500, detail="GRANTER_API_KEY 미설정")

    today = date.today()
    chunks = []
    cursor = today
    for _ in range(months):
        chunk_end = cursor
        chunk_start = chunk_end - timedelta(days=30)
        chunks.append((chunk_start.isoformat(), chunk_end.isoformat()))
        cursor = chunk_start - timedelta(days=1)

    async def _fetch_chunk(start: str, end: str):
        try:
            return await client.list_tickets({
                "ticketType": "TAX_INVOICE_TICKET",
                "startDate": start,
                "endDate": end,
            })
        except GranterAPIError as e:
            logger.warning("contractors-pool chunk %s~%s failed: %s", start, end, e)
            return []

    # 그랜터 rate limit 보호: 3개씩 batch로 순차 처리
    BATCH_SIZE = 3
    results: list = []
    for i in range(0, len(chunks), BATCH_SIZE):
        batch = chunks[i:i + BATCH_SIZE]
        batch_results = await asyncio.gather(*[_fetch_chunk(s, e) for s, e in batch])
        results.extend(batch_results)

    # 그랜터 TaxInvoiceUser 실제 필드명 (가이드 line 753~786 기준):
    #   registrationNumber=사업자등록번호, companyName=회사명, ceoName=대표자명, name=담당자명,
    #   businessTypes=업태, businessItems=종목, businessPlace=사업장주소,
    #   email=이메일, email2=보조이메일, phone=휴대전화, tel=전화번호
    def _g(c: Dict[str, Any], *keys: str) -> str:
        """첫 번째 비어있지 않은 값을 문자열로 반환"""
        for k in keys:
            v = c.get(k)
            if v:
                s = str(v).strip()
                if s:
                    return s
        return ""

    pool: Dict[str, Dict[str, Any]] = {}
    for r in results:
        items = r if isinstance(r, list) else (r.get("data", []) if isinstance(r, dict) else [])
        for t in items:
            ti = t.get("taxInvoice") if isinstance(t, dict) else None
            if not ti:
                continue
            for c in (ti.get("contractor"), ti.get("supplier")):
                if not isinstance(c, dict):
                    continue
                # 사업자번호 (registrationNumber 우선, businessNumber 폴백)
                bn = _g(c, "registrationNumber", "businessNumber")
                name = _g(c, "companyName", "name")
                if not bn and not name:
                    continue
                # 본인 회사(503-87-01038) 제외
                bn_digits = "".join(filter(str.isdigit, bn))
                if bn_digits == "5038701038":
                    continue
                key = bn or name
                cur = pool.get(key)
                if cur is None:
                    cur = {
                        "businessNumber": bn,
                        "companyName": name,
                        "representativeName": _g(c, "ceoName", "representativeName"),
                        "address": _g(c, "businessPlace", "address"),
                        "email": _g(c, "email", "email2"),
                        "phone": _g(c, "phone", "tel", "phoneNumber"),
                        "businessType": _g(c, "businessTypes", "businessType"),
                        "businessItem": _g(c, "businessItems", "businessItem"),
                        "contactName": _g(c, "name"),  # 담당자명
                        "count": 0,
                    }
                    pool[key] = cur
                cur["count"] += 1
                # 빈 필드는 신규 ticket에서 보강
                if not cur["representativeName"]:
                    cur["representativeName"] = _g(c, "ceoName", "representativeName")
                if not cur["address"]:
                    cur["address"] = _g(c, "businessPlace", "address")
                if not cur["email"]:
                    cur["email"] = _g(c, "email", "email2")
                if not cur["phone"]:
                    cur["phone"] = _g(c, "phone", "tel", "phoneNumber")
                if not cur["businessType"]:
                    cur["businessType"] = _g(c, "businessTypes", "businessType")
                if not cur["businessItem"]:
                    cur["businessItem"] = _g(c, "businessItems", "businessItem")
                if not cur["contactName"]:
                    cur["contactName"] = _g(c, "name")

    contractors = sorted(pool.values(), key=lambda x: -x["count"])
    return {"count": len(contractors), "months": months, "contractors": contractors}
