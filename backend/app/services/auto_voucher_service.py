"""
자동 전표 후보 생성 서비스
그랜터 수집 거래 + AI 분류 결과 → AutoVoucherCandidate (검수 큐).

거래 유형별 표준 분개 패턴 (K-GAAP):
- 매출 세금계산서: 외상매출금(108) / 제품매출(404) + 부가세예수금(255)
- 매입 세금계산서: 비용·자산 + 부가세대급금(135) / 외상매입금(251)
- 카드 매입: 비용 + 부가세대급금 / 미지급금(253)[카드사]
- 통장 입금/출금: 보통예금(103) / AI 분류 추천
- 현금영수증 매입: 비용 + 부가세대급금 / 현금(101)
"""
import json
import logging
import re
from datetime import date, timedelta
from decimal import Decimal
from typing import Optional, Dict, Any, Tuple

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.accounting import (
    AutoVoucherCandidate, AutoVoucherSourceType, AutoVoucherStatus,
)
from app.services.granter_client import get_granter_client

logger = logging.getLogger(__name__)


# ============ 공통 유틸 ============

def _split_supply_vat(total: float, tax_amount: Optional[float] = None) -> Tuple[Decimal, Decimal]:
    """
    총액 → (공급가, 부가세) 분리.
    tax_amount 제공되면 그대로 사용, 없으면 10% 가정 → 공급가 = total / 1.1.
    면세/영세율 거래는 호출자가 tax_amount=0 명시.
    """
    total_d = Decimal(str(total or 0))
    if tax_amount is not None and float(tax_amount) > 0:
        vat = Decimal(str(tax_amount))
        return total_d - vat, vat
    if tax_amount == 0:
        return total_d, Decimal("0")
    # 10% 가정
    supply = (total_d / Decimal("1.1")).quantize(Decimal("1"))
    return supply, total_d - supply


def _parse_date(s: Any) -> date:
    if not s:
        return date.today()
    if isinstance(s, date):
        return s
    s = str(s)
    m = re.match(r'(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})', s)
    if m:
        y, mo, d = m.groups()
        try:
            return date(int(y), int(mo), int(d))
        except ValueError:
            pass
    return date.today()


def _safe_float(v: Any) -> float:
    try:
        return float(v or 0)
    except (ValueError, TypeError):
        return 0.0


# ============ 분개 후보 빌더 ============

def _build_tax_invoice_candidate(
    ticket: Dict[str, Any],
    is_sales: bool,
) -> AutoVoucherCandidate:
    """세금계산서(매출/매입) 분개 후보."""
    total = _safe_float(ticket.get("amount"))
    tax_amount_raw = ticket.get("taxAmount")
    tax_invoice = ticket.get("taxInvoice") or {}

    # 면세 추정 — taxAmount가 명시적으로 0이면 면세
    is_taxable = tax_amount_raw is None or float(tax_amount_raw) > 0
    supply, vat = _split_supply_vat(total, tax_amount_raw if is_taxable else 0)

    counterparty_party = (
        tax_invoice.get("contractor") if is_sales else tax_invoice.get("supplier")
    ) or {}
    counterparty = counterparty_party.get("companyName", "")

    if is_sales:
        debit_lines = [{
            "side": "debit", "account_code": "108", "account_name": "외상매출금",
            "amount": str(supply + vat), "memo": "",
        }]
        credit_lines = [{
            "side": "credit", "account_code": "404", "account_name": "제품매출",
            "amount": str(supply), "memo": "",
        }]
        if vat > 0:
            credit_lines.append({
                "side": "credit", "account_code": "255", "account_name": "부가세예수금",
                "amount": str(vat), "memo": "",
            })
        source_type = (AutoVoucherSourceType.SALES_TAX_INVOICE if is_taxable
                       else AutoVoucherSourceType.SALES_INVOICE)
        sugg_code, sugg_name = "404", "제품매출"
    else:
        sugg_code, sugg_name = "153", "원재료"  # AI가 추후 더 정밀 분류
        debit_lines = [{
            "side": "debit", "account_code": sugg_code, "account_name": sugg_name,
            "amount": str(supply), "memo": "",
        }]
        if vat > 0:
            debit_lines.append({
                "side": "debit", "account_code": "135", "account_name": "부가세대급금",
                "amount": str(vat), "memo": "",
            })
        credit_lines = [{
            "side": "credit", "account_code": "251", "account_name": "외상매입금",
            "amount": str(supply + vat), "memo": "",
        }]
        source_type = (AutoVoucherSourceType.PURCHASE_TAX_INVOICE if is_taxable
                       else AutoVoucherSourceType.PURCHASE_INVOICE)

    return AutoVoucherCandidate(
        source_type=source_type,
        source_id=str(ticket.get("id", "")),
        status=AutoVoucherStatus.PENDING,
        transaction_date=_parse_date(ticket.get("transactAt")),
        counterparty=counterparty[:200] if counterparty else None,
        description="",
        supply_amount=supply,
        vat_amount=vat,
        total_amount=supply + vat,
        confidence=Decimal("0.95"),  # 세계는 분개 패턴 명확
        suggested_account_code=sugg_code,
        suggested_account_name=sugg_name,
        debit_lines=json.dumps(debit_lines, ensure_ascii=False),
        credit_lines=json.dumps(credit_lines, ensure_ascii=False),
        raw_data=json.dumps(ticket, default=str, ensure_ascii=False)[:5000],
    )


