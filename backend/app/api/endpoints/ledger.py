"""
Account Ledger API — 계정별 원장 (총계정원장)
데이터 소스: unified_ledger (CONFIRMED Voucher 단일 소스)
- source_account_code/source_account_name: 원장 계정 (좌측 리스트)
- merchant_name: 거래처 (상대계정 컬럼)
"""
import re
from datetime import date, timedelta
from decimal import Decimal
from typing import Optional, List, Any
from fastapi import APIRouter, Depends, Query, HTTPException
from sqlalchemy import select, func, and_, or_
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.account_category import (
    categorize_coarse,
    strip_code,
    CATEGORY_LABEL,
)
from app.models.ai import AIRawTransactionData
from app.schemas.ledger import (
    LedgerAccount,
    LedgerAccountTreeNode,
    LedgerEntry,
    LedgerSummary,
    LedgerEntriesResponse,
    LedgerEntryUpdate,
    AccountCategory,
)

router = APIRouter()

# ============ 카테고리 분류 (공유 모듈 위임) ============
# categorize_coarse  : cogs/opex → 'expense'로 통합 (원장 용도)
# strip_code         : 코드 앞 0 제거
# CATEGORY_LABEL     : 카테고리 → 한글 표시명 (expense:'비용' 포함)


# ============ 진단용 ============

