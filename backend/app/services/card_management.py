"""
카드 관리 서비스

데이터 소스: 그랜터 EXPENSE_TICKET (cardName으로 카드 식별 + cardUsage로 가맹점/카테고리)
"""
from __future__ import annotations

import logging
import re
from collections import defaultdict
from datetime import date, timedelta
from typing import Any, Dict, List, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.card_alias import CardAlias

logger = logging.getLogger(__name__)


def _extract_card_meta(card_key: str) -> Dict[str, Optional[str]]:
    """'BC카드 — B-Point ····2945' → issuer/last4 추출."""
    if not card_key:
        return {"issuer": None, "last4": None}
    s = card_key.strip()
    # 마지막 4자리 숫자
    m = re.search(r'(\d{4})\D*$', s)
    last4 = m.group(1) if m else None
    # 첫 부분 issuer
    issuer = re.split(r'[—\-—\|]', s, 1)[0].strip()
    return {"issuer": issuer or None, "last4": last4}


def _build_card_key(t: Dict[str, Any]) -> Optional[str]:
    """
    EXPENSE_TICKET → 카드 식별자 문자열.
    그랜터 응답: t.cardUsage.card.{name, number, organizationName}
    """
    cu = t.get("cardUsage") or {}
    card = cu.get("card") or {}
    name = (card.get("name") or "").strip()
    org = (card.get("organizationName") or "").strip()
    number = (card.get("number") or "").strip()
    nickname = (card.get("nickname") or "").strip()
    # 우선순위: org + last4 가 가장 안정적
    last4 = ""
    if number:
        digits = re.sub(r'\D', '', number)
        last4 = digits[-4:] if len(digits) >= 4 else ""
    label = nickname or name or org
    if not label and not last4:
        return None
    if org and last4:
        return f"{org} ({last4})"
    if label and last4:
        return f"{label} ({last4})"
    return label or last4


# 메모리 캐시 (period_key → tickets) — 60초 TTL
import time as _time
_EXPENSE_CACHE: Dict[str, tuple] = {}
_CACHE_TTL = 60.0


async def _fetch_expense_tickets(start_date: date, end_date: date) -> List[Dict[str, Any]]:
    """
    EXPENSE_TICKET 단일 타입만 가져옴 (list_tickets) — 모든 타입 가져오는
    list_tickets_all_types보다 훨씬 빠름. 60초 cache로 중복 호출 절약.
    """
    if (end_date - start_date).days > 30:
        start_date = end_date - timedelta(days=30)

    key = f"{start_date.isoformat()}~{end_date.isoformat()}"
    now = _time.time()
    cached = _EXPENSE_CACHE.get(key)
    if cached and (now - cached[1]) < _CACHE_TTL:
        return cached[0]

    from app.services.granter_client import get_granter_client
    client = get_granter_client()
    try:
        resp = await client.list_tickets({
            "ticketType": "EXPENSE_TICKET",
            "startDate": start_date.isoformat(),
            "endDate": end_date.isoformat(),
        })
        if isinstance(resp, list):
            items = resp
        elif isinstance(resp, dict):
            items = resp.get("data") or resp.get("items") or []
        else:
            items = []
    except Exception:
        logger.exception(f"그랜터 EXPENSE_TICKET 조회 실패 ({start_date}~{end_date})")
        items = []

    _EXPENSE_CACHE[key] = (items, now)
    # 5분 지난 캐시 정리
    for k in list(_EXPENSE_CACHE.keys()):
        if now - _EXPENSE_CACHE[k][1] > 300:
            _EXPENSE_CACHE.pop(k, None)
    return items


async def list_cards(
    db: AsyncSession,
    start_date: Optional[date] = None,
    end_date: Optional[date] = None,
) -> List[Dict[str, Any]]:
    """
    카드 목록 — 그랜터 EXPENSE_TICKET에서 distinct cardName 추출 + alias join.
    기간 미지정 시 최근 31일.
    """
    if not end_date:
        end_date = date.today()
    if not start_date:
        start_date = end_date - timedelta(days=31)
    # 31일 제한
    if (end_date - start_date).days > 30:
        start_date = end_date - timedelta(days=30)

    expense = await _fetch_expense_tickets(start_date, end_date)

    # 카드별 집계 — _build_card_key로 식별자 추출
    by_card: Dict[str, Dict[str, Any]] = {}
    for t in expense:
        cn = _build_card_key(t)
        if not cn:
            continue
        try:
            amt = float(t.get("amount") or 0)
        except (ValueError, TypeError):
            amt = 0.0
        entry = by_card.setdefault(cn, {
            "card_key": cn,
            "total_amount": 0.0,
            "transaction_count": 0,
            "last_used": None,
        })
        entry["total_amount"] += amt
        entry["transaction_count"] += 1
        d = t.get("transactAt") or t.get("createdAt") or ""
        d = str(d)[:10]
        if d and (not entry["last_used"] or d > entry["last_used"]):
            entry["last_used"] = d

    # alias join
    aliases = (await db.execute(select(CardAlias))).scalars().all()
    alias_map = {a.card_key: a for a in aliases}

    result = []
    for card_key, agg in by_card.items():
        alias = alias_map.get(card_key)
        meta = _extract_card_meta(card_key)
        result.append({
            "card_key": card_key,
            "nickname": alias.nickname if alias else None,
            "issuer": (alias.issuer if alias else None) or meta["issuer"],
            "last4": (alias.last4 if alias else None) or meta["last4"],
            "color": alias.color if alias else None,
            "memo": alias.memo if alias else None,
            "is_active": alias.is_active if alias else True,
            "total_amount": agg["total_amount"],
            "transaction_count": agg["transaction_count"],
            "last_used": agg["last_used"],
        })

    # 사용액 큰 순
    result.sort(key=lambda x: x["total_amount"], reverse=True)
    return result


