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

# Direct (non-pooled) URL — 큰 쿼리/관리 작업용
DATABASE_URL_DIRECT_RAW = os.environ.get("DATABASE_URL_DIRECT", "")
if DATABASE_URL_DIRECT_RAW.startswith("postgres://"):
    DATABASE_URL_DIRECT_RAW = DATABASE_URL_DIRECT_RAW.replace("postgres://", "postgresql+asyncpg://", 1)
elif DATABASE_URL_DIRECT_RAW.startswith("postgresql://") and "+asyncpg" not in DATABASE_URL_DIRECT_RAW:
    DATABASE_URL_DIRECT_RAW = DATABASE_URL_DIRECT_RAW.replace("postgresql://", "postgresql+asyncpg://", 1)

# Create async engine
engine: Optional[any] = None
async_session_factory: Optional[any] = None
# Direct engine (non-pooled) — 큰 보고서/관리 작업 전용
engine_direct: Optional[any] = None
async_session_factory_direct: Optional[any] = None

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

    # Direct (non-pooled) engine — 환경변수가 있을 때만
    if DATABASE_URL_DIRECT_RAW and DATABASE_URL_DIRECT_RAW.startswith("postgresql"):
        try:
            direct_ssl_ctx = ssl.create_default_context()
            direct_ssl_ctx.check_hostname = False
            direct_ssl_ctx.verify_mode = ssl.CERT_NONE
            engine_direct = create_async_engine(
                DATABASE_URL_DIRECT_RAW,
                pool_size=2,
                max_overflow=4,
                pool_pre_ping=True,
                pool_recycle=600,
                pool_timeout=30,
                echo=False,
                future=True,
                connect_args={
                    "ssl": direct_ssl_ctx,
                    "statement_cache_size": 0,
                    "command_timeout": 600,
                },
            )
            async_session_factory_direct = async_sessionmaker(
                engine_direct,
                class_=AsyncSession,
                expire_on_commit=False,
                autoflush=False,
            )
            _direct_host = DATABASE_URL_DIRECT_RAW.split("@")[-1].split("?")[0]
            logger.info(f"Direct database engine created (non-pooled): {_direct_host}")
        except Exception as e:
            logger.warning(f"Direct engine creation failed (fallback to pooled): {e}")
            engine_direct = None
            async_session_factory_direct = None
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


