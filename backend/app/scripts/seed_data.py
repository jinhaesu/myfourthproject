"""
Smart Finance Core - 초기 데이터 생성 스크립트
관리자 계정, 기본 계정과목, 부서 등 초기 데이터 설정
"""
import asyncio
import sys
import os

# 프로젝트 루트를 path에 추가
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from datetime import datetime
from sqlalchemy import select, text
from app.core.database import async_session_factory, init_db, engine
from app.core.security import get_password_hash
from app.models.user import User, Role, Department, RoleType
from app.models.accounting import Account, AccountCategory


async def reset_database():
    """데이터베이스 초기화 - 모든 테이블과 enum 타입 삭제"""
    print("🔧 데이터베이스 초기화 중...")

    async with engine.begin() as conn:
        # 모든 테이블 삭제
        tables = [
            "login_attempts", "data_snapshots", "audit_logs", "custom_tags",
            "ai_model_versions", "ai_training_data", "ai_classification_logs",
            "budget_usage", "budget_lines", "budgets",
            "reconciliation_matches", "payment_schedules", "payables", "receivables",
            "bank_transactions", "bank_accounts",
            "approval_history", "approval_lines", "approval_steps", "approval_requests",
            "voucher_attachments", "voucher_lines", "vouchers",
            "accounts", "account_categories", "user_sessions", "users", "departments", "roles",
        ]

        for table in tables:
            try:
                await conn.execute(text(f"DROP TABLE IF EXISTS {table} CASCADE"))
            except:
                pass

        # 모든 enum 타입 삭제
        enums = [
            "roletype", "transactiontype", "voucherstatus", "aiclassificationstatus",
            "approvalstatus", "approvalactiontype", "bankaccounttype", "transactiondirection",
            "reconciliationstatus", "receivablestatus", "payablestatus",
            "budgetperiodtype", "budgetstatus", "classificationresult",
        ]

        for enum in enums:
            try:
                await conn.execute(text(f"DROP TYPE IF EXISTS {enum} CASCADE"))
            except:
                pass

    print("✅ 데이터베이스 초기화 완료")


async def create_roles():
    """기본 역할 생성"""
    async with async_session_factory() as db:
        # 이미 존재하는지 확인
        result = await db.execute(select(Role).where(Role.name == "관리자"))
        if result.scalar_one_or_none():
            print("역할이 이미 존재합니다.")
            return

        roles = [
            Role(
                name="관리자",
                role_type=RoleType.ADMIN,
                description="시스템 전체 관리 권한",
                can_create_voucher=True,
                can_approve_voucher=True,
                can_finalize_voucher=True,
                can_manage_budget=True,
                can_view_all_departments=True,
                can_manage_users=True,
                can_configure_ai=True,
                can_export_data=True,
                can_view_reports=True,
                can_manage_accounts=True,
                approval_limit=999999999,
            ),
            Role(
                name="재무담당자",
                role_type=RoleType.FINANCE_MANAGER,
                description="재무/회계 업무 담당",
                can_create_voucher=True,
                can_approve_voucher=True,
                can_finalize_voucher=True,
                can_manage_budget=True,
                can_view_all_departments=True,
                can_manage_users=False,
                can_configure_ai=False,
                can_export_data=True,
                can_view_reports=True,
                can_manage_accounts=True,
                approval_limit=50000000,
            ),
            Role(
                name="팀장",
                role_type=RoleType.TEAM_LEADER,
                description="팀 단위 결재 권한",
                can_create_voucher=True,
                can_approve_voucher=True,
                can_finalize_voucher=False,
                can_manage_budget=False,
                can_view_all_departments=False,
                can_manage_users=False,
                can_configure_ai=False,
                can_export_data=True,
                can_view_reports=True,
                can_manage_accounts=False,
                approval_limit=10000000,
            ),
            Role(
                name="일반직원",
                role_type=RoleType.EMPLOYEE,
                description="기본 사용자 권한",
                can_create_voucher=True,
                can_approve_voucher=False,
                can_finalize_voucher=False,
                can_manage_budget=False,
                can_view_all_departments=False,
                can_manage_users=False,
                can_configure_ai=False,
                can_export_data=False,
                can_view_reports=False,
                can_manage_accounts=False,
                approval_limit=0,
            ),
        ]

        for role in roles:
            db.add(role)

        await db.commit()
        print(f"✅ {len(roles)}개 역할 생성 완료")


