"""
Smart Finance Core - Authentication Tests
인증 관련 API 테스트

Tests cover:
  1. Login with valid credentials
  2. Login with invalid password
  3. Login with non-existent user
  4. Token refresh
  5. Get current user info (/me)
  6. Registration (회원가입)
  7. Account lockout after 5 failed attempts
  8. Inactive account login rejection
  9. Response structure validation (department_name, role_name eager loading)
"""
import pytest
import pytest_asyncio
from httpx import AsyncClient

from app.models.user import User


# ============================================================================
# 1. Login with valid credentials
# ============================================================================

@pytest.mark.asyncio
class TestLoginSuccess:
    """POST /api/v1/auth/login -- happy path"""

    async def test_login_returns_200(self, client: AsyncClient, seed_user: User):
        resp = await client.post(
            "/api/v1/auth/login",
            json={"username": "testuser", "password": "Test1234!"},
        )
        assert resp.status_code == 200

    async def test_login_returns_tokens(self, client: AsyncClient, seed_user: User):
        resp = await client.post(
            "/api/v1/auth/login",
            json={"username": "testuser", "password": "Test1234!"},
        )
        data = resp.json()
        assert "access_token" in data
        assert "refresh_token" in data
        assert data["token_type"] == "bearer"
        assert data["expires_in"] > 0

    async def test_login_returns_user_object(self, client: AsyncClient, seed_user: User):
        resp = await client.post(
            "/api/v1/auth/login",
            json={"username": "testuser", "password": "Test1234!"},
        )
        data = resp.json()
        user = data["user"]
        assert user["username"] == "testuser"
        assert user["email"] == "test@example.com"
        assert user["full_name"] == "테스트 사용자"
        assert user["is_active"] is True

    async def test_login_includes_department_name(
        self, client: AsyncClient, seed_user: User
    ):
        """Eager loading bug fix: department_name must be present."""
        resp = await client.post(
            "/api/v1/auth/login",
            json={"username": "testuser", "password": "Test1234!"},
        )
        user = resp.json()["user"]
        assert user["department_name"] == "개발팀"

    async def test_login_includes_role_name(
        self, client: AsyncClient, seed_user: User
    ):
        """Eager loading bug fix: role_name must be present."""
        resp = await client.post(
            "/api/v1/auth/login",
            json={"username": "testuser", "password": "Test1234!"},
        )
        user = resp.json()["user"]
        assert user["role_name"] == "일반직원"

    async def test_login_requires_2fa_false(
        self, client: AsyncClient, seed_user: User
    ):
        resp = await client.post(
            "/api/v1/auth/login",
            json={"username": "testuser", "password": "Test1234!"},
        )
        assert resp.json()["requires_2fa"] is False

    async def test_login_by_email(self, client: AsyncClient, seed_user: User):
        """Username field also accepts email."""
        resp = await client.post(
            "/api/v1/auth/login",
            json={"username": "test@example.com", "password": "Test1234!"},
        )
        assert resp.status_code == 200
        assert resp.json()["user"]["username"] == "testuser"


# ============================================================================
# 2. Login with invalid password
# ============================================================================

@pytest.mark.asyncio
class TestLoginInvalidPassword:
    """POST /api/v1/auth/login -- wrong password"""

    async def test_wrong_password_returns_401(
        self, client: AsyncClient, seed_user: User
    ):
        resp = await client.post(
            "/api/v1/auth/login",
            json={"username": "testuser", "password": "WrongPass1!"},
        )
        assert resp.status_code == 401

    async def test_wrong_password_returns_error_detail(
        self, client: AsyncClient, seed_user: User
    ):
        resp = await client.post(
            "/api/v1/auth/login",
            json={"username": "testuser", "password": "WrongPass1!"},
        )
        assert "detail" in resp.json()


# ============================================================================
# 3. Login with non-existent user
# ============================================================================

@pytest.mark.asyncio
class TestLoginNonExistentUser:
    """POST /api/v1/auth/login -- user does not exist"""

    async def test_unknown_user_returns_401(self, client: AsyncClient):
        resp = await client.post(
            "/api/v1/auth/login",
            json={"username": "ghost_user", "password": "NoMatter1!"},
        )
        assert resp.status_code == 401

    async def test_unknown_user_error_message(self, client: AsyncClient):
        resp = await client.post(
            "/api/v1/auth/login",
            json={"username": "ghost_user", "password": "NoMatter1!"},
        )
        data = resp.json()
        assert "detail" in data


# ============================================================================
# 4. Token refresh
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

    async def test_refresh_with_invalid_token_returns_401(
        self, client: AsyncClient, seed_user: User
    ):
        resp = await client.post(
            "/api/v1/auth/refresh",
            json={"refresh_token": "this.is.invalid"},
        )
        assert resp.status_code == 401

    async def test_refresh_with_access_token_returns_401(
        self, client: AsyncClient, auth_tokens: dict
    ):
        """Using an access token (type=access) for refresh should fail."""
        access_tok = auth_tokens["access_token"]
        resp = await client.post(
            "/api/v1/auth/refresh",
            json={"refresh_token": access_tok},
        )
        # access token has type="access", not "refresh", so service rejects it
        assert resp.status_code == 401


# ============================================================================
# 5. Get current user info (/me)
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
        """Eager loading in get_user_from_token must populate these fields."""
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

    async def test_me_with_malformed_auth_header_returns_401(
        self, client: AsyncClient
    ):
        resp = await client.get(
            "/api/v1/auth/me",
            headers={"Authorization": "Token something"},
        )
        assert resp.status_code == 401