def _build_card_candidate(
    ticket: Dict[str, Any],
    ai_account_code: Optional[str] = None,
    ai_account_name: Optional[str] = None,
    ai_confidence: float = 0.6,
) -> AutoVoucherCandidate:
    """카드 매입 분개 후보. AI 분류는 호출자가 미리 결정."""
    total = _safe_float(ticket.get("amount"))
    tax_amount = ticket.get("taxAmount")
    supply, vat = _split_supply_vat(total, tax_amount)

    card_usage = ticket.get("cardUsage") or {}
    merchant = card_usage.get("storeName", "")
    card_name = ticket.get("cardName") or ""

    acc_code = ai_account_code or "830"  # 소모품비(판) default
    acc_name = ai_account_name or "소모품비(판)"

    debit_lines = [{
        "side": "debit", "account_code": acc_code, "account_name": acc_name,
        "amount": str(supply), "memo": "",
    }]
    if vat > 0:
        debit_lines.append({
            "side": "debit", "account_code": "135", "account_name": "부가세대급금",
            "amount": str(vat), "memo": "",
        })
    credit_lines = [{
        "side": "credit", "account_code": "253", "account_name": "미지급금",
        "amount": str(supply + vat), "memo": card_name,
    }]

    return AutoVoucherCandidate(
        source_type=AutoVoucherSourceType.CARD,
        source_id=str(ticket.get("id", "")),
        status=AutoVoucherStatus.PENDING,
        transaction_date=_parse_date(ticket.get("transactAt")),
        counterparty=merchant[:200] if merchant else None,
        description=card_name[:500] if card_name else None,
        supply_amount=supply,
        vat_amount=vat,
        total_amount=supply + vat,
        confidence=Decimal(str(ai_confidence)),
        suggested_account_code=acc_code,
        suggested_account_name=acc_name,
        debit_lines=json.dumps(debit_lines, ensure_ascii=False),
        credit_lines=json.dumps(credit_lines, ensure_ascii=False),
        raw_data=json.dumps(ticket, default=str, ensure_ascii=False)[:5000],
    )


def _build_bank_candidate(
    ticket: Dict[str, Any],
    ai_account_code: Optional[str] = None,
    ai_account_name: Optional[str] = None,
    ai_confidence: float = 0.5,
) -> AutoVoucherCandidate:
    """통장 입출금 분개 후보. AI 추천 없으면 입금→외상매출금 회수, 출금→미지급금 결제로 가정."""
    total = _safe_float(ticket.get("amount"))
    direction = (ticket.get("transactionType") or "").upper()
    bt = ticket.get("bankTransaction") or {}
    counterparty = bt.get("counterparty") or bt.get("opponent") or ""
    content = bt.get("content") or ""

    is_inbound = direction in ("IN", "INBOUND", "DEPOSIT") or direction == "입금"

    if ai_account_code:
        acc_code, acc_name = ai_account_code, ai_account_name or ai_account_code
    else:
        acc_code = "108" if is_inbound else "253"
        acc_name = "외상매출금" if is_inbound else "미지급금"

    if is_inbound:
        debit_lines = [{
            "side": "debit", "account_code": "103", "account_name": "보통예금",
            "amount": str(total), "memo": "",
        }]
        credit_lines = [{
            "side": "credit", "account_code": acc_code, "account_name": acc_name,
            "amount": str(total), "memo": "",
        }]
    else:
        debit_lines = [{
            "side": "debit", "account_code": acc_code, "account_name": acc_name,
            "amount": str(total), "memo": "",
        }]
        credit_lines = [{
            "side": "credit", "account_code": "103", "account_name": "보통예금",
            "amount": str(total), "memo": "",
        }]

    return AutoVoucherCandidate(
        source_type=AutoVoucherSourceType.BANK,
        source_id=str(ticket.get("id", "")),
        status=AutoVoucherStatus.PENDING,
        transaction_date=_parse_date(ticket.get("transactAt")),
        counterparty=counterparty[:200] if counterparty else None,
        description=content[:500] if content else None,
        supply_amount=Decimal(str(total)),
        vat_amount=Decimal("0"),
        total_amount=Decimal(str(total)),
        confidence=Decimal(str(ai_confidence)),
        suggested_account_code=acc_code,
        suggested_account_name=acc_name,
        debit_lines=json.dumps(debit_lines, ensure_ascii=False),
        credit_lines=json.dumps(credit_lines, ensure_ascii=False),
        raw_data=json.dumps(ticket, default=str, ensure_ascii=False)[:5000],
    )


