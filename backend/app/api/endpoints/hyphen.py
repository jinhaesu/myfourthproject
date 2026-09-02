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


class CardDiscoverBody(BaseModel):
    card_cd: str
    login_method: str = "CERT"
    user_id: Optional[str] = None
    user_pw: Optional[str] = None
    gustation: bool = False


@router.post("/cards/discover")
async def hyphen_cards_discover(body: CardDiscoverBody, db: AsyncSession = Depends(get_db)):
    """카드사에서 보유 법인카드 목록 조회 (저장 안 함, 인증서 재사용)."""
    try:
        cards = await ext_svc.discover_cards(
            db, card_cd=body.card_cd, login_method=body.login_method,
            user_id=body.user_id, user_pw=body.user_pw, gustation=body.gustation,
        )
    except HyphenAPIError as e:
        raise _err(e)
    return {"cards": cards}


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
    import re as _re
    card_no = _re.sub(r"\D", "", body.card_no or "")
    existing = (await db.execute(_select(HyphenCardAccount).where(
        HyphenCardAccount.card_cd == body.card_cd, HyphenCardAccount.card_no == card_no,
    ).order_by(HyphenCardAccount.id))).scalars().first()
    c = existing or HyphenCardAccount(card_cd=body.card_cd, card_no=card_no)
    c.card_cd = body.card_cd
    c.card_no = card_no
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


@router.delete("/cards")
async def hyphen_delete_all_cards(card_cd: Optional[str] = None, db: AsyncSession = Depends(get_db)):
    """등록된 카드 일괄 삭제. card_cd 지정 시 해당 카드사만, 없으면 전체."""
    from sqlalchemy import delete as _delete
    stmt = _delete(HyphenCardAccount)
    if card_cd:
        stmt = stmt.where(HyphenCardAccount.card_cd == card_cd)
    res = await db.execute(stmt)
    await db.commit()
    return {"deleted": res.rowcount or 0}


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
    full: Optional[int] = None,
    db: AsyncSession = Depends(get_db),
):
    """주기 자동 동기화 (Cloud Scheduler 호출). X-Cron-Secret 헤더로 게이트.

    비용 절감: **은행은 매 실행**, **카드·세금계산서·잔액갱신은 하루 1회만**(KST 06~09시 실행 또는 ?full=1).
    카드 25장을 매 실행마다 재조회하면 비즈머니가 크게 소진되므로 하루 1회로 제한.
    """
    import os as _os
    from datetime import datetime as _dt, timedelta as _td, date as _date
    secret = _os.getenv("HYPHEN_CRON_SECRET", "")
    given = request.headers.get("x-cron-secret", "")
    if not secret or given != secret:
        raise HTTPException(status_code=401, detail="unauthorized")
    today = _date.today()
    start = (today - _td(days=max(1, days))).isoformat()
    end = today.isoformat()
    # 은행 — 매 실행(현금흐름 신선도, 비용 상대적으로 낮음: 계좌당 1콜)
    bank = await sync_svc.sync_all(db, start_date=start, end_date=end)

    # 무거운 동기화(카드·세금·잔액)는 하루 1회만 — KST 06~09시 실행 또는 강제(full=1)
    kst_hour = (_dt.utcnow() + _td(hours=9)).hour
    heavy = bool(full) or (6 <= kst_hour <= 9)
    tax = card = bal = None
    if heavy:
        try:
            tax = await ext_svc.sync_tax_invoices(db, start_date=(today - _td(days=14)).isoformat(), end_date=end)
        except Exception as e:
            logger.warning("cron 세금계산서 동기화 실패: %s", e)
        try:
            card = await ext_svc.sync_cards(db, start_date=(today - _td(days=14)).isoformat(), end_date=end)
        except Exception as e:
            logger.warning("cron 카드 동기화 실패: %s", e)
        try:
            bal = await ext_svc.refresh_account_balances(db)
        except Exception as e:
            logger.warning("cron 잔액 갱신 실패: %s", e)
    return {"bank": bank, "tax": tax, "card": card, "balances": bal, "heavy": heavy, "kst_hour": kst_hour}


