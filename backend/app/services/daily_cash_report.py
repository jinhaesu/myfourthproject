"""
Daily Cash Report (AI 자금 다이제스트) 생성 서비스

데이터 소스: 그랜터 API (실시간 자금 흐름)
- daily-financial-report: 잔액·입출금
- list_tickets_all_types: 카드/통장/세금계산서/현금영수증 거래

위하고 voucher는 회계/분석용이므로 자금 다이제스트에서 사용하지 않음.
"""
from __future__ import annotations

import json
import logging
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Any, Dict, List, Optional

from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.daily_cash_report import (
    DailyCashReportConfig, DailyCashReportSnapshot,
    DEFAULT_SECTIONS, REQUIRED_SECTIONS,
)
from app.services.granter_client import get_granter_client

logger = logging.getLogger(__name__)


async def get_or_create_config(db: AsyncSession, user_id: int) -> DailyCashReportConfig:
    """사용자별 설정 조회 — 없으면 기본값으로 생성."""
    cfg = (await db.execute(
        select(DailyCashReportConfig).where(DailyCashReportConfig.user_id == user_id)
    )).scalar_one_or_none()
    if cfg:
        return cfg
    cfg = DailyCashReportConfig(
        user_id=user_id,
        enabled=True,
        sections=json.dumps(DEFAULT_SECTIONS),
        disabled_sections="[]",
        delivery_time="09:00",
        delivery_channels='["email"]',
    )
    db.add(cfg)
    await db.commit()
    await db.refresh(cfg)
    return cfg


def _format_won(amount: Decimal | float | int) -> str:
    n = int(amount or 0)
    sign = ""
    if n < 0:
        sign = "-"
        n = -n
    if n >= 100_000_000:
        eok = n // 100_000_000
        man = (n % 100_000_000) // 10_000
        if man > 0:
            return f"{sign}{eok}억 {man:,}만원"
        return f"{sign}{eok}억원"
    if n >= 10_000:
        man = n // 10_000
        rest = n % 10_000
        if rest > 0:
            return f"{sign}{man:,}만 {rest:,}원"
        return f"{sign}{man:,}만원"
    return f"{sign}{n:,}원"


# ============ 그랜터 호출 + 캐싱 ============

import time as _time

# 단일 타입 티켓 캐시 — (type, start, end) → (items, ts). 5분 TTL.
_SINGLE_TYPE_CACHE: Dict[tuple, tuple] = {}
# daily-financial-report 캐시 — date → (report, ts). 5분 TTL.
_DAILY_REPORT_CACHE: Dict[str, tuple] = {}
_CACHE_TTL = 300.0


async def _granter_daily_report(target_date: date) -> Dict[str, Any]:
    """target_date 단일 일자 daily-financial-report 호출 (5분 캐시)."""
    key = target_date.isoformat()
    now = _time.time()
    cached = _DAILY_REPORT_CACHE.get(key)
    if cached and (now - cached[1]) < _CACHE_TTL:
        return cached[0]

    client = get_granter_client()
    try:
        report = await client.get_daily_financial_report({
            "startDate": key,
            "endDate": key,
            "useCurrentExchangeRate": False,
        }) or {}
        _DAILY_REPORT_CACHE[key] = (report, now)
        return report
    except Exception as e:
        logger.exception(f"그랜터 daily-report 호출 실패 (date={target_date})")
        return {"_error": str(e)[:200]}


async def _granter_tickets_single(
    ticket_type: str, start_date: date, end_date: date,
) -> List[Dict[str, Any]]:
    """단일 타입 티켓 조회 — 필요한 타입만 1회 호출 (기존 all_types는 4타입×4회 낭비).

    5분 캐시로 같은 기간 재조회 절약. 긴 기간은 자동 분할(list_tickets_single).
    """
    key = (ticket_type, start_date.isoformat(), end_date.isoformat())
    now = _time.time()
    cached = _SINGLE_TYPE_CACHE.get(key)
    if cached and (now - cached[1]) < _CACHE_TTL:
        return cached[0]

    client = get_granter_client()
    try:
        items = await client.list_tickets_single(
            ticket_type, start_date.isoformat(), end_date.isoformat(),
        )
        _SINGLE_TYPE_CACHE[key] = (items, now)
        # 오래된 캐시 정리
        for k in list(_SINGLE_TYPE_CACHE.keys()):
            if now - _SINGLE_TYPE_CACHE[k][1] > _CACHE_TTL:
                _SINGLE_TYPE_CACHE.pop(k, None)
        return items
    except Exception:
        logger.exception(f"그랜터 {ticket_type} 호출 실패 ({start_date}~{end_date})")
        return []


