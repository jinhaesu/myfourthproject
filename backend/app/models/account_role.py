"""
은행 계좌 역할 — 간접 현금흐름 관리용.

역할:
- reservoir(매출 보관): 외부 매출이 쌓이는 풀 계좌 (예: 신한)
- operating(운영/지출): 이자·카드값 등이 빠져나가는 계좌 (예: 기업)
- savings(적립): 퇴직연금 등 — 이동해도 회사 잔액 감소 아님
- other(기타)
"""
from datetime import datetime
from typing import Optional
from sqlalchemy import Integer, String, DateTime
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class BankAccountRole(Base):
    __tablename__ = "bank_account_roles"
    __table_args__ = {"extend_existing": True}

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    account_label: Mapped[str] = mapped_column(String(80), unique=True, index=True)
    role: Mapped[str] = mapped_column(String(20), default="other")  # reservoir/operating/savings/other
    memo: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow,
    )
