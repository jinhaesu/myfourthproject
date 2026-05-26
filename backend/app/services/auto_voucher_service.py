"""
자동 전표 후보 생성 서비스

핵심:
- 백그라운드 task + in-memory 진행률 추적 (재배포 시 휘발이지만 단일 사용자 환경엔 충분)
- 그랜터 31일 청크를 4개 병렬로 수집 (semaphore=1 한계 우회: list_tickets_all_types 자체는 직렬이지만
  여러 청크를 병렬로 큐잉해 청크 간 sleep 누적 회피)

그랜터 수집 거래 + AI 분류 결과 → AutoVoucherCandidate (검수 큐).

거래 유형별 표준 분개 패턴 (K-GAAP):
- 매출 세금계산서: 외상매출금(108) / 제품매출(404) + 부가세예수금(255)
- 매입 세금계산서: 비용·자산 + 부가세대급금(135) / 외상매입금(251)
- 카드 매입: 비용 + 부가세대급금 / 미지급금(253)[카드사]
- 통장 입금/출금: 보통예금(103) / AI 분류 추천
- 현금영수증 매입: 비용 + 부가세대급금 / 현금(101)
"""
import asyncio
import json
import logging
import re
import time
import uuid
from datetime import date, timedelta
from decimal import Decimal
from typing import Optional, Dict, Any, Tuple, List

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import async_session_factory
from app.models.accounting import (
    AutoVoucherCandidate, AutoVoucherSourceType, AutoVoucherStatus,
    Voucher, VoucherStatus,
)
from app.services.granter_client import get_granter_client

logger = logging.getLogger(__name__)

# 우리 회사 사업자번호 (조인앤조인 503-87-01038)
# 매출세금계산서와 매입세금계산서를 정확히 판정하는 기준
OUR_BUSINESS_NUMBER = "5038701038"


def _normalize_biznum(s: Optional[str]) -> str:
    return (s or "").replace("-", "").replace(" ", "").strip()


# 거래처 마스터 캐시 (wehago voucher_lines + 그랜터 BANK_ACCOUNT 자산 기반)
# - sales_customers: 매출처 사업자번호 + 정규화 이름 set
# - purchase_vendors: 매입처 사업자번호 + 정규화 이름 set
# - vendor_account_hints: 거래처 → 추천 비용 계정 코드 (가장 자주 쓰인 것)
# - our_bank_accounts: 우리 회사 계좌 (자기 이체 판정용) — nickname/예금주명 정규화 set
_CP_CACHE: Dict[str, Any] = {
    "ts": 0,
    "sales_customers": set(),
    "purchase_vendors": set(),
    "vendor_account_hints": {},
    "our_bank_accounts": set(),
}
_CP_CACHE_TTL = 30 * 60  # 30분


def _normalize_name(s: Optional[str]) -> str:
    """거래처 이름 정규화 — 공백/(주)/주식회사 변형 흡수."""
    if not s:
        return ""
    t = str(s).strip()
    for token in ("주식회사", "(주)", "㈜", "(유)", "유한회사", " ", "　"):
        t = t.replace(token, "")
    return t.lower()


async def _build_counterparty_cache(force: bool = False) -> Dict[str, Any]:
    """1.1~2.10 wehago voucher_lines + 그랜터 BANK_ACCOUNT 자산에서 마스터 추출.
    30분 캐시 — generate-candidates 또는 bank 재분개 시 호출."""
    import time as _t
    now = _t.time()
    if not force and (now - _CP_CACHE["ts"] < _CP_CACHE_TTL) and _CP_CACHE["sales_customers"]:
        return _CP_CACHE

    from sqlalchemy import text as _text
    sales_set: set = set()
    purchase_set: set = set()
    hints: Dict[str, str] = {}

    async with async_session_factory() as db:
        # 매출처: 4xx (매출/매출원가) 대변 — wehago_import + granter_auto 둘 다 학습
        rows = (await db.execute(_text("""
            SELECT vl.counterparty_name, vl.counterparty_business_number
            FROM voucher_lines vl
            JOIN vouchers v ON v.id = vl.voucher_id
            JOIN accounts a ON a.id = vl.account_id
            WHERE v.source IN ('wehago_import','granter_auto')
              AND a.code IN ('401','404')  -- 매출만 (45x 매출원가 제외)
              AND vl.credit_amount > 0
              AND vl.counterparty_name IS NOT NULL
        """))).all()
        for nm, bn in rows:
            if nm:
                sales_set.add(_normalize_name(nm))
            if bn:
                sales_set.add(_normalize_biznum(bn))

        # 매출처 보강 — AutoVoucherCandidate 중 매출 분개 (CONFIRMED 또는 PENDING):
        # source_type SALES_TAX_INVOICE / SALES_INVOICE / CASH_RECEIPT 의 counterparty
        rows_av_sales = (await db.execute(_text("""
            SELECT DISTINCT counterparty
            FROM auto_voucher_candidates
            WHERE counterparty IS NOT NULL
              AND source_type IN ('SALES_TAX_INVOICE','SALES_INVOICE','CASH_RECEIPT')
              AND status IN ('CONFIRMED','PENDING','APPROVED')
        """))).all()
        for (nm,) in rows_av_sales:
            if nm:
                sales_set.add(_normalize_name(nm))

        # 매입처: 153/146/148/5xx/6xx/7xx/8xx 차변 거래처 + 최빈 계정 hint
        rows2 = (await db.execute(_text("""
            SELECT vl.counterparty_name, vl.counterparty_business_number,
                   a.code, COUNT(*) AS cnt
            FROM voucher_lines vl
            JOIN vouchers v ON v.id = vl.voucher_id
            JOIN accounts a ON a.id = vl.account_id
            WHERE v.source IN ('wehago_import','granter_auto')
              AND (LEFT(a.code,1) IN ('5','8','6','7')
                   OR a.code IN ('153','146','148'))
              AND vl.debit_amount > 0
              AND vl.counterparty_name IS NOT NULL
            GROUP BY vl.counterparty_name, vl.counterparty_business_number, a.code
        """))).all()
        # 거래처별 최빈 계정 코드 선택 — 각 행 처리에 보호
        cp_acc_counter: Dict[str, Dict[str, int]] = {}
        for row in rows2:
            try:
                nm = row[0] if len(row) > 0 else None
                bn = row[1] if len(row) > 1 else None
                code = row[2] if len(row) > 2 else None
                cnt = row[3] if len(row) > 3 else 0
                key = _normalize_name(nm) or _normalize_biznum(bn) or ""
                if not key or not code:
                    continue
                purchase_set.add(key)
                if bn:
                    nb = _normalize_biznum(bn)
                    if nb:
                        purchase_set.add(nb)
                # 계정코드 카운트 누적
                if key not in cp_acc_counter:
                    cp_acc_counter[key] = {}
                code_str = str(code)
                cp_acc_counter[key][code_str] = cp_acc_counter[key].get(code_str, 0) + int(cnt or 0)
            except Exception as row_err:
                logger.warning(f"cache row skip ({nm!r} / {bn!r}): {row_err}")
                continue
        for key, codes in cp_acc_counter.items():
            try:
                if not codes:
                    continue
                best = max(codes.items(), key=lambda x: x[1])[0]
                hints[key] = best
            except Exception as h_err:
                logger.warning(f"hint skip {key!r}: {h_err}")

    # 우리 회사 계좌 (그랜터 BANK_ACCOUNT 자산)
    our_accounts: set = set()
    try:
        client = get_granter_client()
        assets = await client.list_all_assets(only_active=False)
        for ba in (assets.get("BANK_ACCOUNT") or []):
            for k in ("nickname", "name", "accountHolder", "holderName"):
                v = ba.get(k) if isinstance(ba, dict) else None
                if v:
                    our_accounts.add(_normalize_name(v))
            # bankAccount sub-object도 확인
            sub = ba.get("bankAccount") if isinstance(ba, dict) else None
            if isinstance(sub, dict):
                for k in ("nickname", "accountHolderName", "holderName"):
                    v = sub.get(k)
                    if v:
                        our_accounts.add(_normalize_name(v))
        # 우리 회사 이름도 자기 이체 식별에 도움 (조인앤조인 변형)
        our_accounts.update({_normalize_name(s) for s in
                             ("조인앤조인", "(주)조인앤조인", "주식회사 조인앤조인", "㈜조인앤조인")})
    except Exception as e:
        logger.warning(f"our_bank_accounts 조회 실패: {e}")

    _CP_CACHE.update({
        "ts": now,
        "sales_customers": sales_set,
        "purchase_vendors": purchase_set,
        "vendor_account_hints": hints,
        "our_bank_accounts": our_accounts,
    })
    logger.info(
        f"counterparty cache built: sales={len(sales_set)}, "
        f"purchase={len(purchase_set)}, hints={len(hints)}, ours={len(our_accounts)}"
    )
    return _CP_CACHE