@router.get("/diag")
async def diagnose(
    sample_account_code: Optional[str] = None,
    sample_size: int = 5,
    db: AsyncSession = Depends(get_db),
):
    """
    원장 데이터 상태 진단 — 차변/대변 mismatch 등 검증용.

    sample_account_code 지정 시 해당 계정의 raw 데이터 + 차변/대변 합계 + 중복 후보 반환.
    """
    from app.models.ai import AIDataUploadHistory

    total = await db.scalar(select(func.count(AIRawTransactionData.id))) or 0
    with_source = await db.scalar(
        select(func.count(AIRawTransactionData.id)).where(
            AIRawTransactionData.source_account_code.isnot(None),
            AIRawTransactionData.source_account_code != '',
        )
    ) or 0
    distinct_accounts = await db.scalar(
        select(func.count(func.distinct(AIRawTransactionData.source_account_code))).where(
            AIRawTransactionData.source_account_code.isnot(None),
            AIRawTransactionData.source_account_code != '',
        )
    ) or 0
    min_date = await db.scalar(select(func.min(AIRawTransactionData.transaction_date)))
    max_date = await db.scalar(select(func.max(AIRawTransactionData.transaction_date)))

    # 업로드별 행 수 (최근 20개) — 중복 업로드 즉시 감지
    upload_rows = (await db.execute(
        select(
            AIRawTransactionData.upload_id,
            func.count(AIRawTransactionData.id).label('cnt'),
            func.coalesce(func.sum(AIRawTransactionData.debit_amount), 0).label('debit'),
            func.coalesce(func.sum(AIRawTransactionData.credit_amount), 0).label('credit'),
        ).group_by(AIRawTransactionData.upload_id).order_by(AIRawTransactionData.upload_id.desc()).limit(20)
    )).all()

    # 업로드 history join (filename, created_at)
    upload_ids = [u.upload_id for u in upload_rows if u.upload_id is not None]
    history_map = {}
    if upload_ids:
        hist_rows = (await db.execute(
            select(AIDataUploadHistory).where(AIDataUploadHistory.id.in_(upload_ids))
        )).scalars().all()
        history_map = {
            h.id: {
                "filename": h.filename,
                "created_at": h.created_at.isoformat() if h.created_at else None,
                "status": h.status.value if hasattr(h.status, 'value') else str(h.status),
            }
            for h in hist_rows
        }

    # 업로드별 날짜 범위 + 계정 분포
    upload_date_rows = (await db.execute(
        select(
            AIRawTransactionData.upload_id,
            func.min(AIRawTransactionData.transaction_date).label('min_d'),
            func.max(AIRawTransactionData.transaction_date).label('max_d'),
            func.count(func.distinct(AIRawTransactionData.source_account_code)).label('accts'),
        ).group_by(AIRawTransactionData.upload_id)
    )).all()
    date_range_map = {
        d.upload_id: {"min_date": d.min_d, "max_date": d.max_d, "distinct_accounts": d.accts}
        for d in upload_date_rows
    }

    uploads_breakdown = [
        {
            "upload_id": u.upload_id,
            "rows": u.cnt,
            "debit_sum": float(u.debit or 0),
            "credit_sum": float(u.credit or 0),
            **(history_map.get(u.upload_id, {})),
            **(date_range_map.get(u.upload_id, {})),
        }
        for u in upload_rows
    ]

    # 날짜 형식 분포 — 'YYYY-MM-DD'(10자) 정상, 그 외는 비정상 후보
    date_len_rows = (await db.execute(
        select(
            func.length(AIRawTransactionData.transaction_date).label('len'),
            func.count(AIRawTransactionData.id).label('cnt'),
        ).where(AIRawTransactionData.transaction_date.isnot(None))
        .group_by(func.length(AIRawTransactionData.transaction_date))
        .order_by(func.length(AIRawTransactionData.transaction_date))
    )).all()
    date_length_distribution = [
        {"len": r.len, "rows": r.cnt}
        for r in date_len_rows
    ]

    # 샘플 row (DB raw 그대로 — 더존 원본과 직접 비교용)
    sample_q = select(AIRawTransactionData)
    if sample_account_code:
        sample_q = sample_q.where(
            AIRawTransactionData.source_account_code == sample_account_code
        )
    sample_q = sample_q.order_by(AIRawTransactionData.id.asc()).limit(sample_size)
    sample_rows = (await db.execute(sample_q)).scalars().all()

    samples = [
        {
            "id": r.id,
            "upload_id": r.upload_id,
            "row_number": r.row_number,
            "transaction_date": r.transaction_date,
            "description": r.original_description,
            "merchant_name": r.merchant_name,
            "source_account_code": r.source_account_code,
            "source_account_name": r.source_account_name,
            "account_code": r.account_code,
            "account_name": r.account_name,
            "debit_amount": float(r.debit_amount or 0),
            "credit_amount": float(r.credit_amount or 0),
            "amount": float(r.amount or 0),
        }
        for r in sample_rows
    ]

    # 특정 계정 선택 시: 차변/대변 합계 + 중복 후보
    account_totals = None
    duplicate_candidates: list = []
    if sample_account_code:
        totals_row = (await db.execute(
            select(
                func.coalesce(func.sum(AIRawTransactionData.debit_amount), 0).label('debit'),
                func.coalesce(func.sum(AIRawTransactionData.credit_amount), 0).label('credit'),
                func.count(AIRawTransactionData.id).label('cnt'),
            ).where(AIRawTransactionData.source_account_code == sample_account_code)
        )).one()
        account_totals = {
            "account_code": sample_account_code,
            "total_rows": totals_row.cnt,
            "debit_sum": float(totals_row.debit or 0),
            "credit_sum": float(totals_row.credit or 0),
            "diff": float((totals_row.debit or 0) - (totals_row.credit or 0)),
        }

        # 중복 후보: 동일 (날짜, 차변, 대변, 거래처, 적요) 가 2회 이상 등장
        dup_rows = (await db.execute(
            select(
                AIRawTransactionData.transaction_date,
                AIRawTransactionData.debit_amount,
                AIRawTransactionData.credit_amount,
                AIRawTransactionData.merchant_name,
                AIRawTransactionData.original_description,
                func.count(AIRawTransactionData.id).label('cnt'),
                func.array_agg(AIRawTransactionData.upload_id).label('upload_ids'),
            ).where(AIRawTransactionData.source_account_code == sample_account_code)
            .group_by(
                AIRawTransactionData.transaction_date,
                AIRawTransactionData.debit_amount,
                AIRawTransactionData.credit_amount,
                AIRawTransactionData.merchant_name,
                AIRawTransactionData.original_description,
            ).having(func.count(AIRawTransactionData.id) > 1)
            .order_by(func.count(AIRawTransactionData.id).desc())
            .limit(20)
        )).all()
        duplicate_candidates = [
            {
                "transaction_date": d.transaction_date,
                "debit": float(d.debit_amount or 0),
                "credit": float(d.credit_amount or 0),
                "merchant": d.merchant_name,
                "description": d.original_description[:80] if d.original_description else None,
                "occurrences": d.cnt,
                "upload_ids": list(set(d.upload_ids)) if d.upload_ids else [],
            }
            for d in dup_rows
        ]

    # source_account_code별 row 수 (상위 20개)
    by_account = (await db.execute(
        select(
            AIRawTransactionData.source_account_code,
            func.max(AIRawTransactionData.source_account_name).label('name'),
            func.count(AIRawTransactionData.id).label('cnt'),
        )
        .where(
            AIRawTransactionData.source_account_code.isnot(None),
            AIRawTransactionData.source_account_code != '',
        )
        .group_by(AIRawTransactionData.source_account_code)
        .order_by(func.count(AIRawTransactionData.id).desc())
        .limit(20)
    )).all()

    return {
        "total_rows": total,
        "rows_with_source_account": with_source,
        "distinct_source_accounts": distinct_accounts,
        "earliest_transaction_date": min_date,
        "latest_transaction_date": max_date,
        "uploads_breakdown": uploads_breakdown,
        "date_length_distribution": date_length_distribution,
        "top_accounts_by_volume": [
            {"code": a.source_account_code, "name": a.name, "count": a.cnt}
            for a in by_account
        ],
        "samples": samples,
        "samples_for_account": sample_account_code,
        "account_totals": account_totals,
        "duplicate_candidates": duplicate_candidates,
    }


