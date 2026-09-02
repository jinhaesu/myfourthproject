"""
하이픈 계좌 거래 동기화 — 하이픈에서 거래를 가져와 로컬 원장(hyphen_bank_tx)에 저장.

화면은 이 원장을 즉시 읽는다. 은행 실로그인(스크래핑)은 동기화 시점에만 발생.
dedup_hash로 반복 동기화 시 중복 방지.
"""
import re
import hashlib
import logging
from datetime import datetime
from typing import Optional, Dict, Any, List

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.hyphen_bank_tx import HyphenBankTx
from app.models.hyphen_credential import HyphenCredential
from app.services.hyphen_credentials import run_account_transactions, get_credential

logger = logging.getLogger(__name__)


def _num(v: Any) -> float:
    if v is None:
        return 0.0
    s = re.sub(r"[^\d.\-]", "", str(v))
    try:
        return float(s) if s not in ("", "-", ".") else 0.0
    except Exception:
        return 0.0


async def record_coverage(db: AsyncSession, kind: str, ckey: str, start_date: str, end_date: str) -> None:
    """(종류,키)의 당긴 범위를 확장 기록 — 이후 이 범위 조회는 API 재호출 안 함."""
    from app.models.hyphen_ext import HyphenSyncCoverage
    sd = start_date.replace("-", ""); ed = end_date.replace("-", "")
    row = (await db.execute(select(HyphenSyncCoverage).where(
        HyphenSyncCoverage.kind == kind, HyphenSyncCoverage.ckey == ckey))).scalars().first()
    if row is None:
        db.add(HyphenSyncCoverage(kind=kind, ckey=ckey, start_date=sd, end_date=ed, synced_at=datetime.utcnow()))
    else:
        row.start_date = min(row.start_date, sd)
        row.end_date = max(row.end_date, ed)
        row.synced_at = datetime.utcnow()


async def get_coverage(db: AsyncSession, kind: str, ckey: str):
    from app.models.hyphen_ext import HyphenSyncCoverage
    row = (await db.execute(select(HyphenSyncCoverage).where(
        HyphenSyncCoverage.kind == kind, HyphenSyncCoverage.ckey == ckey))).scalars().first()
    return (row.start_date, row.end_date) if row else None


def _iso(ymd: str) -> str:
    return f"{ymd[:4]}-{ymd[4:6]}-{ymd[6:8]}"


def _shift(ymd: str, days: int) -> str:
    from datetime import timedelta
    return (datetime.strptime(ymd, "%Y%m%d") + timedelta(days=days)).strftime("%Y%m%d")


# 자동 온디맨드 sync 허용 최대 gap(일) — 이보다 크면 수동 백필/크론에 맡김(요청 행 방지)
_ENSURE_MAX_GAP_DAYS = int(__import__("os").getenv("HYPHEN_ENSURE_MAX_GAP", "120"))