# 카드사 이름 패턴 — bank content에 등장 시 카드사 결제 청구로 분류 (P/L 영향 X, 미지급금 차감)
_CARD_ISSUER_PATTERNS = (
    "비씨카드", "bc카드", "bc바로카드", "하나카드", "신한카드", "현대카드",
    "롯데카드", "우리카드", "kb국민카드", "kb카드", "삼성카드", "농협카드",
    "씨티카드", "카드출금", "카드결제",
)


def _classify_counterparty(
    name: Optional[str],
    biz_num: Optional[str] = None,
    direction: Optional[str] = None,
) -> str:
    """거래처 분류 — _build_counterparty_cache 먼저 호출되어 있어야 함.
    direction: 'inbound'(입금) | 'outbound'(출금) | None — 동시 매칭 시 우선순위 결정.
    Returns: 'OUR_ACCOUNT' | 'CARD_ISSUER' | 'SALES_CUSTOMER' | 'PURCHASE_VENDOR' | 'UNKNOWN'"""
    key = _normalize_name(name)
    bn = _normalize_biznum(biz_num) if biz_num else ""

    if key and key in _CP_CACHE["our_bank_accounts"]:
        return "OUR_ACCOUNT"
    if bn and bn == OUR_BUSINESS_NUMBER:
        return "OUR_ACCOUNT"

    # 카드사 결제 청구 — content에 카드사 키워드. 매월 자동 출금이라 P/L 영향 X (이미 카드 EXPENSE_TICKET으로 분개됨)
    if key:
        for pat in _CARD_ISSUER_PATTERNS:
            if pat in key:
                return "CARD_ISSUER"

    sales_set = _CP_CACHE["sales_customers"]
    purchase_set = _CP_CACHE["purchase_vendors"]

    # 1. 정확 매칭
    sales_hit = (key and key in sales_set) or (bn and bn in sales_set)
    purchase_hit = (key and key in purchase_set) or (bn and bn in purchase_set)

    # 2. 부분 매칭 — 거래처 이름이 substring으로 포함 (양방향)
    #    bank counterparty가 "쿠팡 4월정산" 이면 "쿠팡" wehago 거래처 매칭
    #    또는 wehago "주식회사 컬리" 의 정규화 키 "컬리"가 bank "컬리" 안에 있음
    if not sales_hit and not purchase_hit and key and len(key) >= 3:
        # 우리 계좌 substring도 체크 — "이마트b2b 정산" 같은 케이스
        for our_key in _CP_CACHE["our_bank_accounts"]:
            if isinstance(our_key, str) and len(our_key) >= 4:
                if our_key in key or (len(key) >= 4 and key in our_key):
                    return "OUR_ACCOUNT"
        # 매출처 substring
        for cp in sales_set:
            if isinstance(cp, str) and len(cp) >= 3:
                if cp in key or key in cp:
                    sales_hit = True
                    break
        # 매입처 substring
        for cp in purchase_set:
            if isinstance(cp, str) and len(cp) >= 3:
                if cp in key or key in cp:
                    purchase_hit = True
                    break

    # 우선순위 — 양쪽 다 매칭되면 거래 방향에 따라
    if sales_hit and purchase_hit:
        if direction == "outbound":
            return "PURCHASE_VENDOR"
        return "SALES_CUSTOMER"  # 입금/미상은 매출 우선
    if sales_hit:
        return "SALES_CUSTOMER"
    if purchase_hit:
        return "PURCHASE_VENDOR"
    return "UNKNOWN"


