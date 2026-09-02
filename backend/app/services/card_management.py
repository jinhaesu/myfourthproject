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


def _alias_emails(alias: "CardAlias") -> List[str]:
    """카드에 배정된 이메일 목록 (공동관리 다중 배정). assigned_emails(JSON) 우선, 없으면 assigned_email."""
    import json as _json
    emails: List[str] = []
    raw = getattr(alias, "assigned_emails", None)
    if raw:
        try:
            parsed = _json.loads(raw)
            if isinstance(parsed, list):
                emails = [str(e).strip().lower() for e in parsed if e and str(e).strip()]
        except (ValueError, TypeError):
            emails = []
    if not emails and alias.assigned_email:
        emails = [alias.assigned_email.strip().lower()]
    # dedup, 순서 보존
    seen: set = set()
    out: List[str] = []
    for e in emails:
        if e and e not in seen:
            seen.add(e)
            out.append(e)
    return out


async def get_assigned_card_keys(db: AsyncSession, email: str) -> List[str]:
    """이메일에 배정된 카드 key 목록 (공동관리 다중 배정 포함)."""
    email_l = (email or "").strip().lower()
    if not email_l:
        return []
    aliases = (await db.execute(select(CardAlias))).scalars().all()
    return [a.card_key for a in aliases if email_l in _alias_emails(a)]


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


def _legacy_card_key_from_fields(
    org: Optional[str], number: Optional[str],
    name: Optional[str], nickname: Optional[str],
) -> Optional[str]:
    """
    (구) 카드 식별자 — 'org (last4)' 문자열. 뒷4자리 충돌 위험이 있어 신규 키에는
    쓰지 않지만, 기존 저장 키 마이그레이션 매핑과 id 없는 응답 폴백용으로 보존.
    """
    org = (org or "").strip()
    number = (number or "").strip()
    name = (name or "").strip()
    nickname = (nickname or "").strip()
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


def _meta_from_fields(
    org: Optional[str], number: Optional[str],
    name: Optional[str], nickname: Optional[str],
) -> Dict[str, Optional[str]]:
    """카드 표시용 메타(issuer=발급사, last4=뒷4자리). 키가 id로 바뀌어 키 파싱 대신 사용."""
    org = (org or "").strip()
    last4 = None
    if number:
        d = re.sub(r'\D', '', str(number))
        last4 = d[-4:] if len(d) >= 4 else None
    return {"issuer": org or None, "last4": last4}


def _build_card_key(t: Dict[str, Any]) -> Optional[str]:
    """
    EXPENSE_TICKET → 카드 식별자.
    그랜터 카드 자산 id(cardUsage.card.id)를 최우선 사용 — 뒷4자리 충돌을 원천 차단하고
    번호 마스킹 변화에도 안정적. id가 없을 때만 legacy(org+last4) 문자열로 폴백.
    """
    cu = t.get("cardUsage") or {}
    card = cu.get("card") or {}
    cid = card.get("id")
    if cid is not None:
        return str(cid)
    return _legacy_card_key_from_fields(
        card.get("organizationName"), card.get("number"),
        card.get("name"), card.get("nickname"),
    )


def _card_meta_from_ticket(t: Dict[str, Any]) -> Dict[str, Optional[str]]:
    card = (t.get("cardUsage") or {}).get("card") or {}
    return _meta_from_fields(
        card.get("organizationName"), card.get("number"),
        card.get("name"), card.get("nickname"),
    )


def _build_card_key_from_asset(a: Dict[str, Any]) -> Optional[str]:
    """
    그랜터 CARD 자산 → 카드 식별자. 자산 id를 최우선 사용(거래 cardUsage.card.id와 동일 체계),
    id 없으면 legacy 폴백. 거래키와 동일 id를 반환하므로 중복 없이 dedup된다.
    """
    cid = a.get("id")
    if cid is not None:
        return str(cid)
    return _legacy_card_key_from_fields(
        a.get("organizationName"), a.get("number"),
        a.get("name"), a.get("nickname"),
    )


