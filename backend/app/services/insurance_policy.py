"""
외국인 포함 4대보험 산정 기준(규칙엔진) — 회계팀 검토용 '기준'의 코드 구현.

배경(2026-10-12 대표 지시): 현장 정규직은 급여 변동폭이 크고, 외국인은 체류자격(비자)·국적에
따라 4대보험 가입여부/요율이 달라 기준 수립이 어렵다는 회계팀 의견. 본 모듈이 그 '기준'을
명시적 규칙으로 구현하고, 각 보험이 '어떤 근거로' 산정/제외됐는지 사람이 읽을 수 있는 basis를
함께 반환한다.

대상: 실제 근로자 = 정규직(사무/현장). 알바(사업소득 3.3%)·파견(파견업체 부담)은 4대보험 대상 아님.

⚠ 요율·국가목록은 2차 자료 기반 '설정 기본값'이며 공단 최신 고시로 확정 필요(아래 SOURCES).
   국적이 데이터상 'KR/FOREIGN'만 있어 국민연금 상호주의(국가별)는 자동판정 불가 → confirm 플래그.
"""
from __future__ import annotations
from typing import Any, Dict, List, Optional

# ───────────────────────── 요율/기준 (2026 기본값, 회계팀/공단 확정 대상) ─────────────────────────
RATES = {
    "year": 2026,
    "pension_emp": 0.0475,       # 국민연금 근로자부담 (총 9.5%의 절반)
    "health_emp": 0.03595,       # 건강보험 근로자부담 (총 7.19%의 절반)
    "ltc_on_health": 0.1314,     # 장기요양 = 건강보험료 × 13.14%
    "employment_ui_emp": 0.009,  # 고용보험 실업급여 근로자부담 0.9%
    "pension_base_min": 410000,  # 국민연금 기준소득월액 하한(2026.7)
    "pension_base_max": 6590000, # 국민연금 기준소득월액 상한(2026.7)
}
SOURCES = [
    "국민연금 외국 연금제도 조사표(NPS, 상호주의 국가목록)",
    "근로복지공단 외국인 고용보험 체류자격별 적용 안내",
    "국민건강보험공단 외국인 건강보험/장기요양 적용·제외 안내",
    "2026년 4대보험 요율(국민연금 9.5%, 건강 7.19%, 장기요양 건강료의 13.14%, 고용 실업급여 1.8%, 산재 평균 1.47%)",
]

# ───────────────────────── 체류자격(비자) 매트릭스 ─────────────────────────
# 국민연금: 체류자격 1차 판정. 취업/거주계열은 국적 상호주의 2차 확인(국가 데이터 없으면 confirm).
PENSION_EXCLUDED_VISA = {"D-1", "D-2", "D-3", "D-4", "D-6", "F-1", "F-3", "G-1", "C-4", "B-1", "B-2"}
PENSION_MANDATORY_VISA = {"F-2", "F-4", "F-5", "F-6"}           # 국적 상호주의 무관 당연
PENSION_RECIPROCITY_VISA = {"E-1", "E-2", "E-3", "E-4", "E-5", "E-6", "E-7", "E-8", "E-9", "E-10", "H-2"}  # 당연, 단 상호주의 적용제외국 제외

# 고용보험(실업급여)
EMPLOYMENT_MANDATORY_VISA = {"F-2", "F-4", "F-5", "F-6"}        # 내국인과 동일 당연
EMPLOYMENT_E9H2_VISA = {"E-9", "H-2"}                           # 고용안정·직능 당연, 실업급여 임의
EMPLOYMENT_OPTIONAL_VISA = {"E-1", "E-2", "E-3", "E-4", "E-5", "E-6", "E-7", "E-10", "C-4"}  # 임의
EMPLOYMENT_EXCLUDED_VISA = {"D-1", "D-2", "D-3", "D-4", "D-6", "F-1", "F-3", "G-1"}

# 장기요양 제외신청 가능 체류자격(신청 시 제외; 기본은 적용)
LTC_EXCLUSION_ELIGIBLE_VISA = {"E-9", "H-2", "D-3", "E-8"}


def _norm_visa(v: Optional[str]) -> str:
    return (v or "").strip().upper().replace(" ", "")


