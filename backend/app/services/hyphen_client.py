"""
HYPHEN (하이픈, hyphen.im) API Client — 그랜터 대체 후보 (계좌 속도 PoC용 1차)

Base URL: https://api.hyphen.im
인증: OAuth2 — POST /oauth/token  body={user_id, hkey} → access_token (유효 7일, 캐싱)
      이후 모든 호출 헤더: Authorization: Bearer <access_token>

암호화(ekey): 개발가이드에서 변수에 [암호화] 표시된 필드(은행/홈택스 로그인 ID·PW,
      계좌번호·비밀번호 등 개인정보)는 아래 규격으로 암호화 후 Base64 인코딩해 전송.
        - Algorithm: AES-128 / CBC / PKCS7(=PKCS5) padding
        - Key: ekey (가입 시 발급, 16바이트 문자열)
        - IV : user_id 를 16바이트로 zero-padding/truncate
        - Output: Base64 문자열

시크릿은 환경변수에서만 로드 — 코드/리포지토리 하드코딩 금지:
        HYPHEN_USER_ID, HYPHEN_HKEY, HYPHEN_EKEY
선택: HYPHEN_BASE_URL(기본 https://api.hyphen.im), HYPHEN_TIMEOUT

주의: 하이픈 데이터 API의 정확한 path/파라미터명은 상품별 로그인 개발가이드 기준.
      이 클라이언트는 범용 call(path, payload, encrypt_fields)을 제공하고,
      계좌 거래내역 등 구체 메서드는 env로 path override 가능하게 열어둠(발견 즉시 확정).
"""
import os
import time
import base64
import logging
import subprocess
import tempfile
from typing import Optional, Dict, Any, Iterable

import httpx
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.padding import PKCS7

logger = logging.getLogger(__name__)


class HyphenAPIError(Exception):
    def __init__(self, message: str, status_code: Optional[int] = None, body: Any = None):
        super().__init__(message)
        self.status_code = status_code
        self.body = body


def _to_16(raw: bytes) -> bytes:
    """16바이트로 맞춤 — 짧으면 0x00 패딩, 길면 절단 (IV/Key 공용)."""
    if len(raw) >= 16:
        return raw[:16]
    return raw + b"\x00" * (16 - len(raw))


def _pem_body(s: Optional[str]) -> Optional[str]:
    """하이픈 signCert/signPri 입력형식 — PEM 헤더/푸터와 모든 공백·개행 제거한 순수 base64."""
    if not s:
        return s
    import re
    s2 = re.sub(r"-----BEGIN [^-]+-----", "", s)
    s2 = re.sub(r"-----END [^-]+-----", "", s2)
    return "".join(s2.split())


def _decrypt_sign_key(sign_pri: str, password: str) -> Optional[str]:
    """한국 공동인증서 개인키(PBES2+PBKDF2+SEED-CBC)를 openssl legacy provider로 복호화.
    성공 시 복호화된 PKCS8 DER의 headerless base64 반환, 실패 시 None.
    (cryptography는 SEED 미지원 → openssl 서브프로세스 사용)
    """
    if not sign_pri or not password:
        return None
    try:
        der = base64.b64decode(_pem_body(sign_pri))
    except Exception:
        return None
    path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".key", delete=False) as tf:
            tf.write(der)
            path = tf.name
        env = dict(os.environ, SIGNKEYPW=password)
        proc = subprocess.run(
            [
                "openssl", "pkcs8", "-inform", "DER", "-in", path,
                "-passin", "env:SIGNKEYPW",
                "-outform", "DER", "-nocrypt",
                "-provider", "legacy", "-provider", "default",
            ],
            capture_output=True, timeout=20, env=env,
        )
        if proc.returncode != 0 or not proc.stdout:
            logger.warning("signPri 복호화 실패: %s", (proc.stderr or b"")[:200])
            return None
        return base64.b64encode(proc.stdout).decode()
    except Exception as e:
        logger.warning("signPri 복호화 예외: %s", e)
        return None
    finally:
        if path:
            try:
                os.unlink(path)
            except Exception:
                pass


