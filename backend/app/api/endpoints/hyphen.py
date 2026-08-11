"""
HYPHEN (하이픈) 라우터 — 그랜터 대체 PoC (계좌 속도 벤치마크 우선)

엔드포인트:
- GET  /hyphen/health          : 설정/암호화 가능 여부 진단 (호출 없음)
- POST /hyphen/token-test      : OAuth 토큰 발급 실제 시도
- POST /hyphen/encrypt-test    : ekey 암호화 결과 확인 (평문→Base64)
- POST /hyphen/raw             : 임의 path 호출 (응답 형태 탐색용)
- POST /hyphen/account/transactions : 계좌 거래내역 조회
- POST /hyphen/benchmark/account    : 그랜터 vs 하이픈 계좌 조회 속도 비교

전부 회계 관리자 전용 (router.py에서 ADMIN_ONLY 부착).
시크릿(HYPHEN_USER_ID/HKEY/EKEY)은 서버 환경변수로만.
"""
import time
import base64
import logging
from datetime import datetime, timedelta
from typing import Optional, Dict, Any, List

from fastapi import APIRouter, Body, HTTPException, Depends, Request
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from jose import JWTError, jwt

from app.core.database import get_db
from app.core.config import settings
from app.core.security import get_current_user
from app.services.hyphen_client import get_hyphen_client, HyphenAPIError
from app.services.granter_client import get_granter_client, GranterAPIError
from app.services import hyphen_credentials as creds_svc
from app.services import hyphen_sync as sync_svc
from app.services import hyphen_sync_ext as ext_svc
from app.core.security import data_encryption
from app.models.hyphen_ext import HyphenCardAccount
from sqlalchemy import select as _select

logger = logging.getLogger(__name__)
router = APIRouter()
# 로컬 등록도구용 공개 라우터 (1회용 코드로 게이트 — ADMIN_ONLY 미적용)
public_router = APIRouter()

_REG_CODE_PURPOSE = "hyphen_reg"
_REG_CODE_TTL_SEC = 600  # 10분


def _err(e: HyphenAPIError):
    return HTTPException(status_code=e.status_code or 502, detail={"error": str(e), "body": e.body})


@router.get("/health")
async def hyphen_health():
    c = get_hyphen_client()
    return {
        "configured": c.is_configured,
        "can_encrypt": c.can_encrypt,
        "base_url": c.base_url,
        "user_id": (c.user_id[:3] + "***") if c.user_id else "",
        "has_hkey": bool(c.hkey),
        "has_ekey": bool(c.ekey),
        "timeout": c.timeout,
    }


@router.post("/token-test")
async def hyphen_token_test():
    c = get_hyphen_client()
    try:
        return await c.token_info()
    except HyphenAPIError as e:
        raise _err(e)


class EncryptBody(BaseModel):
    plaintext: str


@router.post("/encrypt-test")
async def hyphen_encrypt_test(body: EncryptBody):
    c = get_hyphen_client()
    try:
        return {"ciphertext_b64": c.encrypt(body.plaintext)}
    except HyphenAPIError as e:
        raise _err(e)


class RawBody(BaseModel):
    path: str
    payload: Optional[Dict[str, Any]] = None
    encrypt_fields: Optional[List[str]] = None
    method: str = "POST"
    extra_headers: Optional[Dict[str, str]] = None


@router.post("/raw")
async def hyphen_raw(body: RawBody):
    """임의 하이픈 path 호출 — 개발가이드 확정 전 응답 형태 탐색용."""
    c = get_hyphen_client()
    t0 = time.perf_counter()
    try:
        data = await c.call(
            body.path,
            body.payload,
            encrypt_fields=body.encrypt_fields,
            method=body.method,
            extra_headers=body.extra_headers,
        )
    except HyphenAPIError as e:
        raise _err(e)
    elapsed = time.perf_counter() - t0
    return {"elapsed_sec": round(elapsed, 3), "data": data}


