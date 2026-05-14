"""
Daily Cash Report (AI 자금 다이제스트) 생성 서비스

데이터 소스: 그랜터 API (실시간 자금 흐름)
- daily-financial-report: 잔액·입출금
- list_tickets_all_types: 카드/통장/세금계산서/현금영수증 거래

위하고 voucher는 회계/분석용이므로 자금 다이제스트에서 사용하지 않음.
"""
from __future__ import annotations

import json
import logging
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Any, Dict, List, Optional

from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.daily_cash_report import (
    DailyCashReportConfig, DailyCashReportSnapshot,
    DEFAULT_SECTIONS, REQUIRED_SECTIONS,
)
from app.services.granter_client import get_granter_client

logger = logging.getLogger(__name__)


async def get_or_create_config(db: AsyncSession, user_id: int) -> DailyCashReportConfig:
    """사용자별 설정 조회 — 없으면 기본값으로 생성."""
    cfg = (await db.execute(
        select(DailyCashReportConfig).where(DailyCashReportConfig.user_id == user_id)
    )).scalar_one_or_none()
    if cfg:
        return cfg
    cfg = DailyCashReportConfig(
        user_id=user_id,
        enabled=True,
        sections=json.dumps(DEFAULT_SECTIONS),
        disabled_sections="[]",
        delivery_time="09:00",
        delivery_channels='["email"]',
    )
    db.add(cfg)
    await db.commit()
    await db.refresh(cfg)
    return cfg


def _format_won(amount: Decimal | float | int) -> str:
    n = int(amount or 0)
    sign = ""
    if n < 0:
        sign = "-"
        n = -n
    if n >= 100_000_000:
        eok = n // 100_000_000
        man = (n % 100_000_000) // 10_000
        if man > 0:
            return f"{sign}{eok}억 {man:,}만원"
        return f"{sign}{eok}억원"
    if n >= 10_000:
        man = n // 10_000
        rest = n % 10_000
        if rest > 0:
            return f"{sign}{man:,}만 {rest:,}원"
        return f"{sign}{man:,}만원"
    return f"{sign}{n:,}원"


# ============ 그랜터 호출 + 캐싱 ============

async def _granter_daily_report(target_date: date) -> Dict[str, Any]:
    """target_date 단일 일자 daily-financial-report 호출."""
    client = get_granter_client()
    try:
        return await client.get_daily_financial_report({
            "startDate": target_date.isoformat(),
            "endDate": target_date.isoformat(),
            "useCurrentExchangeRate": False,
        }) or {}
    except Exception as e:
        logger.exception(f"그랜터 daily-report 호출 실패 (date={target_date})")
        return {"_error": str(e)[:200]}


async def _granter_expense_tickets(start_date: date, end_date: date) -> List[Dict[str, Any]]:
    """카드(EXPENSE_TICKET) 거래 — 31일 제한 안에서만 호출."""
    client = get_granter_client()
    if (end_date - start_date).days > 30:
        start_date = end_date - timedelta(days=30)
    try:
        tickets = await client.list_tickets_all_types(
            start_date.isoformat(), end_date.isoformat(),
        )
        return tickets.get("EXPENSE_TICKET", []) or []
    except Exception:
        logger.exception(f"그랜터 expense_tickets 호출 실패 ({start_date}~{end_date})")
        return []


async def _granter_bank_tickets(start_date: date, end_date: date) -> List[Dict[str, Any]]:
    """통장 거래(BANK_TRANSACTION_TICKET) — 입출금 상세."""
    client = get_granter_client()
    if (end_date - start_date).days > 30:
        start_date = end_date - timedelta(days=30)
    try:
        tickets = await client.list_tickets_all_types(
            start_date.isoformat(), end_date.isoformat(),
        )
        return tickets.get("BANK_TRANSACTION_TICKET", []) or []
    except Exception:
        logger.exception(f"그랜터 bank_tickets 호출 실패 ({start_date}~{end_date})")
        return []


def _split_inflow_outflow(bank_tickets: List[Dict[str, Any]]) -> tuple:
    """BANK_TRANSACTION_TICKET 리스트를 입금/출금으로 분리."""
    inflows = []
    outflows = []
    for t in bank_tickets:
        try:
            amt = float(t.get("amount") or 0)
        except (ValueError, TypeError):
            amt = 0.0
        if amt <= 0:
            continue
        bt = t.get("bankTransaction") or {}
        direction = (t.get("transactionType") or "").upper()
        # 그랜터 응답 다양성 — IN/INBOUND/DEPOSIT, 한글 '입금', 또는 inOutType 등
        in_out = (t.get("inOutType") or bt.get("inOutType") or "").upper()
        is_inbound = (
            direction in ("IN", "INBOUND", "DEPOSIT")
            or in_out in ("IN", "INBOUND", "DEPOSIT")
            or "입금" in str(direction)
            or "입금" in str(in_out)
        )
        entry = {
            "counterparty": (bt.get("opponent") or bt.get("counterparty")
                             or bt.get("opponentName") or "(미지정)"),
            "description": bt.get("content") or bt.get("memo") or "",
            "amount": amt,
            "date": t.get("transactAt") or t.get("createdAt") or "",
        }
        if is_inbound:
            inflows.append(entry)
        else:
            outflows.append(entry)
    return inflows, outflows


