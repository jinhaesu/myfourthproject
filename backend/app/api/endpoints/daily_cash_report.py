"""
Daily Cash Report (AI 자금 다이제스트) API

엔드포인트:
- GET  /daily-cash-report/preview?date=YYYY-MM-DD  → 자금일보 미리보기 (실시간 생성)
- GET  /daily-cash-report/today                    → 오늘 발송된 snapshot 또는 즉시 생성
- GET  /daily-cash-report/config                   → 내 설정 조회
- PUT  /daily-cash-report/config                   → 내 설정 저장
- GET  /daily-cash-report/sections                 → 사용 가능한 섹션 메타데이터
"""
import json
import logging
from datetime import date, datetime, timedelta
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.models.daily_cash_report import (
    DailyCashReportConfig, DailyCashReportSnapshot,
    DEFAULT_SECTIONS, SECTION_LABELS, SECTION_DESCRIPTIONS, REQUIRED_SECTIONS,
)
from app.services.daily_cash_report import (
    get_or_create_config, generate_report_content,
)

logger = logging.getLogger(__name__)
router = APIRouter()


class SectionMeta(BaseModel):
    key: str
    label: str
    description: str
    required: bool


class ConfigOut(BaseModel):
    enabled: bool
    sections: List[str]
    disabled_sections: List[str]
    delivery_time: str
    delivery_channels: List[str]


class ConfigUpdate(BaseModel):
    enabled: Optional[bool] = None
    sections: Optional[List[str]] = Field(None, description="섹션 키 순서 배열")
    disabled_sections: Optional[List[str]] = Field(None, description="비활성 섹션 키")
    delivery_time: Optional[str] = Field(None, description="HH:MM")
    delivery_channels: Optional[List[str]] = None


def _config_to_out(c: DailyCashReportConfig) -> ConfigOut:
    return ConfigOut(
        enabled=c.enabled,
        sections=json.loads(c.sections) if c.sections else DEFAULT_SECTIONS,
        disabled_sections=json.loads(c.disabled_sections) if c.disabled_sections else [],
        delivery_time=c.delivery_time or "09:00",
        delivery_channels=json.loads(c.delivery_channels) if c.delivery_channels else ["email"],
    )


@router.get("/sections", response_model=List[SectionMeta])
async def list_sections():
    """사용 가능한 섹션 메타데이터 — 프론트 토글/드래그 UI에 사용."""
    return [
        SectionMeta(
            key=k,
            label=SECTION_LABELS.get(k, k),
            description=SECTION_DESCRIPTIONS.get(k, ""),
            required=k in REQUIRED_SECTIONS,
        )
        for k in DEFAULT_SECTIONS
    ]


@router.get("/config", response_model=ConfigOut)
async def get_config(
    user_id: int = Query(1, description="사용자 id (인증 도입 시 자동)"),
    db: AsyncSession = Depends(get_db),
):
    cfg = await get_or_create_config(db, user_id)
    return _config_to_out(cfg)


@router.put("/config", response_model=ConfigOut)
async def update_config(
    patch: ConfigUpdate,
    user_id: int = Query(1),
    db: AsyncSession = Depends(get_db),
):
    cfg = await get_or_create_config(db, user_id)
    if patch.enabled is not None:
        cfg.enabled = patch.enabled
    if patch.sections is not None:
        # 필수 섹션이 sections에 없으면 자동 추가
        secs = list(patch.sections)
        for req in REQUIRED_SECTIONS:
            if req not in secs:
                secs.append(req)
        cfg.sections = json.dumps(secs)
    if patch.disabled_sections is not None:
        # 필수 섹션은 disable 금지
        disabled = [s for s in patch.disabled_sections if s not in REQUIRED_SECTIONS]
        cfg.disabled_sections = json.dumps(disabled)
    if patch.delivery_time is not None:
        cfg.delivery_time = patch.delivery_time
    if patch.delivery_channels is not None:
        cfg.delivery_channels = json.dumps(patch.delivery_channels)

    await db.commit()
    await db.refresh(cfg)
    return _config_to_out(cfg)


@router.get("/preview")
async def preview_report(
    date_str: Optional[str] = Query(None, alias="date", description="기준일자 (없으면 어제)"),
    user_id: int = Query(1),
    db: AsyncSession = Depends(get_db),
):
    """자금일보 실시간 미리보기 — DB에 저장하지 않음."""
    if date_str:
        try:
            target = date.fromisoformat(date_str)
        except ValueError:
            raise HTTPException(status_code=400, detail="invalid date")
    else:
        target = date.today() - timedelta(days=1)

    cfg = await get_or_create_config(db, user_id)
    content = await generate_report_content(db, user_id, target, cfg)
    return content


@router.get("/today")
async def get_today_report(
    user_id: int = Query(1),
    db: AsyncSession = Depends(get_db),
):
    """
    오늘 발송된 자금일보 — snapshot이 있으면 그것, 없으면 어제 기준 즉시 생성.
    """
    today = date.today()
    snap = (await db.execute(
        select(DailyCashReportSnapshot).where(
            DailyCashReportSnapshot.user_id == user_id,
            DailyCashReportSnapshot.report_date == today,
        )
    )).scalar_one_or_none()
    if snap:
        try:
            return {
                "report_date": snap.report_date.isoformat(),
                "from_snapshot": True,
                "sent_at": snap.sent_at.isoformat() if snap.sent_at else None,
                **json.loads(snap.content),
            }
        except (ValueError, TypeError):
            pass

    # snapshot 없으면 즉시 생성 (어제 기준)
    target = today - timedelta(days=1)
    cfg = await get_or_create_config(db, user_id)
    content = await generate_report_content(db, user_id, target, cfg)
    content["from_snapshot"] = False
    return content


@router.post("/send-now")
async def send_now(
    user_id: int = Query(1),
    target_date: Optional[str] = Query(None, description="기준일자 (없으면 어제)"),
    db: AsyncSession = Depends(get_db),
):
    """수동 발송 — 콘텐츠 생성 + snapshot 저장 (실제 채널 발송은 스케줄러에서)."""
    if target_date:
        try:
            target = date.fromisoformat(target_date)
        except ValueError:
            raise HTTPException(status_code=400, detail="invalid date")
    else:
        target = date.today() - timedelta(days=1)

    cfg = await get_or_create_config(db, user_id)
    content = await generate_report_content(db, user_id, target, cfg)

    # snapshot 저장 (오늘 자로)
    today = date.today()
    existing = (await db.execute(
        select(DailyCashReportSnapshot).where(
            DailyCashReportSnapshot.user_id == user_id,
            DailyCashReportSnapshot.report_date == today,
        )
    )).scalar_one_or_none()
    if existing:
        existing.content = json.dumps(content, default=str, ensure_ascii=False)
        existing.sent_at = datetime.utcnow()
    else:
        db.add(DailyCashReportSnapshot(
            user_id=user_id,
            report_date=today,
            content=json.dumps(content, default=str, ensure_ascii=False),
            sent_channels=cfg.delivery_channels,
            sent_at=datetime.utcnow(),
        ))
    await db.commit()
    return {"ok": True, "report_date": target.isoformat()}