class AccountTxBody(BaseModel):
    bank_cd: str
    acct_no: str
    start_date: str
    end_date: str
    # 은행사이트/계좌 인증 (평문으로 넘기면 서버가 ekey 암호화)
    user_id_enc: Optional[str] = None
    user_pw_enc: Optional[str] = None
    acct_pw_enc: Optional[str] = None
    id_no: Optional[str] = None
    path: Optional[str] = None
    extra: Optional[Dict[str, Any]] = None


@router.post("/account/transactions")
async def hyphen_account_transactions(body: AccountTxBody):
    c = get_hyphen_client()
    t0 = time.perf_counter()
    try:
        data = await c.account_transactions(
            bank_cd=body.bank_cd,
            acct_no=body.acct_no,
            start_date=body.start_date,
            end_date=body.end_date,
            user_id_enc=body.user_id_enc,
            user_pw_enc=body.user_pw_enc,
            acct_pw_enc=body.acct_pw_enc,
            id_no=body.id_no,
            path=body.path,
            extra=body.extra,
        )
    except HyphenAPIError as e:
        raise _err(e)
    elapsed = time.perf_counter() - t0
    return {"elapsed_sec": round(elapsed, 3), "data": data}


class BenchmarkBody(BaseModel):
    # 하이픈 계좌 조회 파라미터
    bank_cd: str
    acct_no: str
    start_date: str
    end_date: str
    user_id_enc: Optional[str] = None
    user_pw_enc: Optional[str] = None
    acct_pw_enc: Optional[str] = None
    id_no: Optional[str] = None
    hyphen_path: Optional[str] = None
    hyphen_extra: Optional[Dict[str, Any]] = None
    # 그랜터 비교 대상 assetId (같은 계좌의 그랜터 자산 id)
    granter_asset_id: Optional[int] = None


def _count_rows(data: Any) -> int:
    if isinstance(data, list):
        return len(data)
    if isinstance(data, dict):
        for k in ("data", "items", "list", "resTrHistList", "transactions"):
            v = data.get(k)
            if isinstance(v, list):
                return len(v)
    return 0


@router.post("/benchmark/account")
async def hyphen_benchmark_account(body: BenchmarkBody):
    """같은 계좌·기간을 하이픈과 그랜터로 각각 조회해 소요시간·건수 비교."""
    hy = get_hyphen_client()
    gr = get_granter_client()
    result: Dict[str, Any] = {"period": f"{body.start_date} ~ {body.end_date}"}

    # 하이픈
    h0 = time.perf_counter()
    try:
        hdata = await hy.account_transactions(
            bank_cd=body.bank_cd,
            acct_no=body.acct_no,
            start_date=body.start_date,
            end_date=body.end_date,
            user_id_enc=body.user_id_enc,
            user_pw_enc=body.user_pw_enc,
            acct_pw_enc=body.acct_pw_enc,
            id_no=body.id_no,
            path=body.hyphen_path,
            extra=body.hyphen_extra,
        )
        result["hyphen"] = {
            "ok": True,
            "elapsed_sec": round(time.perf_counter() - h0, 3),
            "rows": _count_rows(hdata),
        }
    except HyphenAPIError as e:
        result["hyphen"] = {
            "ok": False,
            "elapsed_sec": round(time.perf_counter() - h0, 3),
            "error": str(e),
            "body": e.body,
        }

    # 그랜터 (BANK_TRANSACTION_TICKET, 같은 기간)
    g0 = time.perf_counter()
    try:
        payload = {
            "ticketType": "BANK_TRANSACTION_TICKET",
            "startDate": body.start_date,
            "endDate": body.end_date,
        }
        if body.granter_asset_id:
            payload["assetId"] = body.granter_asset_id
        gdata = await gr.list_tickets(payload)
        rows = gdata if isinstance(gdata, list) else (gdata.get("data", []) if isinstance(gdata, dict) else [])
        result["granter"] = {
            "ok": True,
            "elapsed_sec": round(time.perf_counter() - g0, 3),
            "rows": len(rows),
        }
    except GranterAPIError as e:
        result["granter"] = {
            "ok": False,
            "elapsed_sec": round(time.perf_counter() - g0, 3),
            "error": str(e),
        }

    # 요약
    hy_ok = result.get("hyphen", {}).get("ok")
    gr_ok = result.get("granter", {}).get("ok")
    if hy_ok and gr_ok:
        h = result["hyphen"]["elapsed_sec"]
        g = result["granter"]["elapsed_sec"]
        result["summary"] = {
            "faster": "hyphen" if h < g else "granter",
            "speedup_x": round(g / h, 2) if h > 0 else None,
        }
    return result


