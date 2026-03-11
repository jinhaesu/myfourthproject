"""
Smart Finance Core - Authentication API
이메일 OTP 인증 (Resend) - 비밀번호 없이 이메일만으로 로그인
"""
from fastapi import APIRouter, Depends, HTTPException, status, Request
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from sqlalchemy.orm import selectinload
from pydantic import BaseModel, EmailStr
from typing import Optional
from datetime import datetime

from app.core.database import get_db
from app.core.config import settings
from app.models.user import User, Role, RoleType
from app.services.user_service import UserService
from app.services.email_service import (
    is_email_allowed, send_otp_email, verify_otp_code,
)
from app.core.security import create_access_token, create_refresh_token

router = APIRouter()


class EmailLoginRequest(BaseModel):
    """이메일 로그인 요청 (OTP 발송)"""
    email: EmailStr


class VerifyOTPRequest(BaseModel):
    """OTP 검증 요청"""
    email: EmailStr
    otp_code: str


class RefreshRequest(BaseModel):
    """토큰 갱신 요청"""
    refresh_token: str


def user_to_response(user) -> dict:
    """User ORM 객체를 응답 dict로 변환"""
    return {
        "id": user.id,
        "employee_id": user.employee_id,
        "email": user.email,
        "username": user.username,
        "full_name": user.full_name,
        "phone": getattr(user, 'phone', None),
        "position": getattr(user, 'position', None),
        "department_id": user.department_id,
        "department_name": user.department.name if user.department else None,
        "role_id": user.role_id,
        "role_name": user.role.name if user.role else None,
        "is_active": user.is_active,
        "two_factor_enabled": getattr(user, 'two_factor_enabled', False),
        "created_at": user.created_at,
        "last_login": user.last_login,
    }


@router.post("/login")
async def login_request_otp(
    request: Request,
    login_data: EmailLoginRequest,
    db: AsyncSession = Depends(get_db)
):
    """
    이메일 로그인 - OTP 발송

    1. 이메일 화이트리스트 확인
    2. OTP 생성 및 Resend로 발송
    3. 사용자가 없으면 자동 생성
    """
    email = login_data.email.lower()

    # 화이트리스트 확인
    if not is_email_allowed(email):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="등록되지 않은 이메일입니다. 관리자에게 문의하세요."
        )

    # OTP 발송
    sent = await send_otp_email(email)
    if not sent:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="인증 이메일 발송에 실패했습니다. 잠시 후 다시 시도해주세요."
        )

    return {
        "message": "인증 코드가 이메일로 전송되었습니다.",
        "email_hint": _mask_email(email),
        "requires_email_otp": True,
    }


@router.post("/verify-otp")
async def verify_email_otp(
    request: Request,
    otp_data: VerifyOTPRequest,
    db: AsyncSession = Depends(get_db)
):
    """
    OTP 인증 확인 → 토큰 발급

    - OTP 검증 성공 시 JWT 토큰 반환
    - 사용자가 DB에 없으면 자동 생성 (화이트리스트에 있는 이메일)
    """
    email = otp_data.email.lower()

    # OTP 검증
    success, message = verify_otp_code(email, otp_data.otp_code)
    if not success:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=message
        )

    # 사용자 조회 (없으면 자동 생성)
    result = await db.execute(
        select(User)
        .options(selectinload(User.department), selectinload(User.role))
        .where(User.email == email)
    )
    user = result.scalar_one_or_none()

    if not user:
        user = await _auto_create_user(db, email)

    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="비활성화된 계정입니다. 관리자에게 문의하세요."
        )

    # 마지막 로그인 업데이트
    user.last_login = datetime.utcnow()
    await db.commit()

    # 토큰 발급
    access_token = create_access_token({"sub": str(user.id)})
    refresh_token = create_refresh_token({"sub": str(user.id)})

    return {
        "access_token": access_token,
        "refresh_token": refresh_token,
        "token_type": "bearer",
        "expires_in": settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60,
        "user": user_to_response(user),
    }


@router.post("/resend-otp")
async def resend_email_otp(
    data: EmailLoginRequest,
    db: AsyncSession = Depends(get_db)
):
    """OTP 이메일 재발송"""
    email = data.email.lower()

    if not is_email_allowed(email):
        # 보안: 존재 여부 노출하지 않음
        return {"message": "인증 코드가 이메일로 전송되었습니다.", "email_hint": "***"}

    from app.services.email_service import clear_otp
    clear_otp(email)
    await send_otp_email(email)

    return {
        "message": "인증 코드가 이메일로 재전송되었습니다.",
        "email_hint": _mask_email(email),
    }


@router.post("/refresh", response_model=dict)
async def refresh_token(
    request_body: RefreshRequest,
    db: AsyncSession = Depends(get_db)
):
    """토큰 갱신"""
    service = UserService(db)
    result = await service.refresh_token(request_body.refresh_token)

    if not result:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="유효하지 않은 토큰입니다."
        )

    return result


@router.post("/logout")
async def logout():
    """로그아웃"""
    return {"message": "로그아웃 되었습니다."}


@router.get("/me")
async def get_current_user_info(
    request: Request,
    db: AsyncSession = Depends(get_db)
):
    """현재 로그인한 사용자 정보 조회"""
    auth_header = request.headers.get("Authorization")
    if not auth_header or not auth_header.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="인증이 필요합니다."
        )

    token = auth_header.split(" ")[1]
    service = UserService(db)
    user = await service.get_user_from_token(token)

    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="유효하지 않은 토큰입니다."
        )

    return user_to_response(user)


async def _auto_create_user(db: AsyncSession, email: str) -> User:
    """화이트리스트 이메일로 사용자 자동 생성"""
    import uuid
    from app.core.security import get_password_hash

    # 기본 역할 조회
    role_result = await db.execute(
        select(Role).where(Role.role_type == RoleType.EMPLOYEE)
    )
    role = role_result.scalar_one_or_none()

    # 이메일에서 이름 추출
    local_part = email.split("@")[0]
    display_name = local_part.replace(".", " ").replace("_", " ").title()

    user = User(
        employee_id=f"AUTO-{uuid.uuid4().hex[:8].upper()}",
        email=email,
        username=local_part,
        hashed_password=get_password_hash(uuid.uuid4().hex),  # 랜덤 패스워드 (사용 안 함)
        full_name=display_name,
        role_id=role.id if role else None,
        is_active=True,
        is_superuser=False,
        two_factor_enabled=False,
        failed_login_attempts=0,
        password_changed_at=datetime.utcnow(),
    )

    db.add(user)
    await db.commit()
    await db.refresh(user, attribute_names=["department", "role"])

    return user


def _mask_email(email: str) -> str:
    """이메일 마스킹: ab***@gmail.com"""
    parts = email.split("@")
    if len(parts) != 2:
        return "***"
    local = parts[0]
    if len(local) <= 2:
        masked = local[0] + "***"
    else:
        masked = local[:2] + "***"
    return f"{masked}@{parts[1]}"
