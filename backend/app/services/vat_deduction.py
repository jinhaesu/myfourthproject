"""
카드 사용건 부가세 매입세액 공제 참고 판정 (자동판정, 참고용).
원장·부가세 신고에는 자동 반영하지 않는다.

판정 우선순위:
  1) 법정 불공제 계정(접대비/기업업무추진비, 기부금) -> 불공제 (번호 유무 무관)
  2) 사업자번호 없음 -> 확인필요
  3) 가맹점 과세유형: 면세 -> 불공제 / 간이(세금계산서 비발급) -> 불공제 / 폐업(거래일 이후) -> 불공제
  4) 차량 관련 계정(차량유지비 등) -> 확인필요 (차종 미상)
  5) 일반과세자(또는 세금계산서 발급 간이) -> 공제
  6) 그 외(과세유형 미확인, 휴업, 개인사업자 일반/간이 미구분) -> 확인필요
"""
import re
from typing import Any, Dict, Optional

# 3자리 운영 계정코드 (reference_myfourthproject_accounts)
NONDEDUCT_CODES = {"813": "접대비(기업업무추진비)", "953": "기부금"}
VEHICLE_CODES = {"822": "차량유지비"}
_NONDEDUCT_NAME = re.compile(r"접대|기업업무추진|기부")
_VEHICLE_NAME = re.compile(r"차량|유류|주유|렌트|리스료|자동차")

KIND_GENERAL = "일반과세자"
KIND_SIMPLE = "간이과세자"
KIND_SIMPLE_INV = "간이과세자(세금계산서)"
KIND_EXEMPT = "면세사업자"
KIND_UNKNOWN = "미확인"


def digits(v: Optional[str]) -> str:
    return re.sub(r"\D", "", v or "")


def fmt_biz(v: Optional[str]) -> Optional[str]:
    d = digits(v)
    return f"{d[:3]}-{d[3:5]}-{d[5:]}" if len(d) == 10 else None


def kind_from_number(biz_no: str) -> Optional[str]:
    """사업자번호 4~5째 자리(구분코드)로 추정 가능한 과세유형. 영리법인(81,85,86,87,88)=일반과세,
    90~99=개인 면세사업자. 개인 과세(01~79)는 일반/간이 구분 불가 -> None."""
    d = digits(biz_no)
    if len(d) != 10:
        return None
    mid = int(d[3:5])
    if mid in (81, 85, 86, 87, 88):
        return KIND_GENERAL
    if 90 <= mid <= 99:
        return KIND_EXEMPT
    return None


def kind_from_nts(tax_type_cd: Optional[str], raw_text: Optional[str], invoice_apply_dt: Optional[str] = None) -> Optional[str]:
    raw = raw_text or ""
    if "일반" in raw:
        return KIND_GENERAL
    if "면세" in raw:
        return KIND_EXEMPT
    if "간이" in raw:
        return KIND_SIMPLE_INV if ("세금계산서" in raw or tax_type_cd == "06" or (invoice_apply_dt or "").strip()) else KIND_SIMPLE
    return None


def kind_from_hyphen(tax_type: Optional[str]) -> Optional[str]:
    """561 매입내역의 taxType 텍스트 -> 과세유형 (값 형식 미확정이라 키워드 기반)."""
    t = tax_type or ""
    if "면세" in t:
        return KIND_EXEMPT
    if "간이" in t:
        return KIND_SIMPLE_INV if "세금계산서" in t else KIND_SIMPLE
    if "일반" in t or "법인" in t:   # 법인사업자는 일반과세자
        return KIND_GENERAL
    return None