async def create_departments():
    """기본 부서 생성"""
    async with async_session_factory() as db:
        result = await db.execute(select(Department).where(Department.code == "HQ"))
        if result.scalar_one_or_none():
            print("부서가 이미 존재합니다.")
            return

        departments = [
            Department(code="HQ", name="본사", level=1, sort_order=1, is_active=True),
            Department(code="FIN", name="재무팀", level=2, sort_order=2, cost_center_code="CC-FIN", is_active=True),
            Department(code="HR", name="인사팀", level=2, sort_order=3, cost_center_code="CC-HR", is_active=True),
            Department(code="DEV", name="개발팀", level=2, sort_order=4, cost_center_code="CC-DEV", is_active=True),
            Department(code="SALES", name="영업팀", level=2, sort_order=5, cost_center_code="CC-SALES", is_active=True),
            Department(code="MKT", name="마케팅팀", level=2, sort_order=6, cost_center_code="CC-MKT", is_active=True),
        ]

        for dept in departments:
            db.add(dept)

        await db.commit()
        print(f"✅ {len(departments)}개 부서 생성 완료")


async def create_account_categories():
    """계정과목 카테고리 생성"""
    async with async_session_factory() as db:
        result = await db.execute(select(AccountCategory).where(AccountCategory.code == "1"))
        if result.scalar_one_or_none():
            print("계정 카테고리가 이미 존재합니다.")
            return

        categories = [
            AccountCategory(code="1", name="자산", description="회사가 소유한 자산"),
            AccountCategory(code="2", name="부채", description="회사가 갚아야 할 채무"),
            AccountCategory(code="3", name="자본", description="자산에서 부채를 뺀 순자산"),
            AccountCategory(code="4", name="수익", description="영업활동으로 발생한 수익"),
            AccountCategory(code="5", name="비용", description="영업활동으로 발생한 비용"),
        ]

        for cat in categories:
            db.add(cat)

        await db.commit()
        print(f"✅ {len(categories)}개 계정 카테고리 생성 완료")


