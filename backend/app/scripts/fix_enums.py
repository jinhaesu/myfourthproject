"""
PostgreSQL enum 타입 수정 스크립트
기존 enum 타입을 삭제하고 올바른 값으로 재생성
"""
import asyncio
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from sqlalchemy import text
from app.core.database import engine


async def fix_enums():
    """PostgreSQL enum 타입 수정"""
    print("=" * 50)
    print("🔧 PostgreSQL enum 타입 수정 시작")
    print("=" * 50)

    async with engine.begin() as conn:
        # 1. 모든 테이블 삭제 (enum 타입에 의존하므로)
        print("📌 기존 테이블 삭제 중...")

        # 테이블 삭제 (의존성 순서대로)
        tables_to_drop = [
            "login_attempts",
            "data_snapshots",
            "audit_logs",
            "custom_tags",
            "ai_model_versions",
            "ai_training_data",
            "ai_classification_logs",
            "budget_usage",
            "budget_lines",
            "budgets",
            "reconciliation_matches",
            "payment_schedules",
            "payables",
            "receivables",
            "bank_transactions",
            "bank_accounts",
            "approval_history",
            "approval_lines",
            "approval_steps",
            "approval_requests",
            "voucher_attachments",
            "voucher_lines",
            "vouchers",
            "accounts",
            "account_categories",
            "user_sessions",
            "users",
            "departments",
            "roles",
        ]

        for table in tables_to_drop:
            try:
                await conn.execute(text(f"DROP TABLE IF EXISTS {table} CASCADE"))
                print(f"  ✓ {table} 삭제됨")
            except Exception as e:
                print(f"  ⚠ {table} 삭제 실패: {e}")

        # 2. 모든 enum 타입 삭제
        print("\n📌 기존 enum 타입 삭제 중...")

        enum_types = [
            "roletype",
            "transactiontype",
            "voucherstatus",
            "aiclassificationstatus",
            "approvalstatus",
            "approvalactiontype",
            "bankaccounttype",
            "transactiondirection",
            "reconciliationstatus",
            "receivablestatus",
            "payablestatus",
            "budgetperiodtype",
            "budgetstatus",
            "classificationresult",
        ]

        for enum_type in enum_types:
            try:
                await conn.execute(text(f"DROP TYPE IF EXISTS {enum_type} CASCADE"))
                print(f"  ✓ {enum_type} 삭제됨")
            except Exception as e:
                print(f"  ⚠ {enum_type} 삭제 실패: {e}")

        print("\n✅ 정리 완료!")
        print("이제 seed_data.py를 다시 실행하세요.")
        print("테이블과 enum이 올바르게 재생성됩니다.")


if __name__ == "__main__":
    asyncio.run(fix_enums())
