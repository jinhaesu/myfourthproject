"""
카드 가맹점 사업자등록번호 월 배치 채움.

- 소스: 하이픈 카드 매입내역(/in0007000561) — storeBizNo/taxType 제공. 카드 1장당 1콜(기간 전체를 한 번에).
- 매칭: (카드 뒷4자리, 승인번호, 금액[, 사용일]) -> hyphen_card_tx. dedup_hash는 건드리지 않음(분류 키).
- 보강: 561이 못 채운 행은 동일 가맹점명의 다른 행/세금계산서(매입) 공급자명으로 추정(biz_src='inferred').
- 국세청 상태조회(NTS_SERVICE_KEY 있을 때) 캐시 갱신.
- 멱등: store_biz_no가 빈 행만 갱신. 이전 공백도 재시도(범위를 가장 오래된 공백일까지 확장 - 콜 수는 동일).
"""
import re
import logging
from datetime import date, datetime, timedelta
from typing import Any, Dict, List, Optional

from sqlalchemy import select, or_, func

from app.models.hyphen_ext import HyphenCardTx, HyphenCardAccount, HyphenTaxInvoice
from app.services import hyphen_sync_ext as ext
from app.services.hyphen_client import get_hyphen_client, HyphenAPIError
from app.services.hyphen_credentials import _dec
from app.services.vat_deduction import digits, kind_from_hyphen

logger = logging.getLogger(__name__)

CARD_PURCHASE_PATH = "/in0007000561"
FLOOR_DEFAULT = "2026-01-01"
STATE: Dict[str, Any] = {"running": False, "last": None}


def _norm_store(s: Optional[str]) -> str:
    t = (s or "").upper()
    t = re.sub(r"\(주\)|㈜|주식회사|\(유\)|유한회사", "", t)
    return re.sub(r"[\s\-_/()\[\]·.,]", "", t)


def _blank(col):
    return or_(col.is_(None), func.trim(col) == "")


def _ymd(s: str) -> str:
    return s.replace("-", "")


def _iso(s: str) -> str:
    s = _ymd(s)
    return f"{s[:4]}-{s[4:6]}-{s[6:8]}"


def prev_month_range(today: Optional[date] = None) -> tuple:
    t = today or (datetime.utcnow() + timedelta(hours=9)).date()
    last = t.replace(day=1) - timedelta(days=1)
    return last.replace(day=1).isoformat(), last.isoformat()


async def earliest_blank(db, floor: str) -> Optional[str]:
    """floor 이후 사업자번호가 빈 행 중 가장 오래된 사용일 (YYYY-MM-DD)."""
    f = _ymd(floor)
    rows = (await db.execute(
        select(func.min(HyphenCardTx.use_dt)).where(
            _blank(HyphenCardTx.store_biz_no),
            func.replace(HyphenCardTx.use_dt, "-", "") >= f,
        )
    )).scalar()
    return _iso(rows) if rows else None


async def fill_from_purchase(
    db, *, start_date: str, end_date: str, chunk_days: int = 0, max_cards: Optional[int] = None,
) -> Dict[str, Any]:
    """561 매입내역으로 사업자번호/과세유형 채움. 반환에 콜 수 포함."""
    cert = await ext.get_company_cert(db)
    client = get_hyphen_client()
    accts = (await db.execute(select(HyphenCardAccount).order_by(HyphenCardAccount.id))).scalars().all()
    if max_cards:
        accts = accts[:max_cards]
    s0, e0 = date.fromisoformat(_iso(start_date)), date.fromisoformat(_iso(end_date))
    windows = []
    if chunk_days and chunk_days > 0:
        cur = s0
        while cur <= e0:
            nxt = min(cur + timedelta(days=chunk_days - 1), e0)
            windows.append((cur.isoformat(), nxt.isoformat()))
            cur = nxt + timedelta(days=1)
    else:
        windows = [(s0.isoformat(), e0.isoformat())]

    calls = filled = fetched = matched_rows = tax_filled = 0
    results = []
    for a in accts:
        sign = cert if (a.login_method == "CERT" and cert) else (None, None, None)
        last4 = (a.card_no or "")[-4:]
        card_rows: List[Dict[str, Any]] = []
        err = None
        for (ws, we) in windows:
            calls += 1
            try:
                data = await client.card_transactions(
                    card_cd=a.card_cd, card_no=a.card_no, biz_no=ext.COMPANY_BIZ_NO,
                    start_date=ws, end_date=we, sign_cert=sign[0], sign_pri=sign[1], sign_pw=sign[2],
                    user_id=_dec(a.enc_user_id), user_pw=_dec(a.enc_user_pw),
                    login_method=a.login_method, path=CARD_PURCHASE_PATH,
                )
            except HyphenAPIError as e:
                err = str(e)[:120]
                break
            common = (data or {}).get("common") if isinstance(data, dict) else {}
            if isinstance(common, dict) and common.get("errYn") == "Y":
                err = str(common.get("errMsg"))[:120]
                break
            card_rows.extend(ext._extract_list(data))
        if err and not card_rows:
            results.append({"card": last4, "ok": False, "error": err})
            continue
        fetched += len(card_rows)
        # 이 카드의 원장 행 (기간 + 여유)
        q = await db.execute(select(HyphenCardTx).where(
            HyphenCardTx.card_cd == a.card_cd,
            HyphenCardTx.card_no.like(f"%{last4}"),
            func.replace(HyphenCardTx.use_dt, "-", "") >= _ymd(start_date),
            func.replace(HyphenCardTx.use_dt, "-", "") <= _ymd(end_date),
        ))
        txs = q.scalars().all()
        by_full: Dict[tuple, List[HyphenCardTx]] = {}
        by_loose: Dict[tuple, List[HyphenCardTx]] = {}
        for t in txs:
            if not t.appr_no:
                continue
            amt = round(float(t.use_amt or 0))
            by_full.setdefault((_ymd(t.use_dt or ""), t.appr_no, amt), []).append(t)
            by_loose.setdefault((t.appr_no, amt), []).append(t)
        c_fill = 0
        for r in card_rows:
            biz = digits(str(r.get("storeBizNo") or ""))
            if len(biz) != 10:
                continue
            appr = str(r.get("apprNo") or "")
            try:
                amt = round(float(str(r.get("useAmt") or "0").replace(",", "")))
            except ValueError:
                continue
            cand = by_full.get((_ymd(str(r.get("useDt") or "")), appr, amt)) or by_loose.get((appr, amt)) or []
            for t in cand:
                matched_rows += 1
                if not (t.store_biz_no or "").strip() or t.biz_src == "inferred":
                    t.store_biz_no = biz
                    t.biz_src = "hyphen"
                    c_fill += 1
                tt = str(r.get("taxType") or "").strip()
                if tt and not (t.tax_type or "").strip():
                    t.tax_type = tt[:20]
                    tax_filled += 1
        filled += c_fill
        await db.commit()
        results.append({"card": last4, "ok": True, "fetched": len(card_rows), "filled": c_fill,
                        **({"partial_error": err} if err else {})})
    return {"calls": calls, "fetched": fetched, "matched": matched_rows, "filled": filled,
            "tax_type_filled": tax_filled, "cards": len(accts), "results": results}


