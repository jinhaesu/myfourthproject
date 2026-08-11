"""
하이픈 계좌 거래내역 로컬 원장 — 하이픈에서 동기화한 거래를 DB에 보관.

화면(통합조회·대시보드·자금일보)은 이 테이블을 즉시 읽음(은행 실로그인은 동기화 시점만).
dedup_hash로 중복 방지(반복 동기화 안전).
"""
from datetime import datetime
from typing import Optional
from sqlalchemy import Integer, String, DateTime, Numeric, Text, Index
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class HyphenBankTx(Base):
    """하이픈에서 동기화한 계좌 거래 1건."""
    __tablename__ = "hyphen_bank_tx"
    __table_args__ = (
        Index("ix_hyphen_bank_tx_acct_date", "acct_no", "tr_date"),
        {"extend_existing": True},
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    credential_id: Mapped[Optional[int]] = mapped_column(Integer, index=True, nullable=True)
    bank_cd: Mapped[str] = mapped_column(String(10), index=True)
    acct_no: Mapped[str] = mapped_column(String(50), index=True)
    acct_last4: Mapped[Optional[str]] = mapped_column(String(8), nullable=True)

    tr_date: Mapped[str] = mapped_column(String(10), index=True)   # YYYYMMDD 또는 YYYY-MM-DD
    tr_time: Mapped[Optional[str]] = mapped_column(String(10), nullable=True)
    in_amt: Mapped[float] = mapped_column(Numeric(20, 2), default=0)
    out_amt: Mapped[float] = mapped_column(Numeric(20, 2), default=0)
    balance: Mapped[Optional[float]] = mapped_column(Numeric(20, 2), nullable=True)

    tr_name: Mapped[Optional[str]] = mapped_column(String(300), nullable=True)   # 거래처/적요(trNm)
    tr_type: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)    # trTp
    memo: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    counterparty_acct: Mapped[Optional[str]] = mapped_column(String(60), nullable=True)
    counterparty_name: Mapped[Optional[str]] = mapped_column(String(120), nullable=True)

    dedup_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    synced_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