async def ensure_coverage(db: AsyncSession, kind: str, ckey: str, start_date: str, end_date: str, sync_fn,
                          *, recent_days: int = 0, recent_throttle_hours: float = 6.0) -> Dict[str, Any]:
    """요청 [start,end]에서 **커버 안 된 좌/우 구간만** sync_fn(db,start_date=,end_date=)로 1회 당김.
    이미 전부 커버된 범위면 API 호출 0(=한 번 조회한 범위는 재조회 시 외부호출 없음).
    sync_fn은 내부에서 record_coverage로 커버리지를 확장해야 함. gap이 너무 크면(초기 대량) 스킵.

    recent_days>0: 카드처럼 매입 정산지연으로 거래가 늦게 들어오는 경우, **커버돼 있어도**
    최근 recent_days일 구간을 재싱크(늦게 확정된 건 반영). 단 이 (kind,ckey)의 마지막 싱크가
    recent_throttle_hours 이내면 스킵 → 조회 폭주 시에도 최근 재싱크는 그 시간당 1회로 제한."""
    from app.models.hyphen_ext import HyphenSyncCoverage
    row = (await db.execute(select(HyphenSyncCoverage).where(
        HyphenSyncCoverage.kind == kind, HyphenSyncCoverage.ckey == ckey))).scalars().first()
    cov = (row.start_date, row.end_date) if row else None
    sd = start_date.replace("-", ""); ed = end_date.replace("-", "")
    if ed < sd:
        return {"synced": [], "covered": True}
    gaps = []
    if cov is None:
        gaps.append((sd, ed))
    else:
        cs, ce = cov
        if sd < cs:
            g_end = min(ed, _shift(cs, -1))
            if sd <= g_end:
                gaps.append((sd, g_end))
        if ed > ce:
            g_start = max(sd, _shift(ce, 1))
            if g_start <= ed:
                gaps.append((g_start, ed))
    # 최근구간 재싱크 (정산지연 대비) — 커버돼 있어도 최근 N일은 다시 당김, throttle로 비용 제한
    if recent_days > 0:
        from datetime import date as _date, timedelta as _td
        today = _date.today()
        rs = max(sd, (today - _td(days=recent_days)).strftime("%Y%m%d"))
        re_ = min(ed, today.strftime("%Y%m%d"))
        if rs <= re_:
            last = row.synced_at if row else None
            fresh = last is not None and (datetime.utcnow() - last) < _td(hours=recent_throttle_hours)
            already = any(g[0] <= rs and re_ <= g[1] for g in gaps)
            if not fresh and not already:
                gaps.append((rs, re_))
    synced = []
    for gsd, ged in gaps:
        span_days = (datetime.strptime(ged, "%Y%m%d") - datetime.strptime(gsd, "%Y%m%d")).days + 1
        if span_days > _ENSURE_MAX_GAP_DAYS:
            logger.info("ensure_coverage: gap %s~%s (%d일) > 한도 → 자동sync 스킵(%s/%s)", gsd, ged, span_days, kind, ckey)
            continue
        try:
            await sync_fn(db, start_date=_iso(gsd), end_date=_iso(ged))
            synced.append({"from": _iso(gsd), "to": _iso(ged)})
        except Exception:
            logger.exception("ensure_coverage sync 실패 %s/%s %s~%s", kind, ckey, gsd, ged)
    return {"synced": synced, "covered": not gaps}


def _hash(acct_no: str, r: Dict[str, Any]) -> str:
    key = "|".join(str(r.get(k, "")) for k in ("trDt", "trTm", "inAmt", "outAmt", "balance", "trNm", "trNo", "trNum"))
    return hashlib.sha256(f"{acct_no}|{key}".encode()).hexdigest()


async def sync_credential(
    db: AsyncSession,
    cred: HyphenCredential,
    *,
    start_date: str,
    end_date: str,
    gustation: bool = False,
) -> Dict[str, Any]:
    """저장 인증정보로 하이픈 거래 조회 → 원장 upsert. 잔액/동기화시각 갱신."""
    res = await run_account_transactions(
        db, cred, start_date=start_date, end_date=end_date, gustation=gustation,
    )
    data = res.get("data") or {}
    common = data.get("common") if isinstance(data, dict) else {}
    if isinstance(common, dict) and common.get("errYn") == "Y":
        return {"ok": False, "error": common.get("errMsg"), "inserted": 0}

    acct_data = data.get("data") if isinstance(data, dict) else {}
    rows: List[Dict[str, Any]] = (acct_data or {}).get("list") or []
    acct_no = cred.acct_no

    # 이미 저장된 hash 조회 (배치 내 중복 방지)
    hashes = [_hash(acct_no, r) for r in rows]
    existing = set()
    if hashes:
        q = await db.execute(select(HyphenBankTx.dedup_hash).where(HyphenBankTx.dedup_hash.in_(hashes)))
        existing = set(q.scalars().all())

    inserted = 0
    seen = set()
    for r, h in zip(rows, hashes):
        if h in existing or h in seen:
            continue
        seen.add(h)
        db.add(HyphenBankTx(
            credential_id=cred.id,
            bank_cd=cred.bank_cd,
            acct_no=acct_no,
            acct_last4=cred.acct_last4,
            tr_date=str(r.get("trDt") or ""),
            tr_time=str(r.get("trTm") or ""),
            in_amt=_num(r.get("inAmt")),
            out_amt=_num(r.get("outAmt")),
            balance=_num(r.get("balance")),
            tr_name=(str(r.get("trNm") or r.get("trDetail") or "")[:300]) or None,
            tr_type=(str(r.get("trTp") or "")[:50]) or None,
            memo=(str(r.get("memo") or "")) or None,
            counterparty_acct=(str(r.get("recvAcctNo") or r.get("sendAcctNo") or "")[:60]) or None,
            counterparty_name=(str(r.get("recvAcctHolder") or r.get("sendAcctHolder") or "")[:120]) or None,
            dedup_hash=h,
        ))
        inserted += 1

    # 잔액/동기화시각 갱신 (curBal 우선, 없으면 최신행 balance)
    bal = _num((acct_data or {}).get("curBal"))
    if not bal and rows:
        bal = _num(rows[-1].get("balance"))
    cred.last_balance = bal or cred.last_balance
    cred.last_synced_at = datetime.utcnow()
    await record_coverage(db, "bank", acct_no, start_date, end_date)
    await db.commit()
    return {"ok": True, "inserted": inserted, "fetched": len(rows), "balance": bal, "elapsed_sec": res.get("elapsed_sec")}