class HyphenClient:
    """하이픈 비동기 클라이언트 (OAuth 캐싱 + ekey AES 암호화)."""

    DEFAULT_BASE_URL = "https://api.hyphen.im"
    DEFAULT_TIMEOUT = 60.0
    TOKEN_PATH = "/oauth/token"
    # 토큰 만료 5분 전이면 갱신
    _TOKEN_REFRESH_MARGIN = 300

    def __init__(self):
        self.user_id = os.getenv("HYPHEN_USER_ID", "").strip()
        self.hkey = os.getenv("HYPHEN_HKEY", "").strip()
        self.ekey = os.getenv("HYPHEN_EKEY", "").strip()
        self.base_url = os.getenv("HYPHEN_BASE_URL", self.DEFAULT_BASE_URL).rstrip("/")
        self.timeout = float(os.getenv("HYPHEN_TIMEOUT", str(self.DEFAULT_TIMEOUT)))
        self._client: Optional[httpx.AsyncClient] = None
        # 토큰 캐시 (프로세스 전역)
        self._access_token: Optional[str] = None
        self._token_expire_at: float = 0.0

    @property
    def is_configured(self) -> bool:
        return bool(self.user_id and self.hkey)

    @property
    def can_encrypt(self) -> bool:
        return bool(self.ekey and self.user_id)

    def _get_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                base_url=self.base_url,
                headers={
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                    "User-Agent": "smart-finance-core/1.0",
                },
                timeout=self.timeout,
            )
        return self._client

    async def aclose(self):
        if self._client and not self._client.is_closed:
            await self._client.aclose()

    # ============ ekey 암호화 ============

    def encrypt(self, plaintext: str) -> str:
        """[암호화] 필드용 — AES-128/CBC/PKCS7 후 Base64.
        Key=ekey(16B), IV=user_id(16B zero-pad).
        """
        if not self.can_encrypt:
            raise HyphenAPIError("HYPHEN_EKEY / HYPHEN_USER_ID 미설정 — 암호화 불가", status_code=500)
        key = _to_16(self.ekey.encode("utf-8"))
        iv = _to_16(self.user_id.encode("utf-8"))
        padder = PKCS7(128).padder()
        padded = padder.update(plaintext.encode("utf-8")) + padder.finalize()
        cipher = Cipher(algorithms.AES(key), modes.CBC(iv))
        enc = cipher.encryptor()
        ct = enc.update(padded) + enc.finalize()
        return base64.b64encode(ct).decode("ascii")

    def encrypt_fields(self, payload: Dict[str, Any], fields: Iterable[str]) -> Dict[str, Any]:
        """payload 사본에서 지정 필드만 암호화해 반환 (원본 불변)."""
        out = dict(payload)
        for f in fields:
            if f in out and out[f] is not None and out[f] != "":
                out[f] = self.encrypt(str(out[f]))
        return out

    # ============ OAuth 토큰 ============

    async def _ensure_token(self, force: bool = False) -> str:
        now = time.time()
        if (
            not force
            and self._access_token
            and now < (self._token_expire_at - self._TOKEN_REFRESH_MARGIN)
        ):
            return self._access_token
        if not self.is_configured:
            raise HyphenAPIError("HYPHEN_USER_ID / HYPHEN_HKEY 미설정", status_code=500)
        client = self._get_client()
        try:
            resp = await client.post(
                self.TOKEN_PATH,
                json={"user_id": self.user_id, "hkey": self.hkey},
            )
        except httpx.HTTPError as e:
            raise HyphenAPIError(f"하이픈 토큰 통신 오류: {e}", status_code=502) from e
        if resp.status_code >= 400:
            try:
                body = resp.json()
            except Exception:
                body = resp.text
            raise HyphenAPIError(
                f"하이픈 토큰 발급 실패 {resp.status_code}: {body}",
                status_code=resp.status_code,
                body=body,
            )
        data = resp.json()
        token = data.get("access_token")
        if not token:
            raise HyphenAPIError("하이픈 토큰 응답에 access_token 없음", status_code=502, body=data)
        expires_in = float(data.get("expires_in") or 0)
        self._access_token = token
        # expires_in 미제공 시 보수적으로 6일
        self._token_expire_at = now + (expires_in if expires_in > 0 else 6 * 86400)
        logger.info("HYPHEN 토큰 발급/갱신 (expires_in=%s)", expires_in)
        return token

    async def token_info(self) -> Dict[str, Any]:
        """진단용 — 토큰 발급을 강제 시도하고 만료시각/앞자리 반환."""
        tok = await self._ensure_token(force=True)
        return {
            "ok": True,
            "token_prefix": tok[:8] + "...",
            "expire_at": self._token_expire_at,
            "expire_in_sec": int(self._token_expire_at - time.time()),
        }

    # ============ 범용 호출 ============

    async def call(
        self,
        path: str,
        payload: Optional[Dict[str, Any]] = None,
        encrypt_fields: Optional[Iterable[str]] = None,
        method: str = "POST",
        extra_headers: Optional[Dict[str, str]] = None,
        _retry: int = 0,
    ) -> Any:
        """하이픈 데이터 API 범용 호출.
        - 토큰 자동 발급/갱신, Bearer 헤더 부착
        - encrypt_fields 지정 시 해당 필드 ekey 암호화
        - 401 수신 시 토큰 강제 재발급 후 1회 재시도
        """
        token = await self._ensure_token()
        body = dict(payload or {})
        if encrypt_fields:
            body = self.encrypt_fields(body, encrypt_fields)
        headers = {"Authorization": f"Bearer {token}"}
        # 일부 하이픈 API는 user-id 헤더를 요구 — 있으면 무해, 없으면 무시됨
        if self.user_id:
            headers["user-id"] = self.user_id
        if extra_headers:
            headers.update(extra_headers)

        client = self._get_client()
        try:
            resp = await client.request(method, path, json=body, headers=headers)
        except httpx.TimeoutException as e:
            raise HyphenAPIError(f"하이픈 타임아웃: {path}", status_code=504) from e
        except httpx.HTTPError as e:
            raise HyphenAPIError(f"하이픈 통신 오류: {e}", status_code=502) from e

        if resp.status_code == 401 and _retry < 1:
            # 토큰 만료/무효 — 강제 재발급 후 1회 재시도
            await self._ensure_token(force=True)
            return await self.call(path, payload, encrypt_fields, method, extra_headers, _retry + 1)

        if resp.status_code >= 400:
            try:
                rbody = resp.json()
            except Exception:
                rbody = resp.text
            raise HyphenAPIError(
                f"하이픈 API {resp.status_code}: {rbody}",
                status_code=resp.status_code,
                body=rbody,
            )
        if resp.status_code == 204 or not resp.content:
            return None
        try:
            return resp.json()
        except Exception:
            return resp.text

    def _apply_cert(self, payload: Dict[str, Any], sign_cert, sign_pri, sign_pw):
        """CERT 로그인 공통 — signCert(헤더제거 base64), signPri(개인키 복호화 후), signPw."""
        if sign_cert is not None:
            payload["signCert"] = _pem_body(sign_cert)
        if sign_pri is not None:
            dec = _decrypt_sign_key(sign_pri, sign_pw) if sign_pw else None
            payload["signPri"] = dec or _pem_body(sign_pri)
        if sign_pw is not None:
            payload["signPw"] = sign_pw

    # ============ 홈택스 세금계산서/현금영수증 (/in0076xxx) ============

    async def tax_invoices(
        self, *, biz_no: str, sup_byr: str, start_date: str, end_date: str,
        sign_cert=None, sign_pri=None, sign_pw=None,
        user_id=None, user_pw=None, login_method: str = "CERT",
        gustation: bool = False,
    ) -> Any:
        """전자세금계산서 발행내역. sup_byr: '01'매출(/in0076000266), '02'매입(/in0076000267)."""
        path = "/in0076000266" if sup_byr == "01" else "/in0076000267"
        payload: Dict[str, Any] = {
            "loginMethod": login_method, "cnvrHstrClsfCd": "04", "bizNo": biz_no,
            "dateGb": "03", "dtCd": "01",
            "inqrDtStrt": start_date.replace("-", ""), "inqrDtEnd": end_date.replace("-", ""),
            "isnType": "00", "bmanCd": "00", "itemOption": "N",
        }
        if login_method.upper() == "CERT":
            self._apply_cert(payload, sign_cert, sign_pri, sign_pw)
        else:
            if user_id is not None:
                payload["userId"] = user_id
            if user_pw is not None:
                payload["userPw"] = user_pw
        return await self.call_bank(path, payload, gustation=gustation)

    async def cash_receipts(
        self, *, biz_no: str, sup_byr: str, start_date: str, end_date: str,
        sign_cert=None, sign_pri=None, sign_pw=None,
        user_id=None, user_pw=None, login_method: str = "CERT",
        gustation: bool = False,
    ) -> Any:
        """현금영수증. sup_byr: '01'매출(/in0076000274), '02'매입(/in0076000275)."""
        path = "/in0076000274" if sup_byr == "01" else "/in0076000275"
        payload: Dict[str, Any] = {
            "loginMethod": login_method, "bizNo": biz_no,
            "inqrDtStrt": start_date.replace("-", ""), "inqrDtEnd": end_date.replace("-", ""),
            "detailYn": "N",
        }
        if login_method.upper() == "CERT":
            self._apply_cert(payload, sign_cert, sign_pri, sign_pw)
        else:
            if user_id is not None:
                payload["userId"] = user_id
            if user_pw is not None:
                payload["userPw"] = user_pw
        return await self.call_bank(path, payload, gustation=gustation)

    # ============ 법인카드 (/in0007xxx) ============

    async def card_list(
        self, *, card_cd: str, biz_no: str,
        sign_cert=None, sign_pri=None, sign_pw=None,
        user_id=None, user_pw=None, login_method: str = "CERT",
        gustation: bool = False,
    ) -> Any:
        """법인 보유카드 조회 (/in0007000556)."""
        payload: Dict[str, Any] = {
            "cardCd": card_cd, "loginMethod": login_method, "bizNo": biz_no,
            "onlyActiveCard": "Y", "cardNoConfirm": "N", "imgB64Yn": "N",
        }
        if login_method.upper() == "CERT":
            self._apply_cert(payload, sign_cert, sign_pri, sign_pw)
        else:
            if user_id is not None:
                payload["userId"] = user_id
            if user_pw is not None:
                payload["userPw"] = user_pw
        return await self.call_bank(payload=payload, path="/in0007000556", gustation=gustation)

    async def card_transactions(
        self, *, card_cd: str, card_no: str, biz_no: str, start_date: str, end_date: str,
        sign_cert=None, sign_pri=None, sign_pw=None,
        user_id=None, user_pw=None, login_method: str = "CERT",
        gustation: bool = False, path: Optional[str] = None,
    ) -> Any:
        """법인카드 승인내역조회 (/in0007000559 기본 — 매입 561은 권한없는 경우 많음)."""
        p = path or os.getenv("HYPHEN_CARD_TX_PATH", "/in0007000559")
        payload: Dict[str, Any] = {
            "cardCd": card_cd, "loginMethod": login_method, "cardNo": card_no, "bizNo": biz_no,
            "sdate": start_date.replace("-", ""), "edate": end_date.replace("-", ""),
            "useArea": "N", "cardNoFilter": "Y",
        }
        if login_method.upper() == "CERT":
            self._apply_cert(payload, sign_cert, sign_pri, sign_pw)
        else:
            if user_id is not None:
                payload["userId"] = user_id
            if user_pw is not None:
                payload["userPw"] = user_pw
        return await self.call_bank(payload=payload, path=p, gustation=gustation)

    # ============ 은행 API (Hkey 헤더 인증) ============
    # 은행 상품(/in0087xxx)은 OAuth Bearer가 아니라 user-id + Hkey 헤더로 인증.
    # 테스트베드는 hyphen-gustation:Y (실사용 시 제거 — 실데이터/실속도 반영).

    def _bank_headers(self, gustation: bool = False, user_tr_no: Optional[str] = None) -> Dict[str, str]:
        h = {"user-id": self.user_id, "Hkey": self.hkey}
        if gustation:
            h["hyphen-gustation"] = "Y"
        if user_tr_no:
            h["user-tr-no"] = user_tr_no
        return h

    async def call_bank(
        self,
        path: str,
        payload: Dict[str, Any],
        gustation: bool = False,
        user_tr_no: Optional[str] = None,
    ) -> Any:
        """은행 API 호출 (Hkey 헤더 인증). payload는 이미 암호화 처리된 상태로 전달."""
        if not self.is_configured:
            raise HyphenAPIError("HYPHEN_USER_ID / HYPHEN_HKEY 미설정", status_code=500)
        client = self._get_client()
        headers = self._bank_headers(gustation, user_tr_no)
        try:
            resp = await client.post(path, json=payload, headers=headers)
        except httpx.TimeoutException as e:
            raise HyphenAPIError(f"하이픈 타임아웃: {path}", status_code=504) from e
        except httpx.HTTPError as e:
            raise HyphenAPIError(f"하이픈 통신 오류: {e}", status_code=502) from e
        if resp.status_code >= 400:
            try:
                rbody = resp.json()
            except Exception:
                rbody = resp.text
            raise HyphenAPIError(f"하이픈 API {resp.status_code}: {rbody}", status_code=resp.status_code, body=rbody)
        if resp.status_code == 204 or not resp.content:
            return None
        try:
            return resp.json()
        except Exception:
            return resp.text

    # ============ 기업계좌 전계좌조회 (POST /in0087000519) — 계좌목록 ============

    ALL_ACCTS_PATH = "/in0087000519"

    async def list_accounts(
        self,
        *,
        bank_cd: str,
        login_method: str = "ID",
        user_id: Optional[str] = None,
        user_pw: Optional[str] = None,
        acct_pw: Optional[str] = None,
        sign_cert: Optional[str] = None,
        sign_pri: Optional[str] = None,
        sign_pw: Optional[str] = None,
        gubun: str = "01",           # 01:입출금 / 02:유형별 / 03:대출
        detail_yn: str = "Y",
        use_channel: Optional[str] = None,
        encrypt_secrets: bool = False,
        gustation: bool = False,
        path: Optional[str] = None,
    ) -> Any:
        """아이디/인증서 로그인으로 은행의 전 계좌 목록 조회 (/in0087000519)."""
        p = path or self.ALL_ACCTS_PATH
        payload: Dict[str, Any] = {
            "gubun": gubun,
            "bankCd": bank_cd,
            "loginMethod": login_method,
            "detailYn": detail_yn,
        }
        if use_channel:
            payload["useChannel"] = use_channel

        def _enc_or_plain(plain_key: str, enc_key: str, value: str):
            if encrypt_secrets:
                payload[enc_key] = self.encrypt(value)
            else:
                payload[plain_key] = value

        if login_method.upper() == "ID":
            if user_id is not None:
                payload["userId"] = user_id
            if user_pw is not None:
                _enc_or_plain("userPw", "userPwEnc", user_pw)
        else:  # CERT
            if sign_cert is not None:
                payload["signCert"] = _pem_body(sign_cert)
            if sign_pri is not None:
                _dec = _decrypt_sign_key(sign_pri, sign_pw) if sign_pw else None
                payload["signPri"] = _dec or _pem_body(sign_pri)
            if sign_pw is not None:
                _enc_or_plain("signPw", "signPwEnc", sign_pw)
        # 일부 은행(우리 등) 아이디로그인 시 계좌 추가인증 필요
        if acct_pw is not None:
            _enc_or_plain("acctPw", "acctPwEnc", acct_pw)
        return await self.call_bank(p, payload, gustation=gustation)

    # ============ 기업계좌 거래내역조회 (POST /in0087000483) — PoC 대상 ============

    ACCT_TX_PATH = "/in0087000483"

    async def account_transactions(
        self,
        *,
        bank_cd: str,
        acct_no: str,
        start_date: str,
        end_date: str,
        login_method: str = "ID",       # ID: 아이디로그인 / CERT: 인증서로그인
        user_id: Optional[str] = None,   # 은행사이트 사용자 아이디
        user_pw: Optional[str] = None,   # 은행사이트 비밀번호 (평문 → userPwEnc로 암호화)
        acct_pw: Optional[str] = None,   # 계좌 비밀번호 (평문 → acctPwEnc로 암호화)
        sign_cert: Optional[str] = None, # 인증서 PEM (CERT 로그인)
        sign_pri: Optional[str] = None,  # 개인키 PEM (CERT 로그인)
        sign_pw: Optional[str] = None,   # 인증서 비밀번호 (평문 → signPwEnc로 암호화)
        gubun: str = "01",               # 01:입출금,외화 / 02:대출 / 03:펀드(우리은행)
        detail_yn: str = "Y",            # 상세조회(입출금 계좌정보 출력)
        sort: str = "OLD",               # NEW:최신 / OLD:과거
        filter_type: str = "all",        # all / in / out
        use_channel: Optional[str] = None,
        cur_cd: Optional[str] = None,
        encrypt_secrets: bool = True,    # 민감필드 ekey 암호화(*Enc 필드로 전송)
        gustation: bool = False,         # True면 테스트베드(샘플응답)
        path: Optional[str] = None,
        extra: Optional[Dict[str, Any]] = None,
    ) -> Any:
        """기업계좌 거래내역조회 — /in0087000483 명세 기준.

        평문으로 넘긴 userPw/acctPw/signPw는 encrypt_secrets=True면 ekey로 AES 암호화되어
        각각 userPwEnc/acctPwEnc/signPwEnc 필드로 전송됨.
        """
        p = path or os.getenv("HYPHEN_ACCT_TX_PATH", self.ACCT_TX_PATH)
        payload: Dict[str, Any] = {
            "gubun": gubun,
            "bankCd": bank_cd,
            "loginMethod": login_method,
            "acctNo": acct_no,
            "sdate": start_date.replace("-", ""),
            "edate": end_date.replace("-", ""),
            "detailYn": detail_yn,
            "sort": sort,
            "filterType": filter_type,
        }
        if use_channel:
            payload["useChannel"] = use_channel
        if cur_cd:
            payload["curCd"] = cur_cd

        def _enc_or_plain(plain_key: str, enc_key: str, value: str):
            if encrypt_secrets:
                payload[enc_key] = self.encrypt(value)
            else:
                payload[plain_key] = value

        if login_method.upper() == "ID":
            if user_id is not None:
                payload["userId"] = user_id
            if user_pw is not None:
                _enc_or_plain("userPw", "userPwEnc", user_pw)
            if acct_pw is not None:
                _enc_or_plain("acctPw", "acctPwEnc", acct_pw)
        else:  # CERT
            if sign_cert is not None:
                payload["signCert"] = _pem_body(sign_cert)
            if sign_pri is not None:
                _dec = _decrypt_sign_key(sign_pri, sign_pw) if sign_pw else None
                payload["signPri"] = _dec or _pem_body(sign_pri)
            if sign_pw is not None:
                _enc_or_plain("signPw", "signPwEnc", sign_pw)
            if acct_pw is not None:
                _enc_or_plain("acctPw", "acctPwEnc", acct_pw)

        if extra:
            payload.update(extra)
        return await self.call_bank(p, payload, gustation=gustation)


# 싱글톤
_hyphen_client: Optional[HyphenClient] = None


def get_hyphen_client() -> HyphenClient:
    global _hyphen_client
    if _hyphen_client is None:
        _hyphen_client = HyphenClient()
    return _hyphen_client
