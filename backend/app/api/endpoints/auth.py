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
from app.core.security import create_access_token, create_refresh_token, is_accounting_admin
from app.core.sso import verify_hub_token

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


class SSOLoginRequest(BaseModel):
    """중앙 SSO 허브(auth.nuldam.com) 로그인 요청 — 허브가 발급한 app 토큰"""
    token: str


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
        "role_type": user.role.role_type.value if user.role and user.role.role_type else None,
        "is_admin": is_accounting_admin(user),
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
    raise HTTPException(status_code=403, detail="이메일 코드 로그인은 비활성화되었습니다. 회사 Google 계정(SSO)으로 로그인하세요.")
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
    raise HTTPException(status_code=403, detail="이메일 코드 로그인은 비활성화되었습니다. 회사 Google 계정(SSO)으로 로그인하세요.")
    email = otp_data.email.lower()
    import logging as _log
    _logger = _log.getLogger(__name__)

    # OTP 검증
    success, message = verify_otp_code(email, otp_data.otp_code)
    if not success:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=message
        )

    try:
        # 사용자 조회 (없으면 자동 생성)
        result = await db.execute(
            select(User)
            .options(selectinload(User.department), selectinload(User.role))
            .where(User.email == email)
        )
        user = result.scalar_one_or_none()

        if not user:
            _logger.info(f"Creating new user for {email}")
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
    except HTTPException:
        raise
    except Exception as e:
        _logger.error(f"verify-otp DB error: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"로그인 처리 오류: {str(e)}"
        )


@router.post("/sso")
async def sso_login(
    request: Request,
    sso_data: SSOLoginRequest,
    db: AsyncSession = Depends(get_db)
):
    """
    중앙 SSO 허브(auth.nuldam.com) 로그인 — 이메일 OTP 로그인과 별개의 추가 로그인 경로.

    - 프론트엔드가 SSO 허브 리다이렉트에서 받은 `#token=<jwt>` 값을 그대로 전달.
    - 허브가 RS256으로 서명한 app 토큰을 JWKS로 검증 (iss/aud/exp 포함).
    - 검증된 토큰의 이메일로 기존 이메일 OTP 로그인과 동일한 사용자 조회/자동생성
      경로(_auto_create_user)를 재사용하고, account 자체 access/refresh 토큰을 발급.
    - 응답 형식은 /verify-otp 와 동일.
    """
    import logging as _log
    _logger = _log.getLogger(__name__)

    # 허브 토큰 검증 (서명/iss/aud/exp) — 실패 시 401
    payload = await verify_hub_token(sso_data.token)

    email = (payload.get("email") or "").lower().strip()
    if not email:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="SSO 토큰에 이메일 정보가 없습니다."
        )

    # 접근 게이트 — 허브가 account(회계) 접근을 부여한 사용자만 로그인 허용.
    # 허브 사용자라도 account 메뉴 권한(perms)이 하나도 없고 슈퍼관리자도 아니면 차단.
    # 사용자 조회/자동생성 이전에 검사하여 미승인 사용자는 생성조차 되지 않는다.
    super = payload.get("super") is True
    perms = payload.get("perms")
    has_account_grant = super or (isinstance(perms, dict) and len(perms) > 0)
    if not has_account_grant:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="이 시스템에 대한 접근 권한이 없습니다. 관리자에게 문의하세요."
        )

    try:
        # 사용자 조회 (없으면 OTP 로그인과 동일한 방식으로 자동 생성)
        result = await db.execute(
            select(User)
            .options(selectinload(User.department), selectinload(User.role))
            .where(User.email == email)
        )
        user = result.scalar_one_or_none()

        if not user:
            _logger.info(f"Creating new user via SSO for {email}")
            user = await _auto_create_user(db, email)

        if not user.is_active:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="비활성화된 계정입니다. 관리자에게 문의하세요."
            )

        # 허브가 account 관리자 권한의 정본(source of truth) — 허브 클레임을 반영해
        # account 자체 역할(ADMIN/EMPLOYEE)/is_superuser 를 동기화한다.
        # super == True 이거나 perms.admin 이 존재하면 관리자, 아니면 일반 직원.
        perms = payload.get("perms")
        if not isinstance(perms, dict):
            perms = {}
        hub_is_admin = (payload.get("super") is True) or (perms.get("admin") is not None)
        await _sync_admin_from_hub(db, user, hub_is_admin)

        # 마지막 로그인 업데이트
        user.last_login = datetime.utcnow()
        await db.commit()

        # account 자체 세션 토큰 발급 (OTP 로그인과 동일한 헬퍼 재사용)
        access_token = create_access_token({"sub": str(user.id)})
        refresh_token = create_refresh_token({"sub": str(user.id)})

        return {
            "access_token": access_token,
            "refresh_token": refresh_token,
            "token_type": "bearer",
            "expires_in": settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60,
            "user": user_to_response(user),
        }
    except HTTPException:
        raise
    except Exception as e:
        _logger.error(f"sso login DB error: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"로그인 처리 오류: {str(e)}"
        )


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


