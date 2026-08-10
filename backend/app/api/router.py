"""
Smart Finance Core - API Router
모든 API 엔드포인트 라우터

권한 체계:
- 회계 메뉴 라우터 전체 → 회계 관리자(ADMIN_EMAILS) 전용 (서버측 강제)
- cards / purchase → 로그인 사용자 접근, 엔드포인트 내부에서 본인 데이터로 제한
- auth → 공개 (로그인 플로우)
"""
from fastapi import APIRouter, Depends

from app.core.security import require_accounting_admin

from app.api.endpoints import (
    auth,
    users,
    vouchers,
    approvals,
    treasury,
    budget,
    ai,
    forecast,
    reports,
    admin,
    data_import,
    ai_classification,
    sales,
    financial_reports,
    unified,
    daily_report,
    cash_pl,
    settlement,
    tax_invoice,
    transfer,
    connect,
    ledger,
    granter,
    hyphen,
    exchange_rates,
    auto_voucher,
    daily_cash_report,
    cards,
    payroll,
    purchase,
)

api_router = APIRouter()

# 회계 관리자 전용 의존성 (지정 이메일만 회계 데이터 접근)
ADMIN_ONLY = [Depends(require_accounting_admin())]

# 인증 (공개 — 로그인 플로우)
api_router.include_router(auth.router, prefix="/auth", tags=["인증"])

# ===== 로그인 사용자 접근 (내부에서 본인 데이터로 세분화) =====

# 카드 관리 — 관리자: 전체 카드+배정 / 직원: 배정된 카드만
api_router.include_router(cards.router, prefix="/cards", tags=["카드"])

# 구매 요청 (링크 카탈로그 → 구매요청 → 승인 → 카드전표 대사)
api_router.include_router(purchase.router, prefix="/purchase", tags=["구매요청"])

# ===== 이하 전부 회계 관리자 전용 =====

api_router.include_router(users.router, prefix="/users", tags=["사용자"], dependencies=ADMIN_ONLY)
api_router.include_router(vouchers.router, prefix="/vouchers", tags=["전표"], dependencies=ADMIN_ONLY)
api_router.include_router(approvals.router, prefix="/approvals", tags=["결재"], dependencies=ADMIN_ONLY)
api_router.include_router(treasury.router, prefix="/treasury", tags=["자금관리"], dependencies=ADMIN_ONLY)
api_router.include_router(budget.router, prefix="/budget", tags=["예산"], dependencies=ADMIN_ONLY)
api_router.include_router(ai.router, prefix="/ai", tags=["AI"], dependencies=ADMIN_ONLY)
api_router.include_router(forecast.router, prefix="/forecast", tags=["예측"], dependencies=ADMIN_ONLY)
api_router.include_router(reports.router, prefix="/reports", tags=["보고서"], dependencies=ADMIN_ONLY)
api_router.include_router(admin.router, prefix="/admin", tags=["관리자"], dependencies=ADMIN_ONLY)
api_router.include_router(data_import.router, prefix="/data", tags=["데이터"], dependencies=ADMIN_ONLY)
api_router.include_router(ai_classification.router, tags=["AI 계정분류"], dependencies=ADMIN_ONLY)
api_router.include_router(sales.router, prefix="/sales", tags=["Sales Automation"], dependencies=ADMIN_ONLY)
api_router.include_router(financial_reports.router, prefix="/financial", tags=["재무제표"], dependencies=ADMIN_ONLY)
api_router.include_router(unified.router, prefix="/unified", tags=["통합조회"], dependencies=ADMIN_ONLY)
api_router.include_router(daily_report.router, prefix="/daily-report", tags=["자금일보"], dependencies=ADMIN_ONLY)
api_router.include_router(cash_pl.router, prefix="/cash-pl", tags=["현금주의손익"], dependencies=ADMIN_ONLY)
api_router.include_router(settlement.router, prefix="/settlement", tags=["거래처정산"], dependencies=ADMIN_ONLY)
api_router.include_router(tax_invoice.router, prefix="/tax-invoices", tags=["세금계산서"], dependencies=ADMIN_ONLY)
api_router.include_router(transfer.router, prefix="/transfers", tags=["계좌이체"], dependencies=ADMIN_ONLY)
api_router.include_router(connect.router, prefix="/connect", tags=["세무대리인"], dependencies=ADMIN_ONLY)
api_router.include_router(ledger.router, prefix="/ledger", tags=["계정원장"], dependencies=ADMIN_ONLY)
api_router.include_router(granter.router, prefix="/granter", tags=["Granter"], dependencies=ADMIN_ONLY)
api_router.include_router(hyphen.router, prefix="/hyphen", tags=["Hyphen"], dependencies=ADMIN_ONLY)
api_router.include_router(exchange_rates.router, tags=["exchange-rates"], dependencies=ADMIN_ONLY)
api_router.include_router(daily_cash_report.router, prefix="/daily-cash-report", tags=["자금일보"], dependencies=ADMIN_ONLY)
api_router.include_router(auto_voucher.router, prefix="/auto-voucher", tags=["자동전표"], dependencies=ADMIN_ONLY)
api_router.include_router(payroll.router, prefix="/payroll", tags=["급여관리"], dependencies=ADMIN_ONLY)