async def create_accounts():
    """기본 계정과목 생성"""
    async with async_session_factory() as db:
        result = await db.execute(select(Account).where(Account.code == "101"))
        if result.scalar_one_or_none():
            print("계정과목이 이미 존재합니다.")
            return

        # 카테고리 ID 조회
        cat_result = await db.execute(select(AccountCategory))
        categories = {cat.code: cat.id for cat in cat_result.scalars().all()}

        accounts = [
            # 자산 (1xx)
            Account(code="101", name="현금", category_id=categories["1"], level=1, is_detail=True,
                   keywords="현금,cash", is_active=True),
            Account(code="102", name="보통예금", category_id=categories["1"], level=1, is_detail=True,
                   keywords="예금,은행,입금", is_active=True),
            Account(code="103", name="매출채권", category_id=categories["1"], level=1, is_detail=True,
                   keywords="외상,미수금,채권", is_active=True),
            Account(code="104", name="선급금", category_id=categories["1"], level=1, is_detail=True,
                   keywords="선급,미리지급", is_active=True),
            Account(code="105", name="재고자산", category_id=categories["1"], level=1, is_detail=True,
                   keywords="재고,상품,제품", is_active=True),

            # 부채 (2xx)
            Account(code="201", name="매입채무", category_id=categories["2"], level=1, is_detail=True,
                   keywords="외상,미지급,채무", is_active=True),
            Account(code="202", name="미지급금", category_id=categories["2"], level=1, is_detail=True,
                   keywords="미지급,미결제", is_active=True),
            Account(code="203", name="예수금", category_id=categories["2"], level=1, is_detail=True,
                   keywords="원천세,4대보험", is_active=True),
            Account(code="204", name="단기차입금", category_id=categories["2"], level=1, is_detail=True,
                   keywords="대출,차입", is_active=True),

            # 자본 (3xx)
            Account(code="301", name="자본금", category_id=categories["3"], level=1, is_detail=True,
                   keywords="자본,출자", is_active=True),
            Account(code="302", name="이익잉여금", category_id=categories["3"], level=1, is_detail=True,
                   keywords="이익,잉여", is_active=True),

            # 수익 (4xx)
            Account(code="401", name="매출", category_id=categories["4"], level=1, is_detail=True,
                   keywords="매출,판매,수익", is_active=True),
            Account(code="402", name="이자수익", category_id=categories["4"], level=1, is_detail=True,
                   keywords="이자,예금이자", is_active=True),
            Account(code="403", name="기타수익", category_id=categories["4"], level=1, is_detail=True,
                   keywords="기타,잡이익", is_active=True),

            # 비용 (5xx)
            Account(code="501", name="급여", category_id=categories["5"], level=1, is_detail=True,
                   keywords="급여,월급,인건비,salary", common_merchants="급여이체", is_active=True),
            Account(code="502", name="복리후생비", category_id=categories["5"], level=1, is_detail=True,
                   keywords="복리후생,식대,회식,경조사", common_merchants="식당,카페,편의점", is_active=True),
            Account(code="503", name="여비교통비", category_id=categories["5"], level=1, is_detail=True,
                   keywords="교통비,택시,주유,출장", common_merchants="택시,주유소,KTX,항공", is_active=True),
            Account(code="504", name="접대비", category_id=categories["5"], level=1, is_detail=True,
                   keywords="접대,거래처,식사대접", common_merchants="식당,골프장", is_active=True),
            Account(code="505", name="통신비", category_id=categories["5"], level=1, is_detail=True,
                   keywords="통신,전화,인터넷,휴대폰", common_merchants="SKT,KT,LGU+", is_active=True),
            Account(code="506", name="수도광열비", category_id=categories["5"], level=1, is_detail=True,
                   keywords="전기,수도,가스,난방", common_merchants="한전,수도사업소", is_active=True),
            Account(code="507", name="세금과공과", category_id=categories["5"], level=1, is_detail=True,
                   keywords="세금,공과금,재산세", is_active=True),
            Account(code="508", name="임차료", category_id=categories["5"], level=1, is_detail=True,
                   keywords="임대료,월세,사무실", is_active=True),
            Account(code="509", name="수선비", category_id=categories["5"], level=1, is_detail=True,
                   keywords="수리,수선,유지보수", is_active=True),
            Account(code="510", name="소모품비", category_id=categories["5"], level=1, is_detail=True,
                   keywords="소모품,사무용품,문구", common_merchants="오피스디포,알파문구", is_active=True),
            Account(code="511", name="광고선전비", category_id=categories["5"], level=1, is_detail=True,
                   keywords="광고,마케팅,홍보", common_merchants="구글,페이스북,네이버", is_active=True),
            Account(code="512", name="지급수수료", category_id=categories["5"], level=1, is_detail=True,
                   keywords="수수료,용역,외주", is_active=True),
            Account(code="513", name="감가상각비", category_id=categories["5"], level=1, is_detail=True,
                   keywords="감가상각,depreciation", is_active=True),
            Account(code="514", name="잡손실", category_id=categories["5"], level=1, is_detail=True,
                   keywords="잡손실,기타비용", is_active=True),
        ]

        for account in accounts:
            db.add(account)

        await db.commit()
        print(f"✅ {len(accounts)}개 계정과목 생성 완료")


