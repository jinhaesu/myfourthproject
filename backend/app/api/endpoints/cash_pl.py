"""
Cash-Basis P&L API — 현금주의 손익 분석
AI 분류 메뉴에 업로드된 거래(ai_raw_transaction_data)에서
계정코드 첫 자리로 매출/원가/판관비/영업외를 자동 분류해 손익 집계.

데이터 소스: ai_raw_transaction_data
- 4xx: revenue, 5xx: cogs, 6xx/7xx: 제조원가(cogs로 합산), 8xx: opex, 9xx: non_operating
"""
import re
from collections import defaultdict
from datetime import date, timedelta
from decimal import Decimal
from typing import Optional, List, Dict, Any
from fastapi import APIRouter, Depends, Query
from sqlalchemy import select, func, and_, or_
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.models.ai import AIRawTransactionData
from app.schemas.cash_pl import (
    CashPLRequest,
    CashPLResponse,
    CashPLPeriodSummary,
    CashPLLineItem,
    CashPLComparisonResponse,
    PeriodType,
    BasisType,
)

router = APIRouter()


def _strip_code(code: Optional[str]) -> str:
    if not code:
        return '0'
    return code.lstrip('0') or '0'


# 이름 키워드 기반 분류 (가장 강한 신호)
_NAME_RULES = [
    # 매출원가 키워드 (가장 우선 — 매출보다 강함)
    (('매출원가', '제조원가', '상품매출원가', '제품매출원가', '용역매출원가'), 'cogs'),
    # 영업외 (특정 키워드)
    (('이자수익', '이자비용', '외환차익', '외환차손', '외화환산이익', '외화환산손실',
      '잡이익', '잡손실', '유형자산처분', '무형자산처분', '기부금', '재해손실'), 'non_operating'),
    # 매출
    (('상품매출', '제품매출', '용역매출', '공사매출', '임대료수익', '수출매출'), 'revenue'),
]


def _category_of(code: Optional[str], name: str = '') -> str:
    """
    카테고리 분류:
      asset / liability / equity / revenue / cogs / opex / non_operating

    우선순위: 이름 키워드 → 코드 세분화 (4xx 중 45x~49x는 cogs)
    """
    n = (name or '').strip()

    # 1) 이름 우선
    for keywords, cat in _NAME_RULES:
        if any(k in n for k in keywords):
            return cat

    # 2) 코드 기반
    s = _strip_code(code)
    first = s[0] if s else '0'

    if first == '4':
        # 4xx 세분화: 45x~49x는 cogs(매출원가), 40x~44x는 revenue
        if len(s) >= 2 and s[1] in ('5', '6', '7', '8', '9'):
            return 'cogs'
        return 'revenue'

    if first == '9':
        # 9xx은 일반적으로 영업외 — 이름에 '비용'이 있어도 non_operating
        return 'non_operating'

    return {
        '1': 'asset',
        '2': 'liability',
        '3': 'equity',
        '5': 'cogs',
        '6': 'cogs',
        '7': 'cogs',
        '8': 'opex',
    }.get(first, 'opex')


def _is_non_operating_income(code: Optional[str], name: str = '') -> bool:
    """영업외 중에서 '수익'성인지 (이자수익, 잡이익 등)"""
    n = (name or '').strip()
    return any(k in n for k in ('수익', '이익', '환입'))


def _date_filters(period_start: Optional[date], period_end: Optional[date]):
    """
    transaction_date 형식이 'YYYY-MM-DD' 또는 'YYYY.MM.DD' 섞여 있어도 안전 비교.
    이전 OR 패턴(>= s OR >= s2)은 ASCII '-'(0x2D) < '.'(0x2E)이라
    'YYYY-MM-DD' 데이터가 '< YYYY.MM.DD' 끝 조건에 항상 True가 되어
    미래 데이터까지 포함시키는 치명적 버그가 있었음.
    → func.replace로 '.'를 '-'로 정규화한 후 ISO 형식과 비교.
    """
    filters = []
    norm_date = func.replace(AIRawTransactionData.transaction_date, '.', '-')
    if period_start:
        s = period_start.strftime('%Y-%m-%d')
        filters.append(norm_date >= s)
    if period_end:
        e_next = (period_end + timedelta(days=1)).strftime('%Y-%m-%d')
        filters.append(norm_date < e_next)
    return filters


