"""
Smart Finance Core - Forecast API Tests
손익 예측 API 테스트

Tests cover:
  1. Dashboard KPIs
  2. P&L forecast
  3. Cash flow forecast
  4. Scenario simulation
"""
import pytest
from httpx import AsyncClient


# ============================================================================
# 1. Dashboard
# ============================================================================
@pytest.mark.asyncio
async def test_dashboard_kpis(client: AsyncClient, auth_tokens):
    """대시보드 KPI 조회"""
    token = auth_tokens["access_token"]
    resp = await client.get(
        "/api/v1/forecast/dashboard",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    data = resp.json()
    # Should have key metrics
    assert isinstance(data, dict)


# ============================================================================
# 2. P&L Forecast
# ============================================================================
@pytest.mark.asyncio
async def test_pl_forecast(client: AsyncClient, auth_tokens):
    """추정 손익계산서"""
    token = auth_tokens["access_token"]
    resp = await client.get(
        "/api/v1/forecast/pl",
        params={"period_start": "2026-01-01", "period_end": "2026-03-31"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert isinstance(data, dict)


@pytest.mark.asyncio
async def test_pl_forecast_with_department(client: AsyncClient, auth_tokens, seed_department):
    """부서별 추정 손익"""
    token = auth_tokens["access_token"]
    resp = await client.get(
        "/api/v1/forecast/pl",
        params={
            "period_start": "2026-01-01",
            "period_end": "2026-12-31",
            "department_id": seed_department.id,
        },
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200


# ============================================================================
# 3. Cash Flow Forecast
# ============================================================================
@pytest.mark.asyncio
async def test_cash_flow_forecast(client: AsyncClient, auth_tokens):
    """자금 예측"""
    token = auth_tokens["access_token"]
    resp = await client.get(
        "/api/v1/forecast/cashflow",
        params={"forecast_days": 30},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert isinstance(data, dict)


# ============================================================================
# 4. Scenario Simulation
# ============================================================================
@pytest.mark.asyncio
async def test_scenario_simulation(client: AsyncClient, auth_tokens):
    """시나리오 시뮬레이션"""
    token = auth_tokens["access_token"]
    resp = await client.post(
        "/api/v1/forecast/scenario",
        json={
            "scenario_name": "매출 성장 시나리오",
            "base_period_start": "2026-01-01",
            "base_period_end": "2026-03-31",
            "forecast_periods": 12,
            "variables": [
                {
                    "variable_name": "revenue_growth",
                    "change_type": "percentage",
                    "change_value": 10.0,
                }
            ],
        },
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert isinstance(data, dict)


@pytest.mark.asyncio
async def test_scenario_negative_revenue(client: AsyncClient, auth_tokens):
    """매출 감소 시나리오"""
    token = auth_tokens["access_token"]
    resp = await client.post(
        "/api/v1/forecast/scenario",
        json={
            "scenario_name": "매출 감소 시나리오",
            "base_period_start": "2026-01-01",
            "base_period_end": "2026-06-30",
            "forecast_periods": 6,
            "variables": [
                {
                    "variable_name": "revenue_growth",
                    "change_type": "percentage",
                    "change_value": -20.0,
                }
            ],
        },
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
