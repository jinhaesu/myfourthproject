"""
위하고/더존 분개장 import → Voucher 일괄 변환.

위하고 분개장은 이미 차변/대변까지 완성된 분개 데이터이므로,
ai_raw(학습용 원천)가 아니라 Voucher(확정 전표)로 격상해야 한다.

그룹핑 키: (upload_id, transaction_date, original_description, merchant_name)
  → 같은 그룹의 ai_raw 행들을 묶어 1 Voucher (n-line) 생성.

각 ai_raw 행:
  - source_account_code = 본 계정 코드 (분개의 한 라인)
  - debit_amount > 0  → 그 라인은 차변
  - credit_amount > 0 → 그 라인은 대변
"""
from __future__ import annotations

import asyncio
import logging
import re
import time
from collections import defaultdict
from datetime import date, datetime
from decimal import Decimal
from typing import Optional, Dict, Any, List, Tuple

from sqlalchemy import select, and_, func, case, Integer, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import async_session_factory
from app.services.auto_voucher_service import _new_task, _update

from app.models.accounting import (
    Voucher, VoucherLine, VoucherStatus, TransactionType, Account, AccountCategory,
)
from app.models.ai import AIRawTransactionData, AIDataUploadHistory
from app.models.user import User, Department

logger = logging.getLogger(__name__)


def _parse_iso_date(s: Any) -> Optional[date]:
    if not s:
        return None
    if isinstance(s, date):
        return s
    s = str(s).strip()
    m = re.match(r'(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})', s)
    if not m:
        return None
    try:
        return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    except ValueError:
        return None


async def _resolve_account_id_cached(
    db: AsyncSession,
    code: str,
    name: str,
    cache: Dict[str, int],
) -> Optional[int]:
    """account_code → accounts.id (없으면 자동 생성). cache로 동일 코드 반복 lookup 회피."""
    if not code:
        return None
    if code in cache:
        return cache[code]
    acc = (await db.execute(
        select(Account).where(Account.code == code, Account.is_active == True)
    )).scalar_one_or_none()
    if acc:
        cache[code] = acc.id
        return acc.id

    # 자동 생성
    first = code.lstrip("0")[:1] if code else "9"
    cat_code_map = {'1': '1', '2': '2', '3': '3', '4': '4', '5': '5',
                    '6': '5', '7': '5', '8': '5', '9': '5'}
    cat_code = cat_code_map.get(first, '5')
    cat = (await db.execute(
        select(AccountCategory).where(AccountCategory.code == cat_code)
    )).scalar_one_or_none()
    if not cat:
        cat = (await db.execute(select(AccountCategory).limit(1))).scalar_one_or_none()
    if not cat:
        return None
    new_acc = Account(
        code=code, name=name or f"계정 {code}",
        category_id=cat.id, level=1, is_detail=True,
        is_vat_applicable=True, vat_rate=Decimal("10.00"), is_active=True,
    )
    db.add(new_acc)
    await db.flush()
    cache[code] = new_acc.id
    return new_acc.id


async def _next_voucher_number(db: AsyncSession, vdate: date, counter: Dict[str, int]) -> str:
    """일자별 시퀀스. 일괄 처리 시 in-memory counter로 가속."""
    prefix = vdate.strftime('%Y%m%d')
    if prefix not in counter:
        cnt = await db.scalar(
            select(func.count(Voucher.id)).where(Voucher.voucher_number.like(f"{prefix}-%"))
        ) or 0
        counter[prefix] = cnt
    counter[prefix] += 1
    return f"{prefix}-{counter[prefix]:04d}"


