"""
통합 분개 쿼리 — ai_raw_transaction_data + Voucher/VoucherLine을
한 모양으로 합쳐서 분석 메뉴에 제공.

핵심 통찰 (사용자):
"전표는 단일 데이터로 보관해야 누가 추가하든 중복·꼬임이 없다"

현재 두 소스 공존:
- ai_raw_transaction_data: 더존 분개장 엑셀 업로드 결과 (과거 데이터)
- Voucher + VoucherLine: 자동 후보 확정·수기 입력 (현재·미래 데이터)

이 둘을 `source_account_code` 기준 분리 row 형태로 통일해서
현금주의 손익·재무보고서·계정별 원장 등 모든 분석 메뉴가 단일 진실을 본다.
"""
from typing import Optional, Any
from sqlalchemy import select, union_all, literal_column, func, cast, String, and_

from app.models.accounting import (
    Voucher, VoucherLine, Account, VoucherStatus,
)
from app.models.ai import AIRawTransactionData


def unified_aggregation_subquery(
    period_start: Optional[Any] = None,
    period_end: Optional[Any] = None,
):
    """
    통합 거래 row 서브쿼리. 컬럼:
      transaction_date (string), source_account_code, source_account_name,
      debit_amount, credit_amount, merchant_name, description, source ('raw'|'voucher')

    호출자가 .where()/.group_by() 추가해서 사용.

    날짜 필터: 두 소스 모두 ISO 정규화(YYYY-MM-DD) 후 비교.
    Voucher는 CONFIRMED 상태만 포함.
    """
    norm_raw_date = func.replace(AIRawTransactionData.transaction_date, '.', '-')

    raw_q = select(
        norm_raw_date.label('transaction_date'),
        AIRawTransactionData.source_account_code.label('source_account_code'),
        AIRawTransactionData.source_account_name.label('source_account_name'),
        AIRawTransactionData.debit_amount.label('debit_amount'),
        AIRawTransactionData.credit_amount.label('credit_amount'),
        AIRawTransactionData.merchant_name.label('merchant_name'),
        AIRawTransactionData.original_description.label('description'),
        literal_column("'raw'").label('source'),
    ).where(
        AIRawTransactionData.source_account_code.isnot(None),
        AIRawTransactionData.source_account_code != '',
    )

    if period_start:
        s = period_start.strftime('%Y-%m-%d') if hasattr(period_start, 'strftime') else str(period_start)
        raw_q = raw_q.where(norm_raw_date >= s)
    if period_end:
        from datetime import timedelta
        e = (period_end + timedelta(days=1)).strftime('%Y-%m-%d') if hasattr(period_end, 'strftime') else str(period_end)
        raw_q = raw_q.where(norm_raw_date < e)

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

    if period_start:
        voucher_q = voucher_q.where(Voucher.transaction_date >= period_start)
    if period_end:
        voucher_q = voucher_q.where(Voucher.transaction_date <= period_end)

    return union_all(raw_q, voucher_q).subquery('unified_txn')
