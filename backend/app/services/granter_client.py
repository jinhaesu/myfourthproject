"""
Granter Public API Client (granter-public-api 가이드 기반)

Base URL: https://app.granter.biz/api/public-docs
Auth: HTTP Basic — base64(API_KEY:)  (Stripe 스타일, 사용자명=API_KEY, 비밀번호=빈값)

API 키는 GRANTER_API_KEY 환경변수에서만 로드. 코드/리포지토리에 하드코딩 금지.
GRANTER_BASE_URL로 베이스 호스트(prefix 포함) override 가능.

지원 엔드포인트:
- tickets : 카드/계좌/세금계산서/현금영수증/결재 등 거래 통합 조회
- tickets/bulk-update-individual : 거래 일괄 수정
- assets : 연동 자산 (카드/계좌/홈택스/PG/오픈마켓)
- balances : 계좌별 잔액 시계열
- daily-financial-report : 일일 재무 리포트
- exchange-rates : 환율
- tax-invoices-issue|modify-issue|cancel-issue : 세금계산서 발행/수정/취소
- cash-receipts-issue|cancel-issue : 현금영수증 발행/취소
- tags / tag-details / categories : 분류 기준 데이터
"""
import os
import logging
from typing import Optional, Dict, Any
import httpx

logger = logging.getLogger(__name__)


class GranterAPIError(Exception):
    def __init__(self, message: str, status_code: Optional[int] = None, body: Any = None):
        super().__init__(message)
        self.status_code = status_code
        self.body = body


