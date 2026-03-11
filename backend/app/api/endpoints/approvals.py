"""
Smart Finance Core - Approvals API
결재 관리 API 엔드포인트
"""
import json
from typing import Optional, List
from fastapi import APIRouter, Depends, HTTPException, status, Query, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.schemas.approval import (
    ApprovalRequestCreate, ApprovalRequestResponse, ApprovalAction,
    ApprovalListResponse, ApprovalLineCreate, ApprovalLineResponse,
    MyApprovalPendingResponse, ApprovalHistoryResponse
)
from app.services.workflow_engine import WorkflowEngine

router = APIRouter()


def approval_to_response(approval) -> dict:
    """ApprovalRequest ORM 객체를 ApprovalRequestResponse 호환 dict로 변환"""
    steps = []
    for step in (approval.steps if hasattr(approval, 'steps') and approval.steps else []):
        steps.append({
            "id": step.id,
            "step_order": step.step_order,
            "step_name": step.step_name,
            "approver_id": step.approver_id,
            "approver_name": step.approver.full_name if hasattr(step, 'approver') and step.approver else None,
            "approver_position": step.approver.position if hasattr(step, 'approver') and step.approver else None,
            "delegate_id": step.delegate_id,
            "delegate_name": step.delegate.full_name if hasattr(step, 'delegate') and step.delegate else None,
            "status": step.status.value if hasattr(step.status, 'value') else str(step.status),
            "action_type": step.action_type.value if step.action_type and hasattr(step.action_type, 'value') else None,
            "action_at": step.action_at,
            "comment": step.comment,
            "notified_at": step.notified_at,
        })

    return {
        "id": approval.id,
        "request_number": approval.request_number,
        "voucher_id": approval.voucher_id,
        "voucher_number": approval.voucher.voucher_number if hasattr(approval, 'voucher') and approval.voucher else None,
        "title": approval.title,
        "description": approval.description,
        "requester_id": approval.requester_id,
        "requester_name": approval.requester.full_name if hasattr(approval, 'requester') and approval.requester else None,
        "department_id": approval.department_id,
        "department_name": approval.department.name if hasattr(approval, 'department') and approval.department else None,
        "status": approval.status.value if hasattr(approval.status, 'value') else str(approval.status),
        "current_step": approval.current_step,
        "total_steps": approval.total_steps,
        "is_urgent": approval.is_urgent,
        "budget_checked": approval.budget_checked,
        "budget_available": approval.budget_available,
        "budget_message": approval.budget_message,
        "steps": steps,
        "created_at": approval.created_at,
        "submitted_at": approval.submitted_at,
        "completed_at": approval.completed_at,
    }


@router.post("/", response_model=ApprovalRequestResponse, status_code=status.HTTP_201_CREATED)
async def create_approval_request(
    request_data: ApprovalRequestCreate,
    user_id: int = Query(..., description="현재 사용자 ID"),
    db: AsyncSession = Depends(get_db)
):
    """
    결재 요청 (기안) 생성

    - 전표에 대한 결재를 요청합니다
    - 예산 체크가 자동으로 수행됩니다
    """
    workflow = WorkflowEngine(db)

    try:
        approval_request, message = await workflow.create_approval_request(
            voucher_id=request_data.voucher_id,
            requester_id=user_id,
            title=request_data.title,
            description=request_data.description,
            is_urgent=request_data.is_urgent,
            approval_line_id=request_data.approval_line_id
        )

        response = approval_to_response(approval_request)
        return response
    except ValueError as e:
        error_msg = str(e)
        if "찾을 수 없" in error_msg or "not found" in error_msg.lower():
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=error_msg)
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=error_msg)


@router.get("/pending", response_model=MyApprovalPendingResponse)
async def get_my_pending_approvals(
    user_id: int = Query(..., description="현재 사용자 ID"),
    include_delegated: bool = True,
    db: AsyncSession = Depends(get_db)
):
    """
    내 결재 대기 목록

    - 현재 사용자가 결재해야 할 건들을 조회합니다
    """
    workflow = WorkflowEngine(db)

    approvals = await workflow.get_pending_approvals(user_id, include_delegated)

    return MyApprovalPendingResponse(
        pending_approvals=[approval_to_response(a) for a in approvals],
        count=len(approvals)
    )


@router.get("/{approval_id}", response_model=ApprovalRequestResponse)
async def get_approval_request(
    approval_id: int,
    db: AsyncSession = Depends(get_db)
):
    """결재 요청 상세 조회"""
    from app.models.approval import ApprovalRequest, ApprovalStep
    from sqlalchemy import select
    from sqlalchemy.orm import selectinload

    result = await db.execute(
        select(ApprovalRequest)
        .options(
            selectinload(ApprovalRequest.steps),
            selectinload(ApprovalRequest.voucher),
            selectinload(ApprovalRequest.requester),
            selectinload(ApprovalRequest.department),
        )
        .where(ApprovalRequest.id == approval_id)
    )
    approval = result.scalar_one_or_none()

    if not approval:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="결재 요청을 찾을 수 없습니다."
        )

    return approval_to_response(approval)