# ============ 전계좌 조회 (아이디 로그인 → 계좌목록) ============

class ListAccountsBody(BaseModel):
    bank_cd: str
    login_method: str = "ID"
    user_id: Optional[str] = None
    user_pw: Optional[str] = None
    acct_pw: Optional[str] = None
    # CERT(인증서) 로그인 — 파일 base64 + 인증서 비밀번호
    sign_cert_b64: Optional[str] = None
    sign_pri_b64: Optional[str] = None
    sign_pw: Optional[str] = None
    gubun: str = "01"
    gustation: bool = False


def _cert_pem_from_b64(cert_b64: Optional[str], pri_b64: Optional[str]):
    """업로드된 인증서/개인키 base64 → PEM 문자열 (전계좌 조회용)."""
    cert_pem = pri_pem = None
    cb = _b64_to_bytes(cert_b64)
    pb = _b64_to_bytes(pri_b64)
    if cb:
        cert_pem = cb.decode() if cb[:20].lstrip().startswith(b"-----BEGIN") else creds_svc.cert_der_to_pem(cb)["pem"]
    if pb:
        pri_pem = pb.decode() if pb[:20].lstrip().startswith(b"-----BEGIN") else creds_svc.key_der_to_pem(pb)
    return cert_pem, pri_pem


def _extract_accounts(data: Any) -> List[Dict[str, Any]]:
    """하이픈 전계좌 응답(중첩 가능)에서 계좌 배열 추출 후 정규화."""
    node = data
    lst = None
    for _ in range(8):
        if isinstance(node, dict):
            if isinstance(node.get("list"), list):
                lst = node["list"]
                break
            node = node.get("data")
        else:
            break
    if not isinstance(lst, list):
        return []
    out = []
    for a in lst:
        if not isinstance(a, dict):
            continue
        acct_no = str(a.get("acctNo") or a.get("accountNo") or "")
        if not acct_no:
            continue
        out.append({
            "acctNo": acct_no,
            "acctNm": a.get("acctNm") or a.get("acctNick") or a.get("acctDisp") or "",
            "acctHolder": a.get("acctHolder") or "",
            "balance": a.get("curBal") or a.get("balance") or a.get("ablBal") or "",
            "curCd": a.get("curCd") or "KRW",
        })
    return out


@router.post("/list-accounts")
async def hyphen_list_accounts(body: ListAccountsBody):
    """아이디(또는 인증서) 로그인으로 은행의 전 계좌 목록을 조회 (저장 안 함)."""
    client = get_hyphen_client()
    sign_cert = sign_pri = None
    if body.login_method.upper() == "CERT":
        sign_cert, sign_pri = _cert_pem_from_b64(body.sign_cert_b64, body.sign_pri_b64)
    t0 = time.perf_counter()
    try:
        data = await client.list_accounts(
            bank_cd=body.bank_cd,
            login_method=body.login_method,
            user_id=body.user_id,
            user_pw=body.user_pw,
            acct_pw=body.acct_pw,
            sign_cert=sign_cert,
            sign_pri=sign_pri,
            sign_pw=body.sign_pw,
            gubun=body.gubun,
            gustation=body.gustation,
        )
    except HyphenAPIError as e:
        raise _err(e)
    elapsed = round(time.perf_counter() - t0, 2)
    common = (data or {}).get("common") if isinstance(data, dict) else {}
    if isinstance(common, dict) and common.get("errYn") == "Y":
        raise HTTPException(status_code=400, detail={
            "error": common.get("errMsg") or "계좌 조회 실패", "errCd": common.get("errCd"),
        })
    return {"elapsed_sec": elapsed, "accounts": _extract_accounts(data)}


