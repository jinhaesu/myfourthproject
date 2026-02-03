"""
Smart Finance Core - Audit Service
감사 추적 및 데이터 아카이빙 서비스
"""
import json
import hashlib
import gzip
from datetime import datetime, date, timedelta
from pathlib import Path
from typing import Optional, List
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, and_

from app.core.config import settings
from app.models.audit import AuditLog, DataSnapshot


class AuditService:
    """
    감사 추적 서비스
    - 모든 데이터 변경 로깅
    - 일별/월별 백업
    - 감사 리포트 생성
    """

    def __init__(self, db: AsyncSession):
        self.db = db

    async def log_action(
        self,
        user_id: int,
        username: str,
        action: str,
        action_category: str,
        resource_type: str,
        resource_id: Optional[str] = None,
        resource_name: Optional[str] = None,
        old_value: Optional[dict] = None,
        new_value: Optional[dict] = None,
        description: Optional[str] = None,
        ip_address: Optional[str] = None,
        user_agent: Optional[str] = None,
        request_id: Optional[str] = None,
        session_id: Optional[str] = None,
        status: str = "success",
        error_message: Optional[str] = None
    ) -> AuditLog:
        """감사 로그 기록"""
        changed_fields = None
        if old_value and new_value:
            changed_fields = [
                key for key in set(old_value.keys()) | set(new_value.keys())
                if old_value.get(key) != new_value.get(key)
            ]

        audit_log = AuditLog(
            user_id=user_id,
            username=username,
            action=action,
            action_category=action_category,
            resource_type=resource_type,
            resource_id=resource_id,
            resource_name=resource_name,
            old_value=json.dumps(old_value, default=str) if old_value else None,
            new_value=json.dumps(new_value, default=str) if new_value else None,
            changed_fields=json.dumps(changed_fields) if changed_fields else None,
            description=description,
            ip_address=ip_address,
            user_agent=user_agent,
            request_id=request_id,
            session_id=session_id,
            status=status,
            error_message=error_message
        )

        self.db.add(audit_log)
        await self.db.commit()

        return audit_log

    async def get_audit_logs(
        self,
        page: int = 1,
        size: int = 50,
        user_id: Optional[int] = None,
        action: Optional[str] = None,
        action_category: Optional[str] = None,
        resource_type: Optional[str] = None,
        from_date: Optional[datetime] = None,
        to_date: Optional[datetime] = None
    ) -> tuple[List[AuditLog], int]:
        """감사 로그 조회"""
        from sqlalchemy import func

        conditions = []

        if user_id:
            conditions.append(AuditLog.user_id == user_id)
        if action:
            conditions.append(AuditLog.action == action)
        if action_category:
            conditions.append(AuditLog.action_category == action_category)
        if resource_type:
            conditions.append(AuditLog.resource_type == resource_type)
        if from_date:
            conditions.append(AuditLog.created_at >= from_date)
        if to_date:
            conditions.append(AuditLog.created_at <= to_date)

        # 총 개수
        count_query = select(func.count(AuditLog.id))
        if conditions:
            count_query = count_query.where(and_(*conditions))
        result = await self.db.execute(count_query)
        total = result.scalar()

        # 목록 조회
        query = select(AuditLog)
        if conditions:
            query = query.where(and_(*conditions))
        query = query.order_by(AuditLog.created_at.desc())
        query = query.offset((page - 1) * size).limit(size)

        result = await self.db.execute(query)
        logs = result.scalars().all()

        return logs, total

    async def create_snapshot(
        self,
        snapshot_type: str,
        data_type: str,
        user_id: int
    ) -> DataSnapshot:
        """데이터 스냅샷 생성"""
        today = date.today()

        # 기간 설정
        if snapshot_type == "daily":
            period_start = datetime.combine(today - timedelta(days=1), datetime.min.time())
            period_end = datetime.combine(today, datetime.min.time())
        elif snapshot_type == "monthly":
            first_of_month = today.replace(day=1)
            period_start = datetime.combine(
                (first_of_month - timedelta(days=1)).replace(day=1),
                datetime.min.time()
            )
            period_end = datetime.combine(first_of_month, datetime.min.time())
        else:
            period_start = datetime.min
            period_end = datetime.utcnow()

        # 데이터 수집
        data = await self._collect_snapshot_data(data_type, period_start, period_end)

        # 파일 저장
        file_name = f"snapshot_{snapshot_type}_{data_type}_{today.isoformat()}.json.gz"
        file_path = Path(settings.UPLOAD_DIR) / "snapshots" / file_name
        file_path.parent.mkdir(parents=True, exist_ok=True)

        json_data = json.dumps(data, default=str).encode('utf-8')
        compressed_data = gzip.compress(json_data)

        with open(file_path, 'wb') as f:
            f.write(compressed_data)

        # 체크섬 계산
        checksum = hashlib.sha256(compressed_data).hexdigest()

        # 스냅샷 레코드 생성
        snapshot = DataSnapshot(
            snapshot_type=snapshot_type,
            snapshot_date=today,
            data_type=data_type,
            period_start=period_start,
            period_end=period_end,
            storage_type="local",
            file_path=str(file_path),
            file_size_bytes=len(compressed_data),
            file_checksum=checksum,
            is_encrypted=False,
            record_count=len(data.get("records", [])),
            status="completed",
            created_by=user_id
        )

        self.db.add(snapshot)
        await self.db.commit()

        return snapshot

    async def _collect_snapshot_data(
        self,
        data_type: str,
        period_start: datetime,
        period_end: datetime
    ) -> dict:
        """스냅샷 데이터 수집"""
        data = {
            "snapshot_time": datetime.utcnow().isoformat(),
            "data_type": data_type,
            "period_start": period_start.isoformat(),
            "period_end": period_end.isoformat(),
            "records": []
        }

        if data_type == "vouchers":
            from app.models.accounting import Voucher
            result = await self.db.execute(
                select(Voucher).where(
                    and_(
                        Voucher.created_at >= period_start,
                        Voucher.created_at < period_end
                    )
                )
            )
            vouchers = result.scalars().all()
            data["records"] = [
                {
                    "id": v.id,
                    "voucher_number": v.voucher_number,
                    "voucher_date": v.voucher_date.isoformat(),
                    "description": v.description,
                    "total_debit": str(v.total_debit),
                    "total_credit": str(v.total_credit),
                    "status": v.status.value,
                    "created_at": v.created_at.isoformat()
                }
                for v in vouchers
            ]

        elif data_type == "approvals":
            from app.models.approval import ApprovalRequest
            result = await self.db.execute(
                select(ApprovalRequest).where(
                    and_(
                        ApprovalRequest.created_at >= period_start,
                        ApprovalRequest.created_at < period_end
                    )
                )
            )
            approvals = result.scalars().all()
            data["records"] = [
                {
                    "id": a.id,
                    "request_number": a.request_number,
                    "title": a.title,
                    "status": a.status.value,
                    "created_at": a.created_at.isoformat()
                }
                for a in approvals
            ]

        elif data_type == "audit_logs":
            result = await self.db.execute(
                select(AuditLog).where(
                    and_(
                        AuditLog.created_at >= period_start,
                        AuditLog.created_at < period_end
                    )
                )
            )
            logs = result.scalars().all()
            data["records"] = [
                {
                    "id": log.id,
                    "user_id": log.user_id,
                    "action": log.action,
                    "resource_type": log.resource_type,
                    "resource_id": log.resource_id,
                    "created_at": log.created_at.isoformat()
                }
                for log in logs
            ]

        return data

    async def generate_audit_report(
        self,
        report_type: str,
        from_date: datetime,
        to_date: datetime
    ) -> dict:
        """감사 리포트 생성"""
        from sqlalchemy import func

        # 기간별 활동 요약
        result = await self.db.execute(
            select(
                AuditLog.action_category,
                func.count(AuditLog.id).label("count")
            ).where(
                and_(
                    AuditLog.created_at >= from_date,
                    AuditLog.created_at <= to_date
                )
            ).group_by(AuditLog.action_category)
        )
        category_summary = {row.action_category: row.count for row in result.all()}

        # 사용자별 활동
        result = await self.db.execute(
            select(
                AuditLog.username,
                func.count(AuditLog.id).label("count")
            ).where(
                and_(
                    AuditLog.created_at >= from_date,
                    AuditLog.created_at <= to_date
                )
            ).group_by(AuditLog.username).order_by(func.count(AuditLog.id).desc()).limit(20)
        )
        user_activity = [
            {"username": row.username, "count": row.count}
            for row in result.all()
        ]

        # 실패한 작업
        result = await self.db.execute(
            select(AuditLog).where(
                and_(
                    AuditLog.created_at >= from_date,
                    AuditLog.created_at <= to_date,
                    AuditLog.status == "failed"
                )
            ).order_by(AuditLog.created_at.desc()).limit(50)
        )
        failed_actions = [
            {
                "id": log.id,
                "username": log.username,
                "action": log.action,
                "error_message": log.error_message,
                "created_at": log.created_at.isoformat()
            }
            for log in result.scalars().all()
        ]

        return {
            "report_type": report_type,
            "period_start": from_date.isoformat(),
            "period_end": to_date.isoformat(),
            "generated_at": datetime.utcnow().isoformat(),
            "summary": {
                "by_category": category_summary,
                "total_actions": sum(category_summary.values())
            },
            "user_activity": user_activity,
            "failed_actions": failed_actions
        }
