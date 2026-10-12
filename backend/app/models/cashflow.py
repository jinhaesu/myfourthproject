"""
현금흐름(Cash Flow) 분류 — 통장 거래(hyphen_bank_tx)를 현금흐름표 라인으로 분류.

설계(사용자 지시): 현금흐름 = 통장 내역 − 내부거래.
각 거래를 현금흐름 라인(영업수입/매출원가/판관비/영업외/투자/재무)으로 분류해
旬(10일 단위)×월 피벗으로 집계한다. 자동분류 후 화면에서 수동 재분류하면
이 테이블에 tx_hash 기준으로 저장되어 영구 반영된다(멱등).
"""
from datetime import datetime
from typing import Optional

from sqlalchemy import Integer, String, DateTime, Index
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


# 현금흐름표 라인 정의 — (키, 표시명, 방향). 방향: in=유입, out=유출, both=투자/재무(부호는 거래 in/out로).
CF_LINES = [
    ("op_income",   "영업수입",         "in"),
    ("op_advance",  "선정산(선입금)",    "in"),
    ("op_cogs",     "영업지출(매출원가)", "out"),
    ("op_sga",      "판매관리비",        "out"),
    ("non_op_in",   "영업외수입",        "in"),
    ("non_op_out",  "영업외지출(세금 등)", "out"),
    ("investing",   "투자활동",          "both"),
    ("financing",   "재무활동(차입·상환)", "both"),
    ("exclude",     "내부이체/제외",      "both"),
    ("uncat",       "미분류",            "both"),
]
# 현금흐름 집계에서 제외하는 라인(내부이체 등) — 피벗 셀/순증감에 반영 안 함
EXCLUDE_LINES = {"exclude"}
CF_LINE_KEYS = [k for k, _, _ in CF_LINES]
CF_LINE_LABEL = {k: label for k, label, _ in CF_LINES}
CF_LINE_DIR = {k: d for k, _, d in CF_LINES}
DEFAULT_IN_LINE = "op_income"
DEFAULT_OUT_LINE = "op_sga"


class CashflowClass(Base):
    """통장 거래 1건의 현금흐름 라인 분류(수동 재분류 영속)."""
    __tablename__ = "cashflow_class"
    __table_args__ = (
        Index("ix_cashflow_class_hash", "tx_hash"),
        {"extend_existing": True},
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    tx_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)  # HyphenBankTx.dedup_hash
    cf_line: Mapped[str] = mapped_column(String(20))        # CF_LINE_KEYS 중 하나
    cf_sub: Mapped[Optional[str]] = mapped_column(String(60), nullable=True)   # 세부(계정명 등, 선택)
    source: Mapped[str] = mapped_column(String(10), default="manual")  # manual | auto
    updated_by: Mapped[Optional[str]] = mapped_column(String(120), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class CashflowConfig(Base):
    """현금흐름 전역 설정 — 연초 기초잔액 수동보정 등(연도별 1행)."""
    __tablename__ = "cashflow_config"
    __table_args__ = ({"extend_existing": True},)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    year: Mapped[int] = mapped_column(Integer, unique=True, index=True)
    opening_balance: Mapped[Optional[float]] = mapped_column(nullable=True)  # 연초 기초잔액 수동보정(없으면 거래로 역산)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