# ============ 인증정보 (암호화 보관, 30일 TTL) ============

class RegisterCredBody(BaseModel):
    bank_cd: str
    acct_no: str
    login_method: str = "CERT"
    label: Optional[str] = None
    # 공통
    acct_pw: Optional[str] = None
    # CERT: 인증서 파일(base64 of der/key) 또는 PEM 문자열(base64로 감싸서 전달해도 됨)
    sign_cert_b64: Optional[str] = None
    sign_pri_b64: Optional[str] = None
    sign_pw: Optional[str] = None
    # ID 로그인
    user_id: Optional[str] = None
    user_pw: Optional[str] = None


def _b64_to_bytes(s: Optional[str]) -> Optional[bytes]:
    if not s:
        return None
    # data URL(예: data:application/octet-stream;base64,....) 지원
    if "," in s and s.strip().startswith("data:"):
        s = s.split(",", 1)[1]
    try:
        return base64.b64decode(s)
    except Exception:
        # 이미 원문(PEM 등)일 수 있음
        return s.encode()


@router.post("/credentials")
async def hyphen_register_credential(
    body: RegisterCredBody,
    db: AsyncSession = Depends(get_db),
    user=Depends(get_current_user),
):
    """인증서/비밀번호를 암호화 보관(30일 TTL). CERT: sign_cert_b64+sign_pri_b64+sign_pw+acct_pw."""
    created_by = getattr(user, "email", None) if user else None
    try:
        cred = await creds_svc.register_credential(
            db,
            bank_cd=body.bank_cd,
            acct_no=body.acct_no,
            acct_pw=body.acct_pw,
            login_method=body.login_method,
            sign_cert_bytes=_b64_to_bytes(body.sign_cert_b64),
            sign_pri_bytes=_b64_to_bytes(body.sign_pri_b64),
            sign_pw=body.sign_pw,
            user_id=body.user_id,
            user_pw=body.user_pw,
            label=body.label,
            created_by=created_by,
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"인증정보 등록 실패: {e}")
    return creds_svc.to_public(cred)


@router.get("/credentials")
async def hyphen_list_credentials(db: AsyncSession = Depends(get_db)):
    return {"credentials": await creds_svc.list_credentials(db)}


@router.delete("/credentials/{cred_id}")
async def hyphen_delete_credential(cred_id: int, db: AsyncSession = Depends(get_db)):
    ok = await creds_svc.delete_credential(db, cred_id)
    if not ok:
        raise HTTPException(status_code=404, detail="인증정보 없음")
    return {"deleted": True}


class CredQueryBody(BaseModel):
    start_date: str
    end_date: str
    gubun: str = "01"
    sort: str = "OLD"
    filter_type: str = "all"
    gustation: bool = False  # True=테스트베드(무료·샘플)


@router.post("/credentials/{cred_id}/query")
async def hyphen_credential_query(
    cred_id: int,
    body: CredQueryBody,
    db: AsyncSession = Depends(get_db),
):
    """저장된 인증정보로 계좌 거래내역 조회 (복호화→하이픈 호출)."""
    cred = await creds_svc.get_credential(db, cred_id)
    if not cred:
        raise HTTPException(status_code=404, detail="인증정보 없음")
    try:
        return await creds_svc.run_account_transactions(
            db, cred,
            start_date=body.start_date, end_date=body.end_date,
            gubun=body.gubun, sort=body.sort, filter_type=body.filter_type,
            gustation=body.gustation,
        )
    except HyphenAPIError as e:
        raise _err(e)


# ============ 홈택스 세금계산서 ============

class TaxSyncBody(BaseModel):
    start_date: str
    end_date: str
    gustation: bool = False


@router.post("/tax/sync")
async def hyphen_tax_sync(body: TaxSyncBody, db: AsyncSession = Depends(get_db)):
    """세금계산서(매출·매입) 동기화 — 저장된 법인 인증서 재사용."""
    return await ext_svc.sync_tax_invoices(db, start_date=body.start_date, end_date=body.end_date, gustation=body.gustation)


