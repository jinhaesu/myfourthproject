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
        "version": settings.APP_VERSION
    }


@app.get("/api/v1/health")
async def api_health_check():
    """API Health check endpoint"""
    return {
        "status": "healthy",
        "app": settings.APP_NAME,
        "version": settings.APP_VERSION
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


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "app.main:app",
        host=settings.HOST,
        port=settings.PORT,
        reload=settings.DEBUG,
        workers=settings.WORKERS if not settings.DEBUG else 1
    )
