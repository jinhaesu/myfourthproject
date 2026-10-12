"""
현금흐름표(旬×월) 집계 — 통장 거래(hyphen_bank_tx) − 내부거래.

사용자 지시(2026-10-12): "현금흐름 = 통장내역 − 내부거래. 旬(10일) 단위로 분류해서 넣는다."
旬 정의(시트 09_작성기준): 10일=1~10, 20일=11~20, 30일=21~말일.
각 거래를 현금흐름 라인으로 자동분류(규칙) → 화면에서 수동 재분류(cashflow_class 영속).
"""
from __future__ import annotations

import logging
from collections import defaultdict
from datetime import date
from typing import Any, Dict, List, Optional, Set, Tuple

from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.hyphen_bank_tx import HyphenBankTx
from app.models.cashflow import (
    CashflowClass, CashflowConfig,
    CF_LINES, CF_LINE_KEYS, CF_LINE_LABEL, DEFAULT_IN_LINE, DEFAULT_OUT_LINE,
)

logger = logging.getLogger(__name__)

# 회사 자기명의 별칭(내부거래 판정 보조) — internal_transfers._COMPANY_ALIASES 와 동일 취지
_COMPANY_ALIASES = ("조인앤조인", "조인앤", "joinandjoin", "join&join", "(주)조인앤조인")

# ── 자동분류 키워드 규칙(출금) ──
_KW_FINANCING = ("이자", "대출", "차입", "상환", "원리금", "리스료", "배당")
_KW_TAX = ("법인세", "부가세", "부가가치세", "원천세", "지방소득세", "주민세", "국세", "세무서",
           "4대보험", "국민연금", "건강보험", "고용보험", "산재", "장기요양")
_KW_INVEST = ("설비", "기계", "취득", "증권매입", "예적금가입", "정기예금", "펀드")
_KW_INCOME_NONOP = ("환급", "이자입금", "배당금")


def xun_of(day: int) -> int:
    """일(day) → 旬 버킷(10/20/30)."""
    if day <= 10:
        return 10
    if day <= 20:
        return 20
    return 30


def _parse_trdate(s: str) -> Optional[date]:
    d = "".join(c for c in (s or "") if c.isdigit())
    if len(d) < 8:
        return None
    try:
        return date(int(d[0:4]), int(d[4:6]), int(d[6:8]))
    except ValueError:
        return None


def _last4(acct: Optional[str]) -> str:
    d = "".join(c for c in (acct or "") if c.isdigit())
    return d[-4:] if len(d) >= 4 else ""


def _is_internal(tx: HyphenBankTx, own_last4: Set[str]) -> bool:
    """내부거래 1차 판정(단건) — 상대계좌가 우리 보유계좌이거나, 적요/상대명에 회사 별칭 포함."""
    cp4 = _last4(tx.counterparty_acct)
    if cp4 and cp4 in own_last4:
        return True
    hay = f"{tx.tr_name or ''} {tx.counterparty_name or ''} {tx.memo or ''}".lower()
    return any(a.lower() in hay for a in _COMPANY_ALIASES)


def _acct_key(tx: HyphenBankTx) -> str:
    return (tx.acct_no or "") or (tx.acct_last4 or "") or "?"


def detect_internal(txs: List[HyphenBankTx], own_last4: Set[str]) -> Set[str]:
    """내부거래(계좌 간 자금이동) tx_hash 집합.

    상대계좌 필드가 비는 은행이 많아 단건판정(_is_internal)만으론 과소집계 →
    같은 날·같은 금액의 '우리 계좌 출금' ↔ '우리 다른 계좌 입금'을 1:1로 짝지어 쌍 제거.
    (대표 패턴: 매출풀→운영 메꿈 / 운영→매출풀 회수)
    """
    internal: Set[str] = set()
    outs: Dict[Tuple[date, int], List[HyphenBankTx]] = defaultdict(list)
    ins: Dict[Tuple[date, int], List[HyphenBankTx]] = defaultdict(list)
    for tx in txs:
        d = _parse_trdate(tx.tr_date)
        if not d:
            continue
        o = round(float(tx.out_amt or 0))
        i = round(float(tx.in_amt or 0))
        if o > 0:
            outs[(d, o)].append(tx)
        if i > 0:
            ins[(d, i)].append(tx)
    for key, olist in outs.items():
        ilist = ins.get(key)
        if not ilist:
            continue
        for otx in olist:
            if otx.dedup_hash in internal:
                continue
            for itx in ilist:
                if itx.dedup_hash in internal:
                    continue
                # 서로 다른 우리 계좌 간 이동만 내부거래로
                if _acct_key(otx) != _acct_key(itx):
                    internal.add(otx.dedup_hash)
                    internal.add(itx.dedup_hash)
                    break
    # 단건 판정도 합집합
    for tx in txs:
        if _is_internal(tx, own_last4):
            internal.add(tx.dedup_hash)
    return internal


