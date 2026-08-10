"""
하이픈 은행 스크래핑 인증정보 — 서버 암호화 보관 (30일 후 자동 삭제 → 재인증).

민감필드(signCert/signPri/signPw/acctPw/userPw)는 app.core.security.data_encryption
(Fernet AES-256, SECRET_KEY 파생)으로 암호화해 저장. 평문 컬럼은 식별/표시용만.
"""
from datetime import datetime, timedelta
from typing import Optional
from sqlalchemy import Integer, String, Text, DateTime
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base

# 인증정보 보관 기간 — 경과 시 삭제하고 재인증 요구
HYPHEN_CRED_TTL_DAYS = 30


class HyphenCredential(Base):
    """하이픈 계좌 스크래핑용 인증정보 (암호화 보관, 30일 TTL)."""
    __tablename__ = "hyphen_credentials"
    __table_args__ = {"extend_existing": True}

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    label: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    bank_cd: Mapped[str] = mapped_column(String(10))
    # 계좌번호 — 식별/표시용 평문 + 끝4자리
    acct_no: Mapped[str] = mapped_column(String(50))
    acct_last4: Mapped[Optional[str]] = mapped_column(String(8), nullable=True)
    login_method: Mapped[str] = mapped_column(String(10), default="CERT")  # CERT / ID

    # 암호화 저장 필드 (Fernet)
    enc_sign_cert: Mapped[Optional[str]] = mapped_column(Text, nullable=True)  # 인증서 PEM
    enc_sign_pri: Mapped[Optional[str]] = mapped_column(Text, nullable=True)   # 개인키 PEM(암호화된 키)
    enc_sign_pw: Mapped[Optional[str]] = mapped_column(Text, nullable=True)    # 인증서 비밀번호
    enc_acct_pw: Mapped[Optional[str]] = mapped_column(Text, nullable=True)    # 계좌 비밀번호
    enc_user_id: Mapped[Optional[str]] = mapped_column(Text, nullable=True)    # (ID로그인) 은행ID
    enc_user_pw: Mapped[Optional[str]] = mapped_column(Text, nullable=True)    # (ID로그인) 은행PW

    # 인증서 정보(표시용, 비밀 아님)
    cert_subject: Mapped[Optional[str]] = mapped_column(String(300), nullable=True)
    cert_expires_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    created_by: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    # 보관 만료 — 경과 시 삭제 대상
    expires_at: Mapped[datetime] = mapped_column(
        DateTime, default=lambda: datetime.utcnow() + timedelta(days=HYPHEN_CRED_TTL_DAYS)
    )
    last_used_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    last_status: Mapped[Optional[str]] = mapped_column(String(300), nullable=True)

    @property
    def is_expired(self) -> bool:
        return datetime.utcnow() >= self.expires_at

    @property
    def days_left(self) -> int:
        return max(0, (self.expires_at - datetime.utcnow()).days)
