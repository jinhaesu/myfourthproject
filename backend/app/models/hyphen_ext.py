"""
하이픈 확장 원장 — 세금계산서·법인카드 동기화 데이터 + 카드 연동설정.
은행과 동일하게 dedup_hash로 중복방지, 화면은 DB 즉시 읽음.
"""
from datetime import datetime
from typing import Optional
from sqlalchemy import Integer, String, DateTime, Numeric, Text, Index
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class HyphenTaxInvoice(Base):
    """홈택스 전자세금계산서 1건 (매출/매입)."""
    __tablename__ = "hyphen_tax_invoice"
    __table_args__ = (Index("ix_hyphen_taxinv_dt", "issue_dt"), {"extend_existing": True})

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    biz_no: Mapped[str] = mapped_column(String(20), index=True)
    sup_byr: Mapped[str] = mapped_column(String(2), index=True)  # 01 매출 / 02 매입
    issue_dt: Mapped[str] = mapped_column(String(10), index=True)  # 발행일 YYYYMMDD/date
    make_dt: Mapped[Optional[str]] = mapped_column(String(10), nullable=True)
    sup_corp_nm: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)  # 공급자
    sup_biz_no: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)
    byr_corp_nm: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)  # 공급받는자
    byr_biz_no: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)
    tot_amt: Mapped[float] = mapped_column(Numeric(20, 2), default=0)
    sup_amt: Mapped[float] = mapped_column(Numeric(20, 2), default=0)
    tax_amt: Mapped[float] = mapped_column(Numeric(20, 2), default=0)
    tax_knd: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)   # 세금/계산서
    item_nm: Mapped[Optional[str]] = mapped_column(String(300), nullable=True)
    issue_no: Mapped[Optional[str]] = mapped_column(String(60), nullable=True)
    dedup_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    synced_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class HyphenCardTx(Base):
    """법인카드 매입내역 1건."""
    __tablename__ = "hyphen_card_tx"
    __table_args__ = (Index("ix_hyphen_cardtx_dt", "use_dt"), {"extend_existing": True})

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    card_cd: Mapped[str] = mapped_column(String(10), index=True)
    card_no: Mapped[str] = mapped_column(String(30), index=True)  # 마스킹 카드번호
    use_dt: Mapped[str] = mapped_column(String(10), index=True)
    use_tm: Mapped[Optional[str]] = mapped_column(String(10), nullable=True)
    appr_no: Mapped[Optional[str]] = mapped_column(String(30), nullable=True)
    use_store: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    use_amt: Mapped[float] = mapped_column(Numeric(20, 2), default=0)
    use_div: Mapped[Optional[str]] = mapped_column(String(30), nullable=True)   # 승인/취소
    appr_st: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)
    inst_mon: Mapped[Optional[str]] = mapped_column(String(10), nullable=True)  # 할부개월
    store_biz_no: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)
    tax_type: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)
    dedup_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    synced_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class HyphenSyncCoverage(Base):
    """동기화 커버리지 — (종류,키)별로 이미 API로 당긴 날짜범위. 이 범위 내 조회는 API 재호출 안 함."""
    __tablename__ = "hyphen_sync_coverage"
    __table_args__ = (Index("ix_hyphen_cov_kk", "kind", "ckey", unique=True), {"extend_existing": True})

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    kind: Mapped[str] = mapped_column(String(10))   # bank / tax / card
    ckey: Mapped[str] = mapped_column(String(50))   # acct_no / card_no / 'tax'
    start_date: Mapped[str] = mapped_column(String(8))   # YYYYMMDD (당긴 최소일)
    end_date: Mapped[str] = mapped_column(String(8))     # YYYYMMDD (당긴 최대일)
    synced_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class HyphenCardAccount(Base):
    """법인카드 연동설정 (카드사+카드번호). 인증은 공용 법인 공동인증서 재사용."""
    __tablename__ = "hyphen_card_account"
    __table_args__ = {"extend_existing": True}

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    card_cd: Mapped[str] = mapped_column(String(10))
    card_no: Mapped[str] = mapped_column(String(30))
    label: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    login_method: Mapped[str] = mapped_column(String(10), default="CERT")
    enc_user_id: Mapped[Optional[str]] = mapped_column(Text, nullable=True)  # 카드사 아이디로그인시
    enc_user_pw: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_by: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    last_synced_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    last_status: Mapped[Optional[str]] = mapped_column(String(300), nullable=True)
