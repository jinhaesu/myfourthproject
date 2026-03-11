"""
Smart Finance Core - Authentication API
인증 관련 API 엔드포인트
"""
from fastapi import APIRouter, Depends, HTTPException, status, Request
from sqlalchemy.ext.asyncio import AsyncSession
from pydantic import BaseModel, EmailStr
from typing import Optional

from app.core.database import get_db
from app.schemas.user import UserLogin, Token, UserResponse
from app.services.user_service import UserService

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


@router.post("/login", response_model=Token)
async def login(
    request: Request,
    login_data: UserLogin,
    db: AsyncSession = Depends(get_db)
):
    """
    로그인

    - 사용자명/이메일과 비밀번호로 로그인
    - 2FA 활성화된 경우 OTP 코드 필요
    """
    service = UserService(db)

    # 클라이언트 정보
    ip_address = request.client.host if request.client else None
    user_agent = request.headers.get("user-agent")

    # 인증
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

    # 2FA 필요한 경우
    if requires_2fa:
        if not login_data.otp_code:
            return {
                "access_token": "",
                "refresh_token": "",
                "token_type": "bearer",
                "expires_in": 0,
                "user": user_to_response(user),
                "requires_2fa": True
            }

        # OTP 검증
        if not await service.verify_2fa(user.id, login_data.otp_code):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="2차 인증 코드가 올바르지 않습니다."
            )

    # 세션 생성
    tokens = await service.create_session(user, ip_address, user_agent)

    return {
        **tokens,
        "user": user_to_response(user),
        "requires_2fa": False
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
    # 실제로는 세션 무효화 처리
    return {"message": "로그아웃 되었습니다."}


@router.post("/register")
async def register(
    request: RegisterRequest,
    db: AsyncSession = Depends(get_db)
):
    """
    회원가입 신청

    - 신청 후 관리자 승인이 필요합니다
    - 승인 후 로그인이 가능합니다
    """
    service = UserService(db)

    # 이메일 중복 확인
    existing = await service.get_by_email(request.email)
    if existing:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="이미 등록된 이메일입니다."
        )

    # 사용자명 중복 확인
    existing = await service.get_by_username(request.username)
    if existing:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="이미 사용 중인 사용자명입니다."
        )

    # 회원가입 신청 (is_active=False로 생성, 관리자 승인 필요)
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
    # Authorization 헤더에서 토큰 추출
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