# 매입 키워드 → 계정 매핑 (description/merchant_name/counterparty 키워드 검색)
# 우선순위: vendor hint(과거 학습) > 키워드 분류 > 153 원재료(최종 default)
_PURCHASE_KEYWORD_MAP: List[Tuple[Tuple[str, ...], str, str]] = [
    # (키워드들, 계정코드, 계정명)
    (("외주", "용역", "위탁", "외주가공"), "533", "외주가공비"),
    (("주유", "주차", "차량", "엔진오일", "타이어", "정비", "통행료", "하이패스"), "822", "차량유지비"),
    (("광고", "마케팅", "프로모션", "퍼블리시", "퍼블리싱", "노출", "sns광고", "구글광고", "페이스북광고", "인스타광고"), "833", "광고선전비"),
    (("운반", "배송", "택배", "퀵", "용달", "물류", "포워딩"), "824", "운반비"),
    (("통신", "인터넷", "kt ", "케이티 ", "skt", "lg유플", "유플러스", "전화비"), "814", "통신비(판)"),
    (("임대", "임차", "월세", "rent", "리스 ", "사무실 "), "819", "지급임차료(판)"),
    (("회식", "복리", "간식", "식대", "워크샵", "워크숍", "휴게실"), "811", "복리후생비(판)"),
    (("교육", "강의", "세미나", "컨퍼런스", "training"), "825", "교육훈련비"),
    (("도서", "책", "정기간행", "구독", "도서구입", "신문"), "826", "도서인쇄비"),
    (("접대", "회식대", "선물", "경조사", "축의금", "조의금"), "813", "접대비"),
    (("수도", "전기", "가스", "한국전력", "도시가스", "수도요금"), "815", "수도광열비"),
    (("보험", "건강보험", "산재", "고용보험", "보험료"), "821", "보험료(판)"),
    (("수리", "수선", "유지보수", "ac정비", "수리비"), "820", "수선비"),
    (("출장", "여비", "교통비", "택시", "kt x", "ktx", "고속버스", "철도", "항공", "숙박"), "812", "여비교통비"),
    (("수수료", "fee", "은행수수료", "송금수수료", "결제수수료", "이체수수료"), "831", "지급수수료(판)"),
    (("소모품", "비품", "사무용품", "프린터", "잉크", "토너", "복사용지", "마우스", "키보드"), "830", "소모품비(판)"),
    (("개발", "연구", "rd", "r&d", "프로토타입"), "823", "경상연구개발비"),
    # 원재료성 키워드 (확실한 것만)
    (("원료", "원재료", "농산물", "축산물", "수산물", "식품원료"), "153", "원재료"),
]


def _suggest_purchase_account(name: Optional[str], description: Optional[str] = None, merchant: Optional[str] = None) -> Tuple[str, str]:
    """매입처별 추천 계정.
    1순위: 거래처 이름 기반 vendor hint (wehago 학습)
    2순위: description/merchant_name/counterparty의 키워드 매칭
    3순위: 153 원재료 (default)
    """
    # 1순위: vendor hint
    key = _normalize_name(name)
    code = _CP_CACHE["vendor_account_hints"].get(key) if key else None
    if code:
        return code, code

    # 2순위: 키워드 매칭 (이름+적요+가맹점명 결합 후 소문자)
    haystack_parts = []
    for s in (name, description, merchant):
        if s:
            haystack_parts.append(str(s).lower())
    haystack = " ".join(haystack_parts)
    if haystack:
        for keywords, kw_code, kw_name in _PURCHASE_KEYWORD_MAP:
            for kw in keywords:
                if kw.lower() in haystack:
                    return kw_code, kw_name

    # 3순위: default 원재료
    return "153", "원재료"


def _is_sales_tax_invoice(ticket: Dict[str, Any]) -> bool:
    """매출/매입 세금계산서 판정.
    1순위: supplier(공급자)의 사업자번호가 우리 회사 → 매출
            contractor(매입자)의 사업자번호가 우리 회사 → 매입
    2순위(사번 미상): transactionType "SALES" 키워드만 매출로 인정
            (그랜터의 "OUT"은 "외부에서 받음"=매입이므로 매출 키워드에서 제외)"""
    ti = ticket.get("taxInvoice") or {}
    sup_reg = _normalize_biznum((ti.get("supplier") or {}).get("registrationNumber"))
    con_reg = _normalize_biznum((ti.get("contractor") or {}).get("registrationNumber"))

    if sup_reg == OUR_BUSINESS_NUMBER and con_reg != OUR_BUSINESS_NUMBER:
        return True
    if con_reg == OUR_BUSINESS_NUMBER and sup_reg != OUR_BUSINESS_NUMBER:
        return False
    # 양쪽 다 우리 회사이거나 매칭 안 됨 → 보수적으로 매입 (대부분의 식품회사 케이스)
    txn_type = (ticket.get("transactionType") or "").upper()
    return "SALES" in txn_type


# ============ 진행률 추적 (in-memory) ============

# task_id → {status, percent, message, result, started_at, finished_at}
_PROGRESS: Dict[str, Dict[str, Any]] = {}


def _new_task(label: str = "") -> str:
    tid = str(uuid.uuid4())[:8]
    _PROGRESS[tid] = {
        "task_id": tid,
        "status": "running",
        "percent": 0,
        "message": label or "준비 중…",
        "result": None,
        "started_at": time.time(),
        "finished_at": None,
    }
    return tid


def _update(tid: str, **kwargs):
    if tid in _PROGRESS:
        _PROGRESS[tid].update(kwargs)


def get_progress(tid: str) -> Optional[Dict[str, Any]]:
    p = _PROGRESS.get(tid)
    if not p:
        return None
    # 1시간 지난 완료 task는 정리
    if p.get("finished_at") and time.time() - p["finished_at"] > 3600:
        _PROGRESS.pop(tid, None)
        return None
    return p


# ============ 공통 유틸 ============

def _split_supply_vat(total: float, tax_amount: Optional[float] = None) -> Tuple[Decimal, Decimal]:
    """
    총액 → (공급가, 부가세) 분리.
    tax_amount 제공되면 그대로 사용, 없으면 10% 가정 → 공급가 = total / 1.1.
    면세/영세율 거래는 호출자가 tax_amount=0 명시.
    """
    total_d = Decimal(str(total or 0))
    if tax_amount is not None and float(tax_amount) > 0:
        vat = Decimal(str(tax_amount))
        return total_d - vat, vat
    if tax_amount == 0:
        return total_d, Decimal("0")
    # 10% 가정
    supply = (total_d / Decimal("1.1")).quantize(Decimal("1"))
    return supply, total_d - supply


def _parse_date(s: Any) -> date:
    if not s:
        return date.today()
    if isinstance(s, date):
        return s
    s = str(s)
    m = re.match(r'(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})', s)
    if m:
        y, mo, d = m.groups()
        try:
            return date(int(y), int(mo), int(d))
        except ValueError:
            pass
    return date.today()


def _safe_float(v: Any) -> float:
    try:
        return float(v or 0)
    except (ValueError, TypeError):
        return 0.0


# ============ 분개 후보 빌더 ============

