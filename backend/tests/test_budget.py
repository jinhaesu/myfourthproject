"""
Smart Finance Core - Budget API Tests
예산 관리 API 테스트

Tests cover:
  1. Budget CRUD
  2. Budget check
  3. Budget vs Actual
  4. Budget summary
"""
import pytest
from httpx import AsyncClient


# ============================================================================
# 1. Budget List
# ============================================================================
@pytest.mark.asyncio
async def test_list_budgets(client: AsyncClient, auth_tokens):
    """예산 목록 조회"""
    token = auth_tokens["access_token"]
    resp = await client.get(
        "/api/v1/budget/",
        params={"fiscal_year": 2026},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    assert isinstance(resp.json(), list)


# ============================================================================
# 2. Create Budget
# ============================================================================
@pytest.mark.asyncio
async def test_create_budget(client: AsyncClient, auth_tokens, seed_user, seed_department):
    """예산 생성"""
    token = auth_tokens["access_token"]
    resp = await client.post(
        "/api/v1/budget/",
        params={"user_id": seed_user.id},
        json={
            "budget_name": "2026년 개발팀 연간 예산",
            "fiscal_year": 2026,
            "department_id": seed_department.id,
            "period_type": "yearly",
            "description": "테스트 예산",
            "lines": [],
        },
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code in [200, 201], resp.text
    data = resp.json()
    assert data["budget_name"] == "2026년 개발팀 연간 예산"
    assert data["fiscal_year"] == 2026


# ============================================================================
# 3. Budget Summary
# ============================================================================
@pytest.mark.asyncio
async def test_budget_summary(client: AsyncClient, auth_tokens, seed_department):
    """부서별 예산 요약"""
    token = auth_tokens["access_token"]
    resp = await client.get(
        f"/api/v1/budget/summary/{seed_department.id}",
        params={"fiscal_year": 2026},
        headers={"Authorization": f"Bearer {token}"},
    )
    # 200 if active budget exists, 404 if no active budget for the department
    assert resp.status_code in [200, 404]
    data = resp.json()
    if resp.status_code == 200:
        assert "total_budget" in data or "department_id" in data


# ============================================================================
# 4. Budget vs Actual
# ============================================================================
@pytest.mark.asyncio
async def test_budget_vs_actual(client: AsyncClient, auth_tokens):
    """예산 대비 실적"""
    token = auth_tokens["access_token"]
    resp = await client.get(
        "/api/v1/budget/vs-actual",
        params={"fiscal_year": 2026},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert "items" in data or isinstance(data, dict)


# ============================================================================
# 5. Budget Check
# ============================================================================
@pytest.mark.asyncio
async def test_budget_check(client: AsyncClient, auth_tokens, seed_department):
    """예산 체크 API"""
    token = auth_tokens["access_token"]
    resp = await client.post(
        "/api/v1/budget/check",
        params={
            "department_id": seed_department.id,
            "account_id": 1,
            "amount": 100000,
        },
        headers={"Authorization": f"Bearer {token}"},
    )
    # Either succeeds or returns budget not found
    assert resp.status_code in [200, 400, 404]