def _extract_month_key(date_str: Optional[str]) -> Optional[str]:
    if not date_str:
        return None
    m = re.match(r'(\d{4})[.\-/](\d{1,2})', date_str.strip())
    if m:
        return f"{m.group(1)}-{int(m.group(2)):02d}"
    return None


async def _aggregate_by_category(
    db: AsyncSession,
    period_start: date,
    period_end: date,
) -> Dict[str, Decimal]:
    """
    기간 내 카테고리별 합계.

    분류는 코드 + 계정명으로 결정 (_category_of):
    - revenue: 401, 404 등 매출 계정
    - cogs: 45x~49x, 5xx, 6xx, 7xx (매출원가/제조원가) 또는 이름에 '매출원가'
    - opex: 8xx (판관비)
    - non_operating: 9xx 또는 이자수익/이자비용/외환 등
    """
    rows = (await db.execute(
        select(
            AIRawTransactionData.source_account_code,
            func.max(AIRawTransactionData.source_account_name).label('name'),
            func.coalesce(func.sum(AIRawTransactionData.debit_amount), 0).label('debit'),
            func.coalesce(func.sum(AIRawTransactionData.credit_amount), 0).label('credit'),
        )
        .where(
            AIRawTransactionData.source_account_code.isnot(None),
            AIRawTransactionData.source_account_code != '',
            *_date_filters(period_start, period_end),
        )
        .group_by(AIRawTransactionData.source_account_code)
    )).all()

    totals = defaultdict(lambda: Decimal('0'))
    nop_income = Decimal('0')
    nop_expense = Decimal('0')

    for r in rows:
        cat = _category_of(r.source_account_code, r.name)
        debit = Decimal(str(r.debit or 0))
        credit = Decimal(str(r.credit or 0))
        if cat == 'revenue':
            totals['revenue'] += credit - debit
        elif cat == 'cogs':
            totals['cogs'] += debit - credit
        elif cat == 'opex':
            totals['opex'] += debit - credit
        elif cat == 'non_operating':
            # 영업외 수익/비용 분리
            if _is_non_operating_income(r.source_account_code, r.name):
                nop_income += credit - debit
            else:
                nop_expense += debit - credit

    totals['non_operating_income'] = nop_income
    totals['non_operating_expense'] = nop_expense
    # 기존 코드 호환: non_operating은 비용성으로
    totals['non_operating'] = nop_expense
    return totals


def _build_summary(start: date, end: date, label: str, totals: Dict[str, Decimal]) -> CashPLPeriodSummary:
    revenue = totals.get('revenue', Decimal('0'))
    cogs = totals.get('cogs', Decimal('0'))
    opex = totals.get('opex', Decimal('0'))
    nop_income = totals.get('non_operating_income', Decimal('0'))
    nop_expense = totals.get('non_operating_expense', Decimal('0'))

    gross = revenue - cogs
    op = gross - opex
    net = op + nop_income - nop_expense

    def pct(numerator: Decimal) -> float:
        if revenue == 0:
            return 0.0
        return float(numerator / revenue * 100)

    return CashPLPeriodSummary(
        period_label=label,
        period_start=start,
        period_end=end,
        revenue=revenue,
        cogs=cogs,
        gross_profit=gross,
        gross_margin_pct=pct(gross),
        opex=opex,
        operating_profit=op,
        operating_margin_pct=pct(op),
        non_operating_income=nop_income,
        non_operating_expense=nop_expense,
        net_profit=net,
        net_margin_pct=pct(net),
    )


# ============ Snapshot (대시보드 카드용) ============

