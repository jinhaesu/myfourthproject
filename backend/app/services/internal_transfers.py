"""
은행간 내부거래 (회사 계좌 ↔ 회사 계좌 이체) 정리 서비스

데이터 소스: 그랜터 BANK_TRANSACTION_TICKET
식별 방식: 각 통장거래의 상대방(적요/counterparty)을 '우리 계좌'로 해석.
  - 상대가 특정 우리 계좌로 해석되면 → 그 방향(from→to)이 확정된 내부이체
  - 상대가 회사명(조인앤조인)만 있으면 → 내부이체지만 상대 계좌 미상
  - 상대가 외부 거래처면 → 내부이체 아님(제외)

계좌 라벨: '은행명 계좌뒷4자리' (예: 기업은행 4019, 신한은행 5021)
"""
from __future__ import annotations

import logging
import re
import time as _time
from datetime import date, datetime, timedelta
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

_CACHE: Dict[str, tuple] = {}
_CACHE_TTL = 300.0

_COMPANY_ALIASES = ("조인앤조인", "joinandjoin")

# 은행명 → 기본 역할 (대표 설명: 신한=매출보관, 기업=운영지출)
_DEFAULT_ROLE_BY_BANK = {
    "신한은행": "reservoir",
    "기업은행": "operating",
}
# 계좌명에 이 키워드가 있으면 적립(퇴직연금 등) — 이동해도 잔액감소 아님
_SAVINGS_NAME_HINTS = ("퇴직연금", "적립", "정기예금", "정기적금", "펀드")

ROLE_LABELS = {
    "reservoir": "매출 보관",
    "operating": "운영·지출",
    "savings": "적립(퇴직연금 등)",
    "other": "기타",
}

# 은행명 → 짧은 별칭(적요에 등장하는 형태)
_BANK_SHORT = {
    "기업은행": ["기업", "ibk"],
    "신한은행": ["신한"],
    "하나은행": ["하나", "keb", "외환"],
    "국민은행": ["국민", "kb"],
    "우리은행": ["우리"],
    "농협은행": ["농협", "nh"],
    "농협": ["농협", "nh"],
    "새마을금고": ["새마을", "mg"],
    "카카오뱅크": ["카카오"],
    "토스뱅크": ["토스"],
}


def _digits(s: Optional[str]) -> str:
    return re.sub(r"\D", "", str(s or ""))


def _norm(s: Optional[str]) -> str:
    return re.sub(r"[\s\(\)（）㈜주식회사\-_.]", "", str(s or "")).lower()


class Account:
    __slots__ = ("asset_id", "bank", "number", "last4", "last3", "shorts", "label", "name", "role")

    def __init__(self, asset_id, bank, number, name=""):
        self.asset_id = int(asset_id) if asset_id is not None else None
        self.bank = (bank or "").strip()
        self.name = (name or "").strip()
        num = _digits(number)
        self.number = num
        self.last4 = num[-4:] if len(num) >= 4 else num
        self.last3 = num[-3:] if len(num) >= 3 else num
        self.shorts = _BANK_SHORT.get(self.bank, [self.bank[:2]] if self.bank else [])
        # 라벨: 은행명 + 뒷4자리
        self.label = f"{self.bank} {self.last4}".strip() if self.bank else f"계좌 {self.last4}"
        # 기본 역할: 계좌명에 적립 힌트 있으면 savings, 아니면 은행명 기준
        if any(h in self.name for h in _SAVINGS_NAME_HINTS):
            self.role = "savings"
        else:
            self.role = _DEFAULT_ROLE_BY_BANK.get(self.bank, "other")


