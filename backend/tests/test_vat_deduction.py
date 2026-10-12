from app.services.vat_deduction import judge, summarize, fmt_biz, vat_split


def test_fmt():
    assert fmt_biz("5038701038") == "503-87-01038"
    assert fmt_biz("") is None


def test_no_biz_needs_check():
    r = judge(None)
    assert r["deduct"] == "확인필요" and r["reason"] == "사업자번호 없음 — 증빙 확인 필요"


def test_no_biz_but_entertainment_nondeductible():
    assert judge(None, account_code="813")["deduct"] == "불공제"
    assert judge("", account_code="953")["deduct"] == "불공제"


def test_entertainment_nondeductible():
    r = judge("5038701038", account_code="813")
    assert r["deduct"] == "불공제"


def test_vehicle_needs_check():
    assert judge("5038701038", account_code="822")["deduct"] == "확인필요"


def test_corp_general_deductible():
    r = judge("5038701038", account_code="830")
    assert r["deduct"] == "공제" and r["tax_kind"] == "일반과세자"


def test_exempt_and_simple():
    assert judge("5038701038", status_row={"tax_kind": "면세사업자"})["deduct"] == "불공제"
    assert judge("5038701038", status_row={"tax_kind": "간이과세자"})["deduct"] == "불공제"
    assert judge("5038701038", status_row={"tax_kind": "간이과세자(세금계산서)"})["deduct"] == "공제"


def test_closed_before_after():
    st = {"tax_kind": "일반과세자", "status": "폐업", "end_dt": "20260601"}
    assert judge("5038701038", status_row=st, tx_date="2026-07-01")["deduct"] == "불공제"
    assert judge("5038701038", status_row=st, tx_date="2026-05-01")["deduct"] == "공제"


def test_hometax_selective_ignored():
    r = judge("5038701038", ht_kind="법인사업자", ht_deduct="불공제", ht_reason="선택불공제")
    assert r["deduct"] == "공제"
    r = judge("5038701038", ht_kind="법인사업자", ht_deduct="불공제", ht_reason="당연불공제")
    assert r["deduct"] == "불공제"


def test_individual_unknown():
    assert judge("1234567890")["deduct"] == "확인필요"


def test_vat_split():
    assert vat_split(11000, "일반과세자") == {"supply": 10000.0, "vat": 1000.0}
    assert vat_split(11000, "면세사업자")["vat"] == 0
    s = summarize([{"amount": 11000, "deduct": "공제", "tax_kind": "일반과세자"}])
    assert s["공제"]["vat"] == 1000.0


def test_manual_key_and_checksum():
    from app.services.vat_deduction import manual_key, valid_biz_no
    assert manual_key("  컬리_AD / 주식회사 컬리페이 ") == "컬리_AD"
    assert manual_key("컬리_AD") == manual_key("컬리_AD/주식회사 컬리페이")
    assert manual_key("A   b") == "A B"
    assert valid_biz_no("503-87-01038")
    assert not valid_biz_no("503-87-01039")
    assert not valid_biz_no("123")


def test_nonvat_payments():
    from app.services.vat_deduction import NONVAT
    for nm in ["국세", "국세(인터넷납부)", "지방세", "지자체세입금(온라인)", "세입금", "포털_건강보험공단", "국민연금", "근로복지공단", "과태료"]:
        r = judge("2208201439", store_name=nm, account_code="830")
        assert r["deduct"] == NONVAT, nm
    r = judge(None, store_name="국세")
    assert r["deduct"] == NONVAT and "부가세 거래 아님" in r["reason"]
    # 보증보험은 면세 -> 불공제 (부가세 대상 아님 아님)
    r = judge("1068100235", store_name="서울보증보험", status_row={"tax_kind": "면세사업자"})
    assert r["deduct"] == "불공제"


def test_nonvat_excluded_from_totals_line():
    s = summarize([{"amount": 11000, "deduct": "부가세 대상 아님", "tax_kind": "해당없음"},
                   {"amount": 11000, "deduct": "공제", "tax_kind": "일반과세자"}])
    assert s["부가세 대상 아님"]["vat"] == 0 and s["공제"]["vat"] == 1000.0
