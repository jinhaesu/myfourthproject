"""
Smart Finance Core - Sales API
매출 자동화 & 전표 전환 API 엔드포인트
"""
from typing import Optional, List
from fastapi import APIRouter, Depends, HTTPException, status, Query, UploadFile, File
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession
import io

from app.core.database import get_db
from app.schemas.sales import (
    SalesChannelCreate, SalesChannelUpdate, SalesChannelResponse,
    SalesRecordCreate, SalesRecordUpdate, SalesRecordResponse,
    SalesAutomationScheduleCreate, SalesAutomationScheduleUpdate,
    SalesAutomationScheduleResponse,
    SalesReportData, MonthlySalesSummary,
    ChannelTrendResponse, YearlySummaryResponse,
    VoucherConversionRequest, VoucherConversionResponse,
    SalesExcelImportResponse, SendReportRequest,
)
from app.services.sales_service import SalesService

router = APIRouter()


# ============================================================================
# Helper functions
# ============================================================================

def channel_to_response(channel) -> dict:
    """SalesChannel ORM 객체를 응답 dict로 변환"""
    return {
        "id": channel.id,
        "code": channel.code,
        "name": channel.name,
        "channel_type": channel.channel_type.value if hasattr(channel.channel_type, 'value') else str(channel.channel_type),
        "platform_url": channel.platform_url,
        "api_type": channel.api_type.value if hasattr(channel.api_type, 'value') else str(channel.api_type),
        "api_endpoint": channel.api_endpoint,
        "seller_id": channel.seller_id,
        "commission_rate": channel.commission_rate,
        "settlement_day": channel.settlement_day,
        "is_active": channel.is_active,
        "last_sync_at": channel.last_sync_at,
        "created_at": channel.created_at,
        "updated_at": channel.updated_at,
    }


def record_to_response(record) -> dict:
    """SalesRecord ORM 객체를 응답 dict로 변환"""
    return {
        "id": record.id,
        "channel_id": record.channel_id,
        "channel_code": record.channel.code if hasattr(record, 'channel') and record.channel else None,
        "channel_name": record.channel.name if hasattr(record, 'channel') and record.channel else None,
        "period_year": record.period_year,
        "period_month": record.period_month,
        "gross_sales": record.gross_sales,
        "returns": record.returns,
        "net_sales": record.net_sales,
        "commission": record.commission,
        "settlement_amount": record.settlement_amount,
        "order_count": record.order_count,
        "cancel_count": record.cancel_count,
        "status": record.status.value if hasattr(record.status, 'value') else str(record.status),
        "notes": record.notes,
        "synced_at": record.synced_at,
        "confirmed_at": record.confirmed_at,
        "converted_at": record.converted_at,
        "voucher_id": record.voucher_id,
        "created_at": record.created_at,
        "updated_at": record.updated_at,
    }


def schedule_to_response(schedule) -> dict:
    """SalesAutomationSchedule ORM 객체를 응답 dict로 변환"""
    return {
        "id": schedule.id,
        "name": schedule.name,
        "schedule_type": schedule.schedule_type.value if hasattr(schedule.schedule_type, 'value') else str(schedule.schedule_type),
        "schedule_day": schedule.schedule_day,
        "schedule_time": schedule.schedule_time,
        "target_channels": schedule.target_channels,
        "email_recipients": schedule.email_recipients,
        "email_subject_template": schedule.email_subject_template,
        "include_excel": schedule.include_excel,
        "is_active": schedule.is_active,
        "last_run_at": schedule.last_run_at,
        "next_run_at": schedule.next_run_at,
        "created_at": schedule.created_at,
        "updated_at": schedule.updated_at,
    }


# ============================================================================
# Channels
# ============================================================================

@router.get("/channels/", response_model=List[SalesChannelResponse])
async def list_channels(
    active_only: bool = Query(True, description="활성 채널만 조회"),
    db: AsyncSession = Depends(get_db)
):
    """판매 채널 목록 조회"""
    service = SalesService(db)
    channels = await service.get_channels(active_only=active_only)
    return [channel_to_response(ch) for ch in channels]


@router.post("/channels/", response_model=SalesChannelResponse, status_code=status.HTTP_201_CREATED)
async def create_channel(
    channel_data: SalesChannelCreate,
    db: AsyncSession = Depends(get_db)
):
    """판매 채널 추가"""
    service = SalesService(db)

    try:
        data = channel_data.model_dump()
        code = data.pop("code")
        name = data.pop("name")
        channel_type = data.pop("channel_type")
        api_type = data.pop("api_type")

        channel = await service.create_channel(
            code=code, name=name,
            channel_type=channel_type, api_type=api_type,
            **data
        )
        return channel_to_response(channel)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))


