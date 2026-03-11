"""
Smart Finance Core - Authentication API
인증 관련 API 엔드포인트 (Resend 이메일 OTP 포함)
"""
from fastapi import APIRouter, Depends, HTTPException, status, Request
from sqlalchemy.ext.asyncio import AsyncSession
from pydantic import BaseModel, EmailStr
from typing import Optional

from app.core.database import get_db
from app.core.config import settings
from app.schemas.user import UserLogin, Token, UserResponse
from app.services.user_service import UserService
from app.services.email_service import (
    is_email_allowed, send_otp_email, verify_otp_code, clear_otp
)

router = APIRouter()


class RegisterRequest(BaseModel):
    """회원가입 요청"""
    email: EmailStr
    username: str
    password: str
    full_name: str
    phone: Optional[str] = None
    department_code: Optional[str] = None
    position: Optional[str] = None


class RefreshRequest(BaseModel):
    """토큰 갱신 요청"""
    refresh_token: str


class VerifyOTPRequest(BaseModel):
    """이메일 OTP 검증 요청"""
    username: str
    otp_code: str


def user_to_response(user) -> dict:
    """User ORM 객체를 UserResponse 호환 dict로 변환"""
    return {
        "id": user.id,
        "employee_id": user.employee_id,
        "email": user.email,
        "username": user.username,
        "full_name": user.full_name,
        "phone": user.phone,
        "position": user.position,
        "department_id": user.department_id,
        "department_name": user.department.name if user.department else None,
        "role_id": user.role_id,
        "role_name": user.role.name if user.role else None,
        "is_active": user.is_active,
        "two_factor_enabled": user.two_factor_enabled,
        "created_at": user.created_at,
        "last_login": user.last_login,
    }


@router.post("/login")
async def login(
    request: Request,
    login_data: UserLogin,
    db: AsyncSession = Depends(get_db)
):
    """
    로그인 (이메일 OTP 인증 포함)

    Flow:
    1. username/password 인증
    2. 이메일 화이트리스트 확인
    3. OTP 이메일 발송 → requires_email_otp: true 반환
    4. OTP 코드와 함께 /verify-otp 호출 → 토큰 발급
    """
    service = UserService(db)

    ip_address = request.client.host if request.client else None
    user_agent = request.headers.get("user-agent")

    # 1) 비밀번호 인증
    user, message, requires_2fa = await service.authenticate(
        login_data.username,
        login_data.password,
        ip_address,
        user_agent
    )

    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=message
        )

    # 2) 이메일 화이트리스트 확인
    if not is_email_allowed(user.email):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="등록되지 않은 이메일입니다. 관리자에게 문의하세요."
        )

    # 3) 기존 2FA (TOTP) 처리
    if requires_2fa and not login_data.otp_code:
        return {
            "access_token": "",
            "refresh_token": "",
            "token_type": "bearer",
            "expires_in": 0,
            "user": user_to_response(user),
            "requires_2fa": True,
            "requires_email_otp": False,
        }

    if requires_2fa and login_data.otp_code:
        if not await service.verify_2fa(user.id, login_data.otp_code):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="2차 인증 코드가 올바르지 않습니다."
            )

    # 4) Resend 이메일 OTP 발송 (RESEND_API_KEY 설정 시에만 활성화)
    if settings.RESEND_API_KEY:
        sent = await send_otp_email(user.email)
        if not sent:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="인증 이메일 발송에 실패했습니다. 잠시 후 다시 시도해주세요."
            )

        return {
            "access_token": "",
            "refresh_token": "",
            "token_type": "bearer",
            "expires_in": 0,
            "user": user_to_response(user),
            "requires_2fa": False,
            "requires_email_otp": True,
            "email_hint": _mask_email(user.email),
        }

    # Resend 미설정 시: OTP 없이 바로 토큰 발급 (개발 모드)
    tokens = await service.create_session(user, ip_address, user_agent)
    return {
        **tokens,
        "user": user_to_response(user),
        "requires_2fa": False,
        "requires_email_otp": False,
    }


@router.post("/verify-otp")
async def verify_email_otp(
    request: Request,
    otp_data: VerifyOTPRequest,
    db: AsyncSession = Depends(get_db)
):
    """
    이메일 OTP 인증 확인 → 토큰 발급

    로그인 후 이메일로 받은 6자리 코드를 입력하여 최종 인증
    """
    service = UserService(db)

    # 사용자 조회
    from sqlalchemy import select
    from sqlalchemy.orm import selectinload
    from app.models.user import User

    result = await db.execute(
        select(User)
        .options(selectinload(User.department), selectinload(User.role))
        .where((User.username == otp_data.username) | (User.email == otp_data.username))
    )
    user = result.scalar_one_or_none()

    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="사용자를 찾을 수 없습니다."
        )

    # OTP 검증
    success, message = verify_otp_code(user.email, otp_data.otp_code)
    if not success:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=message
        )

    # 토큰 발급
    ip_address = request.client.host if request.client else None
    user_agent = request.headers.get("user-agent")
    tokens = await service.create_session(user, ip_address, user_agent)

    return {
        **tokens,
        "user": user_to_response(user),
        "requires_2fa": False,
        "requires_email_otp": False,
    }


@router.post("/resend-otp")
async def resend_email_otp(
    request: Request,
    data: dict,
    db: AsyncSession = Depends(get_db)
):
    """OTP 이메일 재발송"""
    username = data.get("username")
    if not username:
        raise HTTPException(status_code=400, detail="사용자명이 필요합니다.")

    from sqlalchemy import select
    from app.models.user import User

    result = await db.execute(
        select(User).where((User.username == username) | (User.email == username))
    )
    user = result.scalar_one_or_none()

    if not user:
        # 보안: 사용자 존재 여부를 노출하지 않음
        return {"message": "인증 코드가 이메일로 전송되었습니다.", "email_hint": "***"}

    clear_otp(user.email)
    sent = await send_otp_email(user.email)

    return {
        "message": "인증 코드가 이메일로 전송되었습니다.",
        "email_hint": _mask_email(user.email),
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
async def logout(
    db: AsyncSession = Depends(get_db)
):
    """로그아웃"""
    return {"message": "로그아웃 되었습니다."}


@router.post("/register")
async def register(
    request: RegisterRequest,
    db: AsyncSession = Depends(get_db)
):
    """
    회원가입 신청

    - 이메일 화이트리스트 확인
    - 신청 후 관리자 승인이 필요합니다
    """
    # 화이트리스트 확인
    if not is_email_allowed(request.email):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="등록이 허용되지 않은 이메일입니다. 관리자에게 문의하세요."
        )

    service = UserService(db)

    existing = await service.get_by_email(request.email)
    if existing:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="이미 등록된 이메일입니다."
        )

    existing = await service.get_by_username(request.username)
    if existing:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="이미 사용 중인 사용자명입니다."
        )

    user = await service.create_pending_user(
        email=request.email,
        username=request.username,
        password=request.password,
        full_name=request.full_name,
        phone=request.phone,
        department_code=request.department_code,
        position=request.position
    )

    return {
        "message": "회원가입 신청이 완료되었습니다. 관리자 승인 후 로그인이 가능합니다.",
        "user_id": user.id,
        "email": user.email
    }


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
