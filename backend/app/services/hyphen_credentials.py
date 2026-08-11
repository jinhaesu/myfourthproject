"""
하이픈 인증정보 서비스 — 암호화 보관/복호화, 30일 TTL 정리, 인증서 PEM 변환, 조회 실행.

민감필드는 data_encryption(Fernet)으로 at-rest 암호화. 30일 경과분은 접근 시 자동 삭제.
"""
import base64
import logging
from datetime import datetime, timedelta
from typing import Optional, List, Dict, Any

from sqlalchemy import select, delete as sa_delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import data_encryption
from app.models.hyphen_credential import HyphenCredential, HYPHEN_CRED_TTL_DAYS
from app.services.hyphen_client import get_hyphen_client, HyphenAPIError

logger = logging.getLogger(__name__)


# ============ 인증서 PEM 변환 ============

def cert_der_to_pem(der: bytes) -> Dict[str, Any]:
    """signCert.der → {pem, subject, expires_at}. 실패 시 raw base64 PEM으로 폴백."""
    from cryptography import x509
    from cryptography.hazmat.primitives import serialization
    try:
        c = x509.load_der_x509_certificate(der)
        pem = c.public_bytes(serialization.Encoding.PEM).decode()
        return {
            "pem": pem,
            "subject": c.subject.rfc4514_string()[:300],
            "expires_at": c.not_valid_after_utc.replace(tzinfo=None),
        }
    except Exception as e:
        logger.warning("cert DER 파싱 실패, raw PEM 폴백: %s", e)
        b64 = base64.b64encode(der).decode()
        pem = "-----BEGIN CERTIFICATE-----\n" + "\n".join(b64[i:i+64] for i in range(0, len(b64), 64)) + "\n-----END CERTIFICATE-----\n"
        return {"pem": pem, "subject": None, "expires_at": None}


def key_der_to_pem(key: bytes) -> str:
    """signPri.key(암호화된 EncryptedPrivateKeyInfo DER) → ENCRYPTED PRIVATE KEY PEM."""
    b64 = base64.b64encode(key).decode()
    return "-----BEGIN ENCRYPTED PRIVATE KEY-----\n" + "\n".join(b64[i:i+64] for i in range(0, len(b64), 64)) + "\n-----END ENCRYPTED PRIVATE KEY-----\n"


def _looks_pem(data: bytes) -> bool:
    head = data[:40].lstrip()
    return head.startswith(b"-----BEGIN")


# ============ CRUD + 만료 정리 ============

async def purge_expired(db: AsyncSession) -> int:
    """30일 경과 인증정보 삭제. 삭제 건수 반환."""
    now = datetime.utcnow()
    res = await db.execute(sa_delete(HyphenCredential).where(HyphenCredential.expires_at <= now))
    await db.commit()
    n = res.rowcount or 0
    if n:
        logger.info("하이픈 인증정보 만료 삭제 %d건", n)
    return n


def _enc(v: Optional[str]) -> Optional[str]:
    return data_encryption.encrypt(v) if v else None


def _dec(v: Optional[str]) -> Optional[str]:
    if not v:
        return None
    try:
        return data_encryption.decrypt(v)
    except Exception:
        logger.warning("하이픈 인증정보 복호화 실패 (SECRET_KEY 변경?)")
        return None


async def register_credential(
    db: AsyncSession,
    *,
    bank_cd: str,
    acct_no: str,
    acct_pw: Optional[str] = None,
    login_method: str = "CERT",
    sign_cert_bytes: Optional[bytes] = None,
    sign_pri_bytes: Optional[bytes] = None,
    sign_pw: Optional[str] = None,
    user_id: Optional[str] = None,
    user_pw: Optional[str] = None,
    label: Optional[str] = None,
    created_by: Optional[str] = None,
) -> HyphenCredential:
    """인증정보 등록(또는 같은 bank_cd+acct_no 갱신). 30일 만료 재설정."""
    cert_pem = None
    cert_subject = None
    cert_expires_at = None
    key_pem = None
    if login_method.upper() == "CERT":
        if sign_cert_bytes:
            info = ({"pem": sign_cert_bytes.decode(), "subject": None, "expires_at": None}
                    if _looks_pem(sign_cert_bytes) else cert_der_to_pem(sign_cert_bytes))
            cert_pem = info["pem"]
            cert_subject = info["subject"]
            cert_expires_at = info["expires_at"]
        if sign_pri_bytes:
            key_pem = (sign_pri_bytes.decode() if _looks_pem(sign_pri_bytes)
                       else key_der_to_pem(sign_pri_bytes))

    now = datetime.utcnow()
    # 기존 동일 계좌 있으면 갱신
    existing = (await db.execute(
        select(HyphenCredential).where(
            HyphenCredential.bank_cd == bank_cd,
            HyphenCredential.acct_no == acct_no,
        )
    )).scalar_one_or_none()
    cred = existing or HyphenCredential(bank_cd=bank_cd, acct_no=acct_no)
    cred.label = label
    cred.bank_cd = bank_cd
    cred.acct_no = acct_no
    cred.acct_last4 = (acct_no or "")[-4:]
    cred.login_method = login_method.upper()
    if cert_pem is not None:
        cred.enc_sign_cert = _enc(cert_pem)
    if key_pem is not None:
        cred.enc_sign_pri = _enc(key_pem)
    if sign_pw is not None:
        cred.enc_sign_pw = _enc(sign_pw)
    if acct_pw is not None:
        cred.enc_acct_pw = _enc(acct_pw)
    if user_id is not None:
        cred.enc_user_id = _enc(user_id)
    if user_pw is not None:
        cred.enc_user_pw = _enc(user_pw)
    if cert_subject:
        cred.cert_subject = cert_subject
    if cert_expires_at:
        cred.cert_expires_at = cert_expires_at
    cred.created_by = created_by
    cred.created_at = now
    cred.expires_at = now + timedelta(days=HYPHEN_CRED_TTL_DAYS)
    cred.last_status = "등록됨(미검증)"
    if not existing:
        db.add(cred)
    await db.commit()
    await db.refresh(cred)
    return cred


