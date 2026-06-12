"""
통합 분개 쿼리 — Voucher/VoucherLine(CONFIRMED) 단일 소스.

핵심 통찰 (사용자):
"전표는 단일 데이터로 보관해야 누가 추가하든 중복·꼬임이 없다"

2026-06 단일화:
- 과거 ai_raw_transaction_data(더존 분개장 raw)는 위하고 분개장 import로
  wehago_import 전표에 전량 반영되어 있어, raw를 함께 합산하면
  2025년이 2배로 집계되는 버그가 있었다.
- 이제 모든 분석 메뉴(계정별원장·시산표·손익·BS·현금손익)는
  CONFIRMED Voucher만 본다. ai_raw_transaction_data는 분개장 업로드
  스테이징(journal_migration) 용도로만 유지.
"""
from typing import Optional, Any
from sqlalchemy import select, literal_column, func, cast, String, null

from app.models.accounting import (
    Voucher, VoucherLine, Account, VoucherStatus,
)


def unified_aggregation_subquery(
    period_start: Optional[Any] = None,
    period_end: Optional[Any] = None,
    exclude_closing: bool = False,
):
    """
    통합 거래 row 서브쿼리. 컬럼:
      transaction_date (string), source_account_code, source_account_name,
      debit_amount, credit_amount, merchant_name, description, source ('voucher')

    호출자가 .where()/.group_by() 추가해서 사용.
    Voucher는 CONFIRMED 상태만 포함.
    exclude_closing=True면 자동 마감(auto_closing) 전표 제외 —
    손익(P/L)성 보고서는 마감 대체분개가 섞이면 이중반영/상쇄되므로 켜야 함.
    """
    voucher_date_str = func.to_char(Voucher.transaction_date, 'YYYY-MM-DD')

    voucher_q = select(
        voucher_date_str.label('transaction_date'),
        Account.code.label('source_account_code'),
        Account.name.label('source_account_name'),
        VoucherLine.debit_amount.label('debit_amount'),
        VoucherLine.credit_amount.label('credit_amount'),
        VoucherLine.counterparty_name.label('merchant_name'),
        VoucherLine.description.label('description'),
        literal_column("'voucher'").label('source'),
    ).select_from(VoucherLine).join(
        Voucher, VoucherLine.voucher_id == Voucher.id
    ).join(
        Account, VoucherLine.account_id == Account.id
    ).where(
        Voucher.status == VoucherStatus.CONFIRMED,
        Account.code.isnot(None),
        Account.code != '',
    )
    if exclude_closing:
        voucher_q = voucher_q.where(
            func.coalesce(Voucher.source, '') != 'auto_closing'
        )

    if period_start:
        voucher_q = voucher_q.where(Voucher.transaction_date >= period_start)
    if period_end:
        voucher_q = voucher_q.where(Voucher.transaction_date <= period_end)

    return voucher_q.subquery('unified_txn')


def unified_rows_subquery(
    period_start: Optional[Any] = None,
    period_end: Optional[Any] = None,
    exclude_closing: bool = False,
):
    """
    행 보존용 unified — 거래 그리드(LedgerEntry) 표시용.
    집계용 컬럼 + id / row_number / 상대계정 정보 포함.

    Voucher 라인은 같은 voucher 내 다른 라인이 상대계정이라 단순히 NULL로 둠
    (UI에서 '-' 표시).
    """
    voucher_date_str = func.to_char(Voucher.transaction_date, 'YYYY-MM-DD')

    voucher_q = select(
        VoucherLine.id.label('id'),
        literal_column("'voucher'").label('source'),
        VoucherLine.line_number.label('row_number'),
        voucher_date_str.label('transaction_date'),
        Account.code.label('source_account_code'),
        Account.name.label('source_account_name'),
        cast(null(), String).label('counterparty_account_code'),
        cast(null(), String).label('counterparty_account_name'),
        VoucherLine.debit_amount.label('debit_amount'),
        VoucherLine.credit_amount.label('credit_amount'),
        VoucherLine.counterparty_name.label('merchant_name'),
        VoucherLine.description.label('description'),
        VoucherLine.voucher_id.label('voucher_id'),
    ).select_from(VoucherLine).join(
        Voucher, VoucherLine.voucher_id == Voucher.id
    ).join(
        Account, VoucherLine.account_id == Account.id
    ).where(
        Voucher.status == VoucherStatus.CONFIRMED,
        Account.code.isnot(None),
        Account.code != '',
    )
    if exclude_closing:
        voucher_q = voucher_q.where(
            func.coalesce(Voucher.source, '') != 'auto_closing'
        )
    if period_start:
        voucher_q = voucher_q.where(Voucher.transaction_date >= period_start)
    if period_end:
        voucher_q = voucher_q.where(Voucher.transaction_date <= period_end)

    return voucher_q.subquery('unified_rows')


async def has_closing_vouchers(db, period_start=None, period_end=None) -> bool:
    """기간 내 자동 마감(auto_closing) 전표 존재 여부 — 손익 이중반영 가드용."""
    q = select(func.count(Voucher.id)).where(
        Voucher.source == 'auto_closing',
        Voucher.status == VoucherStatus.CONFIRMED,
    )
    if period_start:
        q = q.where(Voucher.transaction_date >= period_start)
    if period_end:
        q = q.where(Voucher.transaction_date <= period_end)
    return bool((await db.scalar(q)) or 0)