async def _granter_expense_tickets(start_date: date, end_date: date) -> List[Dict[str, Any]]:
    """카드(EXPENSE_TICKET) 거래 — 31일 제한 안에서만 호출."""
    items = await _granter_tickets_single("EXPENSE_TICKET", start_date, end_date)
    # 취소/거절 카드거래 제외 — 자금일보 카드지출 부풀림 방지
    from app.services.granter_client import filter_normal_card_tickets
    return filter_normal_card_tickets(items, f"daily_cash_report {start_date}~{end_date}")


async def _granter_bank_tickets(start_date: date, end_date: date) -> List[Dict[str, Any]]:
    """통장 거래(BANK_TRANSACTION_TICKET) — 입출금 상세."""
    return await _granter_tickets_single("BANK_TRANSACTION_TICKET", start_date, end_date)


def _split_inflow_outflow(bank_tickets: List[Dict[str, Any]]) -> tuple:
    """BANK_TRANSACTION_TICKET 리스트를 입금/출금으로 분리."""
    inflows = []
    outflows = []
    for t in bank_tickets:
        try:
            amt = float(t.get("amount") or 0)
        except (ValueError, TypeError):
            amt = 0.0
        if amt <= 0:
            continue
        bt = t.get("bankTransaction") or {}
        direction = (t.get("transactionType") or "").upper()
        # 그랜터 응답 다양성 — IN/INBOUND/DEPOSIT, 한글 '입금', 또는 inOutType 등
        in_out = (t.get("inOutType") or bt.get("inOutType") or "").upper()
        is_inbound = (
            direction in ("IN", "INBOUND", "DEPOSIT")
            or in_out in ("IN", "INBOUND", "DEPOSIT")
            or "입금" in str(direction)
            or "입금" in str(in_out)
        )
        entry = {
            "counterparty": (bt.get("opponent") or bt.get("counterparty")
                             or bt.get("opponentName") or "(미지정)"),
            "description": bt.get("content") or bt.get("memo") or "",
            "amount": amt,
            "date": t.get("transactAt") or t.get("createdAt") or "",
        }
        if is_inbound:
            inflows.append(entry)
        else:
            outflows.append(entry)
    return inflows, outflows


# ============ 섹션 빌더 ============

