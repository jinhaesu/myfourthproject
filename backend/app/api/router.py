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
