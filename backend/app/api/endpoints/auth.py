"""
Smart Finance Core - Authentication API
인증 관련 API 엔드포인트
"""
from fastapi import APIRouter, Depends, HTTPException, status, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.schemas.user import UserLogin, Token, UserResponse
from app.services.user_service import UserService

router = APIRouter()


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
                "user": UserResponse.model_validate(user),
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
        "user": UserResponse.model_validate(user),
        "requires_2fa": False
    }


@router.post("/refresh", response_model=dict)
async def refresh_token(
    refresh_token: str,
    db: AsyncSession = Depends(get_db)
):
    """토큰 갱신"""
    service = UserService(db)
    result = await service.refresh_token(refresh_token)

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
