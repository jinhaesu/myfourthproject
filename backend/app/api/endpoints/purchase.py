"""
구매·지출 통제 API — 링크 카탈로그 → 구매요청 → 승인 → 카드전표 대사

권한:
- 카탈로그 조회/등록, 구매요청 생성/본인 조회/취소/결제완료 등록: 로그인한 전 직원
- 승인/반려, 전체 요청 조회, 대사 확정: 회계 관리자
"""
from datetime import date, datetime, timedelta
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, HttpUrl
from sqlalchemy import select, desc
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.database import get_db
from app.core.security import get_current_user, is_accounting_admin
from app.models.purchase import (
    CatalogItem, CatalogPriceHistory,
    PurchaseRequest, PurchaseRequestItem, PurchaseRequestStatus,
)
from app.services.link_parser import parse_product_link

router = APIRouter()


# ==================== Schemas ====================

class ParseLinkBody(BaseModel):
    url: HttpUrl


class CatalogCreateBody(BaseModel):
    url: str
    title: str
    price: Optional[float] = None
    seller: Optional[str] = None
    image_url: Optional[str] = None
    platform: Optional[str] = None
    tags: Optional[str] = None


class RequestItemBody(BaseModel):
    catalog_item_id: Optional[int] = None
    title: str
    unit_price: float = 0.0
    quantity: int = 1


class RequestCreateBody(BaseModel):
    title: str
    reason: Optional[str] = None
    items: List[RequestItemBody]


class RejectBody(BaseModel):
    reason: str


class CompleteBody(BaseModel):
    order_no: Optional[str] = None
    final_amount: float
    card_key: Optional[str] = None
    purchased_at: Optional[datetime] = None


class MatchBody(BaseModel):
    ticket_id: str


# ==================== Helpers ====================

def _catalog_to_dict(item: CatalogItem) -> dict:
    return {
        "id": item.id,
        "url": item.url,
        "platform": item.platform,
        "title": item.title,
        "price": item.price,
        "seller": item.seller,
        "image_url": item.image_url,
        "tags": item.tags,
        "is_active": item.is_active,
        "created_by": item.created_by,
        "created_at": item.created_at.isoformat() if item.created_at else None,
        "updated_at": item.updated_at.isoformat() if item.updated_at else None,
    }


def _request_to_dict(req: PurchaseRequest) -> dict:
    return {
        "id": req.id,
        "requester_email": req.requester_email,
        "title": req.title,
        "reason": req.reason,
        "status": req.status,
        "total_amount": req.total_amount,
        "approved_by": req.approved_by,
        "approved_at": req.approved_at.isoformat() if req.approved_at else None,
        "reject_reason": req.reject_reason,
        "purchased_at": req.purchased_at.isoformat() if req.purchased_at else None,
        "order_no": req.order_no,
        "final_amount": req.final_amount,
        "card_key": req.card_key,
        "matched_ticket_id": req.matched_ticket_id,
        "matched_at": req.matched_at.isoformat() if req.matched_at else None,
        "created_at": req.created_at.isoformat() if req.created_at else None,
        "items": [
            {
                "id": it.id,
                "catalog_item_id": it.catalog_item_id,
                "title": it.title,
                "unit_price": it.unit_price,
                "quantity": it.quantity,
                "line_total": it.line_total,
            }
            for it in (req.items or [])
        ],
    }


async def _get_request_or_404(db: AsyncSession, request_id: int) -> PurchaseRequest:
    req = (await db.execute(
        select(PurchaseRequest)
        .options(selectinload(PurchaseRequest.items))
        .where(PurchaseRequest.id == request_id)
    )).scalar_one_or_none()
    if not req:
        raise HTTPException(status_code=404, detail="구매요청을 찾을 수 없습니다.")
    return req


# ==================== 카탈로그 ====================

@router.post("/catalog/parse")
async def parse_link(
    body: ParseLinkBody,
    user=Depends(get_current_user),
):
    """상품 링크 → 상품명·가격·판매자·이미지 자동 인식 (저장 안 함, 미리보기)."""
    return await parse_product_link(str(body.url))


