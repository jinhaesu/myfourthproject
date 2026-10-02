"""
내 카드 관리 — 분류 추천.

미분류 사용 건에 대해 "계정과목 + 메모" 추천을 만든다. 자동 분류가 아니라 추천이며,
직원이 눌러야 입력된다. 근거가 약하면 추천하지 않는다.

우선순위:
  1) 이 카드에서 같은 가맹점을 분류한 이력            (source="card")
  2) 본인이 다른 카드에서 같은 가맹점을 분류한 이력   (source="mine")
  3) 회사 전체 이력 — 2건 이상이고 80% 이상이 같은 계정 (source="company")
  4) 이력이 없으면 가맹점명만으로 계정이 명확한 곳만 AI가 추천 (source="ai")
"""
import asyncio
import json
import logging
import re
from collections import Counter, defaultdict
from typing import Any, Dict, List, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.accounting import Account, AccountCategory
from app.models.card_classification import CardUsageClassification

logger = logging.getLogger(__name__)

AI_MIN_CONFIDENCE = 0.85
AI_MAX_STORES = 40

# 가맹점명 → AI 추천 캐시(프로세스 메모리). None = "명확하지 않아 추천 안 함"도 기억한다.
_ai_cache: Dict[str, Optional[Dict[str, str]]] = {}


def norm_store(name: Optional[str]) -> str:
    """가맹점 비교 키. 카드사가 매입 확정 뒤 붙이는 '/하위가맹점' 표기와 공백을 걷어낸다
    ("컬리_AD" 와 "컬리_AD/주식회사 컬리페이" 를 같은 곳으로 본다)."""
    s = (name or "").split("/")[0]
    return re.sub(r"\s+", "", s).lower()


def _pick(rows: List[CardUsageClassification], *, min_count: int = 1, min_share: float = 0.0):
    """이력에서 가장 많이 쓴 계정과, 그 계정으로 가장 최근에 적은 메모를 고른다."""
    rows = [r for r in rows if r.account_code]
    if len(rows) < min_count:
        return None
    counts = Counter(r.account_code for r in rows)
    code, n = counts.most_common(1)[0]
    if n / len(rows) < min_share:
        return None
    same = sorted((r for r in rows if r.account_code == code), key=lambda r: r.updated_at or r.created_at, reverse=True)
    memo = next((r.memo for r in same if (r.memo or "").strip()), "") or ""
    return {
        "account_code": code,
        "account_name": same[0].account_name or same[0].category,
        "memo": memo,
        "count": n,
    }


