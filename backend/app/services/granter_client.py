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

    def __init__(self):
        self.api_key = os.getenv("GRANTER_API_KEY", "").strip()
        self.base_url = os.getenv("GRANTER_BASE_URL", self.DEFAULT_BASE_URL).rstrip("/")
        self.timeout = float(os.getenv("GRANTER_TIMEOUT", str(self.DEFAULT_TIMEOUT)))
        self._client: Optional[httpx.AsyncClient] = None

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
    ) -> Any:
        if not self.is_configured:
            raise GranterAPIError("GRANTER_API_KEY 환경변수가 설정되지 않았습니다.", status_code=500)

        client = self._get_client()
        if params:
            params = {k: v for k, v in params.items() if v is not None and v != ""}

        headers = {}
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key

        try:
            resp = await client.request(method, path, params=params, json=json, headers=headers)
        except httpx.TimeoutException as e:
            raise GranterAPIError(f"그랜터 API 타임아웃: {path}", status_code=504) from e
        except httpx.HTTPError as e:
            raise GranterAPIError(f"그랜터 API 통신 오류: {e}", status_code=502) from e

        if resp.status_code >= 400:
            try:
                body = resp.json()
            except Exception:
                body = resp.text
            logger.warning("Granter %s %s → %s: %s", method, path, resp.status_code, body)
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

        results = await asyncio.gather(*[_fetch(t) for t in asset_types])
        return dict(results)

    async def list_tickets_all_types(
        self,
        start_date: str,
        end_date: str,
        asset_id: Optional[int] = None,
    ) -> Dict[str, Any]:
        """
        모든 ticketType을 병렬 호출해 합쳐서 반환.
        그랜터 31일 제한 안내: 31일 이상이면 클라이언트가 분할 호출 권장.
        """
        import asyncio

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

        results = await asyncio.gather(*[_fetch(t) for t in ticket_types])
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
