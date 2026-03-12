"""
Smart Finance Core - Database Configuration
PostgreSQL 데이터베이스 연결 및 세션 관리
"""
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from sqlalchemy.orm import DeclarativeBase
from sqlalchemy import MetaData
from typing import AsyncGenerator, Optional
from contextlib import asynccontextmanager
import logging
import os

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

# Railway PostgreSQL URL 변환 (postgres:// -> postgresql+asyncpg://)
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql+asyncpg://", 1)
elif DATABASE_URL.startswith("postgresql://"):
    DATABASE_URL = DATABASE_URL.replace("postgresql://", "postgresql+asyncpg://", 1)

# 디버그: DB URL 정보 출력 (비밀번호 마스킹)
try:
    _parts = DATABASE_URL.split("@")
    _host_info = _parts[-1] if len(_parts) > 1 else "unknown"
    logger.info(f"Database URL scheme: {DATABASE_URL.split('://')[0]}, host: {_host_info}")
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
        engine = create_async_engine(
            DATABASE_URL,
            pool_size=5,
            max_overflow=10,
            echo=False,
            future=True
        )

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
        raise RuntimeError("Database not configured")
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
        raise RuntimeError("Database not configured")
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
    """Initialize database tables (with retry for cold-start connections)"""
    import asyncio

    if engine is None:
        logger.warning("Database engine not available, skipping init")
        return

    for attempt in range(3):
        try:
            async with engine.begin() as conn:
                await conn.run_sync(Base.metadata.create_all)
            logger.info("Database tables created successfully")
            return
        except Exception as e:
            logger.warning(f"DB init attempt {attempt + 1}/3 failed: {e}")
            if attempt < 2:
                await asyncio.sleep(2)
    raise RuntimeError("Failed to initialize database after 3 attempts")


async def close_db():
    """Close database connections"""
    if engine:
        await engine.dispose()