@router.get("/channels/{channel_id}", response_model=SalesChannelResponse)
async def get_channel(
    channel_id: int,
    db: AsyncSession = Depends(get_db)
):
    """판매 채널 상세 조회"""
    service = SalesService(db)
    channel = await service.get_channel(channel_id)
    if not channel:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="판매 채널을 찾을 수 없습니다."
        )
    return channel_to_response(channel)


@router.put("/channels/{channel_id}", response_model=SalesChannelResponse)
async def update_channel(
    channel_id: int,
    channel_data: SalesChannelUpdate,
    db: AsyncSession = Depends(get_db)
):
    """판매 채널 수정"""
    service = SalesService(db)

    try:
        updates = channel_data.model_dump(exclude_unset=True)
        channel = await service.update_channel(channel_id, **updates)
        return channel_to_response(channel)
    except ValueError as e:
        error_msg = str(e)
        if "찾을 수 없" in error_msg:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=error_msg)
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=error_msg)


@router.delete("/channels/{channel_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_channel(
    channel_id: int,
    db: AsyncSession = Depends(get_db)
):
    """판매 채널 삭제 (비활성화)"""
    service = SalesService(db)

    try:
        await service.delete_channel(channel_id)
    except ValueError as e:
        error_msg = str(e)
        if "찾을 수 없" in error_msg:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=error_msg)
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=error_msg)


# ============================================================================
# Sales Records
# ============================================================================

@router.get("/records/", response_model=List[SalesRecordResponse])
async def list_records(
    year: int = Query(..., ge=2000, le=2100, description="조회 연도"),
    month: int = Query(..., ge=1, le=12, description="조회 월"),
    channel_id: Optional[int] = Query(None, description="채널 ID"),
    record_status: Optional[str] = Query(None, alias="status", description="상태 필터"),
    db: AsyncSession = Depends(get_db)
):
    """매출 기록 조회"""
    service = SalesService(db)
    records = await service.get_sales_records(
        year=year, month=month,
        channel_id=channel_id, status=record_status
    )
    return [record_to_response(r) for r in records]


@router.post("/records/", response_model=SalesRecordResponse, status_code=status.HTTP_201_CREATED)
async def create_record(
    record_data: SalesRecordCreate,
    db: AsyncSession = Depends(get_db)
):
    """매출 기록 수동 입력/업로드 (upsert)"""
    service = SalesService(db)

    try:
        data = record_data.model_dump()
        channel_id = data.pop("channel_id")
        year = data.pop("period_year")
        month = data.pop("period_month")

        record = await service.upsert_sales_record(
            channel_id=channel_id,
            year=year, month=month,
            data=data
        )

        # channel 관계 로드를 위해 재조회
        from app.models.sales import SalesRecord
        from sqlalchemy.orm import selectinload
        from sqlalchemy import select as sa_select

        result = await db.execute(
            sa_select(SalesRecord).options(
                selectinload(SalesRecord.channel)
            ).where(SalesRecord.id == record.id)
        )
        record = result.scalar_one()

        return record_to_response(record)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))


@router.put("/records/{record_id}/confirm", response_model=SalesRecordResponse)
async def confirm_record(
    record_id: int,
    db: AsyncSession = Depends(get_db)
):
    """매출 기록 확정"""
    service = SalesService(db)

    try:
        record = await service.confirm_sales_record(record_id)

        # channel 관계 로드를 위해 재조회
        from app.models.sales import SalesRecord
        from sqlalchemy.orm import selectinload
        from sqlalchemy import select as sa_select

        result = await db.execute(
            sa_select(SalesRecord).options(
                selectinload(SalesRecord.channel)
            ).where(SalesRecord.id == record.id)
        )
        record = result.scalar_one()

        return record_to_response(record)
    except ValueError as e:
        error_msg = str(e)
        if "찾을 수 없" in error_msg:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=error_msg)
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=error_msg)


# ============================================================================
# Summary & Trends
# ============================================================================

@router.get("/summary/monthly", response_model=SalesReportData)
async def get_monthly_summary(
    year: int = Query(..., ge=2000, le=2100),
    month: int = Query(..., ge=1, le=12),
    db: AsyncSession = Depends(get_db)
):
    """월간 매출 집계"""
    service = SalesService(db)
    return await service.get_monthly_summary(year, month)


@router.get("/summary/yearly", response_model=YearlySummaryResponse)
async def get_yearly_summary(
    year: int = Query(..., ge=2000, le=2100),
    db: AsyncSession = Depends(get_db)
):
    """연간 매출 집계"""
    service = SalesService(db)
    return await service.get_yearly_summary(year)


