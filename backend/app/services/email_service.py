"""
Smart Finance Core - Email Service (Resend)
Resend API를 통한 이메일 OTP 발송 및 검증
"""
import secrets
import time
import logging
from typing import Optional

import httpx

from app.core.config import settings

logger = logging.getLogger(__name__)

# In-memory OTP 저장소 (프로덕션에서는 Redis 사용 권장)
# { email: { "code": "123456", "expires_at": timestamp, "attempts": 0 } }
_otp_store: dict[str, dict] = {}

# OTP 설정
OTP_LENGTH = 6
OTP_EXPIRE_SECONDS = 300  # 5분
OTP_MAX_ATTEMPTS = 5


def generate_otp_code() -> str:
    """안전한 6자리 OTP 생성"""
    return ''.join([str(secrets.randbelow(10)) for _ in range(OTP_LENGTH)])


def is_email_allowed(email: str) -> bool:
    """화이트리스트에 있는 이메일인지 확인"""
    if not settings.ALLOWED_EMAILS:
        return True  # 화이트리스트가 비어있으면 모든 이메일 허용
    return email.lower() in [e.lower() for e in settings.ALLOWED_EMAILS]


async def send_otp_email(email: str) -> bool:
    """
    Resend API를 통해 OTP 이메일 발송

    Returns:
        True if sent successfully
    """
    if not settings.RESEND_API_KEY:
        logger.warning("RESEND_API_KEY not configured, using debug mode")
        # 디버그 모드: OTP를 로그에 출력
        code = generate_otp_code()
        _otp_store[email.lower()] = {
            "code": code,
            "expires_at": time.time() + OTP_EXPIRE_SECONDS,
            "attempts": 0,
        }
        logger.info(f"[DEBUG] OTP for {email}: {code}")
        return True

    code = generate_otp_code()
    _otp_store[email.lower()] = {
        "code": code,
        "expires_at": time.time() + OTP_EXPIRE_SECONDS,
        "attempts": 0,
    }

    html_body = f"""
    <div style="font-family: 'Apple SD Gothic Neo', sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
        <div style="background: linear-gradient(135deg, #2563eb, #4f46e5); border-radius: 12px; padding: 32px; text-align: center; color: white;">
            <h1 style="margin: 0 0 8px; font-size: 24px;">Smart Finance Core</h1>
            <p style="margin: 0; opacity: 0.9; font-size: 14px;">로그인 인증 코드</p>
        </div>
        <div style="background: #ffffff; border: 1px solid #e5e7eb; border-radius: 12px; margin-top: 16px; padding: 32px; text-align: center;">
            <p style="color: #6b7280; font-size: 14px; margin: 0 0 16px;">아래 인증 코드를 입력해주세요.</p>
            <div style="background: #f3f4f6; border-radius: 8px; padding: 16px; margin: 0 auto; display: inline-block;">
                <span style="font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #1f2937;">{code}</span>
            </div>
            <p style="color: #9ca3af; font-size: 12px; margin: 16px 0 0;">
                이 코드는 {OTP_EXPIRE_SECONDS // 60}분 동안 유효합니다.<br>
                본인이 요청하지 않았다면 이 이메일을 무시해주세요.
            </p>
        </div>
    </div>
    """

    try:
        async with httpx.AsyncClient() as client:
            response = await client.post(
                "https://api.resend.com/emails",
                headers={
                    "Authorization": f"Bearer {settings.RESEND_API_KEY}",
                    "Content-Type": "application/json",
                },
                json={
                    "from": settings.RESEND_FROM_EMAIL,
                    "to": [email],
                    "subject": f"[Smart Finance] 로그인 인증 코드: {code}",
                    "html": html_body,
                },
                timeout=10.0,
            )

        if response.status_code in (200, 201):
            logger.info(f"OTP email sent to {email}")
            return True
        else:
            logger.error(f"Resend API error: {response.status_code} {response.text}")
            return False

    except Exception as e:
        logger.error(f"Failed to send OTP email: {e}")
        return False


def verify_otp_code(email: str, code: str) -> tuple[bool, str]:
    """
    OTP 코드 검증

    Returns:
        (success, message)
    """
    email_lower = email.lower()
    entry = _otp_store.get(email_lower)

    if not entry:
        return False, "인증 코드가 요청되지 않았습니다. 다시 로그인해주세요."

    # 만료 확인
    if time.time() > entry["expires_at"]:
        del _otp_store[email_lower]
        return False, "인증 코드가 만료되었습니다. 다시 로그인해주세요."

    # 시도 횟수 확인
    if entry["attempts"] >= OTP_MAX_ATTEMPTS:
        del _otp_store[email_lower]
        return False, "인증 시도 횟수를 초과했습니다. 다시 로그인해주세요."

    entry["attempts"] += 1

    if entry["code"] != code:
        remaining = OTP_MAX_ATTEMPTS - entry["attempts"]
        return False, f"인증 코드가 올바르지 않습니다. (남은 시도: {remaining}회)"

    # 성공 - OTP 삭제
    del _otp_store[email_lower]
    return True, "인증 성공"


def clear_otp(email: str):
    """OTP 항목 삭제"""
    _otp_store.pop(email.lower(), None)
