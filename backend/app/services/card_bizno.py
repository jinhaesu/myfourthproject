"""
카드 가맹점 사업자등록번호 월 배치 채움.

- 1순위 소스: 홈택스 사업용 신용카드 매입내역(/in0076000279, CERT) — 법인 전 카드를 기간 전체로 **1콜**.
  가맹점 사업자번호·사업자유형(법인/일반/간이/면세)·공제여부를 함께 제공. 승인번호는 없어 (카드뒷4·승인일·금액)으로 매칭.
- 2순위: 하이픈 카드 매입내역(/in0007000561) — ID로그인 카드(하나 006)만 동작(BC 010 CERT는 LOGIN-C04). 남은 공백이 있을 때만.
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
            or_(_blank(HyphenCardTx.store_biz_no), HyphenCardTx.biz_src == "inferred"),
            func.replace(HyphenCardTx.use_dt, "-", "") >= f,
        )
    )).scalar()
    return _iso(rows) if rows else None


def _bman_norm(v: Optional[str]) -> Optional[str]:
    t = (v or "").strip()
    return t[:20] or None


async def fill_from_hometax(db, *, start_date: str, end_date: str) -> Dict[str, Any]:
    """홈택스 사업용신용카드 매입내역 1콜 -> hyphen_card_tx 사업자번호/사업자유형/공제여부 채움."""
    cert = await ext.get_company_cert(db)
    if not cert:
        return {"calls": 0, "error": "저장된 법인 공동인증서 없음"}
    client = get_hyphen_client()
    try:
        data = await client.hometax_card_purchases(
            biz_no=ext.COMPANY_BIZ_NO, start_date=start_date, end_date=end_date,
            sign_cert=cert[0], sign_pri=cert[1], sign_pw=cert[2])
    except HyphenAPIError as e:
        return {"calls": 1, "error": str(e)[:200]}
    common = (data or {}).get("common") if isinstance(data, dict) else {}
    if isinstance(common, dict) and common.get("errYn") == "Y":
        return {"calls": 1, "error": str(common.get("errMsg"))[:200]}
    rows = ext._extract_list(data)

    # 홈택스 행 인덱스: (카드뒷4, 승인일, 총액) -> [row]
    idx: Dict[tuple, List[Dict[str, Any]]] = {}
    for r in rows:
        biz = digits(r.get("mrntTxprDscmNoEncCntn"))
        if len(biz) != 10:
            continue
        last4 = digits(r.get("busnCrdCardNoEncCntn"))[-4:]
        try:
            amt = round(float(str(r.get("totaTrsAmt") or "0").replace(",", "")))
        except ValueError:
            continue
        for dt in {_ymd(str(r.get("aprvDt") or "")), _ymd(str(r.get("prhDt") or ""))}:
            if dt:
                idx.setdefault((last4, dt, amt), []).append(r)

    txs = (await db.execute(select(HyphenCardTx).where(
        func.replace(HyphenCardTx.use_dt, "-", "") >= _ymd(start_date),
        func.replace(HyphenCardTx.use_dt, "-", "") <= _ymd(end_date)))).scalars().all()
    filled = updated = ambiguous = unmatched = 0
    for t in txs:
        last4 = digits(t.card_no)[-4:]
        amt = round(float(t.use_amt or 0))
        cands = idx.get((last4, _ymd(t.use_dt or ""), amt)) or idx.get((last4, _ymd(t.use_dt or ""), -amt)) or []
        if not cands:
            unmatched += 1
            continue
        bizs = {digits(c.get("mrntTxprDscmNoEncCntn")) for c in cands}
        pick = cands[0]
        if len(bizs) > 1:   # 같은 카드·날짜·금액에 서로 다른 가맹점 -> 가맹점명 유사도로 선택
            nk = _norm_store(t.use_store)
            named = [c for c in cands if nk and (nk[:4] in _norm_store(c.get("mrntTxprNm")) or _norm_store(c.get("mrntTxprNm"))[:4] in nk)]
            if len({digits(c.get("mrntTxprDscmNoEncCntn")) for c in named}) == 1:
                pick = named[0]
            else:
                ambiguous += 1
                continue
        biz = digits(pick.get("mrntTxprDscmNoEncCntn"))
        was_blank = not (t.store_biz_no or "").strip()
        if was_blank or t.biz_src in ("inferred", "manual"):
            if t.biz_src == "manual" and digits(t.store_biz_no) != biz:
                from app.services.merchant_biz import log_conflict, manual_key
                await log_conflict(db, manual_key(t.use_store), digits(t.store_biz_no), biz, "hometax")
            t.store_biz_no, t.biz_src = biz, "hometax"
            filled += 1
        elif digits(t.store_biz_no) != biz:
            continue    # 이미 다른 번호로 확정 - 덮어쓰지 않음
        t.ht_kind = _bman_norm(pick.get("bmanClNm"))
        t.ht_deduct = _bman_norm(pick.get("ddcYnNm"))
        t.ht_reason = (str(pick.get("vatDdcClNm") or "").strip()[:60]) or None
        updated += 1
    await db.commit()
    return {"calls": 1, "hometax_rows": len(rows), "tx_in_range": len(txs), "filled": filled,
            "ht_updated": updated, "ambiguous": ambiguous, "unmatched": unmatched}


async def fill_from_purchase(
    db, *, start_date: str, end_date: str, chunk_days: int = 0, max_cards: Optional[int] = None,
) -> Dict[str, Any]:
    """561 매입내역으로 사업자번호/과세유형 채움. 반환에 콜 수 포함."""
    cert = await ext.get_company_cert(db)
    client = get_hyphen_client()
    accts = (await db.execute(select(HyphenCardAccount).order_by(HyphenCardAccount.id))).scalars().all()
    # CERT 로그인 카드(BC 010)는 561에서 LOGIN-C04로 실패 -> ID로그인 카드만.
    # 561은 조회기간 최대 3개월 -> 카드별로 '공백/추정' 행이 있는 날짜만 90일 창으로 묶어 호출(불필요한 콜 제거).
    accts = [a for a in accts if a.login_method.upper() == "ID"]
    if max_cards:
        accts = accts[:max_cards]
    span = chunk_days if chunk_days and chunk_days > 0 else 89
    pend = (await db.execute(select(HyphenCardTx.card_no, HyphenCardTx.use_dt).where(
        or_(_blank(HyphenCardTx.store_biz_no), HyphenCardTx.biz_src == "inferred"),
        func.replace(HyphenCardTx.use_dt, "-", "") >= _ymd(start_date),
        func.replace(HyphenCardTx.use_dt, "-", "") <= _ymd(end_date)))).all()
    pend_by4: Dict[str, List[date]] = {}
    for cn, ud in pend:
        pend_by4.setdefault(digits(cn)[-4:], []).append(date.fromisoformat(_iso(ud)))

    def windows_for(a) -> List[tuple]:
        ds = sorted(pend_by4.get(digits(a.card_no)[-4:], []))
        out, i = [], 0
        while i < len(ds):
            w0 = ds[i]; w1 = w0 + timedelta(days=span)
            out.append((w0.isoformat(), min(w1, ds[-1]).isoformat()))
            while i < len(ds) and ds[i] <= w1:
                i += 1
        return out

    calls = filled = fetched = matched_rows = tax_filled = 0
    results = []
    for a in accts:
        sign = cert if (a.login_method == "CERT" and cert) else (None, None, None)
        last4 = (a.card_no or "")[-4:]
        card_rows: List[Dict[str, Any]] = []
        err = None
        win = windows_for(a)
        if not win:
            continue
        for (ws, we) in win:
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
                if not (t.store_biz_no or "").strip() or t.biz_src in ("inferred", "manual"):
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


async def infer_blanks(db, *, floor: str = FLOOR_DEFAULT, reset: bool = False) -> Dict[str, int]:
    """공백 행을 동일 가맹점명(다른 행) 또는 세금계산서 매입 공급자명으로 추정 채움. biz_src='inferred'."""
    from app.services.vat_deduction import nonvat_reason
    cleared = 0
    if reset:   # 추정값 전부 비우고 (이름 기준으로만) 다시 계산
        for t in (await db.execute(select(HyphenCardTx).where(
                HyphenCardTx.biz_src == "inferred",
                func.replace(HyphenCardTx.use_dt, "-", "") >= _ymd(floor)))).scalars().all():
            t.store_biz_no, t.biz_src = None, None
            cleared += 1
        await db.flush()
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
        if not k or nonvat_reason(t.use_store):   # 세금·4대보험 납부는 가맹점이 아니므로 추정 금지
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
    return {"cleared": cleared, "from_card_rows": n_card, "from_tax_invoices": n_tax, "blank_scanned": len(rows)}


async def fill_stats(db, floor: str = FLOOR_DEFAULT) -> List[Dict[str, Any]]:
    mm = func.substr(func.replace(HyphenCardTx.use_dt, "-", ""), 1, 6)
    rows = (await db.execute(
        select(mm, func.count(), func.count().filter(~_blank(HyphenCardTx.store_biz_no)),
               func.count().filter(HyphenCardTx.biz_src.in_(["hyphen", "hometax"])),
               func.count().filter(HyphenCardTx.biz_src == "inferred"))
        .where(func.replace(HyphenCardTx.use_dt, "-", "") >= _ymd(floor)).group_by(mm).order_by(mm))).all()
    return [{"month": r[0], "rows": r[1], "filled": r[2], "confirmed": r[3], "inferred": r[4]} for r in rows]


async def run_monthly(
    db, *, start_date: Optional[str] = None, end_date: Optional[str] = None,
    floor: str = FLOOR_DEFAULT, chunk_days: int = 0, include_retry: bool = True,
    max_cards: Optional[int] = None, nts: bool = True, use_hometax: bool = True,
) -> Dict[str, Any]:
    from app.services import nts_client
    if not start_date or not end_date:
        start_date, end_date = prev_month_range()
    if include_retry:
        eb = await earliest_blank(db, floor)
        if eb and _ymd(eb) < _ymd(start_date):
            start_date = eb
    before = await fill_stats(db, floor)
    ht = await fill_from_hometax(db, start_date=start_date, end_date=end_date) if use_hometax else {"calls": 0, "skipped": True}
    res = await fill_from_purchase(db, start_date=start_date, end_date=end_date,
                                   chunk_days=chunk_days, max_cards=max_cards)
    from app.services.merchant_biz import apply_mappings
    manual_n = await apply_mappings(db, floor=floor)
    inf = await infer_blanks(db, floor=floor, reset=True)
    nts_res = None
    if nts:
        nums = [digits(x) for x in (await db.execute(
            select(HyphenCardTx.store_biz_no).where(~_blank(HyphenCardTx.store_biz_no)).distinct())).scalars().all()]
        nts_res = await nts_client.refresh_statuses(db, nums)
    after = await fill_stats(db, floor)
    return {"range": [start_date, end_date], "hometax": ht, "purchase": res, "manual_applied": manual_n, "inferred": inf, "nts": nts_res,
            "before": before, "after": after}
