"""
Frankfurter (ECB) 환율 시계열 프록시 endpoint.
클라이언트 직접 호출이 막히는 환경(CORS, 광고차단 등) 우회용.
"""
from fastapi import APIRouter, HTTPException, Query
import httpx
import logging

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/exchange-rates", tags=["exchange-rates"])


@router.get("/timeseries")
async def get_exchange_timeseries(
    start_date: str = Query(..., description="YYYY-MM-DD"),
    end_date: str = Query(..., description="YYYY-MM-DD"),
    base: str = Query("USD", description="Base currency"),
    targets: str = Query(
        "KRW,JPY,CNY,SGD,EUR,GBP,HKD", description="Comma-separated target currencies"
    ),
):
    """
    Frankfurter (ECB) 시계열 환율 프록시.
    응답 구조: { base, start_date, end_date, rates: { "YYYY-MM-DD": { CODE: rate } } }
    """
    url = f"https://api.frankfurter.app/{start_date}..{end_date}"
    params = {"from": base, "to": targets}
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(url, params=params)
        if resp.status_code != 200:
            raise HTTPException(
                status_code=502,
                detail=f"Frankfurter API {resp.status_code}: {resp.text[:200]}",
            )
        return resp.json()
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="Frankfurter API 타임아웃")
    except httpx.HTTPError as e:
        logger.exception("Frankfurter fetch failed")
        raise HTTPException(status_code=502, detail=f"Frankfurter 통신 오류: {e}")
