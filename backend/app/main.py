"""
Smart Finance Core - Main Application
AI 기반 회계 자동화 및 재무 예측 플랫폼
"""
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
import logging
import sys
import os

# Logging setup - 먼저 설정
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(message)s"
)
logger = logging.getLogger(__name__)

# 시작 시 환경 정보 출력
logger.info(f"Python version: {sys.version}")
logger.info(f"Working directory: {os.getcwd()}")
logger.info(f"PORT env: {os.environ.get('PORT', 'not set')}")

try:
    from app.core.config import settings
    logger.info("Config loaded successfully")
except Exception as e:
    logger.error(f"Failed to load config: {e}")
    raise

try:
    from app.core.database import init_db, close_db
    logger.info("Database module loaded")
except Exception as e:
    logger.error(f"Failed to load database module: {e}")
    init_db = None
    close_db = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan manager"""
    # Startup
    logger.info("Starting Smart Finance Core...")
    if init_db:
        try:
            await init_db()
            logger.info("Database initialized")
        except Exception as e:
            logger.warning(f"Database initialization failed: {e}")
            logger.warning("Application will start without database")
    yield
    # Shutdown
    logger.info("Shutting down Smart Finance Core...")
    if close_db:
        try:
            await close_db()
            logger.info("Database connections closed")
        except Exception as e:
            logger.warning(f"Error closing database: {e}")


# Create FastAPI application
app = FastAPI(
    title=settings.APP_NAME,
    description="""
## AI 기반 능동형 회계/재무 관리 플랫폼

### 주요 기능

* **AI 전표 자동 분류** - 자연어 처리로 계정과목 자동 분류
* **전사적 결재 시스템** - 기안/승인 프로세스 자동화
* **자금 관리** - 채권/채무 자동 매칭 및 자금 수지 예측
* **손익 예측** - 실시간 추정 P&L 및 시나리오 시뮬레이션
* **엑셀 호환** - 더존 양식 지원 및 강력한 Import/Export

### 기술 스택