def _card_meta_from_asset(a: Dict[str, Any]) -> Dict[str, Optional[str]]:
    return _meta_from_fields(
        a.get("organizationName"), a.get("number"),
        a.get("name"), a.get("nickname"),
    )


# 메모리 캐시 (period_key → tickets) — granter_client와 동일한 5분 TTL
# (TTL이 경로마다 다르면 같은 기간 조회가 화면마다 다른 스냅샷을 볼 수 있음)
import time as _time
_EXPENSE_CACHE: Dict[str, tuple] = {}
_CACHE_TTL = 300.0


async def _fetch_expense_tickets(db: AsyncSession, start_date: date, end_date: date) -> List[Dict[str, Any]]:
    """
    카드 사용내역 — 하이픈 카드원장 단일소스(DB 즉시, 그랜터 미사용).
    hyphen_card_tx를 그랜터 EXPENSE_TICKET 형태로 정규화. 5분 cache로 중복 조회 절약.
    """
    now = _time.time()
    from app.services import hyphen_sync_ext as _hy
    hkey = f"HY|{start_date.isoformat()}~{end_date.isoformat()}"
    cached = _EXPENSE_CACHE.get(hkey)
    if cached and (now - cached[1]) < _CACHE_TTL:
        return cached[0]
    # 커버 안 된 구간만 1회 당김 — 이미 본 범위는 외부 API 재호출 없음(DB 즉시)
    try:
        await _hy.ensure_card_coverage(db, start_date=start_date.isoformat(), end_date=end_date.isoformat())
    except Exception:
        logger.exception("카드 커버리지 확보 스킵")
    items = await _hy.card_tickets_as_expense(
        db, start_date=start_date.isoformat(), end_date=end_date.isoformat(),
    )
    _EXPENSE_CACHE[hkey] = (items, now)
    for k in list(_EXPENSE_CACHE.keys()):
        if now - _EXPENSE_CACHE[k][1] > 300:
            _EXPENSE_CACHE.pop(k, None)
    return items


# 활성 CARD 자산 캐시 (그랜터 연동됐지만 최근 거래 없는 카드도 노출용)
_ASSET_CACHE: Dict[str, tuple] = {}


