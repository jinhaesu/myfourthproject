"""
하이픈 세금계산서·법인카드 동기화 — 홈택스/카드사에서 가져와 원장에 저장.
CERT 로그인은 이미 저장된 법인 공동인증서를 재사용(get_company_cert).
"""
import os
import re
import hashlib
import logging
from datetime import datetime
from typing import Optional, Dict, Any, List, Tuple

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.hyphen_credential import HyphenCredential
from app.models.hyphen_ext import HyphenTaxInvoice, HyphenCardTx, HyphenCardAccount
from app.services.hyphen_client import get_hyphen_client, HyphenAPIError
from app.services.hyphen_credentials import _dec
from app.services.hyphen_sync import record_coverage, get_coverage

logger = logging.getLogger(__name__)

# 조인앤조인 사업자등록번호 (503-87-01038) — env로 override
COMPANY_BIZ_NO = os.getenv("HYPHEN_BIZ_NO", "5038701038")


def _num(v: Any) -> float:
    if v is None:
        return 0.0
    s = re.sub(r"[^\d.\-]", "", str(v))
    try:
        return float(s) if s not in ("", "-", ".") else 0.0
    except Exception:
        return 0.0


async def get_company_cert(db: AsyncSession) -> Optional[Tuple[str, str, str]]:
    """저장된 CERT 은행 인증정보에서 법인 공동인증서(signCert PEM, signPri 암호화PEM, signPw) 복호화 반환."""
    row = (await db.execute(
        select(HyphenCredential).where(
            HyphenCredential.login_method == "CERT",
            HyphenCredential.enc_sign_cert.isnot(None),
        ).order_by(HyphenCredential.id)
    )).scalars().first()
    if not row:
        return None
    cert = _dec(row.enc_sign_cert)
    pri = _dec(row.enc_sign_pri)
    pw = _dec(row.enc_sign_pw)
    if not (cert and pri and pw):
        return None
    return cert, pri, pw


def _extract_list(data: Any, key: str = "list") -> List[Dict[str, Any]]:
    node = data
    for _ in range(6):
        if isinstance(node, dict):
            if isinstance(node.get(key), list):
                return node[key]
            node = node.get("data")
        else:
            break
    return []


# ============ 세금계산서 ============

async def sync_tax_invoices(db: AsyncSession, *, start_date: str, end_date: str, gustation: bool = False) -> Dict[str, Any]:
    cert = await get_company_cert(db)
    if not cert:
        return {"ok": False, "error": "저장된 법인 공동인증서 없음(먼저 은행 계좌를 인증서로 등록하세요)", "inserted": 0}
    sign_cert, sign_pri, sign_pw = cert
    client = get_hyphen_client()
    inserted = 0
    for sup_byr in ("01", "02"):  # 매출/매입
        try:
            data = await client.tax_invoices(
                biz_no=COMPANY_BIZ_NO, sup_byr=sup_byr, start_date=start_date, end_date=end_date,
                sign_cert=sign_cert, sign_pri=sign_pri, sign_pw=sign_pw, gustation=gustation,
            )
        except HyphenAPIError as e:
            logger.warning("세금계산서 %s 조회 실패: %s", sup_byr, e)
            continue
        common = (data or {}).get("common") if isinstance(data, dict) else {}
        if isinstance(common, dict) and common.get("errYn") == "Y":
            logger.warning("세금계산서 %s errMsg: %s", sup_byr, common.get("errMsg"))
            continue
        rows = _extract_list(data)
        hashes = []
        for r in rows:
            key = "|".join(str(r.get(k, "")) for k in ("issueNo", "issueDt", "supBizNo", "byrBizNo", "totAmt"))
            hashes.append(hashlib.sha256(f"{sup_byr}|{key}".encode()).hexdigest())
        existing = set()
        if hashes:
            q = await db.execute(select(HyphenTaxInvoice.dedup_hash).where(HyphenTaxInvoice.dedup_hash.in_(hashes)))
            existing = set(q.scalars().all())
        for r, h in zip(rows, hashes):
            if h in existing:
                continue
            db.add(HyphenTaxInvoice(
                biz_no=COMPANY_BIZ_NO, sup_byr=sup_byr,
                issue_dt=str(r.get("issueDt") or ""), make_dt=str(r.get("makeDt") or "") or None,
                sup_corp_nm=(str(r.get("supCorpNm") or "")[:200]) or None,
                sup_biz_no=(str(r.get("supBizNo") or "")[:20]) or None,
                byr_corp_nm=(str(r.get("byrCorpNm") or "")[:200]) or None,
                byr_biz_no=(str(r.get("byrBizNo") or "")[:20]) or None,
                tot_amt=_num(r.get("totAmt")), sup_amt=_num(r.get("supAmt")), tax_amt=_num(r.get("taxAmt")),
                tax_knd=(str(r.get("taxKnd") or "")[:20]) or None,
                item_nm=(str(r.get("itemNm") or "")[:300]) or None,
                issue_no=(str(r.get("issueNo") or r.get("issueNoDisp") or "")[:60]) or None,
                dedup_hash=h,
            ))
            existing.add(h)
            inserted += 1
    await record_coverage(db, "tax", "tax", start_date, end_date)
    await db.commit()
    return {"ok": True, "inserted": inserted}


