"""
Account Transfer API — 계좌 이체
회사 계좌에서 외부/내부 계좌로 이체. 단건/대량/예약/즐겨찾기.

NOTE: 라우트 스켈레톤.
"""
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Optional, List
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.schemas.transfer import (
    TransferRequest,
    BulkTransferRequest,
    TransferResponse,
    TransferListResponse,
    TransferOTPVerifyRequest,
    TransferRecipientBookmark,
    TransferRecipientBookmarkCreate,
    TransferStatus,
)

router = APIRouter()


def _mask_account(num: str) -> str:
    if len(num) < 4:
        return num
    return "*" * (len(num) - 4) + num[-4:]


def _mock_transfer(idx: int) -> TransferResponse:
    samples = [
        ("신한", "강남빌딩", "임대료", 3200000, "completed"),
        ("국민", "(주)대상", "원재료 결제", 8400000, "completed"),
        ("우리", "직원_김민수", "급여", 3500000, "scheduled"),
        ("하나", "(주)CJ제일제당", "매입대금", 12500000, "pending_approval"),
    ]
    s = samples[idx % len(samples)]
    return TransferResponse(
        id=idx,
        transfer_type="normal",
        status=s[4],  # type: ignore[arg-type]
        from_bank_account_id=1,
        from_bank_name="신한은행",
        from_account_alias="운영계좌",
        to_bank_code="088",
        to_bank_name=s[0] + "은행",
        to_account_number_masked="****-****-1234",
        to_account_holder=s[1],
        amount=Decimal(str(s[3])),
        fee=Decimal("500"),
        memo_outgoing="우리회사",
        memo_incoming=s[1],
        scheduled_date=date.today() if s[4] == "scheduled" else None,
        executed_at=datetime.utcnow() - timedelta(days=idx),
        completed_at=datetime.utcnow() - timedelta(days=idx) if s[4] == "completed" else None,
        failure_reason=None,
        bank_transaction_id=f"TX{idx:010d}",
        requested_by_user_id=1,
        approved_by_user_id=2 if s[4] != "pending_approval" else None,
        approved_at=datetime.utcnow() - timedelta(days=idx) if s[4] != "pending_approval" else None,
        related_payable_id=None,
        description=s[2],
        created_at=datetime.utcnow() - timedelta(days=idx),
    )


# ==================== 단건 이체 ====================

@router.post("/", response_model=TransferResponse, status_code=status.HTTP_201_CREATED)
async def create_transfer(
    req: TransferRequest,
    user_id: int = Query(...),
    db: AsyncSession = Depends(get_db),
):
    """
    이체 신청 생성
    - require_approval=True면 결재 큐로 대기
    - scheduled_date가 미래면 예약 이체로 등록
    - 즉시 이체는 OTP 인증 후 /execute 호출 필요
    """
    # TODO: 실제 이체 신청 생성
    # 1) 잔액 검증
    # 2) 한도/일일 이체 한도 검증
    # 3) require_approval에 따라 결재 라인 생성
    return TransferResponse(
        id=999,
        transfer_type="scheduled" if req.scheduled_date else "normal",
        status="pending_approval" if req.require_approval else "approved",
        from_bank_account_id=req.from_bank_account_id,
        from_bank_name="신한은행",
        from_account_alias="운영계좌",
        to_bank_code=req.to_bank_code,
        to_bank_name="국민은행",
        to_account_number_masked=_mask_account(req.to_account_number),
        to_account_holder=req.to_account_holder,
        amount=req.amount,
        fee=Decimal("500"),
        memo_outgoing=req.memo_outgoing,
        memo_incoming=req.memo_incoming,
        scheduled_date=req.scheduled_date,
        executed_at=None,
        completed_at=None,
        failure_reason=None,
        bank_transaction_id=None,
        requested_by_user_id=user_id,
        approved_by_user_id=None,
        approved_at=None,
        related_payable_id=req.related_payable_id,
        description=req.description,
        created_at=datetime.utcnow(),
    )


@router.post("/bulk", response_model=List[TransferResponse], status_code=status.HTTP_201_CREATED)
async def create_bulk_transfer(
    req: BulkTransferRequest,
    user_id: int = Query(...),
    db: AsyncSession = Depends(get_db),
):
    """
    대량 이체 (급여, 거래처 일괄지급 등)
    엑셀 업로드 후 검증된 데이터를 한 번에 신청
    """
    # TODO: 실제 대량 이체 처리. 각 건별 검증 + 묶음 결재.
    results: List[TransferResponse] = []
    for item in req.items:
        results.append(TransferResponse(
            id=10000 + item.line_no,
            transfer_type="bulk",
            status="pending_approval" if req.require_approval else "approved",
            from_bank_account_id=req.from_bank_account_id,
            from_bank_name="신한은행",
            from_account_alias="운영계좌",
            to_bank_code=item.to_bank_code,
            to_bank_name="은행",
            to_account_number_masked=_mask_account(item.to_account_number),
            to_account_holder=item.to_account_holder,
            amount=item.amount,
            fee=Decimal("500"),
            memo_outgoing=item.memo_outgoing,
            memo_incoming=item.memo_incoming,
            scheduled_date=req.scheduled_date,
            executed_at=None,
            completed_at=None,
            failure_reason=None,
            bank_transaction_id=None,
            requested_by_user_id=user_id,
            approved_by_user_id=None,
            approved_at=None,
            related_payable_id=None,
            description=item.description or req.description,
            created_at=datetime.utcnow(),
        ))
    return results


