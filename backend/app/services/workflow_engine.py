"""
Smart Finance Core - Workflow Engine
전사적 기안 및 결재 프로세스 엔진
"""
import json
from datetime import datetime
from typing import Optional, List, Tuple
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, and_, or_

from app.models.user import User, Department, RoleType
from app.models.accounting import Voucher, VoucherStatus
from app.models.approval import (
    ApprovalRequest, ApprovalStep, ApprovalLine, ApprovalHistory,
    ApprovalStatus, ApprovalActionType
)
from app.models.budget import Budget, BudgetLine
from app.services.budget_service import BudgetService


class WorkflowEngine:
    """
    결재 워크플로우 엔진
    - 결재선 자동 생성
    - 결재 진행 관리
    - 예산 체크 연동
    - 결재 이력 관리
    """

    def __init__(self, db: AsyncSession):
        self.db = db
        self.budget_service = BudgetService(db)

    async def create_approval_request(
        self,
        voucher_id: int,
        requester_id: int,
        title: str,
        description: Optional[str] = None,
        is_urgent: bool = False,
        approval_line_id: Optional[int] = None
    ) -> Tuple[ApprovalRequest, str]:
        """
        결재 요청 생성

        Returns:
            (ApprovalRequest, message)
        """
        # 전표 조회
        voucher = await self.db.get(Voucher, voucher_id)
        if not voucher:
            raise ValueError("전표를 찾을 수 없습니다.")

        if voucher.status != VoucherStatus.DRAFT:
            raise ValueError("임시저장 상태의 전표만 기안할 수 있습니다.")

        # 기안자 정보 조회
        requester = await self.db.get(User, requester_id)
        if not requester:
            raise ValueError("기안자를 찾을 수 없습니다.")

        # 결재선 결정
        approval_line = await self._determine_approval_line(
            voucher, requester, approval_line_id
        )

        # 예산 체크
        budget_check = await self._check_budget(voucher)

        # 기안번호 생성
        request_number = await self._generate_request_number()

        # 결재 요청 생성
        approval_request = ApprovalRequest(
            request_number=request_number,
            voucher_id=voucher_id,
            title=title,
            description=description,
            requester_id=requester_id,
            department_id=voucher.department_id,
            status=ApprovalStatus.PENDING,
            current_step=1,
            total_steps=len(approval_line["steps"]),
            is_urgent=is_urgent,
            budget_checked=True,
            budget_available=budget_check["is_available"],
            budget_message=budget_check["message"],
            submitted_at=datetime.utcnow()
        )
        self.db.add(approval_request)
        await self.db.flush()

        # 결재 단계 생성
        for step_config in approval_line["steps"]:
            approver_id = await self._resolve_approver(
                step_config, requester, voucher.department_id
            )

            step = ApprovalStep(
                approval_request_id=approval_request.id,
                step_order=step_config["step_order"],
                step_name=step_config["step_name"],
                approver_id=approver_id,
                status=ApprovalStatus.PENDING if step_config["step_order"] == 1 else ApprovalStatus.PENDING
            )
            self.db.add(step)

            # 첫 번째 단계 결재자에게 알림 (실제로는 알림 서비스 연동)
            if step_config["step_order"] == 1:
                step.notified_at = datetime.utcnow()

        # 전표 상태 업데이트
        voucher.status = VoucherStatus.PENDING_APPROVAL

        # 이력 기록
        await self._record_history(
            approval_request.id,
            requester_id,
            "submit",
            None,
            ApprovalStatus.PENDING.value,
            "기안 상신"
        )

        await self.db.commit()

        message = "기안이 상신되었습니다."
        if not budget_check["is_available"]:
            message += f" (주의: {budget_check['message']})"

        return approval_request, message

    async def _determine_approval_line(
        self,
        voucher: Voucher,
        requester: User,
        approval_line_id: Optional[int]
    ) -> dict:
        """결재선 결정"""
        if approval_line_id:
            # 지정된 결재선 사용
            result = await self.db.execute(
                select(ApprovalLine).where(
                    ApprovalLine.id == approval_line_id,
                    ApprovalLine.is_active == True
                )
            )
            line = result.scalar_one_or_none()
            if line:
                return {
                    "line_id": line.id,
                    "line_name": line.name,
                    "steps": json.loads(line.line_config)
                }

        # 부서별 기본 결재선 조회
        result = await self.db.execute(
            select(ApprovalLine).where(
                and_(
                    ApprovalLine.is_active == True,
                    or_(
                        ApprovalLine.department_id == voucher.department_id,
                        ApprovalLine.department_id.is_(None)
                    ),
                    or_(
                        ApprovalLine.min_amount.is_(None),
                        ApprovalLine.min_amount <= float(voucher.total_debit)
                    ),
                    or_(
                        ApprovalLine.max_amount.is_(None),
                        ApprovalLine.max_amount >= float(voucher.total_debit)
                    )
                )
            ).order_by(
                ApprovalLine.department_id.desc().nulls_last(),
                ApprovalLine.is_default.desc()
            )
        )
        line = result.scalar_first()

        if line:
            return {
                "line_id": line.id,
                "line_name": line.name,
                "steps": json.loads(line.line_config)
            }

        # 기본 결재선 (팀장 -> 재무팀)
        return {
            "line_id": None,
            "line_name": "기본 결재선",
            "steps": [
                {"step_order": 1, "step_name": "팀장", "approver_role_type": "team_leader"},
                {"step_order": 2, "step_name": "재무팀", "approver_role_type": "finance_staff"}
            ]
        }

    async def _resolve_approver(
        self,
        step_config: dict,
        requester: User,
        department_id: int
    ) -> int:
        """결재자 결정"""
        if "approver_id" in step_config and step_config["approver_id"]:
            return step_config["approver_id"]

        role_type = step_config.get("approver_role_type")

        if role_type == "team_leader":
            # 기안자의 팀장 찾기
            result = await self.db.execute(
                select(User).where(
                    and_(
                        User.department_id == department_id,
                        User.is_active == True,
                        User.role.has(role_type=RoleType.TEAM_LEADER)
                    )
                )
            )
            approver = result.scalar_first()
            if approver:
                return approver.id

        elif role_type == "department_head":
            # 부문장 찾기
            result = await self.db.execute(
                select(User).where(
                    and_(
                        User.is_active == True,
                        User.role.has(role_type=RoleType.DEPARTMENT_HEAD)
                    )
                )
            )
            approver = result.scalar_first()
            if approver:
                return approver.id

        elif role_type in ["finance_staff", "finance_manager"]:
            # 재무팀 직원 찾기
            result = await self.db.execute(
                select(User).where(
                    and_(
                        User.is_active == True,
                        User.role.has(role_type=RoleType.FINANCE_STAFF)
                    )
                )
            )
            approver = result.scalar_first()
            if approver:
                return approver.id

        # 기본값: 기안자 (자기 결재 - 실제로는 상위자로 변경 필요)
        return requester.id

    async def _check_budget(self, voucher: Voucher) -> dict:
        """예산 체크"""
        try:
            # 전표의 비용 계정 확인
            if not voucher.lines:
                return {"is_available": True, "message": "예산 확인 대상 없음"}

            total_expense = sum(
                float(line.debit_amount) for line in voucher.lines
                if line.account and line.account.category_id == 5  # 비용 계정
            )

            if total_expense == 0:
                return {"is_available": True, "message": "비용 계정 없음"}

            # 예산 조회
            current_year = datetime.utcnow().year
            current_month = datetime.utcnow().month

            result = await self.db.execute(
                select(Budget).where(
                    and_(
                        Budget.department_id == voucher.department_id,
                        Budget.fiscal_year == current_year,
                        Budget.status == "active"
                    )
                )
            )
            budget = result.scalar_first()

            if not budget:
                return {
                    "is_available": True,
                    "message": "예산이 설정되지 않았습니다."
                }

            remaining = float(budget.remaining_amount)
            if total_expense > remaining:
                return {
                    "is_available": False,
                    "message": f"예산 초과 (요청: {total_expense:,.0f}원, 잔액: {remaining:,.0f}원)"
                }

            usage_pct = ((float(budget.used_amount) + total_expense) / float(budget.total_amount)) * 100

            if usage_pct >= float(budget.critical_threshold):
                return {
                    "is_available": True,
                    "message": f"예산 사용률 위험 ({usage_pct:.1f}%)"
                }
            elif usage_pct >= float(budget.warning_threshold):
                return {
                    "is_available": True,
                    "message": f"예산 사용률 경고 ({usage_pct:.1f}%)"
                }

            return {
                "is_available": True,
                "message": f"예산 확인 완료 (잔액: {remaining:,.0f}원)"
            }

        except Exception as e:
            return {"is_available": True, "message": f"예산 확인 중 오류: {str(e)}"}

    async def _generate_request_number(self) -> str:
        """기안번호 생성"""
        today = datetime.utcnow().strftime("%Y%m%d")
        prefix = f"AP{today}"

        result = await self.db.execute(
            select(ApprovalRequest).where(
                ApprovalRequest.request_number.like(f"{prefix}%")
            ).order_by(ApprovalRequest.request_number.desc())
        )
        last_request = result.scalar_first()

        if last_request:
            last_seq = int(last_request.request_number[-4:])
            new_seq = last_seq + 1
        else:
            new_seq = 1

        return f"{prefix}{new_seq:04d}"

    async def process_approval_action(
        self,
        approval_request_id: int,
        approver_id: int,
        action_type: str,  # approve, reject, return, delegate
        comment: Optional[str] = None,
        delegate_to: Optional[int] = None,
        ip_address: Optional[str] = None
    ) -> Tuple[ApprovalRequest, str]:
        """
        결재 액션 처리
        """
        # 결재 요청 조회
        approval_request = await self.db.get(ApprovalRequest, approval_request_id)
        if not approval_request:
            raise ValueError("결재 요청을 찾을 수 없습니다.")

        if approval_request.status in [ApprovalStatus.APPROVED, ApprovalStatus.REJECTED, ApprovalStatus.CANCELLED]:
            raise ValueError("이미 완료된 결재입니다.")

        # 현재 단계 조회
        result = await self.db.execute(
            select(ApprovalStep).where(
                and_(
                    ApprovalStep.approval_request_id == approval_request_id,
                    ApprovalStep.step_order == approval_request.current_step,
                    ApprovalStep.status == ApprovalStatus.PENDING
                )
            )
        )
        current_step = result.scalar_one_or_none()

        if not current_step:
            raise ValueError("현재 결재 단계를 찾을 수 없습니다.")

        # 결재 권한 확인
        if current_step.approver_id != approver_id and current_step.delegate_id != approver_id:
            raise ValueError("결재 권한이 없습니다.")

        previous_status = approval_request.status.value

        # 액션 처리
        if action_type == "approve":
            current_step.status = ApprovalStatus.APPROVED
            current_step.action_type = ApprovalActionType.APPROVE
            current_step.action_at = datetime.utcnow()
            current_step.comment = comment

            # 다음 단계 확인
            if approval_request.current_step < approval_request.total_steps:
                approval_request.current_step += 1
                approval_request.status = ApprovalStatus.IN_PROGRESS

                # 다음 단계 활성화
                result = await self.db.execute(
                    select(ApprovalStep).where(
                        and_(
                            ApprovalStep.approval_request_id == approval_request_id,
                            ApprovalStep.step_order == approval_request.current_step
                        )
                    )
                )
                next_step = result.scalar_one_or_none()
                if next_step:
                    next_step.notified_at = datetime.utcnow()

                message = f"승인되었습니다. 다음 결재자에게 전달되었습니다."
            else:
                # 최종 승인
                approval_request.status = ApprovalStatus.APPROVED
                approval_request.completed_at = datetime.utcnow()

                # 전표 상태 업데이트
                voucher = await self.db.get(Voucher, approval_request.voucher_id)
                if voucher:
                    voucher.status = VoucherStatus.APPROVED

                message = "최종 승인되었습니다."

        elif action_type == "reject":
            current_step.status = ApprovalStatus.REJECTED
            current_step.action_type = ApprovalActionType.REJECT
            current_step.action_at = datetime.utcnow()
            current_step.comment = comment

            approval_request.status = ApprovalStatus.REJECTED
            approval_request.completed_at = datetime.utcnow()

            # 전표 상태 업데이트
            voucher = await self.db.get(Voucher, approval_request.voucher_id)
            if voucher:
                voucher.status = VoucherStatus.REJECTED

            message = "반려되었습니다."

        elif action_type == "return":
            current_step.status = ApprovalStatus.RETURNED
            current_step.action_type = ApprovalActionType.RETURN
            current_step.action_at = datetime.utcnow()
            current_step.comment = comment

            approval_request.status = ApprovalStatus.RETURNED

            message = "재상신 요청되었습니다."

        elif action_type == "delegate":
            if not delegate_to:
                raise ValueError("위임 대상자를 지정해야 합니다.")

            current_step.delegate_id = delegate_to
            current_step.action_type = ApprovalActionType.DELEGATE
            current_step.comment = comment

            message = "결재가 위임되었습니다."

        else:
            raise ValueError(f"지원하지 않는 액션: {action_type}")

        # 이력 기록
        await self._record_history(
            approval_request_id,
            approver_id,
            action_type,
            previous_status,
            approval_request.status.value,
            comment,
            current_step.step_order,
            ip_address
        )

        await self.db.commit()

        return approval_request, message

    async def _record_history(
        self,
        approval_request_id: int,
        user_id: int,
        action: str,
        previous_status: Optional[str],
        new_status: str,
        comment: Optional[str] = None,
        step_order: Optional[int] = None,
        ip_address: Optional[str] = None
    ):
        """결재 이력 기록"""
        history = ApprovalHistory(
            approval_request_id=approval_request_id,
            user_id=user_id,
            action=action,
            previous_status=previous_status,
            new_status=new_status,
            comment=comment,
            step_order=step_order,
            ip_address=ip_address
        )
        self.db.add(history)

    async def get_pending_approvals(
        self,
        approver_id: int,
        include_delegated: bool = True
    ) -> List[ApprovalRequest]:
        """내 결재 대기 목록 조회"""
        conditions = [
            ApprovalStep.approver_id == approver_id,
            ApprovalStep.status == ApprovalStatus.PENDING
        ]

        if include_delegated:
            conditions = [
                or_(
                    ApprovalStep.approver_id == approver_id,
                    ApprovalStep.delegate_id == approver_id
                ),
                ApprovalStep.status == ApprovalStatus.PENDING
            ]

        result = await self.db.execute(
            select(ApprovalRequest).join(ApprovalStep).where(
                and_(*conditions)
            ).order_by(
                ApprovalRequest.is_urgent.desc(),
                ApprovalRequest.created_at.asc()
            )
        )

        return result.scalars().all()

    async def cancel_approval_request(
        self,
        approval_request_id: int,
        requester_id: int,
        reason: Optional[str] = None
    ) -> Tuple[ApprovalRequest, str]:
        """기안 취소"""
        approval_request = await self.db.get(ApprovalRequest, approval_request_id)
        if not approval_request:
            raise ValueError("결재 요청을 찾을 수 없습니다.")

        if approval_request.requester_id != requester_id:
            raise ValueError("기안자만 취소할 수 있습니다.")

        if approval_request.status not in [ApprovalStatus.PENDING, ApprovalStatus.IN_PROGRESS, ApprovalStatus.RETURNED]:
            raise ValueError("취소할 수 없는 상태입니다.")

        previous_status = approval_request.status.value
        approval_request.status = ApprovalStatus.CANCELLED
        approval_request.completed_at = datetime.utcnow()

        # 전표 상태 복원
        voucher = await self.db.get(Voucher, approval_request.voucher_id)
        if voucher:
            voucher.status = VoucherStatus.DRAFT

        # 이력 기록
        await self._record_history(
            approval_request_id,
            requester_id,
            "cancel",
            previous_status,
            ApprovalStatus.CANCELLED.value,
            reason
        )

        await self.db.commit()

        return approval_request, "기안이 취소되었습니다."
