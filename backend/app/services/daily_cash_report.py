"""
Daily Cash Report (AI 자금 다이제스트) 생성 서비스

섹션별 콘텐츠 생성:
- cash_status: 어제 입출금 + 현 잔액
- ai_cashflow: 잔액 추이 (전일/전월 대비) + 주요 입출금 + AI 요약 텍스트
- card_spending: 어제 카드 지출 + 이번달 누적 + 전월 동기 비교
- card_usage: 어제 카드 결제 상세 목록

데이터 소스: vouchers + voucher_lines (위하고 import + 그랜터 import 통합)
"""
from __future__ import annotations

import json
import logging
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Any, Dict, List, Optional

from sqlalchemy import select, func, and_
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.accounting import Voucher, VoucherLine, VoucherStatus, TransactionType, Account
from app.models.daily_cash_report import (
    DailyCashReportConfig, DailyCashReportSnapshot,
    DEFAULT_SECTIONS, REQUIRED_SECTIONS,
)

logger = logging.getLogger(__name__)


# 현금성 자산 계정 코드 (자산 카테고리)
CASH_ACCOUNT_CODES = {"101", "103", "104"}  # 현금, 보통예금, 정기예금

# 카드 매입 비용 계정 prefix (8xx 판관비)
CARD_EXPENSE_PREFIX = "8"


async def get_or_create_config(db: AsyncSession, user_id: int) -> DailyCashReportConfig:
    """사용자별 설정 조회 — 없으면 기본값으로 생성."""
    cfg = (await db.execute(
        select(DailyCashReportConfig).where(DailyCashReportConfig.user_id == user_id)
    )).scalar_one_or_none()
    if cfg:
        return cfg
    cfg = DailyCashReportConfig(
        user_id=user_id,
        enabled=True,
        sections=json.dumps(DEFAULT_SECTIONS),
        disabled_sections="[]",
        delivery_time="09:00",
        delivery_channels='["email"]',
    )
    db.add(cfg)
    await db.commit()
    await db.refresh(cfg)
    return cfg


def _format_won(amount: Decimal | float | int) -> str:
    """금액 한국식 표기: 1,234,567원 → '1억 2,345만 6,700원' 단순화"""
    n = int(amount)
    if n >= 100_000_000:
        eok = n // 100_000_000
        man = (n % 100_000_000) // 10_000
        if man > 0:
            return f"{eok}억 {man:,}만원"
        return f"{eok}억원"
    if n >= 10_000:
        man = n // 10_000
        rest = n % 10_000
        if rest > 0:
            return f"{man:,}만 {rest:,}원"
        return f"{man:,}만원"
    return f"{n:,}원"


async def _section_cash_status(db: AsyncSession, target_date: date) -> Dict[str, Any]:
    """어제 입금·출금 + 현 시점 잔액."""
    # 어제 일자의 voucher_lines 집계 — 현금성 자산 계정
    cash_lines_q = (
        select(
            func.sum(VoucherLine.debit_amount).label("inflow"),
            func.sum(VoucherLine.credit_amount).label("outflow"),
        )
        .select_from(VoucherLine)
        .join(Voucher, VoucherLine.voucher_id == Voucher.id)
        .join(Account, VoucherLine.account_id == Account.id)
        .where(
            Voucher.status == VoucherStatus.CONFIRMED,
            Voucher.transaction_date == target_date,
            Account.code.in_(CASH_ACCOUNT_CODES),
        )
    )
    row = (await db.execute(cash_lines_q)).first()
    inflow = Decimal(str(row.inflow or 0))
    outflow = Decimal(str(row.outflow or 0))

    # 누적 잔액 (현금성 자산 — 모든 confirmed voucher line)
    balance_q = (
        select(
            func.coalesce(func.sum(VoucherLine.debit_amount - VoucherLine.credit_amount), 0)
        )
        .select_from(VoucherLine)
        .join(Voucher, VoucherLine.voucher_id == Voucher.id)
        .join(Account, VoucherLine.account_id == Account.id)
        .where(
            Voucher.status == VoucherStatus.CONFIRMED,
            Voucher.transaction_date <= target_date,
            Account.code.in_(CASH_ACCOUNT_CODES),
        )
    )
    balance = Decimal(str((await db.execute(balance_q)).scalar() or 0))

    return {
        "title": "자금 현황",
        "date": target_date.isoformat(),
        "inflow": float(inflow),
        "outflow": float(outflow),
        "net": float(inflow - outflow),
        "balance": float(balance),
        "summary": (
            f"어제 입금 {_format_won(inflow)}, 출금 {_format_won(outflow)}으로 "
            f"순 {'+' if inflow >= outflow else ''}{_format_won(inflow - outflow)} 변동했어요. "
            f"현 시점 가용자금은 {_format_won(balance)}이에요."
        ),
    }


