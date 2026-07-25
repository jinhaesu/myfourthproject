"""
상품 링크 파서 — 링크 붙여넣기 → 상품명·가격·판매자·이미지 자동 인식.

og: 메타태그 + JSON-LD 기반 (bs4 없이 regex 파싱).
네이버 스마트스토어/쿠팡 등 봇 차단이 있는 사이트는 실패할 수 있음 →
그 경우 프론트에서 수동 입력으로 폴백.
"""
from __future__ import annotations

import html as html_lib
import json
import logging
import re
from typing import Any, Dict, Optional
from urllib.parse import urlparse

import httpx

logger = logging.getLogger(__name__)

_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)

_PLATFORM_MAP = [
    ("smartstore.naver.com", "네이버 스마트스토어"),
    ("brand.naver.com", "네이버 브랜드스토어"),
    ("shopping.naver.com", "네이버 쇼핑"),
    ("naver.com", "네이버"),
    ("coupang.com", "쿠팡"),
    ("gmarket.co.kr", "지마켓"),
    ("11st.co.kr", "11번가"),
    ("auction.co.kr", "옥션"),
    ("ssg.com", "SSG"),
    ("kurly.com", "마켓컬리"),
    ("ohou.se", "오늘의집"),
    ("aliexpress.com", "알리익스프레스"),
    ("amazon.", "아마존"),
]


def detect_platform(url: str) -> Optional[str]:
    try:
        host = (urlparse(url).hostname or "").lower()
    except Exception:
        return None
    for pattern, name in _PLATFORM_MAP:
        if pattern in host:
            return name
    return host or None


def _meta(html: str, *props: str) -> Optional[str]:
    """<meta property|name="X" content="..."> 추출 (속성 순서 무관)."""
    for prop in props:
        for pattern in (
            rf'<meta[^>]+(?:property|name)=["\']{re.escape(prop)}["\'][^>]*content=["\']([^"\']*)["\']',
            rf'<meta[^>]+content=["\']([^"\']*)["\'][^>]*(?:property|name)=["\']{re.escape(prop)}["\']',
        ):
            m = re.search(pattern, html, re.IGNORECASE)
            if m and m.group(1).strip():
                return html_lib.unescape(m.group(1).strip())
    return None


def _parse_price_text(text: Optional[str]) -> Optional[float]:
    if not text:
        return None
    digits = re.sub(r"[^\d.]", "", str(text))
    if not digits:
        return None
    try:
        return float(digits)
    except ValueError:
        return None


def _from_json_ld(html: str) -> Dict[str, Any]:
    """JSON-LD (schema.org/Product) 에서 상품 정보 추출."""
    out: Dict[str, Any] = {}
    for m in re.finditer(
        r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>',
        html, re.IGNORECASE | re.DOTALL,
    ):
        try:
            data = json.loads(m.group(1).strip())
        except Exception:
            continue
        candidates = data if isinstance(data, list) else [data]
        for d in candidates:
            if not isinstance(d, dict):
                continue
            if d.get("@type") not in ("Product", "product"):
                continue
            out.setdefault("title", d.get("name"))
            img = d.get("image")
            if isinstance(img, list):
                img = img[0] if img else None
            out.setdefault("image_url", img)
            offers = d.get("offers") or {}
            if isinstance(offers, list):
                offers = offers[0] if offers else {}
            if isinstance(offers, dict):
                out.setdefault("price", _parse_price_text(offers.get("price")))
                seller = offers.get("seller") or {}
                if isinstance(seller, dict):
                    out.setdefault("seller", seller.get("name"))
            brand = d.get("brand")
            if isinstance(brand, dict):
                out.setdefault("seller", brand.get("name"))
    return {k: v for k, v in out.items() if v}


async def parse_product_link(url: str) -> Dict[str, Any]:
    """
    상품 링크 → {title, price, seller, image_url, platform, parsed, error}
    파싱 실패해도 platform은 채워서 반환 (수동 입력 폴백용).
    """
    platform = detect_platform(url)
    base = {
        "url": url,
        "platform": platform,
        "title": None,
        "price": None,
        "seller": None,
        "image_url": None,
        "parsed": False,
        "error": None,
    }

    # 네이버·쿠팡은 서버측 자동 조회를 차단(429/403/로그인 리다이렉트) →
    # 시도하지 않고 바로 검색/수동입력 폴백 안내
    host_blocked = platform and any(
        k in (platform or "") for k in ("네이버", "쿠팡")
    )
    if host_blocked:
        base["error"] = (
            f"{platform}은(는) 자동 조회를 차단합니다. "
            "아래 '상품명으로 검색'을 이용하거나 정보를 직접 입력해주세요."
        )
        return base

    try:
        async with httpx.AsyncClient(
            follow_redirects=True,
            timeout=12.0,
            headers={
                "User-Agent": _UA,
                "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
                "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
            },
        ) as client:
            resp = await client.get(url)
        if resp.status_code >= 400:
            base["error"] = f"HTTP {resp.status_code} — 사이트가 자동 조회를 차단했을 수 있습니다. 직접 입력해주세요."
            return base
        html = resp.text[:1_500_000]
    except Exception as e:
        logger.warning(f"링크 파싱 실패 {url}: {e}")
        base["error"] = "페이지를 불러오지 못했습니다. 직접 입력해주세요."
        return base

    # og: 메타태그
    title = _meta(html, "og:title", "twitter:title")
    image = _meta(html, "og:image", "twitter:image")
    price = _parse_price_text(
        _meta(html, "product:price:amount", "og:price:amount", "twitter:data1")
    )
    seller = _meta(html, "og:site_name", "product:brand", "twitter:site")

    # JSON-LD 보강
    ld = _from_json_ld(html)
    title = title or ld.get("title")
    image = image or ld.get("image_url")
    price = price if price is not None else ld.get("price")
    seller = seller or ld.get("seller")

    # <title> 폴백
    if not title:
        m = re.search(r"<title[^>]*>(.*?)</title>", html, re.IGNORECASE | re.DOTALL)
        if m:
            title = html_lib.unescape(m.group(1).strip())[:300] or None

    base.update({
        "title": title,
        "price": price,
        "seller": seller,
        "image_url": image,
        "parsed": bool(title),
    })
    if not title:
        base["error"] = "상품 정보를 인식하지 못했습니다. 직접 입력해주세요."
    return base