@router.get("/years")
async def get_available_years(db: AsyncSession = Depends(get_db)):
    """
    데이터에 존재하는 회계연도 목록 — CONFIRMED Voucher 기준.
    프론트에서 가장 최신 년도를 default로 사용하도록 활용.
    """
    from app.models.accounting import Voucher, VoucherStatus
    from sqlalchemy import extract

    year_rows = (await db.execute(
        select(func.extract('year', Voucher.transaction_date).label('yr'))
        .where(
            Voucher.status == VoucherStatus.CONFIRMED,
            Voucher.transaction_date.isnot(None),
        )
        .distinct()
        .order_by(func.extract('year', Voucher.transaction_date).desc())
    )).all()

    years_list = [int(r.yr) for r in year_rows if r.yr is not None]
    return {
        "years": years_list,
        "latest": years_list[0] if years_list else None,
    }


def _date_to_iso(s: Optional[str]) -> Optional[str]:
    """업로드 데이터의 transaction_date(string) → ISO yyyy-mm-dd로 정규화"""
    if not s:
        return None
    s = s.strip()
    m = re.match(r'(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})', s)
    if m:
        y, mo, d = m.groups()
        return f"{int(y):04d}-{int(mo):02d}-{int(d):02d}"
    return None


def _signed_change(category: str, debit: Decimal, credit: Decimal) -> Decimal:
    """카테고리별 변동 부호: 자산·비용은 debit-credit, 그 외는 credit-debit"""
    if category in ('asset', 'expense'):
        return debit - credit
    return credit - debit


# ============ 계정 리스트 (좌측 사이드바) ============

@router.get("/accounts", response_model=List[LedgerAccount])
async def list_accounts(
    fiscal_year: Optional[int] = None,
    period_start: Optional[date] = None,
    period_end: Optional[date] = None,
    category: Optional[AccountCategory] = None,
    only_with_activity: bool = False,
    search: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
):
    """
    계정과목 리스트 — source_account_code 기준 GROUP BY.
    CONFIRMED Voucher 단일 소스(unified_aggregation_subquery).
    """
    from app.services.unified_ledger import unified_aggregation_subquery

    # fiscal_year → period 변환
    if fiscal_year and not period_start and not period_end:
        period_start = date(fiscal_year, 1, 1)
        period_end = date(fiscal_year, 12, 31)

    sub = unified_aggregation_subquery(period_start, period_end)

    q = select(
        sub.c.source_account_code,
        func.max(sub.c.source_account_name).label('name'),
        func.coalesce(func.sum(sub.c.debit_amount), 0).label('debit'),
        func.coalesce(func.sum(sub.c.credit_amount), 0).label('credit'),
        func.count().label('cnt'),
    ).group_by(sub.c.source_account_code)

    if search:
        like = f"%{search}%"
        q = q.where(or_(
            sub.c.source_account_code.like(like),
            sub.c.source_account_name.like(like),
        ))

    result = await db.execute(q)
    rows = result.all()

    accounts: List[LedgerAccount] = []
    for r in rows:
        cat = categorize_coarse(r.source_account_code, r.name)
        if category and cat != category:
            continue
        debit = Decimal(str(r.debit or 0))
        credit = Decimal(str(r.credit or 0))
        change = _signed_change(cat, debit, credit)
        if only_with_activity and r.cnt == 0:
            continue
        accounts.append(LedgerAccount(
            account_code=r.source_account_code,
            account_name=r.name or f"계정 {strip_code(r.source_account_code)}",
            category=cat,  # type: ignore[arg-type]
            parent_code=None,
            depth=0,
            period_debit=debit,
            period_credit=credit,
            period_change=change,
            closing_balance=change,  # 기초 0 가정 (기간 합계만 표시)
            transaction_count=r.cnt,
            has_children=False,
        ))

    accounts.sort(key=lambda a: (a.category, strip_code(a.account_code)))
    return accounts