@router.post("/{approval_id}/action", response_model=ApprovalRequestResponse)
async def process_approval_action(
    approval_id: int,
    action_data: ApprovalAction,
    request: Request,
    user_id: int = Query(..., description="현재 사용자 ID"),
    db: AsyncSession = Depends(get_db)
):
    """
    결재 액션 처리

    - approve: 승인
    - reject: 반려
    - return: 재상신 요청
    - delegate: 위임
    """
    workflow = WorkflowEngine(db)

    ip_address = request.client.host if request.client else None

    try:
        approval_request, message = await workflow.process_approval_action(
            approval_request_id=approval_id,
            approver_id=user_id,
            action_type=action_data.action_type,
            comment=action_data.comment,
            delegate_to=action_data.delegate_to,
            ip_address=ip_address
        )

        return approval_to_response(approval_request)
    except ValueError as e:
        error_msg = str(e)
        if "찾을 수 없" in error_msg or "not found" in error_msg.lower():
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=error_msg)
        if "권한" in error_msg or "permission" in error_msg.lower():
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=error_msg)
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=error_msg)


@router.post("/{approval_id}/cancel", response_model=ApprovalRequestResponse)
async def cancel_approval_request(
    approval_id: int,
    reason: Optional[str] = None,
    user_id: int = Query(..., description="현재 사용자 ID"),
    db: AsyncSession = Depends(get_db)
):
    """기안 취소"""
    workflow = WorkflowEngine(db)

    try:
        approval_request, message = await workflow.cancel_approval_request(
            approval_request_id=approval_id,
            requester_id=user_id,
            reason=reason
        )

        return approval_to_response(approval_request)
    except ValueError as e:
        error_msg = str(e)
        if "찾을 수 없" in error_msg or "not found" in error_msg.lower():
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=error_msg)
        if "권한" in error_msg or "permission" in error_msg.lower():
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=error_msg)
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=error_msg)


@router.get("/{approval_id}/history", response_model=List[ApprovalHistoryResponse])
async def get_approval_history(
    approval_id: int,
    db: AsyncSession = Depends(get_db)
):
    """결재 이력 조회"""
    from app.models.approval import ApprovalHistory
    from sqlalchemy import select
    from sqlalchemy.orm import selectinload

    result = await db.execute(
        select(ApprovalHistory)
        .options(selectinload(ApprovalHistory.user))
        .where(
            ApprovalHistory.approval_request_id == approval_id
        ).order_by(ApprovalHistory.created_at)
    )
    history = result.scalars().all()

    return [
        {
            "id": h.id,
            "user_id": h.user_id,
            "username": h.user.username if h.user else "",
            "action": h.action,
            "action_detail": h.action_detail,
            "previous_status": h.previous_status,
            "new_status": h.new_status,
            "step_order": h.step_order,
            "comment": h.comment,
            "created_at": h.created_at,
        }
        for h in history
    ]


# 결재선 관리

@router.get("/lines/", response_model=List[ApprovalLineResponse])
async def get_approval_lines(
    department_id: Optional[int] = None,
    db: AsyncSession = Depends(get_db)
):
    """결재선 목록 조회"""
    from app.models.approval import ApprovalLine
    from sqlalchemy import select, or_

    query = select(ApprovalLine).where(ApprovalLine.is_active == True)

    if department_id:
        query = query.where(
            or_(
                ApprovalLine.department_id == department_id,
                ApprovalLine.department_id.is_(None)
            )
        )

    result = await db.execute(query)
    lines = result.scalars().all()

    return [
        {
            "id": l.id,
            "name": l.name,
            "description": l.description,
            "department_id": l.department_id,
            "min_amount": l.min_amount,
            "max_amount": l.max_amount,
            "is_active": l.is_active,
            "is_default": l.is_default,
            "steps": json.loads(l.line_config) if l.line_config else [],
            "created_at": l.created_at,
        }
        for l in lines
    ]


@router.post("/lines/", response_model=ApprovalLineResponse, status_code=status.HTTP_201_CREATED)
async def create_approval_line(
    line_data: ApprovalLineCreate,
    user_id: int = Query(..., description="현재 사용자 ID"),
    db: AsyncSession = Depends(get_db)
):
    """결재선 생성"""
    from app.models.approval import ApprovalLine

    line = ApprovalLine(
        name=line_data.name,
        description=line_data.description,
        department_id=line_data.department_id,
        min_amount=line_data.min_amount,
        max_amount=line_data.max_amount,
        is_default=line_data.is_default,
        line_config=json.dumps([s.model_dump() for s in line_data.steps]),
        created_by=user_id
    )

    db.add(line)
    await db.commit()

    return {
        "id": line.id,
        "name": line.name,
        "description": line.description,
        "department_id": line.department_id,
        "min_amount": line.min_amount,
        "max_amount": line.max_amount,
        "is_active": line.is_active,
        "is_default": line.is_default,
        "steps": [s.model_dump() for s in line_data.steps],
        "created_at": line.created_at,
    }