async def _get_or_create_role(db: AsyncSession, role_type: RoleType) -> Role:
    """지정한 역할 유형을 조회하고, 기본 역할(ADMIN/EMPLOYEE)이 없으면 함께 생성.

    _auto_create_user 의 역할 부트스트랩 로직과 동일한 시드 역할을 사용한다
    (신규 DB 등에서 역할 테이블이 비어 있는 경우 대비).
    """
    role_result = await db.execute(
        select(Role).where(Role.role_type == role_type)
    )
    role = role_result.scalar_one_or_none()
    if role:
        return role

    admin_role = Role(
        name="관리자", role_type=RoleType.ADMIN, description="시스템 전체 관리 권한",
        can_create_voucher=True, can_approve_voucher=True, can_finalize_voucher=True,
        can_manage_budget=True, can_view_all_departments=True, can_manage_users=True,
        can_configure_ai=True, can_export_data=True, can_view_reports=True,
        can_manage_accounts=True, approval_limit=999999999,
    )
    employee_role = Role(
        name="일반직원", role_type=RoleType.EMPLOYEE, description="기본 사용자 권한",
        can_create_voucher=True, can_export_data=True, can_view_reports=True, approval_limit=0,
    )
    db.add(admin_role)
    db.add(employee_role)
    await db.flush()
    return admin_role if role_type == RoleType.ADMIN else employee_role


async def _sync_admin_from_hub(db: AsyncSession, user: User, hub_is_admin: bool) -> None:
    """허브가 부여한 account 관리자 여부를 account 자체 역할 모델에 반영.

    account 는 is_accounting_admin() 이 DB 사용자 레코드(role_type / is_superuser)를
    기준으로 관리자 여부를 판별하므로, 허브 권한을 사용자 레코드에 영속화한다.
    - hub_is_admin True  → ADMIN 역할 + is_superuser=True (관리자 메뉴 접근)
    - hub_is_admin False → EMPLOYEE 역할 + is_superuser=False (일반 로그인)

    OTP 경로(_auto_create_user)의 ADMIN/EMPLOYEE 배정 규칙과 동일한 메커니즘을 사용.
    """
    target_role_type = RoleType.ADMIN if hub_is_admin else RoleType.EMPLOYEE
    current_role_type = user.role.role_type if user.role else None

    if current_role_type != target_role_type:
        role = await _get_or_create_role(db, target_role_type)
        user.role = role
        user.role_id = role.id

    if bool(user.is_superuser) != hub_is_admin:
        user.is_superuser = hub_is_admin


async def _auto_create_user(db: AsyncSession, email: str) -> User:
    """이메일 OTP 로그인 시 사용자 자동 생성 (역할 없으면 함께 생성)"""
    import uuid
    import hashlib

    # 비밀번호 미사용 (OTP 전용) - bcrypt 우회하여 더미 해시 직접 생성
    dummy_hash = "$2b$12$" + hashlib.sha256(uuid.uuid4().bytes).hexdigest()[:53]

    # 관리자 이메일이면 ADMIN 역할, 아니면 EMPLOYEE 역할
    is_admin_email = email.lower() in [e.lower() for e in settings.ADMIN_EMAILS]
    target_role_type = RoleType.ADMIN if is_admin_email else RoleType.EMPLOYEE
    role_result = await db.execute(
        select(Role).where(Role.role_type == target_role_type)
    )
    role = role_result.scalar_one_or_none()

    if not role:
        admin_role = Role(
            name="관리자", role_type=RoleType.ADMIN, description="시스템 전체 관리 권한",
            can_create_voucher=True, can_approve_voucher=True, can_finalize_voucher=True,
            can_manage_budget=True, can_view_all_departments=True, can_manage_users=True,
            can_configure_ai=True, can_export_data=True, can_view_reports=True,
            can_manage_accounts=True, approval_limit=999999999,
        )
        employee_role = Role(
            name="일반직원", role_type=RoleType.EMPLOYEE, description="기본 사용자 권한",
            can_create_voucher=True, can_export_data=True, can_view_reports=True, approval_limit=0,
        )
        db.add(admin_role)
        db.add(employee_role)
        await db.flush()
        role = admin_role if is_admin_email else employee_role

    local_part = email.split("@")[0]
    display_name = local_part.replace(".", " ").replace("_", " ").title()

    # username 유일성 보장 — 같은 local part의 다른 도메인 이메일 (예: gmail/회사메일 동시 사용)
    username = local_part
    existing_username = await db.execute(
        select(User.id).where(User.username == username)
    )
    if existing_username.scalar_one_or_none() is not None:
        username = f"{local_part}-{uuid.uuid4().hex[:4]}"

    user = User(
        employee_id=f"AUTO-{uuid.uuid4().hex[:8].upper()}",
        email=email,
        username=username,
        hashed_password=dummy_hash,
        full_name=display_name,
        role_id=role.id,
        is_active=True,
        is_superuser=True if role.role_type == RoleType.ADMIN else False,
        two_factor_enabled=False,
        failed_login_attempts=0,
        password_changed_at=datetime.utcnow(),
    )

    db.add(user)
    await db.commit()

    result = await db.execute(
        select(User)
        .options(selectinload(User.department), selectinload(User.role))
        .where(User.id == user.id)
    )
    return result.scalar_one()


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
