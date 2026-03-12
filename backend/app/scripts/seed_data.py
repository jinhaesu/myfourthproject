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
from app.models.sales import SalesChannel, ChannelType, ApiType


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
            "sales_automation_schedules", "sales_records", "sales_channels",
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
                name="재무책임자(CFO)",
                role_type=RoleType.CFO,
                description="재무 최고 책임자",
                can_create_voucher=True,
                can_approve_voucher=True,
                can_finalize_voucher=True,
                can_manage_budget=True,
                can_view_all_departments=True,
                can_manage_users=False,
                can_configure_ai=True,
                can_export_data=True,
                can_view_reports=True,
                can_manage_accounts=True,
                approval_limit=999999999,
            ),
            Role(
                name="재무팀원",
                role_type=RoleType.FINANCE_STAFF,
                description="재무팀 실무 담당자",
                can_create_voucher=True,
                can_approve_voucher=False,
                can_finalize_voucher=True,
                can_manage_budget=False,
                can_view_all_departments=True,
                can_manage_users=False,
                can_configure_ai=False,
                can_export_data=True,
                can_view_reports=True,
                can_manage_accounts=True,
                approval_limit=5000000,
            ),
            Role(
                name="부서장",
                role_type=RoleType.DEPARTMENT_HEAD,
                description="부서 단위 결재 및 관리 권한",
                can_create_voucher=True,
                can_approve_voucher=True,
                can_finalize_voucher=False,
                can_manage_budget=True,
                can_view_all_departments=False,
                can_manage_users=False,
                can_configure_ai=False,
                can_export_data=True,
                can_view_reports=True,
                can_manage_accounts=False,
                approval_limit=30000000,
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

        # 본사(HQ) 먼저 생성하여 ID 확보
        hq = Department(code="HQ", name="본사", level=1, sort_order=1, is_active=True)
        db.add(hq)
        await db.flush()  # ID 할당을 위해 flush

        # 하위 부서 생성 (parent_id = HQ)
        sub_departments = [
            Department(code="FIN", name="재무팀", parent_id=hq.id, level=2, sort_order=2, cost_center_code="CC-FIN", is_active=True),
            Department(code="HR", name="인사팀", parent_id=hq.id, level=2, sort_order=3, cost_center_code="CC-HR", is_active=True),
            Department(code="DEV", name="개발팀", parent_id=hq.id, level=2, sort_order=4, cost_center_code="CC-DEV", is_active=True),
            Department(code="SALES", name="영업팀", parent_id=hq.id, level=2, sort_order=5, cost_center_code="CC-SALES", is_active=True),
            Department(code="MKT", name="마케팅팀", parent_id=hq.id, level=2, sort_order=6, cost_center_code="CC-MKT", is_active=True),
        ]

        for dept in sub_departments:
            db.add(dept)

        await db.commit()
        print(f"✅ {1 + len(sub_departments)}개 부서 생성 완료")


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
        result = await db.execute(select(Account).where(Account.code == "110100"))
        if result.scalar_one_or_none():
            print("계정과목이 이미 존재합니다.")
            return

        # 카테고리 ID 조회
        cat_result = await db.execute(select(AccountCategory))
        categories = {cat.code: cat.id for cat in cat_result.scalars().all()}

        accounts = [
            # ============================================================
            # K-IFRS 기준 한국 표준 계정과목 코드 (6자리)
            # 자산: 1xxxxx, 부채: 2xxxxx, 자본: 3xxxxx
            # 매출/수익: 4xxxxx, 매출원가: 5xxxxx
            # 판매비와관리비: 8xxxxx, 영업외손익: 9xxxxx
            # ============================================================

            # 자산 (1xxxxx)
            Account(code="110100", name="현금", category_id=categories["1"], level=1, is_detail=True,
                   keywords="현금,cash", is_active=True),
            Account(code="110200", name="보통예금", category_id=categories["1"], level=1, is_detail=True,
                   keywords="예금,은행,입금", is_active=True),
            Account(code="110300", name="정기예금", category_id=categories["1"], level=1, is_detail=True,
                   keywords="정기예금,적금", is_active=True),
            Account(code="120100", name="매출채권", category_id=categories["1"], level=1, is_detail=True,
                   keywords="외상,미수금,채권", is_active=True),
            Account(code="120200", name="받을어음", category_id=categories["1"], level=1, is_detail=True,
                   keywords="어음,받을어음", is_active=True),
            Account(code="130100", name="선급금", category_id=categories["1"], level=1, is_detail=True,
                   keywords="선급,미리지급", is_active=True),
            Account(code="130200", name="선급비용", category_id=categories["1"], level=1, is_detail=True,
                   keywords="선급비용,선납", is_active=True),
            Account(code="140100", name="재고자산", category_id=categories["1"], level=1, is_detail=True,
                   keywords="재고,상품,제품", is_active=True),
            Account(code="150100", name="부가세대급금", category_id=categories["1"], level=1, is_detail=True,
                   keywords="부가세,매입세액", is_active=True),

            # 부채 (2xxxxx)
            Account(code="210100", name="매입채무", category_id=categories["2"], level=1, is_detail=True,
                   keywords="외상,미지급,채무", is_active=True),
            Account(code="210200", name="지급어음", category_id=categories["2"], level=1, is_detail=True,
                   keywords="어음,지급어음", is_active=True),
            Account(code="220100", name="미지급금", category_id=categories["2"], level=1, is_detail=True,
                   keywords="미지급,미결제", is_active=True),
            Account(code="220200", name="미지급비용", category_id=categories["2"], level=1, is_detail=True,
                   keywords="미지급비용,발생비용", is_active=True),
            Account(code="230100", name="예수금", category_id=categories["2"], level=1, is_detail=True,
                   keywords="원천세,4대보험,예수금", is_active=True),
            Account(code="230200", name="부가세예수금", category_id=categories["2"], level=1, is_detail=True,
                   keywords="부가세,매출세액", is_active=True),
            Account(code="240100", name="단기차입금", category_id=categories["2"], level=1, is_detail=True,
                   keywords="대출,차입", is_active=True),
            Account(code="250100", name="선수금", category_id=categories["2"], level=1, is_detail=True,
                   keywords="선수금,선수", is_active=True),

            # 자본 (3xxxxx)
            Account(code="310100", name="자본금", category_id=categories["3"], level=1, is_detail=True,
                   keywords="자본,출자", is_active=True),
            Account(code="320100", name="자본잉여금", category_id=categories["3"], level=1, is_detail=True,
                   keywords="자본잉여,주식발행초과금", is_active=True),
            Account(code="330100", name="이익잉여금", category_id=categories["3"], level=1, is_detail=True,
                   keywords="이익,잉여", is_active=True),

            # 매출/수익 (4xxxxx)
            Account(code="410100", name="상품매출", category_id=categories["4"], level=1, is_detail=True,
                   keywords="매출,판매,수익,상품매출", is_active=True),
            Account(code="410200", name="제품매출", category_id=categories["4"], level=1, is_detail=True,
                   keywords="제품매출,제조판매", is_active=True),
            Account(code="410300", name="서비스매출", category_id=categories["4"], level=1, is_detail=True,
                   keywords="서비스매출,용역매출", is_active=True),

            # 매출원가 (5xxxxx)
            Account(code="510100", name="상품매출원가", category_id=categories["5"], level=1, is_detail=True,
                   keywords="매출원가,상품원가", is_active=True),
            Account(code="510200", name="제품매출원가", category_id=categories["5"], level=1, is_detail=True,
                   keywords="제조원가,제품원가", is_active=True),
            Account(code="520100", name="원재료비", category_id=categories["5"], level=1, is_detail=True,
                   keywords="원재료,재료비", is_active=True),
            Account(code="520200", name="노무비", category_id=categories["5"], level=1, is_detail=True,
                   keywords="노무비,생산인건비", is_active=True),
            Account(code="520300", name="제조경비", category_id=categories["5"], level=1, is_detail=True,
                   keywords="제조경비,공장경비", is_active=True),

            # 판매비와관리비 (8xxxxx) - 한국 표준
            Account(code="810100", name="급여", category_id=categories["5"], level=1, is_detail=True,
                   keywords="급여,월급,인건비,salary", common_merchants="급여이체", is_active=True),
            Account(code="810200", name="퇴직급여", category_id=categories["5"], level=1, is_detail=True,
                   keywords="퇴직급여,퇴직금", is_active=True),
            Account(code="813100", name="복리후생비", category_id=categories["5"], level=1, is_detail=True,
                   keywords="복리후생,식대,회식,경조사", common_merchants="식당,카페,편의점", is_active=True),
            Account(code="813200", name="접대비", category_id=categories["5"], level=1, is_detail=True,
                   keywords="접대,거래처,식사대접", common_merchants="식당,골프장", is_active=True),
            Account(code="813300", name="여비교통비", category_id=categories["5"], level=1, is_detail=True,
                   keywords="교통비,택시,주유,출장", common_merchants="택시,주유소,KTX,항공", is_active=True),
            Account(code="813400", name="통신비", category_id=categories["5"], level=1, is_detail=True,
                   keywords="통신,전화,인터넷,휴대폰", common_merchants="SKT,KT,LGU+", is_active=True),
            Account(code="813500", name="소모품비", category_id=categories["5"], level=1, is_detail=True,
                   keywords="소모품,사무용품,문구", common_merchants="오피스디포,알파문구", is_active=True),
            Account(code="813600", name="광고선전비", category_id=categories["5"], level=1, is_detail=True,
                   keywords="광고,마케팅,홍보", common_merchants="구글,페이스북,네이버", is_active=True),
            Account(code="813700", name="지급수수료", category_id=categories["5"], level=1, is_detail=True,
                   keywords="수수료,용역,외주", is_active=True),
            Account(code="813800", name="교육훈련비", category_id=categories["5"], level=1, is_detail=True,
                   keywords="교육,훈련,세미나,연수", is_active=True),
            Account(code="813900", name="도서인쇄비", category_id=categories["5"], level=1, is_detail=True,
                   keywords="도서,인쇄,명함,출판", is_active=True),
            Account(code="814000", name="회의비", category_id=categories["5"], level=1, is_detail=True,
                   keywords="회의,회의실,다과", is_active=True),
            Account(code="820100", name="수도광열비", category_id=categories["5"], level=1, is_detail=True,
                   keywords="전기,수도,가스,난방", common_merchants="한전,수도사업소", is_active=True),
            Account(code="820200", name="세금과공과", category_id=categories["5"], level=1, is_detail=True,
                   keywords="세금,공과금,재산세", is_active=True),
            Account(code="820300", name="임차료", category_id=categories["5"], level=1, is_detail=True,
                   keywords="임대료,월세,사무실", is_active=True),
            Account(code="820400", name="수선비", category_id=categories["5"], level=1, is_detail=True,
                   keywords="수리,수선,유지보수", is_active=True),
            Account(code="830100", name="감가상각비", category_id=categories["5"], level=1, is_detail=True,
                   keywords="감가상각,depreciation", is_active=True),
            Account(code="840100", name="보험료", category_id=categories["5"], level=1, is_detail=True,
                   keywords="보험,보험료,화재보험", is_active=True),

            # 영업외수익 (9xxxxx - 수익성)
            Account(code="910100", name="이자수익", category_id=categories["4"], level=1, is_detail=True,
                   keywords="이자,예금이자", is_active=True),
            Account(code="910200", name="배당금수익", category_id=categories["4"], level=1, is_detail=True,
                   keywords="배당금,배당수익", is_active=True),
            Account(code="910300", name="유형자산처분이익", category_id=categories["4"], level=1, is_detail=True,
                   keywords="자산처분,처분이익", is_active=True),
            Account(code="910900", name="잡이익", category_id=categories["4"], level=1, is_detail=True,
                   keywords="잡이익,기타이익", is_active=True),

            # 영업외비용 (9xxxxx - 비용성)
            Account(code="950100", name="이자비용", category_id=categories["5"], level=1, is_detail=True,
                   keywords="이자비용,대출이자", is_active=True),
            Account(code="950200", name="유형자산처분손실", category_id=categories["5"], level=1, is_detail=True,
                   keywords="자산처분,처분손실", is_active=True),
            Account(code="950900", name="잡손실", category_id=categories["5"], level=1, is_detail=True,
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


async def create_sales_channels():
    """기본 판매 채널 생성"""
    async with async_session_factory() as db:
        result = await db.execute(select(SalesChannel).where(SalesChannel.code == "COUPANG"))
        if result.scalar_one_or_none():
            print("판매 채널이 이미 존재합니다.")
            return

        from decimal import Decimal

        channels = [
            SalesChannel(
                code="COUPANG", name="쿠팡",
                channel_type=ChannelType.ONLINE_MARKETPLACE,
                api_type=ApiType.API,
                commission_rate=Decimal("10.80"),
                platform_url="https://wing.coupang.com",
                is_active=True,
            ),
            SalesChannel(
                code="NAVER_SMART", name="네이버 스마트스토어",
                channel_type=ChannelType.ONLINE_MARKETPLACE,
                api_type=ApiType.API,
                commission_rate=Decimal("5.50"),
                platform_url="https://sell.smartstore.naver.com",
                is_active=True,
            ),
            SalesChannel(
                code="GMARKET", name="G마켓",
                channel_type=ChannelType.ONLINE_MARKETPLACE,
                api_type=ApiType.API,
                commission_rate=Decimal("12.00"),
                platform_url="https://www.gmarket.co.kr",
                is_active=True,
            ),
            SalesChannel(
                code="AUCTION", name="옥션",
                channel_type=ChannelType.ONLINE_MARKETPLACE,
                api_type=ApiType.API,
                commission_rate=Decimal("12.00"),
                platform_url="https://www.auction.co.kr",
                is_active=True,
            ),
            SalesChannel(
                code="11ST", name="11번가",
                channel_type=ChannelType.ONLINE_MARKETPLACE,
                api_type=ApiType.API,
                commission_rate=Decimal("12.00"),
                platform_url="https://soffice.11st.co.kr",
                is_active=True,
            ),
            SalesChannel(
                code="WEMAKEPRICE", name="위메프",
                channel_type=ChannelType.ONLINE_MARKETPLACE,
                api_type=ApiType.SCRAPING,
                commission_rate=Decimal("12.00"),
                platform_url="https://wpartner.wemakeprice.com",
                is_active=True,
            ),
            SalesChannel(
                code="TMON", name="티몬",
                channel_type=ChannelType.ONLINE_MARKETPLACE,
                api_type=ApiType.SCRAPING,
                commission_rate=Decimal("12.00"),
                platform_url="https://spc.tmon.co.kr",
                is_active=True,
            ),
            SalesChannel(
                code="INTERPARK", name="인터파크",
                channel_type=ChannelType.ONLINE_MARKETPLACE,
                api_type=ApiType.SCRAPING,
                commission_rate=Decimal("13.00"),
                platform_url="https://incomeplus.interpark.com",
                is_active=True,
            ),
            SalesChannel(
                code="SSG", name="SSG.COM",
                channel_type=ChannelType.ONLINE_MARKETPLACE,
                api_type=ApiType.SCRAPING,
                commission_rate=Decimal("10.00"),
                platform_url="https://www.ssg.com",
                is_active=True,
            ),
            SalesChannel(
                code="LOTTE_ON", name="롯데ON",
                channel_type=ChannelType.ONLINE_MARKETPLACE,
                api_type=ApiType.SCRAPING,
                commission_rate=Decimal("10.00"),
                platform_url="https://www.lotteon.com",
                is_active=True,
            ),
            SalesChannel(
                code="KAKAO_GIFT", name="카카오 선물하기",
                channel_type=ChannelType.ONLINE_MARKETPLACE,
                api_type=ApiType.SCRAPING,
                commission_rate=Decimal("15.00"),
                platform_url="https://gift.kakao.com",
                is_active=True,
            ),
            SalesChannel(
                code="OWN_MALL", name="자사몰",
                channel_type=ChannelType.OWN_WEBSITE,
                api_type=ApiType.MANUAL,
                commission_rate=Decimal("0.00"),
                is_active=True,
            ),
            SalesChannel(
                code="OFFLINE", name="오프라인 매장",
                channel_type=ChannelType.OFFLINE,
                api_type=ApiType.MANUAL,
                commission_rate=Decimal("0.00"),
                is_active=True,
            ),
            SalesChannel(
                code="WHOLESALE", name="도매/B2B",
                channel_type=ChannelType.WHOLESALE,
                api_type=ApiType.MANUAL,
                commission_rate=Decimal("0.00"),
                is_active=True,
            ),
        ]

        for channel in channels:
            db.add(channel)

        await db.commit()
        print(f"✅ {len(channels)}개 판매 채널 생성 완료")


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
    await create_sales_channels()

    print("=" * 50)
    print("🎉 초기 데이터 생성 완료!")
    print("=" * 50)


if __name__ == "__main__":
    asyncio.run(main())