async def _section_ai_cashflow(db: AsyncSession, target_date: date) -> Dict[str, Any]:
    """잔액 추이 + 주요 입출금 + 텍스트 요약."""
    prev_day = target_date - timedelta(days=1)
    prev_month = target_date.replace(day=1) - timedelta(days=1)
    prev_month_same = prev_month.replace(day=min(target_date.day, prev_month.day))

    async def balance_at(d: date) -> Decimal:
        q = (
            select(func.coalesce(func.sum(VoucherLine.debit_amount - VoucherLine.credit_amount), 0))
            .select_from(VoucherLine)
            .join(Voucher, VoucherLine.voucher_id == Voucher.id)
            .join(Account, VoucherLine.account_id == Account.id)
            .where(
                Voucher.status == VoucherStatus.CONFIRMED,
                Voucher.transaction_date <= d,
                Account.code.in_(CASH_ACCOUNT_CODES),
            )
        )
        return Decimal(str((await db.execute(q)).scalar() or 0))

    bal_today = await balance_at(target_date)
    bal_prev_day = await balance_at(prev_day)
    bal_prev_month = await balance_at(prev_month_same)

    delta_day = bal_today - bal_prev_day
    delta_month = bal_today - bal_prev_month

    # 어제 주요 출금 top 3 (현금성 계정에서 빠진 금액)
    out_top_q = (
        select(
            VoucherLine.counterparty_name,
            VoucherLine.description,
            func.sum(VoucherLine.credit_amount).label("amt"),
        )
        .select_from(VoucherLine)
        .join(Voucher, VoucherLine.voucher_id == Voucher.id)
        .join(Account, VoucherLine.account_id == Account.id)
        .where(
            Voucher.status == VoucherStatus.CONFIRMED,
            Voucher.transaction_date == target_date,
            Account.code.in_(CASH_ACCOUNT_CODES),
            VoucherLine.credit_amount > 0,
        )
        .group_by(VoucherLine.counterparty_name, VoucherLine.description)
        .order_by(func.sum(VoucherLine.credit_amount).desc())
        .limit(3)
    )
    out_rows = (await db.execute(out_top_q)).all()

    # 어제 주요 입금 top 3
    in_top_q = (
        select(
            VoucherLine.counterparty_name,
            VoucherLine.description,
            func.sum(VoucherLine.debit_amount).label("amt"),
        )
        .select_from(VoucherLine)
        .join(Voucher, VoucherLine.voucher_id == Voucher.id)
        .join(Account, VoucherLine.account_id == Account.id)
        .where(
            Voucher.status == VoucherStatus.CONFIRMED,
            Voucher.transaction_date == target_date,
            Account.code.in_(CASH_ACCOUNT_CODES),
            VoucherLine.debit_amount > 0,
        )
        .group_by(VoucherLine.counterparty_name, VoucherLine.description)
        .order_by(func.sum(VoucherLine.debit_amount).desc())
        .limit(3)
    )
    in_rows = (await db.execute(in_top_q)).all()

    return {
        "title": "AI 현금흐름 분석",
        "balance_trend": {
            "title": "잔액 추이",
            "balance": float(bal_today),
            "delta_day": float(delta_day),
            "delta_month": float(delta_month),
            "summary": (
                f"어제 최종 잔액은 {_format_won(bal_today)}으로, "
                f"전일 대비 {_format_won(abs(delta_day))} "
                f"{'증가' if delta_day >= 0 else '감소'}하였고, "
                f"전월 동기 대비 {_format_won(abs(delta_month))} "
                f"{'증가' if delta_month >= 0 else '감소'}했어요."
            ),
        },
        "top_movements": {
            "title": "주요 입출금 내역",
            "outflows": [
                {
                    "counterparty": r.counterparty_name or "(미지정)",
                    "description": r.description or "",
                    "amount": float(r.amt or 0),
                }
                for r in out_rows
            ],
            "inflows": [
                {
                    "counterparty": r.counterparty_name or "(미지정)",
                    "description": r.description or "",
                    "amount": float(r.amt or 0),
                }
                for r in in_rows
            ],
        },
    }