def _auto_line(tx: HyphenBankTx) -> str:
    """거래 → 현금흐름 라인 자동분류(규칙). 수동분류 없을 때만 사용."""
    in_amt = float(tx.in_amt or 0)
    out_amt = float(tx.out_amt or 0)
    hay = f"{tx.tr_name or ''} {tx.counterparty_name or ''} {tx.memo or ''}"
    if in_amt > 0 and in_amt >= out_amt:
        if any(k in hay for k in _KW_INCOME_NONOP):
            return "non_op_in"
        return DEFAULT_IN_LINE  # op_income
    # 출금
    if any(k in hay for k in _KW_FINANCING):
        return "financing"
    if any(k in hay for k in _KW_TAX):
        return "non_op_out"
    if any(k in hay for k in _KW_INVEST):
        return "investing"
    return DEFAULT_OUT_LINE  # op_sga


async def _own_last4(db: AsyncSession) -> Set[str]:
    """우리 보유계좌 last4 집합 — hyphen_bank_tx 에 존재하는 자기계좌(동기화 대상)."""
    rows = (await db.execute(select(func.distinct(HyphenBankTx.acct_last4)))).scalars().all()
    out: Set[str] = set()
    for r in rows:
        f = _last4(r)
        if f:
            out.add(f)
    return out


async def _load_classes(db: AsyncSession, hashes: List[str]) -> Dict[str, str]:
    if not hashes:
        return {}
    out: Dict[str, str] = {}
    CH = 1000
    for i in range(0, len(hashes), CH):
        chunk = hashes[i:i + CH]
        rows = (await db.execute(
            select(CashflowClass.tx_hash, CashflowClass.cf_line)
            .where(CashflowClass.tx_hash.in_(chunk))
        )).all()
        for h, line in rows:
            if line in CF_LINE_KEYS:
                out[h] = line
    return out


async def _opening_balance(db: AsyncSession, year: int, txs: List[HyphenBankTx]) -> Tuple[float, bool]:
    """연초 기초잔액. config 수동보정 우선, 없으면 계좌별 연초 첫거래 balance 역산 합산."""
    cfg = (await db.execute(
        select(CashflowConfig).where(CashflowConfig.year == year)
    )).scalar_one_or_none()
    if cfg and cfg.opening_balance is not None:
        return float(cfg.opening_balance), True
    # 역산: 계좌별 연내 첫 거래의 balance − (그 거래 순증감)
    first_by_acct: Dict[str, HyphenBankTx] = {}
    for tx in txs:
        d = _parse_trdate(tx.tr_date)
        if not d:
            continue
        key = tx.acct_no or tx.acct_last4 or "?"
        cur = first_by_acct.get(key)
        if cur is None or (_parse_trdate(cur.tr_date) or date.max) > d:
            first_by_acct[key] = tx
    total = 0.0
    ok = True
    for tx in first_by_acct.values():
        if tx.balance is None:
            ok = False
            continue
        net = float(tx.in_amt or 0) - float(tx.out_amt or 0)
        total += float(tx.balance) - net
    return total, ok