@router.get("/snapshot")
async def get_quick_snapshot(
    db: AsyncSession = Depends(get_db),
):
    """
    당월 vs 전월 매출/영업이익 빠른 스냅샷.
    실제 ai_raw_transaction_data를 집계하여 반환.
    """
    today = date.today()
    this_month_start = today.replace(day=1)
    last_month_end = this_month_start - timedelta(days=1)
    last_month_start = last_month_end.replace(day=1)
    this_month_end = today

    last_year_start = this_month_start.replace(year=this_month_start.year - 1)
    last_year_end = this_month_end.replace(year=this_month_end.year - 1)

    this_totals = await _aggregate_by_category(db, this_month_start, this_month_end)
    last_totals = await _aggregate_by_category(db, last_month_start, last_month_end)
    yoy_totals = await _aggregate_by_category(db, last_year_start, last_year_end)

    this_summary = _build_summary(this_month_start, this_month_end,
                                  this_month_start.strftime('%Y-%m'), this_totals)
    last_summary = _build_summary(last_month_start, last_month_end,
                                  last_month_start.strftime('%Y-%m'), last_totals)
    yoy_summary = _build_summary(last_year_start, last_year_end,
                                 last_year_start.strftime('%Y-%m'), yoy_totals)

    def safe_pct(curr: Decimal, prev: Decimal) -> float:
        if prev == 0:
            return 0.0
        return float((curr - prev) / abs(prev) * 100)

    return {
        "this_month": {
            "revenue": str(this_summary.revenue),
            "cogs": str(this_summary.cogs),
            "operating_profit": str(this_summary.operating_profit),
            "net_profit": str(this_summary.net_profit),
            "operating_margin_pct": this_summary.operating_margin_pct,
        },
        "last_month": {
            "revenue": str(last_summary.revenue),
            "operating_profit": str(last_summary.operating_profit),
            "operating_margin_pct": last_summary.operating_margin_pct,
        },
        "yoy": {
            "revenue_pct": safe_pct(this_summary.revenue, yoy_summary.revenue),
            "operating_profit_pct": safe_pct(this_summary.operating_profit, yoy_summary.operating_profit),
        },
    }


# ============ Main P&L ============