def _pension_base(gross: float) -> float:
    return max(RATES["pension_base_min"], min(RATES["pension_base_max"], gross))


def assess(
    *, nationality: Optional[str], visa_type: Optional[str],
    gross_monthly: float, age: Optional[int] = None,
    ltc_exclusion_applied: bool = False, ui_opt_in: bool = False,
) -> Dict[str, Any]:
    """근로자 1명의 4대보험 산정(근거 포함).

    nationality: 'KR' 내국인 / 'FOREIGN'(또는 기타) 외국인. visa_type: 체류자격(F-2, E-9 …).
    gross_monthly: 당월 과세보수(변동급은 당월 기준 산정 후 연1회 정기결정으로 정산).
    ltc_exclusion_applied: 장기요양 제외신청 완료 여부. ui_opt_in: 실업급여 임의가입 신청 여부.
    """
    gross = float(gross_monthly or 0)
    is_foreign = (nationality or "KR").strip().upper() not in ("KR", "KOR", "", "내국인")
    visa = _norm_visa(visa_type)
    flags: List[str] = []

    def line(applicable, status, rate, base, basis):
        amt = round(base * rate) if applicable else 0
        return {"applicable": applicable, "status": status, "rate": rate,
                "base": round(base) if applicable else 0, "employee_amount": amt, "basis": basis}

    # ── 국민연금 ──
    if age is not None and (age < 18 or age >= 60):
        np = line(False, "제외", 0, 0, f"연령 {age}세 — 18세 미만/60세 이상 적용제외")
    elif not is_foreign:
        np = line(True, "당연", RATES["pension_emp"], _pension_base(gross), "내국인 사업장가입자 당연적용")
    elif visa in PENSION_EXCLUDED_VISA:
        np = line(False, "제외", 0, 0, f"체류자격 {visa or '미상'} — 연수/유학/동반/단기 등 적용제외 대상")
    elif visa in PENSION_MANDATORY_VISA:
        np = line(True, "당연", RATES["pension_emp"], _pension_base(gross), f"체류자격 {visa} — 상호주의 무관 당연적용")
    elif visa in PENSION_RECIPROCITY_VISA:
        np = line(True, "당연(상호주의 확인)", RATES["pension_emp"], _pension_base(gross),
                  f"체류자격 {visa} — 당연적용이나 국적 상호주의(적용제외국) 확인 필요")
        flags.append("국민연금: 국적 상호주의 확인 필요(적용제외국이면 제외). 시스템에 구체 국적 없음 → 수동 확인")
    else:
        np = line(True, "확인필요", RATES["pension_emp"], _pension_base(gross),
                  f"체류자격 {visa or '미상'} — 매트릭스 미등록, 수동 확인")
        flags.append(f"국민연금: 체류자격 {visa or '미상'} 미등록 — 수동 확인")

    # ── 건강보험 (외국인 근로자 당연적용) ──
    hi = line(True, "당연", RATES["health_emp"], gross,
              "내국인 당연적용" if not is_foreign else "외국인 근로자 직장가입 당연적용")

    # ── 장기요양 (건강보험료 기준) ──
    health_amt = hi["employee_amount"]
    ltc_eligible = is_foreign and visa in LTC_EXCLUSION_ELIGIBLE_VISA
    if ltc_eligible and ltc_exclusion_applied:
        ltc = {"applicable": False, "status": "제외(신청)", "rate": RATES["ltc_on_health"], "base": 0,
               "employee_amount": 0, "basis": f"체류자격 {visa} — 장기요양 제외신청 완료"}
    else:
        ltc = {"applicable": True, "status": "적용", "rate": RATES["ltc_on_health"], "base": health_amt,
               "employee_amount": round(health_amt * RATES["ltc_on_health"]),
               "basis": "건강보험료 × 13.14%" + (f" (체류자격 {visa} 제외신청 가능 — 미신청)" if ltc_eligible else "")}
        if ltc_eligible:
            flags.append(f"장기요양: 체류자격 {visa} 제외신청 가능 — 신청 시 면제")

    # ── 고용보험(실업급여) ──
    if not is_foreign:
        ei = line(True, "당연", RATES["employment_ui_emp"], gross, "내국인 당연적용")
    elif visa in EMPLOYMENT_MANDATORY_VISA:
        ei = line(True, "당연", RATES["employment_ui_emp"], gross, f"체류자격 {visa} — 고용보험 당연적용")
    elif visa in EMPLOYMENT_E9H2_VISA:
        if ui_opt_in:
            ei = line(True, "임의(가입)", RATES["employment_ui_emp"], gross, f"체류자격 {visa} — 실업급여 임의가입 신청")
        else:
            ei = line(False, "임의(미가입)", 0, 0, f"체류자격 {visa} — 고용안정·직능 당연이나 실업급여는 임의(미신청)")
        flags.append(f"고용보험: {visa} 실업급여 임의가입 — 신청 여부 확인(고용안정·직능은 사업주 당연)")
    elif visa in EMPLOYMENT_OPTIONAL_VISA:
        ei = line(ui_opt_in, "임의(가입)" if ui_opt_in else "임의(미가입)",
                  RATES["employment_ui_emp"] if ui_opt_in else 0, gross if ui_opt_in else 0,
                  f"체류자격 {visa} — 임의가입" + ("(신청)" if ui_opt_in else "(미신청)"))
    elif visa in EMPLOYMENT_EXCLUDED_VISA:
        ei = line(False, "제외", 0, 0, f"체류자격 {visa} — 고용보험 적용제외")
    else:
        ei = line(False, "확인필요", 0, 0, f"체류자격 {visa or '미상'} — 매트릭스 미등록, 수동 확인")
        flags.append(f"고용보험: 체류자격 {visa or '미상'} 미등록 — 수동 확인")

    # ── 산재(전원 당연, 전액 사업주 부담 → 근로자 공제 0) ──
    ia = {"applicable": True, "status": "당연(사업주부담)", "rate": 0.0, "base": 0,
          "employee_amount": 0, "basis": "체류자격·국적 불문 전원 당연적용, 전액 사업주 부담(근로자 공제 없음)"}

    total_emp = np["employee_amount"] + hi["employee_amount"] + ltc["employee_amount"] + ei["employee_amount"]
    return {
        "is_foreign": is_foreign, "visa_type": visa or None, "gross_monthly": round(gross),
        "national_pension": np, "health_insurance": hi, "long_term_care": ltc,
        "employment_insurance": ei, "industrial_accident": ia,
        "employee_total": total_emp, "flags": flags, "rate_year": RATES["year"],
    }