@router.get("/accounts/tree", response_model=List[LedgerAccountTreeNode])
async def get_account_tree(
    fiscal_year: Optional[int] = None,
    period_start: Optional[date] = None,
    period_end: Optional[date] = None,
    db: AsyncSession = Depends(get_db),
):
    """카테고리별 트리 (대분류 → 계정과목)"""
    flat = await list_accounts(
        fiscal_year=fiscal_year,
        period_start=period_start,
        period_end=period_end,
        only_with_activity=False,
        db=db,
    )

    grouped: dict = {}
    for a in flat:
        grouped.setdefault(a.category, []).append(a)

    nodes: List[LedgerAccountTreeNode] = []
    for cat, children in grouped.items():
        total_debit = sum((c.period_debit for c in children), Decimal('0'))
        total_credit = sum((c.period_credit for c in children), Decimal('0'))
        total_change = sum((c.period_change for c in children), Decimal('0'))
        total_count = sum(c.transaction_count for c in children)
        nodes.append(LedgerAccountTreeNode(
            account_code=f"_cat_{cat}",
            account_name=CATEGORY_LABEL.get(cat, cat),
            category=cat,  # type: ignore[arg-type]
            parent_code=None,
            depth=0,
            period_debit=total_debit,
            period_credit=total_credit,
            period_change=total_change,
            closing_balance=total_change,
            transaction_count=total_count,
            has_children=True,
            children=[
                LedgerAccountTreeNode(**c.model_dump(), children=[])
                for c in children
            ],
        ))
    return nodes


# ============ 선택 계정 요약 ============

@router.get("/accounts/{account_code}/summary", response_model=LedgerSummary)
async def get_account_summary(
    account_code: str,
    period_start: date = Query(...),
    period_end: date = Query(...),
    db: AsyncSession = Depends(get_db),
):
    """선택 계정의 기간 요약 (그리드 상단 KPI)"""
    # 임시로 코드만 — 아래에서 name 받아온 후 재분류
    cat = categorize_coarse(account_code)

    # 기간 내 합계 — ai_raw + Voucher 통합
    from app.services.unified_ledger import unified_aggregation_subquery
    sub = unified_aggregation_subquery(period_start, period_end)

    period_row = (await db.execute(
        select(
            func.max(sub.c.source_account_name).label('name'),
            func.coalesce(func.sum(sub.c.debit_amount), 0).label('debit'),
            func.coalesce(func.sum(sub.c.credit_amount), 0).label('credit'),
            func.count().label('cnt'),
            func.max(sub.c.debit_amount).label('max_debit'),
            func.max(sub.c.credit_amount).label('max_credit'),
        ).where(sub.c.source_account_code == account_code)
    )).one()

    # 기초 잔액 (기간 시작 이전 누적) — ai_raw + Voucher 통합
    sub_open = unified_aggregation_subquery(None, period_start - timedelta(days=1))
    opening_row = (await db.execute(
        select(
            func.coalesce(func.sum(sub_open.c.debit_amount), 0).label('debit'),
            func.coalesce(func.sum(sub_open.c.credit_amount), 0).label('credit'),
        ).where(sub_open.c.source_account_code == account_code)
    )).one()

    # 이름 받아온 후 카테고리 재분류 (이름 우선)
    cat = categorize_coarse(account_code, period_row.name or '')

    # 회계 원칙: 수익·비용·영업외 계정은 매년 기말에 손익으로 마감되어 0으로 리셋된다.
    # 기간 시작 이전 누적을 "기초 잔액"으로 잡으면 매출이 과대 표시되는 오류 발생.
    # → 손익 계정은 opening_balance=0 (기간 발생액만 표시)
    if cat in ('revenue', 'expense', 'non_operating'):
        opening_balance = Decimal('0')
    else:
        opening_balance = _signed_change(
            cat,
            Decimal(str(opening_row.debit or 0)),
            Decimal(str(opening_row.credit or 0)),
        )
    debit = Decimal(str(period_row.debit or 0))
    credit = Decimal(str(period_row.credit or 0))
    change = _signed_change(cat, debit, credit)

    # 기간 개월 수
    months = max(1, (period_end.year - period_start.year) * 12 + period_end.month - period_start.month + 1)

    return LedgerSummary(
        account_code=account_code,
        account_name=period_row.name or f"계정 {strip_code(account_code)}",
        category=cat,  # type: ignore[arg-type]
        period_start=period_start,
        period_end=period_end,
        opening_balance=opening_balance,
        period_debit=debit,
        period_credit=credit,
        period_change=change,
        closing_balance=opening_balance + change,
        transaction_count=period_row.cnt or 0,
        avg_per_month=(change / months) if change else Decimal('0'),
        largest_debit=Decimal(str(period_row.max_debit or 0)) or None,
        largest_credit=Decimal(str(period_row.max_credit or 0)) or None,
    )


