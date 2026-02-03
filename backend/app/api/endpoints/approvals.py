"""
Smart Finance Core - Approvals API
결재 관리 API 엔드포인트
"""
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

        response = ApprovalRequestResponse.model_validate(approval_request)
        return response
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))


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
        pending_approvals=[ApprovalRequestResponse.model_validate(a) for a in approvals],
        count=len(approvals)
    )


@router.get("/{approval_id}", response_model=ApprovalRequestResponse)
async def get_approval_request(
    approval_id: int,
    db: AsyncSession = Depends(get_db)
):
    """결재 요청 상세 조회"""
    from app.models.approval import ApprovalRequest

    approval = await db.get(ApprovalRequest, approval_id)

    if not approval:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="결재 요청을 찾을 수 없습니다."
        )

    return ApprovalRequestResponse.model_validate(approval)


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

        return ApprovalRequestResponse.model_validate(approval_request)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))


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

        return ApprovalRequestResponse.model_validate(approval_request)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))


@router.get("/{approval_id}/history", response_model=List[ApprovalHistoryResponse])
async def get_approval_history(
    approval_id: int,
    db: AsyncSession = Depends(get_db)
):
    """결재 이력 조회"""
    from app.models.approval import ApprovalHistory
    from sqlalchemy import select

    result = await db.execute(
        select(ApprovalHistory).where(
            ApprovalHistory.approval_request_id == approval_id
        ).order_by(ApprovalHistory.created_at)
    )
    history = result.scalars().all()

    return [ApprovalHistoryResponse.model_validate(h) for h in history]


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

    return [ApprovalLineResponse.model_validate(l) for l in lines]


@router.post("/lines/", response_model=ApprovalLineResponse, status_code=status.HTTP_201_CREATED)
async def create_approval_line(
    line_data: ApprovalLineCreate,
    user_id: int = Query(..., description="현재 사용자 ID"),
    db: AsyncSession = Depends(get_db)
):
    """결재선 생성"""
    import json
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

    return ApprovalLineResponse.model_validate(line)
