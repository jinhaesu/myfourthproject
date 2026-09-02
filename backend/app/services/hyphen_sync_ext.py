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
from app.services.hyphen_sync import record_coverage, get_coverage, ensure_coverage

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
    # 커버 안 된 구간만 1회 당김 — 이미 조회한 범위는 외부 API 재호출 없음
    try:
        await ensure_tax_coverage(db, start_date=start_date, end_date=end_date)
    except Exception:
        logger.exception("세금계산서 커버리지 확보 스킵")
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
    # 승인내역(559)은 카드번호 16자리 전체가 필수 → 카드 1장당 1회 호출(각 카드 고유 16자리로 조회).
    for a in accts:
        sign = cert if (a.login_method == "CERT" and cert) else (None, None, None)
        try:
            data = await client.card_transactions(
                card_cd=a.card_cd, card_no=a.card_no, biz_no=COMPANY_BIZ_NO,
                start_date=start_date, end_date=end_date,
                sign_cert=sign[0], sign_pri=sign[1], sign_pw=sign[2],
                user_id=_dec(a.enc_user_id), user_pw=_dec(a.enc_user_pw),
                login_method=a.login_method, gustation=gustation,
            )
        except HyphenAPIError as e:
            a.last_status = f"오류: {str(e)[:280]}"
            results.append({"card_no": a.card_no[-4:], "ok": False, "error": str(e)[:120]})
            continue
        common = (data or {}).get("common") if isinstance(data, dict) else {}
        if isinstance(common, dict) and common.get("errYn") == "Y":
            msg = common.get("errMsg")
            a.last_status = f"실패: {msg}"
            results.append({"card_no": a.card_no[-4:], "ok": False, "error": msg})
            continue
        rows = _extract_list(data)
        hashes = []
        for r in rows:
            key = "|".join(str(r.get(k, "")) for k in ("useDt", "useTm", "apprNo", "useAmt", "useStore", "useCard"))
            hashes.append(hashlib.sha256(f"{a.card_cd}|{a.card_no}|{key}".encode()).hexdigest())
        existing = set()
        if hashes:
            q = await db.execute(select(HyphenCardTx.dedup_hash).where(HyphenCardTx.dedup_hash.in_(hashes)))
            existing = set(q.scalars().all())
        ins = 0
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
        results.append({"card_no": a.card_no[-4:], "ok": True, "inserted": ins, "fetched": len(rows)})
    # 집계 커버리지 — 카드 읽기 게이트용(이 범위는 재조회 시 API 재호출 안 함)
    if any(r.get("ok") for r in results):
        await record_coverage(db, "card", "ALL", start_date, end_date)
    await db.commit()
    return {"ok": True, "inserted": total_inserted, "results": results}


# 카드사코드 → 발급사명 (그랜터 organizationName 자리 채움)
CARD_ISSUER_NM = {
    "001": "신한카드", "002": "현대카드", "003": "삼성카드", "004": "KB국민카드",
    "005": "롯데카드", "006": "하나카드", "007": "우리카드", "008": "농협카드",
    "009": "씨티카드", "010": "BC카드", "011": "수협카드", "012": "광주카드",
    "013": "전북카드", "014": "제주카드",
}


def _card_key(card_cd: str, card_no: str) -> str:
    """비PII 안정 카드키 — HY-{카드사}-{뒷4}. 뒷4 충돌 없으면 카드 1:1."""
    d = re.sub(r"\D", "", card_no or "")
    return f"HY-{card_cd}-{d[-4:]}"


def _masked_no(card_no: str) -> str:
    d = re.sub(r"\D", "", card_no or "")
    return ("*" * max(0, len(d) - 4)) + d[-4:] if d else ""


