"""
Smart Finance Core - Authentication Tests
이메일 OTP 인증 API 테스트

Tests cover:
  1. Email OTP login flow (request → verify)
  2. OTP verification
  3. Token refresh
  4. Get current user info (/me)
  5. Disallowed email rejection
  6. Logout
"""
import pytest
from httpx import AsyncClient

from app.models.user import User
from app.services.email_service import _otp_store


# ============================================================================
# 1. Email Login - OTP Request
# ============================================================================

@pytest.mark.asyncio
class TestEmailLoginRequest:
    """POST /api/v1/auth/login -- request OTP"""

    async def test_login_request_returns_200(self, client: AsyncClient, seed_user: User):
        resp = await client.post(
            "/api/v1/auth/login",
            json={"email": "test@example.com"},
        )
        assert resp.status_code == 200

    async def test_login_request_returns_otp_required(self, client: AsyncClient, seed_user: User):
        resp = await client.post(
            "/api/v1/auth/login",
            json={"email": "test@example.com"},
        )
        data = resp.json()
        assert data["requires_email_otp"] is True
        assert "email_hint" in data

    async def test_login_request_new_email_returns_200(self, client: AsyncClient):
        """New email (not in DB) should also get OTP sent."""
        resp = await client.post(
            "/api/v1/auth/login",
            json={"email": "brand_new@example.com"},
        )
        assert resp.status_code == 200
        assert resp.json()["requires_email_otp"] is True

    async def test_login_invalid_email_returns_422(self, client: AsyncClient):
        resp = await client.post(
            "/api/v1/auth/login",
            json={"email": "not-an-email"},
        )
        assert resp.status_code == 422

    async def test_login_empty_body_returns_422(self, client: AsyncClient):
        resp = await client.post("/api/v1/auth/login", json={})
        assert resp.status_code == 422


# ============================================================================
# 2. OTP Verification
# ============================================================================

@pytest.mark.asyncio
class TestOTPVerification:
    """POST /api/v1/auth/verify-otp"""

    async def test_verify_valid_otp_returns_tokens(self, client: AsyncClient, seed_user: User):
        # Request OTP
        await client.post("/api/v1/auth/login", json={"email": "test@example.com"})

        # Get OTP from store
        otp_entry = _otp_store.get("test@example.com")
        assert otp_entry is not None
        otp_code = otp_entry["code"]

        # Verify OTP
        resp = await client.post(
            "/api/v1/auth/verify-otp",
            json={"email": "test@example.com", "otp_code": otp_code},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert "access_token" in data
        assert "refresh_token" in data
        assert data["token_type"] == "bearer"
        assert data["expires_in"] > 0

    async def test_verify_otp_returns_user_object(self, client: AsyncClient, seed_user: User):
        await client.post("/api/v1/auth/login", json={"email": "test@example.com"})
        otp_code = _otp_store["test@example.com"]["code"]

        resp = await client.post(
            "/api/v1/auth/verify-otp",
            json={"email": "test@example.com", "otp_code": otp_code},
        )
        user = resp.json()["user"]
        assert user["email"] == "test@example.com"
        assert user["username"] == "testuser"
        assert user["full_name"] == "테스트 사용자"

    async def test_verify_wrong_otp_returns_401(self, client: AsyncClient, seed_user: User):
        await client.post("/api/v1/auth/login", json={"email": "test@example.com"})

        resp = await client.post(
            "/api/v1/auth/verify-otp",
            json={"email": "test@example.com", "otp_code": "000000"},
        )
        assert resp.status_code == 401

    async def test_verify_without_request_returns_401(self, client: AsyncClient):
        resp = await client.post(
            "/api/v1/auth/verify-otp",
            json={"email": "nobody@example.com", "otp_code": "123456"},
        )
        assert resp.status_code == 401

    async def test_verify_otp_auto_creates_user(self, client: AsyncClient):
        """New email should auto-create user on successful OTP."""
        await client.post("/api/v1/auth/login", json={"email": "auto_new@example.com"})
        otp_code = _otp_store["auto_new@example.com"]["code"]

        resp = await client.post(
            "/api/v1/auth/verify-otp",
            json={"email": "auto_new@example.com", "otp_code": otp_code},
        )
        assert resp.status_code == 200
        assert resp.json()["user"]["email"] == "auto_new@example.com"


# ============================================================================
# 3. Token refresh
# ============================================================================

@pytest.mark.asyncio
class TestTokenRefresh:
    """POST /api/v1/auth/refresh"""

    async def test_refresh_returns_new_access_token(
        self, client: AsyncClient, auth_tokens: dict
    ):
        refresh_tok = auth_tokens["refresh_token"]
        resp = await client.post(
            "/api/v1/auth/refresh",
            json={"refresh_token": refresh_tok},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert "access_token" in data
        assert data["token_type"] == "bearer"
        assert data["expires_in"] > 0

    async def test_refresh_with_invalid_token_returns_401(self, client: AsyncClient):
        resp = await client.post(
            "/api/v1/auth/refresh",
            json={"refresh_token": "this.is.invalid"},
        )
        assert resp.status_code == 401

    async def test_refresh_with_access_token_returns_401(
        self, client: AsyncClient, auth_tokens: dict
    ):
        access_tok = auth_tokens["access_token"]
        resp = await client.post(
            "/api/v1/auth/refresh",
            json={"refresh_token": access_tok},
        )
        assert resp.status_code == 401


# ============================================================================
# 4. Get current user info (/me)
# ============================================================================

@pytest.mark.asyncio
class TestGetCurrentUser:
    """GET /api/v1/auth/me"""

    async def test_me_returns_user_info(
        self, client: AsyncClient, auth_tokens: dict
    ):
        access_tok = auth_tokens["access_token"]
        resp = await client.get(
            "/api/v1/auth/me",
            headers={"Authorization": f"Bearer {access_tok}"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["username"] == "testuser"
        assert data["email"] == "test@example.com"

    async def test_me_includes_department_and_role(
        self, client: AsyncClient, auth_tokens: dict
    ):
        access_tok = auth_tokens["access_token"]
        resp = await client.get(
            "/api/v1/auth/me",
            headers={"Authorization": f"Bearer {access_tok}"},
        )
        data = resp.json()
        assert data["department_name"] == "개발팀"
        assert data["role_name"] == "일반직원"

    async def test_me_without_token_returns_401(self, client: AsyncClient):
        resp = await client.get("/api/v1/auth/me")
        assert resp.status_code == 401

    async def test_me_with_invalid_token_returns_401(self, client: AsyncClient):
        resp = await client.get(
            "/api/v1/auth/me",
            headers={"Authorization": "Bearer invalid.token.here"},
        )
        assert resp.status_code == 401


# ============================================================================
# 5. OTP Resend
# ============================================================================

@pytest.mark.asyncio
class TestOTPResend:
    """POST /api/v1/auth/resend-otp"""

    async def test_resend_returns_200(self, client: AsyncClient, seed_user: User):
        resp = await client.post(
            "/api/v1/auth/resend-otp",
            json={"email": "test@example.com"},
        )
        assert resp.status_code == 200
        assert "email_hint" in resp.json()


# ============================================================================
# 6. Logout
# ============================================================================

@pytest.mark.asyncio
class TestLogout:
    """POST /api/v1/auth/logout"""

    async def test_logout_returns_200(self, client: AsyncClient):
        resp = await client.post("/api/v1/auth/logout")
        assert resp.status_code == 200
        assert "로그아웃" in resp.json()["message"]