# ============ 선택 계정 거래 내역 ============

@router.get("/accounts/{account_code}/entries", response_model=LedgerEntriesResponse)
async def get_account_entries(
    account_code: str,
    period_start: date = Query(...),
    period_end: date = Query(...),
    counterparty: Optional[str] = None,
    direction: Optional[str] = Query(None, pattern="^(debit|credit)$"),
    min_amount: Optional[Decimal] = None,
    max_amount: Optional[Decimal] = None,
    search: Optional[str] = None,
    page: int = Query(1, ge=1),
    size: int = Query(200, ge=1, le=2000),
    db: AsyncSession = Depends(get_db),
):
    """
    선택 계정의 거래 내역 (엑셀형 그리드용)
    - 누적 잔액(running_balance) 함께 반환
    """
    summary = await get_account_summary(account_code, period_start, period_end, db)
    cat = summary.category

    from app.services.unified_ledger import unified_rows_subquery
    sub = unified_rows_subquery(period_start, period_end)

    filters = [sub.c.source_account_code == account_code]
    if counterparty:
        filters.append(sub.c.merchant_name.ilike(f"%{counterparty}%"))
    if direction == 'debit':
        filters.append(sub.c.debit_amount > 0)
    elif direction == 'credit':
        filters.append(sub.c.credit_amount > 0)
    if min_amount is not None:
        filters.append(or_(
            sub.c.debit_amount >= min_amount,
            sub.c.credit_amount >= min_amount,
        ))
    if max_amount is not None:
        filters.append(or_(
            sub.c.debit_amount <= max_amount,
            sub.c.credit_amount <= max_amount,
        ))
    if search:
        like = f"%{search}%"
        filters.append(or_(
            sub.c.description.ilike(like),
            sub.c.merchant_name.ilike(like),
            sub.c.counterparty_account_name.ilike(like),
        ))

    total = await db.scalar(
        select(func.count()).select_from(sub).where(and_(*filters))
    ) or 0

    offset = (page - 1) * size
    rows = (await db.execute(
        select(sub)
        .where(and_(*filters))
        .order_by(
            sub.c.transaction_date.asc(),
            sub.c.row_number.asc(),
            sub.c.id.asc(),
        )
        .offset(offset).limit(size)
    )).all()

    running = Decimal(str(summary.opening_balance))
    entries: List[LedgerEntry] = []
    for r in rows:
        debit_amt = Decimal(str(r.debit_amount or 0))
        credit_amt = Decimal(str(r.credit_amount or 0))
        running += _signed_change(cat, debit_amt, credit_amt)
        # 상대계정 처리: 6자리 거래처코드거나 source와 동일하면 비움
        ac = (r.counterparty_account_code or '').strip()
        src_code = (r.source_account_code or '').strip()
        is_counterparty_code = ac.isdigit() and len(ac) >= 5
        if not ac or ac == src_code or is_counterparty_code:
            cp_code = None
            cp_name = None
        else:
            cp_code = r.counterparty_account_code
            cp_name = r.counterparty_account_name

        # 날짜 파싱
        try:
            txn_date = date.fromisoformat(r.transaction_date) if r.transaction_date else period_start
        except (ValueError, TypeError):
            txn_date = period_start

        # ai_raw인지 voucher인지 표시 (id 충돌 방지 위해 source 접두사)
        is_voucher = r.source == 'voucher'
        entry_id = (r.id or 0) + (10_000_000 if is_voucher else 0)
        txn_num = f"V#{r.row_number}" if is_voucher else f"#{r.row_number}"

        entries.append(LedgerEntry(
            id=entry_id,
            voucher_id=r.voucher_id if is_voucher else None,
            transaction_date=txn_date,
            transaction_number=txn_num,
            counterparty=r.merchant_name,
            description=r.description or "",
            debit=debit_amt,
            credit=credit_amt,
            running_balance=running,
            counterparty_account_code=cp_code,
            counterparty_account_name=cp_name,
            department_name=None,
            project_tag=None,
            memo=None,
            is_locked=is_voucher,  # voucher 라인은 PATCH 불가
            created_at=None,
        ))

    return LedgerEntriesResponse(
        summary=summary,
        entries=entries,
        total=total,
        page=page,
        size=size,
    )