def _build_tax_invoice_candidate(
    ticket: Dict[str, Any],
    is_sales: bool,
) -> AutoVoucherCandidate:
    """세금계산서(매출/매입) 분개 후보."""
    total = _safe_float(ticket.get("amount"))
    tax_amount_raw = ticket.get("taxAmount")
    tax_invoice = ticket.get("taxInvoice") or {}

    # 면세 추정 — taxAmount가 명시적으로 0이면 면세
    is_taxable = tax_amount_raw is None or float(tax_amount_raw) > 0
    supply, vat = _split_supply_vat(total, tax_amount_raw if is_taxable else 0)

    counterparty_party = (
        tax_invoice.get("contractor") if is_sales else tax_invoice.get("supplier")
    ) or {}
    counterparty = counterparty_party.get("companyName", "")

    if is_sales:
        debit_lines = [{
            "side": "debit", "account_code": "108", "account_name": "외상매출금",
            "amount": str(supply + vat), "memo": "",
        }]
        credit_lines = [{
            "side": "credit", "account_code": "404", "account_name": "제품매출",
            "amount": str(supply), "memo": "",
        }]
        if vat != 0:
            credit_lines.append({
                "side": "credit", "account_code": "255", "account_name": "부가세예수금",
                "amount": str(vat), "memo": "",
            })
        source_type = (AutoVoucherSourceType.SALES_TAX_INVOICE if is_taxable
                       else AutoVoucherSourceType.SALES_INVOICE)
        sugg_code, sugg_name = "404", "제품매출"
    else:
        # 매입 — 거래처(supplier)별 학습된 계정. 없으면 키워드 분류, 그것도 없으면 153.
        ti_memo = (ti.get("invoice") or {}).get("description") or (ti.get("invoice") or {}).get("memo") or ""
        sugg_code, sugg_name = _suggest_purchase_account(counterparty, description=ti_memo, merchant=counterparty)
        if sugg_code == "153":
            sugg_name = "원재료"
        debit_lines = [{
            "side": "debit", "account_code": sugg_code, "account_name": sugg_name,
            "amount": str(supply), "memo": "",
        }]
        if vat != 0:
            debit_lines.append({
                "side": "debit", "account_code": "135", "account_name": "부가세대급금",
                "amount": str(vat), "memo": "",
            })
        credit_lines = [{
            "side": "credit", "account_code": "251", "account_name": "외상매입금",
            "amount": str(supply + vat), "memo": "",
        }]
        source_type = (AutoVoucherSourceType.PURCHASE_TAX_INVOICE if is_taxable
                       else AutoVoucherSourceType.PURCHASE_INVOICE)

    rich_desc = f"{'매출' if is_sales else '매입'} 세금계산서 · {counterparty}"
    return AutoVoucherCandidate(
        source_type=source_type,
        source_id=str(ticket.get("id", "")),
        status=AutoVoucherStatus.PENDING,
        transaction_date=_parse_date(ticket.get("transactAt")),
        counterparty=counterparty[:200] if counterparty else None,
        description=rich_desc[:500],
        supply_amount=supply,
        vat_amount=vat,
        total_amount=supply + vat,
        confidence=Decimal("0.95"),  # 세계는 분개 패턴 명확
        suggested_account_code=sugg_code,
        suggested_account_name=sugg_name,
        debit_lines=json.dumps(debit_lines, ensure_ascii=False),
        credit_lines=json.dumps(credit_lines, ensure_ascii=False),
        raw_data=json.dumps(ticket, default=str, ensure_ascii=False)[:5000],
    )


def _build_card_candidate(
    ticket: Dict[str, Any],
    ai_account_code: Optional[str] = None,
    ai_account_name: Optional[str] = None,
    ai_confidence: float = 0.6,
) -> AutoVoucherCandidate:
    """카드 매입 분개 후보. AI 분류는 호출자가 미리 결정."""
    total = _safe_float(ticket.get("amount"))
    tax_amount = ticket.get("taxAmount")
    supply, vat = _split_supply_vat(total, tax_amount)

    card_usage = ticket.get("cardUsage") or {}
    merchant = card_usage.get("storeName", "")
    category = card_usage.get("category", "")
    card = card_usage.get("card") or {}
    card_name = (card.get("nickname") or card.get("name") or card.get("organizationName")
                 or ticket.get("cardName") or "")
    # 풍부한 적요: "BC카드 - 스타벅스 (음식점)"
    desc_parts = []
    if card_name: desc_parts.append(card_name.split('|')[0].strip())
    if merchant: desc_parts.append(merchant)
    if category: desc_parts.append(f"({category})")
    rich_desc = " ".join(desc_parts) if desc_parts else (merchant or "카드 결제")

    # AI 추천 없으면 가맹점(=매입처)별 학습된 hint + 키워드 분류 활용, 그것도 없으면 830 소모품비
    if ai_account_code:
        acc_code, acc_name = ai_account_code, ai_account_name or ai_account_code
    else:
        # category(MCC) 정보가 키워드 매칭에 큰 도움
        hint_code, hint_name = _suggest_purchase_account(merchant, description=category, merchant=merchant)
        if hint_code != "153":
            acc_code, acc_name = hint_code, hint_name
        else:
            # 카드는 기본 소모품비(판) — 원재료 카드결제는 드뭄
            acc_code, acc_name = "830", "소모품비(판)"

    debit_lines = [{
        "side": "debit", "account_code": acc_code, "account_name": acc_name,
        "amount": str(supply), "memo": "",
    }]
    if vat > 0:
        debit_lines.append({
            "side": "debit", "account_code": "135", "account_name": "부가세대급금",
            "amount": str(vat), "memo": "",
        })
    credit_lines = [{
        "side": "credit", "account_code": "253", "account_name": "미지급금",
        "amount": str(supply + vat), "memo": card_name,
    }]

    return AutoVoucherCandidate(
        source_type=AutoVoucherSourceType.CARD,
        source_id=str(ticket.get("id", "")),
        status=AutoVoucherStatus.PENDING,
        transaction_date=_parse_date(ticket.get("transactAt")),
        counterparty=merchant[:200] if merchant else None,
        description=rich_desc[:500],
        supply_amount=supply,
        vat_amount=vat,
        total_amount=supply + vat,
        confidence=Decimal(str(ai_confidence)),
        suggested_account_code=acc_code,
        suggested_account_name=acc_name,
        debit_lines=json.dumps(debit_lines, ensure_ascii=False),
        credit_lines=json.dumps(credit_lines, ensure_ascii=False),
        raw_data=json.dumps(ticket, default=str, ensure_ascii=False)[:5000],
    )


