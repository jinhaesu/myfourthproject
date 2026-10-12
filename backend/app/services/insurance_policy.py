"""
외국인 포함 4대보험 산정 기준(규칙엔진) — DB 저장·회계팀 편집 가능 구조.

배경(2026-10-12 대표 지시): 현장 정규직 급여 변동폭 큼 + 외국인 체류자격(비자)·국적별
가입여부/요율 상이 → 기준을 명시 규칙으로 두되, 회계팀이 화면에서 업데이트하고
시스템 계산이 그 저장값을 읽어 동작하도록 한다. 본 모듈은 순수 산정 로직 + 기본값이며,
요율/비자규칙/근로자 개별설정은 DB(insurance_rate·insurance_visa_rule·insurance_worker_override)에서
주입된다. 각 보험의 산정근거(basis)와 수동확인 플래그를 함께 반환.

대상: 실제 근로자 = 정규직. 알바(사업소득 3.3%)·파견(파견업체 부담)은 4대보험 대상 아님.
"""
from __future__ import annotations
from typing import Any, Dict, List, Optional

# ───────── 기본 요율/기준 (2026, 회계팀/공단 확정 대상 · DB에서 덮어씀) ─────────
DEFAULT_RATES: Dict[str, float] = {
    "pension_emp": 0.0475,       # 국민연금 근로자 (총 9.5%)
    "health_emp": 0.03595,       # 건강보험 근로자 (총 7.19%)
    "ltc_on_health": 0.1314,     # 장기요양 = 건강보험료 × 13.14%
    "employment_ui_emp": 0.009,  # 고용보험 실업급여 근로자 0.9%
    "pension_base_min": 410000,  # 기준소득월액 하한(2026.7)
    "pension_base_max": 6590000, # 기준소득월액 상한(2026.7)
}
SOURCES = [
    "국민연금 외국 연금제도 조사표(NPS, 상호주의 국가목록)",
    "근로복지공단 외국인 고용보험 체류자격별 적용 안내",
    "국민건강보험공단 외국인 건강보험/장기요양 적용·제외 안내",
    "2026 요율: 국민연금 9.5%·건강 7.19%·장기요양 건강료의 13.14%·고용 실업급여 1.8%·산재 평균 1.47%",
]

# status 어휘: pension ∈ {mandatory, excluded, reciprocity, optional}
#             health ∈ {mandatory, excluded}
#             employment ∈ {mandatory, e9h2, optional, excluded}
#             ltc_exclusion_eligible ∈ {True, False}
def _rule(pension, health, employment, ltc_elig, label):
    return {"pension": pension, "health": health, "employment": employment,
            "ltc_exclusion_eligible": ltc_elig, "label": label}

# 체류자격별 기본 규칙(회계팀이 DB에서 가감 가능)
DEFAULT_VISA_RULES: Dict[str, Dict[str, Any]] = {
    "KR":  _rule("mandatory", "mandatory", "mandatory", False, "내국인"),
    "F-2": _rule("mandatory", "mandatory", "mandatory", False, "거주"),
    "F-4": _rule("mandatory", "mandatory", "mandatory", False, "재외동포"),
    "F-5": _rule("mandatory", "mandatory", "mandatory", False, "영주"),
    "F-6": _rule("mandatory", "mandatory", "mandatory", False, "결혼이민"),
    "E-1": _rule("reciprocity", "mandatory", "optional", False, "교수"),
    "E-2": _rule("reciprocity", "mandatory", "optional", False, "회화지도"),
    "E-3": _rule("reciprocity", "mandatory", "optional", False, "연구"),
    "E-4": _rule("reciprocity", "mandatory", "optional", False, "기술지도"),
    "E-5": _rule("reciprocity", "mandatory", "optional", False, "전문직업"),
    "E-6": _rule("reciprocity", "mandatory", "optional", False, "예술흥행"),
    "E-7": _rule("reciprocity", "mandatory", "optional", False, "특정활동"),
    "E-8": _rule("reciprocity", "mandatory", "optional", True, "계절근로"),
    "E-9": _rule("reciprocity", "mandatory", "e9h2", True, "비전문취업"),
    "E-10": _rule("reciprocity", "mandatory", "optional", False, "선원취업"),
    "H-2": _rule("reciprocity", "mandatory", "e9h2", True, "방문취업"),
    "D-2": _rule("excluded", "mandatory", "excluded", False, "유학"),
    "D-3": _rule("excluded", "mandatory", "excluded", True, "기술연수"),
    "D-4": _rule("excluded", "mandatory", "excluded", False, "일반연수"),
    "D-6": _rule("excluded", "mandatory", "excluded", False, "종교"),
    "F-1": _rule("excluded", "mandatory", "excluded", False, "방문동거"),
    "F-3": _rule("excluded", "mandatory", "excluded", False, "동반"),
    "C-4": _rule("excluded", "mandatory", "optional", False, "단기취업"),
    "G-1": _rule("excluded", "mandatory", "excluded", False, "기타"),
}


