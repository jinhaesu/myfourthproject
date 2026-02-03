"""
Smart Finance Core - Treasury Manager
자금 관리, 채권/채무 자동화, 스마트 매칭
"""
from datetime import datetime, date, timedelta
from decimal import Decimal
from typing import Optional, List, Tuple
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, and_, or_, func

from app.models.treasury import (
    BankAccount, BankTransaction, Receivable, Payable,
    PaymentSchedule, ReconciliationMatch,
    TransactionDirection, ReceivableStatus, PayableStatus,
    ReconciliationStatus
)
from app.models.accounting import Voucher


class TreasuryManager:
    """
    자금 관리 서비스
    - 은행 거래 내역 조회/동기화
    - 채권/채무 자동 매칭 (Reconciliation)
    - 지급 스케줄 관리
    - 가상계좌 연동
    """

    def __init__(self, db: AsyncSession):
        self.db = db

    # ==================== 스마트 매칭 ====================

    async def auto_reconcile_transactions(
        self,
        bank_account_id: Optional[int] = None,
        from_date: Optional[date] = None,
        to_date: Optional[date] = None
    ) -> dict:
        """
        은행 거래와 채권/채무 자동 매칭

        Returns:
            {
                "matched_count": int,
                "unmatched_count": int,
                "matches": [...]
            }
        """
        conditions = [BankTransaction.reconciliation_status == ReconciliationStatus.UNMATCHED]

        if bank_account_id:
            conditions.append(BankTransaction.bank_account_id == bank_account_id)
        if from_date:
            conditions.append(BankTransaction.transaction_date >= from_date)
        if to_date:
            conditions.append(BankTransaction.transaction_date <= to_date)

        result = await self.db.execute(
            select(BankTransaction).where(and_(*conditions))
        )
        transactions = result.scalars().all()

        matched_count = 0
        matches = []

        for transaction in transactions:
            match_result = await self._find_best_match(transaction)
            if match_result:
                # 매칭 기록 저장
                reconciliation_match = ReconciliationMatch(
                    bank_transaction_id=transaction.id,
                    matched_type=match_result["type"],
                    matched_id=match_result["id"],
                    match_method="auto",
                    confidence_score=Decimal(str(match_result["confidence"])),
                    match_criteria=match_result["criteria"],
                    matched_amount=transaction.amount
                )
                self.db.add(reconciliation_match)

                # 거래 상태 업데이트
                transaction.reconciliation_status = ReconciliationStatus.AUTO_MATCHED

                if match_result["type"] == "receivable":
                    transaction.matched_receivable_id = match_result["id"]
                    await self._update_receivable_collection(
                        match_result["id"], transaction.amount
                    )
                elif match_result["type"] == "payable":
                    transaction.matched_payable_id = match_result["id"]
                    await self._update_payable_payment(
                        match_result["id"], transaction.amount
                    )

                matched_count += 1
                matches.append({
                    "transaction_id": transaction.id,
                    "matched_type": match_result["type"],
                    "matched_id": match_result["id"],
                    "matched_name": match_result["name"],
                    "confidence": match_result["confidence"]
                })

        await self.db.commit()

        return {
            "matched_count": matched_count,
            "unmatched_count": len(transactions) - matched_count,
            "matches": matches
        }

    async def _find_best_match(self, transaction: BankTransaction) -> Optional[dict]:
        """최적 매칭 대상 찾기"""
        if transaction.direction == TransactionDirection.INBOUND:
            # 입금 -> 매출채권 매칭
            return await self._find_receivable_match(transaction)
        else:
            # 출금 -> 매입채무 매칭
            return await self._find_payable_match(transaction)

    async def _find_receivable_match(self, transaction: BankTransaction) -> Optional[dict]:
        """매출채권 매칭 (입금)"""
        # 가상계좌로 100% 매칭
        if transaction.virtual_account_number:
            result = await self.db.execute(
                select(Receivable).where(
                    and_(
                        Receivable.assigned_virtual_account == transaction.virtual_account_number,
                        Receivable.status.in_([ReceivableStatus.PENDING, ReceivableStatus.PARTIAL])
                    )
                )
            )
            receivable = result.scalar_first()
            if receivable:
                return {
                    "type": "receivable",
                    "id": receivable.id,
                    "name": receivable.customer_name,
                    "confidence": 1.0,
                    "criteria": "virtual_account"
                }

        # 금액 + 거래처명 매칭
        result = await self.db.execute(
            select(Receivable).where(
                and_(
                    Receivable.outstanding_amount == transaction.amount,
                    Receivable.status.in_([ReceivableStatus.PENDING, ReceivableStatus.PARTIAL])
                )
            )
        )
        receivables = result.scalars().all()

        best_match = None
        best_confidence = 0.0

        for receivable in receivables:
            confidence = 0.5  # 금액 일치 기본 점수

            # 거래처명 유사도 검사
            if transaction.counterparty_name and receivable.customer_name:
                name_similarity = self._calculate_name_similarity(
                    transaction.counterparty_name,
                    receivable.customer_name
                )
                confidence += 0.4 * name_similarity

            # 만기일 근접성
            days_diff = abs((transaction.transaction_date - receivable.due_date).days)
            if days_diff <= 7:
                confidence += 0.1

            if confidence > best_confidence:
                best_confidence = confidence
                best_match = receivable

        if best_match and best_confidence >= 0.7:
            return {
                "type": "receivable",
                "id": best_match.id,
                "name": best_match.customer_name,
                "confidence": best_confidence,
                "criteria": "amount_and_name"
            }

        return None

    async def _find_payable_match(self, transaction: BankTransaction) -> Optional[dict]:
        """매입채무 매칭 (출금)"""
        # 금액 + 거래처 계좌 매칭
        result = await self.db.execute(
            select(Payable).where(
                and_(
                    Payable.outstanding_amount == transaction.amount,
                    Payable.status.in_([PayableStatus.PENDING, PayableStatus.SCHEDULED, PayableStatus.PARTIAL])
                )
            )
        )
        payables = result.scalars().all()

        best_match = None
        best_confidence = 0.0

        for payable in payables:
            confidence = 0.5  # 금액 일치 기본 점수

            # 거래처 계좌 일치
            if transaction.counterparty_account and payable.vendor_bank_account:
                if transaction.counterparty_account == payable.vendor_bank_account:
                    confidence += 0.4

            # 거래처명 유사도
            if transaction.counterparty_name and payable.vendor_name:
                name_similarity = self._calculate_name_similarity(
                    transaction.counterparty_name,
                    payable.vendor_name
                )
                confidence += 0.3 * name_similarity

            if confidence > best_confidence:
                best_confidence = confidence
                best_match = payable

        if best_match and best_confidence >= 0.7:
            return {
                "type": "payable",
                "id": best_match.id,
                "name": best_match.vendor_name,
                "confidence": best_confidence,
                "criteria": "amount_and_account"
            }

        return None

    def _calculate_name_similarity(self, name1: str, name2: str) -> float:
        """이름 유사도 계산 (간단한 방식)"""
        name1 = name1.lower().replace(" ", "")
        name2 = name2.lower().replace(" ", "")

        if name1 == name2:
            return 1.0

        # 포함 관계 확인
        if name1 in name2 or name2 in name1:
            return 0.8

        # 공통 문자 비율
        common = set(name1) & set(name2)
        total = set(name1) | set(name2)

        if total:
            return len(common) / len(total)

        return 0.0

    async def _update_receivable_collection(
        self,
        receivable_id: int,
        amount: Decimal
    ):
        """매출채권 입금 처리"""
        receivable = await self.db.get(Receivable, receivable_id)
        if not receivable:
            return

        receivable.collected_amount += amount
        receivable.outstanding_amount = receivable.original_amount - receivable.collected_amount

        if receivable.outstanding_amount <= 0:
            receivable.status = ReceivableStatus.COLLECTED
            receivable.collected_at = datetime.utcnow()
        elif receivable.collected_amount > 0:
            receivable.status = ReceivableStatus.PARTIAL

    async def _update_payable_payment(
        self,
        payable_id: int,
        amount: Decimal
    ):
        """매입채무 지급 처리"""
        payable = await self.db.get(Payable, payable_id)
        if not payable:
            return

        payable.paid_amount += amount
        payable.outstanding_amount = payable.original_amount - payable.paid_amount

        if payable.outstanding_amount <= 0:
            payable.status = PayableStatus.PAID
            payable.paid_at = datetime.utcnow()
        elif payable.paid_amount > 0:
            payable.status = PayableStatus.PARTIAL

    # ==================== 지급 스케줄 ====================

    async def create_payment_schedule(
        self,
        payable_id: int,
        scheduled_date: date,
        scheduled_amount: Decimal,
        bank_account_id: int,
        user_id: int
    ) -> PaymentSchedule:
        """지급 스케줄 생성"""
        payable = await self.db.get(Payable, payable_id)
        if not payable:
            raise ValueError("매입채무를 찾을 수 없습니다.")

        if scheduled_amount > payable.outstanding_amount:
            raise ValueError("지급 예정 금액이 잔액을 초과합니다.")

        schedule = PaymentSchedule(
            payable_id=payable_id,
            scheduled_date=scheduled_date,
            scheduled_amount=scheduled_amount,
            bank_account_id=bank_account_id,
            created_by=user_id
        )
        self.db.add(schedule)

        # 채무 상태 업데이트
        payable.status = PayableStatus.SCHEDULED

        await self.db.commit()
        return schedule

    async def get_upcoming_payments(
        self,
        days_ahead: int = 30,
        bank_account_id: Optional[int] = None
    ) -> List[PaymentSchedule]:
        """예정된 지급 목록 조회"""
        today = date.today()
        end_date = today + timedelta(days=days_ahead)

        conditions = [
            PaymentSchedule.scheduled_date >= today,
            PaymentSchedule.scheduled_date <= end_date,
            PaymentSchedule.is_executed == False
        ]

        if bank_account_id:
            conditions.append(PaymentSchedule.bank_account_id == bank_account_id)

        result = await self.db.execute(
            select(PaymentSchedule).where(and_(*conditions)).order_by(
                PaymentSchedule.scheduled_date
            )
        )

        return result.scalars().all()

    # ==================== 연령 분석 ====================

    async def get_ar_aging_report(self, as_of_date: Optional[date] = None) -> dict:
        """매출채권 연령 분석"""
        if not as_of_date:
            as_of_date = date.today()

        result = await self.db.execute(
            select(Receivable).where(
                Receivable.status.in_([
                    ReceivableStatus.PENDING,
                    ReceivableStatus.PARTIAL,
                    ReceivableStatus.OVERDUE
                ])
            )
        )
        receivables = result.scalars().all()

        aging_data = {}

        for receivable in receivables:
            customer = receivable.customer_name
            if customer not in aging_data:
                aging_data[customer] = {
                    "current": Decimal("0"),
                    "days_1_30": Decimal("0"),
                    "days_31_60": Decimal("0"),
                    "days_61_90": Decimal("0"),
                    "days_over_90": Decimal("0"),
                    "total": Decimal("0")
                }

            days_overdue = (as_of_date - receivable.due_date).days

            if days_overdue <= 0:
                aging_data[customer]["current"] += receivable.outstanding_amount
            elif days_overdue <= 30:
                aging_data[customer]["days_1_30"] += receivable.outstanding_amount
            elif days_overdue <= 60:
                aging_data[customer]["days_31_60"] += receivable.outstanding_amount
            elif days_overdue <= 90:
                aging_data[customer]["days_61_90"] += receivable.outstanding_amount
            else:
                aging_data[customer]["days_over_90"] += receivable.outstanding_amount

            aging_data[customer]["total"] += receivable.outstanding_amount

        return {
            "report_date": as_of_date.isoformat(),
            "items": [
                {"customer": k, **v} for k, v in aging_data.items()
            ],
            "summary": {
                "current": sum(v["current"] for v in aging_data.values()),
                "days_1_30": sum(v["days_1_30"] for v in aging_data.values()),
                "days_31_60": sum(v["days_31_60"] for v in aging_data.values()),
                "days_61_90": sum(v["days_61_90"] for v in aging_data.values()),
                "days_over_90": sum(v["days_over_90"] for v in aging_data.values()),
                "total": sum(v["total"] for v in aging_data.values())
            }
        }

    async def get_ap_aging_report(self, as_of_date: Optional[date] = None) -> dict:
        """매입채무 연령 분석"""
        if not as_of_date:
            as_of_date = date.today()

        result = await self.db.execute(
            select(Payable).where(
                Payable.status.in_([
                    PayableStatus.PENDING,
                    PayableStatus.SCHEDULED,
                    PayableStatus.PARTIAL,
                    PayableStatus.OVERDUE
                ])
            )
        )
        payables = result.scalars().all()

        aging_data = {}

        for payable in payables:
            vendor = payable.vendor_name
            if vendor not in aging_data:
                aging_data[vendor] = {
                    "current": Decimal("0"),
                    "days_1_30": Decimal("0"),
                    "days_31_60": Decimal("0"),
                    "days_61_90": Decimal("0"),
                    "days_over_90": Decimal("0"),
                    "total": Decimal("0")
                }

            days_overdue = (as_of_date - payable.due_date).days

            if days_overdue <= 0:
                aging_data[vendor]["current"] += payable.outstanding_amount
            elif days_overdue <= 30:
                aging_data[vendor]["days_1_30"] += payable.outstanding_amount
            elif days_overdue <= 60:
                aging_data[vendor]["days_31_60"] += payable.outstanding_amount
            elif days_overdue <= 90:
                aging_data[vendor]["days_61_90"] += payable.outstanding_amount
            else:
                aging_data[vendor]["days_over_90"] += payable.outstanding_amount

            aging_data[vendor]["total"] += payable.outstanding_amount

        return {
            "report_date": as_of_date.isoformat(),
            "items": [
                {"vendor": k, **v} for k, v in aging_data.items()
            ],
            "summary": {
                "current": sum(v["current"] for v in aging_data.values()),
                "days_1_30": sum(v["days_1_30"] for v in aging_data.values()),
                "days_31_60": sum(v["days_31_60"] for v in aging_data.values()),
                "days_61_90": sum(v["days_61_90"] for v in aging_data.values()),
                "days_over_90": sum(v["days_over_90"] for v in aging_data.values()),
                "total": sum(v["total"] for v in aging_data.values())
            }
        }

    # ==================== 현금 포지션 ====================

    async def get_cash_position(self) -> dict:
        """현재 현금 포지션 조회"""
        result = await self.db.execute(
            select(BankAccount).where(
                and_(
                    BankAccount.is_active == True,
                    BankAccount.account_type != "virtual"
                )
            )
        )
        accounts = result.scalars().all()

        total_balance = sum(acc.current_balance for acc in accounts)
        available_balance = sum(acc.available_balance for acc in accounts)

        return {
            "total_balance": total_balance,
            "available_balance": available_balance,
            "accounts": [
                {
                    "id": acc.id,
                    "alias": acc.account_alias,
                    "bank": acc.bank_name,
                    "current_balance": acc.current_balance,
                    "available_balance": acc.available_balance,
                    "last_update": acc.last_balance_update.isoformat() if acc.last_balance_update else None
                }
                for acc in accounts
            ]
        }