def _build_bank_candidate(
    ticket: Dict[str, Any],
    ai_account_code: Optional[str] = None,
    ai_account_name: Optional[str] = None,
    ai_confidence: float = 0.5,
) -> AutoVoucherCandidate:
    """통장 입출금 분개 후보. 거래처 마스터(wehago 학습) 기반 분류:
    - 입금 + 거래처=매출처 → 차변 보통예금 / 대변 매출 + 부가세예수금 (매출 인식)
    - 출금 + 거래처=매입처 → 차변 추천 비용 / 대변 보통예금 (비용 인식)
    - 양쪽이 우리 회사 → 자기 계좌이체 (DUPLICATE 표시, P/L 영향 X)
    - 그 외 → 기존 default (외상매출금 회수 / 미지급금 결제)"""
    total = _safe_float(ticket.get("amount"))
    direction = (ticket.get("transactionType") or "").upper()
    bt = ticket.get("bankTransaction") or {}
    counterparty = bt.get("counterparty") or bt.get("opponent") or ""
    content = bt.get("content") or ""
    # 그랜터 bank ticket은 counterparty가 비어있는 경우가 많음 — content(적요)에 거래처 정보
    if not counterparty and content:
        counterparty = content
    is_in = direction in ("IN", "INBOUND", "DEPOSIT") or "입금" in str(direction)
    rich_parts = ["입금" if is_in else "출금"]
    if counterparty: rich_parts.append(counterparty)
    if content and content != counterparty: rich_parts.append(content)
    rich_desc = " · ".join(rich_parts)

    is_inbound = is_in
    cp_class = _classify_counterparty(
        counterparty,
        direction=("inbound" if is_inbound else "outbound"),
    )
    # default values
    confidence = Decimal(str(ai_confidence))
    sugg_code, sugg_name = ("103", "보통예금")
    status_override = None
    rejected_reason = None

    # --- 분개 결정 ---
    if cp_class == "OUR_ACCOUNT":
        # 자기 계좌이체 — P/L 영향 X. status DUPLICATE.
        debit_lines = [{
            "side": "debit", "account_code": "103", "account_name": "보통예금",
            "amount": str(total), "memo": "자기계좌 이체(추정)",
        }]
        credit_lines = [{
            "side": "credit", "account_code": "103", "account_name": "보통예금",
            "amount": str(total), "memo": "자기계좌 이체(추정)",
        }]
        status_override = AutoVoucherStatus.DUPLICATE
        rejected_reason = "자기 계좌이체 — P/L 미반영"
        sugg_code, sugg_name = "103", "보통예금"
        confidence = Decimal("0.9")
    elif cp_class == "CARD_ISSUER":
        # 카드사 결제 청구 (매월 출금). 비용은 이미 EXPENSE_TICKET candidate에서 분개됨.
        # 출금: 차변 253 미지급금 / 대변 103 보통예금
        debit_lines = [{
            "side": "debit", "account_code": "253", "account_name": "미지급금",
            "amount": str(total), "memo": "카드사 결제 청구",
        }]
        credit_lines = [{
            "side": "credit", "account_code": "103", "account_name": "보통예금",
            "amount": str(total), "memo": counterparty,
        }]
        sugg_code, sugg_name = "253", "미지급금"
        confidence = Decimal("0.85")
    elif is_inbound and cp_class == "SALES_CUSTOMER":
        # 매출 거래처 입금 → 매출 인식 (부가세 10% 자동 분리)
        # supply + vat = total, vat = total / 11
        try:
            from decimal import Decimal as _D, ROUND_HALF_UP
            t = _D(str(total))
            vat = (t / _D("11")).quantize(_D("1"), rounding=ROUND_HALF_UP)
            supply = t - vat
        except Exception:
            supply, vat = Decimal(str(total)), Decimal("0")
        debit_lines = [{
            "side": "debit", "account_code": "103", "account_name": "보통예금",
            "amount": str(total), "memo": "",
        }]
        credit_lines = [
            {"side": "credit", "account_code": "404", "account_name": "제품매출",
             "amount": str(supply), "memo": counterparty},
            {"side": "credit", "account_code": "255", "account_name": "부가세예수금",
             "amount": str(vat), "memo": ""},
        ]
        sugg_code, sugg_name = "404", "제품매출"
        confidence = Decimal("0.85")
    elif (not is_inbound) and cp_class == "PURCHASE_VENDOR":
        # 매입처 출금 → 비용 인식 (거래처 hint + 키워드 분류 + 부가세 10%)
        hint_code, _ = _suggest_purchase_account(counterparty, description=content, merchant=counterparty)
        try:
            from decimal import Decimal as _D, ROUND_HALF_UP
            t = _D(str(total))
            vat = (t / _D("11")).quantize(_D("1"), rounding=ROUND_HALF_UP)
            supply = t - vat
        except Exception:
            supply, vat = Decimal(str(total)), Decimal("0")
        debit_lines = [
            {"side": "debit", "account_code": hint_code, "account_name": hint_code,
             "amount": str(supply), "memo": counterparty},
            {"side": "debit", "account_code": "135", "account_name": "부가세대급금",
             "amount": str(vat), "memo": ""},
        ]
        credit_lines = [{
            "side": "credit", "account_code": "103", "account_name": "보통예금",
            "amount": str(total), "memo": "",
        }]
        sugg_code, sugg_name = hint_code, hint_code
        confidence = Decimal("0.80")
    else:
        # 기존 default: 입금→외상매출금 회수 / 출금→미지급금 결제
        if ai_account_code:
            acc_code, acc_name = ai_account_code, ai_account_name or ai_account_code
        else:
            acc_code = "108" if is_inbound else "253"
            acc_name = "외상매출금" if is_inbound else "미지급금"
        if is_inbound:
            debit_lines = [{
                "side": "debit", "account_code": "103", "account_name": "보통예금",
                "amount": str(total), "memo": "",
            }]
            credit_lines = [{
                "side": "credit", "account_code": acc_code, "account_name": acc_name,
                "amount": str(total), "memo": "",
            }]
        else:
            debit_lines = [{
                "side": "debit", "account_code": acc_code, "account_name": acc_name,
                "amount": str(total), "memo": "",
            }]
            credit_lines = [{
                "side": "credit", "account_code": "103", "account_name": "보통예금",
                "amount": str(total), "memo": "",
            }]
        sugg_code, sugg_name = acc_code, acc_name

    return AutoVoucherCandidate(
        source_type=AutoVoucherSourceType.BANK,
        source_id=str(ticket.get("id", "")),
        status=status_override or AutoVoucherStatus.PENDING,
        transaction_date=_parse_date(ticket.get("transactAt")),
        counterparty=counterparty[:200] if counterparty else None,
        description=rich_desc[:500],
        supply_amount=Decimal(str(total)),
        vat_amount=Decimal("0"),
        total_amount=Decimal(str(total)),
        confidence=confidence,
        suggested_account_code=sugg_code,
        suggested_account_name=sugg_name,
        debit_lines=json.dumps(debit_lines, ensure_ascii=False),
        credit_lines=json.dumps(credit_lines, ensure_ascii=False),
        raw_data=json.dumps(ticket, default=str, ensure_ascii=False)[:5000],
        rejected_reason=rejected_reason,
    )