async def _section_cash_status(target_date: date, report: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """자금 현황 — 그랜터 일일 리포트의 입출금 + 현 잔액."""
    if report is None:
        report = await _granter_daily_report(target_date)
    total = (report or {}).get("total", {}) if isinstance(report, dict) else {}
    inflow = float(total.get("inAmount") or 0)
    outflow = float(total.get("outAmount") or 0)
    balance = float(total.get("currentBalance") or 0)
    net = inflow - outflow

    return {
        "title": "자금 현황",
        "date": target_date.isoformat(),
        "inflow": inflow,
        "outflow": outflow,
        "net": net,
        "balance": balance,
        "summary": (
            f"어제 입금 {_format_won(inflow)}, 출금 {_format_won(outflow)}으로 "
            f"순 {'+' if net >= 0 else ''}{_format_won(net)} 변동했어요. "
            f"현 시점 가용자금은 {_format_won(balance)}이에요."
        ),
    }


async def _section_ai_cashflow(target_date: date, report: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """AI 현금흐름 — 잔액 추이 + 주요 입출금 (개별 거래 단위).

    주요 입출금은 BANK_TRANSACTION_TICKET 기반으로 입금/출금 각 top 5 보장.
    어제 데이터가 부족하면 최근 7일까지 확장해서 채움.
    """
    if report is None:
        report = await _granter_daily_report(target_date)
    total = (report or {}).get("total", {}) if isinstance(report, dict) else {}
    bal_today = float(total.get("currentBalance") or 0)
    bal_prev_day = float(total.get("previousBalance") or 0)
    delta_day = bal_today - bal_prev_day

    # 전월 동기
    prev_month_target = target_date.replace(day=1) - timedelta(days=1)
    prev_month_same_day = min(target_date.day, prev_month_target.day)
    prev_month_date = prev_month_target.replace(day=prev_month_same_day)
    prev_month_report = await _granter_daily_report(prev_month_date)
    prev_total = (prev_month_report or {}).get("total", {})
    bal_prev_month = float(prev_total.get("currentBalance") or 0)
    delta_month = bal_today - bal_prev_month

    # 어제 통장 거래
    day_tickets = await _granter_bank_tickets(target_date, target_date)
    inflows, outflows = _split_inflow_outflow(day_tickets)
    inflows.sort(key=lambda x: x["amount"], reverse=True)
    outflows.sort(key=lambda x: x["amount"], reverse=True)

    # 어제만으로 3건 미만이면 최근 7일까지 확장
    if len(inflows) < 3 or len(outflows) < 3:
        wider_start = target_date - timedelta(days=7)
        wider_tickets = await _granter_bank_tickets(wider_start, target_date)
        wider_in, wider_out = _split_inflow_outflow(wider_tickets)
        # 어제 항목 보존, 추가만 채움
        existing_in = {(e["counterparty"], e["amount"], e["date"]) for e in inflows}
        existing_out = {(e["counterparty"], e["amount"], e["date"]) for e in outflows}
        for e in sorted(wider_in, key=lambda x: x["amount"], reverse=True):
            if (e["counterparty"], e["amount"], e["date"]) not in existing_in:
                inflows.append(e)
                existing_in.add((e["counterparty"], e["amount"], e["date"]))
                if len(inflows) >= 5:
                    break
        for e in sorted(wider_out, key=lambda x: x["amount"], reverse=True):
            if (e["counterparty"], e["amount"], e["date"]) not in existing_out:
                outflows.append(e)
                existing_out.add((e["counterparty"], e["amount"], e["date"]))
                if len(outflows) >= 5:
                    break

    # top 5씩 자름
    inflows = inflows[:5]
    outflows = outflows[:5]

    return {
        "title": "AI 현금흐름 분석",
        "balance_trend": {
            "title": "잔액 추이",
            "balance": bal_today,
            "delta_day": delta_day,
            "delta_month": delta_month,
            "summary": (
                f"어제 최종 잔액은 {_format_won(bal_today)}으로, "
                f"전일 대비 {_format_won(abs(delta_day))} "
                f"{'증가' if delta_day >= 0 else '감소'}하였고, "
                f"전월 동기 대비 {_format_won(abs(delta_month))} "
                f"{'증가' if delta_month >= 0 else '감소'}했어요."
            ),
        },
        "top_movements": {
            "title": "주요 입출금 내역",
            "outflows": outflows,
            "inflows": inflows,
        },
    }


async def _section_card_spending(target_date: date) -> Dict[str, Any]:
    """카드 지출 분석 — 어제 + 이번달 vs 전월 동기 (그랜터 expense_tickets)."""
    month_start = target_date.replace(day=1)
    prev_month_end = month_start - timedelta(days=1)
    prev_month_start = prev_month_end.replace(day=1)
    prev_month_same = prev_month_end.replace(day=min(target_date.day, prev_month_end.day))

    # 이번달 + 전월 동기 한꺼번에 받음 (30일 제한 안에서)
    span_start = min(prev_month_start, month_start)
    span_end = target_date
    tickets = await _granter_expense_tickets(span_start, span_end)

    def _ticket_date(t: Dict[str, Any]) -> Optional[date]:
        d = t.get("transactAt") or t.get("createdAt") or ""
        try:
            return date.fromisoformat(str(d)[:10])
        except (ValueError, TypeError):
            return None

    def _amt(t: Dict[str, Any]) -> float:
        try:
            return float(t.get("amount") or 0)
        except (ValueError, TypeError):
            return 0.0

    today_total = sum(_amt(t) for t in tickets if _ticket_date(t) == target_date)
    month_total = sum(_amt(t) for t in tickets if _ticket_date(t) and month_start <= _ticket_date(t) <= target_date)
    prev_total = sum(_amt(t) for t in tickets if _ticket_date(t) and prev_month_start <= _ticket_date(t) <= prev_month_same)

    diff = month_total - prev_total

    # 어제 top 5
    today_tickets = [t for t in tickets if _ticket_date(t) == target_date]
    today_tickets.sort(key=_amt, reverse=True)
    top = today_tickets[:5]
    top_payments = []
    for t in top:
        cu = t.get("cardUsage") or {}
        card = cu.get("card") or {}
        card_label = (card.get("nickname") or card.get("name")
                      or card.get("organizationName") or "")
        top_payments.append({
            "counterparty": cu.get("storeName") or "(미지정)",
            "description": card_label or cu.get("category") or "",
            "amount": _amt(t),
        })

    return {
        "title": "카드 지출 분석",
        "trend": {
            "title": "지출 추이",
            "today_total": today_total,
            "month_total": month_total,
            "prev_month_total": prev_total,
            "diff_vs_prev_month": diff,
            "summary": (
                f"어제는 총 {_format_won(today_total)}을 결제했어요. "
                f"이번달 누적 카드 사용액은 {_format_won(month_total)}으로, "
                f"전월 동기 대비 {_format_won(abs(diff))} "
                f"{'더 쓰고' if diff > 0 else '덜 쓰고'} 있어요."
            ),
        },
        "top_payments": top_payments,
    }


async def _section_card_usage(target_date: date) -> Dict[str, Any]:
    """카드 사용 현황 — 어제 카드 결제 상세."""
    tickets = await _granter_expense_tickets(target_date, target_date)

    def _amt(t: Dict[str, Any]) -> float:
        try:
            return float(t.get("amount") or 0)
        except (ValueError, TypeError):
            return 0.0

    tickets.sort(key=_amt, reverse=True)
    total = sum(_amt(t) for t in tickets)
    items = []
    for t in tickets[:10]:
        cu = t.get("cardUsage") or {}
        items.append({
            "counterparty": cu.get("storeName") or "(미지정)",
            "description": t.get("cardName") or cu.get("category") or "",
            "amount": _amt(t),
        })

    return {
        "title": "카드 사용 현황",
        "date": target_date.isoformat(),
        "total": total,
        "count": len(tickets),
        "items": items,
        "summary": f"어제 카드 결제 {len(tickets)}건, 총 {_format_won(total)}이에요.",
    }


SECTION_GENERATORS = {
    "cash_status": _section_cash_status,
    "ai_cashflow": _section_ai_cashflow,
    "card_spending": _section_card_spending,
    "card_usage": _section_card_usage,
}


# ============ 정기 발송 (스케줄러가 매분 호출) ============

def _won(v: Any) -> str:
    return _format_won(v)


def _digest_to_html(content: Dict[str, Any]) -> str:
    """자금일보 콘텐츠 → 이메일 HTML (화면과 동일한 상세 내용)."""
    target = content.get("target_date") or content.get("report_date") or ""
    P = [
        '<div style="font-family:\'Apple SD Gothic Neo\',sans-serif;max-width:600px;margin:0 auto;padding:24px 16px;background:#f8fafc;">',
        '<div style="background:linear-gradient(135deg,#2563eb,#4f46e5);border-radius:12px;padding:24px;color:#fff;">',
        '<h1 style="margin:0 0 4px;font-size:20px;">AI 자금 다이제스트</h1>',
        f'<p style="margin:0;opacity:.9;font-size:13px;">기준일 {target}</p></div>',
    ]

    def card_open(title, color="#1f2937"):
        return ('<div style="background:#fff;border:1px solid #e5e7eb;border-radius:12px;margin-top:12px;padding:18px;">'
                f'<h2 style="margin:0 0 10px;font-size:15px;color:{color};">{title}</h2>')

    def row(label, value, vcolor="#111827"):
        return ('<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid #f3f4f6;">'
                f'<span style="font-size:13px;color:#6b7280;">{label}</span>'
                f'<span style="font-size:13px;color:{vcolor};font-weight:600;">{value}</span></div>')

    sections = content.get("content", {}) or {}
    order = content.get("sections_order") or list(sections.keys())
    disabled = set(content.get("disabled_sections", []) or [])

    for key in order:
        if key in disabled:
            continue
        sec = sections.get(key)
        if not sec or not isinstance(sec, dict):
            continue
        title = sec.get("title") or key

        if key == "cash_status":
            P.append(card_open(title, "#2563eb"))
            P.append(f'<p style="margin:0 0 10px;font-size:13px;color:#374151;line-height:1.6;">{sec.get("summary","")}</p>')
            P.append(row("입금", _won(sec.get("inflow")), "#059669"))
            P.append(row("출금", _won(sec.get("outflow")), "#dc2626"))
            P.append(row("순변동", _won(sec.get("net"))))
            P.append(row("현재 잔액", _won(sec.get("balance"))))
            P.append("</div>")

        elif key == "ai_cashflow":
            P.append(card_open(title, "#059669"))
            bt = sec.get("balance_trend") or {}
            if bt.get("summary"):
                P.append(f'<p style="margin:0 0 8px;font-size:13px;color:#374151;line-height:1.6;">{bt.get("summary")}</p>')
            tm = sec.get("top_movements") or {}
            for m in (tm.get("outflows") or [])[:5]:
                cp = m.get("counterparty") or m.get("description") or "출금"
                P.append(row(f"↑ {cp}", _won(m.get("amount")), "#dc2626"))
            for m in (tm.get("inflows") or [])[:5]:
                cp = m.get("counterparty") or m.get("description") or "입금"
                P.append(row(f"↓ {cp}", _won(m.get("amount")), "#059669"))
            P.append("</div>")

        elif key == "card_spending":
            P.append(card_open(title, "#d97706"))
            tr = sec.get("trend") or {}
            if tr.get("summary"):
                P.append(f'<p style="margin:0 0 8px;font-size:13px;color:#374151;line-height:1.6;">{tr.get("summary")}</p>')
            for p in (sec.get("top_payments") or [])[:8]:
                cp = p.get("counterparty") or "결제"
                desc = f" ({p.get('description')})" if p.get("description") else ""
                P.append(row(f"{cp}{desc}", _won(p.get("amount")), "#d97706"))
            P.append("</div>")

        elif key == "card_usage":
            P.append(card_open(title, "#7c3aed"))
            if sec.get("summary"):
                P.append(f'<p style="margin:0 0 8px;font-size:13px;color:#374151;line-height:1.6;">{sec.get("summary")}</p>')
            for it in (sec.get("items") or [])[:8]:
                cp = it.get("counterparty") or "사용"
                P.append(row(cp, _won(it.get("amount")), "#7c3aed"))
            P.append("</div>")

        else:
            P.append(card_open(title))
            P.append(f'<p style="margin:0;font-size:13px;color:#374151;line-height:1.6;">{sec.get("summary") or sec.get("error") or ""}</p></div>')

    P.append('<p style="margin:16px 0 0;font-size:11px;color:#9ca3af;text-align:center;">Smart Finance Core — 자금일보 자동 발송</p></div>')
    return "".join(P)


async def deliver_scheduled_digests() -> int:
    """정기 발송 실행 — enabled 설정 중 delivery_time(KST)이 지났고
    오늘 아직 발송 안 된 사용자에게 생성→스냅샷→이메일 발송.

    다중 인스턴스 중복 발송은 스냅샷(user_id+report_date unique)의
    sent_at IS NULL 조건부 UPDATE 클레임으로 방지.
    Returns: 발송 건수
    """
    from sqlalchemy import update
    from app.core.database import async_session_factory
    from app.models.user import User
    from app.services.email_service import send_email

    if async_session_factory is None:
        return 0

    now_kst = datetime.utcnow() + timedelta(hours=9)
    today_kst = now_kst.date()
    hhmm = now_kst.strftime("%H:%M")
    sent_count = 0

    async with async_session_factory() as db:
        rows = (await db.execute(
            select(DailyCashReportConfig, User.email)
            .join(User, User.id == DailyCashReportConfig.user_id)
            .where(DailyCashReportConfig.enabled == True)  # noqa: E712
        )).all()

        for cfg, email in rows:
            delivery_time = (cfg.delivery_time or "09:00")[:5]
            if hhmm < delivery_time:
                continue  # 아직 발송 시각 전

            channels = []
            try:
                channels = json.loads(cfg.delivery_channels or '["email"]')
            except (ValueError, TypeError):
                channels = ["email"]
            if "email" not in channels:
                continue  # 현재 이메일 채널만 지원

            # 오늘 스냅샷 조회/생성 (클레임 대상 행 확보)
            snap = (await db.execute(
                select(DailyCashReportSnapshot).where(
                    DailyCashReportSnapshot.user_id == cfg.user_id,
                    DailyCashReportSnapshot.report_date == today_kst,
                )
            )).scalar_one_or_none()

            if snap and snap.sent_at:
                continue  # 오늘 이미 발송됨

            if snap is None:
                try:
                    snap = DailyCashReportSnapshot(
                        user_id=cfg.user_id,
                        report_date=today_kst,
                        content="{}",
                        sent_channels=None,
                        sent_at=None,
                    )
                    db.add(snap)
                    await db.commit()
                    await db.refresh(snap)
                except Exception:
                    # unique 충돌 — 다른 인스턴스가 먼저 생성
                    await db.rollback()
                    continue

            # 원자적 클레임 — 이긴 인스턴스만 발송
            claimed = await db.execute(
                update(DailyCashReportSnapshot)
                .where(
                    DailyCashReportSnapshot.id == snap.id,
                    DailyCashReportSnapshot.sent_at.is_(None),
                )
                .values(sent_at=datetime.utcnow(), sent_channels=json.dumps(["email"]))
            )
            await db.commit()
            if claimed.rowcount == 0:
                continue  # 다른 인스턴스가 선점

            try:
                target = today_kst - timedelta(days=1)
                content = await generate_report_content(db, cfg.user_id, target, cfg)
                snap.content = json.dumps(content, default=str, ensure_ascii=False)
                await db.commit()

                ok = await send_email(
                    email,
                    f"[Smart Finance] {target.isoformat()} 자금 다이제스트",
                    _digest_to_html(content),
                )
                if ok:
                    sent_count += 1
                    logger.info(f"[Digest] {email} 자금일보 발송 완료 (기준일 {target})")
                else:
                    logger.warning(f"[Digest] {email} 이메일 발송 실패 — 스냅샷은 저장됨")
            except Exception:
                logger.exception(f"[Digest] user_id={cfg.user_id} 발송 처리 실패")

    return sent_count


async def generate_report_content(
    db: AsyncSession,
    user_id: int,
    target_date: date,
    config: Optional[DailyCashReportConfig] = None,
    auto_latest: bool = True,
) -> Dict[str, Any]:
    """사용자 설정에 따라 자금일보 콘텐츠 생성 (그랜터 데이터)."""
    if config is None:
        config = await get_or_create_config(db, user_id)

    try:
        sections = json.loads(config.sections)
        disabled = set(json.loads(config.disabled_sections or "[]"))
    except (ValueError, TypeError):
        sections = DEFAULT_SECTIONS
        disabled = set()

    # 그랜터 daily-report 한 번만 호출 후 cash_status/ai_cashflow에 공유
    shared_report = await _granter_daily_report(target_date)

    result = {
        "report_date": target_date.isoformat(),
        "target_date": target_date.isoformat(),
        "sections_order": sections,
        "disabled_sections": list(disabled),
        "content": {},
    }

    for section_key in sections:
        if section_key in disabled and section_key not in REQUIRED_SECTIONS:
            continue
        try:
            if section_key == "cash_status":
                result["content"][section_key] = await _section_cash_status(target_date, shared_report)
            elif section_key == "ai_cashflow":
                result["content"][section_key] = await _section_ai_cashflow(target_date, shared_report)
            elif section_key == "card_spending":
                result["content"][section_key] = await _section_card_spending(target_date)
            elif section_key == "card_usage":
                result["content"][section_key] = await _section_card_usage(target_date)
        except Exception as e:
            logger.exception(f"섹션 생성 실패: {section_key}")
            result["content"][section_key] = {"error": str(e)[:200]}

    return result