async def sync_all(db: AsyncSession, *, start_date: str, end_date: str) -> Dict[str, Any]:
    """만료 안 된 모든 인증정보 동기화."""
    from app.services.hyphen_credentials import purge_expired
    await purge_expired(db)
    creds = (await db.execute(select(HyphenCredential))).scalars().all()
    results = []
    for c in creds:
        if c.is_expired:
            continue
        try:
            r = await sync_credential(db, c, start_date=start_date, end_date=end_date)
            results.append({"credential_id": c.id, "acct_last4": c.acct_last4, **r})
        except Exception as e:
            logger.warning("sync_all 실패 cred=%s: %s", c.id, e)
            results.append({"credential_id": c.id, "acct_last4": c.acct_last4, "ok": False, "error": str(e)[:200]})
    return {"synced": len([r for r in results if r.get("ok")]), "results": results}


async def hyphen_digest_data(db: AsyncSession, target_date) -> Optional[Dict[str, Any]]:
    """AI 자금 다이제스트용 하이픈 원장 데이터 — 특정일 잔액/입출금/당일거래(그랜터티켓 형태).
    등록 계좌 없으면 None(그랜터 폴백)."""
    from datetime import timedelta as _td
    creds = (await db.execute(select(HyphenCredential))).scalars().all()
    active = {c.acct_no for c in creds if not c.is_expired}
    if not active:
        return None

    # 45일 EOD 시계열(계좌합)
    series = await balance_series(db, days=45)
    eod_by_date: Dict[str, float] = {}
    for row in series.get("series", []):
        d = str(row.get("date", "")).replace("-", "")
        s = 0.0
        for k, v in row.items():
            if k == "date":
                continue
            try:
                s += float(v or 0)
            except Exception:
                pass
        eod_by_date[d] = s

    def _n(dt) -> str:
        return dt.isoformat().replace("-", "")

    tnorm = _n(target_date)
    prev_day = _n(target_date - _td(days=1))
    prev_month_target = target_date.replace(day=1) - _td(days=1)
    pm_day = min(target_date.day, prev_month_target.day)
    prev_month_date = prev_month_target.replace(day=pm_day)
    pm = _n(prev_month_date)

    # 시계열에 없으면(가장 최근/과거) 최신값 폴백
    latest = eod_by_date.get(max(eod_by_date) ) if eod_by_date else 0.0
    cur_bal = eod_by_date.get(tnorm, latest)
    prev_bal = eod_by_date.get(prev_day, cur_bal)
    pm_bal = eod_by_date.get(pm, 0.0)

    # 당일 거래(원장)
    rows = (await db.execute(select(HyphenBankTx).where(HyphenBankTx.acct_no.in_(list(active))))).scalars().all()
    in_amt = out_amt = 0.0
    day_tickets = []
    for t in rows:
        d = (t.tr_date or "").replace("-", "")
        if d != tnorm:
            continue
        ia = float(t.in_amt or 0)
        oa = float(t.out_amt or 0)
        in_amt += ia
        out_amt += oa
        amt = ia if ia > 0 else oa
        day_tickets.append({
            "id": f"hy-{t.id}",
            "amount": amt,
            "transactionType": "IN" if ia > 0 else "OUT",
            "transactAt": t.tr_date,
            "bankTransaction": {"content": t.tr_name or t.counterparty_name or "", "counterparty": t.tr_name or t.counterparty_name or ""},
        })
    return {
        "has_data": True,
        "total": {"currentBalance": cur_bal, "previousBalance": prev_bal, "inAmount": in_amt, "outAmount": out_amt},
        "prev_month_balance": pm_bal,
        "day_tickets": day_tickets,
    }