def _build_cash_receipt_candidate(
    ticket: Dict[str, Any],
    ai_account_code: Optional[str] = None,
    ai_account_name: Optional[str] = None,
    ai_confidence: float = 0.6,
) -> AutoVoucherCandidate:
    """현금영수증 매입 분개 후보 (대변=현금)."""
    total = _safe_float(ticket.get("amount"))
    tax_amount = ticket.get("taxAmount")
    supply, vat = _split_supply_vat(total, tax_amount)

    cr = ticket.get("cashReceipt") or {}
    issuer = (cr.get("issuer") or {}).get("companyName", "")

    acc_code = ai_account_code or "830"
    acc_name = ai_account_name or "소모품비(판)"

    debit_lines = [{
        "side": "debit", "account_code": acc_code, "account_name": acc_name,
        "amount": str(supply), "memo": "",
    }]
    if vat > 0:
        debit_lines.append({
            "side": "debit", "account_code": "135", "account_name": "부가세대급금",
            "amount": str(vat), "memo": "",
        })
    credit_lines = [{
        "side": "credit", "account_code": "101", "account_name": "현금",
        "amount": str(supply + vat), "memo": "",
    }]

    return AutoVoucherCandidate(
        source_type=AutoVoucherSourceType.CASH_RECEIPT,
        source_id=str(ticket.get("id", "")),
        status=AutoVoucherStatus.PENDING,
        transaction_date=_parse_date(ticket.get("transactAt")),
        counterparty=issuer[:200] if issuer else None,
        description="",
        supply_amount=supply,
        vat_amount=vat,
        total_amount=supply + vat,
        confidence=Decimal(str(ai_confidence)),
        suggested_account_code=acc_code,
        suggested_account_name=acc_name,
        debit_lines=json.dumps(debit_lines, ensure_ascii=False),
        credit_lines=json.dumps(credit_lines, ensure_ascii=False),
        raw_data=json.dumps(ticket, default=str, ensure_ascii=False)[:5000],
    )


# ============ 메인 진입점 ============

async def generate_candidates_for_period(
    db: AsyncSession,
    start_date: date,
    end_date: date,
    asset_id: Optional[int] = None,
) -> Dict[str, Any]:
    """
    기간 내 그랜터 거래 → AutoVoucherCandidate 일괄 생성.
    이미 등록된 source_id는 skip.
    """
    client = get_granter_client()

    tickets = await client.list_tickets_all_types(
        start_date.isoformat(),
        end_date.isoformat(),
        asset_id=asset_id,
    )

    # 중복 방지용 기존 source_id
    existing = (await db.execute(
        select(AutoVoucherCandidate.source_id)
        .where(AutoVoucherCandidate.source_id.isnot(None))
    )).all()
    existing_ids = {row[0] for row in existing if row[0]}

    counts = {
        "sales_tax_invoice": 0, "purchase_tax_invoice": 0,
        "card": 0, "bank": 0, "cash_receipt": 0,
        "skipped": 0, "errors": 0,
    }

    for t in tickets.get("TAX_INVOICE_TICKET", []) or []:
        tid = str(t.get("id", ""))
        if tid and tid in existing_ids:
            counts["skipped"] += 1
            continue
        try:
            txn_type = (t.get("transactionType") or "").upper()
            is_sales = any(k in txn_type for k in ("SALES", "OUT", "SUPPLY"))
            cand = _build_tax_invoice_candidate(t, is_sales=is_sales)
            db.add(cand)
            if is_sales:
                counts["sales_tax_invoice"] += 1
            else:
                counts["purchase_tax_invoice"] += 1
        except Exception as e:
            logger.warning(f"세금계산서 후보 생성 오류 ticket={t.get('id')}: {e}")
            counts["errors"] += 1

    for t in tickets.get("EXPENSE_TICKET", []) or []:
        tid = str(t.get("id", ""))
        if tid and tid in existing_ids:
            counts["skipped"] += 1
            continue
        try:
            cand = _build_card_candidate(t)
            db.add(cand)
            counts["card"] += 1
        except Exception as e:
            logger.warning(f"카드 후보 생성 오류 ticket={t.get('id')}: {e}")
            counts["errors"] += 1

    for t in tickets.get("BANK_TRANSACTION_TICKET", []) or []:
        tid = str(t.get("id", ""))
        if tid and tid in existing_ids:
            counts["skipped"] += 1
            continue
        try:
            cand = _build_bank_candidate(t)
            db.add(cand)
            counts["bank"] += 1
        except Exception as e:
            logger.warning(f"통장 후보 생성 오류 ticket={t.get('id')}: {e}")
            counts["errors"] += 1

    for t in tickets.get("CASH_RECEIPT_TICKET", []) or []:
        tid = str(t.get("id", ""))
        if tid and tid in existing_ids:
            counts["skipped"] += 1
            continue
        try:
            cand = _build_cash_receipt_candidate(t)
            db.add(cand)
            counts["cash_receipt"] += 1
        except Exception as e:
            logger.warning(f"현금영수증 후보 생성 오류 ticket={t.get('id')}: {e}")
            counts["errors"] += 1

    await db.commit()

    counts["total_created"] = (
        counts["sales_tax_invoice"] + counts["purchase_tax_invoice"]
        + counts["card"] + counts["bank"] + counts["cash_receipt"]
    )
    counts["period"] = f"{start_date} ~ {end_date}"
    return counts


