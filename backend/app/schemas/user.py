"""
Smart Finance Core - User Schemas
사용자 관련 API 스키마
"""
from datetime import datetime
from typing import Optional, List
from pydantic import BaseModel, EmailStr, Field, field_validator
import re


class UserBase(BaseModel):
    """사용자 기본 스키마"""
    email: EmailStr
    username: str = Field(..., min_length=3, max_length=100)
    employee_id: str = Field(..., min_length=1, max_length=50)
    full_name: str = Field(..., min_length=1, max_length=100)
    phone: Optional[str] = None
    position: Optional[str] = None
    department_id: Optional[int] = None
    role_id: Optional[int] = None


class UserCreate(UserBase):
    """사용자 생성 스키마"""
    password: str = Field(..., min_length=8)

    @field_validator('password')
    @classmethod
    def validate_password(cls, v: str) -> str:
        if not re.search(r'[A-Z]', v):
            raise ValueError('비밀번호는 대문자를 포함해야 합니다')
        if not re.search(r'[a-z]', v):
            raise ValueError('비밀번호는 소문자를 포함해야 합니다')
        if not re.search(r'\d', v):
            raise ValueError('비밀번호는 숫자를 포함해야 합니다')
        if not re.search(r'[!@#$%^&*()_+\-=\[\]{}|;:\'",.<>?]', v):
            raise ValueError('비밀번호는 특수문자를 포함해야 합니다')
        return v


class UserUpdate(BaseModel):
    """사용자 수정 스키마"""
    email: Optional[EmailStr] = None
    full_name: Optional[str] = None
    phone: Optional[str] = None
    position: Optional[str] = None
    department_id: Optional[int] = None
    role_id: Optional[int] = None
    is_active: Optional[bool] = None


class UserResponse(BaseModel):
    """사용자 응답 스키마"""
    id: int
    employee_id: str
    email: str
    username: str
    full_name: str
    phone: Optional[str] = None
    position: Optional[str] = None
    department_id: Optional[int] = None
    department_name: Optional[str] = None
    role_id: Optional[int] = None
    role_name: Optional[str] = None
    is_active: bool
    two_factor_enabled: bool
    created_at: datetime
    last_login: Optional[datetime] = None

    class Config:
        from_attributes = True


class UserLogin(BaseModel):
    """로그인 요청 스키마"""
    username: str
    password: str
    otp_code: Optional[str] = None  # 2FA


class Token(BaseModel):
    """토큰 응답 스키마"""
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    expires_in: int  # seconds
    user: UserResponse
    requires_2fa: bool = False


class TokenPayload(BaseModel):
    """토큰 페이로드 스키마"""
    sub: str  # user_id
    exp: datetime
    iat: datetime
    type: str  # access or refresh


class DepartmentBase(BaseModel):
    """부서 기본 스키마"""
    code: str = Field(..., min_length=1, max_length=20)
    name: str = Field(..., min_length=1, max_length=100)
    parent_id: Optional[int] = None
    cost_center_code: Optional[str] = None


class DepartmentCreate(DepartmentBase):
    """부서 생성 스키마"""
    pass


class DepartmentResponse(DepartmentBase):
    """부서 응답 스키마"""
    id: int
    level: int
    sort_order: int
    is_active: bool
    children: List["DepartmentResponse"] = []
    created_at: datetime

    class Config:
        from_attributes = True


class RoleResponse(BaseModel):
    """역할 응답 스키마"""
    id: int
    name: str
    role_type: str
    description: Optional[str] = None
    can_create_voucher: bool
    can_approve_voucher: bool
    can_finalize_voucher: bool
    can_manage_budget: bool
    can_view_all_departments: bool
    can_manage_users: bool
    can_configure_ai: bool
    can_export_data: bool
    can_view_reports: bool
    can_manage_accounts: bool
    approval_limit: Optional[int] = None

    class Config:
        from_attributes = True


# Self-reference for nested departments
DepartmentResponse.model_rebuild()