async def _find_journal_upload_ids(
    db: AsyncSession, only_ids: Optional[List[int]] = None,
    min_journal_rows: int = 5,
) -> List[int]:
    """
    "분개장 데이터를 보유한 업로드" 식별 — upload_type 무관.

    기준: ai_raw 행 중 (debit_amount > 0 OR credit_amount > 0) AND account_code 채워짐.
    이 조건을 만족하는 행이 ≥ min_journal_rows건인 업로드만 분개장으로 본다.

    source_account_code는 _account_name_to_code 매핑 실패 시 비어있을 수 있으므로
    필수 조건에서 제외 (실제 분개 변환 시점에 account_code/source_account_code 둘 다 시도).
    """
    q = (
        select(
            AIRawTransactionData.upload_id,
            func.count(AIRawTransactionData.id).label("cnt"),
        )
        .where(
            AIRawTransactionData.account_code.isnot(None),
            AIRawTransactionData.account_code != "",
            (AIRawTransactionData.debit_amount > 0) | (AIRawTransactionData.credit_amount > 0),
        )
        .group_by(AIRawTransactionData.upload_id)
    )
    if only_ids:
        q = q.where(AIRawTransactionData.upload_id.in_(only_ids))
    rows = (await db.execute(q)).all()
    return [r.upload_id for r in rows if (r.cnt or 0) >= min_journal_rows]


async def diagnose_journal_data(
    db: AsyncSession, upload_id: Optional[int] = None,
) -> Dict[str, Any]:
    """
    ai_raw 진단 — 어떤 컬럼이 어떻게 채워졌는지 업로드별 통계.
    분개장 식별이 왜 실패하는지 디버깅용.
    """
    debit_flag = case((AIRawTransactionData.debit_amount > 0, 1), else_=0)
    credit_flag = case((AIRawTransactionData.credit_amount > 0, 1), else_=0)
    src_filled_flag = case(
        (
            and_(
                AIRawTransactionData.source_account_code.isnot(None),
                AIRawTransactionData.source_account_code != "",
            ),
            1,
        ),
        else_=0,
    )

    stat_q = (
        select(
            AIRawTransactionData.upload_id,
            func.count(AIRawTransactionData.id).label("total"),
            func.count(AIRawTransactionData.account_code).label("acc_code_cnt"),
            func.sum(src_filled_flag).label("src_code_cnt"),
            func.count(AIRawTransactionData.transaction_date).label("date_cnt"),
            func.sum(debit_flag).label("debit_cnt"),
            func.sum(credit_flag).label("credit_cnt"),
        )
        .group_by(AIRawTransactionData.upload_id)
        .order_by(AIRawTransactionData.upload_id.desc())
    )
    if upload_id is not None:
        stat_q = stat_q.where(AIRawTransactionData.upload_id == upload_id)
    stat_rows = (await db.execute(stat_q)).all()

    # 업로드 메타 join
    upload_q = select(
        AIDataUploadHistory.id,
        AIDataUploadHistory.filename,
        AIDataUploadHistory.upload_type,
        AIDataUploadHistory.row_count,
    )
    if upload_id is not None:
        upload_q = upload_q.where(AIDataUploadHistory.id == upload_id)
    uploads = {u.id: u for u in (await db.execute(upload_q)).all()}

    # 샘플 행 (디버깅용 — 첫 3행)
    sample_rows = []
    if upload_id is not None:
        sample_q = (
            select(AIRawTransactionData)
            .where(AIRawTransactionData.upload_id == upload_id)
            .order_by(AIRawTransactionData.row_number)
            .limit(5)
        )
        for r in (await db.execute(sample_q)).scalars().all():
            sample_rows.append({
                "row_number": r.row_number,
                "transaction_date": r.transaction_date,
                "original_description": r.original_description[:50] if r.original_description else None,
                "merchant_name": r.merchant_name,
                "account_code": r.account_code,
                "account_name": r.account_name,
                "source_account_code": r.source_account_code,
                "source_account_name": r.source_account_name,
                "debit_amount": str(r.debit_amount),
                "credit_amount": str(r.credit_amount),
            })

    result = []
    for s in stat_rows:
        u = uploads.get(s.upload_id)
        result.append({
            "upload_id": s.upload_id,
            "filename": u.filename if u else None,
            "upload_type": u.upload_type if u else None,
            "history_row_count": u.row_count if u else None,
            "ai_raw_total": s.total or 0,
            "account_code_filled": s.acc_code_cnt or 0,
            "source_account_code_filled": s.src_code_cnt or 0,
            "transaction_date_filled": s.date_cnt or 0,
            "rows_with_debit": int(s.debit_cnt or 0),
            "rows_with_credit": int(s.credit_cnt or 0),
            "is_journal_by_account_code": (s.acc_code_cnt or 0) >= 5 and (int(s.debit_cnt or 0) + int(s.credit_cnt or 0)) >= 5,
            "is_journal_by_source_code": (s.src_code_cnt or 0) >= 5 and (int(s.debit_cnt or 0) + int(s.credit_cnt or 0)) >= 5,
        })

    return {
        "uploads": result,
        "sample_rows": sample_rows if upload_id is not None else None,
    }