async def card_tickets_as_expense(db: AsyncSession, *, start_date: str, end_date: str) -> List[Dict[str, Any]]:
    """하이픈 카드원장(HyphenCardTx) → 그랜터 EXPENSE_TICKET 형태로 정규화.
    card_management._fetch_expense_tickets가 이 셰이프를 그대로 소비(수정 불필요).
    ticket id = dedup_hash(재동기화에도 안정) → 분류가 재싱크에도 유지됨."""
    sd = start_date.replace("-", ""); ed = end_date.replace("-", "")
    accts = (await db.execute(select(HyphenCardAccount))).scalars().all()
    label_by_no: Dict[str, str] = {}
    for a in accts:
        label_by_no[re.sub(r"\D", "", a.card_no or "")] = a.label or ""
    rows = (await db.execute(select(HyphenCardTx))).scalars().all()
    out = []
    for t in rows:
        d = (t.use_dt or "").replace("-", "")
        if not d or d < sd or d > ed:
            continue
        tm = (t.use_tm or "").replace(":", "")
        iso = f"{d[:4]}-{d[4:6]}-{d[6:8]}"
        if len(tm) >= 6:
            iso += f"T{tm[:2]}:{tm[2:4]}:{tm[4:6]}"
        elif len(tm) >= 4:
            iso += f"T{tm[:2]}:{tm[2:4]}:00"
        no_digits = re.sub(r"\D", "", t.card_no or "")
        label = label_by_no.get(no_digits) or label_by_no.get(no_digits[-16:], "")
        out.append({
            "id": t.dedup_hash or f"hy-{t.id}",
            "amount": float(t.use_amt or 0),
            "transactAt": iso,
            "createdAt": iso,
            "cardUsage": {
                "storeName": t.use_store or "",
                "category": t.tax_type or "",
                "approvalNumber": t.appr_no or "",
                "paymentStatus": "NORMAL",
                "card": {
                    "id": _card_key(t.card_cd, t.card_no),
                    "number": _masked_no(t.card_no),
                    "organizationName": CARD_ISSUER_NM.get(t.card_cd, t.card_cd),
                    "name": label or None,
                    "nickname": label or None,
                },
            },
        })
    return out


async def has_hyphen_cards(db: AsyncSession) -> bool:
    """등록된 하이픈 카드가 하나라도 있으면 True → 카드 소스 하이픈 우선."""
    row = (await db.execute(select(HyphenCardAccount.id).limit(1))).first()
    return row is not None


async def ensure_card_coverage(db: AsyncSession, *, start_date: str, end_date: str) -> Dict[str, Any]:
    """카드 읽기 전 커버리지 게이트 — 커버 안 된 구간만 1회 sync. 커버된 범위는 API 재호출 0."""
    from app.models.hyphen_ext import HyphenSyncCoverage
    # ALL 집계키가 없으면 개별카드 커버리지에서 시드(기존 백필분 재스크랩 방지)
    if await get_coverage(db, "card", "ALL") is None:
        rows = (await db.execute(select(HyphenSyncCoverage).where(
            HyphenSyncCoverage.kind == "card", HyphenSyncCoverage.ckey != "ALL"))).scalars().all()
        if rows:
            mn = min(r.start_date for r in rows); mx = max(r.end_date for r in rows)
            await record_coverage(db, "card", "ALL", f"{mn[:4]}-{mn[4:6]}-{mn[6:8]}", f"{mx[:4]}-{mx[4:6]}-{mx[6:8]}")
            await db.commit()
    async def _sync(db_, *, start_date, end_date):
        await sync_cards(db_, start_date=start_date, end_date=end_date)
    return await ensure_coverage(db, "card", "ALL", start_date, end_date, _sync)


async def ensure_tax_coverage(db: AsyncSession, *, start_date: str, end_date: str) -> Dict[str, Any]:
    """세금계산서 읽기 전 커버리지 게이트 — 커버 안 된 구간만 1회 sync."""
    async def _sync(db_, *, start_date, end_date):
        await sync_tax_invoices(db_, start_date=start_date, end_date=end_date)
    return await ensure_coverage(db, "tax", "tax", start_date, end_date, _sync)


# ============ 은행/세금/자산 어댑터 (그랜터 셰이프로 정규화 → 백엔드 엔드포인트가 소비) ============

# 하이픈 은행코드 → 은행명 (프론트 BANKS와 동일)
BANK_CD_NAME = {
    "002": "산업은행", "003": "기업은행", "004": "국민은행", "007": "수협은행",
    "011": "농협은행", "020": "우리은행", "023": "SC제일은행", "027": "씨티은행",
    "031": "대구은행", "032": "부산은행", "034": "광주은행", "035": "제주은행",
    "037": "전북은행", "039": "경남은행", "045": "새마을금고", "048": "신협",
    "071": "우체국", "081": "하나은행", "088": "신한은행", "089": "K뱅크",
    "090": "카카오뱅크", "092": "토스뱅크", "105": "웰컴저축은행",
}


def _bank_nm(bank_cd: str) -> str:
    return BANK_CD_NAME.get((bank_cd or "").zfill(3), bank_cd or "")


def _synthetic_asset_id(acct_no: str) -> int:
    """하이픈 계좌용 안정 음수 정수 id (그랜터 양수 id와 충돌 방지)."""
    d = re.sub(r"\D", "", acct_no or "") or "0"
    return -(int(d[-9:]) + 1)


async def has_hyphen_bank(db: AsyncSession) -> bool:
    """하이픈 은행 계좌(인증정보)가 하나라도 있으면 True → 은행 소스 하이픈 우선."""
    row = (await db.execute(select(HyphenCredential.id).limit(1))).first()
    return row is not None