@asynccontextmanager
async def get_db_direct() -> AsyncGenerator[AsyncSession, None]:
    """Direct (non-pooled) DB session — 풀러 8초 timeout 우회. 큰 보고서/관리 작업 전용.
    DATABASE_URL_DIRECT 미설정 시 일반 풀러 세션으로 폴백."""
    factory = async_session_factory_direct or async_session_factory
    if factory is None:
        raise RuntimeError("Database not configured.")
    async with factory() as session:
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
        # card_aliases — 카드 관리 메뉴 (이름/색상/메모)
        """CREATE TABLE IF NOT EXISTS card_aliases (
            id SERIAL PRIMARY KEY,
            card_key VARCHAR(200) UNIQUE NOT NULL,
            nickname VARCHAR(100) NOT NULL,
            issuer VARCHAR(50),
            last4 VARCHAR(20),
            color VARCHAR(7),
            memo VARCHAR(500),
            is_active BOOLEAN DEFAULT TRUE,
            created_at TIMESTAMP DEFAULT NOW(),
            updated_at TIMESTAMP DEFAULT NOW()
        )""",
        "CREATE INDEX IF NOT EXISTS ix_card_aliases_card_key ON card_aliases(card_key)",
        # card_aliases.assigned_email — 카드 배정 (관리자가 이메일 기준 배정, 직원은 본인 카드만 조회)
        "ALTER TABLE card_aliases ADD COLUMN IF NOT EXISTS assigned_email VARCHAR(255)",
        "CREATE INDEX IF NOT EXISTS ix_card_aliases_assigned_email ON card_aliases(assigned_email) WHERE assigned_email IS NOT NULL",
        # 공동관리 다중 배정 — 여러 직원이 한 카드를 함께 분류/마감
        "ALTER TABLE card_aliases ADD COLUMN IF NOT EXISTS assigned_emails TEXT",
        # 하이픈 은행 스크래핑 인증정보 (암호화 보관, 30일 TTL)
        """CREATE TABLE IF NOT EXISTS hyphen_credentials (
            id SERIAL PRIMARY KEY,
            label VARCHAR(100),
            bank_cd VARCHAR(10) NOT NULL,
            acct_no VARCHAR(50) NOT NULL,
            acct_last4 VARCHAR(8),
            login_method VARCHAR(10) DEFAULT 'CERT',
            enc_sign_cert TEXT,
            enc_sign_pri TEXT,
            enc_sign_pw TEXT,
            enc_acct_pw TEXT,
            enc_user_id TEXT,
            enc_user_pw TEXT,
            cert_subject VARCHAR(300),
            cert_expires_at TIMESTAMP,
            created_by VARCHAR(255),
            created_at TIMESTAMP DEFAULT NOW(),
            expires_at TIMESTAMP NOT NULL,
            last_used_at TIMESTAMP,
            last_status VARCHAR(300)
        )""",
        "CREATE INDEX IF NOT EXISTS ix_hyphen_credentials_bank ON hyphen_credentials(bank_cd)",
        # 동기화 상태 (마지막 동기화 시각/잔액)
        "ALTER TABLE hyphen_credentials ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMP",
        "ALTER TABLE hyphen_credentials ADD COLUMN IF NOT EXISTS last_balance NUMERIC(20,2)",
        # 하이픈 계좌 거래 로컬 원장
        """CREATE TABLE IF NOT EXISTS hyphen_bank_tx (
            id SERIAL PRIMARY KEY,
            credential_id INTEGER,
            bank_cd VARCHAR(10) NOT NULL,
            acct_no VARCHAR(50) NOT NULL,
            acct_last4 VARCHAR(8),
            tr_date VARCHAR(10) NOT NULL,
            tr_time VARCHAR(10),
            in_amt NUMERIC(20,2) DEFAULT 0,
            out_amt NUMERIC(20,2) DEFAULT 0,
            balance NUMERIC(20,2),
            tr_name VARCHAR(300),
            tr_type VARCHAR(50),
            memo TEXT,
            counterparty_acct VARCHAR(60),
            counterparty_name VARCHAR(120),
            dedup_hash VARCHAR(64) UNIQUE NOT NULL,
            synced_at TIMESTAMP DEFAULT NOW()
        )""",
        "CREATE INDEX IF NOT EXISTS ix_hyphen_bank_tx_acct_date ON hyphen_bank_tx(acct_no, tr_date)",
        "CREATE INDEX IF NOT EXISTS ix_hyphen_bank_tx_cred ON hyphen_bank_tx(credential_id)",
        # 급여 세금 설정/오버라이드 (외부 확정값 입력)
        """CREATE TABLE IF NOT EXISTS payroll_tax_settings (
            id SERIAL PRIMARY KEY,
            national_pension_rate DOUBLE PRECISION DEFAULT 4.5,
            health_insurance_rate DOUBLE PRECISION DEFAULT 3.545,
            long_term_care_rate DOUBLE PRECISION DEFAULT 12.95,
            employment_insurance_rate DOUBLE PRECISION DEFAULT 0.9,
            freelance_withholding_rate DOUBLE PRECISION DEFAULT 3.3,
            local_tax_rate DOUBLE PRECISION DEFAULT 10.0,
            updated_at TIMESTAMP DEFAULT NOW()
        )""",
        """CREATE TABLE IF NOT EXISTS payroll_tax_overrides (
            id SERIAL PRIMARY KEY,
            month VARCHAR(7) NOT NULL,
            worker_name VARCHAR(100) NOT NULL,
            income_tax DOUBLE PRECISION,
            local_tax DOUBLE PRECISION,
            insurance DOUBLE PRECISION,
            memo TEXT,
            updated_by VARCHAR(255),
            updated_at TIMESTAMP DEFAULT NOW(),
            CONSTRAINT uq_payroll_tax_override UNIQUE (month, worker_name)
        )""",
        "CREATE INDEX IF NOT EXISTS ix_payroll_tax_overrides_month ON payroll_tax_overrides(month)",
        # 세율 프로필(고용형태·직군별) 컬럼 추가
        "ALTER TABLE payroll_tax_settings ADD COLUMN IF NOT EXISTS profile VARCHAR(40)",
        "ALTER TABLE payroll_tax_settings ADD COLUMN IF NOT EXISTS label VARCHAR(60)",
        # 구 단일행(profile 없거나 'default') 정리 — 새 프로필 insert 시 PK 충돌 방지
        "DELETE FROM payroll_tax_settings WHERE profile IS NULL OR profile = 'default'",
        # id를 명시 지정하던 구코드로 시퀀스가 안 밀렸을 수 있음 → MAX(id)+안전값으로 재설정
        "SELECT setval(pg_get_serial_sequence('payroll_tax_settings','id'), GREATEST(COALESCE((SELECT MAX(id) FROM payroll_tax_settings), 0), 1))",
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_payroll_tax_settings_profile ON payroll_tax_settings(profile)",
        # 카드 사용 분류 — 원장 계정 코드/명
        "ALTER TABLE card_usage_classifications ADD COLUMN IF NOT EXISTS account_code VARCHAR(20)",
        "ALTER TABLE card_usage_classifications ADD COLUMN IF NOT EXISTS account_name VARCHAR(100)",
        # 구매 카탈로그 폴더 분류(부서 등) + 구매요청 채널/계정ID
        "ALTER TABLE purchase_catalog_items ADD COLUMN IF NOT EXISTS folder VARCHAR(100)",
        "CREATE INDEX IF NOT EXISTS ix_purchase_catalog_folder ON purchase_catalog_items(folder) WHERE folder IS NOT NULL",
        "ALTER TABLE purchase_requests ADD COLUMN IF NOT EXISTS channel VARCHAR(50)",
        "ALTER TABLE purchase_requests ADD COLUMN IF NOT EXISTS channel_account_id VARCHAR(200)",
        # 구매 자동승인 설정
        """CREATE TABLE IF NOT EXISTS purchase_settings (
            id SERIAL PRIMARY KEY,
            auto_approve_enabled BOOLEAN DEFAULT FALSE,
            auto_approve_threshold DOUBLE PRECISION DEFAULT 0,
            updated_at TIMESTAMP DEFAULT NOW()
        )""",
        # 계좌 역할 (매출보관/운영지출/적립) — 간접 현금흐름 관리
        """CREATE TABLE IF NOT EXISTS bank_account_roles (
            id SERIAL PRIMARY KEY,
            account_label VARCHAR(80) UNIQUE NOT NULL,
            role VARCHAR(20) DEFAULT 'other',
            memo VARCHAR(200),
            updated_at TIMESTAMP DEFAULT NOW()
        )""",
        # voucher_lines.voucher_id 인덱스 — DELETE/SELECT 성능 (없으면 full scan)
        "CREATE INDEX IF NOT EXISTS ix_voucher_lines_voucher_id ON voucher_lines(voucher_id)",
        # vouchers.source 인덱스 — wehago_import 등 source 기반 조회 성능
        "CREATE INDEX IF NOT EXISTS ix_vouchers_source ON vouchers(source)",
        # === 2026-05-21 성능 인덱스 (재무보고서/사이드바 카운트 가속) ===
        # voucher_lines.account_id — 계정별 GROUP BY 집계 (재무보고서 핵심)
        "CREATE INDEX IF NOT EXISTS ix_voucher_lines_account_id ON voucher_lines(account_id)",
        # voucher_lines (voucher_id, account_id) — JOIN + 집계 동시 최적화
        "CREATE INDEX IF NOT EXISTS ix_voucher_lines_voucher_account ON voucher_lines(voucher_id, account_id)",
        # vouchers.transaction_type — 매출/매입 필터
        "CREATE INDEX IF NOT EXISTS ix_vouchers_transaction_type ON vouchers(transaction_type)",
        # vouchers.external_ref — 멱등성 보장 위해 UNIQUE (중복 INSERT 차단)
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_vouchers_external_ref ON vouchers(external_ref) WHERE external_ref IS NOT NULL",
        # vouchers (voucher_date DESC) — 최신 리스트 페이지네이션
        "CREATE INDEX IF NOT EXISTS ix_vouchers_voucher_date_desc ON vouchers(voucher_date DESC)",
        # auto_voucher_candidates.status — 사이드바 PENDING 카운트
        "CREATE INDEX IF NOT EXISTS ix_avc_status ON auto_voucher_candidates(status)",
        # auto_voucher_candidates.source_type — 타입별 카운트
        "CREATE INDEX IF NOT EXISTS ix_avc_source_type ON auto_voucher_candidates(source_type)",
        # auto_voucher_candidates.confirmed_voucher_id — Voucher → Candidate 역참조
        "CREATE INDEX IF NOT EXISTS ix_avc_confirmed_voucher_id ON auto_voucher_candidates(confirmed_voucher_id) WHERE confirmed_voucher_id IS NOT NULL",
        # auto_voucher_candidates.duplicate_voucher_id — wehago 중복 매칭 역참조
        "CREATE INDEX IF NOT EXISTS ix_avc_duplicate_voucher_id ON auto_voucher_candidates(duplicate_voucher_id) WHERE duplicate_voucher_id IS NOT NULL",
        # auto_voucher_candidates.transaction_date — 날짜 범위 필터 (검수 큐)
        "CREATE INDEX IF NOT EXISTS ix_avc_transaction_date ON auto_voucher_candidates(transaction_date)",
        # ai_raw_transaction_data — data import 검사용 (자주 조회)
        "CREATE INDEX IF NOT EXISTS ix_ai_raw_source_account ON ai_raw_transaction_data(source_account_name) WHERE source_account_name IS NOT NULL",
        # 후보 FK를 ON DELETE SET NULL로 — voucher 삭제 시 후보가 orphan FK로 막히지 않게.
        # (idempotent: confdeltype 'n'(SET NULL)이 아닐 때만 재생성)
        """DO $$
        BEGIN
            IF EXISTS (SELECT 1 FROM pg_constraint
                       WHERE conname = 'fk_auto_voucher_candidates_confirmed_voucher_id_vouchers'
                         AND confdeltype <> 'n') THEN
                ALTER TABLE auto_voucher_candidates
                    DROP CONSTRAINT fk_auto_voucher_candidates_confirmed_voucher_id_vouchers;
            END IF;
            IF NOT EXISTS (SELECT 1 FROM pg_constraint
                           WHERE conname = 'fk_auto_voucher_candidates_confirmed_voucher_id_vouchers') THEN
                ALTER TABLE auto_voucher_candidates
                    ADD CONSTRAINT fk_auto_voucher_candidates_confirmed_voucher_id_vouchers
                    FOREIGN KEY (confirmed_voucher_id) REFERENCES vouchers(id) ON DELETE SET NULL;
            END IF;
            IF EXISTS (SELECT 1 FROM pg_constraint
                       WHERE conname = 'auto_voucher_candidates_duplicate_voucher_id_fkey'
                         AND confdeltype <> 'n') THEN
                ALTER TABLE auto_voucher_candidates
                    DROP CONSTRAINT auto_voucher_candidates_duplicate_voucher_id_fkey;
            END IF;
            IF NOT EXISTS (SELECT 1 FROM pg_constraint
                           WHERE conname = 'auto_voucher_candidates_duplicate_voucher_id_fkey') THEN
                ALTER TABLE auto_voucher_candidates
                    ADD CONSTRAINT auto_voucher_candidates_duplicate_voucher_id_fkey
                    FOREIGN KEY (duplicate_voucher_id) REFERENCES vouchers(id) ON DELETE SET NULL;
            END IF;
        END $$""",
    ]
    # direct engine 있으면 인덱스/마이그레이션은 그쪽으로 (풀러 8초 timeout 우회).
    # 큰 테이블 인덱스 빌드는 풀러로는 거의 실패함.
    migration_engine = engine_direct or engine
    if engine_direct is not None:
        logger.info("Using direct engine for migrations (bypassing pooler timeout)")

    for sql in migrations:
        try:
            async with migration_engine.begin() as conn:
                # 인덱스 빌드를 위한 넉넉한 timeout
                _su = sql.strip().upper()
                if _su.startswith("CREATE INDEX") or _su.startswith("CREATE UNIQUE INDEX"):
                    await conn.execute(text("SET LOCAL statement_timeout = '600s'"))
                await conn.execute(text(sql))
        except Exception as col_err:
            err_str = str(col_err).lower()
            if "duplicate" not in err_str and "already exists" not in err_str:
                logger.warning(f"Migration skipped: {str(col_err)[:120]}")

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
