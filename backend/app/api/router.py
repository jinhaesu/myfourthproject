"""
Smart Finance Core - API Router
모든 API 엔드포인트 라우터
"""
from fastapi import APIRouter

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
)

api_router = APIRouter()

# 인증
api_router.include_router(
    auth.router,
    prefix="/auth",
    tags=["인증"]
)

# 사용자 관리
api_router.include_router(
    users.router,
    prefix="/users",
    tags=["사용자"]
)

# 전표 관리
api_router.include_router(
    vouchers.router,
    prefix="/vouchers",
    tags=["전표"]
)

# 결재 관리
api_router.include_router(
    approvals.router,
    prefix="/approvals",
    tags=["결재"]
)

# 자금 관리
api_router.include_router(
    treasury.router,
    prefix="/treasury",
    tags=["자금관리"]
)

# 예산 관리
api_router.include_router(
    budget.router,
    prefix="/budget",
    tags=["예산"]
)

# AI 분류
api_router.include_router(
    ai.router,
    prefix="/ai",
    tags=["AI"]
)

# 예측/시뮬레이션
api_router.include_router(
    forecast.router,
    prefix="/forecast",
    tags=["예측"]
)

# 보고서
api_router.include_router(
    reports.router,
    prefix="/reports",
    tags=["보고서"]
)

# 관리자
api_router.include_router(
    admin.router,
    prefix="/admin",
    tags=["관리자"]
)

# 데이터 가져오기/내보내기
api_router.include_router(
    data_import.router,
    prefix="/data",
    tags=["데이터"]
)

# AI 계정 분류 (학습 및 자동분류)
api_router.include_router(
    ai_classification.router,
    tags=["AI 계정분류"]
)

# 매출 자동화
api_router.include_router(
    sales.router,
    prefix="/sales",
    tags=["Sales Automation"]
)

# 재무제표 (Financial Reports from raw transaction data)
api_router.include_router(
    financial_reports.router,
    prefix="/financial",
    tags=["재무제표"]
)

# 통합 데이터 실시간 조회 (계좌·카드·세금계산서)
api_router.include_router(
    unified.router,
    prefix="/unified",
    tags=["통합조회"]
)

# 실시간 자금일보
api_router.include_router(
    daily_report.router,
    prefix="/daily-report",
    tags=["자금일보"]
)

# 현금주의 손익 분석
api_router.include_router(
    cash_pl.router,
    prefix="/cash-pl",
    tags=["현금주의손익"]
)

# 매출·매입·거래처 정산
api_router.include_router(
    settlement.router,
    prefix="/settlement",
    tags=["거래처정산"]
)

# 세금계산서 발행/조회
api_router.include_router(
    tax_invoice.router,
    prefix="/tax-invoices",
    tags=["세금계산서"]
)

# 계좌 이체
api_router.include_router(
    transfer.router,
    prefix="/transfers",
    tags=["계좌이체"]
)

# 클로브커넥트 (세무대리인 전용)
api_router.include_router(
    connect.router,
    prefix="/connect",
    tags=["세무대리인"]
)

# 계정별 원장 (총계정원장)
api_router.include_router(
    ledger.router,
    prefix="/ledger",
    tags=["계정원장"]
)