@router.get("/", response_model=TransferListResponse)
async def list_transfers(
    status_filter: Optional[TransferStatus] = Query(None, alias="status"),
    from_bank_account_id: Optional[int] = None,
    from_date: Optional[date] = None,
    to_date: Optional[date] = None,
    counterparty_search: Optional[str] = None,
    page: int = Query(1, ge=1),
    size: int = Query(50, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
):
    """이체 이력 조회"""
    # TODO: 실제 조회
    items = [_mock_transfer(i + 1) for i in range(min(size, 8))]
    return TransferListResponse(
        items=items,
        total=len(items),
        page=page, size=size,
        total_amount=sum((i.amount for i in items), Decimal("0")),
    )


@router.get("/{transfer_id}", response_model=TransferResponse)
async def get_transfer(
    transfer_id: int,
    db: AsyncSession = Depends(get_db),
):
    """이체 상세 조회"""
    # TODO: 실제 조회
    return _mock_transfer(transfer_id)


@router.post("/{transfer_id}/execute", response_model=TransferResponse)
async def execute_transfer(
    transfer_id: int,
    otp: TransferOTPVerifyRequest,
    user_id: int = Query(...),
    db: AsyncSession = Depends(get_db),
):
    """
    이체 실행 (OTP 인증 후)
    - 결재 완료된 이체에 대해 OTP 검증 → 은행 API로 이체 실행
    """
    # TODO: OTP 검증 + 은행 API 호출 + 결과 반영
    if not otp.otp_code or len(otp.otp_code) != 6:
        raise HTTPException(status_code=400, detail="유효한 OTP 코드를 입력하세요.")
    tr = _mock_transfer(transfer_id)
    tr.status = "completed"
    tr.executed_at = datetime.utcnow()
    tr.completed_at = datetime.utcnow()
    tr.bank_transaction_id = f"TX{transfer_id:010d}"
    return tr


@router.post("/{transfer_id}/cancel", response_model=TransferResponse)
async def cancel_transfer(
    transfer_id: int,
    reason: str = Query(..., min_length=1),
    user_id: int = Query(...),
    db: AsyncSession = Depends(get_db),
):
    """이체 취소 (완료 전만 가능)"""
    # TODO: 상태 검증 + 취소 처리
    tr = _mock_transfer(transfer_id)
    tr.status = "cancelled"
    return tr


# ==================== 즐겨찾기 ====================

@router.get("/bookmarks/", response_model=List[TransferRecipientBookmark])
async def list_bookmarks(
    db: AsyncSession = Depends(get_db),
):
    """자주 쓰는 입금 계좌 목록"""
    # TODO: 실제 조회
    return [
        TransferRecipientBookmark(
            id=1, nickname="강남빌딩 임대료",
            bank_code="088", bank_name="신한은행",
            account_number_masked="****-****-1234",
            account_holder="강남빌딩",
            last_used_at=datetime.utcnow() - timedelta(days=30),
            usage_count=12,
        ),
        TransferRecipientBookmark(
            id=2, nickname="(주)대상",
            bank_code="004", bank_name="국민은행",
            account_number_masked="****-****-5678",
            account_holder="(주)대상",
            last_used_at=datetime.utcnow() - timedelta(days=7),
            usage_count=24,
        ),
    ]


@router.post("/bookmarks/", response_model=TransferRecipientBookmark,
             status_code=status.HTTP_201_CREATED)
async def create_bookmark(
    req: TransferRecipientBookmarkCreate,
    db: AsyncSession = Depends(get_db),
):
    """즐겨찾기 등록"""
    # TODO: 실제 저장
    return TransferRecipientBookmark(
        id=999, nickname=req.nickname,
        bank_code=req.bank_code, bank_name="은행",
        account_number_masked=_mask_account(req.account_number),
        account_holder=req.account_holder,
        last_used_at=None, usage_count=0,
    )


@router.delete("/bookmarks/{bookmark_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_bookmark(
    bookmark_id: int,
    db: AsyncSession = Depends(get_db),
):
    """즐겨찾기 삭제"""
    # TODO: 실제 삭제
    return


# ==================== OTP / 보안 ====================

@router.post("/{transfer_id}/request-otp")
async def request_otp(
    transfer_id: int,
    db: AsyncSession = Depends(get_db),
):
    """이체 실행용 OTP 발송 (SMS/앱)"""
    # TODO: OTP 발송 로직
    return {
        "transfer_id": transfer_id,
        "delivery_method": "sms",
        "expires_in_seconds": 180,
        "sent_at": datetime.utcnow().isoformat(),
    }
