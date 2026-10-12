"""국세청 사업자등록 상태조회 (data.go.kr / api.odcloud.kr nts-businessman v1 status).
환경변수 NTS_SERVICE_KEY(일반 인증키, 인코딩/디코딩 모두 허용)가 있을 때만 동작. 1회 100건."""
import os
import logging
from datetime import datetime
from typing import Dict, List
from urllib.parse import unquote

import httpx
from sqlalchemy import select

from app.models.hyphen_ext import MerchantBizStatus
from app.services.vat_deduction import kind_from_nts

logger = logging.getLogger(__name__)
NTS_URL = "https://api.odcloud.kr/api/nts-businessman/v1/status"


def nts_enabled() -> bool:
    return bool(os.getenv("NTS_SERVICE_KEY", "").strip())


async def fetch_status(biz_nos: List[str]) -> Dict[str, Dict]:
    """최대 100건. returns {biz_no: {tax_kind,status,end_dt,raw_tax_type}}"""
    key = unquote(os.getenv("NTS_SERVICE_KEY", "").strip())
    out: Dict[str, Dict] = {}
    async with httpx.AsyncClient(timeout=30) as c:
        r = await c.post(NTS_URL, params={"serviceKey": key, "returnType": "JSON"}, json={"b_no": biz_nos[:100]})
        r.raise_for_status()
        for it in (r.json().get("data") or []):
            b = str(it.get("b_no") or "")
            raw = it.get("tax_type") or ""
            stt = (it.get("b_stt") or "").strip()
            status = "폐업" if "폐업" in stt else "휴업" if "휴업" in stt else "계속" if "계속" in stt else None
            out[b] = {
                "tax_kind": kind_from_nts(it.get("tax_type_cd"), raw),
                "status": status, "end_dt": (it.get("end_dt") or "")[:8] or None,
                "raw_tax_type": raw[:80] or None,
            }
    return out


async def refresh_statuses(db, biz_nos: List[str], *, max_age_days: int = 25) -> Dict[str, int]:
    """캐시 갱신. 월 1회 배치에서 호출. checked_at이 max_age_days 이내면 건너뜀."""
    if not nts_enabled():
        return {"enabled": 0, "checked": 0}
    nums = sorted({b for b in biz_nos if b and len(b) == 10})
    if not nums:
        return {"enabled": 1, "checked": 0}
    cutoff = datetime.utcnow().timestamp() - max_age_days * 86400
    have = {r.biz_no: r for r in (await db.execute(
        select(MerchantBizStatus).where(MerchantBizStatus.biz_no.in_(nums)))).scalars().all()}
    todo = [n for n in nums if n not in have or have[n].source != "nts" or have[n].checked_at.timestamp() < cutoff]
    checked = 0
    for i in range(0, len(todo), 100):
        chunk = todo[i:i + 100]
        try:
            res = await fetch_status(chunk)
        except Exception as e:  # noqa: BLE001
            logger.warning("NTS 상태조회 실패: %s", str(e)[:200])
            continue
        for b, v in res.items():
            row = have.get(b) or MerchantBizStatus(biz_no=b)
            row.tax_kind, row.status, row.end_dt, row.raw_tax_type = v["tax_kind"], v["status"], v["end_dt"], v["raw_tax_type"]
            row.source, row.checked_at = "nts", datetime.utcnow()
            if b not in have:
                db.add(row)
            checked += 1
    await db.commit()
    return {"enabled": 1, "checked": checked, "requested": len(todo)}


async def load_status_map(db, biz_nos) -> Dict[str, Dict]:
    nums = sorted({b for b in biz_nos if b})
    if not nums:
        return {}
    rows = (await db.execute(select(MerchantBizStatus).where(MerchantBizStatus.biz_no.in_(nums)))).scalars().all()
    return {r.biz_no: {"tax_kind": r.tax_kind, "status": r.status, "end_dt": r.end_dt} for r in rows}