async def dashboard_bank_aggregates(db: AsyncSession, *, as_of=None) -> Optional[Dict[str, Any]]:
    """대시보드용 은행 집계(하이픈 원장) — 가용자금·어제·최근7일 입출금+상위 거래처.
    등록 계좌가 없으면 None(그랜터 폴백)."""
    from datetime import date as _date, timedelta as _td
    today = as_of or _date.today()
    yesterday = today - _td(days=1)
    week_start = today - _td(days=6)

    creds = (await db.execute(select(HyphenCredential).order_by(HyphenCredential.id))).scalars().all()
    bal_by_acct: Dict[str, Any] = {}
    active_accts = set()
    for c in creds:
        if c.is_expired:
            continue
        active_accts.add(c.acct_no)
        prev = bal_by_acct.get(c.acct_no)
        if prev is None or (c.last_synced_at and (prev[1] is None or c.last_synced_at > prev[1])):
            bal_by_acct[c.acct_no] = (float(c.last_balance or 0), c.last_synced_at)
    if not active_accts:
        return None
    balance = sum(v[0] for v in bal_by_acct.values())

    def _n(d: str) -> str:
        return (d or "").replace("-", "")

    y = _n(yesterday.isoformat())
    ws = _n(week_start.isoformat())
    te = _n(today.isoformat())

    rows = (await db.execute(
        select(HyphenBankTx).where(HyphenBankTx.acct_no.in_(list(active_accts)))
    )).scalars().all()

    y_in = y_out = w_in = w_out = 0.0
    inflows: List[Dict[str, Any]] = []
    outflows: List[Dict[str, Any]] = []
    for t in rows:
        d = _n(t.tr_date)
        ia = float(t.in_amt or 0)
        oa = float(t.out_amt or 0)
        iso = f"{d[0:4]}-{d[4:6]}-{d[6:8]}" if len(d) == 8 else t.tr_date
        cp = t.tr_name or t.counterparty_name or "(미지정)"
        if d == y:
            y_in += ia
            y_out += oa
        if ws <= d <= te:
            w_in += ia
            w_out += oa
            if ia > 0:
                inflows.append({"counterparty": cp, "description": "", "amount": ia, "date": iso})
            if oa > 0:
                outflows.append({"counterparty": cp, "description": "", "amount": oa, "date": iso})
    inflows.sort(key=lambda x: x["amount"], reverse=True)
    outflows.sort(key=lambda x: x["amount"], reverse=True)
    return {
        "balance": balance,
        "yesterday": {"inflow": y_in, "outflow": y_out},
        "week": {
            "inflow": w_in, "outflow": w_out,
            "top_inflows": inflows[:5], "top_outflows": outflows[:5],
        },
    }