def _build_cash_receipt_candidate(
    ticket: Dict[str, Any],
    ai_account_code: Optional[str] = None,
    ai_account_name: Optional[str] = None,
    ai_confidence: float = 0.6,
    our_business_number: Optional[str] = None,
) -> AutoVoucherCandidate:
    """현금영수증 분개 후보 — issuer가 우리 회사면 매출, 아니면 매입.

    매출: 차변 현금 / 대변 매출 + 부가세예수금
    매입: 차변 비용 + 부가세대급금 / 대변 현금
    """
    total = _safe_float(ticket.get("amount"))
    tax_amount = ticket.get("taxAmount")

    cr = ticket.get("cashReceipt") or {}
    issuer = cr.get("issuer") or {}
    issuer_name = issuer.get("companyName") or ""
    issuer_regnum = (issuer.get("registrationNumber") or "").replace("-", "")

    # cashReceipt.supplyValue / vat 직접 사용 (있으면)
    cr_supply = _safe_float(cr.get("supplyValue"))
    cr_vat = _safe_float(cr.get("vat"))
    if cr_supply > 0 or cr_vat > 0:
        supply, vat = Decimal(str(cr_supply)), Decimal(str(cr_vat))
    else:
        supply, vat = _split_supply_vat(total, tax_amount)

    # 매출/매입 판정: ticket.transactionType=='IN' 이거나 issuer가 우리 회사면 매출
    txn_type = (ticket.get("transactionType") or "").upper()
    is_sales = (
        txn_type in ("IN", "INBOUND")
        or (our_business_number and issuer_regnum == our_business_number)
    )

    if is_sales:
        # 매출: 차변 현금 / 대변 매출 + 부가세예수금
        debit_lines = [{
            "side": "debit", "account_code": "101", "account_name": "현금",
            "amount": str(supply + vat), "memo": "",
        }]
        credit_lines = [{
            "side": "credit", "account_code": "404", "account_name": "제품매출",
            "amount": str(supply), "memo": "",
        }]
        if vat != 0:
            credit_lines.append({
                "side": "credit", "account_code": "255", "account_name": "부가세예수금",
                "amount": str(vat), "memo": "",
            })
        acc_code, acc_name = "404", "제품매출"
        rich_desc = f"현금영수증 매출 · {issuer_name}" if issuer_name else "현금영수증 매출"
    else:
        # 매입: 차변 비용 + 부가세대급금 / 대변 현금
        acc_code = ai_account_code or "830"
        acc_name = ai_account_name or "소모품비(판)"
        debit_lines = [{
            "side": "debit", "account_code": acc_code, "account_name": acc_name,
            "amount": str(supply), "memo": "",
        }]
        if vat != 0:
            debit_lines.append({
                "side": "debit", "account_code": "135", "account_name": "부가세대급금",
                "amount": str(vat), "memo": "",
            })
        credit_lines = [{
            "side": "credit", "account_code": "101", "account_name": "현금",
            "amount": str(supply + vat), "memo": "",
        }]
        rich_desc = f"현금영수증 매입 · {issuer_name}" if issuer_name else "현금영수증 매입"
    return AutoVoucherCandidate(
        source_type=AutoVoucherSourceType.CASH_RECEIPT,
        source_id=str(ticket.get("id", "")),
        status=AutoVoucherStatus.PENDING,
        transaction_date=_parse_date(ticket.get("transactAt")),
        counterparty=issuer_name[:200] if issuer_name else None,
        description=rich_desc[:500],
        supply_amount=supply,
        vat_amount=vat,
        total_amount=supply + vat,
        confidence=Decimal(str(ai_confidence)),
        suggested_account_code=acc_code,
        suggested_account_name=acc_name,
        debit_lines=json.dumps(debit_lines, ensure_ascii=False),
        credit_lines=json.dumps(credit_lines, ensure_ascii=False),
        raw_data=json.dumps(ticket, default=str, ensure_ascii=False)[:5000],
    )


# ============ 메인 진입점 ============

async def _generate_candidates_core(
    db: AsyncSession,
    start_date: date,
    end_date: date,
    asset_id: Optional[int] = None,
    task_id: Optional[str] = None,
) -> Dict[str, Any]:
    """청크 단위로 그랜터 호출 + 진행률 보고. db는 호출자 책임 (commit도)."""
    client = get_granter_client()

    def _report(pct: int, msg: str):
        if task_id:
            _update(task_id, percent=pct, message=msg)

    _report(3, "거래처 마스터 캐시 빌드 중 (wehago 학습 + 그랜터 계좌)…")
    await _build_counterparty_cache(force=False)

    _report(5, f"그랜터에서 거래 수집 중… ({start_date}~{end_date})")
    tickets = await client.list_tickets_all_types(
        start_date.isoformat(),
        end_date.isoformat(),
        asset_id=asset_id,
    )
    _report(60, "수집 완료. 분개 후보 생성 중…")

    # 중복 방지용 기존 source_id
    existing = (await db.execute(
        select(AutoVoucherCandidate.source_id)
        .where(AutoVoucherCandidate.source_id.isnot(None))
    )).all()
    existing_ids = {row[0] for row in existing if row[0]}

    counts = {
        "sales_tax_invoice": 0, "purchase_tax_invoice": 0,
        "card": 0, "bank": 0, "cash_receipt": 0,
        "skipped": 0, "errors": 0,
    }

    for t in tickets.get("TAX_INVOICE_TICKET", []) or []:
        tid = str(t.get("id", ""))
        if tid and tid in existing_ids:
            counts["skipped"] += 1
            continue
        try:
            # 사업자번호 기반 판정 — 그랜터의 transactionType="OUT"이 매입이라 키워드 매칭은 위험
            is_sales = _is_sales_tax_invoice(t)
            cand = _build_tax_invoice_candidate(t, is_sales=is_sales)
            db.add(cand)
            if is_sales:
                counts["sales_tax_invoice"] += 1
            else:
                counts["purchase_tax_invoice"] += 1
        except Exception as e:
            logger.warning(f"세금계산서 후보 생성 오류 ticket={t.get('id')}: {e}")
            counts["errors"] += 1

    for t in tickets.get("EXPENSE_TICKET", []) or []:
        tid = str(t.get("id", ""))
        if tid and tid in existing_ids:
            counts["skipped"] += 1
            continue
        try:
            cand = _build_card_candidate(t)
            db.add(cand)
            counts["card"] += 1
        except Exception as e:
            logger.warning(f"카드 후보 생성 오류 ticket={t.get('id')}: {e}")
            counts["errors"] += 1

    for t in tickets.get("BANK_TRANSACTION_TICKET", []) or []:
        tid = str(t.get("id", ""))
        if tid and tid in existing_ids:
            counts["skipped"] += 1
            continue
        try:
            cand = _build_bank_candidate(t)
            db.add(cand)
            counts["bank"] += 1
        except Exception as e:
            logger.warning(f"통장 후보 생성 오류 ticket={t.get('id')}: {e}")
            counts["errors"] += 1

    for t in tickets.get("CASH_RECEIPT_TICKET", []) or []:
        tid = str(t.get("id", ""))
        if tid and tid in existing_ids:
            counts["skipped"] += 1
            continue
        try:
            cand = _build_cash_receipt_candidate(t, our_business_number=OUR_BUSINESS_NUMBER)
            db.add(cand)
            counts["cash_receipt"] += 1
        except Exception as e:
            logger.warning(f"현금영수증 후보 생성 오류 ticket={t.get('id')}: {e}")
            counts["errors"] += 1

    _report(90, "DB 커밋 중…")
    await db.commit()

    counts["total_created"] = (
        counts["sales_tax_invoice"] + counts["purchase_tax_invoice"]
        + counts["card"] + counts["bank"] + counts["cash_receipt"]
    )
    counts["period"] = f"{start_date} ~ {end_date}"
    return counts