@router.post("/", response_model=CashPLResponse)
async def get_cash_pl(
    req: CashPLRequest,
    db: AsyncSession = Depends(get_db),
):
    """
    현금주의 손익 — 기간별 시계열 + 라인 아이템.
    monthly만 우선 지원. weekly/daily/quarterly/yearly는 추후 보강.
    """
    summaries: List[CashPLPeriodSummary] = []

    if req.period_type == 'monthly':
        cur = req.from_date.replace(day=1)
        while cur <= req.to_date:
            next_month = (cur.replace(day=28) + timedelta(days=4)).replace(day=1)
            period_end = min(next_month - timedelta(days=1), req.to_date)
            totals = await _aggregate_by_category(db, cur, period_end)
            summaries.append(_build_summary(cur, period_end, cur.strftime('%Y-%m'), totals))
            cur = next_month

    elif req.period_type == 'quarterly':
        # 분기 시작월 (1, 4, 7, 10)
        q_month = ((req.from_date.month - 1) // 3) * 3 + 1
        cur = date(req.from_date.year, q_month, 1)
        while cur <= req.to_date:
            q_end_month = q_month + 2
            q_end = (date(cur.year, q_end_month, 28) + timedelta(days=4)).replace(day=1) - timedelta(days=1)
            period_end = min(q_end, req.to_date)
            totals = await _aggregate_by_category(db, cur, period_end)
            q_label = f"{cur.year}-Q{(q_month - 1) // 3 + 1}"
            summaries.append(_build_summary(cur, period_end, q_label, totals))
            # 다음 분기
            q_month += 3
            if q_month > 12:
                q_month = 1
                cur = date(cur.year + 1, 1, 1)
            else:
                cur = date(cur.year, q_month, 1)

    elif req.period_type == 'yearly':
        cur = date(req.from_date.year, 1, 1)
        while cur <= req.to_date:
            year_end = date(cur.year, 12, 31)
            period_end = min(year_end, req.to_date)
            totals = await _aggregate_by_category(db, cur, period_end)
            summaries.append(_build_summary(cur, period_end, str(cur.year), totals))
            cur = date(cur.year + 1, 1, 1)

    elif req.period_type == 'weekly':
        # 월요일 시작 주
        cur = req.from_date - timedelta(days=req.from_date.weekday())
        while cur <= req.to_date:
            week_end = cur + timedelta(days=6)
            period_end = min(week_end, req.to_date)
            iso = cur.isocalendar()
            label = f"{iso[0]}-W{iso[1]:02d}"
            totals = await _aggregate_by_category(db, cur, period_end)
            summaries.append(_build_summary(cur, period_end, label, totals))
            cur = cur + timedelta(days=7)

    elif req.period_type == 'daily':
        cur = req.from_date
        while cur <= req.to_date:
            totals = await _aggregate_by_category(db, cur, cur)
            summaries.append(_build_summary(cur, cur, cur.strftime('%m-%d'), totals))
            cur = cur + timedelta(days=1)

    else:
        totals = await _aggregate_by_category(db, req.from_date, req.to_date)
        summaries.append(_build_summary(
            req.from_date, req.to_date, f"{req.from_date} ~ {req.to_date}", totals
        ))

    # Line items (전 기간 합계, 계정별)
    rows = (await db.execute(
        select(
            AIRawTransactionData.source_account_code,
            func.max(AIRawTransactionData.source_account_name).label('name'),
            func.coalesce(func.sum(AIRawTransactionData.debit_amount), 0).label('debit'),
            func.coalesce(func.sum(AIRawTransactionData.credit_amount), 0).label('credit'),
        )
        .where(
            AIRawTransactionData.source_account_code.isnot(None),
            AIRawTransactionData.source_account_code != '',
            *_date_filters(req.from_date, req.to_date),
        )
        .group_by(AIRawTransactionData.source_account_code)
    )).all()

    total_revenue = sum(s.revenue for s in summaries) or Decimal('1')
    line_items: List[CashPLLineItem] = []
    for r in rows:
        cat = _category_of(r.source_account_code, r.name)
        if cat in ('asset', 'liability', 'equity'):
            continue
        debit = Decimal(str(r.debit or 0))
        credit = Decimal(str(r.credit or 0))
        if cat == 'revenue':
            amt = credit - debit
        elif cat == 'non_operating':
            # 영업외수익/비용 둘 다 non_operating 카테고리로 묶음
            amt = (credit - debit) if _is_non_operating_income(r.source_account_code, r.name) else (debit - credit)
        else:
            amt = debit - credit
        line_items.append(CashPLLineItem(
            account_code=r.source_account_code,
            account_name=r.name or f"계정 {_strip_code(r.source_account_code)}",
            category=cat,  # type: ignore[arg-type]
            amount=amt,
            pct_of_revenue=float(amt / total_revenue * 100) if total_revenue else 0.0,
        ))
    line_items.sort(key=lambda x: -abs(float(x.amount)))

    return CashPLResponse(
        basis=req.basis,
        period_type=req.period_type,
        summaries=summaries,
        line_items=line_items,
        cash_vs_accrual_diff=None,
        generated_at=date.today(),
    )


# ============ 계정별 기간 cross-tab (재무보고서 펼치기용) ============

async def _aggregate_by_account_in_period(
    db: AsyncSession,
    period_start: date,
    period_end: date,
) -> Dict[str, Dict[str, Any]]:
    """
    기간 내 source_account_code별 합계.
    Returns: { code: { name, category, amount } }
    amount: 카테고리에 따라 부호 적용된 값
    """
    rows = (await db.execute(
        select(
            AIRawTransactionData.source_account_code,
            func.max(AIRawTransactionData.source_account_name).label('name'),
            func.coalesce(func.sum(AIRawTransactionData.debit_amount), 0).label('debit'),
            func.coalesce(func.sum(AIRawTransactionData.credit_amount), 0).label('credit'),
        )
        .where(
            AIRawTransactionData.source_account_code.isnot(None),
            AIRawTransactionData.source_account_code != '',
            *_date_filters(period_start, period_end),
        )
        .group_by(AIRawTransactionData.source_account_code)
    )).all()

    out = {}
    for r in rows:
        cat = _category_of(r.source_account_code, r.name)
        if cat in ('asset', 'liability', 'equity'):
            continue
        debit = Decimal(str(r.debit or 0))
        credit = Decimal(str(r.credit or 0))
        if cat == 'revenue':
            amt = credit - debit
        elif cat == 'non_operating':
            amt = (credit - debit) if _is_non_operating_income(r.source_account_code, r.name) else (debit - credit)
        else:
            amt = debit - credit
        out[r.source_account_code] = {
            "code": r.source_account_code,
            "name": r.name or f"계정 {_strip_code(r.source_account_code)}",
            "category": cat,
            "amount": amt,
        }
    return out


@router.post("/by-account-cross-tab")
async def get_by_account_cross_tab(req: CashPLRequest, db: AsyncSession = Depends(get_db)):
    """
    재무보고서 판관비 등 펼치기용 — 계정 × 기간 cross-tab.

    Returns:
    {
      "periods": [{label, start, end}, ...],
      "accounts": {
        "revenue":   [{code, name, values: [...], total}],
        "cogs":      [...],
        "opex":      [...],   # 판관비 — 펼치기 대상
        "non_operating": [...],
      }
    }
    """
    # 기간 분할 (monthly 기본)
    periods: List[Dict[str, Any]] = []

    if req.period_type == 'monthly':
        cur = req.from_date.replace(day=1)
        while cur <= req.to_date:
            next_month = (cur.replace(day=28) + timedelta(days=4)).replace(day=1)
            period_end = min(next_month - timedelta(days=1), req.to_date)
            periods.append({
                "label": cur.strftime('%Y-%m'),
                "start": cur,
                "end": period_end,
            })
            cur = next_month
    elif req.period_type == 'quarterly':
        q_month = ((req.from_date.month - 1) // 3) * 3 + 1
        cur = date(req.from_date.year, q_month, 1)
        while cur <= req.to_date:
            q_end = (date(cur.year, q_month + 2, 28) + timedelta(days=4)).replace(day=1) - timedelta(days=1)
            period_end = min(q_end, req.to_date)
            periods.append({
                "label": f"{cur.year}-Q{(q_month - 1) // 3 + 1}",
                "start": cur,
                "end": period_end,
            })
            q_month += 3
            if q_month > 12:
                q_month = 1
                cur = date(cur.year + 1, 1, 1)
            else:
                cur = date(cur.year, q_month, 1)
    elif req.period_type == 'yearly':
        cur = date(req.from_date.year, 1, 1)
        while cur <= req.to_date:
            year_end = date(cur.year, 12, 31)
            periods.append({
                "label": str(cur.year),
                "start": cur,
                "end": min(year_end, req.to_date),
            })
            cur = date(cur.year + 1, 1, 1)
    else:
        periods.append({
            "label": f"{req.from_date} ~ {req.to_date}",
            "start": req.from_date,
            "end": req.to_date,
        })

    # 각 기간별로 계정 합계 집계
    by_account_period: Dict[str, Dict[str, Decimal]] = {}  # {code: {period_label: amount}}
    account_meta: Dict[str, Dict[str, Any]] = {}  # {code: {name, category}}

    for p in periods:
        agg = await _aggregate_by_account_in_period(db, p["start"], p["end"])
        for code, info in agg.items():
            account_meta.setdefault(code, {"name": info["name"], "category": info["category"]})
            by_account_period.setdefault(code, {})[p["label"]] = info["amount"]

    # 카테고리별로 그룹핑
    grouped: Dict[str, List[Dict[str, Any]]] = {
        "revenue": [],
        "cogs": [],
        "opex": [],
        "non_operating": [],
    }
    for code, meta in account_meta.items():
        cat = meta["category"]
        if cat not in grouped:
            continue
        values = [
            float(by_account_period.get(code, {}).get(p["label"], Decimal("0")))
            for p in periods
        ]
        total = sum(values)
        grouped[cat].append({
            "code": code,
            "name": meta["name"],
            "values": values,
            "total": total,
        })
        # 큰 금액 순으로 정렬
        grouped[cat].sort(key=lambda x: -abs(x["total"]))

    return {
        "periods": [{"label": p["label"], "start": p["start"].isoformat(), "end": p["end"].isoformat()} for p in periods],
        "accounts": grouped,
    }


# ============ Comparison (현금주의 vs 발생주의) ============

@router.get("/comparison", response_model=CashPLComparisonResponse)
async def compare_cash_vs_accrual(
    from_date: date,
    to_date: date,
    db: AsyncSession = Depends(get_db),
):
    """
    현금주의 vs 발생주의 비교.
    현재는 현금주의 데이터만 있으므로 동일 값 반환 — 발생주의 데이터 적재 후 보강.
    """
    totals = await _aggregate_by_category(db, from_date, to_date)
    label = f"{from_date} ~ {to_date}"
    cash = _build_summary(from_date, to_date, label, totals)
    # TODO: 발생주의는 tax_invoice 등에서 별도 집계
    accrual = _build_summary(from_date, to_date, label, totals)

    diff = {
        "revenue": float(cash.revenue - accrual.revenue),
        "cogs": float(cash.cogs - accrual.cogs),
        "operating_profit": float(cash.operating_profit - accrual.operating_profit),
        "net_profit": float(cash.net_profit - accrual.net_profit),
    }
    return CashPLComparisonResponse(
        period_label=label,
        cash_basis=cash,
        accrual_basis=accrual,
        difference_summary=diff,
    )
