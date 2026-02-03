"""
Smart Finance Core - User Service
사용자 및 인증 관리 서비스
"""
from datetime import datetime, timedelta
from typing import Optional, List, Tuple
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, and_

from app.core.security import (
    verify_password, get_password_hash, validate_password_strength,
    create_access_token, create_refresh_token, decode_token,
    generate_otp
)
from app.core.config import settings
from app.models.user import User, Role, Department, UserSession, RoleType
from app.models.audit import LoginAttempt


class UserService:
    """
    사용자 관리 서비스
    - 사용자 CRUD
    - 인증/로그인
    - 2FA 관리
    """

    def __init__(self, db: AsyncSession):
        self.db = db

    async def create_user(
        self,
        employee_id: str,
        email: str,
        username: str,
        password: str,
        full_name: str,
        phone: Optional[str] = None,
        position: Optional[str] = None,
        department_id: Optional[int] = None,
        role_id: Optional[int] = None
    ) -> User:
        """사용자 생성"""
        # 중복 체크
        existing = await self.db.execute(
            select(User).where(
                (User.email == email) | (User.username == username) | (User.employee_id == employee_id)
            )
        )
        if existing.scalar_first():
            raise ValueError("이미 존재하는 이메일, 사용자명 또는 사번입니다.")

        # 비밀번호 강도 검증
        is_valid, errors = validate_password_strength(password)
        if not is_valid:
            raise ValueError("비밀번호 요구사항: " + ", ".join(errors))

        user = User(
            employee_id=employee_id,
            email=email,
            username=username,
            hashed_password=get_password_hash(password),
            full_name=full_name,
            phone=phone,
            position=position,
            department_id=department_id,
            role_id=role_id,
            password_changed_at=datetime.utcnow()
        )

        self.db.add(user)
        await self.db.commit()
        return user

    async def authenticate(
        self,
        username: str,
        password: str,
        ip_address: Optional[str] = None,
        user_agent: Optional[str] = None
    ) -> Tuple[Optional[User], str, bool]:
        """
        사용자 인증

        Returns:
            (user, message, requires_2fa)
        """
        # 사용자 조회
        result = await self.db.execute(
            select(User).where(
                (User.username == username) | (User.email == username)
            )
        )
        user = result.scalar_one_or_none()

        # 로그인 시도 기록
        login_attempt = LoginAttempt(
            username=username,
            ip_address=ip_address or "",
            user_agent=user_agent,
            success=False,
            failure_reason=None
        )

        if not user:
            login_attempt.failure_reason = "user_not_found"
            self.db.add(login_attempt)
            await self.db.commit()
            return None, "사용자를 찾을 수 없습니다.", False

        # 계정 잠금 체크
        if user.locked_until and user.locked_until > datetime.utcnow():
            login_attempt.failure_reason = "locked"
            self.db.add(login_attempt)
            await self.db.commit()
            return None, "계정이 잠겨있습니다. 잠시 후 다시 시도하세요.", False

        # 비밀번호 확인
        if not verify_password(password, user.hashed_password):
            user.failed_login_attempts += 1

            # 5회 실패 시 15분 잠금
            if user.failed_login_attempts >= 5:
                user.locked_until = datetime.utcnow() + timedelta(minutes=15)
                login_attempt.failure_reason = "locked_after_attempts"
            else:
                login_attempt.failure_reason = "invalid_password"

            self.db.add(login_attempt)
            await self.db.commit()
            return None, "비밀번호가 올바르지 않습니다.", False

        # 비활성 계정 체크
        if not user.is_active:
            login_attempt.failure_reason = "inactive"
            self.db.add(login_attempt)
            await self.db.commit()
            return None, "비활성화된 계정입니다.", False

        # 2FA 체크
        if user.two_factor_enabled:
            login_attempt.success = True
            login_attempt.two_factor_required = True
            self.db.add(login_attempt)
            await self.db.commit()
            return user, "2차 인증이 필요합니다.", True

        # 로그인 성공
        user.failed_login_attempts = 0
        user.locked_until = None
        user.last_login = datetime.utcnow()

        login_attempt.success = True
        self.db.add(login_attempt)
        await self.db.commit()

        return user, "로그인 성공", False

    async def verify_2fa(
        self,
        user_id: int,
        otp_code: str
    ) -> bool:
        """2FA 코드 검증"""
        user = await self.db.get(User, user_id)
        if not user or not user.two_factor_enabled:
            return False

        # 실제로는 TOTP 라이브러리 사용
        # 여기서는 간단한 구현
        # import pyotp
        # totp = pyotp.TOTP(user.two_factor_secret)
        # return totp.verify(otp_code)

        return True  # 임시 구현

    async def create_session(
        self,
        user: User,
        ip_address: Optional[str] = None,
        user_agent: Optional[str] = None
    ) -> dict:
        """세션 및 토큰 생성"""
        # 토큰 생성
        access_token = create_access_token({"sub": str(user.id)})
        refresh_token = create_refresh_token({"sub": str(user.id)})

        # 세션 저장
        session = UserSession(
            user_id=user.id,
            session_token=access_token[:100],  # 일부만 저장
            refresh_token=refresh_token[:100],
            ip_address=ip_address,
            user_agent=user_agent,
            expires_at=datetime.utcnow() + timedelta(days=settings.REFRESH_TOKEN_EXPIRE_DAYS)
        )
        self.db.add(session)
        await self.db.commit()

        return {
            "access_token": access_token,
            "refresh_token": refresh_token,
            "token_type": "bearer",
            "expires_in": settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60
        }

    async def refresh_token(self, refresh_token: str) -> Optional[dict]:
        """토큰 갱신"""
        payload = decode_token(refresh_token)
        if not payload or payload.get("type") != "refresh":
            return None

        user_id = int(payload.get("sub"))
        user = await self.db.get(User, user_id)

        if not user or not user.is_active:
            return None

        # 새 토큰 발급
        new_access_token = create_access_token({"sub": str(user.id)})

        return {
            "access_token": new_access_token,
            "token_type": "bearer",
            "expires_in": settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60
        }

    async def get_user(self, user_id: int) -> Optional[User]:
        """사용자 조회"""
        return await self.db.get(User, user_id)

    async def get_user_by_username(self, username: str) -> Optional[User]:
        """사용자명으로 조회"""
        result = await self.db.execute(
            select(User).where(User.username == username)
        )
        return result.scalar_one_or_none()

    async def update_user(self, user_id: int, **updates) -> User:
        """사용자 정보 수정"""
        user = await self.db.get(User, user_id)
        if not user:
            raise ValueError("사용자를 찾을 수 없습니다.")

        allowed_fields = [
            "email", "full_name", "phone", "position",
            "department_id", "role_id", "is_active"
        ]

        for field in allowed_fields:
            if field in updates and updates[field] is not None:
                setattr(user, field, updates[field])

        user.updated_at = datetime.utcnow()
        await self.db.commit()
        return user

    async def change_password(
        self,
        user_id: int,
        current_password: str,
        new_password: str
    ) -> bool:
        """비밀번호 변경"""
        user = await self.db.get(User, user_id)
        if not user:
            raise ValueError("사용자를 찾을 수 없습니다.")

        if not verify_password(current_password, user.hashed_password):
            raise ValueError("현재 비밀번호가 올바르지 않습니다.")

        is_valid, errors = validate_password_strength(new_password)
        if not is_valid:
            raise ValueError("비밀번호 요구사항: " + ", ".join(errors))

        user.hashed_password = get_password_hash(new_password)
        user.password_changed_at = datetime.utcnow()

        await self.db.commit()
        return True

    async def enable_2fa(self, user_id: int) -> str:
        """2FA 활성화"""
        user = await self.db.get(User, user_id)
        if not user:
            raise ValueError("사용자를 찾을 수 없습니다.")

        # 비밀 키 생성
        import secrets
        secret = secrets.token_urlsafe(32)

        user.two_factor_secret = secret
        user.two_factor_enabled = True

        await self.db.commit()

        return secret

    async def disable_2fa(self, user_id: int) -> bool:
        """2FA 비활성화"""
        user = await self.db.get(User, user_id)
        if not user:
            raise ValueError("사용자를 찾을 수 없습니다.")

        user.two_factor_secret = None
        user.two_factor_enabled = False

        await self.db.commit()
        return True

    async def get_departments(self) -> List[Department]:
        """부서 목록 조회"""
        result = await self.db.execute(
            select(Department).where(
                Department.is_active == True
            ).order_by(Department.level, Department.sort_order)
        )
        return result.scalars().all()

    async def get_roles(self) -> List[Role]:
        """역할 목록 조회"""
        result = await self.db.execute(select(Role))
        return result.scalars().all()