@public_router.post("/cron/refresh-balances")
async def hyphen_refresh_balances(request: Request, db: AsyncSession = Depends(get_db)):
    """저장 인증정보로 전 계좌 잔액 갱신(은행별 1콜). X-Cron-Secret 게이트."""
    import os as _os
    if request.headers.get("x-cron-secret", "") != _os.getenv("HYPHEN_CRON_SECRET", "") or not _os.getenv("HYPHEN_CRON_SECRET", ""):
        raise HTTPException(status_code=401, detail="unauthorized")
    return await ext_svc.refresh_account_balances(db)


@public_router.get("/cron/accounts-diag")
async def hyphen_accounts_diag(request: Request, db: AsyncSession = Depends(get_db)):
    """진단: 원장 계정과목(Account) 현황 — 카테고리별 개수 + 비용(판관비) 계정 목록 +
    광고선전비 존재 여부. 카드분류 계정선택 점검용. X-Cron-Secret 게이트."""
    import os as _os
    secret = _os.getenv("HYPHEN_CRON_SECRET", "")
    if request.headers.get("x-cron-secret", "") != secret or not secret:
        raise HTTPException(status_code=401, detail="unauthorized")
    from app.models.accounting import Account, AccountCategory
    cats = {c.id: c for c in (await _select_all(db, AccountCategory))}
    accts = await _select_all(db, Account)
    by_cat: Dict[str, int] = {}
    expense, asset, other = [], [], []
    for a in accts:
        cat = cats.get(a.category_id)
        cname = cat.name if cat else f"cat{a.category_id}"
        by_cat[cname] = by_cat.get(cname, 0) + 1
        row = {"code": a.code, "name": a.name, "category": cname, "active": a.is_active}
        if cname == "비용":
            expense.append(row)
        elif cname == "자산":
            asset.append(row)
        else:
            other.append(row)
    for lst in (expense, asset, other):
        lst.sort(key=lambda x: x["code"])
    has_ad = any("광고" in a.name for a in accts)
    # 유형자산 관련(기계장치/비품/차량 등) 어디에 있는지 진단
    fixed_kw = ("기계", "비품", "차량", "건물", "토지", "시설", "장치", "공구", "기구", "구축")
    fixed = [{"code": a.code, "name": a.name, "category": (cats.get(a.category_id).name if cats.get(a.category_id) else "?"), "active": a.is_active}
             for a in accts if any(k in a.name for k in fixed_kw)]
    fixed.sort(key=lambda x: x["code"])
    return {"total": len(accts), "by_category": by_cat,
            "expense_count": len(expense), "asset_count": len(asset), "other_count": len(other),
            "has_ad_expense": has_ad,
            "categories": [{"id": c.id, "code": c.code, "name": c.name} for c in cats.values()],
            "asset_accounts": asset, "other_accounts": other,
            "fixed_asset_like": fixed, "expense_accounts": expense}


async def _select_all(db, model):
    from sqlalchemy import select as _sel
    return (await db.execute(_sel(model))).scalars().all()


@public_router.get("/cron/card-alias-diag")
async def hyphen_card_alias_diag(request: Request, db: AsyncSession = Depends(get_db)):
    """진단: 카드 별칭↔하이픈 카드 매칭 상태(읽기 전용). X-Cron-Secret 게이트."""
    import os as _os
    secret = _os.getenv("HYPHEN_CRON_SECRET", "")
    if request.headers.get("x-cron-secret", "") != secret or not secret:
        raise HTTPException(status_code=401, detail="unauthorized")
    return await ext_svc.diagnose_card_aliases(db)


@public_router.post("/cron/card-alias-rekey")
async def hyphen_card_alias_rekey(request: Request, db: AsyncSession = Depends(get_db)):
    """카드 별칭·배정·분류·월마감 키를 하이픈 카드키로 이관(멱등). X-Cron-Secret 게이트.
    실행 후 이관 건수 + 잔여 미매칭 진단을 함께 반환."""
    import os as _os
    secret = _os.getenv("HYPHEN_CRON_SECRET", "")
    if request.headers.get("x-cron-secret", "") != secret or not secret:
        raise HTTPException(status_code=401, detail="unauthorized")
    moved = await ext_svc.rekey_card_aliases_by_last4(db)
    diag = await ext_svc.diagnose_card_aliases(db)
    return {"moved": moved, "after": {
        "already_hyphen": diag["already_hyphen"], "will_move": diag["will_move"],
        "unmatched": diag["unmatched"],
        "unmatched_aliases": [r for r in diag["aliases"] if r["status"] == "UNMATCHED"],
    }}