async def create_admin_user():
    """관리자 계정 생성"""
    async with async_session_factory() as db:
        # 이미 존재하는지 확인
        result = await db.execute(select(User).where(User.email == "admin@smartfinance.com"))
        if result.scalar_one_or_none():
            print("관리자 계정이 이미 존재합니다.")
            return

        # 관리자 역할 ID 조회
        role_result = await db.execute(select(Role).where(Role.name == "관리자"))
        admin_role = role_result.scalar_one_or_none()

        # 본사 부서 ID 조회
        dept_result = await db.execute(select(Department).where(Department.code == "HQ"))
        hq_dept = dept_result.scalar_one_or_none()

        if not admin_role or not hq_dept:
            print("❌ 역할 또는 부서가 없습니다. 먼저 생성해주세요.")
            return

        admin_user = User(
            employee_id="ADMIN001",
            email="admin@smartfinance.com",
            username="admin",
            hashed_password=get_password_hash("admin123!"),  # 실제 운영시 변경 필요
            full_name="시스템 관리자",
            phone="010-0000-0000",
            department_id=hq_dept.id,
            role_id=admin_role.id,
            position="관리자",
            is_active=True,
            is_superuser=True,
            two_factor_enabled=False,
            failed_login_attempts=0,
        )

        db.add(admin_user)
        await db.commit()

        print("✅ 관리자 계정 생성 완료")
        print("=" * 50)
        print("📧 이메일: admin@smartfinance.com")
        print("🔑 비밀번호: admin123!")
        print("=" * 50)


async def create_sample_users():
    """샘플 사용자 생성"""
    async with async_session_factory() as db:
        # 역할 조회
        role_result = await db.execute(select(Role))
        roles = {role.name: role.id for role in role_result.scalars().all()}

        # 부서 조회
        dept_result = await db.execute(select(Department))
        depts = {dept.code: dept.id for dept in dept_result.scalars().all()}

        # 이미 존재하는지 확인
        result = await db.execute(select(User).where(User.email == "finance@smartfinance.com"))
        if result.scalar_one_or_none():
            print("샘플 사용자가 이미 존재합니다.")
            return

        users = [
            User(
                employee_id="FIN001",
                email="finance@smartfinance.com",
                username="finance",
                hashed_password=get_password_hash("finance123!"),
                full_name="김재무",
                phone="010-1111-1111",
                department_id=depts.get("FIN"),
                role_id=roles.get("재무담당자"),
                position="재무팀장",
                is_active=True,
                is_superuser=False,
            ),
            User(
                employee_id="DEV001",
                email="developer@smartfinance.com",
                username="developer",
                hashed_password=get_password_hash("dev123!"),
                full_name="이개발",
                phone="010-2222-2222",
                department_id=depts.get("DEV"),
                role_id=roles.get("팀장"),
                position="개발팀장",
                is_active=True,
                is_superuser=False,
            ),
            User(
                employee_id="STAFF001",
                email="staff@smartfinance.com",
                username="staff",
                hashed_password=get_password_hash("staff123!"),
                full_name="박직원",
                phone="010-3333-3333",
                department_id=depts.get("DEV"),
                role_id=roles.get("일반직원"),
                position="사원",
                is_active=True,
                is_superuser=False,
            ),
        ]

        for user in users:
            db.add(user)

        await db.commit()
        print(f"✅ {len(users)}개 샘플 사용자 생성 완료")
        print("📧 finance@smartfinance.com / finance123!")
        print("📧 developer@smartfinance.com / dev123!")
        print("📧 staff@smartfinance.com / staff123!")


async def main():
    """메인 실행 함수"""
    print("=" * 50)
    print("🚀 Smart Finance Core 초기 데이터 생성 시작")
    print("=" * 50)

    # 기존 테이블/enum 삭제 후 재생성
    await reset_database()
    await init_db()
    print("✅ 데이터베이스 테이블 생성 완료")

    # 기본 데이터 생성
    await create_roles()
    await create_departments()
    await create_account_categories()
    await create_accounts()
    await create_admin_user()
    await create_sample_users()

    print("=" * 50)
    print("🎉 초기 데이터 생성 완료!")
    print("=" * 50)


if __name__ == "__main__":
    asyncio.run(main())