def _clean_label(label: Optional[str], bank_nm: str, last4: str) -> str:
    """깨진 라벨(mojibake, U+FFFD 포함) 또는 빈 값이면 은행명+뒷4로 대체."""
    s = (label or "").strip()
    if not s or "�" in s or "�" in s:
        return f"{bank_nm} {last4}".strip()
    return s


async def _hyphen_bank_creds(db: AsyncSession, *, dedup: bool = True) -> List[HyphenCredential]:
    """등록된 하이픈 은행 credential. dedup=True면 계좌번호(숫자) 기준 중복제거
    (last_balance 있는 것 우선, 그다음 최신 동기화 우선)."""
    rows = [c for c in (await db.execute(select(HyphenCredential))).scalars().all() if not c.is_expired]
    if not dedup:
        return rows
    best: Dict[str, HyphenCredential] = {}
    for c in rows:
        k = re.sub(r"\D", "", c.acct_no or "")
        if not k:
            continue
        cur = best.get(k)
        if cur is None:
            best[k] = c
            continue
        # 우선순위: last_balance 있음 > last_synced_at 최신
        cur_has = cur.last_balance is not None
        c_has = c.last_balance is not None
        if c_has and not cur_has:
            best[k] = c
        elif c_has == cur_has:
            cs = c.last_synced_at or datetime.min
            us = cur.last_synced_at or datetime.min
            if cs > us:
                best[k] = c
    return list(best.values())


async def bank_tickets_as_granter(db: AsyncSession, *, start_date: str, end_date: str,
                                  acct_no: Optional[str] = None) -> List[Dict[str, Any]]:
    """하이픈 은행원장(HyphenBankTx) → 그랜터 BANK_TRANSACTION_TICKET 형태로 정규화.
    _split_inflow_outflow / _build_bank_candidate / internal_transfers 가 이 셰이프를 그대로 소비.
    assetId = 계좌번호 기반 안정 음수 정수(계좌 식별용). id = HYB-{원장id}(재싱크에도 안정)."""
    from app.models.hyphen_bank_tx import HyphenBankTx
    sd = start_date.replace("-", ""); ed = end_date.replace("-", "")
    stmt = select(HyphenBankTx)
    if acct_no:
        stmt = stmt.where(HyphenBankTx.acct_no == acct_no)
    rows = (await db.execute(stmt)).scalars().all()
    out = []
    for t in rows:
        d = (t.tr_date or "").replace("-", "")
        if not d or d < sd or d > ed:
            continue
        tm = (t.tr_time or "").replace(":", "")
        iso = f"{d[:4]}-{d[4:6]}-{d[6:8]}"
        if len(tm) >= 6:
            iso += f"T{tm[:2]}:{tm[2:4]}:{tm[4:6]}"
        elif len(tm) >= 4:
            iso += f"T{tm[:2]}:{tm[2:4]}:00"
        ia = float(t.in_amt or 0); oa = float(t.out_amt or 0)
        is_in = ia > 0
        amt = ia if is_in else oa
        memo = (t.counterparty_name or t.tr_name or "").strip()
        out.append({
            "id": f"hy-{t.id}",  # hyphen_digest_data의 day_tickets와 동일 스킴(내부거래 제외 매칭)
            "ticketType": "BANK_TRANSACTION_TICKET",
            "transactionType": "IN" if is_in else "OUT",
            "amount": amt,
            "transactAt": iso,
            "createdAt": iso,
            "assetId": _synthetic_asset_id(t.acct_no),
            "bankTransaction": {
                "counterparty": memo,
                "content": memo,
                "description": (t.tr_name or "").strip(),
                "balanceAfter": float(t.balance) if t.balance is not None else None,
                "bankName": _bank_nm(t.bank_cd),
                "accountNumber": t.acct_no,
            },
        })
    out.sort(key=lambda x: (x["transactAt"]))
    return out