@public_router.get("/cron/card-tx-diag")
async def hyphen_card_tx_diag(request: Request, last4: str, start_date: str, end_date: str,
                              db: AsyncSession = Depends(get_db)):
    """진단: 특정 뒷4 카드의 원장거래(HyphenCardTx) + 파생 카드키를 그대로 반환.
    직원 화면 미표시 원인(키 불일치 vs 날짜)을 데이터로 확정. X-Cron-Secret 게이트."""
    import os as _os
    secret = _os.getenv("HYPHEN_CRON_SECRET", "")
    if request.headers.get("x-cron-secret", "") != secret or not secret:
        raise HTTPException(status_code=401, detail="unauthorized")
    from app.models.hyphen_ext import HyphenCardTx, HyphenCardAccount as _HCA
    import re as _re
    l4 = _re.sub(r"\D", "", last4)[-4:]
    sd = start_date.replace("-", ""); ed = end_date.replace("-", "")
    # 등록 계정 중 해당 뒷4
    accts = (await db.execute(_select(_HCA))).scalars().all()
    acct_rows = [{
        "card_cd": a.card_cd, "card_no_last4": _re.sub(r"\D", "", a.card_no or "")[-4:],
        "key": ext_svc._card_key(a.card_cd, a.card_no), "label": a.label,
    } for a in accts if _re.sub(r"\D", "", a.card_no or "")[-4:] == l4]
    # 원장거래 중 뒷4 일치(거래 card_no=useCard 기준) 또는 파생키 뒷4 일치
    rows = (await db.execute(_select(HyphenCardTx))).scalars().all()
    tx = []
    for t in rows:
        tno4 = _re.sub(r"\D", "", t.card_no or "")[-4:]
        key = ext_svc._card_key(t.card_cd, t.card_no)
        if tno4 != l4 and key[-4:] != l4:
            continue
        d = (t.use_dt or "").replace("-", "")
        in_range = bool(d) and sd <= d <= ed
        tx.append({"use_dt": t.use_dt, "use_store": t.use_store, "use_amt": float(t.use_amt or 0),
                   "card_cd": t.card_cd, "tx_card_no_last4": tno4, "derived_key": key, "in_range": in_range})
    tx.sort(key=lambda x: x["use_dt"] or "")
    return {"last4": l4, "accounts": acct_rows,
            "tx_total": len(tx), "tx_in_range": sum(1 for x in tx if x["in_range"]),
            "distinct_keys": sorted({x["derived_key"] for x in tx}),
            "tx": tx[-60:]}


@public_router.get("/cron/card-recover-scan")
async def hyphen_card_recover_scan(request: Request, db: AsyncSession = Depends(get_db)):
    """복구 스캔: 원장거래(HyphenCardTx)에 저장된 카드번호가 전체자리인지 마스킹인지 판별.
    삭제된 카드 계정을 거래에서 재구성할 수 있는지 확인용. 번호는 마스킹 반환. X-Cron-Secret."""
    import os as _os, re as _re
    secret = _os.getenv("HYPHEN_CRON_SECRET", "")
    if request.headers.get("x-cron-secret", "") != secret or not secret:
        raise HTTPException(status_code=401, detail="unauthorized")
    from app.models.hyphen_ext import HyphenCardTx, HyphenCardAccount as _HCA
    rows = (await db.execute(_select(HyphenCardTx))).scalars().all()
    # (card_cd, 정규화 카드번호) 단위 집계
    byno: Dict[tuple, Dict[str, Any]] = {}
    for t in rows:
        raw = t.card_no or ""
        digits = _re.sub(r"\D", "", raw)
        has_mask = ("*" in raw) or ("x" in raw.lower())
        k = (t.card_cd, digits)
        e = byno.setdefault(k, {"card_cd": t.card_cd, "digits_len": len(digits),
                                "last4": digits[-4:], "has_mask_char": has_mask, "count": 0,
                                "sample_masked": (digits[:6] + "*" * max(0, len(digits) - 10) + digits[-4:]) if len(digits) >= 10 else "*" * len(digits)})
        e["count"] += 1
    accts = (await db.execute(_select(_HCA))).scalars().all()
    cur = [{"card_cd": a.card_cd, "last4": _re.sub(r"\D", "", a.card_no or "")[-4:],
            "digits_len": len(_re.sub(r"\D", "", a.card_no or ""))} for a in accts]
    vals = list(byno.values())
    # 전체자리(15~16)로 판정되는 것만 복구 후보
    recoverable = [v for v in vals if v["digits_len"] in (15, 16) and not v["has_mask_char"]]
    return {"ledger_distinct_cards": len(vals),
            "full_number_cards": len(recoverable),
            "masked_cards": len([v for v in vals if v not in recoverable]),
            "currently_registered": len(cur), "registered": cur,
            "ledger_cards": sorted(vals, key=lambda x: (x["card_cd"], x["last4"]))}