async def read_tax_invoices(db: AsyncSession, *, start_date: str, end_date: str, sup_byr: Optional[str] = None) -> Dict[str, Any]:
    sd = start_date.replace("-", ""); ed = end_date.replace("-", "")
    stmt = select(HyphenTaxInvoice)
    if sup_byr:
        stmt = stmt.where(HyphenTaxInvoice.sup_byr == sup_byr)
    rows = (await db.execute(stmt)).scalars().all()
    out, sales, purchase = [], 0.0, 0.0
    for t in rows:
        d = (t.issue_dt or "").replace("-", "")
        if d < sd or d > ed:
            continue
        amt = float(t.tot_amt or 0)
        if t.sup_byr == "01":
            sales += amt
        else:
            purchase += amt
        out.append({
            "issue_dt": d, "sup_byr": t.sup_byr,
            "counterparty": (t.byr_corp_nm if t.sup_byr == "01" else t.sup_corp_nm) or "",
            "sup_corp_nm": t.sup_corp_nm, "byr_corp_nm": t.byr_corp_nm,
            "tot_amt": amt, "sup_amt": float(t.sup_amt or 0), "tax_amt": float(t.tax_amt or 0),
            "tax_knd": t.tax_knd, "item_nm": t.item_nm,
        })
    out.sort(key=lambda x: x["issue_dt"], reverse=True)
    cov = await get_coverage(db, "tax", "tax")
    return {"count": len(out), "sales_amount": sales, "purchase_amount": purchase, "net": sales - purchase,
            "invoices": out, "covered_from": cov[0] if cov else None, "covered_to": cov[1] if cov else None}


# ============ 법인카드 ============

async def discover_cards(
    db: AsyncSession, *, card_cd: str, login_method: str = "CERT",
    user_id: Optional[str] = None, user_pw: Optional[str] = None, gustation: bool = False,
) -> List[Dict[str, Any]]:
    """카드사에서 보유 법인카드 목록 조회(/in0007000556). 저장 안 함. 인증서 재사용."""
    cert = await get_company_cert(db) if login_method.upper() == "CERT" else None
    sign = cert if cert else (None, None, None)
    if login_method.upper() == "CERT" and not cert:
        raise HyphenAPIError("저장된 법인 공동인증서 없음(은행 계좌를 인증서로 먼저 등록)", status_code=400)
    client = get_hyphen_client()
    data = await client.card_list(
        card_cd=card_cd, biz_no=COMPANY_BIZ_NO,
        sign_cert=sign[0], sign_pri=sign[1], sign_pw=sign[2],
        user_id=user_id, user_pw=user_pw, login_method=login_method, gustation=gustation,
    )
    common = (data or {}).get("common") if isinstance(data, dict) else {}
    if isinstance(common, dict) and common.get("errYn") == "Y":
        raise HyphenAPIError(common.get("errMsg") or "보유카드 조회 실패", status_code=400)
    out = []
    for r in _extract_list(data):
        if not isinstance(r, dict):
            continue
        no = str(r.get("cardNo") or "")
        if not no:
            continue
        out.append({
            "card_no": no, "card_nm": r.get("cardNm") or "", "card_brand": r.get("cardBrand") or "",
            "valid_date": r.get("validDate") or "", "active_yn": r.get("activeYn") or "",
        })
    return out