async def _fetch_accounts(role_overrides: Optional[Dict[str, str]] = None) -> List[Account]:
    from app.services.granter_client import get_granter_client
    client = get_granter_client()
    assets = await client.list_all_assets(only_active=False)
    accts: List[Account] = []
    for a in (assets.get("BANK_ACCOUNT") or []):
        if not isinstance(a, dict):
            continue
        ba = a.get("bankAccount") or {}
        bank = ba.get("bankName") or a.get("bankName") or a.get("organizationName") or ""
        number = ba.get("number") or a.get("number") or ""
        name = a.get("name") or a.get("nickname") or ba.get("nickname") or ""
        acc = Account(a.get("id"), bank, number, name)
        # 관리자 지정 역할 override (라벨 기준)
        if role_overrides and acc.label in role_overrides:
            acc.role = role_overrides[acc.label]
        accts.append(acc)
    return accts


def _resolve_counterparty(memo: str, accounts: List[Account], my: Optional[Account]) -> Tuple[Optional[Account], bool]:
    """적요 → (해석된 우리 계좌 or None, 회사명 매칭 여부).

    반환:
      (Account, _) — 특정 우리 계좌로 확정
      (None, True) — 회사명만 매칭(내부이체지만 계좌 미상)
      (None, False) — 외부 거래처(내부 아님)
    """
    n = _norm(memo)
    if not n:
        return None, False

    # 은행 별칭 + 뒷자리(3~4)로 특정 계좌 매칭
    best: Optional[Account] = None
    for acc in accounts:
        if my and acc.asset_id == my.asset_id:
            continue
        bank_hit = any(s and s in n for s in [_norm(x) for x in acc.shorts])
        if not bank_hit:
            continue
        # 뒷자리 매칭 (4자리 우선, 없으면 3자리)
        if acc.last4 and acc.last4 in n:
            return acc, True
        if acc.last3 and acc.last3 in n:
            best = best or acc
    if best:
        return best, True

    # 회사명만 있으면 내부(계좌 미상)
    if any(_norm(a) in n for a in _COMPANY_ALIASES):
        return None, True

    return None, False


async def _fetch_bank_tickets(start_date: date, end_date: date) -> List[Dict[str, Any]]:
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


