"""
Smart Finance Core - Users API
사용자 관리 API 엔드포인트
"""
from typing import List
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.schemas.user import (
    UserCreate, UserUpdate, UserResponse,
    DepartmentCreate, DepartmentResponse, RoleResponse
)
from app.services.user_service import UserService

router = APIRouter()


@router.post("/", response_model=UserResponse, status_code=status.HTTP_201_CREATED)
async def create_user(
    user_data: UserCreate,
    db: AsyncSession = Depends(get_db)
):
    """사용자 생성"""
    service = UserService(db)

    try:
        user = await service.create_user(
            employee_id=user_data.employee_id,
            email=user_data.email,
            username=user_data.username,
            password=user_data.password,
            full_name=user_data.full_name,
            phone=user_data.phone,
            position=user_data.position,
            department_id=user_data.department_id,
            role_id=user_data.role_id
        )
        return UserResponse.model_validate(user)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))


@router.get("/{user_id}", response_model=UserResponse)
async def get_user(
    user_id: int,
    db: AsyncSession = Depends(get_db)
):
    """사용자 조회"""
    service = UserService(db)
    user = await service.get_user(user_id)

    if not user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="사용자를 찾을 수 없습니다."
        )

    return UserResponse.model_validate(user)


@router.patch("/{user_id}", response_model=UserResponse)
async def update_user(
    user_id: int,
    user_data: UserUpdate,
    db: AsyncSession = Depends(get_db)
):
    """사용자 정보 수정"""
    service = UserService(db)

    try:
        user = await service.update_user(user_id, **user_data.model_dump(exclude_unset=True))
        return UserResponse.model_validate(user)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))


@router.post("/{user_id}/change-password")
async def change_password(
    user_id: int,
    current_password: str,
    new_password: str,
    db: AsyncSession = Depends(get_db)
):
    """비밀번호 변경"""
    service = UserService(db)

    try:
        await service.change_password(user_id, current_password, new_password)
        return {"message": "비밀번호가 변경되었습니다."}
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))


@router.post("/{user_id}/enable-2fa")
async def enable_2fa(
    user_id: int,
    db: AsyncSession = Depends(get_db)
):
    """2FA 활성화"""
    service = UserService(db)

    try:
        secret = await service.enable_2fa(user_id)
        return {
            "message": "2차 인증이 활성화되었습니다.",
            "secret": secret
        }
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))


@router.post("/{user_id}/disable-2fa")
async def disable_2fa(
    user_id: int,
    db: AsyncSession = Depends(get_db)
):
    """2FA 비활성화"""
    service = UserService(db)

    try:
        await service.disable_2fa(user_id)
        return {"message": "2차 인증이 비활성화되었습니다."}
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))


@router.get("/departments/", response_model=List[DepartmentResponse])
async def get_departments(
    db: AsyncSession = Depends(get_db)
):
    """부서 목록 조회"""
    service = UserService(db)
    departments = await service.get_departments()
    return [DepartmentResponse.model_validate(d) for d in departments]


@router.get("/roles/", response_model=List[RoleResponse])
async def get_roles(
    db: AsyncSession = Depends(get_db)
):
    """역할 목록 조회"""
    service = UserService(db)
    roles = await service.get_roles()
    return [RoleResponse.model_validate(r) for r in roles]
