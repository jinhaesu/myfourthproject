"""
Smart Finance Core - Security Module
인증, 암호화, 권한 관리
"""
from datetime import datetime, timedelta
from typing import Optional, Union
import secrets
import hashlib
import base64

from jose import JWTError, jwt
from passlib.context import CryptContext
from cryptography.fernet import Fernet
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

from app.core.config import settings


# Password hashing context
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


def verify_password(plain_password: str, hashed_password: str) -> bool:
    """Verify a password against its hash"""
    return pwd_context.verify(plain_password, hashed_password)


def get_password_hash(password: str) -> str:
    """Generate password hash"""
    return pwd_context.hash(password)


def validate_password_strength(password: str) -> tuple[bool, list[str]]:
    """
    Validate password meets security requirements
    Returns (is_valid, list of error messages)
    """
    errors = []

    if len(password) < settings.PASSWORD_MIN_LENGTH:
        errors.append(f"비밀번호는 최소 {settings.PASSWORD_MIN_LENGTH}자 이상이어야 합니다.")

    if settings.PASSWORD_REQUIRE_UPPERCASE and not any(c.isupper() for c in password):
        errors.append("대문자를 포함해야 합니다.")

    if settings.PASSWORD_REQUIRE_LOWERCASE and not any(c.islower() for c in password):
        errors.append("소문자를 포함해야 합니다.")

    if settings.PASSWORD_REQUIRE_DIGIT and not any(c.isdigit() for c in password):
        errors.append("숫자를 포함해야 합니다.")

    if settings.PASSWORD_REQUIRE_SPECIAL:
        special_chars = "!@#$%^&*()_+-=[]{}|;:',.<>?"
        if not any(c in special_chars for c in password):
            errors.append("특수문자를 포함해야 합니다.")

    return len(errors) == 0, errors


def create_access_token(
    data: dict,
    expires_delta: Optional[timedelta] = None
) -> str:
    """Create JWT access token"""
    to_encode = data.copy()

    if expires_delta:
        expire = datetime.utcnow() + expires_delta
    else:
        expire = datetime.utcnow() + timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)

    to_encode.update({
        "exp": expire,
        "iat": datetime.utcnow(),
        "type": "access"
    })

    return jwt.encode(to_encode, settings.SECRET_KEY, algorithm=settings.ALGORITHM)


def create_refresh_token(data: dict) -> str:
    """Create JWT refresh token"""
    to_encode = data.copy()
    expire = datetime.utcnow() + timedelta(days=settings.REFRESH_TOKEN_EXPIRE_DAYS)

    to_encode.update({
        "exp": expire,
        "iat": datetime.utcnow(),
        "type": "refresh"
    })

    return jwt.encode(to_encode, settings.SECRET_KEY, algorithm=settings.ALGORITHM)


def decode_token(token: str) -> Optional[dict]:
    """Decode and verify JWT token"""
    try:
        payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
        return payload
    except JWTError:
        return None


def generate_otp() -> str:
    """Generate 6-digit OTP for 2FA"""
    return ''.join([str(secrets.randbelow(10)) for _ in range(6)])


def generate_otp_secret() -> str:
    """Generate secret key for OTP"""
    return secrets.token_urlsafe(32)


class DataEncryption:
    """
    AES-256 encryption for sensitive data
    감사 추적 및 민감 데이터 암호화용
    """

    def __init__(self, key: Optional[str] = None):
        if key is None:
            key = settings.SECRET_KEY

        # Derive a key from the secret
        kdf = PBKDF2HMAC(
            algorithm=hashes.SHA256(),
            length=32,
            salt=b"smartfinance_salt",  # In production, use a secure random salt
            iterations=100000,
        )
        derived_key = base64.urlsafe_b64encode(kdf.derive(key.encode()))
        self.fernet = Fernet(derived_key)

    def encrypt(self, data: str) -> str:
        """Encrypt string data"""
        return self.fernet.encrypt(data.encode()).decode()

    def decrypt(self, encrypted_data: str) -> str:
        """Decrypt string data"""
        return self.fernet.decrypt(encrypted_data.encode()).decode()


def hash_sensitive_data(data: str) -> str:
    """
    One-way hash for sensitive data (e.g., card numbers)
    단방향 해시 - 검색용
    """
    return hashlib.sha256(data.encode()).hexdigest()


class AuditLogger:
    """
    Audit trail logging for compliance
    감사 추적 로거 - 내부 통제용
    """

    @staticmethod
    def log_action(
        user_id: int,
        action: str,
        resource_type: str,
        resource_id: Union[int, str],
        old_value: Optional[dict] = None,
        new_value: Optional[dict] = None,
        ip_address: Optional[str] = None
    ) -> dict:
        """
        Create audit log entry

        Args:
            user_id: ID of user performing action
            action: Action type (CREATE, READ, UPDATE, DELETE)
            resource_type: Type of resource (voucher, approval, etc.)
            resource_id: ID of the resource
            old_value: Previous state (for updates)
            new_value: New state (for creates/updates)
            ip_address: Client IP address
        """
        return {
            "timestamp": datetime.utcnow().isoformat(),
            "user_id": user_id,
            "action": action,
            "resource_type": resource_type,
            "resource_id": str(resource_id),
            "old_value": old_value,
            "new_value": new_value,
            "ip_address": ip_address
        }


# Instantiate encryption helper
data_encryption = DataEncryption()