async def _fetch_active_card_assets(db: Optional[AsyncSession] = None) -> List[Dict[str, Any]]:
    """등록 법인카드(하이픈 HyphenCardAccount) 목록 — 거래 없어도 노출. 그랜터 미사용.
    id=_card_key(거래 cardUsage.card.id와 동일 체계)라 dedup됨."""
    if db is None:
        return []
    from app.services import hyphen_sync_ext as _hy
    from app.models.hyphen_ext import HyphenCardAccount
    rows = (await db.execute(select(HyphenCardAccount))).scalars().all()
    items: List[Dict[str, Any]] = []
    for a in rows:
        issuer = _hy.CARD_ISSUER_NM.get(a.card_cd, a.card_cd)
        items.append({
            "id": _hy._card_key(a.card_cd, a.card_no),
            "organizationName": issuer,
            "number": _hy._masked_no(a.card_no),
            "name": a.label or None,
            "nickname": a.label or None,
        })
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

    # 하이픈 소스 전환 시 배정/별칭/분류 키를 뒷4자리로 이관(멱등, 최초 1회만 실제 이동)
    try:
        from app.services import hyphen_sync_ext as _hy
        if await _hy.has_hyphen_cards(db):
            await _hy.rekey_card_aliases_by_last4(db)
    except Exception:
        logger.exception("카드 별칭 키 이관 스킵")

    expense = await _fetch_expense_tickets(db, start_date, end_date)

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
            "_meta": None,
        })
        if not entry.get("_meta"):
            entry["_meta"] = _card_meta_from_ticket(t)
        entry["total_amount"] += amt
        entry["transaction_count"] += 1
        d = t.get("transactAt") or t.get("createdAt") or ""
        d = str(d)[:10]
        if d and (not entry["last_used"] or d > entry["last_used"]):
            entry["last_used"] = d

    # 등록 카드(하이픈 계정) 병합 — 거래 없어도 등록 카드는 노출.
    # 자연 규칙: 카드는 (해당 기간에 거래가 있음) 또는 (현재 하이픈에 등록됨)일 때만 목록에 나타남.
    # → 연동 삭제된 카드는 거래가 있는 기간을 조회하면 보이고, 거래 없는 기간엔 자연히 사라짐.
    #   과거 분류·월마감 데이터는 DB에 그대로 보존됨.
    registered_keys: set = set()
    try:
        for a in await _fetch_active_card_assets(db):
            ak = _build_card_key_from_asset(a)
            if not ak:
                continue
            registered_keys.add(ak)
            entry = by_card.setdefault(ak, {
                "card_key": ak, "total_amount": 0.0,
                "transaction_count": 0, "last_used": None, "_meta": None,
            })
            if not entry.get("_meta"):
                entry["_meta"] = _card_meta_from_asset(a)
    except Exception:
        logger.exception("활성 CARD 자산 병합 실패 — 거래 기반 목록만 반환")
    asset_keys = registered_keys

    # alias join
    aliases = (await db.execute(select(CardAlias))).scalars().all()
    alias_map = {a.card_key: a for a in aliases}

    # 직원용: 배정된 카드 중 (거래 있거나 등록된) 것만. 공동관리 다중 배정 포함.
    # 배정만 되고 등록 해제 + 해당 기간 거래도 없는 카드는 자연 규칙대로 표시 안 함.
    if only_assigned_to:
        email_lower = only_assigned_to.lower()
        assigned_keys = {
            a.card_key for a in aliases
            if email_lower in _alias_emails(a)
        }
        by_card = {k: v for k, v in by_card.items() if k in assigned_keys}

    result = []
    for card_key, agg in by_card.items():
        alias = alias_map.get(card_key)
        # 표시 메타는 거래/자산에서 캐리한 값 사용 (키가 id로 바뀌어 키 파싱 불가).
        # 배정만 되고 메타 없는 경우 alias에 저장된 issuer/last4로 폴백.
        meta = agg.get("_meta") or {"issuer": None, "last4": None}
        result.append({
            "card_key": card_key,
            "nickname": alias.nickname if alias else None,
            "issuer": (alias.issuer if alias else None) or meta.get("issuer"),
            "last4": (alias.last4 if alias else None) or meta.get("last4"),
            "color": alias.color if alias else None,
            "memo": alias.memo if alias else None,
            "is_active": alias.is_active if alias else True,
            "assigned_email": alias.assigned_email if alias else None,
            "assigned_emails": _alias_emails(alias) if alias else [],
            "total_amount": agg["total_amount"],
            "transaction_count": agg["transaction_count"],
            "last_used": agg["last_used"],
            # 그랜터에 활성 연동된 카드 (거래 유무와 무관하게 연동 확인됨)
            "connected": card_key in asset_keys,
        })

    # 사용액 큰 순
    result.sort(key=lambda x: x["total_amount"], reverse=True)
    return result