class GranterClient:
    """그랜터 공식 Public API 비동기 클라이언트"""

    DEFAULT_BASE_URL = "https://app.granter.biz/api/public-docs"
    DEFAULT_TIMEOUT = 30.0
    # 그랜터가 동시 호출 N개 이상이면 401로 차단 → semaphore로 직렬화
    _SEMAPHORE = None  # type: ignore

    def __init__(self):
        import asyncio
        self.api_key = os.getenv("GRANTER_API_KEY", "").strip()
        self.base_url = os.getenv("GRANTER_BASE_URL", self.DEFAULT_BASE_URL).rstrip("/")
        self.timeout = float(os.getenv("GRANTER_TIMEOUT", str(self.DEFAULT_TIMEOUT)))
        self._client: Optional[httpx.AsyncClient] = None
        # 동시 호출 1개로 제한 (그랜터 401 차단 회피)
        if GranterClient._SEMAPHORE is None:
            GranterClient._SEMAPHORE = asyncio.Semaphore(1)

    @property
    def is_configured(self) -> bool:
        return bool(self.api_key)

    def _get_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            # HTTP Basic Auth: 사용자명=API_KEY, 비밀번호=빈값 (Stripe 스타일)
            auth = httpx.BasicAuth(self.api_key, "")
            self._client = httpx.AsyncClient(
                base_url=self.base_url,
                auth=auth,
                headers={
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                    "User-Agent": "smart-finance-core/1.0",
                },
                timeout=self.timeout,
            )
        return self._client

    async def aclose(self):
        if self._client and not self._client.is_closed:
            await self._client.aclose()

    async def _request(
        self,
        method: str,
        path: str,
        params: Optional[Dict[str, Any]] = None,
        json: Optional[Dict[str, Any]] = None,
        idempotency_key: Optional[str] = None,
        _retry_count: int = 0,
    ) -> Any:
        """
        그랜터 API 호출. 401/429/502/503/504 받으면 지수백오프 자동 재시도 (최대 2회).
        그랜터가 동시 호출 시 간헐적으로 401 반환하는 케이스 자체 회복.
        """
        import asyncio

        if not self.is_configured:
            raise GranterAPIError("GRANTER_API_KEY 환경변수가 설정되지 않았습니다.", status_code=500)

        client = self._get_client()
        if params:
            params = {k: v for k, v in params.items() if v is not None and v != ""}

        headers = {}
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key

        # 글로벌 semaphore로 그랜터 동시 호출 1개로 직렬화 (401 차단 방지) + 호출 간 간격
        async with GranterClient._SEMAPHORE:  # type: ignore
            try:
                resp = await client.request(method, path, params=params, json=json, headers=headers)
            except httpx.TimeoutException as e:
                if _retry_count < 2:
                    await asyncio.sleep(1.0 * (2 ** _retry_count))
                    return await self._request(method, path, params, json, idempotency_key, _retry_count + 1)
                raise GranterAPIError(f"그랜터 API 타임아웃: {path}", status_code=504) from e
            except httpx.HTTPError as e:
                if _retry_count < 2:
                    await asyncio.sleep(1.0 * (2 ** _retry_count))
                    return await self._request(method, path, params, json, idempotency_key, _retry_count + 1)
                raise GranterAPIError(f"그랜터 API 통신 오류: {e}", status_code=502) from e
            # 다음 호출과 간격 100ms (그랜터 부담 경감)
            await asyncio.sleep(0.1)

        # 일시적 실패(401/429/5xx) 자동 재시도 — 그랜터 동시 호출 시 간헐 401 회복
        RETRYABLE_STATUS = {401, 429, 502, 503, 504}
        MAX_RETRIES = 5
        if resp.status_code in RETRYABLE_STATUS and _retry_count < MAX_RETRIES:
            # 401은 그랜터 차단 — 더 길게 대기. 429/5xx는 짧게.
            if resp.status_code == 401:
                # 5s, 10s, 20s, 40s, 60s (총 ~135s) — 그랜터 IP 차단 회복용
                wait = min(5.0 * (2 ** _retry_count), 60.0)
            else:
                wait = min(1.0 * (3 ** _retry_count), 30.0)
            logger.info(
                "Granter %s %s → %s, retry %d/%d after %.1fs",
                method, path, resp.status_code, _retry_count + 1, MAX_RETRIES, wait,
            )
            await asyncio.sleep(wait)
            return await self._request(method, path, params, json, idempotency_key, _retry_count + 1)

        if resp.status_code >= 400:
            try:
                body = resp.json()
            except Exception:
                body = resp.text
            logger.warning("Granter %s %s → %s: %s", method, path, resp.status_code, body)
            # 401 retry 모두 실패 시 — 그랜터 차단 추정. 사용자에게 친절한 안내.
            if resp.status_code == 401:
                raise GranterAPIError(
                    "그랜터 서버가 일시적으로 차단했습니다. 1~2분 후 새로고침하면 자동 복구됩니다.",
                    status_code=429,  # 429로 변환 — frontend가 retry 가능 신호로 인식
                    body=body,
                )
            raise GranterAPIError(
                f"그랜터 API {resp.status_code}: {body}",
                status_code=resp.status_code,
                body=body,
            )

        if resp.status_code == 204 or not resp.content:
            return None
        try:
            return resp.json()
        except Exception:
            return resp.text

    # ============ 거래 (Tickets) ============

    async def list_tickets(self, payload: Dict[str, Any]) -> Any:
        """카드·계좌·세금계산서·현금영수증·결재 등 통합 거래 조회 (POST)"""
        return await self._request("POST", "/tickets", json=payload)

    async def bulk_update_tickets(self, payload: Dict[str, Any]) -> Any:
        """거래 일괄 수정 (분류/태그/메모 등)"""
        return await self._request("POST", "/tickets/bulk-update-individual", json=payload)

    # ============ 자산 (Assets) ============

    async def list_assets(self, payload: Dict[str, Any]) -> Any:
        """
        특정 assetType의 자산 목록.
        payload에 assetType 필수 (enum: CARD, BANK_ACCOUNT, HOME_TAX_ACCOUNT, CUSTOM,
        MERCHANT_GROUP, SECURITIES_ACCOUNT, ECOMMERCE, MANUAL).
        """
        return await self._request("POST", "/assets", json=payload)

    async def list_all_assets(self, only_active: bool = True) -> Dict[str, Any]:
        """
        모든 assetType을 병렬 호출 후 합쳐서 반환.

        only_active=True (default): 그랜터 자산 중 다음 조건 모두 만족하는 것만:
          - isActive == True
          - isHidden == False
          - isDormant == False
          - 홈택스의 경우 readCertificate.isExpired != True (인증서 미만료)

        Returns: { "CARD": [...], "BANK_ACCOUNT": [...], "HOME_TAX_ACCOUNT": [...], ... }
        """
        import asyncio

        asset_types = [
            "CARD", "BANK_ACCOUNT", "HOME_TAX_ACCOUNT",
            "SECURITIES_ACCOUNT", "ECOMMERCE", "MERCHANT_GROUP",
        ]

        def _is_active(a: Dict[str, Any]) -> bool:
            if not a.get("isActive", True):
                return False
            if a.get("isHidden", False):
                return False
            if a.get("isDormant", False):
                return False
            # 홈택스 인증서 만료 체크
            if a.get("assetType") == "HOME_TAX_ACCOUNT":
                ht = a.get("homeTaxAccount") or {}
                read_cert = ht.get("readCertificate") or {}
                if read_cert.get("isExpired"):
                    return False
            return True

        async def _fetch(t: str):
            try:
                r = await self.list_assets({"assetType": t})
                items = r if isinstance(r, list) else (r.get("data", []) if isinstance(r, dict) else [])
                if only_active:
                    items = [a for a in items if _is_active(a)]
                return t, items
            except GranterAPIError as e:
                logger.warning("Granter assets %s fetch failed: %s", t, e)
                return t, []

        # 그랜터 401 차단 회피 — semaphore로 어차피 순차이지만 명시적 순차 처리
        results = []
        for t in asset_types:
            results.append(await _fetch(t))
        return dict(results)

    # 메모리 TTL 캐시 (같은 (start, end, asset_id) 조합 5분 캐시)
    # 3시간으로 늘렸을 때 빈 응답이 고착되는 문제 발생 → 5분으로 단축.
    # 사용자 요구 '3시간 캐시'는 frontend gcTime로 충족됨.
    _TICKETS_CACHE: Dict[str, Any] = {}
    _CACHE_TTL = 5 * 60  # 5 minutes

    async def list_tickets_all_types(
        self,
        start_date: str,
        end_date: str,
        asset_id: Optional[int] = None,
    ) -> Dict[str, Any]:
        """
        모든 ticketType을 병렬 호출해 합쳐서 반환.
        그랜터 31일 한도 자동 우회 — 31일 초과 시 31일씩 분할 호출 후 중복 제거 합치기.
        5분 메모리 캐시 — 페이지 재방문 시 즉시 응답.
        """
        import asyncio
        import time as _time
        from datetime import date as _date, timedelta

        cache_key = f"all|{start_date}|{end_date}|{asset_id}"
        now = _time.time()
        cached = self._TICKETS_CACHE.get(cache_key)
        if cached and (now - cached[0] < self._CACHE_TTL):
            logger.info("Granter cache HIT: %s", cache_key)
            return cached[1]

        # 31일 초과 시 자동 분할
        try:
            sd = _date.fromisoformat(start_date)
            ed = _date.fromisoformat(end_date)
            span_days = (ed - sd).days + 1
        except Exception:
            sd = ed = None
            span_days = 0

        if sd and ed and span_days > 31:
            # 31일씩 분할 (뒤에서부터)
            chunks = []
            cursor_end = ed
            while cursor_end >= sd:
                cursor_start = max(sd, cursor_end - timedelta(days=30))
                chunks.append((cursor_start.isoformat(), cursor_end.isoformat()))
                cursor_end = cursor_start - timedelta(days=1)

            merged: Dict[str, list] = {
                "EXPENSE_TICKET": [],
                "BANK_TRANSACTION_TICKET": [],
                "TAX_INVOICE_TICKET": [],
                "CASH_RECEIPT_TICKET": [],
            }
            seen_ids: Dict[str, set] = {k: set() for k in merged}
            for s, e in chunks:
                try:
                    chunk_result = await self._fetch_one_period(s, e, asset_id)
                    for tt, items in chunk_result.items():
                        if not isinstance(items, list):
                            continue
                        bucket = merged.setdefault(tt, [])
                        ids = seen_ids.setdefault(tt, set())
                        for t in items:
                            tid = t.get("id") if isinstance(t, dict) else None
                            if tid is not None and tid in ids:
                                continue
                            if tid is not None:
                                ids.add(tid)
                            bucket.append(t)
                except GranterAPIError as e:
                    logger.warning("tickets_all chunk %s~%s failed: %s", s, e, e)

            # 합산 결과 캐시 (빈 응답이 아니면)
            total_count = sum(len(v) for v in merged.values() if isinstance(v, list))
            if total_count > 0:
                self._TICKETS_CACHE[cache_key] = (now, merged)
            logger.info("tickets_all auto-split %d chunks → %d total", len(chunks), total_count)
            return merged

        ticket_types = [
            "EXPENSE_TICKET",            # 카드 사용
            "BANK_TRANSACTION_TICKET",   # 계좌 입출금
            "TAX_INVOICE_TICKET",        # 세금계산서
            "CASH_RECEIPT_TICKET",       # 현금영수증
        ]

        async def _fetch(t: str):
            payload = {"ticketType": t, "startDate": start_date, "endDate": end_date}
            if asset_id is not None:
                payload["assetId"] = asset_id
            try:
                r = await self.list_tickets(payload)
                items = r if isinstance(r, list) else (r.get("data", []) if isinstance(r, dict) else [])
                return t, items
            except GranterAPIError as e:
                logger.warning("Granter tickets %s fetch failed: %s", t, e)
                return t, []

        # 그랜터 rate limit/간헐 401 회피 — 병렬 → 순차 처리 (각 호출 사이 0.2초 간격)
        results = []
        for t in ticket_types:
            results.append(await _fetch(t))
            await asyncio.sleep(0.2)
        result_dict = dict(results)

        # 모든 sub-call이 빈 배열이면 캐시에 저장하지 않음 (실패한 응답이 고착되는 문제 방지)
        total_count = sum(len(v) for v in result_dict.values() if isinstance(v, list))
        if total_count > 0:
            self._TICKETS_CACHE[cache_key] = (now, result_dict)
            # 캐시 청소 (오래된 항목 제거 — 캐시가 100개 넘을 때만)
            if len(self._TICKETS_CACHE) > 100:
                cutoff = now - self._CACHE_TTL
                self._TICKETS_CACHE = {
                    k: v for k, v in self._TICKETS_CACHE.items() if v[0] > cutoff
                }
        else:
            logger.info("Granter cache SKIP (empty): %s", cache_key)
        return result_dict

    def clear_cache(self):
        """전체 캐시 강제 무효화 (디버깅/회복용)"""
        n = len(self._TICKETS_CACHE)
        self._TICKETS_CACHE.clear()
        logger.info("Granter cache cleared (%d entries)", n)
        return n

    async def _fetch_one_period(
        self,
        start_date: str,
        end_date: str,
        asset_id: Optional[int] = None,
    ) -> Dict[str, list]:
        """단일 31일 이내 기간의 모든 ticketType 호출 (캐시 미사용 — 자동 분할에서 사용)"""
        import asyncio

        ticket_types = [
            "EXPENSE_TICKET",
            "BANK_TRANSACTION_TICKET",
            "TAX_INVOICE_TICKET",
            "CASH_RECEIPT_TICKET",
        ]

        async def _fetch(t: str):
            payload = {"ticketType": t, "startDate": start_date, "endDate": end_date}
            if asset_id is not None:
                payload["assetId"] = asset_id
            try:
                r = await self.list_tickets(payload)
                items = r if isinstance(r, list) else (r.get("data", []) if isinstance(r, dict) else [])
                return t, items
            except GranterAPIError as e:
                logger.warning("Granter tickets %s fetch failed: %s", t, e)
                return t, []

        results = []
        for t in ticket_types:
            results.append(await _fetch(t))
            await asyncio.sleep(0.2)
        return dict(results)

    # ============ 잔액 / 일일 리포트 / 환율 ============

    async def list_balances(self, payload: Dict[str, Any]) -> Any:
        """계좌별 잔액 시계열"""
        return await self._request("POST", "/balances", json=payload)

    async def get_daily_financial_report(self, payload: Dict[str, Any]) -> Any:
        """일일 재무 리포트"""
        return await self._request("POST", "/daily-financial-report", json=payload)

    async def get_exchange_rates(self, payload: Dict[str, Any]) -> Any:
        """환율"""
        return await self._request("POST", "/exchange-rates", json=payload)

    # ============ 세금계산서 발행 ============

    async def issue_tax_invoice(self, payload: Dict[str, Any], idempotency_key: Optional[str] = None) -> Any:
        return await self._request("POST", "/tax-invoices-issue", json=payload, idempotency_key=idempotency_key)

    async def modify_tax_invoice(self, payload: Dict[str, Any], idempotency_key: Optional[str] = None) -> Any:
        return await self._request("POST", "/tax-invoices-modify-issue", json=payload, idempotency_key=idempotency_key)

    async def cancel_tax_invoice(self, payload: Dict[str, Any], idempotency_key: Optional[str] = None) -> Any:
        return await self._request("POST", "/tax-invoices-cancel-issue", json=payload, idempotency_key=idempotency_key)

    # ============ 현금영수증 발행 ============

    async def issue_cash_receipt(self, payload: Dict[str, Any], idempotency_key: Optional[str] = None) -> Any:
        return await self._request("POST", "/cash-receipts-issue", json=payload, idempotency_key=idempotency_key)

    async def cancel_cash_receipt(self, payload: Dict[str, Any], idempotency_key: Optional[str] = None) -> Any:
        return await self._request("POST", "/cash-receipts-cancel-issue", json=payload, idempotency_key=idempotency_key)

    # ============ 분류 기준 데이터 ============

    async def list_tags(self) -> Any:
        return await self._request("GET", "/tags")

    async def create_tag(self, payload: Dict[str, Any]) -> Any:
        return await self._request("POST", "/tags", json=payload)

    async def update_tag(self, payload: Dict[str, Any]) -> Any:
        return await self._request("PUT", "/tags", json=payload)

    async def list_tag_details(self) -> Any:
        return await self._request("GET", "/tag-details")

    async def list_categories(self) -> Any:
        return await self._request("GET", "/categories")


# 싱글톤
_granter_client: Optional[GranterClient] = None


def get_granter_client() -> GranterClient:
    global _granter_client
    if _granter_client is None:
        _granter_client = GranterClient()
    return _granter_client