async def generate_candidates_for_period(
    db: AsyncSession,
    start_date: date,
    end_date: date,
    asset_id: Optional[int] = None,
) -> Dict[str, Any]:
    """Foreground 호출 (소규모 기간용). 진행률 추적 없음."""
    return await _generate_candidates_core(db, start_date, end_date, asset_id, task_id=None)


async def generate_candidates_background(
    start_date: date,
    end_date: date,
    asset_id: Optional[int] = None,
    auto_match_duplicates: bool = True,
) -> str:
    """
    백그라운드 task로 후보 생성. task_id 즉시 반환.
    호출자는 /auto-voucher/progress/{task_id}로 폴링.
    """
    task_id = _new_task(f"후보 생성 시작 ({start_date}~{end_date})")

    async def _runner():
        try:
            async with async_session_factory() as db:
                result = await _generate_candidates_core(
                    db, start_date, end_date, asset_id, task_id=task_id,
                )
                if auto_match_duplicates:
                    _update(task_id, percent=92, message="카드↔통장 중복 매칭…")
                    match_result = await match_card_bank_duplicates(db, start_date, end_date)
                    result["duplicate_matching"] = match_result
                    _update(task_id, percent=95, message="위하고 분개 묶음 중복 검사…")
                    voucher_dup = await match_voucher_duplicates_grouped(db, start_date, end_date)
                    result["voucher_duplicate_matching"] = voucher_dup
                    _update(task_id, percent=98, message="확정 분개 기간 후보 자동 정리…")
                    rejected = await reject_candidates_in_confirmed_period(db, start_date, end_date)
                    result["confirmed_period_rejected"] = rejected
                _update(task_id, status="completed", percent=100,
                        message=f"완료 — {result.get('total_created', 0)}건 생성",
                        result=result, finished_at=time.time())
        except Exception as e:
            logger.exception("백그라운드 후보 생성 실패")
            _update(task_id, status="failed", message=f"실패: {str(e)[:200]}",
                    finished_at=time.time())

    asyncio.create_task(_runner())
    return task_id


# ============ 카드 ↔ 통장 중복 매칭 ============

async def match_card_bank_duplicates(
    db: AsyncSession,
    start_date: date,
    end_date: date,
    day_window: int = 35,
) -> Dict[str, int]:
    """
    카드 사용액 (EXPENSE) ↔ 통장 결제 출금 (BANK OUT) 매칭.
    매칭 키: 카드사명 매칭 + 금액 매칭 + 결제일이 카드 사용일 이후 N일 이내 (default 35일).

    매칭되면 통장 거래의 status = DUPLICATE 로 표시 (카드 후보가 원전표).
    """
    # 기간 내 카드 후보 (status=PENDING)
    card_rows = (await db.execute(
        select(AutoVoucherCandidate).where(
            AutoVoucherCandidate.source_type == AutoVoucherSourceType.CARD,
            AutoVoucherCandidate.status == AutoVoucherStatus.PENDING,
            AutoVoucherCandidate.transaction_date >= start_date,
            AutoVoucherCandidate.transaction_date <= end_date,
        )
    )).scalars().all()

    # 기간 ±day_window 내 통장 출금 후보
    bank_rows = (await db.execute(
        select(AutoVoucherCandidate).where(
            AutoVoucherCandidate.source_type == AutoVoucherSourceType.BANK,
            AutoVoucherCandidate.status == AutoVoucherStatus.PENDING,
            AutoVoucherCandidate.transaction_date >= start_date,
            AutoVoucherCandidate.transaction_date <= end_date + timedelta(days=day_window),
        )
    )).scalars().all()

    # 카드 description에 카드사명이 있음 (e.g. '신한카드', '비씨카드') — 매칭 시 활용
    # 단순화: 통장 description/counterparty에 '카드'·카드사명 포함 + 금액 일치 + 날짜 이후
    matched = 0

    # 통장 후보를 (counterparty/desc에 '카드' 포함된 것만) 필터
    card_payment_bank = [
        b for b in bank_rows
        if (b.description and "카드" in (b.description or "")) or
           (b.counterparty and "카드" in (b.counterparty or ""))
    ]

    # 통장 후보 indexing: amount → list
    bank_by_amount: Dict[Decimal, list] = {}
    for b in card_payment_bank:
        bank_by_amount.setdefault(b.total_amount, []).append(b)

    for c in card_rows:
        # 카드 결제 = 같은 금액의 통장 출금 (모든 카드 사용을 묶어 월별 청구한 결과인 경우도 있어서
        # 1:1 매칭이 안 될 수 있음 — 일단 단일 금액 매칭만)
        candidates = bank_by_amount.get(c.total_amount, [])
        for b in candidates:
            if b.duplicate_of_id is not None:
                continue  # 이미 매칭됨
            # 날짜 조건: 통장 결제일이 카드 사용일 이후 + day_window 이내
            if b.transaction_date < c.transaction_date:
                continue
            if (b.transaction_date - c.transaction_date).days > day_window:
                continue
            # 카드사명 매칭 (선택적): 통장 desc에 카드사명 포함 — 이미 필터로 거른 상태
            b.duplicate_of_id = c.id
            b.status = AutoVoucherStatus.DUPLICATE
            matched += 1
            break

    await db.commit()
    return {"matched_pairs": matched, "checked_cards": len(card_rows), "checked_banks": len(card_payment_bank)}


# ============ Voucher (위하고 import 등) 중복 매칭 ============

