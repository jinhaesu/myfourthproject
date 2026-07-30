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
from app.models.card_classification import CardUsageClassification, CardMonthlyClosing

logger = logging.getLogger(__name__)


async def get_assigned_card_keys(db: AsyncSession, email: str) -> List[str]:
    """이메일에 배정된 카드 key 목록."""
    rows = (await db.execute(
        select(CardAlias.card_key).where(CardAlias.assigned_email == email.lower())
    )).scalars().all()
    return list(rows)


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
    # 'BC카드 (2950)' 처럼 뒤에 붙은 (last4)는 issuer에서 제거 (last4로 별도 표시됨)
    issuer = re.sub(r'\s*\(\d{3,4}\)\s*$', '', issuer).strip()
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


def _build_card_key_from_asset(a: Dict[str, Any]) -> Optional[str]:
    """
    그랜터 CARD 자산 → 거래 기반(_build_card_key)과 동일 포맷의 카드 식별자.
    자산은 식별 필드가 최상위(name/nickname/number/organizationName)에 있음
    (card 서브객체는 비어있음). 거래키와 dedup되도록 org+last4 우선순위를 맞춘다.
    """
    org = (a.get("organizationName") or "").strip()
    number = (a.get("number") or "").strip()
    name = (a.get("name") or "").strip()
    nickname = (a.get("nickname") or "").strip()
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


# 메모리 캐시 (period_key → tickets) — granter_client와 동일한 5분 TTL
# (TTL이 경로마다 다르면 같은 기간 조회가 화면마다 다른 스냅샷을 볼 수 있음)
import time as _time
_EXPENSE_CACHE: Dict[str, tuple] = {}
_CACHE_TTL = 300.0


async def _fetch_expense_tickets(start_date: date, end_date: date) -> List[Dict[str, Any]]:
    """
    EXPENSE_TICKET 단일 타입 — 31일 초과 기간은 자동 분할 조회(list_tickets_single).
    긴 기간(수개월)도 조회 가능. 5분 cache로 중복 호출 절약.
    """
    key = f"{start_date.isoformat()}~{end_date.isoformat()}"
    now = _time.time()
    cached = _EXPENSE_CACHE.get(key)
    if cached and (now - cached[1]) < _CACHE_TTL:
        return cached[0]

    from app.services.granter_client import get_granter_client
    client = get_granter_client()
    try:
        items = await client.list_tickets_single(
            "EXPENSE_TICKET", start_date.isoformat(), end_date.isoformat(),
        )
    except Exception:
        logger.exception(f"그랜터 EXPENSE_TICKET 조회 실패 ({start_date}~{end_date})")
        items = []

    # 취소/거절 건 제외 — paymentStatus가 정상(NORMAL)이 아닌 카드사용은 실지출이 아님.
    from app.services.granter_client import filter_normal_card_tickets
    items = filter_normal_card_tickets(items, f"card_management {start_date}~{end_date}")

    _EXPENSE_CACHE[key] = (items, now)
    # 5분 지난 캐시 정리
    for k in list(_EXPENSE_CACHE.keys()):
        if now - _EXPENSE_CACHE[k][1] > 300:
            _EXPENSE_CACHE.pop(k, None)
    return items


# 활성 CARD 자산 캐시 (그랜터 연동됐지만 최근 거래 없는 카드도 노출용)
_ASSET_CACHE: Dict[str, tuple] = {}


async def _fetch_active_card_assets() -> List[Dict[str, Any]]:
    """
    그랜터 활성 CARD 자산 목록. 거래내역이 없어도 연동만 돼 있으면 카드 목록에 노출.
    CARD 단일 assetType만 조회(list_all_assets 6종 순차호출보다 가벼움). 5분 캐시.
    """
    key = "active_card"
    now = _time.time()
    cached = _ASSET_CACHE.get(key)
    if cached and (now - cached[1]) < _CACHE_TTL:
        return cached[0]

    from app.services.granter_client import get_granter_client
    client = get_granter_client()
    try:
        r = await client.list_assets({"assetType": "CARD"})
        items = r if isinstance(r, list) else (r.get("data", []) if isinstance(r, dict) else [])
        # 활성 + 비휴면 + 비숨김만
        items = [
            a for a in items
            if a.get("isActive", True) and not a.get("isHidden", False)
            and not a.get("isDormant", False)
        ]
    except Exception:
        logger.exception("그랜터 활성 CARD 자산 조회 실패")
        items = []

    _ASSET_CACHE[key] = (items, now)
    return items