async def infer_blanks(db, *, floor: str = FLOOR_DEFAULT) -> Dict[str, int]:
    """공백 행을 동일 가맹점명(다른 행) 또는 세금계산서 매입 공급자명으로 추정 채움. biz_src='inferred'."""
    known: Dict[str, set] = {}
    for store, biz in (await db.execute(
        select(HyphenCardTx.use_store, HyphenCardTx.store_biz_no).where(
            ~_blank(HyphenCardTx.store_biz_no), HyphenCardTx.biz_src.is_distinct_from("inferred")))).all():
        k = _norm_store(store)
        if k and len(digits(biz)) == 10:
            known.setdefault(k, set()).add(digits(biz))
    tax_known: Dict[str, set] = {}
    for nm, biz in (await db.execute(
        select(HyphenTaxInvoice.sup_corp_nm, HyphenTaxInvoice.sup_biz_no).where(HyphenTaxInvoice.sup_byr == "02"))).all():
        k = _norm_store(nm)
        if k and len(digits(biz)) == 10:
            tax_known.setdefault(k, set()).add(digits(biz))
    rows = (await db.execute(select(HyphenCardTx).where(
        _blank(HyphenCardTx.store_biz_no), func.replace(HyphenCardTx.use_dt, "-", "") >= _ymd(floor)))).scalars().all()
    n_card = n_tax = 0
    for t in rows:
        k = _norm_store(t.use_store)
        if not k:
            continue
        s = known.get(k)
        if s and len(s) == 1:
            t.store_biz_no, t.biz_src = next(iter(s)), "inferred"
            n_card += 1
            continue
        s = tax_known.get(k)
        if s and len(s) == 1:
            t.store_biz_no, t.biz_src = next(iter(s)), "inferred"
            n_tax += 1
    await db.commit()
    return {"from_card_rows": n_card, "from_tax_invoices": n_tax, "blank_scanned": len(rows)}


async def fill_stats(db, floor: str = FLOOR_DEFAULT) -> List[Dict[str, Any]]:
    mm = func.substr(func.replace(HyphenCardTx.use_dt, "-", ""), 1, 6)
    rows = (await db.execute(
        select(mm, func.count(), func.count().filter(~_blank(HyphenCardTx.store_biz_no)),
               func.count().filter(HyphenCardTx.biz_src == "hyphen"),
               func.count().filter(HyphenCardTx.biz_src == "inferred"))
        .where(func.replace(HyphenCardTx.use_dt, "-", "") >= _ymd(floor)).group_by(mm).order_by(mm))).all()
    return [{"month": r[0], "rows": r[1], "filled": r[2], "confirmed": r[3], "inferred": r[4]} for r in rows]


async def run_monthly(
    db, *, start_date: Optional[str] = None, end_date: Optional[str] = None,
    floor: str = FLOOR_DEFAULT, chunk_days: int = 0, include_retry: bool = True,
    max_cards: Optional[int] = None, nts: bool = True,
) -> Dict[str, Any]:
    from app.services import nts_client
    if not start_date or not end_date:
        start_date, end_date = prev_month_range()
    if include_retry:
        eb = await earliest_blank(db, floor)
        if eb and _ymd(eb) < _ymd(start_date):
            start_date = eb
    before = await fill_stats(db, floor)
    res = await fill_from_purchase(db, start_date=start_date, end_date=end_date,
                                   chunk_days=chunk_days, max_cards=max_cards)
    inf = await infer_blanks(db, floor=floor)
    nts_res = None
    if nts:
        nums = [digits(x) for x in (await db.execute(
            select(HyphenCardTx.store_biz_no).where(~_blank(HyphenCardTx.store_biz_no)).distinct())).scalars().all()]
        nts_res = await nts_client.refresh_statuses(db, nums)
    after = await fill_stats(db, floor)
    return {"range": [start_date, end_date], "purchase": res, "inferred": inf, "nts": nts_res,
            "before": before, "after": after}
