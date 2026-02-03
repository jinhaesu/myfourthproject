"""
Smart Finance Core - Voucher Service
전표 관리 서비스
"""
from datetime import datetime, date
from decimal import Decimal
from typing import Optional, List, Tuple
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, and_, or_, func

from app.models.accounting import (
    Voucher, VoucherLine, VoucherAttachment,
    Account, VoucherStatus, TransactionType, AIClassificationStatus
)
from app.models.user import User, Department
from app.services.ai_classifier import AIClassifierService


class VoucherService:
    """
    전표 관리 서비스
    - 전표 CRUD
    - AI 자동 분류 연동
    - 전표번호 자동 생성
    """

    def __init__(self, db: AsyncSession):
        self.db = db
        self.ai_classifier = AIClassifierService()

    async def create_voucher(
        self,
        voucher_date: date,
        transaction_date: date,
        description: str,
        transaction_type: str,
        department_id: int,
        user_id: int,
        lines: List[dict],
        external_ref: Optional[str] = None,
        merchant_name: Optional[str] = None,
        merchant_category: Optional[str] = None,
        custom_tags: Optional[List[str]] = None,
        use_ai_classification: bool = True
    ) -> Voucher:
        """전표 생성"""
        # 전표번호 생성
        voucher_number = await self._generate_voucher_number(voucher_date)

        # 합계 계산
        total_debit = sum(Decimal(str(line.get("debit_amount", 0))) for line in lines)
        total_credit = sum(Decimal(str(line.get("credit_amount", 0))) for line in lines)

        if total_debit != total_credit:
            raise ValueError(f"차변 합계({total_debit})와 대변 합계({total_credit})가 일치하지 않습니다.")

        # AI 분류 수행 (선택적)
        ai_result = None
        if use_ai_classification and description:
            ai_result = await self.ai_classifier.classify(
                self.db,
                description=description,
                merchant_name=merchant_name,
                merchant_category=merchant_category,
                amount=total_debit
            )

        # 전표 생성
        voucher = Voucher(
            voucher_number=voucher_number,
            voucher_date=voucher_date,
            transaction_date=transaction_date,
            description=description,
            transaction_type=TransactionType(transaction_type),
            external_ref=external_ref,
            department_id=department_id,
            created_by=user_id,
            total_debit=total_debit,
            total_credit=total_credit,
            status=VoucherStatus.DRAFT,
            merchant_name=merchant_name,
            merchant_category=merchant_category,
            custom_tags=",".join(custom_tags) if custom_tags else None
        )

        # AI 분류 결과 적용
        if ai_result:
            voucher.ai_confidence_score = ai_result["primary_prediction"]["confidence_score"]
            voucher.ai_suggested_account_id = ai_result["primary_prediction"]["account_id"]

            if ai_result["auto_confirm"]:
                voucher.ai_classification_status = AIClassificationStatus.AUTO_CONFIRMED
            elif ai_result["needs_review"]:
                voucher.ai_classification_status = AIClassificationStatus.NEEDS_REVIEW
            else:
                voucher.ai_classification_status = AIClassificationStatus.NEEDS_REVIEW

        self.db.add(voucher)
        await self.db.flush()

        # 전표 라인 생성
        for idx, line_data in enumerate(lines, 1):
            line = VoucherLine(
                voucher_id=voucher.id,
                line_number=idx,
                account_id=line_data["account_id"],
                debit_amount=Decimal(str(line_data.get("debit_amount", 0))),
                credit_amount=Decimal(str(line_data.get("credit_amount", 0))),
                vat_amount=Decimal(str(line_data.get("vat_amount", 0))),
                supply_amount=Decimal(str(line_data.get("supply_amount", 0))),
                description=line_data.get("description"),
                counterparty_name=line_data.get("counterparty_name"),
                counterparty_business_number=line_data.get("counterparty_business_number"),
                cost_center_code=line_data.get("cost_center_code"),
                project_code=line_data.get("project_code")
            )
            self.db.add(line)

        await self.db.commit()
        return voucher

    async def _generate_voucher_number(self, voucher_date: date) -> str:
        """전표번호 생성"""
        prefix = f"V{voucher_date.strftime('%Y%m%d')}"

        result = await self.db.execute(
            select(Voucher).where(
                Voucher.voucher_number.like(f"{prefix}%")
            ).order_by(Voucher.voucher_number.desc())
        )
        last_voucher = result.scalar_first()

        if last_voucher:
            last_seq = int(last_voucher.voucher_number[-4:])
            new_seq = last_seq + 1
        else:
            new_seq = 1

        return f"{prefix}{new_seq:04d}"

    async def get_voucher(self, voucher_id: int) -> Optional[Voucher]:
        """전표 조회"""
        return await self.db.get(Voucher, voucher_id)

    async def get_vouchers(
        self,
        page: int = 1,
        size: int = 20,
        department_id: Optional[int] = None,
        status: Optional[str] = None,
        from_date: Optional[date] = None,
        to_date: Optional[date] = None,
        search: Optional[str] = None,
        created_by: Optional[int] = None
    ) -> Tuple[List[Voucher], int]:
        """전표 목록 조회"""
        conditions = []

        if department_id:
            conditions.append(Voucher.department_id == department_id)
        if status:
            conditions.append(Voucher.status == VoucherStatus(status))
        if from_date:
            conditions.append(Voucher.voucher_date >= from_date)
        if to_date:
            conditions.append(Voucher.voucher_date <= to_date)
        if created_by:
            conditions.append(Voucher.created_by == created_by)
        if search:
            conditions.append(
                or_(
                    Voucher.description.ilike(f"%{search}%"),
                    Voucher.voucher_number.ilike(f"%{search}%"),
                    Voucher.merchant_name.ilike(f"%{search}%")
                )
            )

        # 총 개수
        count_query = select(func.count(Voucher.id))
        if conditions:
            count_query = count_query.where(and_(*conditions))
        result = await self.db.execute(count_query)
        total = result.scalar()

        # 목록 조회
        query = select(Voucher)
        if conditions:
            query = query.where(and_(*conditions))
        query = query.order_by(Voucher.voucher_date.desc(), Voucher.voucher_number.desc())
        query = query.offset((page - 1) * size).limit(size)

        result = await self.db.execute(query)
        vouchers = result.scalars().all()

        return vouchers, total

    async def update_voucher(
        self,
        voucher_id: int,
        user_id: int,
        **updates
    ) -> Voucher:
        """전표 수정"""
        voucher = await self.db.get(Voucher, voucher_id)
        if not voucher:
            raise ValueError("전표를 찾을 수 없습니다.")

        if voucher.status not in [VoucherStatus.DRAFT, VoucherStatus.REJECTED]:
            raise ValueError("임시저장 또는 반려 상태의 전표만 수정할 수 있습니다.")

        # 허용된 필드만 업데이트
        allowed_fields = [
            "voucher_date", "transaction_date", "description",
            "merchant_name", "custom_tags"
        ]

        for field in allowed_fields:
            if field in updates and updates[field] is not None:
                setattr(voucher, field, updates[field])

        # 라인 업데이트
        if "lines" in updates and updates["lines"]:
            # 기존 라인 삭제
            for line in voucher.lines:
                await self.db.delete(line)

            # 새 라인 추가
            total_debit = Decimal("0")
            total_credit = Decimal("0")

            for idx, line_data in enumerate(updates["lines"], 1):
                line = VoucherLine(
                    voucher_id=voucher.id,
                    line_number=idx,
                    account_id=line_data["account_id"],
                    debit_amount=Decimal(str(line_data.get("debit_amount", 0))),
                    credit_amount=Decimal(str(line_data.get("credit_amount", 0))),
                    vat_amount=Decimal(str(line_data.get("vat_amount", 0))),
                    supply_amount=Decimal(str(line_data.get("supply_amount", 0))),
                    description=line_data.get("description"),
                    counterparty_name=line_data.get("counterparty_name"),
                    counterparty_business_number=line_data.get("counterparty_business_number"),
                    cost_center_code=line_data.get("cost_center_code"),
                    project_code=line_data.get("project_code")
                )
                self.db.add(line)

                total_debit += line.debit_amount
                total_credit += line.credit_amount

            voucher.total_debit = total_debit
            voucher.total_credit = total_credit

        voucher.updated_at = datetime.utcnow()

        await self.db.commit()
        return voucher

    async def confirm_voucher(
        self,
        voucher_id: int,
        user_id: int,
        final_account_id: Optional[int] = None
    ) -> Voucher:
        """전표 확정 (회계처리 완료)"""
        voucher = await self.db.get(Voucher, voucher_id)
        if not voucher:
            raise ValueError("전표를 찾을 수 없습니다.")

        if voucher.status != VoucherStatus.APPROVED:
            raise ValueError("결재 완료된 전표만 확정할 수 있습니다.")

        voucher.status = VoucherStatus.CONFIRMED
        voucher.confirmed_at = datetime.utcnow()
        voucher.confirmed_by = user_id

        # AI 피드백 기록 (사용자가 계정 수정한 경우)
        if final_account_id and voucher.ai_suggested_account_id:
            if final_account_id != voucher.ai_suggested_account_id:
                voucher.ai_classification_status = AIClassificationStatus.USER_CORRECTED
                # AI 피드백 기록
                await self.ai_classifier.record_feedback(
                    self.db,
                    voucher_id=voucher.id,
                    description=voucher.description,
                    merchant_name=voucher.merchant_name,
                    amount=voucher.total_debit,
                    predicted_account_id=voucher.ai_suggested_account_id,
                    actual_account_id=final_account_id,
                    user_id=user_id
                )
            else:
                voucher.ai_classification_status = AIClassificationStatus.USER_CONFIRMED

        await self.db.commit()
        return voucher

    async def delete_voucher(self, voucher_id: int) -> bool:
        """전표 삭제"""
        voucher = await self.db.get(Voucher, voucher_id)
        if not voucher:
            raise ValueError("전표를 찾을 수 없습니다.")

        if voucher.status not in [VoucherStatus.DRAFT, VoucherStatus.CANCELLED]:
            raise ValueError("임시저장 또는 취소 상태의 전표만 삭제할 수 있습니다.")

        await self.db.delete(voucher)
        await self.db.commit()
        return True

    async def batch_import_card_transactions(
        self,
        transactions: List[dict],
        department_id: int,
        user_id: int
    ) -> dict:
        """카드 거래 일괄 임포트"""
        created_count = 0
        error_count = 0
        errors = []

        for idx, txn in enumerate(transactions):
            try:
                # AI 분류
                ai_result = await self.ai_classifier.classify(
                    self.db,
                    description=txn.get("description", txn.get("merchant_name", "")),
                    merchant_name=txn.get("merchant_name"),
                    merchant_category=txn.get("merchant_category"),
                    amount=Decimal(str(txn["amount"])),
                    transaction_time=txn.get("transaction_time")
                )

                # 자동 분류된 계정과목으로 전표 생성
                account_id = ai_result["primary_prediction"]["account_id"]

                lines = [
                    {
                        "account_id": account_id,
                        "debit_amount": txn["amount"],
                        "credit_amount": 0,
                        "description": txn.get("description")
                    },
                    {
                        "account_id": 1,  # 현금/예금 계정 (설정 필요)
                        "debit_amount": 0,
                        "credit_amount": txn["amount"]
                    }
                ]

                await self.create_voucher(
                    voucher_date=txn["transaction_date"],
                    transaction_date=txn["transaction_date"],
                    description=txn.get("description", txn.get("merchant_name", "")),
                    transaction_type="card",
                    department_id=department_id,
                    user_id=user_id,
                    lines=lines,
                    external_ref=txn.get("approval_number"),
                    merchant_name=txn.get("merchant_name"),
                    merchant_category=txn.get("merchant_category"),
                    use_ai_classification=False  # 이미 분류됨
                )

                created_count += 1

            except Exception as e:
                error_count += 1
                errors.append({
                    "index": idx,
                    "error": str(e)
                })

        return {
            "created_count": created_count,
            "error_count": error_count,
            "errors": errors
        }