async def _ensure_base_data() -> tuple[int, int]:
    """
    부서·사용자 시드를 별도 connection/트랜잭션에서 보장 (raw SQL + ON CONFLICT).

    이유: 호출 측 트랜잭션 안에서 INSERT departments 하면 Supabase의 8s statement_timeout +
    이전 트랜잭션의 lock 잔여물 때문에 QueryCanceledError 발생.
    별도 connection은 fresh lock context → 안전하게 시드 가능.

    반환: (department_id, user_id)
    """
    from app.core.database import engine

    async with engine.begin() as conn:
        # 이 connection의 statement timeout을 1분으로 늘림 (Supabase 기본값 무시)
        try:
            await conn.execute(text("SET LOCAL statement_timeout = '60000'"))
        except Exception:
            pass  # Supabase가 SET LOCAL 막을 수도 있으므로 best-effort

        # 부서 보장
        await conn.execute(text("""
            INSERT INTO departments (code, name, level, sort_order, is_active, created_at, updated_at)
            VALUES ('DEFAULT', '기본 부서', 1, 0, true, NOW(), NOW())
            ON CONFLICT (code) DO NOTHING
        """))
        dept_id = (await conn.execute(
            text("SELECT id FROM departments WHERE is_active = true ORDER BY id LIMIT 1")
        )).scalar()
        if not dept_id:
            # 최후 폴백 — is_active 무시
            dept_id = (await conn.execute(
                text("SELECT id FROM departments ORDER BY id LIMIT 1")
            )).scalar()

        # 사용자 보장 — 가장 먼저 만들어진 1명 사용. 없으면 시스템 계정 생성.
        user_id = (await conn.execute(
            text("SELECT id FROM users ORDER BY id LIMIT 1")
        )).scalar()
        if not user_id:
            await conn.execute(text("""
                INSERT INTO users
                  (employee_id, email, username, hashed_password, full_name, is_active, is_superuser,
                   failed_login_attempts, two_factor_enabled, created_at, updated_at)
                VALUES
                  ('SYSTEM', 'system@smartfinance.local', 'system', '!disabled!',
                   'System (자동생성)', true, false, 0, false, NOW(), NOW())
                ON CONFLICT (email) DO NOTHING
            """))
            user_id = (await conn.execute(
                text("SELECT id FROM users WHERE email = 'system@smartfinance.local'")
            )).scalar()

    if not dept_id or not user_id:
        raise RuntimeError(f"기초 데이터 시드 실패 (dept_id={dept_id}, user_id={user_id})")
    return dept_id, user_id