# ============ 카드 ↔ 통장 중복 매칭 ============

async def match_card_bank_duplicates(
    db: AsyncSession,
    start_date: date,
    end_date: date,
    day_window: int = 35,
) -> Dict[str, int]:
    """
    카드 사용액 (EXPENSE) ↔ 통장 결제 출금 (BANK OUT) 매칭.
    매칭 키: 카드사명 매칭 + 금액 매칭 + 결제일이 카드 사용일 이후 N일 이내 (default 35일).

    매칭되면 통장 거래의 status = DUPLICATE 로 표시 (카드 후보가 원전표).
    """
    # 기간 내 카드 후보 (status=PENDING)
    card_rows = (await db.execute(
        select(AutoVoucherCandidate).where(
            AutoVoucherCandidate.source_type == AutoVoucherSourceType.CARD,
            AutoVoucherCandidate.status == AutoVoucherStatus.PENDING,
            AutoVoucherCandidate.transaction_date >= start_date,
            AutoVoucherCandidate.transaction_date <= end_date,
        )
    )).scalars().all()

    # 기간 ±day_window 내 통장 출금 후보
    bank_rows = (await db.execute(
        select(AutoVoucherCandidate).where(
            AutoVoucherCandidate.source_type == AutoVoucherSourceType.BANK,
            AutoVoucherCandidate.status == AutoVoucherStatus.PENDING,
            AutoVoucherCandidate.transaction_date >= start_date,
            AutoVoucherCandidate.transaction_date <= end_date + timedelta(days=day_window),
        )
    )).scalars().all()

    # 카드 description에 카드사명이 있음 (e.g. '신한카드', '비씨카드') — 매칭 시 활용
    # 단순화: 통장 description/counterparty에 '카드'·카드사명 포함 + 금액 일치 + 날짜 이후
    matched = 0

    # 통장 후보를 (counterparty/desc에 '카드' 포함된 것만) 필터
    card_payment_bank = [
        b for b in bank_rows
        if (b.description and "카드" in (b.description or "")) or
           (b.counterparty and "카드" in (b.counterparty or ""))
    ]

    # 통장 후보 indexing: amount → list
    bank_by_amount: Dict[Decimal, list] = {}
    for b in card_payment_bank:
        bank_by_amount.setdefault(b.total_amount, []).append(b)

    for c in card_rows:
        # 카드 결제 = 같은 금액의 통장 출금 (모든 카드 사용을 묶어 월별 청구한 결과인 경우도 있어서
        # 1:1 매칭이 안 될 수 있음 — 일단 단일 금액 매칭만)
        candidates = bank_by_amount.get(c.total_amount, [])
        for b in candidates:
            if b.duplicate_of_id is not None:
                continue  # 이미 매칭됨
            # 날짜 조건: 통장 결제일이 카드 사용일 이후 + day_window 이내
            if b.transaction_date < c.transaction_date:
                continue
            if (b.transaction_date - c.transaction_date).days > day_window:
                continue
            # 카드사명 매칭 (선택적): 통장 desc에 카드사명 포함 — 이미 필터로 거른 상태
            b.duplicate_of_id = c.id
            b.status = AutoVoucherStatus.DUPLICATE
            matched += 1
            break

    await db.commit()
    return {"matched_pairs": matched, "checked_cards": len(card_rows), "checked_banks": len(card_payment_bank)}