async def upsert_alias(
    db: AsyncSession,
    card_key: str,
    nickname: Optional[str] = None,
    color: Optional[str] = None,
    memo: Optional[str] = None,
    is_active: Optional[bool] = None,
) -> CardAlias:
    """카드 별명/색상/메모 저장 (upsert)."""
    alias = (await db.execute(
        select(CardAlias).where(CardAlias.card_key == card_key)
    )).scalar_one_or_none()
    meta = _extract_card_meta(card_key)
    if alias is None:
        alias = CardAlias(
            card_key=card_key,
            nickname=nickname or card_key,
            issuer=meta["issuer"],
            last4=meta["last4"],
            color=color,
            memo=memo,
            is_active=is_active if is_active is not None else True,
        )
        db.add(alias)
    else:
        if nickname is not None:
            alias.nickname = nickname
        if color is not None:
            alias.color = color
        if memo is not None:
            alias.memo = memo
        if is_active is not None:
            alias.is_active = is_active
    await db.commit()
    await db.refresh(alias)
    return alias


async def get_card_analysis(
    db: AsyncSession,
    card_key: str,
    start_date: date,
    end_date: date,
) -> Dict[str, Any]:
    """
    카드 사용 분석 — 가맹점별/카테고리별 top + 일별 합계.
    그랜터 EXPENSE_TICKET 기반.
    """
    if (end_date - start_date).days > 30:
        start_date = end_date - timedelta(days=30)

    expense = await _fetch_expense_tickets(start_date, end_date)

    # card_key 매칭만
    cards = [t for t in expense if _build_card_key(t) == card_key]

    def _amt(t: Dict[str, Any]) -> float:
        try:
            return float(t.get("amount") or 0)
        except (ValueError, TypeError):
            return 0.0

    def _date(t: Dict[str, Any]) -> Optional[str]:
        d = t.get("transactAt") or t.get("createdAt") or ""
        s = str(d)[:10]
        return s or None

    # 가맹점별 집계
    by_store: Dict[str, Dict[str, Any]] = defaultdict(lambda: {"total": 0.0, "count": 0, "category": ""})
    by_category: Dict[str, float] = defaultdict(float)
    by_date: Dict[str, float] = defaultdict(float)

    for t in cards:
        cu = t.get("cardUsage") or {}
        store = (cu.get("storeName") or "(미지정)").strip()
        category = (cu.get("category") or "기타").strip()
        amt = _amt(t)
        d = _date(t)
        by_store[store]["total"] += amt
        by_store[store]["count"] += 1
        by_store[store]["category"] = category
        by_category[category] += amt
        if d:
            by_date[d] += amt

    # top stores
    top_stores = sorted(
        [{"store": k, **v} for k, v in by_store.items()],
        key=lambda x: x["total"], reverse=True,
    )[:20]

    # top categories
    top_categories = sorted(
        [{"category": k, "total": v} for k, v in by_category.items()],
        key=lambda x: x["total"], reverse=True,
    )

    # 일별 timeline (모든 날짜 포함, 없으면 0)
    timeline = []
    cur = start_date
    while cur <= end_date:
        d_iso = cur.isoformat()
        timeline.append({"date": d_iso, "amount": by_date.get(d_iso, 0.0)})
        cur += timedelta(days=1)

    total = sum(_amt(t) for t in cards)
    count = len(cards)

    return {
        "card_key": card_key,
        "period": {"start": start_date.isoformat(), "end": end_date.isoformat()},
        "total_amount": total,
        "transaction_count": count,
        "avg_per_transaction": (total / count) if count else 0,
        "top_stores": top_stores,
        "top_categories": top_categories,
        "timeline": timeline,
    }


async def get_monthly_summary(
    db: AsyncSession,
    card_key: Optional[str] = None,
    months: int = 6,
) -> List[Dict[str, Any]]:
    """
    월별 카드 사용액 — card_key=None면 전체 카드.
    그랜터 31일 제한 때문에 월 단위로 N번 호출.
    """
    today = date.today()
    result = []

    for offset in range(months):
        # 월 시작/끝 계산
        target_month_end = today.replace(day=1) - timedelta(days=offset * 30)
        m_start = target_month_end.replace(day=1)
        # 다음 달 1일 - 1일
        if m_start.month == 12:
            next_m = m_start.replace(year=m_start.year + 1, month=1)
        else:
            next_m = m_start.replace(month=m_start.month + 1)
        m_end = min(next_m - timedelta(days=1), today)

        expense = await _fetch_expense_tickets(m_start, m_end)

        month_total = 0.0
        count = 0
        for t in expense:
            cn = _build_card_key(t)
            if card_key and cn != card_key:
                continue
            try:
                month_total += float(t.get("amount") or 0)
            except (ValueError, TypeError):
                pass
            count += 1
        result.append({
            "month": m_start.strftime('%Y-%m'),
            "total": month_total,
            "count": count,
        })

    result.reverse()  # 오래된 달이 앞으로
    return result
