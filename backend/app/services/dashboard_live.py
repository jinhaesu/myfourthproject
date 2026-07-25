"""
대시보드 실데이터 — 그랜터 기반 (전표 DB 아님).

기존 대시보드가 위하고 전표/예산 DB를 봐서 빈 화면이던 문제 해결.
자금 잔액·최근 입출금·카드지출·이번달 vs 지난달을 그랜터 실시간으로 구성.
"""
from __future__ import annotations

import logging
from datetime import date, timedelta
from typing import Any, Dict, List

logger = logging.getLogger(__name__)


def _num(v: Any) -> float:
    try:
        return float(v or 0)
    except (ValueError, TypeError):
        return 0.0


async def build_dashboard(as_of: date | None = None) -> Dict[str, Any]:
    from app.services.daily_cash_report import (
        _granter_daily_report, _granter_bank_tickets, _granter_expense_tickets,
        _split_inflow_outflow,
    )

    today = as_of or date.today()
    yesterday = today - timedelta(days=1)

    # 1) 현재 잔액 + 어제 입출금 (daily-financial-report)
    report = await _granter_daily_report(yesterday)
    total = (report or {}).get("total", {}) if isinstance(report, dict) else {}
    balance = _num(total.get("currentBalance"))
    y_inflow = _num(total.get("inAmount"))
    y_outflow = _num(total.get("outAmount"))

    # 2) 최근 7일 통장 입출금 상위
    week_start = today - timedelta(days=7)
    bank = await _granter_bank_tickets(week_start, today)
    inflows, outflows = _split_inflow_outflow(bank)
    inflows.sort(key=lambda x: x["amount"], reverse=True)
    outflows.sort(key=lambda x: x["amount"], reverse=True)
    week_inflow = sum(i["amount"] for i in inflows)
    week_outflow = sum(o["amount"] for o in outflows)

    # 3) 카드 지출 — 이번달 vs 지난달
    this_m_start = today.replace(day=1)
    prev_m_end = this_m_start - timedelta(days=1)
    prev_m_start = prev_m_end.replace(day=1)

    this_cards = await _granter_expense_tickets(this_m_start, today)
    prev_cards = await _granter_expense_tickets(prev_m_start, prev_m_end)
    this_card_total = sum(_num(t.get("amount")) for t in this_cards)
    prev_card_total = sum(_num(t.get("amount")) for t in prev_cards)

    def _slim(lst: List[Dict[str, Any]], n: int = 5) -> List[Dict[str, Any]]:
        return [
            {
                "counterparty": x.get("counterparty") or "(미지정)",
                "description": (x.get("description") or "")[:40],
                "amount": x["amount"],
                "date": str(x.get("date") or "")[:10],
            }
            for x in lst[:n]
        ]

    return {
        "as_of": today.isoformat(),
        "balance": balance,
        "yesterday": {"date": yesterday.isoformat(), "inflow": y_inflow, "outflow": y_outflow, "net": y_inflow - y_outflow},
        "week": {
            "start": week_start.isoformat(),
            "inflow": week_inflow, "outflow": week_outflow, "net": week_inflow - week_outflow,
            "top_inflows": _slim(inflows), "top_outflows": _slim(outflows),
        },
        "card": {
            "this_month": this_card_total, "prev_month": prev_card_total,
            "this_count": len(this_cards), "prev_count": len(prev_cards),
            "delta_pct": ((this_card_total - prev_card_total) / prev_card_total * 100) if prev_card_total else 0,
        },
    }