async def balance_series(db: AsyncSession, *, days: int = 30) -> Dict[str, Any]:
    """하이픈 원장 기반 계좌별 일별 EOD 잔액 시계열 (대시보드용).
    현재 잔액(last_balance) + 일별 순변동 역산으로 재구성. 계좌는 acct_no로 중복 제거.
    """
    from datetime import date as _date, timedelta as _td
    creds = (await db.execute(select(HyphenCredential).order_by(HyphenCredential.id))).scalars().all()
    # acct_no 기준 계좌 목록(중복 제거, 최신 last_balance 사용)
    accts: Dict[str, Dict[str, Any]] = {}
    for c in creds:
        if c.is_expired:
            continue
        key = c.acct_no
        cur = accts.get(key)
        if cur is None or (c.last_synced_at and (not cur.get("_synced") or c.last_synced_at > cur["_synced"])):
            accts[key] = {
                "acct_no": c.acct_no,
                "bank_cd": c.bank_cd,
                "last4": c.acct_last4,
                "label": c.label or f"{c.bank_cd}({c.acct_last4})",
                "balance": float(c.last_balance) if c.last_balance is not None else 0.0,
                "_synced": c.last_synced_at,
            }
    if not accts:
        return {"accounts": [], "series": []}

    today = _date.today()
    day_list = [(today - _td(days=i)).isoformat() for i in range(days - 1, -1, -1)]  # 오래된→최신
    day_set = {d.replace("-", "") for d in day_list}

    # 계좌별 일별 순변동
    rows = (await db.execute(
        select(HyphenBankTx).where(HyphenBankTx.acct_no.in_(list(accts.keys())))
    )).scalars().all()
    net: Dict[str, Dict[str, float]] = {k: {} for k in accts}
    for t in rows:
        d = (t.tr_date or "").replace("-", "")
        if d not in day_set:
            continue
        iso = f"{d[0:4]}-{d[4:6]}-{d[6:8]}" if len(d) == 8 else t.tr_date
        signed = float(t.in_amt or 0) - float(t.out_amt or 0)
        net[t.acct_no][iso] = net[t.acct_no].get(iso, 0.0) + signed

    # EOD 역산: 오늘=현재잔액, EOD[전일]=EOD[당일]-net(당일)
    eod: Dict[str, Dict[str, float]] = {}
    for k, a in accts.items():
        eod[k] = {}
        bal = a["balance"]
        for i in range(len(day_list) - 1, -1, -1):
            d = day_list[i]
            eod[k][d] = bal
            bal = bal - net[k].get(d, 0.0)

    series = []
    for d in day_list:
        row: Dict[str, Any] = {"date": d}
        for k in accts:
            row[k] = eod[k].get(d)
        series.append(row)

    accounts = [{"acct_no": a["acct_no"], "bank_cd": a["bank_cd"], "last4": a["last4"], "label": a["label"], "balance": a["balance"]} for a in accts.values()]
    accounts.sort(key=lambda x: x["balance"], reverse=True)
    return {"accounts": accounts, "series": series}


async def read_transactions(
    db: AsyncSession,
    *,
    start_date: str,
    end_date: str,
    acct_no: Optional[str] = None,
    bank_cd: Optional[str] = None,
) -> Dict[str, Any]:
    """로컬 원장에서 거래 조회 (화면용, 즉시). 날짜는 YYYY-MM-DD 또는 YYYYMMDD 혼용 대응."""
    sd = start_date.replace("-", "")
    ed = end_date.replace("-", "")

    def _norm(d: str) -> str:
        return (d or "").replace("-", "")

    stmt = select(HyphenBankTx)
    if acct_no:
        stmt = stmt.where(HyphenBankTx.acct_no == acct_no)
    if bank_cd:
        stmt = stmt.where(HyphenBankTx.bank_cd == bank_cd)
    rows = (await db.execute(stmt)).scalars().all()
    # 날짜 필터(문자열 정규화 비교) + 정렬
    out = []
    in_sum = out_sum = 0.0
    for t in rows:
        d = _norm(t.tr_date)
        if d < sd or d > ed:
            continue
        ia = float(t.in_amt or 0)
        oa = float(t.out_amt or 0)
        in_sum += ia
        out_sum += oa
        out.append({
            "id": t.id,
            "bank_cd": t.bank_cd,
            "acct_no": t.acct_no,
            "acct_last4": t.acct_last4,
            "tr_date": d,
            "tr_time": t.tr_time,
            "in_amt": ia,
            "out_amt": oa,
            "balance": float(t.balance) if t.balance is not None else None,
            "tr_name": t.tr_name,
            "tr_type": t.tr_type,
            "counterparty_name": t.counterparty_name,
        })
    out.sort(key=lambda x: (x["tr_date"], x["tr_time"] or ""))
    cov = await get_coverage(db, "bank", acct_no) if acct_no else None
    return {
        "count": len(out),
        "in_sum": in_sum,
        "out_sum": out_sum,
        "net": in_sum - out_sum,
        "transactions": out,
        "covered_from": cov[0] if cov else None,
        "covered_to": cov[1] if cov else None,
    }
