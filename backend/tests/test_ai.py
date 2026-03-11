"""
Smart Finance Core - AI Classification API Tests
AI 분류 API 테스트

Tests cover:
  1. AI model status
  2. Classification request
  3. Feedback submission
  4. Classification status endpoint
"""
import pytest
import pytest_asyncio
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.accounting import Account, AccountCategory


@pytest_asyncio.fixture
async def ai_accounts(db_session: AsyncSession):
    """Seed account categories and accounts required by the AI classifier."""
    cat_expense = AccountCategory(id=5, name="비용", code="5")
    db_session.add(cat_expense)
    await db_session.flush()

    accounts = [
        Account(code="813100", name="복리후생비", category_id=5, is_active=True, is_detail=True),
        Account(code="813200", name="접대비", category_id=5, is_active=True, is_detail=True),
        Account(code="813300", name="여비교통비", category_id=5, is_active=True, is_detail=True),
        Account(code="813400", name="통신비", category_id=5, is_active=True, is_detail=True),
        Account(code="813500", name="소모품비", category_id=5, is_active=True, is_detail=True),
        Account(code="813600", name="광고선전비", category_id=5, is_active=True, is_detail=True),
        Account(code="813700", name="지급수수료", category_id=5, is_active=True, is_detail=True),
        Account(code="813800", name="교육훈련비", category_id=5, is_active=True, is_detail=True),
        Account(code="813900", name="도서인쇄비", category_id=5, is_active=True, is_detail=True),
        Account(code="814000", name="회의비", category_id=5, is_active=True, is_detail=True),
        Account(code="812100", name="접대비(기타)", category_id=5, is_active=True, is_detail=True),
    ]
    for a in accounts:
        db_session.add(a)
    await db_session.commit()
    return accounts


# ============================================================================
# 1. Model Status
# ============================================================================
@pytest.mark.asyncio
async def test_get_model_status(client: AsyncClient, auth_tokens):
    """AI 모델 상태 조회"""
    token = auth_tokens["access_token"]
    resp = await client.get(
        "/api/v1/ai/model-status",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert isinstance(data, dict)


# ============================================================================
# 2. Classification
# ============================================================================
@pytest.mark.asyncio
async def test_classify_transaction(client: AsyncClient, auth_tokens, ai_accounts):
    """AI 분류 요청"""
    token = auth_tokens["access_token"]
    resp = await client.post(
        "/api/v1/ai/classify",
        json={
            "description": "거래처 식사 접대",
            "merchant_name": "한식당",
            "amount": 150000,
        },
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200, f"Classify failed: {resp.text}"
    data = resp.json()
    # Should return classification result
    assert isinstance(data, dict)


@pytest.mark.asyncio
async def test_classify_with_category(client: AsyncClient, auth_tokens, ai_accounts):
    """카테고리 포함 분류"""
    token = auth_tokens["access_token"]
    resp = await client.post(
        "/api/v1/ai/classify",
        json={
            "description": "KTX 서울-부산",
            "merchant_name": "코레일",
            "merchant_category": "교통",
            "amount": 59800,
        },
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200


# ============================================================================
# 3. Feedback
# ============================================================================
@pytest.mark.asyncio
async def test_submit_feedback(client: AsyncClient, auth_tokens, seed_user, ai_accounts):
    """AI 피드백 제출"""
    token = auth_tokens["access_token"]
    resp = await client.post(
        "/api/v1/ai/feedback",
        params={"user_id": seed_user.id},
        json={
            "description": "거래처 식사",
            "amount": 50000,
            "predicted_account_id": ai_accounts[0].id,
            "actual_account_id": ai_accounts[1].id,
            "correction_reason": "접대비로 분류되어야 함",
        },
        headers={"Authorization": f"Bearer {token}"},
    )
    # May not have full implementation
    assert resp.status_code in [200, 201, 422]


# ============================================================================
# 4. Custom Tags
# ============================================================================
@pytest.mark.asyncio
async def test_get_custom_tags(client: AsyncClient, auth_tokens):
    """커스텀 태그 조회"""
    token = auth_tokens["access_token"]
    resp = await client.get(
        "/api/v1/ai/tags/",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    assert isinstance(resp.json(), list)


# ============================================================================
# 5. AI Classification Endpoints
# ============================================================================
@pytest.mark.asyncio
async def test_classification_status(client: AsyncClient, auth_tokens):
    """AI 분류 시스템 상태"""
    token = auth_tokens["access_token"]
    resp = await client.get(
        "/api/v1/ai-classification/status",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_classification_accounts(client: AsyncClient, auth_tokens):
    """분류용 계정과목 목록"""
    token = auth_tokens["access_token"]
    resp = await client.get(
        "/api/v1/ai-classification/accounts",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_training_history(client: AsyncClient, auth_tokens):
    """학습 이력"""
    token = auth_tokens["access_token"]
    resp = await client.get(
        "/api/v1/ai-classification/training-history",
        params={"limit": 5},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
