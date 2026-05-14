"""
Smart Finance Core - Database Configuration
Supabase PostgreSQL 데이터베이스 연결 및 세션 관리
- 영구 데이터 보존 (배포/재시작 무관)
- Supavisor connection pooler 지원
- SSL 연결 지원
"""
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from sqlalchemy.orm import DeclarativeBase
from sqlalchemy import MetaData
from typing import AsyncGenerator, Optional
from contextlib import asynccontextmanager
import logging
import os
import ssl

logger = logging.getLogger(__name__)

# Naming convention for constraints
convention = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s"
}

metadata = MetaData(naming_convention=convention)


class Base(DeclarativeBase):
    """Base class for all database models"""
    metadata = metadata


# 데이터베이스 URL 가져오기 (환경변수 우선)
DATABASE_URL = os.environ.get("DATABASE_URL", "sqlite+aiosqlite:///./smartfinance.db")

# Supabase / Railway PostgreSQL URL 변환
# Supabase: postgresql://user:pass@host:port/db → postgresql+asyncpg://user:pass@host:port/db
# Railway: postgres://user:pass@host:port/db → postgresql+asyncpg://user:pass@host:port/db
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql+asyncpg://", 1)
elif DATABASE_URL.startswith("postgresql://") and "+asyncpg" not in DATABASE_URL:
    DATABASE_URL = DATABASE_URL.replace("postgresql://", "postgresql+asyncpg://", 1)

# Supabase pooler URL 처리 (?pgbouncer=true 파라미터 처리)
_is_supabase = "supabase" in DATABASE_URL or "pooler.supabase" in DATABASE_URL

# 디버그: DB URL 정보 출력 (비밀번호 마스킹)
try:
    _parts = DATABASE_URL.split("@")
    _host_info = _parts[-1] if len(_parts) > 1 else "unknown"
    _db_type = "Supabase" if _is_supabase else ("PostgreSQL" if "postgresql" in DATABASE_URL else "SQLite")
    logger.info(f"Database: {_db_type}, host: {_host_info.split('?')[0]}")
except Exception:
    logger.info(f"Database URL scheme: {DATABASE_URL.split('://')[0] if '://' in DATABASE_URL else 'unknown'}")

# Create async engine
engine: Optional[any] = None
async_session_factory: Optional[any] = None

try:
    if DATABASE_URL.startswith("sqlite"):
        engine = create_async_engine(
            DATABASE_URL,
            echo=False,
            future=True
        )
    else:
        # PostgreSQL (Supabase / Railway / 기타)
        engine_kwargs = {
            "pool_size": 5,
            "max_overflow": 10,
            "pool_pre_ping": True,
            "pool_recycle": 300,
            "pool_timeout": 30,
            "echo": False,
            "future": True,
        }

        # Supabase / 외부 PostgreSQL: SSL + prepared statement 비활성화
        connect_args = {}

        if _is_supabase or "sslmode" in DATABASE_URL:
            ssl_ctx = ssl.create_default_context()
            ssl_ctx.check_hostname = False
            ssl_ctx.verify_mode = ssl.CERT_NONE
            connect_args["ssl"] = ssl_ctx

        # Supabase는 모든 연결(direct/pooler)에서 prepared statements 비활성화 필요
        if _is_supabase or "pgbouncer" in DATABASE_URL:
            connect_args["statement_cache_size"] = 0

        if connect_args:
            engine_kwargs["connect_args"] = connect_args

        engine = create_async_engine(DATABASE_URL, **engine_kwargs)

    async_session_factory = async_sessionmaker(
        engine,
        class_=AsyncSession,
        expire_on_commit=False,
        autoflush=False
    )
    logger.info("Database engine created successfully")
except Exception as e:
    logger.error(f"Failed to create database engine: {e}")
    engine = None
    async_session_factory = None


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """Dependency for getting database session"""
    if async_session_factory is None:
        raise RuntimeError("Database not configured. Set DATABASE_URL environment variable.")
    async with async_session_factory() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
        finally:
            await session.close()


@asynccontextmanager
async def get_db_context() -> AsyncGenerator[AsyncSession, None]:
    """Context manager for database session"""
    if async_session_factory is None:
        raise RuntimeError("Database not configured. Set DATABASE_URL environment variable.")
    async with async_session_factory() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
        finally:
            await session.close()


async def init_db():
    """Initialize database tables (with retry for cold-start connections)

    중요: create_all은 기존 테이블이 있으면 건드리지 않습니다.
    새 테이블만 생성하고 기존 데이터는 절대 삭제하지 않습니다.
    """
    import asyncio

    if engine is None:
        logger.warning("Database engine not available, skipping init")
        return

    from sqlalchemy import text

    for attempt in range(3):  # Supabase cold start 대비 3회 재시도
        try:
            # Step 1: 테이블 생성 (별도 트랜잭션)
            async with engine.begin() as conn:
                await conn.run_sync(Base.metadata.create_all)
            logger.info("Tables created/verified")
            break
        except Exception as e:
            logger.warning(f"DB init attempt {attempt + 1}/3 failed: {e}")
            if attempt < 2:
                await asyncio.sleep(2)
            else:
                logger.error("Failed to initialize database after 3 attempts")
                return  # 실패해도 앱은 계속 실행

    # Step 2: 마이그레이션 (각각 별도 트랜잭션, 실패해도 앱 시작에 영향 없음)
    migrations = [
        "ALTER TABLE ai_raw_transaction_data ADD COLUMN IF NOT EXISTS source_account_name VARCHAR(100)",
        "ALTER TABLE ai_training_data ALTER COLUMN account_id DROP NOT NULL",
        "ALTER TABLE ai_data_upload_history ADD COLUMN IF NOT EXISTS result_json TEXT",
        # file_type VARCHAR(10) → VARCHAR(50): "bank_statement" 등 긴 값 저장 지원
        "ALTER TABLE ai_data_upload_history ALTER COLUMN file_type TYPE VARCHAR(50)",
        # upload_type VARCHAR(20) → VARCHAR(50): 여유 확보
        "ALTER TABLE ai_data_upload_history ALTER COLUMN upload_type TYPE VARCHAR(50)",
        # Voucher.source — 데이터 출처 (granter_auto/manual/wehago_import 등)
        "ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS source VARCHAR(50)",
        # AutoVoucherCandidate.duplicate_voucher_id — 위하고 import 등 기존 Voucher와의 중복 매칭
        "ALTER TABLE auto_voucher_candidates ADD COLUMN IF NOT EXISTS duplicate_voucher_id INTEGER REFERENCES vouchers(id)",
    ]
    for sql in migrations:
        try:
            async with engine.begin() as conn:
                await conn.execute(text(sql))
        except Exception as col_err:
            err_str = str(col_err).lower()
            if "duplicate" not in err_str and "already exists" not in err_str:
                logger.warning(f"Migration skipped: {str(col_err)[:100]}")

    # Step 3: 연결 테스트
    try:
        async with async_session_factory() as session:
            result = await session.execute(text("SELECT COUNT(*) FROM ai_raw_transaction_data"))
            count = result.scalar() or 0
            result2 = await session.execute(text("SELECT COUNT(*) FROM ai_data_upload_history"))
            upload_count = result2.scalar() or 0
            logger.info(f"Database initialized. raw_data: {count:,}, upload_history: {upload_count:,} rows preserved.")
    except Exception as e:
        logger.warning(f"DB count check skipped: {e}")

    logger.info("Database tables ready (existing data preserved)")


async def close_db():
    """Close database connections"""
    if engine:
        await engine.dispose()