@router.post("/catalog")
async def create_catalog_item(
    body: CatalogCreateBody,
    db: AsyncSession = Depends(get_db),
    user=Depends(get_current_user),
):
    """카탈로그 저장 — 같은 URL이 있으면 갱신 + 가격 추이 기록."""
    existing = (await db.execute(
        select(CatalogItem).where(CatalogItem.url == body.url)
    )).scalar_one_or_none()

    if existing:
        existing.title = body.title
        existing.seller = body.seller or existing.seller
        existing.image_url = body.image_url or existing.image_url
        existing.platform = body.platform or existing.platform
        existing.tags = body.tags or existing.tags
        existing.is_active = True
        if body.price is not None and body.price != existing.price:
            existing.price = body.price
            db.add(CatalogPriceHistory(item_id=existing.id, price=body.price))
        await db.commit()
        await db.refresh(existing)
        return _catalog_to_dict(existing)

    item = CatalogItem(
        url=body.url,
        title=body.title,
        price=body.price,
        seller=body.seller,
        image_url=body.image_url,
        platform=body.platform,
        tags=body.tags,
        created_by=user.email,
    )
    db.add(item)
    await db.flush()
    if body.price is not None:
        db.add(CatalogPriceHistory(item_id=item.id, price=body.price))
    await db.commit()
    await db.refresh(item)
    return _catalog_to_dict(item)


@router.get("/catalog")
async def list_catalog(
    q: Optional[str] = Query(None, description="상품명/판매자 검색"),
    db: AsyncSession = Depends(get_db),
    user=Depends(get_current_user),
):
    """카탈로그 목록 (회사 공용 — 전 직원 조회 가능)."""
    stmt = select(CatalogItem).where(CatalogItem.is_active == True)  # noqa: E712
    if q:
        like = f"%{q}%"
        stmt = stmt.where(CatalogItem.title.ilike(like) | CatalogItem.seller.ilike(like))
    stmt = stmt.order_by(desc(CatalogItem.updated_at)).limit(200)
    items = (await db.execute(stmt)).scalars().all()
    return {"items": [_catalog_to_dict(i) for i in items]}


@router.post("/catalog/{item_id}/refresh")
async def refresh_catalog_price(
    item_id: int,
    db: AsyncSession = Depends(get_db),
    user=Depends(get_current_user),
):
    """상품 가격 재조회 → 가격 추이 기록."""
    item = (await db.execute(
        select(CatalogItem).where(CatalogItem.id == item_id)
    )).scalar_one_or_none()
    if not item:
        raise HTTPException(status_code=404, detail="카탈로그 항목을 찾을 수 없습니다.")

    parsed = await parse_product_link(item.url)
    if parsed.get("price") is not None:
        item.price = parsed["price"]
        db.add(CatalogPriceHistory(item_id=item.id, price=parsed["price"]))
        await db.commit()
        await db.refresh(item)
    return {"item": _catalog_to_dict(item), "parsed": parsed}


@router.get("/catalog/{item_id}/price-history")
async def price_history(
    item_id: int,
    db: AsyncSession = Depends(get_db),
    user=Depends(get_current_user),
):
    """상품 가격 추이."""
    rows = (await db.execute(
        select(CatalogPriceHistory)
        .where(CatalogPriceHistory.item_id == item_id)
        .order_by(CatalogPriceHistory.checked_at)
    )).scalars().all()
    return {
        "history": [
            {"price": r.price, "checked_at": r.checked_at.isoformat() if r.checked_at else None}
            for r in rows
        ]
    }


@router.delete("/catalog/{item_id}")
async def delete_catalog_item(
    item_id: int,
    db: AsyncSession = Depends(get_db),
    user=Depends(get_current_user),
):
    """카탈로그 비활성화 (등록자 또는 관리자)."""
    item = (await db.execute(
        select(CatalogItem).where(CatalogItem.id == item_id)
    )).scalar_one_or_none()
    if not item:
        raise HTTPException(status_code=404, detail="카탈로그 항목을 찾을 수 없습니다.")
    if item.created_by != user.email and not is_accounting_admin(user):
        raise HTTPException(status_code=403, detail="본인이 등록한 항목만 삭제할 수 있습니다.")
    item.is_active = False
    await db.commit()
    return {"ok": True}


# ==================== 구매요청 ====================