async def list_cards(
    db: AsyncSession,
    start_date: Optional[date] = None,
    end_date: Optional[date] = None,
    only_assigned_to: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """
    카드 목록 — 그랜터 EXPENSE_TICKET에서 distinct cardName 추출 + alias join.
    기간 미지정 시 최근 31일.
    only_assigned_to: 이메일 지정 시 해당 이메일에 배정된 카드만 반환 (직원용).
    """
    if not end_date:
        end_date = date.today()
    if not start_date:
        start_date = end_date - timedelta(days=31)
    # 긴 기간은 _fetch_expense_tickets가 자동 분할 조회

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

    # 연동 카드 병합 — 거래는 없지만 그랜터에 활성 연동된 카드도 목록에 노출(관리자용).
    # only_assigned_to(직원용)는 배정 카드만 봐야 하므로 자산 병합/추가 호출 생략.
    asset_keys: set = set()
    if not only_assigned_to:
        try:
            for a in await _fetch_active_card_assets():
                ak = _build_card_key_from_asset(a)
                if not ak:
                    continue
                asset_keys.add(ak)
                by_card.setdefault(ak, {
                    "card_key": ak,
                    "total_amount": 0.0,
                    "transaction_count": 0,
                    "last_used": None,
                })
        except Exception:
            logger.exception("활성 CARD 자산 병합 실패 — 거래 기반 목록만 반환")

    # alias join
    aliases = (await db.execute(select(CardAlias))).scalars().all()
    alias_map = {a.card_key: a for a in aliases}

    # 직원용: 배정된 카드만 (사용내역 없어도 배정 카드는 표시)
    if only_assigned_to:
        email_lower = only_assigned_to.lower()
        assigned_keys = {
            a.card_key for a in aliases
            if (a.assigned_email or "").lower() == email_lower
        }
        by_card = {k: v for k, v in by_card.items() if k in assigned_keys}
        for k in assigned_keys:
            by_card.setdefault(k, {
                "card_key": k, "total_amount": 0.0,
                "transaction_count": 0, "last_used": None,
            })

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
            "assigned_email": alias.assigned_email if alias else None,
            "total_amount": agg["total_amount"],
            "transaction_count": agg["transaction_count"],
            "last_used": agg["last_used"],
            # 그랜터에 활성 연동된 카드 (거래 유무와 무관하게 연동 확인됨)
            "connected": card_key in asset_keys,
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


async def assign_card(
    db: AsyncSession,
    card_key: str,
    email: Optional[str],
) -> CardAlias:
    """카드를 이메일에 배정 (email=None이면 배정 해제). 관리자 전용에서 호출."""
    alias = (await db.execute(
        select(CardAlias).where(CardAlias.card_key == card_key)
    )).scalar_one_or_none()
    if alias is None:
        meta = _extract_card_meta(card_key)
        alias = CardAlias(
            card_key=card_key,
            nickname=card_key,
            issuer=meta["issuer"],
            last4=meta["last4"],
            is_active=True,
        )
        db.add(alias)
    alias.assigned_email = email.lower().strip() if email else None
    await db.commit()
    await db.refresh(alias)
    return alias


async def list_transactions(
    db: AsyncSession,
    card_key: str,
    start_date: date,
    end_date: date,
) -> List[Dict[str, Any]]:
    """
    카드 사용내역 건별 목록 + 분류(있으면) 조인.
    그랜터 EXPENSE_TICKET 실시간 조회 기반. 최신순 정렬. 긴 기간 자동 분할.
    """
    expense = await _fetch_expense_tickets(start_date, end_date)
    tickets = [t for t in expense if _build_card_key(t) == card_key]

    ticket_ids = [str(t.get("id")) for t in tickets if t.get("id") is not None]
    cls_map: Dict[str, CardUsageClassification] = {}
    if ticket_ids:
        rows = (await db.execute(
            select(CardUsageClassification).where(
                CardUsageClassification.ticket_id.in_(ticket_ids)
            )
        )).scalars().all()
        cls_map = {c.ticket_id: c for c in rows}

    result = []
    for t in tickets:
        tid = str(t.get("id")) if t.get("id") is not None else None
        cu = t.get("cardUsage") or {}
        try:
            amt = float(t.get("amount") or 0)
        except (ValueError, TypeError):
            amt = 0.0
        cls = cls_map.get(tid) if tid else None
        result.append({
            "ticket_id": tid,
            "transact_at": str(t.get("transactAt") or t.get("createdAt") or "")[:19],
            "store_name": (cu.get("storeName") or "").strip() or None,
            "granter_category": (cu.get("category") or "").strip() or None,
            "amount": amt,
            "classification": {
                "category": cls.category,
                "account_code": cls.account_code,
                "account_name": cls.account_name,
                "memo": cls.memo,
                "classified_by": cls.classified_by,
                "updated_at": cls.updated_at.isoformat() if cls.updated_at else None,
            } if cls else None,
        })

    result.sort(key=lambda x: x["transact_at"] or "", reverse=True)
    return result


async def classify_transaction(
    db: AsyncSession,
    ticket_id: str,
    card_key: str,
    category: str,
    memo: Optional[str],
    classified_by: str,
    account_code: Optional[str] = None,
    account_name: Optional[str] = None,
    transact_at: Optional[str] = None,
    store_name: Optional[str] = None,
    amount: Optional[float] = None,
) -> CardUsageClassification:
    """카드 사용 건 분류 저장 (upsert) — 원장 계정 기준."""
    cls = (await db.execute(
        select(CardUsageClassification).where(
            CardUsageClassification.ticket_id == ticket_id
        )
    )).scalar_one_or_none()
    if cls is None:
        cls = CardUsageClassification(
            ticket_id=ticket_id,
            card_key=card_key,
            category=category,
            account_code=account_code,
            account_name=account_name,
            memo=memo,
            classified_by=classified_by,
            transact_at=transact_at,
            store_name=store_name,
            amount=amount,
        )
        db.add(cls)
    else:
        cls.category = category
        cls.account_code = account_code
        cls.account_name = account_name
        cls.memo = memo
        cls.classified_by = classified_by
        if transact_at:
            cls.transact_at = transact_at
        if store_name:
            cls.store_name = store_name
        if amount is not None:
            cls.amount = amount
    await db.commit()
    await db.refresh(cls)
    return cls


# ==================== 월별 분류 마감 ====================

def _month_range(month: str) -> tuple:
    """'YYYY-MM' → (1일, 말일)"""
    y, m = int(month[:4]), int(month[5:7])
    start = date(y, m, 1)
    end = (date(y + 1, 1, 1) if m == 12 else date(y, m + 1, 1)) - timedelta(days=1)
    return start, min(end, date.today())


async def get_closing(
    db: AsyncSession, card_key: str, month: str,
) -> Optional[CardMonthlyClosing]:
    return (await db.execute(
        select(CardMonthlyClosing).where(
            CardMonthlyClosing.card_key == card_key,
            CardMonthlyClosing.month == month,
        )
    )).scalar_one_or_none()


async def close_month(
    db: AsyncSession, card_key: str, month: str, closed_by: str,
) -> CardMonthlyClosing:
    """월 마감 — 그 달 사용내역이 전건 분류되어 있어야 함.

    Raises:
        ValueError: 미분류 건 존재 (메시지에 건수 포함)
    """
    import json as _json

    existing = await get_closing(db, card_key, month)
    if existing:
        raise ValueError("이미 마감된 월입니다.")

    start, end = _month_range(month)
    txs = await list_transactions(db, card_key, start, end)
    unclassified = [t for t in txs if t["ticket_id"] and not t["classification"]]
    if unclassified:
        raise ValueError(f"미분류 {len(unclassified)}건이 남아 있습니다. 전건 분류 후 마감할 수 있습니다.")

    by_category: Dict[str, float] = defaultdict(float)
    total = 0.0
    for t in txs:
        total += t["amount"] or 0
        if t["classification"]:
            by_category[t["classification"]["category"]] += t["amount"] or 0

    closing = CardMonthlyClosing(
        card_key=card_key,
        month=month,
        transaction_count=len(txs),
        total_amount=total,
        category_summary=_json.dumps(dict(by_category), ensure_ascii=False),
        closed_by=closed_by,
    )
    db.add(closing)
    await db.commit()
    await db.refresh(closing)
    return closing


async def list_closings(
    db: AsyncSession,
    month: Optional[str] = None,
    only_card_keys: Optional[List[str]] = None,
) -> List[Dict[str, Any]]:
    """마감 목록 — month 필터, 직원은 본인 카드만."""
    import json as _json

    stmt = select(CardMonthlyClosing)
    if month:
        stmt = stmt.where(CardMonthlyClosing.month == month)
    if only_card_keys is not None:
        stmt = stmt.where(CardMonthlyClosing.card_key.in_(only_card_keys or ["__none__"]))
    stmt = stmt.order_by(CardMonthlyClosing.month.desc(), CardMonthlyClosing.card_key)
    rows = (await db.execute(stmt)).scalars().all()
    return [
        {
            "id": c.id,
            "card_key": c.card_key,
            "month": c.month,
            "transaction_count": c.transaction_count,
            "total_amount": c.total_amount,
            "category_summary": _json.loads(c.category_summary) if c.category_summary else {},
            "closed_by": c.closed_by,
            "closed_at": c.closed_at.isoformat() if c.closed_at else None,
        }
        for c in rows
    ]


async def reopen_closing(db: AsyncSession, closing_id: int) -> bool:
    """마감 해제 (관리자 전용) — 직원이 분류를 수정할 수 있게 됨."""
    c = (await db.execute(
        select(CardMonthlyClosing).where(CardMonthlyClosing.id == closing_id)
    )).scalar_one_or_none()
    if not c:
        return False
    await db.delete(c)
    await db.commit()
    return True


async def get_card_analysis(
    db: AsyncSession,
    card_key: str,
    start_date: date,
    end_date: date,
) -> Dict[str, Any]:
    """
    카드 사용 분석 — 가맹점별/카테고리별 top + 일별 합계.
    그랜터 EXPENSE_TICKET 기반. 긴 기간 자동 분할.
    """
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