async def migrate_journal_uploads_to_vouchers(
    db: AsyncSession,
    upload_ids: Optional[List[int]] = None,
    start_date: Optional[date] = None,
    end_date: Optional[date] = None,
    user_id: Optional[int] = None,
    department_id: Optional[int] = None,
    source_label: str = "wehago_import",
    task_id: Optional[str] = None,
    commit_every: int = 50,
) -> Dict[str, Any]:
    """
    위하고/더존 분개장 업로드 → Voucher(CONFIRMED) 일괄 변환.

    필터:
      - upload_ids: 특정 업로드만 대상 (없으면 모든 분개장 업로드)
      - start_date/end_date: ai_raw.transaction_date 기간 필터

    동일 (upload_id, transaction_date, description, merchant_name) 그룹의 모든 ai_raw 행 → 1 Voucher.
    이미 마이그레이션된 그룹(Voucher.external_ref 매칭)은 skip — idempotent.

    "분개장" 판정: upload_type이 아니라 ai_raw 데이터에 분개 정보가 있는지로 자동 감지.
    upload-historical 경로로 들어온 위하고 분개장도 잡힌다.
    """
    # 0) FK 보장: 부서·사용자 시드를 별도 connection에서 처리 후 검증
    seeded_dept_id, seeded_user_id = await _ensure_base_data()

    effective_department_id = department_id
    if effective_department_id is None:
        effective_department_id = seeded_dept_id
    else:
        exists = await db.scalar(
            select(Department.id).where(Department.id == effective_department_id)
        )
        if not exists:
            effective_department_id = seeded_dept_id

    effective_user_id = user_id
    if effective_user_id is None:
        effective_user_id = seeded_user_id
    else:
        exists = await db.scalar(
            select(User.id).where(User.id == effective_user_id)
        )
        if not exists:
            effective_user_id = seeded_user_id

    # 1) 대상 업로드 선정 — 분개 정보 보유 업로드 자동 감지
    target_upload_ids = await _find_journal_upload_ids(db, only_ids=upload_ids)

    if not target_upload_ids:
        return {
            "migrated_count": 0, "skipped_count": 0, "error_count": 0,
            "voucher_ids": [], "errors": [],
            "message": "대상 분개장 업로드 없음",
        }

    # 2) ai_raw 행 로드 (필터 적용)
    rq = select(AIRawTransactionData).where(
        AIRawTransactionData.upload_id.in_(target_upload_ids),
    ).order_by(
        AIRawTransactionData.upload_id, AIRawTransactionData.row_number,
    )
    rows = (await db.execute(rq)).scalars().all()

    if start_date or end_date:
        def _row_in_period(r: AIRawTransactionData) -> bool:
            d = _parse_iso_date(r.transaction_date)
            if not d:
                return False
            if start_date and d < start_date:
                return False
            if end_date and d > end_date:
                return False
            return True
        rows = [r for r in rows if _row_in_period(r)]

    if not rows:
        return {
            "migrated_count": 0, "skipped_count": 0, "error_count": 0,
            "voucher_ids": [], "errors": [],
            "message": "기간 내 분개장 데이터 없음",
        }

    # 3) 그룹핑 — row_number 순서로 누적해 차변=대변 도달 시 한 분개로 마감
    #    위하고 _parse_journal()의 _flush()가 한 분개를 연속 행으로 출력하므로
    #    이 패턴이 가장 정확. description fallback 차이 문제 회피.
    groups: Dict[Tuple, List[AIRawTransactionData]] = {}
    # upload_id 별로 정렬
    rows_by_upload: Dict[int, List[AIRawTransactionData]] = defaultdict(list)
    for r in rows:
        if _parse_iso_date(r.transaction_date):
            rows_by_upload[r.upload_id].append(r)
    for uid in rows_by_upload:
        rows_by_upload[uid].sort(key=lambda x: x.row_number or 0)

    group_seq = 0
    for upload_id_grp, urs in rows_by_upload.items():
        current: List[AIRawTransactionData] = []
        cur_d = Decimal("0")
        cur_c = Decimal("0")
        cur_date = None
        for r in urs:
            d = _parse_iso_date(r.transaction_date)
            # 날짜 바뀌면 이전 그룹 강제 마감 (불완전해도 errors로 처리)
            if cur_date is not None and d != cur_date and current:
                group_seq += 1
                key = (upload_id_grp, cur_date.isoformat() if cur_date else "0000-00-00", group_seq)
                groups[key] = current
                current = []
                cur_d = Decimal("0")
                cur_c = Decimal("0")
            cur_date = d
            current.append(r)
            cur_d += Decimal(str(r.debit_amount or 0))
            cur_c += Decimal(str(r.credit_amount or 0))
            # 차변=대변 도달 + 둘 다 > 0 → 한 분개 완성
            if cur_d > 0 and cur_d == cur_c:
                group_seq += 1
                key = (upload_id_grp, d.isoformat(), group_seq)
                groups[key] = current
                current = []
                cur_d = Decimal("0")
                cur_c = Decimal("0")
        # 잔여 (불완전 분개)
        if current:
            group_seq += 1
            key = (upload_id_grp, (cur_date.isoformat() if cur_date else "0000-00-00"), group_seq)
            groups[key] = current

    # 4) 이미 마이그레이션된 그룹 확인 (external_ref 기준)
    existing_refs_q = select(Voucher.external_ref).where(
        Voucher.source == source_label,
        Voucher.external_ref.isnot(None),
    )
    existing_refs = {r[0] for r in (await db.execute(existing_refs_q)).all() if r[0]}

    migrated_count = 0
    skipped_count = 0
    error_count = 0
    voucher_ids: List[int] = []
    errors: List[Dict[str, Any]] = []

    account_cache: Dict[str, int] = {}
    voucher_no_counter: Dict[str, int] = {}

    def _report(pct: int, msg: str, extra: Optional[Dict[str, Any]] = None):
        if task_id:
            payload = {"percent": pct, "message": msg}
            if extra:
                payload.update(extra)
            _update(task_id, **payload)

    _report(10, f"{len(groups)}개 분개 그룹 처리 시작…")

    # 5) 그룹별 Voucher 생성 — 청크 단위로 commit
    processed = 0
    total_groups = len(groups)
    for key, grp in groups.items():
        upload_id, date_iso, group_seq = key
        # 그룹 내 첫 행에서 description/merchant 추출 (전체 그룹이 공유한다는 가정)
        first = grp[0]
        desc = (first.original_description or "")[:200] if first else ""
        merchant = (first.merchant_name or "")[:200] if first else ""
        # 그룹 내 모든 행을 식별 가능한 안정적인 ext_ref
        ext_ref = f"journal:upload:{upload_id}:{date_iso}:seq{group_seq}"
        if ext_ref in existing_refs:
            skipped_count += 1
            processed += 1
            continue

        # 그룹별로 savepoint를 열어 부분 실패해도 다음 그룹 진행 가능하게
        savepoint = await db.begin_nested()
        try:
            vdate = date.fromisoformat(date_iso)
            total_debit = Decimal("0")
            total_credit = Decimal("0")
            line_specs: List[Dict[str, Any]] = []

            for r in grp:
                debit_amt = Decimal(str(r.debit_amount or 0))
                credit_amt = Decimal(str(r.credit_amount or 0))
                # source_account_code = 본 계정 (분개장 파서가 그렇게 저장)
                acc_code = (r.source_account_code or r.account_code or "").strip()
                acc_name = (r.source_account_name or r.account_name or "").strip()
                if not acc_code:
                    continue
                # 5자리 이상 거래처 코드는 계정 코드가 아님 - skip
                if acc_code.isdigit() and len(acc_code) >= 5:
                    continue

                if debit_amt > 0:
                    total_debit += debit_amt
                    line_specs.append({
                        "side": "debit", "account_code": acc_code, "account_name": acc_name,
                        "amount": debit_amt,
                    })
                if credit_amt > 0:
                    total_credit += credit_amt
                    line_specs.append({
                        "side": "credit", "account_code": acc_code, "account_name": acc_name,
                        "amount": credit_amt,
                    })

            if not line_specs:
                await savepoint.rollback()
                error_count += 1
                errors.append({"group": list(key), "reason": "유효한 라인 없음"})
                continue

            if total_debit != total_credit:
                await savepoint.rollback()
                error_count += 1
                errors.append({
                    "group": list(key),
                    "reason": f"차변({total_debit}) ≠ 대변({total_credit})",
                })
                continue

            voucher = Voucher(
                voucher_number=await _next_voucher_number(db, vdate, voucher_no_counter),
                voucher_date=vdate,
                transaction_date=vdate,
                description=(desc or merchant or "위하고 분개장 import")[:500],
                transaction_type=TransactionType.GENERAL,
                external_ref=ext_ref,
                source=source_label,
                department_id=effective_department_id,
                created_by=effective_user_id,
                total_debit=total_debit,
                total_credit=total_credit,
                status=VoucherStatus.CONFIRMED,
                merchant_name=merchant or None,
                confirmed_at=datetime.utcnow(),
                confirmed_by=effective_user_id,
            )
            db.add(voucher)
            await db.flush()  # voucher.id 확보

            line_no = 1
            for spec in line_specs:
                account_id = await _resolve_account_id_cached(
                    db, spec["account_code"], spec["account_name"], account_cache,
                )
                if account_id is None:
                    raise ValueError(f"계정 매핑 실패: code={spec['account_code']}")
                is_debit = spec["side"] == "debit"
                amt = spec["amount"]
                vat_acc = spec["account_code"] in ("135", "255")
                db.add(VoucherLine(
                    voucher_id=voucher.id,
                    line_number=line_no,
                    account_id=account_id,
                    debit_amount=amt if is_debit else Decimal("0"),
                    credit_amount=amt if not is_debit else Decimal("0"),
                    vat_amount=amt if vat_acc else Decimal("0"),
                    supply_amount=amt if not vat_acc else Decimal("0"),
                    description=desc[:500] if desc else None,
                    counterparty_name=merchant or None,
                ))
                line_no += 1

            await savepoint.commit()
            voucher_ids.append(voucher.id)
            migrated_count += 1

        except Exception as e:
            try:
                await savepoint.rollback()
            except Exception:
                pass
            logger.exception(f"분개장 → Voucher 변환 실패 (group={key})")
            error_count += 1
            errors.append({"group": list(key), "reason": str(e)[:200]})

        processed += 1
        # 청크 단위 commit — 8,000+ 그룹도 안정적으로 처리
        if processed % commit_every == 0:
            commit_failed = False
            try:
                await db.commit()
            except Exception as commit_err:
                commit_failed = True
                logger.exception("청크 commit 실패")
                errors.append({"group": ["__commit__"], "reason": f"commit 실패: {str(commit_err)[:200]}"})
                # 세션이 invalid 상태일 수 있으므로 rollback 시도
                try:
                    await db.rollback()
                except Exception:
                    pass
            pct = 10 + int(80 * processed / max(total_groups, 1))
            recent_errors = [e["reason"] for e in errors[-5:]]
            _report(
                pct,
                f"진행 {processed}/{total_groups} — 변환 {migrated_count}건"
                + (" (commit 실패)" if commit_failed else ""),
                {
                    "migrated_count": migrated_count,
                    "error_count": error_count,
                    "skipped_count": skipped_count,
                    "recent_errors": recent_errors,
                },
            )

    # 마지막 commit
    await db.commit()
    _report(95, f"완료 직전 — 변환 {migrated_count}건")

    return {
        "migrated_count": migrated_count,
        "skipped_count": skipped_count,
        "error_count": error_count,
        "voucher_ids": voucher_ids[:200],  # 응답 크기 제한
        "errors": errors[:20],
        "total_groups": len(groups),
        "target_uploads": len(target_upload_ids),
    }


