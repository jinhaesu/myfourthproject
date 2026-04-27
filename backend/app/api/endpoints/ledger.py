"""
Account Ledger API — 계정별 원장 (총계정원장)
좌측: 계정과목 트리
우측: 선택 계정의 거래 내역 (엑셀형 그리드)

NOTE: 라우트 스켈레톤. 실제 데이터는 journal_entries / vouchers 테이블 기반으로 집계.
"""
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Optional, List
from fastapi import APIRouter, Depends, Query, HTTPException, status
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
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


# 표준 계정과목 시드 (실제로는 chart_of_accounts 테이블에서 조회)
_STANDARD_ACCOUNTS = [
    # 자산
    ("101", "현금", "asset", None, 0),
    ("102", "당좌예금", "asset", None, 0),
    ("103", "보통예금", "asset", None, 0),
    ("110", "단기금융상품", "asset", None, 0),
    ("120", "외상매출금", "asset", None, 0),
    ("125", "받을어음", "asset", None, 0),
    ("130", "선급금", "asset", None, 0),
    ("140", "재고자산", "asset", None, 0),
    ("180", "건물", "asset", None, 0),
    ("181", "기계장치", "asset", None, 0),
    # 부채
    ("251", "외상매입금", "liability", None, 0),
    ("252", "지급어음", "liability", None, 0),
    ("253", "미지급금", "liability", None, 0),
    ("254", "예수금", "liability", None, 0),
    ("260", "단기차입금", "liability", None, 0),
    ("293", "장기차입금", "liability", None, 0),
    # 자본
    ("331", "자본금", "equity", None, 0),
    ("375", "이익잉여금", "equity", None, 0),
    # 매출(수익)
    ("401", "상품매출", "revenue", None, 0),
    ("411", "제품매출", "revenue", None, 0),
    ("412", "용역매출", "revenue", None, 0),
    # 매출원가
    ("451", "원재료비", "expense", None, 0),
    ("452", "상품매입", "expense", None, 0),
    # 판관비
    ("811", "급여", "expense", None, 0),
    ("812", "잡급", "expense", None, 0),
    ("819", "임차료", "expense", None, 0),
    ("820", "보험료", "expense", None, 0),
    ("821", "수도광열비", "expense", None, 0),
    ("822", "통신비", "expense", None, 0),
    ("826", "도서인쇄비", "expense", None, 0),
    ("830", "소모품비", "expense", None, 0),
    ("831", "복리후생비", "expense", None, 0),
    ("832", "여비교통비", "expense", None, 0),
    ("833", "접대비", "expense", None, 0),
    ("834", "광고선전비", "expense", None, 0),
    # 영업외
    ("930", "이자비용", "non_operating", None, 0),
    ("906", "이자수익", "non_operating", None, 0),
]


def _mock_account(code: str, name: str, category: str, parent: Optional[str], depth: int, idx: int) -> LedgerAccount:
    base_amount = (idx + 1) * 100000
    debit = Decimal(str(base_amount * 1.4)) if category in ("asset", "expense") else Decimal(str(base_amount * 0.3))
    credit = Decimal(str(base_amount * 0.3)) if category in ("asset", "expense") else Decimal(str(base_amount * 1.4))
    if category in ("asset", "expense"):
        change = debit - credit
    else:
        change = credit - debit
    return LedgerAccount(
        account_code=code,
        account_name=name,
        category=category,  # type: ignore[arg-type]
        parent_code=parent,
        depth=depth,
        period_debit=debit,
        period_credit=credit,
        period_change=change,
        closing_balance=change,  # 기초 0 가정
        transaction_count=(idx % 7) + 1,
        has_children=False,
    )


@router.get("/accounts", response_model=List[LedgerAccount])
async def list_accounts(
    fiscal_year: int = Query(...),
    period_start: Optional[date] = None,
    period_end: Optional[date] = None,
    category: Optional[AccountCategory] = None,
    only_with_activity: bool = False,
    search: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
):
    """
    계정과목 리스트 (좌측 사이드바용)
    각 계정의 기간 차변/대변/잔액/거래 건수까지 함께 반환
    """
    # TODO: chart_of_accounts JOIN journal_entries 집계 쿼리
    accounts = []
    for idx, (code, name, cat, parent, depth) in enumerate(_STANDARD_ACCOUNTS):
        if category and cat != category:
            continue
        if search and search.lower() not in name.lower() and search not in code:
            continue
        accounts.append(_mock_account(code, name, cat, parent, depth, idx))

    if only_with_activity:
        accounts = [a for a in accounts if a.transaction_count > 0]

    return accounts


@router.get("/accounts/tree", response_model=List[LedgerAccountTreeNode])
async def get_account_tree(
    fiscal_year: int = Query(...),
    period_start: Optional[date] = None,
    period_end: Optional[date] = None,
    db: AsyncSession = Depends(get_db),
):
    """계정과목 트리 (대분류 → 중분류 → 세분류)"""
    # TODO: 실제 트리 구성. 현재는 평탄한 구조를 카테고리 노드로 묶어서 반환.
    grouped: dict = {}
    for idx, (code, name, cat, parent, depth) in enumerate(_STANDARD_ACCOUNTS):
        grouped.setdefault(cat, []).append(_mock_account(code, name, cat, parent, depth, idx))

    category_labels = {
        "asset": "자산",
        "liability": "부채",
        "equity": "자본",
        "revenue": "수익",
        "expense": "비용",
        "non_operating": "영업외",
    }

    nodes: List[LedgerAccountTreeNode] = []
    for cat, children in grouped.items():
        total_debit = sum((c.period_debit for c in children), Decimal("0"))
        total_credit = sum((c.period_credit for c in children), Decimal("0"))
        total_change = sum((c.period_change for c in children), Decimal("0"))
        total_count = sum(c.transaction_count for c in children)
        head = LedgerAccountTreeNode(
            account_code=f"_cat_{cat}",
            account_name=category_labels.get(cat, cat),
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
                LedgerAccountTreeNode(**c.model_dump(), children=[]) for c in children
            ],
        )
        nodes.append(head)
    return nodes