# ============ 거래 수정 ============

@router.patch("/entries/{entry_id}", response_model=LedgerEntry)
async def update_entry(
    entry_id: int,
    update: LedgerEntryUpdate,
    user_id: int = Query(...),
    db: AsyncSession = Depends(get_db),
):
    """
    원장 거래 수정 — 구분/금액/계정/거래처/적요까지 한 번에.
    - direction='debit' + amount=N → debit_amount=N, credit_amount=0
    - direction='credit' + amount=N → debit_amount=0, credit_amount=N
    - 또는 debit_amount/credit_amount 직접 지정
    """
    row = await db.get(AIRawTransactionData, entry_id)
    if not row:
        raise HTTPException(status_code=404, detail="거래를 찾을 수 없습니다.")

    # 1) 적요
    if update.description is not None:
        row.original_description = update.description

    # 2) 거래처
    if update.counterparty is not None:
        row.merchant_name = update.counterparty

    # 3) 원장 계정 (source) — 변경 시 다른 원장으로 이동됨
    if update.source_account_code is not None:
        row.source_account_code = update.source_account_code
    if update.source_account_name is not None:
        row.source_account_name = update.source_account_name

    # 4) 상대 계정
    if update.account_code is not None:
        row.account_code = update.account_code
    if update.account_name is not None:
        row.account_name = update.account_name

    # 5) 차변/대변 — direction + amount 우선 적용
    if update.direction and update.amount is not None:
        amt = update.amount
        if update.direction == 'debit':
            row.debit_amount = amt
            row.credit_amount = Decimal('0')
        else:
            row.debit_amount = Decimal('0')
            row.credit_amount = amt
    else:
        if update.debit_amount is not None:
            row.debit_amount = update.debit_amount
        if update.credit_amount is not None:
            row.credit_amount = update.credit_amount

    # amount 동기화 (raw 데이터의 amount 컬럼)
    if (
        update.direction and update.amount is not None
    ) or update.debit_amount is not None or update.credit_amount is not None:
        row.amount = max(row.debit_amount or Decimal('0'), row.credit_amount or Decimal('0'))

    # 6) 거래처 코드 / 메모 / 프로젝트 태그
    # raw 테이블엔 별도 컬럼 없음 — TODO: ledger_entry_meta 테이블 추가 후 분리 저장
    # 현재는 무시 (프론트엔드 전용 임시 저장 가능)

    await db.commit()
    await db.refresh(row)

    cat = categorize_coarse(row.source_account_code)
    return LedgerEntry(
        id=row.id,
        voucher_id=None,
        transaction_date=date.fromisoformat(_date_to_iso(row.transaction_date) or date.today().isoformat()),
        transaction_number=f"#{row.row_number}",
        counterparty=row.merchant_name,
        description=row.original_description,
        debit=Decimal(str(row.debit_amount or 0)),
        credit=Decimal(str(row.credit_amount or 0)),
        running_balance=Decimal('0'),
        counterparty_account_code=row.account_code,
        counterparty_account_name=row.account_name,
        department_name=None,
        project_tag=update.project_tag,
        memo=update.memo,
        is_locked=False,
        created_at=row.created_at,
    )


