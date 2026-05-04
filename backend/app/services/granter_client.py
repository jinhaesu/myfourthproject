"""
Granter API Client
그랜터(Granter) 금융 데이터·증빙 발행 API 래퍼.

모든 API 키는 GRANTER_API_KEY 환경변수에서만 읽음. 코드/리포지토리에 하드코딩 금지.
Base URL은 GRANTER_BASE_URL로 override 가능 (default: https://api.granter.io).

지원 기능:
- 연동 데이터 (계좌, 카드, 홈택스, PG사, 오픈마켓)
- 거래 내역 / 잔액 / 환율
- 세금계산서 (발행/수정/취소) · 현금영수증 (발행/취소)
"""
import os
import logging
from datetime import date
from typing import Optional, List, Dict, Any
import httpx

logger = logging.getLogger(__name__)


class GranterAPIError(Exception):
    """그랜터 API 호출 실패"""
    def __init__(self, message: str, status_code: Optional[int] = None, body: Any = None):
        super().__init__(message)
        self.status_code = status_code
        self.body = body


class GranterClient:
    """그랜터 API 비동기 클라이언트 (싱글톤 권장)"""

    DEFAULT_BASE_URL = "https://api.granter.io"
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
            self._client = httpx.AsyncClient(
                base_url=self.base_url,
                headers={
                    "Authorization": f"Bearer {self.api_key}",
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
    ) -> Any:
        if not self.is_configured:
            raise GranterAPIError(
                "GRANTER_API_KEY 환경변수가 설정되지 않았습니다.",
                status_code=500,
            )
        client = self._get_client()
        # None/빈 값 정리
        if params:
            params = {k: v for k, v in params.items() if v is not None and v != ""}

        try:
            resp = await client.request(method, path, params=params, json=json)
        except httpx.TimeoutException as e:
            raise GranterAPIError(f"그랜터 API 타임아웃: {path}", status_code=504) from e
        except httpx.HTTPError as e:
            raise GranterAPIError(f"그랜터 API 통신 오류: {e}", status_code=502) from e

        if resp.status_code >= 400:
            try:
                body = resp.json()
            except Exception:
                body = resp.text
            logger.warning("Granter API %s %s → %s: %s", method, path, resp.status_code, body)
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

    # ============ 연동 데이터 ============

    async def list_connections(self) -> List[Dict[str, Any]]:
        """연동된 금융 자산 목록 (카드/계좌/홈택스/PG/오픈마켓)"""
        result = await self._request("GET", "/v1/connections")
        return result.get("data", result) if isinstance(result, dict) else (result or [])

    async def list_accounts(self) -> List[Dict[str, Any]]:
        """연동된 계좌 목록"""
        result = await self._request("GET", "/v1/accounts")
        return result.get("data", result) if isinstance(result, dict) else (result or [])

    async def list_cards(self) -> List[Dict[str, Any]]:
        """연동된 카드 목록"""
        result = await self._request("GET", "/v1/cards")
        return result.get("data", result) if isinstance(result, dict) else (result or [])

    # ============ 잔액 ============

    async def get_balances(self, account_id: Optional[str] = None) -> Any:
        """계좌별 잔액. account_id 지정 시 특정 계좌만."""
        if account_id:
            return await self._request("GET", f"/v1/accounts/{account_id}/balance")
        return await self._request("GET", "/v1/balances")

    async def get_cash_history(
        self,
        from_date: Optional[date] = None,
        to_date: Optional[date] = None,
    ) -> Any:
        """현금 추이 (시계열 잔액)"""
        return await self._request("GET", "/v1/balances/history", params={
            "from": from_date.isoformat() if from_date else None,
            "to": to_date.isoformat() if to_date else None,
        })

    # ============ 거래 내역 ============

    async def list_transactions(
        self,
        from_date: Optional[date] = None,
        to_date: Optional[date] = None,
        kind: Optional[str] = None,  # account|card|tax_invoice|cash_receipt|approval
        connection_id: Optional[str] = None,
        cursor: Optional[str] = None,
        limit: int = 100,
    ) -> Dict[str, Any]:
        """
        거래 내역 통합 조회 (계좌·카드·세금계산서·현금영수증·결재).
        cursor 기반 페이지네이션 가정.
        """
        result = await self._request("GET", "/v1/transactions", params={
            "from": from_date.isoformat() if from_date else None,
            "to": to_date.isoformat() if to_date else None,
            "kind": kind,
            "connection_id": connection_id,
            "cursor": cursor,
            "limit": limit,
        })
        return result if isinstance(result, dict) else {"data": result or []}

    # ============ 환율 ============

    async def get_exchange_rate(
        self,
        currency: str,
        target_date: Optional[date] = None,
    ) -> Dict[str, Any]:
        """기준 날짜의 환율 (예: KRW 기준 USD)"""
        return await self._request("GET", "/v1/exchange-rates", params={
            "currency": currency,
            "date": target_date.isoformat() if target_date else None,
        })

    # ============ 세금계산서 ============

    async def issue_tax_invoice(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """세금계산서 발행"""
        return await self._request("POST", "/v1/tax-invoices", json=payload)

    async def amend_tax_invoice(
        self,
        invoice_id: str,
        payload: Dict[str, Any],
    ) -> Dict[str, Any]:
        """세금계산서 수정발행"""
        return await self._request("POST", f"/v1/tax-invoices/{invoice_id}/amend", json=payload)

    async def cancel_tax_invoice(
        self,
        invoice_id: str,
        reason: str,
    ) -> Dict[str, Any]:
        """세금계산서 취소발행"""
        return await self._request(
            "POST",
            f"/v1/tax-invoices/{invoice_id}/cancel",
            json={"reason": reason},
        )

    async def get_tax_invoice(self, invoice_id: str) -> Dict[str, Any]:
        return await self._request("GET", f"/v1/tax-invoices/{invoice_id}")

    # ============ 현금영수증 ============

    async def issue_cash_receipt(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """현금영수증 발행"""
        return await self._request("POST", "/v1/cash-receipts", json=payload)

    async def cancel_cash_receipt(
        self,
        receipt_id: str,
        reason: Optional[str] = None,
    ) -> Dict[str, Any]:
        """현금영수증 취소발행"""
        return await self._request(
            "POST",
            f"/v1/cash-receipts/{receipt_id}/cancel",
            json={"reason": reason} if reason else None,
        )

    async def get_cash_receipt(self, receipt_id: str) -> Dict[str, Any]:
        return await self._request("GET", f"/v1/cash-receipts/{receipt_id}")


# 싱글톤 인스턴스
_granter_client: Optional[GranterClient] = None


def get_granter_client() -> GranterClient:
    global _granter_client
    if _granter_client is None:
        _granter_client = GranterClient()
    return _granter_client