async def _section_card_spending(db: AsyncSession, target_date: date) -> Dict[str, Any]:
    """
    카드 지출 추이 + 어제 결제 + 이번달 vs 전월 동기.

    '카드 지출' 판정: voucher_line 차변 중 비용 계정(8xx 판관비/제조경비) 또는
    transaction_type=CARD 둘 중 하나로 잡음. 위하고 import는 모두 GENERAL이라
    transaction_type만으로는 부족.
    """
    month_start = target_date.replace(day=1)
    prev_month_end = month_start - timedelta(days=1)
    prev_month_start = prev_month_end.replace(day=1)
    prev_month_same_day = min(target_date.day, prev_month_end.day)
    prev_month_same = prev_month_end.replace(day=prev_month_same_day)

    def _expense_query(start: date, end: date):
        """비용 계정 차변 합계 (8xx prefix)."""
        return (
            select(func.coalesce(func.sum(VoucherLine.debit_amount), 0))
            .select_from(VoucherLine)
            .join(Voucher, VoucherLine.voucher_id == Voucher.id)
            .join(Account, VoucherLine.account_id == Account.id)
            .where(
                Voucher.status == VoucherStatus.CONFIRMED,
                Voucher.transaction_date >= start,
                Voucher.transaction_date <= end,
                Account.code.like(CARD_EXPENSE_PREFIX + '%'),
                VoucherLine.debit_amount > 0,
            )
        )

    today_total = Decimal(str((await db.execute(_expense_query(target_date, target_date))).scalar() or 0))
    month_total = Decimal(str((await db.execute(_expense_query(month_start, target_date))).scalar() or 0))
    prev_total = Decimal(str((await db.execute(_expense_query(prev_month_start, prev_month_same))).scalar() or 0))

    diff = month_total - prev_total

    # 어제 주요 비용 결제 top 5 — voucher_line 단위 (카드 + 일반 모두)
    detail_q = (
        select(
            VoucherLine.counterparty_name,
            VoucherLine.description,
            Account.name.label("account_name"),
            VoucherLine.debit_amount.label("amount"),
            Voucher.merchant_name,
        )
        .select_from(VoucherLine)
        .join(Voucher, VoucherLine.voucher_id == Voucher.id)
        .join(Account, VoucherLine.account_id == Account.id)
        .where(
            Voucher.status == VoucherStatus.CONFIRMED,
            Voucher.transaction_date == target_date,
            Account.code.like(CARD_EXPENSE_PREFIX + '%'),
            VoucherLine.debit_amount > 0,
        )
        .order_by(VoucherLine.debit_amount.desc())
        .limit(5)
    )
    detail_rows = (await db.execute(detail_q)).all()

    return {
        "title": "카드 지출 분석",
        "trend": {
            "title": "지출 추이",
            "today_total": float(today_total),
            "month_total": float(month_total),
            "prev_month_total": float(prev_total),
            "diff_vs_prev_month": float(diff),
            "summary": (
                f"어제는 총 {_format_won(today_total)}을 결제했어요. "
                f"이번달 누적 카드 사용액은 {_format_won(month_total)}으로, "
                f"전월 동기 대비 {_format_won(abs(diff))} "
                f"{'더 쓰고' if diff > 0 else '덜 쓰고'} 있어요."
            ),
        },
        "top_payments": [
            {
                "counterparty": r.counterparty_name or r.merchant_name or "(미지정)",
                "description": (r.description or r.account_name or "")[:80],
                "amount": float(r.amount or 0),
            }
            for r in detail_rows
        ],
    }