@router.post("/requests")
async def create_request(
    body: RequestCreateBody,
    db: AsyncSession = Depends(get_db),
    user=Depends(get_current_user),
):
    """구매요청 생성 (PENDING)."""
    if not body.items:
        raise HTTPException(status_code=400, detail="품목이 최소 1개 필요합니다.")

    req = PurchaseRequest(
        requester_email=user.email,
        title=body.title,
        reason=body.reason,
        status=PurchaseRequestStatus.PENDING.value,
    )
    total = 0.0
    for it in body.items:
        line_total = round(it.unit_price * it.quantity, 2)
        total += line_total
        req.items.append(PurchaseRequestItem(
            catalog_item_id=it.catalog_item_id,
            title=it.title,
            unit_price=it.unit_price,
            quantity=it.quantity,
            line_total=line_total,
        ))
    req.total_amount = round(total, 2)
    db.add(req)
    await db.commit()
    req = await _get_request_or_404(db, req.id)
    return _request_to_dict(req)


@router.get("/requests")
async def list_requests(
    status_filter: Optional[str] = Query(None, alias="status"),
    db: AsyncSession = Depends(get_db),
    user=Depends(get_current_user),
):
    """구매요청 목록 — 관리자: 전체 / 직원: 본인 요청만."""
    stmt = select(PurchaseRequest).options(selectinload(PurchaseRequest.items))
    if not is_accounting_admin(user):
        stmt = stmt.where(PurchaseRequest.requester_email == user.email)
    if status_filter:
        stmt = stmt.where(PurchaseRequest.status == status_filter.upper())
    stmt = stmt.order_by(desc(PurchaseRequest.created_at)).limit(300)
    reqs = (await db.execute(stmt)).scalars().all()
    return {
        "requests": [_request_to_dict(r) for r in reqs],
        "is_admin": is_accounting_admin(user),
    }


@router.get("/requests/{request_id}")
async def get_request(
    request_id: int,
    db: AsyncSession = Depends(get_db),
    user=Depends(get_current_user),
):
    req = await _get_request_or_404(db, request_id)
    if req.requester_email != user.email and not is_accounting_admin(user):
        raise HTTPException(status_code=403, detail="본인 요청만 조회할 수 있습니다.")
    return _request_to_dict(req)


@router.post("/requests/{request_id}/approve")
async def approve_request(
    request_id: int,
    db: AsyncSession = Depends(get_db),
    user=Depends(get_current_user),
):
    """승인 (관리자 전용)."""
    if not is_accounting_admin(user):
        raise HTTPException(status_code=403, detail="회계 관리자 권한이 필요합니다.")
    req = await _get_request_or_404(db, request_id)
    if req.status != PurchaseRequestStatus.PENDING.value:
        raise HTTPException(status_code=400, detail=f"승인 대기 상태가 아닙니다. (현재: {req.status})")
    req.status = PurchaseRequestStatus.APPROVED.value
    req.approved_by = user.email
    req.approved_at = datetime.utcnow()
    await db.commit()
    return _request_to_dict(await _get_request_or_404(db, request_id))


@router.post("/requests/{request_id}/reject")
async def reject_request(
    request_id: int,
    body: RejectBody,
    db: AsyncSession = Depends(get_db),
    user=Depends(get_current_user),
):
    """반려 (관리자 전용)."""
    if not is_accounting_admin(user):
        raise HTTPException(status_code=403, detail="회계 관리자 권한이 필요합니다.")
    req = await _get_request_or_404(db, request_id)
    if req.status != PurchaseRequestStatus.PENDING.value:
        raise HTTPException(status_code=400, detail=f"승인 대기 상태가 아닙니다. (현재: {req.status})")
    req.status = PurchaseRequestStatus.REJECTED.value
    req.approved_by = user.email
    req.approved_at = datetime.utcnow()
    req.reject_reason = body.reason
    await db.commit()
    return _request_to_dict(await _get_request_or_404(db, request_id))


@router.post("/requests/{request_id}/cancel")
async def cancel_request(
    request_id: int,
    db: AsyncSession = Depends(get_db),
    user=Depends(get_current_user),
):
    """요청 취소 (요청자 본인, PENDING만)."""
    req = await _get_request_or_404(db, request_id)
    if req.requester_email != user.email and not is_accounting_admin(user):
        raise HTTPException(status_code=403, detail="본인 요청만 취소할 수 있습니다.")
    if req.status != PurchaseRequestStatus.PENDING.value:
        raise HTTPException(status_code=400, detail="승인 대기 상태만 취소할 수 있습니다.")
    req.status = PurchaseRequestStatus.CANCELED.value
    await db.commit()
    return _request_to_dict(await _get_request_or_404(db, request_id))


