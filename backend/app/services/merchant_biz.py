"""
가맹점 사업자번호 수동 입력 + 동일 가맹점명 전파.

- 매핑: merchant_biz_manual(norm_name -> biz_no, 입력자/시각). 이름 정규화 = "/" 앞 기본명, 공백 정리, 대문자.
- 행: biz_src='manual', biz_by, biz_at. 우선순위: hometax/hyphen 확정 > manual > inferred.
  (확정값과 수동값이 다르면 확정값 유지, 충돌은 매핑 conflict_note에 기록)
- 전파: 저장 시 모든 카드/월의 공백(또는 inferred) 행에 적용. 이후 동기화·월 배치·조회 시 폴백으로도 적용.
"""
import re
import logging
from datetime import datetime
from typing import Any, Dict, List, Optional

from sqlalchemy import select, or_, func, delete

from app.models.hyphen_ext import HyphenCardTx, MerchantBizManual
from app.services.vat_deduction import digits, manual_key, valid_biz_no  # noqa: F401

logger = logging.getLogger(__name__)

CONFIRMED = ("hometax", "hyphen")


def _is_open(t: HyphenCardTx) -> bool:
    return not (t.store_biz_no or "").strip() or t.biz_src == "inferred"


async def load_manual_map(db) -> Dict[str, str]:
    return {r.norm_name: r.biz_no for r in (await db.execute(select(MerchantBizManual))).scalars().all()}


async def apply_mappings(db, *, floor: str = "2026-01-01", commit: bool = True) -> int:
    """매핑을 공백/추정 행 전체에 적용. 동기화·월 배치에서 호출. 반환=채운 행 수."""
    mp = await load_manual_map(db)
    if not mp:
        return 0
    rows = (await db.execute(select(HyphenCardTx).where(
        or_(func.coalesce(func.trim(HyphenCardTx.store_biz_no), "") == "", HyphenCardTx.biz_src == "inferred"),
        func.replace(HyphenCardTx.use_dt, "-", "") >= floor.replace("-", "")))).scalars().all()
    n = 0
    for t in rows:
        b = mp.get(manual_key(t.use_store))
        if b:
            t.store_biz_no, t.biz_src = b, "manual"
            t.biz_at = t.biz_at or datetime.utcnow()
            n += 1
    if commit:
        await db.commit()
    return n


async def log_conflict(db, key: str, manual_biz: str, confirmed_biz: str, src: str) -> None:
    """확정(hometax/hyphen) 번호가 수동 입력과 다를 때 확정값 유지 + 충돌 기록."""
    m = (await db.execute(select(MerchantBizManual).where(MerchantBizManual.norm_name == key))).scalar_one_or_none()
    note = f"{datetime.utcnow():%Y-%m-%d} {src}={confirmed_biz} 수동={manual_biz} 충돌 -> {src} 유지"
    logger.warning("사업자번호 충돌 [%s] %s", key, note)
    if m is not None:
        m.conflict_note = ((m.conflict_note or "") + "\n" + note)[-900:]


class BizError(ValueError):
    pass


async def set_manual(db, *, ticket_id: str, biz_no: str, user_email: str, is_admin: bool) -> Dict[str, Any]:
    """수동 입력 저장 + 국세청 즉시 조회 + 동일 가맹점명 전파."""
    from app.services import nts_client
    d = digits(biz_no)
    if not valid_biz_no(d):
        raise BizError("사업자번호 형식/체크섬이 올바르지 않습니다.")
    tx = (await db.execute(select(HyphenCardTx).where(HyphenCardTx.dedup_hash == ticket_id))).scalar_one_or_none()
    if tx is None:
        raise BizError("거래를 찾을 수 없습니다.")
    key = manual_key(tx.use_store)
    if not key:
        raise BizError("가맹점명이 없어 입력할 수 없습니다.")
    if tx.biz_src in CONFIRMED and (tx.store_biz_no or "").strip():
        raise BizError("카드사/홈택스에서 확정된 사업자번호는 수정할 수 없습니다.")
    if tx.biz_src == "manual" and (tx.store_biz_no or "").strip() and not is_admin:
        raise BizError("이미 입력된 번호입니다. 수정은 관리자만 가능합니다.")

    # 국세청 즉시 조회 (키 없으면 건너뜀)
    nts_info = None
    if nts_client.nts_enabled():
        try:
            await nts_client.refresh_statuses(db, [d], max_age_days=0)
            nts_info = True
        except Exception as e:  # noqa: BLE001
            logger.warning("수동입력 NTS 조회 실패: %s", str(e)[:150])

    now = datetime.utcnow()
    m = (await db.execute(select(MerchantBizManual).where(MerchantBizManual.norm_name == key))).scalar_one_or_none()
    if m is None:
        db.add(MerchantBizManual(norm_name=key, biz_no=d, entered_by=user_email, entered_at=now))
    else:
        m.biz_no, m.entered_by, m.entered_at = d, user_email, now

    rows = (await db.execute(select(HyphenCardTx).where(
        HyphenCardTx.use_store.isnot(None)))).scalars().all()
    n = 0
    for t in rows:
        if manual_key(t.use_store) != key:
            continue
        cur = digits(t.store_biz_no)
        if t.biz_src in CONFIRMED and cur:
            if cur != d:
                await log_conflict(db, key, d, cur, t.biz_src)
            continue
        if cur and t.biz_src == "manual" and not is_admin:
            continue   # 직원은 기존 수동값을 덮어쓰지 못함
        if cur and t.biz_src not in ("manual", "inferred") and t.biz_src is not None:
            continue
        t.store_biz_no, t.biz_src, t.biz_by, t.biz_at = d, "manual", user_email, now
        n += 1
    await db.commit()
    return {"biz_no": d, "propagated": n, "nts_checked": bool(nts_info), "key": key}


async def clear_manual(db, *, ticket_id: str, user_email: str) -> Dict[str, Any]:
    """관리자: 수동 입력 해제 - 매핑 삭제 + 해당 이름의 manual 행을 공백으로."""
    tx = (await db.execute(select(HyphenCardTx).where(HyphenCardTx.dedup_hash == ticket_id))).scalar_one_or_none()
    if tx is None:
        raise BizError("거래를 찾을 수 없습니다.")
    key = manual_key(tx.use_store)
    await db.execute(delete(MerchantBizManual).where(MerchantBizManual.norm_name == key))
    rows = (await db.execute(select(HyphenCardTx).where(HyphenCardTx.biz_src == "manual"))).scalars().all()
    n = 0
    for t in rows:
        if manual_key(t.use_store) == key:
            t.store_biz_no, t.biz_src, t.biz_by, t.biz_at = None, None, None, None
            n += 1
    await db.commit()
    logger.info("수동 사업자번호 해제 key=%s rows=%s by=%s", key, n, user_email)
    return {"cleared": n}
