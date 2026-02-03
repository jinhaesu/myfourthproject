"""
Smart Finance Core - Approval Schemas
결재 관련 API 스키마
"""
from datetime import datetime
from typing import Optional, List
from pydantic import BaseModel, Field


class ApprovalStepConfig(BaseModel):
    """결재선 단계 설정"""
    step_order: int
    step_name: str
    approver_role_type: Optional[str] = None  # role type 기반
    approver_id: Optional[int] = None  # 특정 사용자 지정
    is_required: bool = True


class ApprovalLineCreate(BaseModel):
    """결재선 생성 스키마"""
    name: str = Field(..., min_length=1, max_length=100)
    description: Optional[str] = None
    department_id: Optional[int] = None
    min_amount: Optional[int] = None
    max_amount: Optional[int] = None
    is_default: bool = False
    steps: List[ApprovalStepConfig]


class ApprovalLineResponse(BaseModel):
    """결재선 응답 스키마"""
    id: int
    name: str
    description: Optional[str] = None
    department_id: Optional[int] = None
    min_amount: Optional[int] = None
    max_amount: Optional[int] = None
    is_active: bool
    is_default: bool
    steps: List[ApprovalStepConfig]
    created_at: datetime

    class Config:
        from_attributes = True


class ApprovalRequestCreate(BaseModel):
    """결재 요청 (기안) 생성 스키마"""
    voucher_id: int
    title: str = Field(..., min_length=1, max_length=200)
    description: Optional[str] = None
    is_urgent: bool = False
    approval_line_id: Optional[int] = None  # 미지정 시 기본 결재선


class ApprovalStepResponse(BaseModel):
    """결재 단계 응답 스키마"""
    id: int
    step_order: int
    step_name: str
    approver_id: int
    approver_name: Optional[str] = None
    approver_position: Optional[str] = None
    delegate_id: Optional[int] = None
    delegate_name: Optional[str] = None
    status: str
    action_type: Optional[str] = None
    action_at: Optional[datetime] = None
    comment: Optional[str] = None
    notified_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class ApprovalRequestResponse(BaseModel):
    """결재 요청 응답 스키마"""
    id: int
    request_number: str
    voucher_id: int
    voucher_number: Optional[str] = None
    title: str
    description: Optional[str] = None
    requester_id: int
    requester_name: Optional[str] = None
    department_id: int
    department_name: Optional[str] = None
    status: str
    current_step: int
    total_steps: int
    is_urgent: bool
    budget_checked: bool
    budget_available: bool
    budget_message: Optional[str] = None
    steps: List[ApprovalStepResponse] = []
    created_at: datetime
    submitted_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class ApprovalAction(BaseModel):
    """결재 액션 스키마"""
    action_type: str  # approve, reject, return, delegate
    comment: Optional[str] = None
    delegate_to: Optional[int] = None  # delegate 시 필수


class ApprovalListResponse(BaseModel):
    """결재 목록 응답 스키마"""
    items: List[ApprovalRequestResponse]
    total: int
    page: int
    size: int
    pages: int


class MyApprovalPendingResponse(BaseModel):
    """내 결재 대기 목록 응답"""
    pending_approvals: List[ApprovalRequestResponse]
    count: int


class ApprovalHistoryResponse(BaseModel):
    """결재 이력 응답 스키마"""
    id: int
    user_id: int
    username: str
    action: str
    action_detail: Optional[str] = None
    previous_status: Optional[str] = None
    new_status: str
    step_order: Optional[int] = None
    comment: Optional[str] = None
    created_at: datetime

    class Config:
        from_attributes = True
