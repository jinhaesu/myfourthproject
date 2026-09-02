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
from fastapi import APIRouter, Body, HTTPException, Query, Depends
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.services.granter_client import get_granter_client, GranterAPIError

logger = logging.getLogger(__name__)
router = APIRouter()


def _err(e: GranterAPIError):
    return HTTPException(status_code=e.status_code or 502, detail={"error": str(e), "body": e.body})


# ============ 진단 ============

@router.get("/health")
async def granter_health(db: AsyncSession = Depends(get_db)):
    """데이터소스 상태 — 하이픈 단일소스로 전환됨(그랜터 미사용). 프론트 게이트는 하이픈 연동 여부로 판단."""
    from app.services import hyphen_sync_ext as _hy
    has_bank = await _hy.has_hyphen_bank(db)
    return {
        "configured": has_bank,   # 프론트 isConfigured 게이트 — 하이픈 계좌 연동 시 true
        "source": "hyphen",
        "granter_disabled": True,
    }


@router.get("/ping")
async def granter_ping(db: AsyncSession = Depends(get_db)):
    """상태 확인 — 하이픈 계좌 수."""
    from app.services import hyphen_sync_ext as _hy
    creds = await _hy._hyphen_bank_creds(db)
    return {"ok": True, "source": "hyphen", "bank_accounts": len(creds)}


@router.post("/cache/clear")
async def granter_cache_clear():
    """캐시 무효화 — 하이픈 전환으로 그랜터 캐시 없음(no-op)."""
    return {"ok": True, "cleared_entries": 0, "source": "hyphen"}


@router.get("/assets/all")
async def list_all_assets(only_active: bool = True, db: AsyncSession = Depends(get_db)):
    """
    자산목록 — 하이픈 단일소스(그랜터 미사용). 대시보드와 동일 계좌·잔액 기준으로 일체화.
    BANK_ACCOUNT=은행 credential(중복제거·refresh 잔액), CARD=등록 법인카드. 증권·홈택스·이커머스는 미제공.
    """
    from app.services import hyphen_sync_ext as _hy
    return await _hy.hyphen_assets_all(db)


@router.get("/diag-tickets")
async def diag_tickets(
    start_date: str = Query(..., description="yyyy-MM-dd"),
    end_date: str = Query(..., description="yyyy-MM-dd"),
    db: AsyncSession = Depends(get_db),
):
    """ticketType별 건수 — 하이픈 원장 기준(그랜터 미사용)."""
    results = {}
    for t in ("EXPENSE_TICKET", "BANK_TRANSACTION_TICKET", "TAX_INVOICE_TICKET", "CASH_RECEIPT_TICKET"):
        try:
            items = await _hyphen_tickets(db, t, start_date, end_date)
        except Exception:
            items = None
        results[t] = {"count": len(items) if items else 0}
    return {"period": {"start": start_date, "end": end_date}, "ticket_types": results, "source": "hyphen"}


@router.get("/asset-debug")
async def asset_debug(
    account_number: Optional[str] = Query(None),
    card_number: Optional[str] = Query(None),
    asset_id: Optional[int] = Query(None),
    include_inactive: bool = Query(True),
    db: AsyncSession = Depends(get_db),
):
    """자산 진단 — 그랜터 제거. 하이픈 계좌 진단은 /hyphen/cron/debug-accounts 사용."""
    from app.services import hyphen_sync_ext as _hy
    assets = await _hy.hyphen_assets_all(db)
    matched = []
    for a in assets.get("BANK_ACCOUNT", []):
        acct = str((a.get("bankAccount") or {}).get("accountNumber") or "")
        if account_number and account_number.replace("-", "") not in acct.replace("-", ""):
            continue
        matched.append(a)
    return {"matched_count": len(matched), "matched": matched, "source": "hyphen"}