def to_public(c: HyphenCredential) -> Dict[str, Any]:
    """비밀 제외 표시용 dict."""
    return {
        "id": c.id,
        "label": c.label,
        "bank_cd": c.bank_cd,
        "acct_no": c.acct_no,
        "acct_last4": c.acct_last4,
        "login_method": c.login_method,
        "cert_subject": c.cert_subject,
        "cert_expires_at": c.cert_expires_at.isoformat() if c.cert_expires_at else None,
        "created_by": c.created_by,
        "created_at": c.created_at.isoformat() if c.created_at else None,
        "expires_at": c.expires_at.isoformat() if c.expires_at else None,
        "days_left": c.days_left,
        "is_expired": c.is_expired,
        "last_used_at": c.last_used_at.isoformat() if c.last_used_at else None,
        "last_status": c.last_status,
        "has_cert": bool(c.enc_sign_cert),
        "last_synced_at": c.last_synced_at.isoformat() if c.last_synced_at else None,
        "last_balance": float(c.last_balance) if c.last_balance is not None else None,
    }


async def list_credentials(db: AsyncSession) -> List[Dict[str, Any]]:
    await purge_expired(db)
    rows = (await db.execute(select(HyphenCredential).order_by(HyphenCredential.created_at.desc()))).scalars().all()
    return [to_public(c) for c in rows]


async def get_credential(db: AsyncSession, cred_id: int) -> Optional[HyphenCredential]:
    return (await db.execute(select(HyphenCredential).where(HyphenCredential.id == cred_id))).scalar_one_or_none()


async def delete_credential(db: AsyncSession, cred_id: int) -> bool:
    c = await get_credential(db, cred_id)
    if not c:
        return False
    await db.delete(c)
    await db.commit()
    return True


async def get_active_for_account(db: AsyncSession, bank_cd: str, acct_no: str) -> Optional[HyphenCredential]:
    """만료 안 된 특정 계좌 인증정보."""
    await purge_expired(db)
    return (await db.execute(
        select(HyphenCredential).where(
            HyphenCredential.bank_cd == bank_cd,
            HyphenCredential.acct_no == acct_no,
        )
    )).scalar_one_or_none()


# ============ 저장된 인증정보로 조회 실행 ============

async def run_account_transactions(
    db: AsyncSession,
    cred: HyphenCredential,
    *,
    start_date: str,
    end_date: str,
    gubun: str = "01",
    sort: str = "OLD",
    filter_type: str = "all",
    gustation: bool = False,
) -> Dict[str, Any]:
    """저장 인증정보를 복호화해 하이픈 거래내역 조회. last_used/last_status 갱신."""
    if cred.is_expired:
        raise HyphenAPIError("인증정보가 만료되었습니다(30일). 재인증이 필요합니다.", status_code=401)
    client = get_hyphen_client()
    import time
    t0 = time.perf_counter()
    try:
        data = await client.account_transactions(
            bank_cd=cred.bank_cd,
            acct_no=cred.acct_no,
            start_date=start_date,
            end_date=end_date,
            login_method=cred.login_method,
            user_id=_dec(cred.enc_user_id),
            user_pw=_dec(cred.enc_user_pw),
            acct_pw=_dec(cred.enc_acct_pw),
            sign_cert=_dec(cred.enc_sign_cert),
            sign_pri=_dec(cred.enc_sign_pri),
            sign_pw=_dec(cred.enc_sign_pw),
            gubun=gubun,
            sort=sort,
            filter_type=filter_type,
            encrypt_secrets=False,  # 하이픈이 평문 수신 후 자체 처리(TLS 보호)
            gustation=gustation,
        )
        elapsed = round(time.perf_counter() - t0, 2)
        common = (data or {}).get("common") if isinstance(data, dict) else {}
        err_yn = (common or {}).get("errYn")
        err_msg = (common or {}).get("errMsg")
        cred.last_used_at = datetime.utcnow()
        cred.last_status = (f"실패: {err_msg}" if err_yn == "Y" else f"성공 {elapsed}s")[:300]
        await db.commit()
        return {"elapsed_sec": elapsed, "data": data}
    except HyphenAPIError as e:
        cred.last_status = f"오류: {str(e)[:280]}"
        await db.commit()
        raise