async def build_internal_transfers(
    start_date: date, end_date: date,
    role_overrides: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    """은행간 내부거래 정리 + 계좌별 순대차 + 간접 현금흐름 관점.

    현금흐름 관점(대표 운영 방식):
    - 매출 보관(reservoir, 예:신한)에 외부 매출이 쌓임
    - 운영·지출(operating, 예:기업)에서 이자·카드값이 빠짐 → 매출풀이 메꿔줌
    - 적립(savings, 퇴직연금 등) 이동은 회사 잔액 감소 아님
    """
    accounts = await _fetch_accounts(role_overrides)
    by_asset = {a.asset_id: a for a in accounts if a.asset_id is not None}
    label_role = {a.label: a.role for a in accounts}
    tickets = await _fetch_bank_tickets(start_date, end_date)

    # 1단계: 내부이체 후보 추출 (상대가 우리 계좌/회사로 해석되는 건)
    legs: List[Dict[str, Any]] = []
    for t in tickets:
        dt = _parse_dt(t)
        if dt is None:
            continue
        try:
            amt = abs(float(t.get("amount") or 0))
        except (ValueError, TypeError):
            continue
        if amt <= 0:
            continue
        direction = (t.get("transactionType") or "").upper()
        is_out = direction in ("OUT", "OUTBOUND", "WITHDRAW") or "출금" in direction
        is_in = direction in ("IN", "INBOUND", "DEPOSIT") or "입금" in direction
        if not is_out and not is_in:
            continue

        bt = t.get("bankTransaction") or {}
        memo = (bt.get("content") or bt.get("counterparty") or bt.get("description") or "").strip()
        aid = t.get("assetId")
        my = by_asset.get(int(aid)) if aid is not None and int(aid) in by_asset else None

        counter, is_internal = _resolve_counterparty(memo, accounts, my)
        if not is_internal:
            continue  # 외부 거래처 — 내부이체 아님

        legs.append({
            "ticket_id": t.get("id"),
            "dt": dt,
            "amount": amt,
            "direction": "OUT" if is_out else "IN",
            "my": my,
            "counter": counter,   # 해석된 상대 계좌 (없으면 None=계좌미상)
            "memo": memo,
        })

    # 2단계: 양다리(OUT/IN 둘 다 잡힌) 병합 — 같은 금액+근접시각+상호 계좌
    used: set = set()
    transfers: List[Dict[str, Any]] = []

    def _acc_label(a: Optional[Account]) -> str:
        return a.label if a else "계좌 미상"

    outs = [l for l in legs if l["direction"] == "OUT"]
    ins = [l for l in legs if l["direction"] == "IN"]

    for o in sorted(outs, key=lambda x: x["dt"]):
        if o["ticket_id"] in used:
            continue
        # 짝 찾기: 같은 금액, 6시간 이내, in쪽 my == out쪽 counter(또는 반대)
        match = None
        for c in ins:
            if c["ticket_id"] in used:
                continue
            if c["amount"] != o["amount"]:
                continue
            if abs((c["dt"] - o["dt"]).total_seconds()) > 6 * 3600:
                continue
            # 상호 계좌 일치성 확인 (느슨): out.counter==in.my 또는 in.counter==out.my
            ok = True
            if o["counter"] and c["my"] and o["counter"].asset_id != c["my"].asset_id:
                ok = False
            if c["counter"] and o["my"] and c["counter"].asset_id != o["my"].asset_id:
                ok = False
            if ok:
                match = c
                break
        from_acc = o["my"]
        to_acc = (match["my"] if match else None) or o["counter"]
        used.add(o["ticket_id"])
        if match:
            used.add(match["ticket_id"])
        transfers.append({
            "date": o["dt"].date().isoformat(),
            "time": o["dt"].strftime("%H:%M"),
            "from_label": _acc_label(from_acc),
            "to_label": _acc_label(to_acc),
            "amount": o["amount"],
            "memo": o["memo"],
            "paired": bool(match),
            "resolved": bool(to_acc),  # 상대 계좌 확정 여부
        })

    # 짝 없는 IN (출금측 미연동) — 입금만 잡힌 내부이체
    for c in ins:
        if c["ticket_id"] in used:
            continue
        used.add(c["ticket_id"])
        from_acc = c["counter"]
        to_acc = c["my"]
        transfers.append({
            "date": c["dt"].date().isoformat(),
            "time": c["dt"].strftime("%H:%M"),
            "from_label": _acc_label(from_acc),
            "to_label": _acc_label(to_acc),
            "amount": c["amount"],
            "memo": c["memo"],
            "paired": False,
            "resolved": bool(from_acc),
        })

    # 3단계: 계좌별 순대차
    summary: Dict[str, Dict[str, Any]] = {}

    def _acc(label: str) -> Dict[str, Any]:
        return summary.setdefault(label, {
            "account": label, "sent": 0.0, "received": 0.0, "count": 0,
        })

    for tr in transfers:
        if tr["from_label"] != "계좌 미상":
            s = _acc(tr["from_label"]); s["sent"] += tr["amount"]; s["count"] += 1
        if tr["to_label"] != "계좌 미상":
            r = _acc(tr["to_label"]); r["received"] += tr["amount"]; r["count"] += 1
    for s in summary.values():
        s["net"] = s["received"] - s["sent"]

    # 4단계: 계좌쌍(A↔B) 순차액 — 양방향 상계 후 순 채권/채무
    #   예: 신한→기업 1억, 기업→신한 1.2억 → 기업이 신한에 순 0.2억 더 보냄(못받음)
    pair: Dict[tuple, Dict[str, float]] = {}
    for tr in transfers:
        a, b = tr["from_label"], tr["to_label"]
        if a == "계좌 미상" or b == "계좌 미상":
            continue
        key = tuple(sorted([a, b]))
        p = pair.setdefault(key, {key[0] + "→" + key[1]: 0.0, key[1] + "→" + key[0]: 0.0})
        p[f"{a}→{b}"] = p.get(f"{a}→{b}", 0.0) + tr["amount"]

    pair_settlements = []
    for (x, y), flows in pair.items():
        xy = flows.get(f"{x}→{y}", 0.0)
        yx = flows.get(f"{y}→{x}", 0.0)
        net = xy - yx  # 양수면 x가 y에게 순으로 더 보냄
        if net > 0:
            creditor, debtor, amt = y, x, net   # y가 x에게 순 amt를 덜 돌려줌 → x가 못받음
        elif net < 0:
            creditor, debtor, amt = x, y, -net
        else:
            creditor, debtor, amt = x, y, 0.0
        pair_settlements.append({
            "account_a": x, "account_b": y,
            "a_to_b": xy, "b_to_a": yx,
            "net": abs(net),
            "net_direction": f"{debtor} → {creditor}" if amt else "상계 완료",
            "note": (f"{debtor}이(가) {creditor}에게서 {abs(net):,.0f}원 아직 못 돌려받음"
                     if amt else "기간 내 상호 이체 상계 완료"),
        })
    pair_settlements.sort(key=lambda p: p["net"], reverse=True)

    # 4.5단계: 각 이체에 현금흐름 유형 태깅
    def _role(label: str) -> str:
        return label_role.get(label, "other")

    cf = {
        "reservoir_to_operating": 0.0,  # 매출풀→운영 메꿈 (실질 운영현금 소진)
        "operating_to_reservoir": 0.0,  # 운영→매출풀 회수
        "savings_move": 0.0,            # 적립 이동 (잔액감소 아님)
        "other_move": 0.0,
    }
    for tr in transfers:
        fr, to = _role(tr["from_label"]), _role(tr["to_label"])
        if fr == "savings" or to == "savings":
            ftype = "savings"
            cf["savings_move"] += tr["amount"]
        elif fr == "reservoir" and to == "operating":
            ftype = "topup"
            cf["reservoir_to_operating"] += tr["amount"]
        elif fr == "operating" and to == "reservoir":
            ftype = "sweep"
            cf["operating_to_reservoir"] += tr["amount"]
        else:
            ftype = "other"
            cf["other_move"] += tr["amount"]
        tr["flow_type"] = ftype
        tr["from_role"] = fr
        tr["to_role"] = to

    cf["net_topup"] = cf["reservoir_to_operating"] - cf["operating_to_reservoir"]

    transfers.sort(key=lambda x: (x["date"], x["time"]), reverse=True)
    resolved_cnt = sum(1 for t in transfers if t["resolved"])
    # 순대차 합계 (검증용 — 이론상 0에 수렴, 미상 건 때문에 잔차 가능)
    net_sum = sum(s["net"] for s in summary.values())

    return {
        "period": {"start": start_date.isoformat(), "end": end_date.isoformat()},
        "transfers": transfers,
        "accounts": sorted(summary.values(), key=lambda x: abs(x["net"]), reverse=True),
        "account_totals": {
            "total_sent": sum(s["sent"] for s in summary.values()),
            "total_received": sum(s["received"] for s in summary.values()),
            "net_sum": net_sum,
        },
        "pair_settlements": pair_settlements,
        "cash_flow": cf,
        "account_roles": [
            {"label": a.label, "role": a.role, "role_label": ROLE_LABELS.get(a.role, a.role), "bank": a.bank, "name": a.name}
            for lbl, a in sorted({a.label: a for a in accounts}.items())
        ],
        "role_options": [{"key": k, "label": v} for k, v in ROLE_LABELS.items()],
        "total_amount": sum(t["amount"] for t in transfers),
        "transfer_count": len(transfers),
        "resolved_count": resolved_cnt,
        "unresolved_count": len(transfers) - resolved_cnt,
        "known_accounts": [
            {"label": lbl, "bank": bank, "last4": l4}
            for lbl, bank, l4 in sorted({(a.label, a.bank, a.last4) for a in accounts})
        ],
    }
