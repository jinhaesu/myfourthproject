"""
은행간 내부거래 (회사 계좌 ↔ 회사 계좌 이체) 정리 서비스

데이터 소스: 그랜터 BANK_TRANSACTION_TICKET (assetId로 소속 계좌 식별)
감지 방식: 같은 금액의 OUT(계좌 A)·IN(계좌 B) 티켓을 근접 시각으로 페어링.
           페어를 못 찾아도 상대명이 우리 회사/계좌주면 '내부이체 추정'으로 별도 표시.
"""
from __future__ import annotations

import logging
import re
import time as _time
from datetime import date, datetime, timedelta
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

_CACHE: Dict[str, tuple] = {}
_CACHE_TTL = 300.0

# 페어링 허용 시간차 (은행 이체는 보통 수 초 내 반영, 여유있게)
_PAIR_WINDOW = timedelta(hours=6)

_OUR_NAME_PATTERNS = ("조인앤조인", "joinandjoin")


def _norm(s: Optional[str]) -> str:
    return re.sub(r"[\s\(\)\(주\)㈜주식회사]", "", str(s or "")).lower()


async def _fetch_assets_map() -> Dict[int, Dict[str, Any]]:
    """assetId → 계좌 라벨 매핑."""
    from app.services.granter_client import get_granter_client
    client = get_granter_client()
    assets = await client.list_all_assets(only_active=False)
    out: Dict[int, Dict[str, Any]] = {}
    for a in (assets.get("BANK_ACCOUNT") or []):
        if not isinstance(a, dict):
            continue
        aid = a.get("id")
        if aid is None:
            continue
        ba = a.get("bankAccount") or {}
        number = str(ba.get("number") or a.get("number") or "")
        last4 = re.sub(r"\D", "", number)[-4:] if number else ""
        bank = (ba.get("bankName") or a.get("bankName") or a.get("organizationName") or "").strip()
        nick = (a.get("nickname") or a.get("name") or ba.get("nickname") or "").strip()
        label = nick or (f"{bank} ({last4})" if bank or last4 else f"계좌#{aid}")
        out[int(aid)] = {
            "asset_id": int(aid),
            "label": label,
            "bank": bank,
            "last4": last4,
            "holder": (ba.get("accountHolderName") or ba.get("holderName") or "").strip(),
        }
    return out


async def _fetch_bank_tickets(start_date: date, end_date: date) -> List[Dict[str, Any]]:
    """기간 내 BANK_TRANSACTION_TICKET — 31일 초과 시 분할 호출."""
    from app.services.granter_client import get_granter_client
    client = get_granter_client()

    key = f"bank|{start_date}|{end_date}"
    now = _time.time()
    cached = _CACHE.get(key)
    if cached and (now - cached[1]) < _CACHE_TTL:
        return cached[0]

    items: List[Dict[str, Any]] = []
    seen: set = set()
    cur = start_date
    while cur <= end_date:
        chunk_end = min(cur + timedelta(days=30), end_date)
        try:
            resp = await client.list_tickets({
                "ticketType": "BANK_TRANSACTION_TICKET",
                "startDate": cur.isoformat(),
                "endDate": chunk_end.isoformat(),
            })
            chunk = resp if isinstance(resp, list) else (
                (resp.get("data") or resp.get("items") or []) if isinstance(resp, dict) else []
            )
            for t in chunk:
                tid = t.get("id")
                if tid in seen:
                    continue
                seen.add(tid)
                items.append(t)
        except Exception:
            logger.exception(f"bank tickets 조회 실패 ({cur}~{chunk_end})")
        cur = chunk_end + timedelta(days=1)

    _CACHE[key] = (items, now)
    for k in list(_CACHE.keys()):
        if now - _CACHE[k][1] > _CACHE_TTL:
            _CACHE.pop(k, None)
    return items


def _parse_dt(t: Dict[str, Any]) -> Optional[datetime]:
    s = str(t.get("transactAt") or t.get("createdAt") or "")[:19]
    try:
        return datetime.fromisoformat(s)
    except ValueError:
        return None


def _looks_internal(t: Dict[str, Any], holders: List[str]) -> bool:
    """상대명이 회사명/계좌주명이면 내부이체 신호."""
    bt = t.get("bankTransaction") or {}
    text = _norm((bt.get("counterparty") or "") + (bt.get("content") or ""))
    if not text:
        return False
    for p in _OUR_NAME_PATTERNS:
        if _norm(p) in text:
            return True
    for h in holders:
        hn = _norm(h)
        if hn and hn in text:
            return True
    return False