* Backend: FastAPI (Python)
* Database: PostgreSQL
* AI Engine: Scikit-learn, Prophet
* Frontend: React.js with TypeScript
    """,
    version=settings.APP_VERSION,
    docs_url="/docs",
    redoc_url="/redoc",
    lifespan=lifespan
)

# CORS middleware - wildcard 패턴 지원
def get_cors_origins():
    """CORS origins 처리 - wildcard 패턴 지원"""
    origins = []
    for origin in settings.CORS_ORIGINS:
        if "*" in origin:
            # wildcard는 allow_origin_regex로 처리
            continue
        origins.append(origin)
    return origins

# CORS 설정
cors_origins = get_cors_origins()
app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins if cors_origins else ["*"],
    allow_origin_regex=r"https://.*\.vercel\.app",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Production logging
if not settings.DEBUG:
    logger.info("Running in production mode")


# Global exception handler
@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    logger.error(f"Unhandled exception: {exc}", exc_info=True)
    return JSONResponse(
        status_code=500,
        content={
            "detail": "Internal server error",
            "message": str(exc) if settings.DEBUG else "An unexpected error occurred"
        }
    )


# Include API router
try:
    from app.api.router import api_router
    app.include_router(api_router, prefix="/api/v1")
    logger.info("API router loaded successfully")
except Exception as e:
    logger.error(f"Failed to load API router: {e}")
    logger.error("API endpoints will not be available")


# Health check endpoint
@app.get("/health")
async def health_check():
    """Health check endpoint for load balancers"""
    return {
        "status": "healthy",
        "app": settings.APP_NAME,
        "version": settings.APP_VERSION,
        "deploy": "ultra-light-v5"
    }


@app.get("/api/v1/health")
async def api_health_check():
    """API Health check endpoint"""
    return {
        "status": "healthy",
        "app": settings.APP_NAME,
        "version": settings.APP_VERSION,
        "deploy": "ultra-light-v5"
    }


# Root endpoint
@app.get("/")
async def root():
    """API root endpoint"""
    return {
        "app": settings.APP_NAME,
        "version": settings.APP_VERSION,
        "docs": "/docs" if settings.DEBUG else "Disabled in production",
        "api": "/api/v1"
    }


# Database seed endpoint (일회성 초기화용)
@app.post("/api/v1/setup/seed")
async def seed_database(secret: str):
    """
    데이터베이스 초기 데이터 생성
    SECRET_KEY를 파라미터로 전달해야 실행됨
    """
    if secret != settings.SECRET_KEY:
        return {"error": "Invalid secret key"}

    try:
        from datetime import datetime
        from sqlalchemy import select, text
        from app.core.database import async_session_factory, engine
        from app.core.security import get_password_hash
        from app.models.user import User, Role, Department, RoleType
        from app.models.accounting import Account, AccountCategory

        logger.info("Starting database seed...")

        # 테이블 생성 확인
        async with engine.begin() as conn:
            # roles 테이블 확인
            result = await conn.execute(text("SELECT COUNT(*) FROM roles"))
            role_count = result.scalar()
            logger.info(f"Current role count: {role_count}")

        async with async_session_factory() as db:
            # 역할 존재 확인
            result = await db.execute(select(Role).where(Role.name == "관리자"))
            if result.scalar_one_or_none():
                logger.info("Roles already exist, checking users...")
            else:
                # 역할 생성
                roles = [
                    Role(name="관리자", role_type=RoleType.ADMIN, description="시스템 전체 관리 권한",
                         can_create_voucher=True, can_approve_voucher=True, can_finalize_voucher=True,
                         can_manage_budget=True, can_view_all_departments=True, can_manage_users=True,
                         can_configure_ai=True, can_export_data=True, can_view_reports=True,
                         can_manage_accounts=True, approval_limit=999999999),
                    Role(name="재무담당자", role_type=RoleType.FINANCE_MANAGER, description="재무/회계 업무 담당",
                         can_create_voucher=True, can_approve_voucher=True, can_finalize_voucher=True,
                         can_manage_budget=True, can_view_all_departments=True, can_export_data=True,
                         can_view_reports=True, can_manage_accounts=True, approval_limit=50000000),
                    Role(name="팀장", role_type=RoleType.TEAM_LEADER, description="팀 단위 결재 권한",
                         can_create_voucher=True, can_approve_voucher=True, can_export_data=True,
                         can_view_reports=True, approval_limit=10000000),
                    Role(name="일반직원", role_type=RoleType.EMPLOYEE, description="기본 사용자 권한",
                         can_create_voucher=True, can_export_data=True, can_view_reports=True, approval_limit=0),
                ]
                for role in roles:
                    db.add(role)
                await db.commit()
                logger.info("Roles created")

            # 부서 생성
            result = await db.execute(select(Department).where(Department.code == "FIN"))
            if not result.scalar_one_or_none():
                departments = [
                    Department(code="EXEC", name="경영진", description="경영진"),
                    Department(code="FIN", name="재무팀", description="재무/회계 담당"),
                    Department(code="DEV", name="개발팀", description="소프트웨어 개발"),
                    Department(code="HR", name="인사팀", description="인사/총무"),
                    Department(code="SALES", name="영업팀", description="영업/마케팅"),
                ]
                for dept in departments:
                    db.add(dept)
                await db.commit()
                logger.info("Departments created")

            # 관리자 계정 생성 또는 업데이트
            result = await db.execute(select(User).where(User.email == "admin@smartfinance.com"))
            existing_user = result.scalar_one_or_none()

            # 역할과 부서 조회
            role_result = await db.execute(select(Role).where(Role.name == "관리자"))
            admin_role = role_result.scalar_one()
            dept_result = await db.execute(select(Department).where(Department.code == "FIN"))
            fin_dept = dept_result.scalar_one()

            if existing_user:
                # 기존 사용자 비밀번호 업데이트
                existing_user.hashed_password = get_password_hash("Admin123!@#")
                existing_user.is_active = True
                await db.commit()
                logger.info("Admin user password updated")
            else:
                admin_user = User(
                    email="admin@smartfinance.com",
                    username="admin",
                    hashed_password=get_password_hash("Admin123!@#"),
                    full_name="시스템 관리자",
                    employee_id="EMP001",
                    phone="010-1234-5678",
                    position="시스템관리자",
                    role_id=admin_role.id,
                    department_id=fin_dept.id,
                    is_active=True,
                    is_superuser=True,
                )
                db.add(admin_user)
                await db.commit()
                logger.info("Admin user created")

            return {
                "status": "success",
                "message": "Database seeded successfully",
                "credentials": {
                    "email": "admin@smartfinance.com",
                    "username": "admin",
                    "password": "Admin123!@#"
                }
            }
    except Exception as e:
        logger.error(f"Seed failed: {e}", exc_info=True)
        return {"status": "error", "message": str(e)}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "app.main:app",
        host=settings.HOST,
        port=settings.PORT,
        reload=settings.DEBUG,
        workers=settings.WORKERS if not settings.DEBUG else 1
    )
