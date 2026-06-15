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
    # Frankfurter 도메인이 .app → .dev로 마이그레이션됨 (.app은 301 redirect).
    # 새 도메인 우선, 실패 시 구 도메인 follow_redirects로 폴백.
    candidate_urls = [
        f"https://api.frankfurter.dev/v1/{start_date}..{end_date}",
        f"https://api.frankfurter.app/{start_date}..{end_date}",
    ]
    params = {"from": base, "to": targets}
    last_err: str | None = None

    async with httpx.AsyncClient(timeout=15.0, follow_redirects=True) as client:
        for url in candidate_urls:
            try:
                resp = await client.get(url, params=params)
                if resp.status_code == 200:
                    return resp.json()
                last_err = f"{url} → {resp.status_code}: {resp.text[:200]}"
                logger.warning("Frankfurter %s", last_err)
            except httpx.TimeoutException:
                last_err = f"{url} → 타임아웃"
                logger.warning("Frankfurter timeout: %s", url)
            except httpx.HTTPError as e:
                last_err = f"{url} → {e}"
                logger.warning("Frankfurter HTTPError: %s", e)

    raise HTTPException(status_code=502, detail=f"Frankfurter API 응답 실패: {last_err}")