async def migrate_card_keys(
    db: AsyncSession,
    manual_map: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    """
    기존 card_key(legacy 'org (last4)' 문자열) → 그랜터 카드 id 문자열로 이관. 멱등.

    - 그랜터 전체 CARD 자산으로 legacy_key→id 매핑 구성(고유 매핑만 사용).
    - 뒷4자리 충돌로 legacy_key가 2개 이상 id에 매핑되면 모호 → 건너뜀(해당 키에
      배정/마감이 있으면 skipped_ambiguous로 보고).
    - manual_map {legacy_key: id}가 주어지면 해당 키는 그 id로 강제 이관(모호 해소용).
    - 이미 id 형태인 키는 already_id로 건너뜀.
    - 대상 id에 이미 다른 alias가 있으면 unique 충돌 방지 위해 건너뜀.
    - 부수적으로 alias.issuer 말미의 중복 '(last4)'도 정리.
    """
    manual = {k: str(v) for k, v in (manual_map or {}).items()}
    from app.services.granter_client import get_granter_client
    client = get_granter_client()
    try:
        r = await client.list_assets({"assetType": "CARD"})
        items = r if isinstance(r, list) else (r.get("data", []) if isinstance(r, dict) else [])
    except Exception:
        logger.exception("migrate_card_keys: 자산 조회 실패")
        items = []

    id_set: set = set()
    legacy_to_ids: Dict[str, set] = {}
    for a in items:
        cid = a.get("id")
        if cid is None:
            continue
        sid = str(cid)
        id_set.add(sid)
        lk = _legacy_card_key_from_fields(
            a.get("organizationName"), a.get("number"),
            a.get("name"), a.get("nickname"),
        )
        if lk:
            legacy_to_ids.setdefault(lk, set()).add(sid)

    def resolve(old_key: str) -> Optional[str]:
        forced = manual.get(old_key)
        if forced and forced in id_set:
            return forced
        ids = legacy_to_ids.get(old_key)
        if ids and len(ids) == 1:
            return next(iter(ids))
        return None

    report = {
        "assets_scanned": len(id_set),
        "aliases": {"updated": 0, "already_id": 0, "skipped_ambiguous": 0,
                     "skipped_unmatched": 0, "skipped_target_taken": 0, "issuer_cleaned": 0},
        "closings": {"updated": 0, "already_id": 0, "skipped": 0},
        "ambiguous_details": [],   # 수동 재배정 필요한 별칭 상세
    }

    aliases = (await db.execute(select(CardAlias))).scalars().all()
    existing_id_keys = {a.card_key for a in aliases if a.card_key in id_set}
    for al in aliases:
        # issuer 중복 (last4) 정리 (키 이관과 무관하게 표시 개선)
        if al.issuer:
            cleaned = re.sub(r'\s*\(\d{3,4}\)\s*$', '', al.issuer).strip()
            if cleaned != al.issuer:
                al.issuer = cleaned or None
                report["aliases"]["issuer_cleaned"] += 1
        k = al.card_key or ""
        if k in id_set:
            report["aliases"]["already_id"] += 1
            continue
        nid = resolve(k)
        if nid is None:
            cand_ids = sorted(legacy_to_ids.get(k) or [])
            if len(cand_ids) > 1:
                report["aliases"]["skipped_ambiguous"] += 1
                # 후보 카드들의 이름을 붙여 어느 물리 카드인지 사용자가 고를 수 있게
                cands = []
                for x in items:
                    if str(x.get("id")) in cand_ids:
                        cands.append({
                            "id": str(x.get("id")),
                            "name": (str(x.get("name") or "").split("|")[0].strip()),
                            "number": x.get("number"),
                        })
                report["ambiguous_details"].append({
                    "card_key": k,
                    "nickname": al.nickname,
                    "assigned_email": al.assigned_email,
                    "candidates": cands,
                })
            else:
                report["aliases"]["skipped_unmatched"] += 1
            continue
        if nid in existing_id_keys:
            report["aliases"]["skipped_target_taken"] += 1
            continue
        al.card_key = nid
        existing_id_keys.add(nid)
        report["aliases"]["updated"] += 1

    closings = (await db.execute(select(CardMonthlyClosing))).scalars().all()
    for cl in closings:
        k = cl.card_key or ""
        if k in id_set:
            report["closings"]["already_id"] += 1
            continue
        nid = resolve(k)
        if nid is None:
            report["closings"]["skipped"] += 1
            continue
        cl.card_key = nid
        report["closings"]["updated"] += 1

    # 카드 사용 분류(card_key 비정규화 컬럼) — 관리자 집계/엑셀 조인이 id 기준으로 맞도록 이관.
    # (분류는 ticket_id로 조인되므로 기능엔 영향 없지만, 배정직원/카드 표시 일치를 위해 정리)
    report["classifications"] = {"updated": 0, "already_id": 0, "skipped": 0}
    cls_rows = (await db.execute(select(CardUsageClassification))).scalars().all()
    for c in cls_rows:
        k = c.card_key or ""
        if k in id_set:
            report["classifications"]["already_id"] += 1
            continue
        nid = resolve(k)
        if nid is None:
            report["classifications"]["skipped"] += 1
            continue
        c.card_key = nid
        report["classifications"]["updated"] += 1

    # 구매요청 결제완료 카드(card_key) — 대사 매칭이 id 기준으로 유지되도록 함께 이관
    from app.models.purchase import PurchaseRequest
    report["purchase_requests"] = {"updated": 0, "already_id": 0, "skipped": 0, "empty": 0}
    reqs = (await db.execute(
        select(PurchaseRequest).where(PurchaseRequest.card_key.isnot(None))
    )).scalars().all()
    for req in reqs:
        k = req.card_key or ""
        if not k:
            report["purchase_requests"]["empty"] += 1
            continue
        if k in id_set:
            report["purchase_requests"]["already_id"] += 1
            continue
        nid = resolve(k)
        if nid is None:
            report["purchase_requests"]["skipped"] += 1
            continue
        req.card_key = nid
        report["purchase_requests"]["updated"] += 1

    await db.commit()
    return report


async def _resolve_card_meta(card_key: str, db: Optional[AsyncSession] = None) -> Dict[str, Optional[str]]:
    """
    card_key(하이픈 _card_key 또는 legacy)에 대한 표시 메타(issuer/last4/label) 조회.
    하이픈 등록 카드에서 매칭해 발급사/뒷4자리/라벨을 뽑는다.
    """
    if card_key and db is not None:
        try:
            for a in await _fetch_active_card_assets(db):
                if str(a.get("id")) == card_key:
                    meta = _meta_from_fields(
                        a.get("organizationName"), a.get("number"),
                        a.get("name"), a.get("nickname"),
                    )
                    label = (a.get("nickname") or a.get("name")
                             or a.get("organizationName") or card_key)
                    meta["label"] = str(label).split("|")[0].strip() or card_key
                    return meta
        except Exception:
            logger.exception("_resolve_card_meta 자산 조회 실패 (%s)", card_key)
    m = _extract_card_meta(card_key)
    m["label"] = m.get("issuer") or card_key
    return m


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
    meta = await _resolve_card_meta(card_key, db)
    if alias is None:
        alias = CardAlias(
            card_key=card_key,
            nickname=nickname or meta.get("label") or card_key,
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
    email: Optional[str] = None,
    emails: Optional[List[str]] = None,
) -> CardAlias:
    """
    카드를 이메일에 배정 (관리자 전용). 공동관리 다중 배정 지원.
    - emails 지정 시: 그 목록 전체로 배정(빈 목록이면 해제).
    - email만 지정 시: 하위호환 단일 배정.
    assigned_emails(JSON 리스트)에 저장하고, assigned_email엔 대표(첫 번째)를 보관.
    """
    import json as _json
    alias = (await db.execute(
        select(CardAlias).where(CardAlias.card_key == card_key)
    )).scalar_one_or_none()
    if alias is None:
        meta = await _resolve_card_meta(card_key, db)
        alias = CardAlias(
            card_key=card_key,
            nickname=meta.get("label") or card_key,
            issuer=meta["issuer"],
            last4=meta["last4"],
            is_active=True,
        )
        db.add(alias)

    if emails is not None:
        raw_list = emails
    elif email is not None:
        raw_list = [email] if email else []
    else:
        raw_list = _alias_emails(alias)  # 변경 없음

    # 정규화 + dedup
    seen: set = set()
    norm: List[str] = []
    for e in raw_list:
        v = (e or "").strip().lower()
        if v and v not in seen:
            seen.add(v)
            norm.append(v)

    alias.assigned_emails = _json.dumps(norm) if norm else None
    alias.assigned_email = norm[0] if norm else None
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
    expense = await _fetch_expense_tickets(db, start_date, end_date)
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


async def export_month_classifications(
    db: AsyncSession,
    month: str,
    only_keys: Optional[List[str]] = None,
) -> List[Dict[str, Any]]:
    """
    한 달(YYYY-MM) 전체 카드 분류 라인아이템 — 관리자 엑셀 다운로드용.
    CardUsageClassification(transact_at LIKE 'YYYY-MM%') + 카드 별칭/배정자 + 마감여부 조인.
    only_keys 지정 시 해당 card_key만.
    """
    stmt = select(CardUsageClassification).where(
        CardUsageClassification.transact_at.like(f"{month}%")
    )
    if only_keys is not None:
        stmt = stmt.where(CardUsageClassification.card_key.in_(only_keys))
    rows = (await db.execute(stmt)).scalars().all()

    aliases = (await db.execute(select(CardAlias))).scalars().all()
    amap = {a.card_key: a for a in aliases}
    closings = (await db.execute(
        select(CardMonthlyClosing).where(CardMonthlyClosing.month == month)
    )).scalars().all()
    closed_keys = {c.card_key for c in closings}

    out: List[Dict[str, Any]] = []
    for r in rows:
        al = amap.get(r.card_key)
        out.append({
            "assigned_email": ", ".join(_alias_emails(al)) if al else "",
            "card_label": (al.nickname if al else None) or (al.issuer if al else None) or r.card_key,
            "issuer": al.issuer if al else None,
            "last4": al.last4 if al else None,
            "transact_at": r.transact_at,
            "store_name": r.store_name,
            "amount": r.amount,
            "account_code": r.account_code,
            "account_name": r.account_name or r.category,
            "memo": r.memo,
            "classified_by": r.classified_by,
            "closed": r.card_key in closed_keys,
        })
    out.sort(key=lambda x: (x["assigned_email"], str(x["card_label"]), str(x["transact_at"] or "")))
    return out


async def classify_transactions_bulk(
    db: AsyncSession,
    card_key: str,
    items: List[Dict[str, Any]],
    classified_by: str,
) -> Dict[str, Any]:
    """
    여러 카드 사용 건 분류를 한 번에 upsert (단일 커밋).
    items: [{ticket_id, account_code, account_name, memo, transact_at?, store_name?, amount?}, ...]
    """
    ids = [str(it.get("ticket_id")) for it in items if it.get("ticket_id")]
    existing: Dict[str, CardUsageClassification] = {}
    if ids:
        rows = (await db.execute(
            select(CardUsageClassification).where(
                CardUsageClassification.ticket_id.in_(ids)
            )
        )).scalars().all()
        existing = {r.ticket_id: r for r in rows}

    saved = 0
    for it in items:
        tid = str(it.get("ticket_id") or "").strip()
        if not tid:
            continue
        acc_code = it.get("account_code")
        acc_name = it.get("account_name")
        memo = it.get("memo")
        cls = existing.get(tid)
        if cls is None:
            cls = CardUsageClassification(
                ticket_id=tid,
                card_key=card_key,
                category=acc_name or "",
                account_code=acc_code,
                account_name=acc_name,
                memo=memo,
                classified_by=classified_by,
                transact_at=it.get("transact_at"),
                store_name=it.get("store_name"),
                amount=it.get("amount"),
            )
            db.add(cls)
        else:
            cls.category = acc_name or cls.category
            cls.account_code = acc_code
            cls.account_name = acc_name
            cls.memo = memo
            cls.classified_by = classified_by
            if it.get("transact_at"):
                cls.transact_at = it.get("transact_at")
            if it.get("store_name"):
                cls.store_name = it.get("store_name")
            if it.get("amount") is not None:
                cls.amount = it.get("amount")
        saved += 1

    await db.commit()
    return {"saved": saved}


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
    expense = await _fetch_expense_tickets(db, start_date, end_date)

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

        expense = await _fetch_expense_tickets(db, m_start, m_end)

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