async def tax_invoices_as_granter(db: AsyncSession, *, start_date: str, end_date: str) -> List[Dict[str, Any]]:
    """하이픈 세금계산서(HyphenTaxInvoice) → 그랜터 TAX_INVOICE_TICKET 형태로 정규화.
    하이픈은 sup_byr(01=매출/02=매입)을 이미 보유 → 매출/매입 판정이 그랜터보다 정확.
    supplier/contractor.registrationNumber 로 _is_sales_tax_invoice 가 그대로 동작."""
    sd = start_date.replace("-", ""); ed = end_date.replace("-", "")
    rows = (await db.execute(select(HyphenTaxInvoice))).scalars().all()
    out = []
    for t in rows:
        d = (t.issue_dt or "").replace("-", "")
        if not d or d < sd or d > ed:
            continue
        iso = f"{d[:4]}-{d[4:6]}-{d[6:8]}" if len(d) >= 8 else d
        is_sales = t.sup_byr == "01"
        out.append({
            "id": t.dedup_hash or f"hyt-{t.id}",
            "ticketType": "TAX_INVOICE_TICKET",
            "transactionType": "IN" if is_sales else "OUT",
            "amount": float(t.tot_amt or 0),
            "transactAt": iso,
            "createdAt": iso,
            "taxInvoice": {
                "supplier": {
                    "registrationNumber": t.sup_biz_no or "",
                    "businessNumber": t.sup_biz_no or "",
                    "companyName": t.sup_corp_nm or "",
                },
                "contractor": {
                    "registrationNumber": t.byr_biz_no or "",
                    "businessNumber": t.byr_biz_no or "",
                    "companyName": t.byr_corp_nm or "",
                },
                "supplyAmount": float(t.sup_amt or 0),
                "taxAmount": float(t.tax_amt or 0),
                "totalAmount": float(t.tot_amt or 0),
                "itemName": t.item_nm or "",
            },
        })
    return out


async def hyphen_assets_all(db: AsyncSession) -> Dict[str, Any]:
    """자산목록을 하이픈 단일소스로 구성(그랜터 미사용). 대시보드와 동일한 계좌·잔액 기준.
    BANK_ACCOUNT=은행 credential(중복제거·라벨보정·refresh된 last_balance), CARD=등록 법인카드.
    증권·홈택스·이커머스는 하이픈 미제공 → 빈 목록."""
    creds = await _hyphen_bank_creds(db)  # 계좌번호 기준 중복제거
    bank_list = []
    for c in creds:
        k = re.sub(r"\D", "", c.acct_no or "")
        if not k:
            continue
        bank_nm = _bank_nm(c.bank_cd)
        label = _clean_label(c.label, bank_nm, k[-4:])
        bal = float(c.last_balance) if c.last_balance is not None else 0.0
        bank_list.append({
            "id": _synthetic_asset_id(c.acct_no),
            "name": label, "nickname": label, "number": c.acct_no,
            "organizationName": bank_nm, "bankName": bank_nm,
            "isActive": True, "isHidden": False, "isDormant": False, "_source": "hyphen",
            "bankAccount": {
                "accountNumber": c.acct_no, "accountBalance": bal, "originalBalance": bal,
                "bankName": bank_nm, "currencyCode": "KRW",
                "nickName": label, "accountName": label, "isTransactionVisible": True,
            },
        })
    bank_list.sort(key=lambda a: a["bankAccount"]["accountBalance"], reverse=True)

    # 카드 — 등록 법인카드(HyphenCardAccount)
    card_list = []
    for a in (await db.execute(select(HyphenCardAccount))).scalars().all():
        issuer = CARD_ISSUER_NM.get(a.card_cd, a.card_cd)
        card_list.append({
            "id": _card_key(a.card_cd, a.card_no),
            "name": a.label or issuer, "nickname": a.label or None,
            "number": _masked_no(a.card_no), "organizationName": issuer, "_source": "hyphen",
            "card": {
                "id": _card_key(a.card_cd, a.card_no),
                "number": _masked_no(a.card_no), "organizationName": issuer,
                "name": a.label or None, "nickname": a.label or None,
            },
        })
    return {
        "BANK_ACCOUNT": bank_list, "CARD": card_list,
        "HOME_TAX_ACCOUNT": [], "SECURITIES_ACCOUNT": [], "ECOMMERCE": [],
    }