@router.get("/trend/{channel_id}", response_model=ChannelTrendResponse)
async def get_channel_trend(
    channel_id: int,
    months: int = Query(12, ge=1, le=60, description="조회 개월 수"),
    db: AsyncSession = Depends(get_db)
):
    """채널별 매출 추이"""
    service = SalesService(db)

    try:
        return await service.get_channel_trend(channel_id, months=months)
    except ValueError as e:
        error_msg = str(e)
        if "찾을 수 없" in error_msg:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=error_msg)
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=error_msg)


# ============================================================================
# Voucher Conversion
# ============================================================================

@router.post("/convert-to-voucher", response_model=VoucherConversionResponse)
async def convert_to_voucher(
    request: VoucherConversionRequest,
    db: AsyncSession = Depends(get_db)
):
    """매출 기록을 전표로 전환"""
    service = SalesService(db)

    try:
        result = await service.convert_to_voucher(
            record_ids=request.record_ids,
            user_id=request.user_id,
            department_id=request.department_id,
            description=request.description,
        )
        return result
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))


# ============================================================================
# Excel Export & Report
# ============================================================================

@router.get("/export/excel")
async def export_excel(
    year: int = Query(..., ge=2000, le=2100),
    month: int = Query(..., ge=1, le=12),
    db: AsyncSession = Depends(get_db)
):
    """월간 매출 엑셀 다운로드"""
    service = SalesService(db)

    try:
        excel_bytes = await service.export_monthly_excel(year, month)
        filename = f"sales_report_{year}_{month:02d}.xlsx"

        return StreamingResponse(
            io.BytesIO(excel_bytes),
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": f"attachment; filename={filename}"}
        )
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))


@router.post("/send-report")
async def send_report(
    request: SendReportRequest,
    db: AsyncSession = Depends(get_db)
):
    """매출 리포트 메일 발송"""
    service = SalesService(db)

    try:
        success = await service.send_monthly_report(
            year=request.year,
            month=request.month,
            recipients=request.recipients,
            subject=request.subject,
        )

        if success:
            return {"message": "리포트가 발송되었습니다.", "recipients": request.recipients}
        else:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="리포트 발송에 실패했습니다."
            )
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))


# ============================================================================
# Excel Import
# ============================================================================

@router.post("/import/excel", response_model=SalesExcelImportResponse)
async def import_excel(
    file: UploadFile = File(..., description="엑셀 파일"),
    db: AsyncSession = Depends(get_db)
):
    """엑셀 업로드로 매출 데이터 일괄 등록"""
    if not file.filename.endswith(('.xlsx', '.xls')):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="xlsx 또는 xls 파일만 업로드 가능합니다."
        )

    file_bytes = await file.read()
    service = SalesService(db)

    try:
        result = await service.import_from_excel(file_bytes)
        return result
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))


# ============================================================================
# Automation Schedules
# ============================================================================

@router.get("/schedules/", response_model=List[SalesAutomationScheduleResponse])
async def list_schedules(
    db: AsyncSession = Depends(get_db)
):
    """자동화 스케줄 목록"""
    service = SalesService(db)
    schedules = await service.get_schedules()
    return [schedule_to_response(s) for s in schedules]


@router.post("/schedules/", response_model=SalesAutomationScheduleResponse, status_code=status.HTTP_201_CREATED)
async def create_schedule(
    schedule_data: SalesAutomationScheduleCreate,
    db: AsyncSession = Depends(get_db)
):
    """자동화 스케줄 생성"""
    service = SalesService(db)

    try:
        data = schedule_data.model_dump()
        name = data.pop("name")
        schedule_type = data.pop("schedule_type")

        schedule = await service.create_schedule(
            name=name, schedule_type=schedule_type, **data
        )
        return schedule_to_response(schedule)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))


@router.put("/schedules/{schedule_id}", response_model=SalesAutomationScheduleResponse)
async def update_schedule(
    schedule_id: int,
    schedule_data: SalesAutomationScheduleUpdate,
    db: AsyncSession = Depends(get_db)
):
    """자동화 스케줄 수정"""
    service = SalesService(db)

    try:
        updates = schedule_data.model_dump(exclude_unset=True)
        schedule = await service.update_schedule(schedule_id, **updates)
        return schedule_to_response(schedule)
    except ValueError as e:
        error_msg = str(e)
        if "찾을 수 없" in error_msg:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=error_msg)
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=error_msg)


@router.delete("/schedules/{schedule_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_schedule(
    schedule_id: int,
    db: AsyncSession = Depends(get_db)
):
    """자동화 스케줄 삭제"""
    service = SalesService(db)

    try:
        await service.delete_schedule(schedule_id)
    except ValueError as e:
        error_msg = str(e)
        if "찾을 수 없" in error_msg:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=error_msg)
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=error_msg)