# 알바/파견 — 4대보험 대상 아님(사유 표시용)
NON_APPLICABLE = {
    "사업소득(알바)": "4대보험 대상 아님 — 사업소득(3.3% 원천징수), 근로자가 아님",
    "파견(거래처지급)": "4대보험 대상 아님 — 파견업체(사용사업주 아님)가 보험 부담",
}


if __name__ == "__main__":  # 간이 자체검증
    import json
    cases = [
        ("내국인 정규직", dict(nationality="KR", visa_type=None, gross_monthly=3_000_000)),
        ("외국인 F-5 영주", dict(nationality="FOREIGN", visa_type="F-5", gross_monthly=3_000_000)),
        ("외국인 E-9 비전문", dict(nationality="FOREIGN", visa_type="E-9", gross_monthly=2_500_000)),
        ("외국인 E-9 장기요양 제외신청", dict(nationality="FOREIGN", visa_type="E-9", gross_monthly=2_500_000, ltc_exclusion_applied=True)),
        ("외국인 D-2 유학", dict(nationality="FOREIGN", visa_type="D-2", gross_monthly=1_200_000)),
        ("외국인 E-7 전문", dict(nationality="FOREIGN", visa_type="E-7", gross_monthly=4_000_000)),
    ]
    for name, kw in cases:
        r = assess(**kw)
        print(f"\n== {name} (보수 {kw['gross_monthly']:,}) 근로자공제계={r['employee_total']:,} ==")
        for k in ("national_pension", "health_insurance", "long_term_care", "employment_insurance"):
            x = r[k]
            print(f"  {k:20} {x['status']:14} {x['employee_amount']:>10,}  | {x['basis']}")
        if r["flags"]:
            print("  flags:", "; ".join(r["flags"]))