@router.get("/recent-activity-period")
async def recent_activity_period(
    asset_id: Optional[int] = Query(None),
    max_lookback_months: int = Query(12, ge=1, le=24),
    db: AsyncSession = Depends(get_db),
):
    """최근 거래 31일 구간 — 하이픈 원장 기준 최신 거래일 중심."""
    from datetime import date, timedelta
    from app.models.hyphen_bank_tx import HyphenBankTx
    from sqlalchemy import select as _sel, func as _func
    latest = (await db.execute(_sel(_func.max(HyphenBankTx.tr_date)))).scalar()
    today = date.today()
    if latest and len(str(latest)) >= 8:
        d = str(latest).replace("-", "")
        end = date(int(d[0:4]), int(d[4:6]), int(d[6:8]))
    else:
        end = today
    start = end - timedelta(days=31)
    return {"start": start.isoformat(), "end": end.isoformat(), "count": 0, "source": "hyphen"}


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
    slim: bool = Query(False),
    db: AsyncSession = Depends(get_db),
):
    """지난 N개월 거래 — 하이픈 원장 단일소스(그랜터 미사용). DB 즉시 조회라 분할 불필요."""
    from datetime import date, timedelta
    end = date.today()
    start = end - timedelta(days=months * 31)
    merged: Dict[str, list] = {
        "EXPENSE_TICKET": await _hyphen_tickets(db, "EXPENSE_TICKET", start.isoformat(), end.isoformat()) or [],
        "BANK_TRANSACTION_TICKET": await _hyphen_tickets(db, "BANK_TRANSACTION_TICKET", start.isoformat(), end.isoformat()) or [],
        "TAX_INVOICE_TICKET": await _hyphen_tickets(db, "TAX_INVOICE_TICKET", start.isoformat(), end.isoformat()) or [],
        "CASH_RECEIPT_TICKET": await _hyphen_tickets(db, "CASH_RECEIPT_TICKET", start.isoformat(), end.isoformat()) or [],
    }
    if slim:
        return {k: [_slim_ticket(t) if isinstance(t, dict) else t for t in v] for k, v in merged.items()}
    return merged


@router.post("/tickets/all")
async def list_tickets_all_types(
    start_date: str = Query(..., description="yyyy-MM-dd"),
    end_date: str = Query(..., description="yyyy-MM-dd"),
    asset_id: Optional[int] = Query(None),
    slim: bool = Query(False, description="패턴 분석용 핵심 필드만 (응답 ~90% 축소)"),
    db: AsyncSession = Depends(get_db),
):
    """
    모든 ticketType을 합쳐서 반환.
    EXPENSE_TICKET / BANK_TRANSACTION_TICKET / TAX_INVOICE_TICKET(하이픈 원장 우선) + CASH_RECEIPT_TICKET(그랜터).
    자산 미지정(전사) 시 하이픈 원장 우선 — DB 즉시·API 최소화. 미커버 도메인은 그랜터 폴백.
    slim=true: 거래처/금액/날짜/방향 등 패턴 분석 필요 필드만 반환.
    """
    # 하이픈 단일소스(그랜터 미사용). 카드·통장·세금계산서·현금영수증 원장에서 그랜터 셰이프로 반환.
    merged: Dict[str, list] = {
        "EXPENSE_TICKET": await _hyphen_tickets(db, "EXPENSE_TICKET", start_date, end_date) or [],
        "BANK_TRANSACTION_TICKET": await _hyphen_tickets(db, "BANK_TRANSACTION_TICKET", start_date, end_date) or [],
        "TAX_INVOICE_TICKET": await _hyphen_tickets(db, "TAX_INVOICE_TICKET", start_date, end_date) or [],
        "CASH_RECEIPT_TICKET": await _hyphen_tickets(db, "CASH_RECEIPT_TICKET", start_date, end_date) or [],
    }
    if slim:
        return {k: [_slim_ticket(t) if isinstance(t, dict) else t for t in v] for k, v in merged.items()}
    return merged


# ============ 거래 (tickets) ============

async def _hyphen_tickets(db: AsyncSession, ticket_type: str, sd_str: str, ed_str: str):
    """하이픈 원장에서 해당 ticketType을 그랜터 셰이프 리스트로 반환(그랜터 미사용). 미지원 타입은 None."""
    from app.services import hyphen_sync_ext as _hy
    if ticket_type == "EXPENSE_TICKET":
        try:
            await _hy.ensure_card_coverage(db, start_date=sd_str, end_date=ed_str)
        except Exception:
            logger.exception("카드 커버리지 확보 스킵")
        return await _hy.card_tickets_as_expense(db, start_date=sd_str, end_date=ed_str)
    if ticket_type == "BANK_TRANSACTION_TICKET":
        return await _hy.bank_tickets_as_granter(db, start_date=sd_str, end_date=ed_str)
    if ticket_type == "TAX_INVOICE_TICKET":
        try:
            await _hy.ensure_tax_coverage(db, start_date=sd_str, end_date=ed_str)
        except Exception:
            logger.exception("세금계산서 커버리지 확보 스킵")
        return await _hy.tax_invoices_as_granter(db, start_date=sd_str, end_date=ed_str)
    if ticket_type == "CASH_RECEIPT_TICKET":
        try:
            await _hy.ensure_cashreceipt_coverage(db, start_date=sd_str, end_date=ed_str)
        except Exception:
            logger.exception("현금영수증 커버리지 확보 스킵")
        return await _hy.cash_receipts_as_granter(db, start_date=sd_str, end_date=ed_str)
    return None