async def migrate_journal_uploads_background(
    upload_ids: Optional[List[int]] = None,
    start_date: Optional[date] = None,
    end_date: Optional[date] = None,
    user_id: Optional[int] = None,
    department_id: Optional[int] = None,
    source_label: str = "wehago_import",
) -> str:
    """
    백그라운드 task로 분개장 변환. task_id 즉시 반환.
    호출자는 /auto-voucher/progress/{task_id}로 폴링.
    """
    task_id = _new_task("위하고 분개장 → 전표 변환 시작…")

    async def _runner():
        try:
            async with async_session_factory() as db:
                result = await migrate_journal_uploads_to_vouchers(
                    db,
                    upload_ids=upload_ids,
                    start_date=start_date,
                    end_date=end_date,
                    user_id=user_id,
                    department_id=department_id,
                    source_label=source_label,
                    task_id=task_id,
                )
                _update(
                    task_id, status="completed", percent=100,
                    message=f"완료 — {result.get('migrated_count', 0)}건 변환",
                    result=result, finished_at=time.time(),
                )
        except Exception as e:
            logger.exception("백그라운드 분개장 변환 실패")
            _update(
                task_id, status="failed",
                message=f"실패: {str(e)[:300]}",
                finished_at=time.time(),
            )

    asyncio.create_task(_runner())
    return task_id