def _norm_visa(v: Optional[str]) -> str:
    return (v or "").strip().upper().replace(" ", "")


def resolve_rule(visa: str, is_foreign: bool,
                 db_rules: Optional[Dict[str, Dict[str, Any]]] = None) -> Dict[str, Any]:
    """비자 → 규칙. DB 규칙 우선, 없으면 기본. 내국인/미등록 처리."""
    rules = db_rules or DEFAULT_VISA_RULES
    if not is_foreign:
        return rules.get("KR", DEFAULT_VISA_RULES["KR"])
    if visa in rules:
        return rules[visa]
    # 미등록 외국인 비자 → 확인필요
    return _rule("reciprocity", "mandatory", "optional", False, f"{visa or '미상'}(미등록)")


def assess(
    *, nationality: Optional[str], visa_type: Optional[str], gross_monthly: float,
    age: Optional[int] = None,
    rates: Optional[Dict[str, float]] = None,
    db_rules: Optional[Dict[str, Dict[str, Any]]] = None,
    ltc_exclusion_applied: bool = False, ui_opt_in: bool = False,
    pension_country_excluded: bool = False,
) -> Dict[str, Any]:
    """근로자 1명 4대보험 산정(근거 포함). rates/db_rules 주입 시 DB 기준 사용."""
    R = {**DEFAULT_RATES, **(rates or {})}
    gross = float(gross_monthly or 0)
    is_foreign = (nationality or "KR").strip().upper() not in ("KR", "KOR", "", "내국인")
    visa = _norm_visa(visa_type)
    rule = resolve_rule(visa, is_foreign, db_rules)
    flags: List[str] = []

    def mk(applicable, status, rate, base, basis):
        return {"applicable": applicable, "status": status, "rate": rate,
                "base": round(base) if applicable else 0,
                "employee_amount": round(base * rate) if applicable else 0, "basis": basis}

    pbase = max(R["pension_base_min"], min(R["pension_base_max"], gross))
    vlbl = rule.get("label") or visa

    # 국민연금
    if age is not None and (age < 18 or age >= 60):
        np = mk(False, "제외", 0, 0, f"연령 {age}세 — 18세 미만/60세 이상 적용제외")
    elif rule["pension"] == "excluded":
        np = mk(False, "제외", 0, 0, f"체류자격 {visa}({vlbl}) — 적용제외 대상")
    elif rule["pension"] == "mandatory":
        np = mk(True, "당연", R["pension_emp"], pbase, ("내국인 당연적용" if not is_foreign else f"체류자격 {visa}({vlbl}) — 상호주의 무관 당연적용"))
    elif rule["pension"] == "reciprocity":
        if pension_country_excluded:
            np = mk(False, "제외(상호주의)", 0, 0, f"체류자격 {visa}({vlbl}) — 국적 상호주의 적용제외국")
        else:
            np = mk(True, "당연(상호주의 확인)", R["pension_emp"], pbase, f"체류자격 {visa}({vlbl}) — 당연적용, 국적 상호주의 확인 필요")
            flags.append("국민연금: 국적 상호주의 확인(적용제외국이면 제외). 구체 국적 미저장 → 근로자 설정에서 확정")
    else:
        np = mk(ui_opt_in, "임의", R["pension_emp"] if ui_opt_in else 0, pbase if ui_opt_in else 0, f"체류자격 {visa}({vlbl}) — 임의")

    # 건강보험
    if rule["health"] == "excluded":
        hi = mk(False, "제외", 0, 0, f"체류자격 {visa}({vlbl}) — 외국법령/계약 의료보장 제외")
    else:
        hi = mk(True, "당연", R["health_emp"], gross, "내국인 당연적용" if not is_foreign else "외국인 근로자 직장가입 당연적용")

    # 장기요양 (건강보험료 기준)
    health_amt = hi["employee_amount"]
    if rule["ltc_exclusion_eligible"] and ltc_exclusion_applied:
        ltc = {"applicable": False, "status": "제외(신청)", "rate": R["ltc_on_health"], "base": 0,
               "employee_amount": 0, "basis": f"체류자격 {visa}({vlbl}) — 장기요양 제외신청 완료"}
    elif not hi["applicable"]:
        ltc = {"applicable": False, "status": "제외", "rate": R["ltc_on_health"], "base": 0,
               "employee_amount": 0, "basis": "건강보험 미가입 → 장기요양 없음"}
    else:
        ltc = {"applicable": True, "status": "적용", "rate": R["ltc_on_health"], "base": health_amt,
               "employee_amount": round(health_amt * R["ltc_on_health"]),
               "basis": "건강보험료 × 13.14%" + (f" (체류자격 {visa} 제외신청 가능 — 미신청)" if rule["ltc_exclusion_eligible"] else "")}
        if rule["ltc_exclusion_eligible"]:
            flags.append(f"장기요양: 체류자격 {visa} 제외신청 가능 — 신청 시 면제")

    # 고용보험(실업급여)
    emp = rule["employment"]
    if emp == "mandatory":
        ei = mk(True, "당연", R["employment_ui_emp"], gross, "내국인 당연적용" if not is_foreign else f"체류자격 {visa}({vlbl}) — 당연적용")
    elif emp == "e9h2":
        if ui_opt_in:
            ei = mk(True, "임의(가입)", R["employment_ui_emp"], gross, f"체류자격 {visa}({vlbl}) — 실업급여 임의가입 신청")
        else:
            ei = mk(False, "임의(미가입)", 0, 0, f"체류자격 {visa}({vlbl}) — 고용안정·직능 당연이나 실업급여 임의(미신청)")
        flags.append(f"고용보험: {visa} 실업급여 임의가입 — 신청 여부 확인")
    elif emp == "optional":
        ei = mk(ui_opt_in, "임의(가입)" if ui_opt_in else "임의(미가입)",
                R["employment_ui_emp"] if ui_opt_in else 0, gross if ui_opt_in else 0,
                f"체류자격 {visa}({vlbl}) — 임의" + ("(신청)" if ui_opt_in else "(미신청)"))
    else:
        ei = mk(False, "제외", 0, 0, f"체류자격 {visa}({vlbl}) — 고용보험 적용제외")

    ia = {"applicable": True, "status": "당연(사업주부담)", "rate": 0.0, "base": 0,
          "employee_amount": 0, "basis": "국적·체류자격 불문 전원 당연, 전액 사업주 부담(근로자 공제 없음)"}

    total = np["employee_amount"] + hi["employee_amount"] + ltc["employee_amount"] + ei["employee_amount"]
    return {
        "is_foreign": is_foreign, "visa_type": visa or None, "visa_label": vlbl,
        "gross_monthly": round(gross),
        "national_pension": np, "health_insurance": hi, "long_term_care": ltc,
        "employment_insurance": ei, "industrial_accident": ia,
        "employee_total": total, "flags": flags,
    }


NON_APPLICABLE = {
    "사업소득(알바)": "4대보험 대상 아님 — 사업소득(3.3% 원천징수), 근로자 아님",
    "파견(거래처지급)": "4대보험 대상 아님 — 파견업체가 보험 부담",
}


if __name__ == "__main__":
    for name, kw in [
        ("내국인", dict(nationality="KR", visa_type=None, gross_monthly=3_000_000)),
        ("F-5", dict(nationality="FOREIGN", visa_type="F-5", gross_monthly=3_000_000)),
        ("E-9", dict(nationality="FOREIGN", visa_type="E-9", gross_monthly=2_500_000)),
        ("E-9 장기제외", dict(nationality="FOREIGN", visa_type="E-9", gross_monthly=2_500_000, ltc_exclusion_applied=True)),
        ("D-2", dict(nationality="FOREIGN", visa_type="D-2", gross_monthly=1_200_000)),
    ]:
        r = assess(**kw)
        print(f"{name}: 공제계 {r['employee_total']:,} | 연금 {r['national_pension']['status']} 건강 {r['health_insurance']['status']} 장기 {r['long_term_care']['status']} 고용 {r['employment_insurance']['status']}")