# ============ 섹션 빌더 ============

async def _section_cash_status(target_date: date, report: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """자금 현황 — 그랜터 일일 리포트의 입출금 + 현 잔액."""
    if report is None:
        report = await _granter_daily_report(target_date)
    total = (report or {}).get("total", {}) if isinstance(report, dict) else {}
    inflow = float(total.get("inAmount") or 0)
    outflow = float(total.get("outAmount") or 0)
    balance = float(total.get("currentBalance") or 0)
    net = inflow - outflow

    return {
        "title": "자금 현황",
        "date": target_date.isoformat(),
        "inflow": inflow,
        "outflow": outflow,
        "net": net,
        "balance": balance,
        "summary": (
            f"어제 입금 {_format_won(inflow)}, 출금 {_format_won(outflow)}으로 "
            f"순 {'+' if net >= 0 else ''}{_format_won(net)} 변동했어요. "
            f"현 시점 가용자금은 {_format_won(balance)}이에요."
        ),
    }


async def _section_ai_cashflow(target_date: date, report: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """AI 현금흐름 — 잔액 추이 + 주요 입출금 (개별 거래 단위).

    주요 입출금은 BANK_TRANSACTION_TICKET 기반으로 입금/출금 각 top 5 보장.
    어제 데이터가 부족하면 최근 7일까지 확장해서 채움.
    """
    if report is None:
        report = await _granter_daily_report(target_date)
    total = (report or {}).get("total", {}) if isinstance(report, dict) else {}
    bal_today = float(total.get("currentBalance") or 0)
    bal_prev_day = float(total.get("previousBalance") or 0)
    delta_day = bal_today - bal_prev_day

    # 전월 동기
    prev_month_target = target_date.replace(day=1) - timedelta(days=1)
    prev_month_same_day = min(target_date.day, prev_month_target.day)
    prev_month_date = prev_month_target.replace(day=prev_month_same_day)
    prev_month_report = await _granter_daily_report(prev_month_date)
    prev_total = (prev_month_report or {}).get("total", {})
    bal_prev_month = float(prev_total.get("currentBalance") or 0)
    delta_month = bal_today - bal_prev_month

    # 어제 통장 거래
    day_tickets = await _granter_bank_tickets(target_date, target_date)
    inflows, outflows = _split_inflow_outflow(day_tickets)
    inflows.sort(key=lambda x: x["amount"], reverse=True)
    outflows.sort(key=lambda x: x["amount"], reverse=True)

    # 어제만으로 3건 미만이면 최근 7일까지 확장
    if len(inflows) < 3 or len(outflows) < 3:
        wider_start = target_date - timedelta(days=7)
        wider_tickets = await _granter_bank_tickets(wider_start, target_date)
        wider_in, wider_out = _split_inflow_outflow(wider_tickets)
        # 어제 항목 보존, 추가만 채움
        existing_in = {(e["counterparty"], e["amount"], e["date"]) for e in inflows}
        existing_out = {(e["counterparty"], e["amount"], e["date"]) for e in outflows}
        for e in sorted(wider_in, key=lambda x: x["amount"], reverse=True):
            if (e["counterparty"], e["amount"], e["date"]) not in existing_in:
                inflows.append(e)
                existing_in.add((e["counterparty"], e["amount"], e["date"]))
                if len(inflows) >= 5:
                    break
        for e in sorted(wider_out, key=lambda x: x["amount"], reverse=True):
            if (e["counterparty"], e["amount"], e["date"]) not in existing_out:
                outflows.append(e)
                existing_out.add((e["counterparty"], e["amount"], e["date"]))
                if len(outflows) >= 5:
                    break

    # top 5씩 자름
    inflows = inflows[:5]
    outflows = outflows[:5]

    return {
        "title": "AI 현금흐름 분석",
        "balance_trend": {
            "title": "잔액 추이",
            "balance": bal_today,
            "delta_day": delta_day,
            "delta_month": delta_month,
            "summary": (
                f"어제 최종 잔액은 {_format_won(bal_today)}으로, "
                f"전일 대비 {_format_won(abs(delta_day))} "
                f"{'증가' if delta_day >= 0 else '감소'}하였고, "
                f"전월 동기 대비 {_format_won(abs(delta_month))} "
                f"{'증가' if delta_month >= 0 else '감소'}했어요."
            ),
        },
        "top_movements": {
            "title": "주요 입출금 내역",
            "outflows": outflows,
            "inflows": inflows,
        },
    }


async def _section_card_spending(target_date: date) -> Dict[str, Any]:
    """카드 지출 분석 — 어제 + 이번달 vs 전월 동기 (그랜터 expense_tickets)."""
    month_start = target_date.replace(day=1)
    prev_month_end = month_start - timedelta(days=1)
    prev_month_start = prev_month_end.replace(day=1)
    prev_month_same = prev_month_end.replace(day=min(target_date.day, prev_month_end.day))

    # 이번달 + 전월 동기 한꺼번에 받음 (30일 제한 안에서)
    span_start = min(prev_month_start, month_start)
    span_end = target_date
    tickets = await _granter_expense_tickets(span_start, span_end)

    def _ticket_date(t: Dict[str, Any]) -> Optional[date]:
        d = t.get("transactAt") or t.get("createdAt") or ""
        try:
            return date.fromisoformat(str(d)[:10])
        except (ValueError, TypeError):
            return None

    def _amt(t: Dict[str, Any]) -> float:
        try:
            return float(t.get("amount") or 0)
        except (ValueError, TypeError):
            return 0.0

    today_total = sum(_amt(t) for t in tickets if _ticket_date(t) == target_date)
    month_total = sum(_amt(t) for t in tickets if _ticket_date(t) and month_start <= _ticket_date(t) <= target_date)
    prev_total = sum(_amt(t) for t in tickets if _ticket_date(t) and prev_month_start <= _ticket_date(t) <= prev_month_same)

    diff = month_total - prev_total

    # 어제 top 5
    today_tickets = [t for t in tickets if _ticket_date(t) == target_date]
    today_tickets.sort(key=_amt, reverse=True)
    top = today_tickets[:5]
    top_payments = []
    for t in top:
        cu = t.get("cardUsage") or {}
        top_payments.append({
            "counterparty": cu.get("storeName") or "(미지정)",
            "description": t.get("cardName") or cu.get("category") or "",
            "amount": _amt(t),
        })

    return {
        "title": "카드 지출 분석",
        "trend": {
            "title": "지출 추이",
            "today_total": today_total,
            "month_total": month_total,
            "prev_month_total": prev_total,
            "diff_vs_prev_month": diff,
            "summary": (
                f"어제는 총 {_format_won(today_total)}을 결제했어요. "
                f"이번달 누적 카드 사용액은 {_format_won(month_total)}으로, "
                f"전월 동기 대비 {_format_won(abs(diff))} "
                f"{'더 쓰고' if diff > 0 else '덜 쓰고'} 있어요."
            ),
        },
        "top_payments": top_payments,
    }


async def _section_card_usage(target_date: date) -> Dict[str, Any]:
    """카드 사용 현황 — 어제 카드 결제 상세."""
    tickets = await _granter_expense_tickets(target_date, target_date)

    def _amt(t: Dict[str, Any]) -> float:
        try:
            return float(t.get("amount") or 0)
        except (ValueError, TypeError):
            return 0.0

    tickets.sort(key=_amt, reverse=True)
    total = sum(_amt(t) for t in tickets)
    items = []
    for t in tickets[:10]:
        cu = t.get("cardUsage") or {}
        items.append({
            "counterparty": cu.get("storeName") or "(미지정)",
            "description": t.get("cardName") or cu.get("category") or "",
            "amount": _amt(t),
        })

    return {
        "title": "카드 사용 현황",
        "date": target_date.isoformat(),
        "total": total,
        "count": len(tickets),
        "items": items,
        "summary": f"어제 카드 결제 {len(tickets)}건, 총 {_format_won(total)}이에요.",
    }


SECTION_GENERATORS = {
    "cash_status": _section_cash_status,
    "ai_cashflow": _section_ai_cashflow,
    "card_spending": _section_card_spending,
    "card_usage": _section_card_usage,
}


async def generate_report_content(
    db: AsyncSession,
    user_id: int,
    target_date: date,
    config: Optional[DailyCashReportConfig] = None,
    auto_latest: bool = True,
) -> Dict[str, Any]:
    """사용자 설정에 따라 자금일보 콘텐츠 생성 (그랜터 데이터)."""
    if config is None:
        config = await get_or_create_config(db, user_id)

    try:
        sections = json.loads(config.sections)
        disabled = set(json.loads(config.disabled_sections or "[]"))
    except (ValueError, TypeError):
        sections = DEFAULT_SECTIONS
        disabled = set()

    # 그랜터 daily-report 한 번만 호출 후 cash_status/ai_cashflow에 공유
    shared_report = await _granter_daily_report(target_date)

    result = {
        "report_date": target_date.isoformat(),
        "target_date": target_date.isoformat(),
        "sections_order": sections,
        "disabled_sections": list(disabled),
        "content": {},
    }

    for section_key in sections:
        if section_key in disabled and section_key not in REQUIRED_SECTIONS:
            continue
        try:
            if section_key == "cash_status":
                result["content"][section_key] = await _section_cash_status(target_date, shared_report)
            elif section_key == "ai_cashflow":
                result["content"][section_key] = await _section_ai_cashflow(target_date, shared_report)
            elif section_key == "card_spending":
                result["content"][section_key] = await _section_card_spending(target_date)
            elif section_key == "card_usage":
                result["content"][section_key] = await _section_card_usage(target_date)
        except Exception as e:
            logger.exception(f"섹션 생성 실패: {section_key}")
            result["content"][section_key] = {"error": str(e)[:200]}

    return result
