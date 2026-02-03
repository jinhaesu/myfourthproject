"""
Smart Finance Core - Admin API
관리자 기능 API 엔드포인트
"""
from datetime import datetime
from typing import Optional, List
from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.services.audit_service import AuditService

router = APIRouter()


@router.get("/audit-logs")
async def get_audit_logs(
    page: int = Query(1, ge=1),
    size: int = Query(50, ge=1, le=200),
    user_id: Optional[int] = None,
    action: Optional[str] = None,
    action_category: Optional[str] = None,
    resource_type: Optional[str] = None,
    from_date: Optional[datetime] = None,
    to_date: Optional[datetime] = None,
    db: AsyncSession = Depends(get_db)
):
    """
    감사 로그 조회

    - 모든 데이터 변경 이력을 조회합니다
    - 내부 통제 및 감사 목적으로 사용됩니다
    """
    service = AuditService(db)

    logs, total = await service.get_audit_logs(
        page=page,
        size=size,
        user_id=user_id,
        action=action,
        action_category=action_category,
        resource_type=resource_type,
        from_date=from_date,
        to_date=to_date
    )

    return {
        "items": [
            {
                "id": log.id,
                "user_id": log.user_id,
                "username": log.username,
                "action": log.action,
                "action_category": log.action_category,
                "resource_type": log.resource_type,
                "resource_id": log.resource_id,
                "resource_name": log.resource_name,
                "old_value": log.old_value,
                "new_value": log.new_value,
                "ip_address": log.ip_address,
                "status": log.status,
                "created_at": log.created_at.isoformat()
            }
            for log in logs
        ],
        "total": total,
        "page": page,
        "size": size,
        "pages": (total + size - 1) // size
    }


@router.post("/snapshots")
async def create_snapshot(
    snapshot_type: str = Query(..., regex="^(daily|monthly|manual)$"),
    data_type: str = Query(..., regex="^(vouchers|approvals|audit_logs|full)$"),
    user_id: int = Query(..., description="현재 사용자 ID"),
    db: AsyncSession = Depends(get_db)
):
    """
    데이터 스냅샷 생성

    - 일별/월별 데이터 백업을 생성합니다
    """
    service = AuditService(db)

    snapshot = await service.create_snapshot(
        snapshot_type=snapshot_type,
        data_type=data_type,
        user_id=user_id
    )

    return {
        "id": snapshot.id,
        "snapshot_type": snapshot.snapshot_type,
        "snapshot_date": snapshot.snapshot_date.isoformat(),
        "data_type": snapshot.data_type,
        "file_path": snapshot.file_path,
        "file_size_bytes": snapshot.file_size_bytes,
        "record_count": snapshot.record_count,
        "status": snapshot.status
    }


@router.get("/snapshots")
async def get_snapshots(
    snapshot_type: Optional[str] = None,
    data_type: Optional[str] = None,
    db: AsyncSession = Depends(get_db)
):
    """데이터 스냅샷 목록 조회"""
    from app.models.audit import DataSnapshot
    from sqlalchemy import select, and_

    conditions = []
    if snapshot_type:
        conditions.append(DataSnapshot.snapshot_type == snapshot_type)
    if data_type:
        conditions.append(DataSnapshot.data_type == data_type)

    query = select(DataSnapshot)
    if conditions:
        query = query.where(and_(*conditions))
    query = query.order_by(DataSnapshot.created_at.desc())

    result = await db.execute(query)
    snapshots = result.scalars().all()

    return [
        {
            "id": s.id,
            "snapshot_type": s.snapshot_type,
            "snapshot_date": s.snapshot_date.isoformat() if s.snapshot_date else None,
            "data_type": s.data_type,
            "file_path": s.file_path,
            "file_size_bytes": s.file_size_bytes,
            "record_count": s.record_count,
            "status": s.status,
            "created_at": s.created_at.isoformat()
        }
        for s in snapshots
    ]


@router.get("/audit-report")
async def generate_audit_report(
    report_type: str = Query("activity", regex="^(activity|security|compliance)$"),
    from_date: datetime = None,
    to_date: datetime = None,
    db: AsyncSession = Depends(get_db)
):
    """
    감사 리포트 생성

    - activity: 활동 요약 리포트
    - security: 보안 이벤트 리포트
    - compliance: 규정 준수 리포트
    """
    service = AuditService(db)

    if not from_date:
        from_date = datetime.utcnow().replace(day=1, hour=0, minute=0, second=0)
    if not to_date:
        to_date = datetime.utcnow()

    report = await service.generate_audit_report(report_type, from_date, to_date)

    return report


@router.get("/system-health")
async def get_system_health(
    db: AsyncSession = Depends(get_db)
):
    """시스템 상태 확인"""
    from sqlalchemy import text

    try:
        await db.execute(text("SELECT 1"))
        db_status = "healthy"
    except Exception as e:
        db_status = f"unhealthy: {str(e)}"

    return {
        "status": "healthy" if db_status == "healthy" else "degraded",
        "components": {
            "database": db_status,
            "api": "healthy"
        },
        "timestamp": datetime.utcnow().isoformat()
    }
