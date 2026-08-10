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
import logging
from typing import Optional, Dict, Any, List

from fastapi import APIRouter, Body, HTTPException
from pydantic import BaseModel

from app.services.hyphen_client import get_hyphen_client, HyphenAPIError
from app.services.granter_client import get_granter_client, GranterAPIError

logger = logging.getLogger(__name__)
router = APIRouter()


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