@public_router.get("/cron/debug-accounts")
async def hyphen_debug_accounts(request: Request, db: AsyncSession = Depends(get_db)):
    """진단: 등록된 하이픈 은행 credential + merge된 BANK_ACCOUNT 목록 요약. X-Cron-Secret 게이트."""
    import os as _os
    secret = _os.getenv("HYPHEN_CRON_SECRET", "")
    if request.headers.get("x-cron-secret", "") != secret or not secret:
        raise HTTPException(status_code=401, detail="unauthorized")
    creds = await ext_svc._hyphen_bank_creds(db)
    cred_rows = [{
        "bank_cd": c.bank_cd, "bank_nm": ext_svc._bank_nm(c.bank_cd),
        "acct_no": c.acct_no, "last4": (c.acct_no or "")[-4:], "label": c.label,
        "last_balance": float(c.last_balance) if c.last_balance is not None else None,
        "last_synced_at": c.last_synced_at.isoformat() if c.last_synced_at else None,
        "expired": c.is_expired,
    } for c in creds]
    # 그랜터 원본 + merge 결과 은행목록
    granter_bank = []
    try:
        g = await get_granter_client().list_all_assets(only_active=False)
        for a in (g.get("BANK_ACCOUNT") or []):
            ba = a.get("bankAccount") or {}
            granter_bank.append({"id": a.get("id"), "name": a.get("name"),
                                 "acct": ba.get("accountNumber") or a.get("number"),
                                 "bal": ba.get("accountBalance"),
                                 "active": a.get("isActive"), "hidden": a.get("isHidden"), "dormant": a.get("isDormant")})
    except Exception as e:
        granter_bank = [{"error": str(e)[:200]}]
    merged = await ext_svc.merge_assets_all(db, {"BANK_ACCOUNT": []})
    merged_bank = [{"id": a.get("id"), "name": a.get("name"), "acct": (a.get("bankAccount") or {}).get("accountNumber"),
                    "bal": (a.get("bankAccount") or {}).get("accountBalance"), "src": a.get("_source", "granter")}
                   for a in merged.get("BANK_ACCOUNT", [])]
    return {"credentials_count": len(cred_rows), "credentials": cred_rows,
            "granter_bank_count": len(granter_bank), "granter_bank": granter_bank,
            "merged_hyphen_only_count": len(merged_bank), "merged_hyphen_only": merged_bank}