async def sync_cards(db: AsyncSession, *, start_date: str, end_date: str, gustation: bool = False) -> Dict[str, Any]:
    cert = await get_company_cert(db)
    client = get_hyphen_client()
    accts = (await db.execute(select(HyphenCardAccount))).scalars().all()
    total_inserted = 0
    results = []
    import asyncio
    for a in accts:
        sign = cert if (a.login_method == "CERT" and cert) else (None, None, None)

        async def _call():
            return await client.card_transactions(
                card_cd=a.card_cd, card_no=a.card_no, biz_no=COMPANY_BIZ_NO,
                start_date=start_date, end_date=end_date,
                sign_cert=sign[0], sign_pri=sign[1], sign_pw=sign[2],
                user_id=_dec(a.enc_user_id), user_pw=_dec(a.enc_user_pw),
                login_method=a.login_method, gustation=gustation,
            )
        try:
            data = await _call()
            common = (data or {}).get("common") if isinstance(data, dict) else {}
            # C0005(데이터 조회 중 오류 — 잠시 후 재시도) 시 1회 재시도
            if isinstance(common, dict) and common.get("errYn") == "Y" and "C0005" in str(common.get("errMsg") or ""):
                await asyncio.sleep(3)
                data = await _call()
                common = (data or {}).get("common") if isinstance(data, dict) else {}
        except HyphenAPIError as e:
            a.last_status = f"오류: {str(e)[:280]}"
            results.append({"card_no": a.card_no, "ok": False, "error": str(e)[:120]})
            continue
        if isinstance(common, dict) and common.get("errYn") == "Y":
            a.last_status = f"실패: {common.get('errMsg')}"
            results.append({"card_no": a.card_no, "ok": False, "error": common.get("errMsg")})
            continue
        rows = _extract_list(data)
        ins = 0
        hashes = []
        for r in rows:
            key = "|".join(str(r.get(k, "")) for k in ("useDt", "useTm", "apprNo", "useAmt", "useStore"))
            hashes.append(hashlib.sha256(f"{a.card_cd}|{a.card_no}|{key}".encode()).hexdigest())
        existing = set()
        if hashes:
            q = await db.execute(select(HyphenCardTx.dedup_hash).where(HyphenCardTx.dedup_hash.in_(hashes)))
            existing = set(q.scalars().all())
        for r, h in zip(rows, hashes):
            if h in existing:
                continue
            db.add(HyphenCardTx(
                card_cd=a.card_cd, card_no=(str(r.get("useCard") or a.card_no)[:30]),
                use_dt=str(r.get("useDt") or ""), use_tm=str(r.get("useTm") or "") or None,
                appr_no=(str(r.get("apprNo") or "")[:30]) or None,
                use_store=(str(r.get("useStore") or "")[:200]) or None,
                use_amt=_num(r.get("useAmt")),
                use_div=(str(r.get("useDiv") or "")[:30]) or None,
                appr_st=(str(r.get("apprSt") or "")[:20]) or None,
                inst_mon=(str(r.get("instMon") or "")[:10]) or None,
                store_biz_no=(str(r.get("storeBizNo") or "")[:20]) or None,
                tax_type=(str(r.get("taxType") or "")[:20]) or None,
                dedup_hash=h,
            ))
            existing.add(h)
            ins += 1
        a.last_synced_at = datetime.utcnow()
        a.last_status = f"성공 신규 {ins}건"
        await record_coverage(db, "card", a.card_no, start_date, end_date)
        total_inserted += ins
        results.append({"card_no": a.card_no, "ok": True, "inserted": ins, "fetched": len(rows)})
    await db.commit()
    return {"ok": True, "inserted": total_inserted, "results": results}


async def read_card_tx(db: AsyncSession, *, start_date: str, end_date: str) -> Dict[str, Any]:
    sd = start_date.replace("-", ""); ed = end_date.replace("-", "")
    rows = (await db.execute(select(HyphenCardTx))).scalars().all()
    out, total = [], 0.0
    for t in rows:
        d = (t.use_dt or "").replace("-", "")
        if d < sd or d > ed:
            continue
        amt = float(t.use_amt or 0)
        total += amt
        out.append({
            "use_dt": d, "use_tm": t.use_tm, "card_no": t.card_no, "card_cd": t.card_cd,
            "use_store": t.use_store, "use_amt": amt, "use_div": t.use_div,
            "appr_st": t.appr_st, "store_biz_no": t.store_biz_no,
        })
    out.sort(key=lambda x: (x["use_dt"], x["use_tm"] or ""), reverse=True)
    return {"count": len(out), "total": total, "transactions": out}