# ============================================================================
# 6. Registration
# ============================================================================

@pytest.mark.asyncio
class TestRegistration:
    """POST /api/v1/auth/register"""

    async def test_register_new_user_succeeds(
        self, client: AsyncClient, seed_role, seed_department
    ):
        resp = await client.post(
            "/api/v1/auth/register",
            json={
                "email": "newuser@example.com",
                "username": "newuser",
                "password": "NewPass1!",
                "full_name": "신규 사용자",
                "phone": "010-9999-8888",
                "department_code": "DEV",
                "position": "인턴",
            },
        )
        assert resp.status_code == 200
        data = resp.json()
        assert "user_id" in data
        assert data["email"] == "newuser@example.com"
        assert "승인" in data["message"] or "신청" in data["message"]

    async def test_registered_user_cannot_login_before_approval(
        self, client: AsyncClient, seed_role, seed_department
    ):
        """Newly registered user is inactive; login must fail."""
        await client.post(
            "/api/v1/auth/register",
            json={
                "email": "pending@example.com",
                "username": "pendinguser",
                "password": "Pend1ng!Pass",
                "full_name": "대기 사용자",
            },
        )
        login_resp = await client.post(
            "/api/v1/auth/login",
            json={"username": "pendinguser", "password": "Pend1ng!Pass"},
        )
        assert login_resp.status_code == 401

    async def test_register_duplicate_email_returns_400(
        self, client: AsyncClient, seed_user: User
    ):
        resp = await client.post(
            "/api/v1/auth/register",
            json={
                "email": "test@example.com",  # already taken by seed_user
                "username": "uniquename",
                "password": "Valid1Pass!",
                "full_name": "중복 이메일",
            },
        )
        assert resp.status_code == 400
        assert "이메일" in resp.json()["detail"]

    async def test_register_duplicate_username_returns_400(
        self, client: AsyncClient, seed_user: User
    ):
        resp = await client.post(
            "/api/v1/auth/register",
            json={
                "email": "unique@example.com",
                "username": "testuser",  # already taken by seed_user
                "password": "Valid1Pass!",
                "full_name": "중복 사용자명",
            },
        )
        assert resp.status_code == 400
        assert "사용자명" in resp.json()["detail"]


# ============================================================================
# 7. Account lockout after 5 failed attempts
# ============================================================================

@pytest.mark.asyncio
class TestAccountLockout:
    """POST /api/v1/auth/login -- brute-force protection"""

    async def test_account_locks_after_5_failed_attempts(
        self, client: AsyncClient, seed_user: User
    ):
        """After 5 wrong passwords the account should be locked (15 min)."""
        for i in range(5):
            resp = await client.post(
                "/api/v1/auth/login",
                json={"username": "testuser", "password": f"Wrong{i}Pass!"},
            )
            assert resp.status_code == 401, f"Attempt {i+1} should fail"

        # 6th attempt -- even with correct password, account is locked
        resp = await client.post(
            "/api/v1/auth/login",
            json={"username": "testuser", "password": "Test1234!"},
        )
        assert resp.status_code == 401
        assert "잠겨" in resp.json()["detail"]


# ============================================================================
# 8. Inactive account login rejection
# ============================================================================

@pytest.mark.asyncio
class TestInactiveAccountLogin:
    """Inactive users should be rejected at login."""

    async def test_inactive_user_cannot_login(
        self, client: AsyncClient, seed_inactive_user: User
    ):
        resp = await client.post(
            "/api/v1/auth/login",
            json={"username": "inactiveuser", "password": "Test1234!"},
        )
        assert resp.status_code == 401
        assert "비활성" in resp.json()["detail"]


# ============================================================================
# 9. Response structure / edge-case validations
# ============================================================================

@pytest.mark.asyncio
class TestResponseStructure:
    """Validate the full shape of the Token response."""

    async def test_token_response_has_all_required_fields(
        self, client: AsyncClient, seed_user: User
    ):
        resp = await client.post(
            "/api/v1/auth/login",
            json={"username": "testuser", "password": "Test1234!"},
        )
        data = resp.json()

        # Top-level fields
        assert "access_token" in data
        assert "refresh_token" in data
        assert "token_type" in data
        assert "expires_in" in data
        assert "user" in data
        assert "requires_2fa" in data

        # User sub-object fields
        user = data["user"]
        expected_user_fields = [
            "id", "employee_id", "email", "username", "full_name",
            "phone", "position", "department_id", "department_name",
            "role_id", "role_name", "is_active", "two_factor_enabled",
            "created_at",
        ]
        for field in expected_user_fields:
            assert field in user, f"Missing field: {field}"

    async def test_login_with_empty_body_returns_422(
        self, client: AsyncClient
    ):
        resp = await client.post("/api/v1/auth/login", json={})
        assert resp.status_code == 422

    async def test_login_with_missing_password_returns_422(
        self, client: AsyncClient
    ):
        resp = await client.post(
            "/api/v1/auth/login", json={"username": "testuser"}
        )
        assert resp.status_code == 422


# ============================================================================
# 10. Logout
# ============================================================================

@pytest.mark.asyncio
class TestLogout:
    """POST /api/v1/auth/logout"""

    async def test_logout_returns_200(self, client: AsyncClient, seed_user: User):
        resp = await client.post("/api/v1/auth/logout")
        assert resp.status_code == 200
        assert "로그아웃" in resp.json()["message"]