async def _section_card_usage(db: AsyncSession, target_date: date) -> Dict[str, Any]:
    """카드 사용 현황 — 비용 계정(8xx) 차변 상세 list."""
    q = (
        select(
            VoucherLine.counterparty_name,
            VoucherLine.description,
            Account.name.label("account_name"),
            VoucherLine.debit_amount.label("amount"),
            Voucher.merchant_name,
        )
        .select_from(VoucherLine)
        .join(Voucher, VoucherLine.voucher_id == Voucher.id)
        .join(Account, VoucherLine.account_id == Account.id)
        .where(
            Voucher.status == VoucherStatus.CONFIRMED,
            Voucher.transaction_date == target_date,
            Account.code.like(CARD_EXPENSE_PREFIX + '%'),
            VoucherLine.debit_amount > 0,
        )
        .order_by(VoucherLine.debit_amount.desc())
    )
    rows = (await db.execute(q)).all()
    total = sum((Decimal(str(r.amount or 0)) for r in rows), Decimal("0"))

    return {
        "title": "카드 사용 현황",
        "date": target_date.isoformat(),
        "total": float(total),
        "count": len(rows),
        "items": [
            {
                "counterparty": r.counterparty_name or r.merchant_name or "(미지정)",
                "description": (r.description or r.account_name or "")[:80],
                "amount": float(r.amount or 0),
            }
            for r in rows[:10]
        ],
        "summary": f"어제 결제 {len(rows)}건, 총 {_format_won(total)}이에요.",
    }


SECTION_GENERATORS = {
    "cash_status": _section_cash_status,
    "ai_cashflow": _section_ai_cashflow,
    "card_spending": _section_card_spending,
    "card_usage": _section_card_usage,
}


async def _latest_data_date(db: AsyncSession) -> Optional[date]:
    """가장 최근 확정 voucher의 transaction_date — 데이터 있는 날짜 자동 추적."""
    q = (
        select(func.max(Voucher.transaction_date))
        .where(Voucher.status == VoucherStatus.CONFIRMED)
    )
    return (await db.execute(q)).scalar()


async def generate_report_content(
    db: AsyncSession,
    user_id: int,
    target_date: date,
    config: Optional[DailyCashReportConfig] = None,
    auto_latest: bool = True,
) -> Dict[str, Any]:
    """사용자 설정에 따라 자금일보 콘텐츠 생성.

    auto_latest=True: target_date 기준 데이터가 없으면 가장 최근 데이터 있는 날짜로 자동 전환.
    """
    if config is None:
        config = await get_or_create_config(db, user_id)

    # target_date 자동 조정 — 그 날 voucher가 없으면 가장 최근 날짜 사용
    if auto_latest:
        has_data = (await db.execute(
            select(func.count(Voucher.id)).where(
                Voucher.status == VoucherStatus.CONFIRMED,
                Voucher.transaction_date == target_date,
            )
        )).scalar() or 0
        if not has_data:
            latest = await _latest_data_date(db)
            if latest:
                target_date = latest

    try:
        sections = json.loads(config.sections)
        disabled = set(json.loads(config.disabled_sections or "[]"))
    except (ValueError, TypeError):
        from app.models.daily_cash_report import DEFAULT_SECTIONS
        sections = DEFAULT_SECTIONS
        disabled = set()

    result = {
        "report_date": target_date.isoformat(),
        "target_date": target_date.isoformat(),
        "sections_order": sections,
        "disabled_sections": list(disabled),
        "content": {},
    }

    for section_key in sections:
        # 필수 섹션은 disabled 무시
        if section_key in disabled and section_key not in REQUIRED_SECTIONS:
            continue
        gen = SECTION_GENERATORS.get(section_key)
        if not gen:
            continue
        try:
            result["content"][section_key] = await gen(db, target_date)
        except Exception as e:
            logger.exception(f"섹션 생성 실패: {section_key}")
            result["content"][section_key] = {"error": str(e)[:200]}

    return result
