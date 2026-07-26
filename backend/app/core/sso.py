"""
Smart Finance Core - SSO Hub Token Verification
중앙 SSO 허브(auth.nuldam.com)가 발급한 app 토큰 검증 전용 모듈.

- 허브는 Google Workspace 로그인 후 RS256으로 서명된 JWT("app token")를 발급하고,
  프론트엔드는 이를 account 백엔드의 POST /api/v1/auth/sso 로 전달합니다.
- 이 모듈은 허브 JWKS(공개키 집합)를 인메모리에 캐싱하고, 토큰의 서명 / 발급자(iss) /
  대상(aud) / 만료(exp)를 검증합니다.
- account 자체 세션 토큰(HS256, settings.SECRET_KEY)과는 완전히 별개입니다 — 이 모듈은
  "허브 토큰을 신뢰할지" 여부만 판단하고, account 자체 토큰 발급은 app.core.security를
  그대로 재사용합니다 (auth.py의 /sso 엔드포인트 참고).
- 모듈 임포트 시점에는 네트워크 호출을 하지 않습니다 (기동 차단 방지). JWKS는 최초 검증
  요청 시 지연 조회(lazy fetch) 후 캐싱됩니다.
"""
import time
import asyncio
import logging
from typing import Optional

import httpx
from jose import jwt as jose_jwt
from jose.exceptions import JWTError, ExpiredSignatureError, JWTClaimsError

from fastapi import HTTPException, status

from app.core.config import settings

logger = logging.getLogger(__name__)

# 모듈 레벨 캐시 — 프로세스 생존 기간 동안 유지, TTL 경과 시 재조회
_jwks_cache: dict = {"keys": [], "fetched_at": 0.0}
_jwks_lock = asyncio.Lock()


async def _fetch_jwks() -> list:
    """허브 JWKS 엔드포인트에서 공개키 목록을 조회합니다."""
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(settings.SSO_HUB_JWKS_URL)
        resp.raise_for_status()
        data = resp.json()
    return data.get("keys", [])


async def _get_jwks(force_refresh: bool = False) -> list:
    """캐시된 JWKS를 반환. TTL 만료 또는 강제 새로고침 시 재조회."""
    now = time.time()
    ttl = settings.SSO_JWKS_CACHE_TTL_SECONDS

    if not force_refresh and _jwks_cache["keys"] and (now - _jwks_cache["fetched_at"]) < ttl:
        return _jwks_cache["keys"]

    async with _jwks_lock:
        # 락 대기 중 다른 요청이 이미 갱신했을 수 있으므로 재확인
        now = time.time()
        if not force_refresh and _jwks_cache["keys"] and (now - _jwks_cache["fetched_at"]) < ttl:
            return _jwks_cache["keys"]

        try:
            keys = await _fetch_jwks()
            _jwks_cache["keys"] = keys
            _jwks_cache["fetched_at"] = now
        except Exception as e:
            logger.error(f"SSO hub JWKS 조회 실패: {e}")
            if _jwks_cache["keys"]:
                # 허브 일시 장애 시 만료된 캐시라도 폴백 사용
                return _jwks_cache["keys"]
            raise

        return _jwks_cache["keys"]


async def _get_signing_key(kid: Optional[str]) -> dict:
    """kid에 해당하는 JWK를 반환. 캐시에 없으면 1회 강제 재조회(키 로테이션 대응)."""
    keys = await _get_jwks()
    for key in keys:
        if key.get("kid") == kid:
            return key

    keys = await _get_jwks(force_refresh=True)
    for key in keys:
        if key.get("kid") == kid:
            return key

    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="유효하지 않은 SSO 토큰입니다 (알 수 없는 서명 키).",
    )


async def verify_hub_token(token: str) -> dict:
    """
    SSO 허브가 발급한 app 토큰을 검증하고 payload(claims)를 반환합니다.

    검증 항목: RS256 서명, iss == settings.SSO_HUB_ISSUER, aud == settings.SSO_AUDIENCE, exp.
    실패 시 HTTPException(401)을 발생시킵니다.
    """
    try:
        unverified_header = jose_jwt.get_unverified_header(token)
    except JWTError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="유효하지 않은 SSO 토큰 형식입니다.",
        )

    kid = unverified_header.get("kid")
    signing_key = await _get_signing_key(kid)

    try:
        payload = jose_jwt.decode(
            token,
            signing_key,
            algorithms=["RS256"],
            audience=settings.SSO_AUDIENCE,
            issuer=settings.SSO_HUB_ISSUER,
        )
    except ExpiredSignatureError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="만료된 SSO 토큰입니다. 다시 로그인해주세요.",
        )
    except JWTClaimsError as e:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"유효하지 않은 SSO 토큰입니다: {str(e)}",
        )
    except JWTError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="유효하지 않은 SSO 토큰입니다.",
        )

    if payload.get("typ") != "app":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="유효하지 않은 SSO 토큰 타입입니다.",
        )

    return payload