@router.get("/accounts/{account_code}/summary", response_model=LedgerSummary)
async def get_account_summary(
    account_code: str,
    period_start: date = Query(...),
    period_end: date = Query(...),
    db: AsyncSession = Depends(get_db),
):
    """선택 계정의 기간 요약 (그리드 상단 KPI 카드)"""
    # TODO: 실제 집계
    matching = next(
        ((c, n, cat) for c, n, cat, _, _ in _STANDARD_ACCOUNTS if c == account_code),
        None,
    )
    if not matching:
        raise HTTPException(status_code=404, detail="계정과목을 찾을 수 없습니다.")
    code, name, cat = matching
    debit = Decimal("12000000")
    credit = Decimal("3500000")
    change = (debit - credit) if cat in ("asset", "expense") else (credit - debit)
    return LedgerSummary(
        account_code=code,
        account_name=name,
        category=cat,  # type: ignore[arg-type]
        period_start=period_start,
        period_end=period_end,
        opening_balance=Decimal("5000000"),
        period_debit=debit,
        period_credit=credit,
        period_change=change,
        closing_balance=Decimal("5000000") + change,
        transaction_count=24,
        avg_per_month=change / 3 if change else Decimal("0"),
        largest_debit=Decimal("3500000"),
        largest_credit=Decimal("1200000"),
    )


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
    size: int = Query(200, ge=1, le=1000),
    db: AsyncSession = Depends(get_db),
):
    """
    선택 계정의 거래 내역 (엑셀형 그리드용)
    - running_balance(누적 잔액) 함께 반환
    """
    # TODO: 실제 journal_entries JOIN voucher 쿼리 + 누적 잔액 계산
    summary = await get_account_summary(account_code, period_start, period_end, db)

    sample_descriptions = [
        ("이마트 식자재 정산", "(주)이마트", 8500000, 0),
        ("롯데마트 정산", "롯데마트", 0, 3500000),
        ("CJ제일제당 매입", "(주)CJ제일제당", 0, 12000000),
        ("스마트로 PG 정산", "스마트로", 5820000, 0),
        ("쿠팡 사무용품", "쿠팡", 87000, 0),
        ("강남빌딩 임대료", "강남빌딩", 3200000, 0),
        ("스타벅스 강남점", "스타벅스", 25400, 0),
        ("4월 급여 지급", "직원전체", 12000000, 0),
        ("법인카드 결제", "삼성카드", 1850000, 0),
        ("부가세 신고 납부", "국세청", 2400000, 0),
    ]

    entries: List[LedgerEntry] = []
    running = Decimal(str(summary.opening_balance))
    for i in range(min(size, len(sample_descriptions) * 3)):
        s = sample_descriptions[i % len(sample_descriptions)]
        d = period_start + timedelta(days=i * 2)
        if d > period_end:
            break
        debit_amt = Decimal(str(s[2]))
        credit_amt = Decimal(str(s[3]))
        if summary.category in ("asset", "expense"):
            running += debit_amt - credit_amt
        else:
            running += credit_amt - debit_amt
        entries.append(
            LedgerEntry(
                id=10000 + i,
                voucher_id=20000 + i,
                transaction_date=d,
                transaction_number=f"V{d.strftime('%Y%m%d')}-{(i + 1):03d}",
                counterparty=s[1],
                description=s[0],
                debit=debit_amt,
                credit=credit_amt,
                running_balance=running,
                counterparty_account_code="103" if debit_amt > 0 else "251",
                counterparty_account_name="보통예금" if debit_amt > 0 else "외상매입금",
                department_name="재무팀",
                project_tag=None,
                memo=None,
                is_locked=False,
                created_at=datetime.utcnow(),
            )
        )

    return LedgerEntriesResponse(
        summary=summary,
        entries=entries,
        total=len(entries),
        page=page,
        size=size,
    )


@router.patch("/entries/{entry_id}", response_model=LedgerEntry)
async def update_entry(
    entry_id: int,
    update: LedgerEntryUpdate,
    user_id: int = Query(...),
    db: AsyncSession = Depends(get_db),
):
    """원장 거래 수정 (적요/메모/태그/거래처) — 결산 락이면 거부"""
    # TODO: is_locked 체크 + 실제 수정
    return LedgerEntry(
        id=entry_id,
        voucher_id=20000 + entry_id,
        transaction_date=date.today(),
        transaction_number=f"V{date.today().strftime('%Y%m%d')}-001",
        counterparty=update.counterparty or "(주)이마트",
        description=update.description or "이마트 식자재 정산",
        debit=Decimal("8500000"),
        credit=Decimal("0"),
        running_balance=Decimal("13500000"),
        counterparty_account_code="103",
        counterparty_account_name="보통예금",
        department_name="재무팀",
        project_tag=update.project_tag,
        memo=update.memo,
        is_locked=False,
        created_at=datetime.utcnow(),
    )


@router.get("/accounts/{account_code}/export")
async def export_ledger_excel(
    account_code: str,
    period_start: date = Query(...),
    period_end: date = Query(...),
    db: AsyncSession = Depends(get_db),
):
    """원장 엑셀 내보내기"""
    # TODO: 실제 xlsx 생성
    return {
        "account_code": account_code,
        "period": f"{period_start} ~ {period_end}",
        "url": f"https://example.com/ledger/{account_code}.xlsx",
        "expires_at": (datetime.utcnow() + timedelta(hours=1)).isoformat(),
    }
