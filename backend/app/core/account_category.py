"""
계정과목 카테고리 분류 — 단일 구현.

기존에 ledger.py / cash_pl.py / financial_reports.py 가 각자 분류 함수를
들고 있어 화면마다 같은 계정이 다른 섹션에 표시될 수 있었다.
모든 메뉴는 이 모듈만 사용한다.

분류 체계 (K-GAAP 3자리 코드 + 이름 키워드):
  asset / liability / equity / revenue / cogs / opex / non_operating
- 이름 키워드가 코드보다 우선 ('매출원가'는 45x가 아니어도 cogs)
- 4xx 세분화: 40x~44x = revenue, 45x~49x = cogs
- 5xx~7xx = cogs(원가), 8xx = opex(판관비), 9xx = non_operating
"""
from typing import Optional

CATEGORY_LABEL = {
    'asset': '자산',
    'liability': '부채',
    'equity': '자본',
    'revenue': '수익',
    'cogs': '매출원가',
    'opex': '판관비',
    'expense': '비용',
    'non_operating': '영업외',
}

# 이름 키워드 기반 분류 (가장 강한 신호)
NAME_RULES = [
    (('매출원가', '제조원가', '상품매출원가', '제품매출원가', '용역매출원가'), 'cogs'),
    (('이자수익', '이자비용', '외환차익', '외환차손', '외화환산이익', '외화환산손실',
      '잡이익', '잡손실', '유형자산처분', '무형자산처분', '기부금', '재해손실'), 'non_operating'),
    (('상품매출', '제품매출', '용역매출', '공사매출', '임대료수익', '수출매출'), 'revenue'),
]


def strip_code(code: Optional[str]) -> str:
    """더존 6자리 코드 앞의 0 제거: '000101' → '101'"""
    if not code:
        return '0'
    return code.lstrip('0') or '0'


def categorize_account(code: Optional[str], name: str = '') -> str:
    """
    세분 카테고리 반환:
      asset / liability / equity / revenue / cogs / opex / non_operating
    """
    n = (name or '').strip()

    for keywords, cat in NAME_RULES:
        if any(k in n for k in keywords):
            return cat

    s = strip_code(code)
    first = s[0] if s else '0'

    if first == '4':
        if len(s) >= 2 and s[1] in ('5', '6', '7', '8', '9'):
            return 'cogs'
        return 'revenue'

    if first == '9':
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


def categorize_coarse(code: Optional[str], name: str = '') -> str:
    """
    굵은 카테고리 (cogs/opex → expense 통합) — 계정별원장 등
    수익/비용 2분류만 필요한 화면용.
    """
    cat = categorize_account(code, name)
    return 'expense' if cat in ('cogs', 'opex') else cat


def is_non_operating_income(code: Optional[str], name: str = '') -> bool:
    """영업외 중 수익성 여부 (이자수익, 잡이익 등)"""
    n = (name or '').strip()
    return any(k in n for k in ('수익', '이익', '환입'))


def is_bs_account(code: Optional[str]) -> bool:
    """재무상태표 대상(자산/부채/자본) 여부"""
    return strip_code(code)[0] in ('1', '2', '3')