async def merge_assets_all(db: AsyncSession, granter_assets: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """그랜터 자산목록에 하이픈 계좌를 병합.
    - 그랜터 BANK_ACCOUNT 중 하이픈 계좌와 매칭되면 잔액을 하이픈 last_balance 로 보정(0/공백일 때).
    - 그랜터에 없는 하이픈 계좌(예: 그랜터 연동해제된 우리은행)는 합성 BANK_ACCOUNT 로 추가.
    - 비은행 자산(CARD/HOME_TAX/SECURITIES/ECOMMERCE)은 그랜터 그대로.
    """
    result: Dict[str, Any] = dict(granter_assets or {})
    bank_list = list(result.get("BANK_ACCOUNT") or [])

    creds = await _hyphen_bank_creds(db)
    # 그랜터 계좌 계좌번호(숫자) 집합 + last_balance 보정
    def _digits(s):
        return re.sub(r"\D", "", str(s or ""))
    hy_by_digits = {}
    for c in creds:
        k = _digits(c.acct_no)
        if k:
            hy_by_digits[k] = c

    granter_digits = set()
    for a in bank_list:
        ba = a.get("bankAccount") or {}
        k = _digits(ba.get("accountNumber") or a.get("number"))
        if k:
            granter_digits.add(k)
        # 그랜터 잔액이 0/None 이면 하이픈 잔액으로 보정
        cur = hy_by_digits.get(k)
        if cur is not None and cur.last_balance is not None:
            gb = ba.get("accountBalance")
            if not gb:
                ba["accountBalance"] = float(cur.last_balance)
                if ba.get("originalBalance") in (None, 0):
                    ba["originalBalance"] = float(cur.last_balance)
                a["bankAccount"] = ba

    # 그랜터에 없는 하이픈 계좌 추가 (계좌번호 기준 중복 방지)
    seen_hy: set = set()
    for c in creds:
        k = _digits(c.acct_no)
        if not k or k in granter_digits or k in seen_hy:
            continue
        seen_hy.add(k)
        bank_nm = _bank_nm(c.bank_cd)
        label = _clean_label(c.label, bank_nm, k[-4:])
        bal = float(c.last_balance) if c.last_balance is not None else 0.0
        bank_list.append({
            "id": _synthetic_asset_id(c.acct_no),
            "name": label,
            "nickname": label,
            "number": c.acct_no,
            "organizationName": bank_nm,
            "bankName": bank_nm,
            "isActive": True,
            "isHidden": False,
            "isDormant": False,
            "_source": "hyphen",
            "bankAccount": {
                "accountNumber": c.acct_no,
                "accountBalance": bal,
                "originalBalance": bal,
                "bankName": bank_nm,
                "currencyCode": "KRW",
                "nickName": label,
                "accountName": label,
                "isTransactionVisible": True,
            },
        })

    result["BANK_ACCOUNT"] = bank_list
    return result


# ============ 현금영수증 (홈택스 조회, 발행 아님) ============

def _g(r: Dict[str, Any], *keys: str) -> str:
    for k in keys:
        v = r.get(k)
        if v not in (None, ""):
            return str(v).strip()
    return ""


async def sync_cash_receipts(db: AsyncSession, *, start_date: str, end_date: str, gustation: bool = False) -> Dict[str, Any]:
    """홈택스 현금영수증(매출01/매입02) 조회→원장 저장. 발행 아님.
    응답 스키마 불확실 → 유연 추출 + 원본 raw 저장(검증용)."""
    import json as _json
    from app.models.hyphen_ext import HyphenCashReceipt
    cert = await get_company_cert(db)
    if not cert:
        return {"ok": False, "error": "저장된 법인 공동인증서 없음", "inserted": 0}
    sign_cert, sign_pri, sign_pw = cert
    client = get_hyphen_client()
    inserted = 0
    for sup_byr in ("01", "02"):
        try:
            data = await client.cash_receipts(
                biz_no=COMPANY_BIZ_NO, sup_byr=sup_byr, start_date=start_date, end_date=end_date,
                sign_cert=sign_cert, sign_pri=sign_pri, sign_pw=sign_pw, gustation=gustation,
            )
        except HyphenAPIError as e:
            logger.warning("현금영수증 %s 조회 실패: %s", sup_byr, e)
            continue
        common = (data or {}).get("common") if isinstance(data, dict) else {}
        if isinstance(common, dict) and common.get("errYn") == "Y":
            logger.warning("현금영수증 %s errMsg: %s", sup_byr, common.get("errMsg"))
            continue
        rows = _extract_list(data)
        for r in rows:
            tr_dt = _g(r, "trDt", "dealDt", "apvDt", "issueDt", "usedDt")
            appr = _g(r, "apvNo", "apprvNo", "approvalNo", "issueNo")
            tot = _num(_g(r, "totAmt", "amt", "dealAmt", "trAmt") or 0)
            key = f"{sup_byr}|{tr_dt}|{appr}|{tot}"
            h = hashlib.sha256(key.encode()).hexdigest()
            exists = (await db.execute(select(HyphenCashReceipt.id).where(HyphenCashReceipt.dedup_hash == h))).first()
            if exists:
                continue
            db.add(HyphenCashReceipt(
                biz_no=COMPANY_BIZ_NO, sup_byr=sup_byr,
                tr_dt=tr_dt or "", appr_no=(appr[:40] or None),
                frcs_biz_no=(_g(r, "frcsBizNo", "frcBizNo", "spBizNo", "mrcBizNo")[:20] or None),
                frcs_nm=(_g(r, "frcsNm", "frcNm", "spNm", "mrcNm", "storeNm")[:200] or None),
                tot_amt=tot,
                sup_amt=_num(_g(r, "supAmt", "suppAmt", "splCft", "supplyAmt") or 0),
                tax_amt=_num(_g(r, "taxAmt", "vatAmt", "vat") or 0),
                item_nm=(_g(r, "itemNm", "goodsNm")[:300] or None),
                raw=_json.dumps(r, ensure_ascii=False)[:2000],
                dedup_hash=h,
            ))
            inserted += 1
    await record_coverage(db, "cashrcpt", "cashrcpt", start_date, end_date)
    await db.commit()
    return {"ok": True, "inserted": inserted}


async def ensure_cashreceipt_coverage(db: AsyncSession, *, start_date: str, end_date: str) -> Dict[str, Any]:
    async def _sync(db_, *, start_date, end_date):
        await sync_cash_receipts(db_, start_date=start_date, end_date=end_date)
    return await ensure_coverage(db, "cashrcpt", "cashrcpt", start_date, end_date, _sync)


async def cash_receipts_as_granter(db: AsyncSession, *, start_date: str, end_date: str) -> List[Dict[str, Any]]:
    """하이픈 현금영수증 → 그랜터 CASH_RECEIPT_TICKET 형태. 매출01=IN(issuer 우리회사), 매입02=OUT(issuer 가맹점)."""
    from app.models.hyphen_ext import HyphenCashReceipt
    sd = start_date.replace("-", ""); ed = end_date.replace("-", "")
    rows = (await db.execute(select(HyphenCashReceipt))).scalars().all()
    out = []
    for t in rows:
        d = (t.tr_dt or "").replace("-", "")
        if not d or d < sd or d > ed:
            continue
        iso = f"{d[:4]}-{d[4:6]}-{d[6:8]}" if len(d) >= 8 else d
        is_sales = t.sup_byr == "01"
        if is_sales:
            issuer = {"companyName": "조인앤조인", "registrationNumber": COMPANY_BIZ_NO}
        else:
            issuer = {"companyName": t.frcs_nm or "", "registrationNumber": t.frcs_biz_no or ""}
        out.append({
            "id": t.dedup_hash or f"hycr-{t.id}",
            "ticketType": "CASH_RECEIPT_TICKET",
            "transactionType": "IN" if is_sales else "OUT",
            "amount": float(t.tot_amt or 0),
            "taxAmount": float(t.tax_amt or 0),
            "transactAt": iso,
            "createdAt": iso,
            "cashReceipt": {
                "issuer": issuer,
                "supplyValue": float(t.sup_amt or 0),
                "vat": float(t.tax_amt or 0),
            },
        })
    return out


def _extract_accounts_balances(data: Any) -> Dict[str, float]:
    """하이픈 계좌목록 응답 → {계좌번호(숫자): 잔액}."""
    node = data
    lst = None
    for _ in range(8):
        if isinstance(node, dict):
            if isinstance(node.get("list"), list):
                lst = node["list"]; break
            node = node.get("data")
        else:
            break
    out: Dict[str, float] = {}
    if not isinstance(lst, list):
        return out
    for a in lst:
        if not isinstance(a, dict):
            continue
        acct_no = str(a.get("acctNo") or a.get("accountNo") or "")
        k = re.sub(r"\D", "", acct_no)
        if not k:
            continue
        bal = a.get("curBal") or a.get("balance") or a.get("ablBal")
        out[k] = _num(bal)
    return out


async def refresh_account_balances(db: AsyncSession) -> Dict[str, Any]:
    """저장된 인증정보로 은행별 계좌목록(잔액 포함)을 1회 조회 → last_balance 갱신.
    거래가 없어 last_balance가 비어있던 계좌도 실제 잔액으로 채움. 은행당 1콜(비용 최소)."""
    from app.services.hyphen_credentials import _dec
    from collections import defaultdict
    creds = [c for c in (await db.execute(select(HyphenCredential))).scalars().all() if not c.is_expired]
    by_bank: Dict[str, List[HyphenCredential]] = defaultdict(list)
    for c in creds:
        by_bank[c.bank_cd].append(c)
    client = get_hyphen_client()
    cert = await get_company_cert(db)  # CERT 은행 공용 법인 공동인증서
    updated = 0
    banks_ok = 0
    for bank_cd, group in by_bank.items():
        # 로그인 대표: ID 계정 있으면 그걸로, 아니면 CERT
        rep = next((c for c in group if c.login_method == "ID" and c.enc_user_id), group[0])
        try:
            if rep.login_method == "ID":
                kwargs = dict(login_method="ID", user_id=_dec(rep.enc_user_id), user_pw=_dec(rep.enc_user_pw))
            else:
                sc = _dec(rep.enc_sign_cert); sp = _dec(rep.enc_sign_pri); spw = _dec(rep.enc_sign_pw)
                if not (sc and sp and spw) and cert:
                    sc, sp, spw = cert
                kwargs = dict(login_method="CERT", sign_cert=sc, sign_pri=sp, sign_pw=spw)
            acct_pw = _dec(rep.enc_acct_pw)
            bal_map: Dict[str, float] = {}
            # 입출금(01) + 외화 등은 은행마다 다름 — 01 우선, 실패시 무시
            for gubun in ("01",):
                try:
                    data = await client.list_accounts(bank_cd=bank_cd, acct_pw=acct_pw, gubun=gubun, **kwargs)
                    common = (data or {}).get("common") if isinstance(data, dict) else {}
                    if isinstance(common, dict) and common.get("errYn") == "Y":
                        continue
                    bal_map.update(_extract_accounts_balances(data))
                except HyphenAPIError:
                    continue
            if not bal_map:
                continue
            banks_ok += 1
            for c in group:
                k = re.sub(r"\D", "", c.acct_no or "")
                if k in bal_map:
                    c.last_balance = bal_map[k]
                    updated += 1
        except Exception:
            logger.exception("잔액 갱신 실패 bank_cd=%s", bank_cd)
            continue
    await db.commit()
    return {"ok": True, "banks_ok": banks_ok, "updated": updated}


async def daily_report_as_granter(db: AsyncSession, *, start_date: str, end_date: str) -> Optional[Dict[str, Any]]:
    """하이픈 원장 기반 일일 재무 리포트(그랜터 daily-report 셰이프: {total:{currentBalance,previousBalance,inAmount,outAmount}}).
    잔액 = 전 계좌 last_balance 합, 입출금 = 기간 은행원장 합계."""
    creds = await _hyphen_bank_creds(db)
    if not creds:
        return None
    # 계좌번호 중복 제거 후 last_balance 합
    seen = {}
    for c in creds:
        d = re.sub(r"\D", "", c.acct_no or "")
        if d:
            seen[d] = float(c.last_balance) if c.last_balance is not None else 0.0
    balance = sum(seen.values())
    tickets = await bank_tickets_as_granter(db, start_date=start_date, end_date=end_date)
    in_amt = sum(t["amount"] for t in tickets if t["transactionType"] == "IN")
    out_amt = sum(t["amount"] for t in tickets if t["transactionType"] == "OUT")
    return {
        "total": {
            "currentBalance": balance,
            "previousBalance": balance - (in_amt - out_amt),
            "inAmount": in_amt,
            "outAmount": out_amt,
        },
    }


# 카드사명(그랜터 issuer/라벨) → 하이픈 카드사코드. 뒷4 충돌을 카드사로 분리.
_ISSUER_CD_TOKENS = {
    "001": ("신한",), "002": ("현대",), "003": ("삼성",),
    "004": ("국민", "kb", "케이비"), "005": ("롯데",), "006": ("하나",),
    "007": ("우리",), "008": ("농협", "nh"), "009": ("씨티", "citi"),
    "010": ("bc", "비씨"), "011": ("수협",), "012": ("광주",),
    "013": ("전북",), "014": ("제주",),
}


def _issuer_to_card_cd(name: Optional[str]) -> Optional[str]:
    """카드사명 문자열 → 카드사코드(001~014). 매칭 실패 시 None."""
    s = (name or "").strip().lower()
    if not s:
        return None
    for cd, toks in _ISSUER_CD_TOKENS.items():
        for tk in toks:
            if tk in s:
                return cd
    return None


def _alias_last4(al) -> str:
    """별칭의 뒷4 — last4 컬럼 우선, 없으면 옛 card_key 문자열 말미의 4자리."""
    d = re.sub(r"\D", "", al.last4 or "")
    if len(d) >= 4:
        return d[-4:]
    m = re.search(r"(\d{4})\D*$", al.card_key or "")
    return m.group(1) if m else ""


def _alias_email_list(al) -> List[str]:
    import json as _json
    raw = getattr(al, "assigned_emails", None)
    if raw:
        try:
            v = _json.loads(raw)
            if isinstance(v, list):
                return [str(e).strip().lower() for e in v if e and str(e).strip()]
        except (ValueError, TypeError):
            pass
    if al.assigned_email:
        return [al.assigned_email.strip().lower()]
    return []


def _resolve_alias_to_new_key(al, by_cd_last4, by_last4) -> Optional[str]:
    """별칭 → 하이픈 카드키 후보. (카드사+뒷4) 우선, 실패 시 뒷4 단독(유일할 때)."""
    l4 = _alias_last4(al)
    if not l4:
        return None
    cd = _issuer_to_card_cd(al.issuer) or _issuer_to_card_cd(al.nickname)
    if cd:
        c = by_cd_last4.get((cd, l4))
        if c and len(c) == 1:
            return c[0]
    c = by_last4.get(l4)
    if c and len(c) == 1:
        return c[0]
    return None


def _build_hyphen_key_maps(accts):
    by_cd_last4: Dict[tuple, List[str]] = {}
    by_last4: Dict[str, List[str]] = {}
    new_keys: set = set()
    for a in accts:
        d = re.sub(r"\D", "", a.card_no or "")
        l4 = d[-4:]
        key = _card_key(a.card_cd, a.card_no)
        new_keys.add(key)
        by_cd_last4.setdefault((a.card_cd, l4), []).append(key)
        by_last4.setdefault(l4, []).append(key)
    return new_keys, by_cd_last4, by_last4


async def rekey_card_aliases_by_last4(db: AsyncSession) -> int:
    """그랜터 card.id 기반 CardAlias/분류/월마감 키를 하이픈 카드키(HY-cd-last4)로 이관.
    (카드사+뒷4) 매칭으로 충돌 해소. 멱등(이미 하이픈키면 스킵). 배정·별칭을 소스 전환에도 보존.
    대상 하이픈키에 빈 별칭이 있으면 배정/이름을 병합해 유실 방지."""
    from app.models.card_alias import CardAlias
    from app.models.card_classification import CardUsageClassification, CardMonthlyClosing
    import json as _json
    accts = (await db.execute(select(HyphenCardAccount))).scalars().all()
    new_keys, by_cd_last4, by_last4 = _build_hyphen_key_maps(accts)
    aliases = (await db.execute(select(CardAlias))).scalars().all()
    by_key = {al.card_key: al for al in aliases}
    moved = 0

    async def _move_rows(old_key: str, new_key: str):
        for M in (CardUsageClassification, CardMonthlyClosing):
            for r in (await db.execute(select(M).where(M.card_key == old_key))).scalars().all():
                r.card_key = new_key

    for al in aliases:
        if al.card_key in new_keys:
            continue  # 이미 하이픈키
        new_key = _resolve_alias_to_new_key(al, by_cd_last4, by_last4)
        if not new_key or new_key == al.card_key:
            continue
        target = by_key.get(new_key)
        if target is not None and target is not al:
            # 충돌 — 대상에 배정/이름이 없으면 옛 별칭 값을 병합, 그 후 옛 별칭 제거.
            if not _alias_email_list(target):
                em = _alias_email_list(al)
                target.assigned_emails = _json.dumps(em) if em else None
                target.assigned_email = em[0] if em else None
            if al.nickname and (not target.nickname or target.nickname in (target.card_key, target.issuer or "")):
                target.nickname = al.nickname
            for f in ("color", "memo", "issuer", "last4"):
                if getattr(al, f) and not getattr(target, f):
                    setattr(target, f, getattr(al, f))
            await _move_rows(al.card_key, new_key)
            await db.delete(al)
            by_key.pop(al.card_key, None)
            moved += 1
            continue
        old = al.card_key
        al.card_key = new_key
        by_key.pop(old, None)
        by_key[new_key] = al
        await _move_rows(old, new_key)
        moved += 1
    if moved:
        await db.commit()
    return moved


async def diagnose_card_aliases(db: AsyncSession) -> Dict[str, Any]:
    """카드 별칭↔하이픈 카드 매칭 진단(읽기 전용). 배포 후 이관 결과 확인용."""
    from app.models.card_alias import CardAlias
    accts = (await db.execute(select(HyphenCardAccount))).scalars().all()
    new_keys, by_cd_last4, by_last4 = _build_hyphen_key_maps(accts)
    hyphen_cards = [{
        "card_cd": a.card_cd, "issuer": CARD_ISSUER_NM.get(a.card_cd, a.card_cd),
        "last4": re.sub(r"\D", "", a.card_no or "")[-4:], "key": _card_key(a.card_cd, a.card_no),
        "label": a.label,
    } for a in accts]
    aliases = (await db.execute(select(CardAlias))).scalars().all()
    rows, matched, orphaned = [], 0, 0
    for al in aliases:
        is_hy = al.card_key in new_keys
        cand = None if is_hy else _resolve_alias_to_new_key(al, by_cd_last4, by_last4)
        status = "already_hyphen" if is_hy else ("will_move" if cand else "UNMATCHED")
        if is_hy:
            matched += 1
        elif not cand:
            orphaned += 1
        rows.append({
            "card_key": al.card_key, "nickname": al.nickname, "issuer": al.issuer,
            "last4": al.last4, "derived_last4": _alias_last4(al),
            "issuer_cd": _issuer_to_card_cd(al.issuer),
            "assigned": _alias_email_list(al), "status": status, "target_key": cand,
        })
    return {
        "hyphen_cards_count": len(hyphen_cards), "hyphen_cards": hyphen_cards,
        "aliases_count": len(rows), "already_hyphen": matched,
        "will_move": sum(1 for r in rows if r["status"] == "will_move"),
        "unmatched": orphaned, "aliases": rows,
    }


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
