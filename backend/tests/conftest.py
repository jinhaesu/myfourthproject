"""
Smart Finance Core - Test Configuration & Fixtures
테스트용 데이터베이스, 클라이언트, 시드 데이터 설정
"""
import asyncio
import os
from datetime import datetime
from typing import AsyncGenerator

import pytest
import pytest_asyncio
from httpx import AsyncClient, ASGITransport
from sqlalchemy.ext.asyncio import (
    create_async_engine,
    AsyncSession,
    async_sessionmaker,
)
from sqlalchemy import event

# 테스트 전에 환경변수 설정 (SQLite in-memory)
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"

from app.core.database import Base, get_db
from app.core.security import get_password_hash
from app.models.user import User, Role, Department, UserSession, RoleType
from app.models.audit import LoginAttempt
from app.main import app


# ---------------------------------------------------------------------------
# Event loop fixture (session-scoped so engine/tables are created once)
# ---------------------------------------------------------------------------
@pytest.fixture(scope="session")
def event_loop():
    """Create a session-scoped event loop for async tests."""
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


# ---------------------------------------------------------------------------
# Database engine & tables (session-scoped)
# ---------------------------------------------------------------------------
TEST_DATABASE_URL = "sqlite+aiosqlite:///:memory:"

test_engine = create_async_engine(TEST_DATABASE_URL, echo=False, future=True)


@pytest_asyncio.fixture(scope="session", autouse=True)
async def create_tables():
    """Create all tables once per test session."""
    async with test_engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield
    async with test_engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
    await test_engine.dispose()


# ---------------------------------------------------------------------------
# Per-test database session using connection-level rollback pattern.
#
# The pattern:
#   1. Open a connection, BEGIN a transaction
#   2. Create a session bound to that connection
#   3. Intercept any session.commit() by using a SAVEPOINT (begin_nested)
#      so the outer transaction is never committed
#   4. After the test, ROLLBACK the outer transaction
#
# This ensures every test gets a clean DB without needing to drop/create tables.
# ---------------------------------------------------------------------------
@pytest_asyncio.fixture
async def db_session() -> AsyncGenerator[AsyncSession, None]:
    """Provide a transactional database session that rolls back after each test."""
    async with test_engine.connect() as connection:
        # Start outer transaction that will be rolled back
        transaction = await connection.begin()

        # Create session bound to this connection
        session = AsyncSession(
            bind=connection,
            expire_on_commit=False,
            autoflush=False,
        )

        # Intercept commits: start a savepoint instead so the outer txn survives
        @event.listens_for(session.sync_session, "after_transaction_end")
        def restart_savepoint(sync_session, trans):
            """After a savepoint ends, start a new one if the outer txn is still active."""
            if trans.nested and not trans._parent.nested:
                sync_session.begin_nested()

        # Begin the initial savepoint
        await connection.begin_nested()

        yield session

        await session.close()
        await transaction.rollback()


# ---------------------------------------------------------------------------
# A session factory that always returns the per-test session.
# This is used to patch async_session_factory so that code paths that
# bypass get_db (like get_current_user) also use the test session.
# ---------------------------------------------------------------------------
@pytest_asyncio.fixture
async def client(db_session: AsyncSession) -> AsyncGenerator[AsyncClient, None]:
    """Provide an async HTTP client wired to the test database."""
    import app.core.database as db_module

    async def _override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_get_db

    # Patch async_session_factory so get_current_user (which creates its own
    # session) also queries the same in-memory database.
    # We create a factory that yields sessions bound to the same engine.
    original_factory = db_module.async_session_factory
    test_factory = async_sessionmaker(
        test_engine,
        class_=AsyncSession,
        expire_on_commit=False,
        autoflush=False,
    )
    db_module.async_session_factory = test_factory

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as ac:
        yield ac

    app.dependency_overrides.clear()
    db_module.async_session_factory = original_factory


# ---------------------------------------------------------------------------
# Seed data fixtures
# ---------------------------------------------------------------------------
@pytest_asyncio.fixture
async def seed_role(db_session: AsyncSession) -> Role:
    """Create a default EMPLOYEE role."""
    role = Role(
        name="일반직원",
        role_type=RoleType.EMPLOYEE,
        description="기본 직원 역할",
        can_create_voucher=True,
        can_approve_voucher=False,
        can_finalize_voucher=False,
        can_manage_budget=False,
        can_view_all_departments=False,
        can_manage_users=False,
        can_configure_ai=False,
        can_export_data=True,
        can_view_reports=True,
        can_manage_accounts=False,
    )
    db_session.add(role)
    await db_session.commit()
    await db_session.refresh(role)
    return role


@pytest_asyncio.fixture
async def seed_department(db_session: AsyncSession) -> Department:
    """Create a default department."""
    dept = Department(
        code="DEV",
        name="개발팀",
        level=1,
        sort_order=1,
        is_active=True,
    )
    db_session.add(dept)
    await db_session.commit()
    await db_session.refresh(dept)
    return dept


@pytest_asyncio.fixture
async def seed_user(
    db_session: AsyncSession,
    seed_role: Role,
    seed_department: Department,
) -> User:
    """Create an active test user with known credentials.

    Credentials:
        username: testuser
        password: Test1234!
    """
    user = User(
        employee_id="EMP-0001",
        email="test@example.com",
        username="testuser",
        hashed_password=get_password_hash("Test1234!"),
        full_name="테스트 사용자",
        phone="010-1234-5678",
        position="사원",
        department_id=seed_department.id,
        role_id=seed_role.id,
        is_active=True,
        is_superuser=False,
        two_factor_enabled=False,
        failed_login_attempts=0,
        password_changed_at=datetime.utcnow(),
    )
    db_session.add(user)
    await db_session.commit()
    await db_session.refresh(user)
    return user


@pytest_asyncio.fixture
async def seed_inactive_user(
    db_session: AsyncSession,
    seed_role: Role,
    seed_department: Department,
) -> User:
    """Create an inactive (pending approval) test user."""
    user = User(
        employee_id="PENDING-AAAA1111",
        email="inactive@example.com",
        username="inactiveuser",
        hashed_password=get_password_hash("Test1234!"),
        full_name="비활성 사용자",
        department_id=seed_department.id,
        role_id=seed_role.id,
        is_active=False,
        is_superuser=False,
        two_factor_enabled=False,
        failed_login_attempts=0,
        password_changed_at=datetime.utcnow(),
    )
    db_session.add(user)
    await db_session.commit()
    await db_session.refresh(user)
    return user


@pytest_asyncio.fixture
async def auth_tokens(client: AsyncClient, seed_user: User) -> dict:
    """Generate tokens directly for test user (bypasses email OTP flow)."""
    from app.core.security import create_access_token, create_refresh_token
    from app.core.config import settings

    access_token = create_access_token({"sub": str(seed_user.id)})
    refresh_token = create_refresh_token({"sub": str(seed_user.id)})

    return {
        "access_token": access_token,
        "refresh_token": refresh_token,
        "token_type": "bearer",
        "expires_in": settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60,
    }