def judge(
    biz_no: Optional[str],
    *,
    status_row: Optional[Dict[str, Any]] = None,
    hyphen_tax_type: Optional[str] = None,
    ht_kind: Optional[str] = None,
    ht_deduct: Optional[str] = None,
    ht_reason: Optional[str] = None,
    account_code: Optional[str] = None,
    account_name: Optional[str] = None,
    tx_date: Optional[str] = None,
) -> Dict[str, Any]:
    """returns {tax_kind, tax_kind_src, status, deduct: 공제|불공제|확인필요, reason}"""
    d = digits(biz_no)
    kind, ksrc = None, None
    st = status_row or {}
    if st.get("tax_kind") in (KIND_GENERAL, KIND_SIMPLE, KIND_SIMPLE_INV, KIND_EXEMPT):
        kind, ksrc = st["tax_kind"], "국세청"
    if kind is None:
        k = kind_from_hyphen(ht_kind)
        if k:
            kind, ksrc = k, "홈택스"
    if kind is None:
        k = kind_from_hyphen(hyphen_tax_type)
        if k:
            kind, ksrc = k, "카드사"
    if kind is None and len(d) == 10:
        k = kind_from_number(d)
        if k:
            kind, ksrc = k, "번호추정"
    status = st.get("status")  # 계속/휴업/폐업

    def out(deduct, reason):
        return {"tax_kind": kind or KIND_UNKNOWN, "tax_kind_src": ksrc, "status": status,
                "deduct": deduct, "reason": reason}

    code = (account_code or "").strip()
    name = account_name or ""
    # 접대비/기부금은 가맹점·번호 유무와 무관하게 불공제
    if code in NONDEDUCT_CODES or (name and _NONDEDUCT_NAME.search(name)):
        return out("불공제", f"법정 불공제 계정: {NONDEDUCT_CODES.get(code) or name}")
    if len(d) != 10:
        return out("확인필요", "사업자번호 없음 — 증빙 확인 필요")

    # 홈택스 '선택불공제'는 공제 대상이나 아직 공제 선택을 안 한 상태(법정 불공제 아님) -> 판정에 쓰지 않음.
    # 당연불공제/면세불공제/간이불공제만 법정 불공제로 반영.
    if ht_deduct == "불공제" and ht_reason and "선택" not in ht_reason:
        return out("불공제", f"홈택스 {ht_reason}")
    if kind == KIND_EXEMPT:
        return out("불공제", "면세사업자(부가세 없음)")
    if kind == KIND_SIMPLE:
        return out("불공제", "간이과세자(세금계산서 발급 불가 구간)")
    if status == "폐업":
        ed = st.get("end_dt") or ""
        td = (tx_date or "").replace("-", "")[:8]
        if ed and td and td >= ed:
            return out("불공제", f"폐업 사업자(폐업일 {ed})")
        if not ed:
            return out("확인필요", "폐업 사업자 - 폐업일 미상")
    if status == "휴업":
        return out("확인필요", "휴업 사업자 - 거래시점 상태 확인 필요")

    if code in VEHICLE_CODES or (name and _VEHICLE_NAME.search(name)):
        return out("확인필요", "차량 관련 지출 - 비영업용 소형승용차(개별소비세 과세대상) 여부 확인")

    if kind in (KIND_GENERAL, KIND_SIMPLE_INV):
        if not code:
            return out("공제", f"{kind} (계정 미분류 - 분류 후 재판정)")
        return out("공제", f"{kind}")
    return out("확인필요", "과세유형 미확인(개인사업자 일반/간이 구분 불가) - 국세청 조회 필요")


def vat_split(amount: float, kind: Optional[str]) -> Dict[str, float]:
    """VAT 포함 카드금액 -> 공급가/부가세 (amount/11). 면세사업자는 부가세 0."""
    a = float(amount or 0)
    if kind == KIND_EXEMPT:
        return {"supply": a, "vat": 0.0}
    vat = round(a / 11.0)
    return {"supply": a - vat, "vat": float(vat)}


def summarize(rows) -> Dict[str, Any]:
    """rows: [{amount, deduct, tax_kind}] -> 공제/불공제/확인필요별 건수·합계·공급가·부가세"""
    s: Dict[str, Dict[str, float]] = {}
    for r in rows:
        k = r.get("deduct") or "확인필요"
        b = s.setdefault(k, {"count": 0, "amount": 0.0, "supply": 0.0, "vat": 0.0})
        sp = vat_split(r.get("amount") or 0, r.get("tax_kind"))
        b["count"] += 1
        b["amount"] += float(r.get("amount") or 0)
        b["supply"] += sp["supply"]
        b["vat"] += sp["vat"]
    return s