@router.post("/tickets")
async def list_tickets(payload: Dict[str, Any] = Body(default_factory=dict), db: AsyncSession = Depends(get_db)):
    """
    카드·계좌·세금계산서·현금영수증 거래 조회 — 하이픈 원장 단일소스(그랜터 미사용, DB 즉시).
    지원 ticketType: EXPENSE_TICKET / BANK_TRANSACTION_TICKET / TAX_INVOICE_TICKET / CASH_RECEIPT_TICKET.
    그 외 타입 또는 날짜 미지정은 빈 리스트.

    예시 payload:
    {
      "ticketType": "TAX_INVOICE_TICKET",
      "startDate": "2026-04-01",
      "endDate": "2026-04-30"
    }
    """
    sd_str = payload.get("startDate")
    ed_str = payload.get("endDate")
    ticket_type = payload.get("ticketType")
    if not (sd_str and ed_str and ticket_type):
        return []
    hy = await _hyphen_tickets(db, ticket_type, sd_str, ed_str)
    return hy if hy is not None else []


_DISABLED = "그랜터 제거됨 — 하이픈 단일소스로 전환되었습니다. (발행 등 일부 기능은 대체 수단 연동 전까지 미지원)"


@router.post("/tickets/bulk-update")
async def bulk_update_tickets(payload: Dict[str, Any] = Body(...)):
    """거래 일괄 수정 — 그랜터 제거로 미지원(분류는 내부 시스템에서 처리)."""
    raise HTTPException(status_code=501, detail=_DISABLED)


# ============ 자산 (assets) ============

@router.post("/assets")
async def list_assets(payload: Dict[str, Any] = Body(default_factory=dict), db: AsyncSession = Depends(get_db)):
    """연동 자산 — 하이픈 단일소스. assetType별로 반환(그랜터 미사용)."""
    from app.services import hyphen_sync_ext as _hy
    all_assets = await _hy.hyphen_assets_all(db)
    at = (payload or {}).get("assetType")
    if at and at in all_assets:
        return all_assets[at]
    return all_assets.get("BANK_ACCOUNT", [])


# ============ 잔액 / 일일 리포트 / 환율 ============

@router.post("/balances")
async def list_balances(payload: Dict[str, Any] = Body(...)):
    """계좌별 잔액 시계열 — 그랜터 제거. 잔액은 /assets, 시계열은 /hyphen/balance-series 사용."""
    raise HTTPException(status_code=501, detail=_DISABLED)


@router.post("/daily-report")
async def get_daily_report(payload: Dict[str, Any] = Body(...), db: AsyncSession = Depends(get_db)):
    """일일 재무 리포트 — 하이픈 원장 단일소스(잔액=전 계좌 last_balance 합, 입출금=기간 원장 합계)."""
    sd = payload.get("startDate"); ed = payload.get("endDate")
    from app.services import hyphen_sync_ext as _hy
    if sd and ed:
        rep = await _hy.daily_report_as_granter(db, start_date=sd, end_date=ed)
        if rep is not None:
            return rep
    return {"total": {"currentBalance": 0, "previousBalance": 0, "inAmount": 0, "outAmount": 0}}


@router.post("/exchange-rates")
async def get_exchange_rates(payload: Dict[str, Any] = Body(...)):
    """환율 — 그랜터 제거. 프론트는 Frankfurter/ECOS 사용."""
    raise HTTPException(status_code=501, detail=_DISABLED)


# ============ 세금계산서 / 현금영수증 발행 — 그랜터 제거로 미지원(조회만) ============

@router.post("/tax-invoices/issue")
async def issue_tax_invoice(payload: Dict[str, Any] = Body(...), idempotency_key: Optional[str] = Query(None)):
    """세금계산서 발행 — 현재 미지원(하이픈은 홈택스 조회만). 대체 발행수단 연동 전까지 불가."""
    raise HTTPException(status_code=501, detail="세금계산서 발행 미지원 (조회만 가능). " + _DISABLED)