@public_router.post("/cron/card-debug")
async def hyphen_card_debug(
    request: Request,
    days: int = 30,
    db: AsyncSession = Depends(get_db),
):
    """하이픈 지원팀 제출용: 실패하는 카드 승인내역 호출의 요청/응답 원본(마스킹) 캡처.
    X-Cron-Secret 헤더 게이트. 개인정보·인증서·키는 마스킹, 원본 응답 body는 그대로."""
    import os as _os
    secret = _os.getenv("HYPHEN_CRON_SECRET", "")
    given = request.headers.get("x-cron-secret", "")
    if not secret or given != secret:
        raise HTTPException(status_code=401, detail="unauthorized")
    from datetime import date as _date, timedelta as _td
    today = _date.today()
    start = (today - _td(days=max(1, days))).isoformat()
    end = today.isoformat()

    cert = await ext_svc.get_company_cert(db)
    client = get_hyphen_client()
    accts = (await db.execute(_select(HyphenCardAccount))).scalars().all()
    if not accts:
        return {"error": "등록된 카드가 없습니다."}
    # 카드사별 대표 1장만 캡처(비용 절감 — 지원팀엔 한 사례면 충분)
    by_cd: Dict[str, Any] = {}
    for a in accts:
        by_cd.setdefault(a.card_cd, a)
    out = []
    for card_cd, rep in by_cd.items():
        sign = cert if (rep.login_method == "CERT" and cert) else (None, None, None)
        cap = await client.card_transactions_debug(
            card_cd=card_cd, card_no=rep.card_no, biz_no=ext_svc.COMPANY_BIZ_NO,
            start_date=start, end_date=end,
            sign_cert=sign[0], sign_pri=sign[1], sign_pw=sign[2],
            user_id=creds_svc._dec(rep.enc_user_id),
            user_pw=creds_svc._dec(rep.enc_user_pw),
            login_method=rep.login_method, gustation=False,
        )
        out.append({"card_cd": card_cd, "login_method": rep.login_method, **cap})
    return {"period": {"sdate": start, "edate": end}, "cases": out}


class BulkCardItem(BaseModel):
    card_cd: str
    card_no: str
    label: Optional[str] = None
    login_method: str = "CERT"


class BulkCardBody(BaseModel):
    cards: List[BulkCardItem]
    replace: bool = True  # 같은 카드사 기존분 삭제 후 삽입


@public_router.post("/cron/cards-bulk-register")
async def hyphen_cards_bulk_register(request: Request, body: BulkCardBody, db: AsyncSession = Depends(get_db)):
    """관리자 대행 일괄등록(카드번호 16자리). X-Cron-Secret 게이트.
    replace=True면 payload에 등장한 카드사코드의 기존분을 지우고 새로 넣음(12자리 잔재 제거)."""
    import os as _os
    import re as _re
    from sqlalchemy import delete as _delete
    secret = _os.getenv("HYPHEN_CRON_SECRET", "")
    if not secret or request.headers.get("x-cron-secret", "") != secret:
        raise HTTPException(status_code=401, detail="unauthorized")

    items = []
    skipped = []
    for it in body.cards:
        no = _re.sub(r"\D", "", it.card_no or "")
        # 15~16자리 허용 (일반 법인카드 16자리, 고위드 BC카드 15자리)
        if len(no) not in (15, 16):
            skipped.append({"card_no": it.card_no, "reason": f"digits={len(no)}"})
            continue
        items.append((it.card_cd, no, it.label, it.login_method))

    if body.replace and items:
        for cd in sorted({c for c, _, _, _ in items}):
            await db.execute(_delete(HyphenCardAccount).where(HyphenCardAccount.card_cd == cd))

    inserted = 0
    for card_cd, no, label, lm in items:
        existing = (await db.execute(_select(HyphenCardAccount).where(
            HyphenCardAccount.card_cd == card_cd, HyphenCardAccount.card_no == no,
        ))).scalars().first()
        c = existing or HyphenCardAccount(card_cd=card_cd, card_no=no)
        c.card_cd = card_cd
        c.card_no = no
        c.label = label
        c.login_method = lm
        if not existing:
            db.add(c)
            inserted += 1
    await db.commit()
    total = (await db.execute(_select(HyphenCardAccount))).scalars().all()
    by_cd: Dict[str, int] = {}
    for t in total:
        by_cd[t.card_cd] = by_cd.get(t.card_cd, 0) + 1
    return {
        "received": len(body.cards), "valid_16": len(items),
        "inserted": inserted, "skipped": skipped,
        "total_now": len(total), "by_cd": by_cd,
    }


@public_router.post("/cron/cards-sync")
async def hyphen_cron_cards_sync(
    request: Request,
    start_date: str,
    end_date: str,
    db: AsyncSession = Depends(get_db),
):
    """카드 백필/동기화 (기간지정). X-Cron-Secret 게이트. 등록된 25장 전체를 기간으로 조회→원장 적재."""
    import os as _os
    secret = _os.getenv("HYPHEN_CRON_SECRET", "")
    if not secret or request.headers.get("x-cron-secret", "") != secret:
        raise HTTPException(status_code=401, detail="unauthorized")
    return await ext_svc.sync_cards(db, start_date=start_date, end_date=end_date)


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
