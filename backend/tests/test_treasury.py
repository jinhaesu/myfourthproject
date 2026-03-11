"""
Smart Finance Core - Treasury API Tests
자금 관리 API 테스트

Tests cover:
  1. Cash position
  2. Bank accounts
  3. Receivables / Payables
  4. AR/AP Aging
  5. Auto reconciliation
"""
import pytest
from httpx import AsyncClient


# ============================================================================
# 1. Cash Position
# ============================================================================
@pytest.mark.asyncio
async def test_get_cash_position(client: AsyncClient, auth_tokens):
    """현금 포지션 조회"""
    token = auth_tokens["access_token"]
    resp = await client.get(
        "/api/v1/treasury/cash-position",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert "total_balance" in data
    assert "accounts" in data


# ============================================================================
# 2. Bank Accounts
# ============================================================================
@pytest.mark.asyncio
async def test_get_bank_accounts(client: AsyncClient, auth_tokens):
    """은행계좌 목록 조회"""
    token = auth_tokens["access_token"]
    resp = await client.get(
        "/api/v1/treasury/accounts/",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    assert isinstance(resp.json(), list)


# ============================================================================
# 3. Receivables
# ============================================================================
@pytest.mark.asyncio
async def test_get_receivables(client: AsyncClient, auth_tokens):
    """매출채권 목록 조회"""
    token = auth_tokens["access_token"]
    resp = await client.get(
        "/api/v1/treasury/receivables/",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    assert isinstance(resp.json(), list)


@pytest.mark.asyncio
async def test_get_receivables_with_status_filter(client: AsyncClient, auth_tokens):
    """매출채권 상태 필터"""
    token = auth_tokens["access_token"]
    resp = await client.get(
        "/api/v1/treasury/receivables/",
        params={"status": "pending"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200


# ============================================================================
# 4. Payables
# ============================================================================
@pytest.mark.asyncio
async def test_get_payables(client: AsyncClient, auth_tokens):
    """매입채무 목록 조회"""
    token = auth_tokens["access_token"]
    resp = await client.get(
        "/api/v1/treasury/payables/",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    assert isinstance(resp.json(), list)


# ============================================================================
# 5. Aging Reports
# ============================================================================
@pytest.mark.asyncio
async def test_ar_aging(client: AsyncClient, auth_tokens):
    """매출채권 연령 분석"""
    token = auth_tokens["access_token"]
    resp = await client.get(
        "/api/v1/treasury/receivables/aging",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert "summary" in data or isinstance(data, dict)


@pytest.mark.asyncio
async def test_ap_aging(client: AsyncClient, auth_tokens):
    """매입채무 연령 분석"""
    token = auth_tokens["access_token"]
    resp = await client.get(
        "/api/v1/treasury/payables/aging",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200


# ============================================================================
# 6. Auto Reconciliation
# ============================================================================
@pytest.mark.asyncio
async def test_auto_reconcile(client: AsyncClient, auth_tokens):
    """자동 매칭"""
    token = auth_tokens["access_token"]
    resp = await client.post(
        "/api/v1/treasury/reconcile",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert "matched_count" in data


# ============================================================================
# 7. Upcoming Payments
# ============================================================================
@pytest.mark.asyncio
async def test_get_upcoming_payments(client: AsyncClient, auth_tokens):
    """예정 지급 조회"""
    token = auth_tokens["access_token"]
    resp = await client.get(
        "/api/v1/treasury/payment-schedules/upcoming",
        params={"days_ahead": 30},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    assert isinstance(resp.json(), list)