@router.get("/tax/invoices")
async def hyphen_tax_invoices(start_date: str, end_date: str, sup_byr: Optional[str] = None, db: AsyncSession = Depends(get_db)):
    return await ext_svc.read_tax_invoices(db, start_date=start_date, end_date=end_date, sup_byr=sup_byr)


# ============ 법인카드 ============

class CardAccountBody(BaseModel):
    card_cd: str
    card_no: str
    label: Optional[str] = None
    login_method: str = "CERT"
    user_id: Optional[str] = None
    user_pw: Optional[str] = None


@router.get("/cards")
async def hyphen_list_cards(db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(_select(HyphenCardAccount).order_by(HyphenCardAccount.id))).scalars().all()
    return {"cards": [{
        "id": c.id, "card_cd": c.card_cd, "card_no": c.card_no, "label": c.label,
        "login_method": c.login_method,
        "last_synced_at": c.last_synced_at.isoformat() if c.last_synced_at else None,
        "last_status": c.last_status,
    } for c in rows]}


@router.post("/cards")
async def hyphen_register_card(body: CardAccountBody, db: AsyncSession = Depends(get_db), user=Depends(get_current_user)):
    existing = (await db.execute(_select(HyphenCardAccount).where(
        HyphenCardAccount.card_cd == body.card_cd, HyphenCardAccount.card_no == body.card_no,
    ).order_by(HyphenCardAccount.id))).scalars().first()
    c = existing or HyphenCardAccount(card_cd=body.card_cd, card_no=body.card_no)
    c.card_cd = body.card_cd
    c.card_no = body.card_no
    c.label = body.label
    c.login_method = body.login_method
    if body.user_id is not None:
        c.enc_user_id = data_encryption.encrypt(body.user_id) if body.user_id else None
    if body.user_pw is not None:
        c.enc_user_pw = data_encryption.encrypt(body.user_pw) if body.user_pw else None
    c.created_by = getattr(user, "email", None) if user else None
    if not existing:
        db.add(c)
    await db.commit()
    await db.refresh(c)
    return {"id": c.id}


@router.delete("/cards/{card_id}")
async def hyphen_delete_card(card_id: int, db: AsyncSession = Depends(get_db)):
    c = (await db.execute(_select(HyphenCardAccount).where(HyphenCardAccount.id == card_id))).scalar_one_or_none()
    if not c:
        raise HTTPException(status_code=404, detail="카드 연동 없음")
    await db.delete(c)
    await db.commit()
    return {"deleted": True}


@router.post("/cards/sync")
async def hyphen_cards_sync(body: TaxSyncBody, db: AsyncSession = Depends(get_db)):
    return await ext_svc.sync_cards(db, start_date=body.start_date, end_date=body.end_date, gustation=body.gustation)


@router.get("/card-tx")
async def hyphen_card_tx(start_date: str, end_date: str, db: AsyncSession = Depends(get_db)):
    return await ext_svc.read_card_tx(db, start_date=start_date, end_date=end_date)


# ============ 동기화 (하이픈 → 로컬 원장) ============

class SyncBody(BaseModel):
    start_date: str
    end_date: str
    gustation: bool = False


@router.post("/credentials/{cred_id}/sync")
async def hyphen_sync_credential(cred_id: int, body: SyncBody, db: AsyncSession = Depends(get_db)):
    """단일 계좌 동기화 (하이픈 조회 → 원장 저장)."""
    cred = await creds_svc.get_credential(db, cred_id)
    if not cred:
        raise HTTPException(status_code=404, detail="인증정보 없음")
    try:
        return await sync_svc.sync_credential(db, cred, start_date=body.start_date, end_date=body.end_date, gustation=body.gustation)
    except HyphenAPIError as e:
        raise _err(e)


@router.post("/sync-all")
async def hyphen_sync_all(body: SyncBody, db: AsyncSession = Depends(get_db)):
    """등록된 모든 계좌 동기화."""
    return await sync_svc.sync_all(db, start_date=body.start_date, end_date=body.end_date)