async def _ai_suggest(db: AsyncSession, stores: Dict[str, Dict[str, Any]]) -> Dict[str, Dict[str, str]]:
    """이력이 없는 가맹점 중 계정이 명확한 곳만 AI에게 묻는다. stores: 정규화 키 → {name, amount}."""
    todo = {k: v for k, v in stores.items() if k not in _ai_cache}
    if todo and settings.ANTHROPIC_API_KEY:
        todo = dict(list(todo.items())[:AI_MAX_STORES])
        accts = (await db.execute(
            select(Account.code, Account.name)
            .join(AccountCategory, Account.category_id == AccountCategory.id)
            .where(Account.is_active == True, AccountCategory.name.in_(["비용", "자산"]))  # noqa: E712
            .order_by(Account.code)
        )).all()
        valid = {c: n for c, n in accts}
        keys = list(todo.keys())
        listing = "\n".join(f'{i + 1}. {todo[k]["name"]} ({todo[k]["amount"]:,.0f}원)' for i, k in enumerate(keys))
        prompt = f"""식품 제조사(조인앤조인)의 법인카드 사용 건입니다. 직원이 계정과목을 고를 때 참고할 추천을 만듭니다.

가맹점 이름만 보고도 계정과목이 명확한 곳만 추천하세요. 예: 주유소 → 차량유지비, 택시·철도·항공 → 여비교통비,
통신사 요금 → 통신비, 택배사 → 운반비, 광고 플랫폼 결제 → 광고선전비.
이름만으로 용도를 알 수 없는 곳(식당·카페·마트·온라인몰·편의점·결제대행 등 — 회의비/복리후생비/접대비/소모품비 중
무엇인지 사용자만 아는 경우)은 추천하지 말고 code를 null로 두세요. 틀린 추천보다 추천 없음이 낫습니다.

## 가맹점
{listing}

## 사용 가능한 계정과목 (이 목록의 코드만 사용)
{chr(10).join(f"- {c}: {n}" for c, n in accts)}

## 출력 (JSON 배열만, 다른 글 없이)
[{{"no": 1, "code": "계정코드 또는 null", "memo": "메모 초안(10자 안팎, 예: 업무 차량 주유)", "confidence": 0.0~1.0}}]"""

        def _call() -> str:
            import anthropic
            client = anthropic.Anthropic(api_key=settings.ANTHROPIC_API_KEY)
            resp = client.messages.create(
                model=settings.ANTHROPIC_MODEL or "claude-fable-5",
                max_tokens=4096,
                messages=[{"role": "user", "content": prompt}],
            )
            return "".join(b.text for b in resp.content if b.type == "text").strip()

        try:
            text = await asyncio.to_thread(_call)
            m = re.search(r"\[.*\]", text, re.S)
            items = json.loads(m.group(0)) if m else []
            for k in keys:
                _ai_cache[k] = None
            for it in items:
                try:
                    idx = int(it.get("no")) - 1
                    code = str(it.get("code") or "")
                    if 0 <= idx < len(keys) and code in valid and float(it.get("confidence") or 0) >= AI_MIN_CONFIDENCE:
                        _ai_cache[keys[idx]] = {
                            "account_code": code,
                            "account_name": valid[code],
                            "memo": str(it.get("memo") or "")[:100],
                        }
                except (TypeError, ValueError):
                    continue
        except Exception as e:  # AI는 부가 기능 — 실패해도 이력 기반 추천은 그대로 돌려준다
            logger.warning("카드 분류 AI 추천 실패: %s", e)

    return {k: _ai_cache[k] for k in stores if _ai_cache.get(k)}


async def suggest_classifications(
    db: AsyncSession, *, card_key: str, user_email: str, items: List[Dict[str, Any]],
) -> Dict[str, Dict[str, Any]]:
    """items: [{ticket_id, store_name, amount}] → {ticket_id: 추천}."""
    wanted: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for it in items:
        key = norm_store(it.get("store_name"))
        if key and it.get("ticket_id"):
            wanted[key].append(it)
    if not wanted:
        return {}

    # 분류 이력은 수천 건 수준이라 한 번에 읽어 가맹점 키로 묶는다
    history = (await db.execute(
        select(CardUsageClassification).where(CardUsageClassification.store_name.isnot(None))
    )).scalars().all()
    ticket_ids = {it["ticket_id"] for its in wanted.values() for it in its}
    by_store: Dict[str, List[CardUsageClassification]] = defaultdict(list)
    for h in history:
        if h.ticket_id not in ticket_ids:
            by_store[norm_store(h.store_name)].append(h)

    per_store: Dict[str, Dict[str, Any]] = {}
    for key in wanted:
        rows = by_store.get(key, [])
        pick = _pick([r for r in rows if r.card_key == card_key])
        source, basis = "card", "이 카드에서 {n}번 이렇게 분류"
        if not pick:
            pick = _pick([r for r in rows if (r.classified_by or "").lower() == user_email.lower()])
            source, basis = "mine", "내가 {n}번 이렇게 분류"
        if not pick:
            pick = _pick(rows, min_count=2, min_share=0.8)
            source, basis = "company", "사내에서 {n}번 이렇게 분류"
        if pick:
            per_store[key] = {
                "account_code": pick["account_code"], "account_name": pick["account_name"],
                # 다른 사람이 적은 메모("야근택시_홍길동" 등)는 내 건에 맞지 않으므로 사내 이력은 계정만 추천한다
                "memo": "" if source == "company" else pick["memo"],
                "source": source, "basis": basis.format(n=pick["count"]),
            }

    missing = {
        k: {"name": its[0].get("store_name"), "amount": float(its[0].get("amount") or 0)}
        for k, its in wanted.items() if k not in per_store
    }
    if missing:
        for k, s in (await _ai_suggest(db, missing)).items():
            per_store[k] = {**s, "source": "ai", "basis": "가맹점 이름으로 AI가 추정"}

    return {it["ticket_id"]: per_store[k] for k, its in wanted.items() if k in per_store for it in its}