async def build_pivot(db: AsyncSession, year: int) -> Dict[str, Any]:
    """연도 현금흐름 피벗 — 라인 × (월×旬) in/out, 旬별 순증감·기말잔액."""
    txs = (await db.execute(
        select(HyphenBankTx).where(HyphenBankTx.tr_date.like(f"{year}%"))
    )).scalars().all()

    classes = await _load_classes(db, [t.dedup_hash for t in txs])
    own4 = await _own_last4(db)
    internal_hashes = detect_internal(txs, own4)

    # cells[line]["M-X"] = {"in": , "out": }
    cells: Dict[str, Dict[str, Dict[str, float]]] = {k: {} for k in CF_LINE_KEYS}
    # 旬 순증감 net["M-X"], 내부거래/미인식 카운트
    net: Dict[str, float] = {}
    internal_ct = 0
    used = 0

    for tx in txs:
        d = _parse_trdate(tx.tr_date)
        if not d or d.year != year:
            continue
        if tx.dedup_hash in internal_hashes:
            internal_ct += 1
            continue
        line = classes.get(tx.dedup_hash) or _auto_line(tx)
        if line not in cells:
            line = "uncat"
        bucket = f"{d.month}-{xun_of(d.day)}"
        cell = cells[line].setdefault(bucket, {"in": 0.0, "out": 0.0})
        i = float(tx.in_amt or 0)
        o = float(tx.out_amt or 0)
        cell["in"] += i
        cell["out"] += o
        net[bucket] = net.get(bucket, 0.0) + (i - o)
        used += 1

    opening, opening_ok = await _opening_balance(db, year, txs)

    # 旬 순서대로 running balance(기말잔액)
    buckets_order = [f"{m}-{x}" for m in range(1, 13) for x in (10, 20, 30)]
    running = opening
    closing: Dict[str, float] = {}
    net_full: Dict[str, float] = {}
    for b in buckets_order:
        n = net.get(b, 0.0)
        net_full[b] = n
        running += n
        closing[b] = running

    return {
        "year": year,
        "lines": [{"key": k, "label": CF_LINE_LABEL[k], "dir": d} for k, _, d in CF_LINES],
        "buckets": buckets_order,
        "cells": cells,
        "net": net_full,
        "closing": closing,
        "opening": opening,
        "opening_estimated": not opening_ok,
        "tx_used": used,
        "internal_excluded": internal_ct,
    }


async def list_bucket_txs(
    db: AsyncSession, year: int, month: int, xun: int, line: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """특정 (월·旬) 거래 목록 + 현재 분류(수동/자동) — 재분류 UI용."""
    txs = (await db.execute(
        select(HyphenBankTx).where(HyphenBankTx.tr_date.like(f"{year}%"))
    )).scalars().all()
    classes = await _load_classes(db, [t.dedup_hash for t in txs])
    own4 = await _own_last4(db)
    internal_hashes = detect_internal(txs, own4)
    out = []
    for tx in txs:
        d = _parse_trdate(tx.tr_date)
        if not d or d.year != year or d.month != month or xun_of(d.day) != xun:
            continue
        if tx.dedup_hash in internal_hashes:
            continue
        manual = classes.get(tx.dedup_hash)
        cur = manual or _auto_line(tx)
        if line and cur != line:
            continue
        out.append({
            "tx_hash": tx.dedup_hash,
            "date": d.isoformat(),
            "acct_last4": tx.acct_last4,
            "name": tx.tr_name or tx.counterparty_name or "(미지정)",
            "in_amt": float(tx.in_amt or 0),
            "out_amt": float(tx.out_amt or 0),
            "cf_line": cur,
            "cf_line_label": CF_LINE_LABEL.get(cur, cur),
            "source": "manual" if manual else "auto",
        })
    out.sort(key=lambda r: (r["date"], -(r["in_amt"] + r["out_amt"])))
    return out


async def set_class(db: AsyncSession, tx_hash: str, cf_line: str, cf_sub: Optional[str],
                    updated_by: Optional[str]) -> None:
    if cf_line not in CF_LINE_KEYS:
        raise ValueError(f"unknown cf_line: {cf_line}")
    row = (await db.execute(
        select(CashflowClass).where(CashflowClass.tx_hash == tx_hash)
    )).scalar_one_or_none()
    if row is None:
        row = CashflowClass(tx_hash=tx_hash)
        db.add(row)
    row.cf_line = cf_line
    row.cf_sub = cf_sub
    row.source = "manual"
    row.updated_by = updated_by
    await db.commit()


async def set_opening(db: AsyncSession, year: int, opening_balance: Optional[float]) -> None:
    row = (await db.execute(
        select(CashflowConfig).where(CashflowConfig.year == year)
    )).scalar_one_or_none()
    if row is None:
        row = CashflowConfig(year=year)
        db.add(row)
    row.opening_balance = opening_balance
    await db.commit()