@public_router.post("/cron/sync")
async def hyphen_cron_sync(
    request: Request,
    days: int = 7,
    db: AsyncSession = Depends(get_db),
):
    """주기 자동 동기화 (Cloud Scheduler 호출). X-Cron-Secret 헤더로 게이트."""
    import os as _os
    secret = _os.getenv("HYPHEN_CRON_SECRET", "")
    given = request.headers.get("x-cron-secret", "")
    if not secret or given != secret:
        raise HTTPException(status_code=401, detail="unauthorized")
    from datetime import date as _date, timedelta as _td
    today = _date.today()
    start = (today - _td(days=max(1, days))).isoformat()
    end = today.isoformat()
    bank = await sync_svc.sync_all(db, start_date=start, end_date=end)
    # 세금계산서·카드도 동기화 (실패해도 은행 동기화는 유지)
    tax = card = None
    try:
        tax = await ext_svc.sync_tax_invoices(db, start_date=(today - _td(days=90)).isoformat(), end_date=end)
    except Exception as e:
        logger.warning("cron 세금계산서 동기화 실패: %s", e)
    try:
        card = await ext_svc.sync_cards(db, start_date=(today - _td(days=45)).isoformat(), end_date=end)
    except Exception as e:
        logger.warning("cron 카드 동기화 실패: %s", e)
    return {"bank": bank, "tax": tax, "card": card}


@router.get("/balance-series")
async def hyphen_balance_series(days: int = 30, db: AsyncSession = Depends(get_db)):
    """계좌별 일별 잔액 시계열 (대시보드 통장별 잔액용, 원장 기반 즉시)."""
    return await sync_svc.balance_series(db, days=max(1, min(days, 120)))


@router.get("/transactions")
async def hyphen_transactions(
    start_date: str,
    end_date: str,
    acct_no: Optional[str] = None,
    bank_cd: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
):
    """로컬 원장에서 거래 즉시 조회 (화면용)."""
    return await sync_svc.read_transactions(db, start_date=start_date, end_date=end_date, acct_no=acct_no, bank_cd=bank_cd)


# ============ 로컬 등록도구 (1회용 코드) ============

@router.post("/register-code")
async def hyphen_register_code(user=Depends(get_current_user)):
    """로컬 인증서 등록도구용 1회용 코드 발급 (관리자 세션). 10분 유효."""
    email = getattr(user, "email", None) if user else None
    exp = datetime.utcnow() + timedelta(seconds=_REG_CODE_TTL_SEC)
    code = jwt.encode(
        {"purpose": _REG_CODE_PURPOSE, "created_by": email, "exp": exp},
        settings.SECRET_KEY,
        algorithm=settings.ALGORITHM,
    )
    return {"code": code, "expires_in": _REG_CODE_TTL_SEC}


class RegisterByCodeBody(RegisterCredBody):
    code: str


@public_router.post("/credentials/by-code")
async def hyphen_register_by_code(body: RegisterByCodeBody, db: AsyncSession = Depends(get_db)):
    """로컬 등록도구가 1회용 코드로 인증서/비번을 암호화 등록 (SSO 불필요, 코드로 게이트)."""
    try:
        payload = jwt.decode(body.code, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
    except JWTError:
        raise HTTPException(status_code=401, detail="등록 코드가 유효하지 않거나 만료되었습니다.")
    if payload.get("purpose") != _REG_CODE_PURPOSE:
        raise HTTPException(status_code=401, detail="잘못된 등록 코드입니다.")
    created_by = payload.get("created_by")
    try:
        cred = await creds_svc.register_credential(
            db,
            bank_cd=body.bank_cd,
            acct_no=body.acct_no,
            acct_pw=body.acct_pw,
            login_method=body.login_method,
            sign_cert_bytes=_b64_to_bytes(body.sign_cert_b64),
            sign_pri_bytes=_b64_to_bytes(body.sign_pri_b64),
            sign_pw=body.sign_pw,
            user_id=body.user_id,
            user_pw=body.user_pw,
            label=body.label,
            created_by=created_by,
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"인증정보 등록 실패: {e}")
    return creds_svc.to_public(cred)