@router.post("/requests/{request_id}/complete")
async def complete_request(
    request_id: int,
    body: CompleteBody,
    db: AsyncSession = Depends(get_db),
    user=Depends(get_current_user),
):
    """결제 완료 등록 — 승인건을 담당자가 결제 후 주문번호·최종금액 입력."""
    req = await _get_request_or_404(db, request_id)
    if req.requester_email != user.email and not is_accounting_admin(user):
        raise HTTPException(status_code=403, detail="본인 요청만 처리할 수 있습니다.")
    if req.status != PurchaseRequestStatus.APPROVED.value:
        raise HTTPException(status_code=400, detail=f"승인된 요청만 결제 완료 처리할 수 있습니다. (현재: {req.status})")
    req.status = PurchaseRequestStatus.PURCHASED.value
    req.order_no = body.order_no
    req.final_amount = body.final_amount
    req.card_key = body.card_key
    req.purchased_at = body.purchased_at or datetime.utcnow()
    await db.commit()
    return _request_to_dict(await _get_request_or_404(db, request_id))


# ==================== 카드전표 대사 ====================

@router.get("/requests/{request_id}/match-candidates")
async def match_candidates(
    request_id: int,
    db: AsyncSession = Depends(get_db),
    user=Depends(get_current_user),
):
    """
    그랜터 카드전표 대사 후보 — 결제일 ±3일, 최종금액 일치(±10원) 우선.
    네이버페이 등 가맹점이 뭉뚱그려 떠도 금액+시각으로 식별.
    """
    req = await _get_request_or_404(db, request_id)
    if req.requester_email != user.email and not is_accounting_admin(user):
        raise HTTPException(status_code=403, detail="본인 요청만 조회할 수 있습니다.")
    if not req.final_amount or not req.purchased_at:
        raise HTTPException(status_code=400, detail="결제 완료 등록(최종금액·결제일) 후 대사할 수 있습니다.")

    from app.services.card_management import _fetch_expense_tickets, _build_card_key

    center = req.purchased_at.date()
    start = center - timedelta(days=3)
    end = min(center + timedelta(days=3), date.today())
    tickets = await _fetch_expense_tickets(start, end)

    target = float(req.final_amount)
    candidates = []
    for t in tickets:
        try:
            amt = float(t.get("amount") or 0)
        except (ValueError, TypeError):
            continue
        diff = abs(amt - target)
        if diff > max(target * 0.05, 1000):  # 5% 또는 1,000원 이내만 후보
            continue
        cu = t.get("cardUsage") or {}
        card_key = _build_card_key(t)
        if req.card_key and card_key != req.card_key:
            continue
        candidates.append({
            "ticket_id": str(t.get("id")),
            "transact_at": str(t.get("transactAt") or t.get("createdAt") or "")[:19],
            "store_name": (cu.get("storeName") or "").strip() or None,
            "card_key": card_key,
            "amount": amt,
            "amount_diff": diff,
            "exact": diff <= 10,
        })
    candidates.sort(key=lambda c: (not c["exact"], c["amount_diff"], c["transact_at"]))
    return {"request_id": request_id, "target_amount": target, "candidates": candidates[:20]}


@router.post("/requests/{request_id}/match")
async def confirm_match(
    request_id: int,
    body: MatchBody,
    db: AsyncSession = Depends(get_db),
    user=Depends(get_current_user),
):
    """카드전표 대사 확정 — 선택한 그랜터 티켓과 연결 (MATCHED)."""
    req = await _get_request_or_404(db, request_id)
    if req.requester_email != user.email and not is_accounting_admin(user):
        raise HTTPException(status_code=403, detail="본인 요청만 처리할 수 있습니다.")
    if req.status != PurchaseRequestStatus.PURCHASED.value:
        raise HTTPException(status_code=400, detail=f"결제 완료 상태만 대사할 수 있습니다. (현재: {req.status})")

    # 동일 티켓 중복 대사 방지
    dup = (await db.execute(
        select(PurchaseRequest).where(
            PurchaseRequest.matched_ticket_id == body.ticket_id,
            PurchaseRequest.id != request_id,
        )
    )).scalar_one_or_none()
    if dup:
        raise HTTPException(status_code=400, detail=f"이미 다른 요청(#{dup.id})에 대사된 전표입니다.")

    req.matched_ticket_id = body.ticket_id
    req.matched_at = datetime.utcnow()
    req.status = PurchaseRequestStatus.MATCHED.value
    await db.commit()
    return _request_to_dict(await _get_request_or_404(db, request_id))
