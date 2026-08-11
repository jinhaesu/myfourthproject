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
    return {
        "count": len(out),
        "in_sum": in_sum,
        "out_sum": out_sum,
        "net": in_sum - out_sum,
        "transactions": out,
    }
