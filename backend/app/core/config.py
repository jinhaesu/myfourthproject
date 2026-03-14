"""
Smart Finance Core - Application Configuration
중앙 집중식 설정 관리
"""
from pydantic_settings import BaseSettings
from pydantic import Field
from typing import List, Optional
from functools import lru_cache


class Settings(BaseSettings):
    """Application settings with environment variable support"""

    # Application
    APP_NAME: str = "Smart Finance Core"
    APP_VERSION: str = "1.0.0"
    DEBUG: bool = False
    ENVIRONMENT: str = "development"

    # Server
    HOST: str = "0.0.0.0"
    PORT: int = 8000
    WORKERS: int = 4

    # Database (SQLite를 기본값으로 사용, 프로덕션에서는 PostgreSQL 설정 필요)
    DATABASE_URL: str = Field(
        default="sqlite+aiosqlite:///./smartfinance.db",
        description="Database connection string"
    )
    DATABASE_POOL_SIZE: int = 20
    DATABASE_MAX_OVERFLOW: int = 10

    # Redis
    REDIS_URL: str = "redis://localhost:6379/0"

    # Security
    SECRET_KEY: str = Field(
        default="your-secret-key-change-in-production",
        description="JWT signing key"
    )
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 30
    REFRESH_TOKEN_EXPIRE_DAYS: int = 7

    # Password Policy
    PASSWORD_MIN_LENGTH: int = 8
    PASSWORD_REQUIRE_UPPERCASE: bool = True
    PASSWORD_REQUIRE_LOWERCASE: bool = True
    PASSWORD_REQUIRE_DIGIT: bool = True
    PASSWORD_REQUIRE_SPECIAL: bool = True

    # Two-Factor Authentication
    ENABLE_2FA: bool = True
    OTP_VALIDITY_SECONDS: int = 300

    # AI Model Settings
    AI_MODEL_PATH: str = "./ml/models"
    AI_CONFIDENCE_THRESHOLD: float = 0.85
    AI_AUTO_CONFIRM_THRESHOLD: float = 0.95
    AI_REVIEW_REQUIRED_THRESHOLD: float = 0.60

    # External APIs
    CARD_API_KEY: Optional[str] = None
    CARD_API_SECRET: Optional[str] = None
    TAX_INVOICE_API_KEY: Optional[str] = None
    BANK_API_KEY: Optional[str] = None

    # OCR Settings
    OCR_ENABLED: bool = True
    TESSERACT_CMD: str = "/usr/bin/tesseract"

    # File Storage
    UPLOAD_DIR: str = "./uploads"
    MAX_UPLOAD_SIZE: int = 10 * 1024 * 1024  # 10MB
    ALLOWED_EXTENSIONS: List[str] = ["xlsx", "xls", "csv", "pdf", "png", "jpg", "jpeg"]

    # AWS S3 (Data Archiving)
    AWS_ACCESS_KEY_ID: Optional[str] = None
    AWS_SECRET_ACCESS_KEY: Optional[str] = None
    AWS_REGION: str = "ap-northeast-2"
    S3_BUCKET_NAME: str = "smartfinance-archive"

    # Logging
    LOG_LEVEL: str = "INFO"
    LOG_FORMAT: str = "{time:YYYY-MM-DD HH:mm:ss} | {level} | {message}"

    # CORS - 환경변수로 설정 가능 (쉼표로 구분)
    CORS_ORIGINS: List[str] = [
        "http://localhost:3000",
        "http://localhost:8080",
        "https://*.vercel.app",
    ]

    # Resend Email (OTP 인증)
    RESEND_API_KEY: Optional[str] = None
    RESEND_FROM_EMAIL: str = "Smart Finance <onboarding@resend.dev>"
    ALLOWED_EMAILS: List[str] = []  # 빈 리스트면 모든 이메일 허용, 값이 있으면 화이트리스트

    # AI Analysis (LLM) - Claude
    ANTHROPIC_API_KEY: Optional[str] = None
    ANTHROPIC_MODEL: str = "claude-sonnet-4-20250514"

    # Douzone Integration
    DOUZONE_API_URL: Optional[str] = None
    DOUZONE_API_KEY: Optional[str] = None

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"
        case_sensitive = True


@lru_cache()
def get_settings() -> Settings:
    """Get cached settings instance"""
    return Settings()


settings = get_settings()