async def build_internal_transfers(start_date: date, end_date: date) -> Dict[str, Any]:
    """은행간 내부거래 정리 + 계좌별 누적 대차."""
    assets = await _fetch_assets_map()
    holders = list({a["holder"] for a in assets.values() if a["holder"]})
    tickets = await _fetch_bank_tickets(start_date, end_date)

    def _entry(t: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        dt = _parse_dt(t)
        if dt is None:
            return None
        try:
            amt = abs(float(t.get("amount") or 0))
        except (ValueError, TypeError):
            return None
        if amt <= 0:
            return None
        direction = (t.get("transactionType") or "").upper()
        is_out = direction in ("OUT", "OUTBOUND", "WITHDRAW") or "출금" in direction
        is_in = direction in ("IN", "INBOUND", "DEPOSIT") or "입금" in direction
        if not is_out and not is_in:
            return None
        bt = t.get("bankTransaction") or {}
        aid = t.get("assetId")
        acct = assets.get(int(aid)) if aid is not None and int(aid) in assets else None
        return {
            "ticket_id": t.get("id"),
            "dt": dt,
            "amount": amt,
            "direction": "OUT" if is_out else "IN",
            "asset_id": aid,
            "account": acct["label"] if acct else f"계좌#{aid}",
            "content": (bt.get("content") or bt.get("counterparty") or "").strip(),
            "internal_hint": _looks_internal(t, holders),
        }

    outs: List[Dict[str, Any]] = []
    ins: List[Dict[str, Any]] = []
    for t in tickets:
        e = _entry(t)
        if e is None:
            continue
        (outs if e["direction"] == "OUT" else ins).append(e)

    # 금액별 그룹 → OUT-IN 근접 시각 페어링 (다른 계좌 간)
    ins_by_amount: Dict[float, List[Dict[str, Any]]] = {}
    for e in ins:
        ins_by_amount.setdefault(e["amount"], []).append(e)
    for lst in ins_by_amount.values():
        lst.sort(key=lambda x: x["dt"])

    transfers: List[Dict[str, Any]] = []
    used_in_ids: set = set()
    for o in sorted(outs, key=lambda x: x["dt"]):
        candidates = ins_by_amount.get(o["amount"]) or []
        best = None
        best_gap = None
        for c in candidates:
            if c["ticket_id"] in used_in_ids:
                continue
            if c["asset_id"] == o["asset_id"]:
                continue  # 같은 계좌면 이체 아님
            gap = abs((c["dt"] - o["dt"]).total_seconds())
            if gap > _PAIR_WINDOW.total_seconds():
                continue
            if best is None or gap < best_gap:
                best, best_gap = c, gap
        if best is None:
            continue
        used_in_ids.add(best["ticket_id"])
        o["_paired"] = True
        transfers.append({
            "date": o["dt"].date().isoformat(),
            "time": o["dt"].strftime("%H:%M"),
            "from_account": o["account"],
            "to_account": best["account"],
            "amount": o["amount"],
            "content": o["content"] or best["content"],
            "gap_seconds": int(best_gap or 0),
            "out_ticket_id": o["ticket_id"],
            "in_ticket_id": best["ticket_id"],
        })

    # 페어는 못 찾았지만 상대명이 우리 회사인 건 — 내부이체 추정 (수동 확인용)
    suspects = [
        {
            "date": e["dt"].date().isoformat(),
            "time": e["dt"].strftime("%H:%M"),
            "account": e["account"],
            "direction": e["direction"],
            "amount": e["amount"],
            "content": e["content"],
        }
        for e in outs + ins
        if e.get("internal_hint") and not e.get("_paired") and e["ticket_id"] not in used_in_ids
    ]
    suspects.sort(key=lambda x: (x["date"], x["time"]))

    # 계좌별 누적 대차 (보낸 금액 = 대변성, 받은 금액 = 차변성)
    summary: Dict[str, Dict[str, Any]] = {}
    for tr in transfers:
        s = summary.setdefault(tr["from_account"], {"account": tr["from_account"], "sent": 0.0, "received": 0.0, "count": 0})
        s["sent"] += tr["amount"]
        s["count"] += 1
        r = summary.setdefault(tr["to_account"], {"account": tr["to_account"], "sent": 0.0, "received": 0.0, "count": 0})
        r["received"] += tr["amount"]
        r["count"] += 1
    for s in summary.values():
        s["net"] = s["received"] - s["sent"]

    transfers.sort(key=lambda x: (x["date"], x["time"]), reverse=True)

    return {
        "period": {"start": start_date.isoformat(), "end": end_date.isoformat()},
        "transfers": transfers,
        "accounts": sorted(summary.values(), key=lambda x: abs(x["net"]), reverse=True),
        "total_amount": sum(t["amount"] for t in transfers),
        "transfer_count": len(transfers),
        "suspects": suspects[:50],
        "accounts_known": len(assets),
    }