async def list_journal_uploads(db: AsyncSession) -> List[Dict[str, Any]]:
    """
    분개장 데이터를 보유한 업로드 목록 — 모달 선택용.

    upload_type 무관. ai_raw 행 중 분개 정보(debit/credit + source_account_code)가
    있는 업로드만 노출 → upload-historical 경로로 들어온 위하고 분개장도 보임.
    """
    journal_ids = await _find_journal_upload_ids(db)
    if not journal_ids:
        return []

    # 각 분개장 업로드별 메타 + 분개 행 수
    q = (
        select(
            AIDataUploadHistory.id,
            AIDataUploadHistory.filename,
            AIDataUploadHistory.row_count,
            AIDataUploadHistory.created_at,
            AIDataUploadHistory.upload_type,
            AIDataUploadHistory.file_type,
        )
        .where(AIDataUploadHistory.id.in_(journal_ids))
        .order_by(AIDataUploadHistory.created_at.desc())
    )
    rows = (await db.execute(q)).all()

    # 분개 행 수 카운트 (별도 쿼리) — _find_journal_upload_ids와 동일 기준
    journal_row_q = (
        select(
            AIRawTransactionData.upload_id,
            func.count(AIRawTransactionData.id).label("journal_rows"),
            func.min(AIRawTransactionData.transaction_date).label("min_date"),
            func.max(AIRawTransactionData.transaction_date).label("max_date"),
        )
        .where(
            AIRawTransactionData.upload_id.in_(journal_ids),
            AIRawTransactionData.account_code.isnot(None),
            AIRawTransactionData.account_code != "",
            (AIRawTransactionData.debit_amount > 0) | (AIRawTransactionData.credit_amount > 0),
        )
        .group_by(AIRawTransactionData.upload_id)
    )
    stat_rows = (await db.execute(journal_row_q)).all()
    stat_map = {r.upload_id: r for r in stat_rows}

    # 이미 변환된 그룹 수 — Voucher.external_ref 기반
    refs_q = select(Voucher.external_ref).where(
        Voucher.source.in_(["wehago_import", "douzone_journal"]),
        Voucher.external_ref.like("journal:upload:%"),
    )
    refs = [r[0] for r in (await db.execute(refs_q)).all() if r[0]]
    migrated_per_upload: Dict[int, int] = defaultdict(int)
    for ref in refs:
        # journal:upload:{upload_id}:...
        parts = ref.split(":")
        if len(parts) >= 3 and parts[1] == "upload":
            try:
                migrated_per_upload[int(parts[2])] += 1
            except ValueError:
                pass

    return [
        {
            "id": r.id,
            "filename": r.filename,
            "row_count": r.row_count,
            "journal_rows": (stat_map.get(r.id).journal_rows if stat_map.get(r.id) else 0),
            "min_date": (stat_map.get(r.id).min_date if stat_map.get(r.id) else None),
            "max_date": (stat_map.get(r.id).max_date if stat_map.get(r.id) else None),
            "migrated_vouchers": migrated_per_upload.get(r.id, 0),
            "created_at": r.created_at.isoformat() if r.created_at else None,
            "upload_type": r.upload_type,
            "file_type": r.file_type,
        }
        for r in rows
    ]