# ============ 엑셀 내보내기 (TODO: 실제 xlsx 생성) ============

@router.get("/accounts/{account_code}/export")
async def export_ledger_excel(
    account_code: str,
    period_start: date = Query(...),
    period_end: date = Query(...),
    db: AsyncSession = Depends(get_db),
):
    """원장 엑셀 내보내기 — 추후 financial_reports의 export 패턴 재사용 예정"""
    return {
        "account_code": account_code,
        "period": f"{period_start} ~ {period_end}",
        "url": f"/api/v1/financial/account-detail/export/excel?account_code={account_code}",
        "note": "기존 /financial/account-detail/export/excel 사용 권장",
    }


# ============ 매출채권 / 매입채무 거래처별 요약 ============

# 매출채권: 외상매출금(108), 받을어음(110)
# 매입채무: 외상매입금(251), 미지급금(253) — 미지급금은 매입성 부채라 함께
AR_CODES = ["108", "110"]
AP_CODES = ["251", "253"]


@router.get("/ar-ap/summary")
async def get_ar_ap_summary(
    fiscal_year: int = Query(..., ge=2020, le=2030, description="회계연도"),
    type: str = Query(..., regex="^(receivable|payable)$", description="receivable=매출채권 / payable=매입채무 (부호 처리용)"),
    codes: Optional[str] = Query(None, description="조회할 계정 코드 csv (예: '108,110'). 미지정 시 type별 default 사용"),
    db: AsyncSession = Depends(get_db),
):
    """
    매출채권/매입채무 거래처별·월별 요약 — CONFIRMED Voucher 단일 소스.

    type은 부호 처리용 (자산=차변증가, 부채=대변증가).
    codes로 계정 단위 선택 가능 — 예:
    - 매출채권: 108(외상매출금), 110(받을어음) → 둘 중 하나 또는 둘 다 선택
    - 매입채무: 251(외상매입금), 253(미지급금) → 둘 중 하나 또는 둘 다 선택
    """
    from app.services.unified_ledger import unified_aggregation_subquery

    default_codes = AR_CODES if type == "receivable" else AP_CODES
    if codes:
        requested = [c.strip() for c in codes.split(',') if c.strip()]
        # 허용된 계정만 통과 (보안: 임의 코드 조회 방지)
        filtered = [c for c in requested if c in default_codes]
        active_codes = filtered if filtered else default_codes
    else:
        active_codes = default_codes

    start = date(fiscal_year, 1, 1)
    end = date(fiscal_year, 12, 31)
    # 기초: period_start 이전 전체 (None ~ start-1일)
    opening_end = start - timedelta(days=1)

    # 부호 처리: 자산은 차변=증가/대변=감소, 부채는 반대
    def signed(d: Any, c: Any) -> Decimal:
        d, c = Decimal(str(d or 0)), Decimal(str(c or 0))
        return (d - c) if type == "receivable" else (c - d)

    # unified 서브쿼리는 transaction_date가 항상 'YYYY-MM-DD' 문자열
    # 기초 잔액 서브쿼리 (period_start 이전 전체)
    sub_open = unified_aggregation_subquery(None, opening_end)
    opening_filter = sub_open.c.source_account_code.in_(active_codes)

    # 기초 총잔액
    opening_row = (await db.execute(
        select(
            func.coalesce(func.sum(sub_open.c.debit_amount), 0).label('d'),
            func.coalesce(func.sum(sub_open.c.credit_amount), 0).label('c'),
        ).where(opening_filter)
    )).one()
    opening_balance = signed(opening_row.d, opening_row.c)

    # 거래처별 기초 잔액
    cp_open_rows = (await db.execute(
        select(
            sub_open.c.merchant_name.label('cp'),
            func.coalesce(func.sum(sub_open.c.debit_amount), 0).label('d'),
            func.coalesce(func.sum(sub_open.c.credit_amount), 0).label('c'),
        ).where(opening_filter)
         .group_by(sub_open.c.merchant_name)
    )).all()
    cp_opening = {(r.cp or '(미지정)'): signed(r.d, r.c) for r in cp_open_rows}

    # 기간 서브쿼리 (fiscal_year 전체)
    sub = unified_aggregation_subquery(start, end)
    period_filter = sub.c.source_account_code.in_(active_codes)

    # 거래처별 기간 합계
    cp_rows = (await db.execute(
        select(
            sub.c.merchant_name.label('cp'),
            func.coalesce(func.sum(sub.c.debit_amount), 0).label('d'),
            func.coalesce(func.sum(sub.c.credit_amount), 0).label('c'),
            func.count().label('cnt'),
            func.max(sub.c.transaction_date).label('latest'),
            func.min(sub.c.transaction_date).label('earliest'),
        ).where(period_filter)
         .group_by(sub.c.merchant_name)
    )).all()

    counterparties = []
    total_debit = Decimal('0')
    total_credit = Decimal('0')
    total_count = 0
    for r in cp_rows:
        name = r.cp or '(미지정)'
        cp_open = cp_opening.get(name, Decimal('0'))
        cp_d = Decimal(str(r.d or 0))
        cp_c = Decimal(str(r.c or 0))
        cp_change = signed(cp_d, cp_c)
        total_debit += cp_d
        total_credit += cp_c
        total_count += r.cnt or 0
        counterparties.append({
            'name': name,
            'opening_balance': float(cp_open),
            'period_debit': float(cp_d),
            'period_credit': float(cp_c),
            'period_change': float(cp_change),
            'closing_balance': float(cp_open + cp_change),
            'transaction_count': r.cnt or 0,
            'latest_date': str(r.latest) if r.latest else None,
            'earliest_date': str(r.earliest) if r.earliest else None,
        })

    # 기초만 있고 기간내 거래 없는 거래처도 포함 (잔액 carry-over)
    period_cp_names = {r.cp or '(미지정)' for r in cp_rows}
    for name, bal in cp_opening.items():
        if name in period_cp_names:
            continue
        if bal == 0:
            continue
        counterparties.append({
            'name': name,
            'opening_balance': float(bal),
            'period_debit': 0.0,
            'period_credit': 0.0,
            'period_change': 0.0,
            'closing_balance': float(bal),
            'transaction_count': 0,
            'latest_date': None,
            'earliest_date': None,
        })

    counterparties.sort(key=lambda x: -abs(x['closing_balance']))

    # 월별 시계열 — transaction_date는 'YYYY-MM-DD' 문자열이므로 앞 7자리가 'YYYY-MM'
    ym_expr = func.substr(sub.c.transaction_date, 1, 7)
    month_rows = (await db.execute(
        select(
            ym_expr.label('ym'),
            func.coalesce(func.sum(sub.c.debit_amount), 0).label('d'),
            func.coalesce(func.sum(sub.c.credit_amount), 0).label('c'),
            func.count().label('cnt'),
        ).where(period_filter)
         .group_by(ym_expr)
         .order_by(ym_expr)
    )).all()

    monthly = []
    running = opening_balance
    for r in month_rows:
        change = signed(r.d, r.c)
        running = running + change
        monthly.append({
            'month': (r.ym or '')[:7],  # unified는 항상 'YYYY-MM-DD' → 앞 7자리가 정확한 'YYYY-MM'
            'period_debit': float(Decimal(str(r.d or 0))),
            'period_credit': float(Decimal(str(r.c or 0))),
            'period_change': float(change),
            'closing_balance': float(running),
            'transaction_count': r.cnt or 0,
        })

    period_change = signed(total_debit, total_credit)
    return {
        'fiscal_year': fiscal_year,
        'type': type,
        'account_codes': active_codes,
        'opening_balance': float(opening_balance),
        'closing_balance': float(opening_balance + period_change),
        'period_debit': float(total_debit),
        'period_credit': float(total_credit),
        'period_change': float(period_change),
        'counterparty_count': len(counterparties),
        'transaction_count': total_count,
        'monthly': monthly,
        'counterparties': counterparties,
    }