@router.post("/tax-invoices/modify")
async def modify_tax_invoice(payload: Dict[str, Any] = Body(...), idempotency_key: Optional[str] = Query(None)):
    raise HTTPException(status_code=501, detail="세금계산서 수정발행 미지원. " + _DISABLED)


@router.post("/tax-invoices/cancel")
async def cancel_tax_invoice(payload: Dict[str, Any] = Body(...), idempotency_key: Optional[str] = Query(None)):
    raise HTTPException(status_code=501, detail="세금계산서 취소발행 미지원. " + _DISABLED)


@router.post("/cash-receipts/issue")
async def issue_cash_receipt(payload: Dict[str, Any] = Body(...), idempotency_key: Optional[str] = Query(None)):
    raise HTTPException(status_code=501, detail="현금영수증 발행 미지원 (조회만 가능). " + _DISABLED)


@router.post("/cash-receipts/cancel")
async def cancel_cash_receipt(payload: Dict[str, Any] = Body(...), idempotency_key: Optional[str] = Query(None)):
    raise HTTPException(status_code=501, detail="현금영수증 취소발행 미지원. " + _DISABLED)


# ============ 분류 기준 (tags / categories) — 그랜터 제거, 빈 목록 ============

@router.get("/tags")
async def list_tags():
    return []


@router.post("/tags")
async def create_tag(payload: Dict[str, Any] = Body(...)):
    raise HTTPException(status_code=501, detail=_DISABLED)


@router.put("/tags")
async def update_tag(payload: Dict[str, Any] = Body(...)):
    raise HTTPException(status_code=501, detail=_DISABLED)


@router.get("/tag-details")
async def list_tag_details():
    return []


@router.get("/categories")
async def list_categories():
    return []


# ============ 거래처 풀 (지난 N개월 세금계산서에서 거래처 정보 추출) ============

@router.get("/contractors-pool")
async def get_contractors_pool(months: int = Query(12, ge=1, le=24), db: AsyncSession = Depends(get_db)):
    """
    지난 N개월(default 12) 세금계산서에서 거래처 풀 구성 — 하이픈 원장 기반(그랜터 API 미사용).
    하이픈 세금계산서는 사업자번호/상호까지 보유(대표자·주소·이메일 등 상세는 미보유 → 빈값).
    응답: { count, months, contractors: [{businessNumber, companyName, count, ...}] }
    """
    from datetime import date, timedelta
    from sqlalchemy import select as _select
    from app.services import hyphen_sync_ext as _hy
    from app.models.hyphen_ext import HyphenTaxInvoice

    today = date.today()
    start = (today - timedelta(days=months * 31))
    sd = start.isoformat().replace("-", ""); ed = today.isoformat().replace("-", "")
    # 커버리지 확보(미커버 구간만 1회 sync)
    try:
        await _hy.ensure_tax_coverage(db, start_date=start.isoformat(), end_date=today.isoformat())
    except Exception:
        logger.exception("contractors-pool 세금계산서 커버리지 스킵")

    rows = (await db.execute(_select(HyphenTaxInvoice))).scalars().all()
    pool: Dict[str, Dict[str, Any]] = {}
    for t in rows:
        d = (t.issue_dt or "").replace("-", "")
        if not d or d < sd or d > ed:
            continue
        # 매출(01): 거래처=매입자(byr), 매입(02): 거래처=공급자(sup)
        if t.sup_byr == "01":
            bn, name = (t.byr_biz_no or ""), (t.byr_corp_nm or "")
        else:
            bn, name = (t.sup_biz_no or ""), (t.sup_corp_nm or "")
        bn_digits = "".join(filter(str.isdigit, bn))
        if not bn and not name:
            continue
        if bn_digits == "5038701038":  # 본인 회사 제외
            continue
        key = bn or name
        cur = pool.get(key)
        if cur is None:
            cur = {"businessNumber": bn, "companyName": name, "representativeName": "",
                   "address": "", "email": "", "phone": "", "businessType": "",
                   "businessItem": "", "contactName": "", "count": 0}
            pool[key] = cur
        cur["count"] += 1
        if not cur["companyName"] and name:
            cur["companyName"] = name

    contractors = sorted(pool.values(), key=lambda x: -x["count"])
    return {"count": len(contractors), "months": months, "contractors": contractors}