async def match_voucher_duplicates_core(
    db: AsyncSession,
    start_date: date,
    end_date: date,
    day_window: int = 3,
    amount_tolerance: Decimal = Decimal("1"),
) -> Dict[str, int]:
    """
    PENDING 후보 ↔ 기존 Voucher (위하고 import, manual 등) 중복 매칭.

    매칭 조건:
      - 날짜 차이 ≤ day_window
      - 금액 차이 ≤ amount_tolerance
      - 거래처 부분일치 (한쪽 비면 통과)

    매칭되면 candidate.status=DUPLICATE + duplicate_voucher_id 저장.
    """
    pendings = (await db.execute(
        select(AutoVoucherCandidate).where(
            AutoVoucherCandidate.status == AutoVoucherStatus.PENDING,
            AutoVoucherCandidate.transaction_date >= start_date,
            AutoVoucherCandidate.transaction_date <= end_date,
        )
    )).scalars().all()

    vouchers = (await db.execute(
        select(Voucher).where(
            Voucher.transaction_date >= start_date - timedelta(days=day_window),
            Voucher.transaction_date <= end_date + timedelta(days=day_window),
            Voucher.status == VoucherStatus.CONFIRMED,
        )
    )).scalars().all()

    matched = 0
    for c in pendings:
        cp = (c.counterparty or "").strip()
        c_amt = Decimal(str(c.total_amount or 0))
        for v in vouchers:
            if abs((v.transaction_date - c.transaction_date).days) > day_window:
                continue
            v_amt = Decimal(str(v.total_debit or 0))
            if abs(v_amt - c_amt) > amount_tolerance:
                continue
            vp = (v.merchant_name or "").strip()
            if cp and vp:
                cp10 = cp[:10]
                vp10 = vp[:10]
                if cp10 not in vp and vp10 not in cp:
                    continue
            c.status = AutoVoucherStatus.DUPLICATE
            c.duplicate_voucher_id = v.id
            matched += 1
            break

    await db.commit()
    return {
        "matched": matched,
        "checked_candidates": len(pendings),
        "checked_vouchers": len(vouchers),
    }


def _normalize_counterparty(name: Optional[str]) -> str:
    """거래처명 정규화: '비씨카드(3917)_마케팅' → '비씨카드'."""
    if not name:
        return ""
    import re
    s = re.sub(r'\([^)]*\)', '', name)   # 괄호 제거
    s = re.sub(r'[_\-/].*$', '', s)       # 첫 구분자 이후 절단
    return s.strip().lower()[:10]


async def reject_candidates_in_confirmed_period(
    db: AsyncSession,
    start_date: date,
    end_date: date,
    confirmed_sources: Optional[List[str]] = None,
    duplicate_only: bool = True,
) -> Dict[str, int]:
    """
    확정 분개장(위하고/더존)이 있는 기간의 PENDING 후보 정리.

    duplicate_only=True (기본 — 안전):
        duplicate_voucher_id가 명확히 매치된 후보만 거절.
        매칭 안 된 후보는 보존하여 사용자 검수 가능.

    duplicate_only=False (구버전 — 공격적):
        해당 날짜의 모든 PENDING 후보를 거절.
        같은 날짜에 무관한 거래라도 거절되는 부작용 있음.
    """
    if confirmed_sources is None:
        confirmed_sources = ["wehago_import", "douzone_journal"]

    if duplicate_only:
        # 안전 모드: duplicate_voucher_id가 있고 PENDING인 것만 거절
        cands_q = select(AutoVoucherCandidate).where(
            AutoVoucherCandidate.status == AutoVoucherStatus.PENDING,
            AutoVoucherCandidate.duplicate_voucher_id.isnot(None),
            AutoVoucherCandidate.transaction_date >= start_date,
            AutoVoucherCandidate.transaction_date <= end_date,
        )
        cands = (await db.execute(cands_q)).scalars().all()
        rejected = 0
        for c in cands:
            c.status = AutoVoucherStatus.REJECTED
            c.rejected_reason = "위하고/더존 분개와 중복 매칭 — 자동 거절"
            rejected += 1
        await db.commit()
        return {
            "rejected": rejected,
            "mode": "duplicate_only",
            "preserved_pending_in_period": True,
        }

    # 공격적 모드 (구버전 호환)
    v_dates_q = (
        select(Voucher.transaction_date)
        .where(
            Voucher.source.in_(confirmed_sources),
            Voucher.transaction_date >= start_date,
            Voucher.transaction_date <= end_date,
        )
        .distinct()
    )
    v_dates = [r[0] for r in (await db.execute(v_dates_q)).all() if r[0]]
    if not v_dates:
        return {"rejected": 0, "confirmed_dates": 0, "mode": "aggressive_date_match"}
    cands_q = select(AutoVoucherCandidate).where(
        AutoVoucherCandidate.status == AutoVoucherStatus.PENDING,
        AutoVoucherCandidate.transaction_date.in_(v_dates),
    )
    cands = (await db.execute(cands_q)).scalars().all()
    rejected = 0
    for c in cands:
        c.status = AutoVoucherStatus.REJECTED
        c.rejected_reason = "확정 분개장(위하고/더존)이 있는 기간 — 자동 거절"
        rejected += 1
    await db.commit()
    return {
        "rejected": rejected,
        "confirmed_dates": len(v_dates),
        "mode": "aggressive_date_match",
        "min_date": min(v_dates).isoformat() if v_dates else None,
        "max_date": max(v_dates).isoformat() if v_dates else None,
    }


async def match_voucher_duplicates_grouped(
    db: AsyncSession,
    start_date: date,
    end_date: date,
    day_window: int = 3,
) -> Dict[str, int]:
    """
    분개 단위 묶음 매칭 — 위하고 voucher 1개가 그랜터 후보 N개와 매칭되는 경우.

    위하고 분개장은 회계 처리 완료된 거래만 모음. 한 분개에 한 거래처의 여러 거래
    가 묶일 수 있음 (예: 한 카드사 월 청구 = 카드 결제 N건).

    매칭 기준: (날짜 ±day_window, 정규화된 거래처) 일치하면 DUPLICATE.
    1:1 amount 검사 없음 — N건이 합쳐서 분개되었다는 전제.
    """
    # 위하고 voucher의 (날짜, 거래처) 매핑
    v_q = select(Voucher.id, Voucher.transaction_date, Voucher.merchant_name).where(
        Voucher.status == VoucherStatus.CONFIRMED,
        Voucher.transaction_date >= start_date - timedelta(days=day_window),
        Voucher.transaction_date <= end_date + timedelta(days=day_window),
    )
    voucher_index: Dict[tuple, int] = {}
    for v in (await db.execute(v_q)).all():
        key = (v.transaction_date, _normalize_counterparty(v.merchant_name))
        if key[1]:  # 빈 거래처는 매칭 키 안 됨
            voucher_index.setdefault(key, v.id)

    # 매칭 후보
    pendings = (await db.execute(
        select(AutoVoucherCandidate).where(
            AutoVoucherCandidate.status == AutoVoucherStatus.PENDING,
            AutoVoucherCandidate.transaction_date >= start_date,
            AutoVoucherCandidate.transaction_date <= end_date,
        )
    )).scalars().all()

    matched = 0
    for c in pendings:
        norm = _normalize_counterparty(c.counterparty)
        if not norm:
            continue
        v_id = None
        for offset in (0, -1, 1, -2, 2, -3, 3):
            test = c.transaction_date + timedelta(days=offset)
            v_id = voucher_index.get((test, norm))
            if v_id:
                break
        if v_id:
            c.status = AutoVoucherStatus.DUPLICATE
            c.duplicate_voucher_id = v_id
            matched += 1

    await db.commit()
    return {
        "matched": matched,
        "checked_candidates": len(pendings),
        "voucher_keys": len(voucher_index),
    }
