"""
Smart Finance Core - Data Import/Export API
데이터 가져오기/내보내기 API 엔드포인트 (엑셀 등)
"""
import io
from datetime import datetime
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, status, UploadFile, File, Query
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
import pandas as pd

from app.core.database import get_db
from app.models.accounting import Voucher, VoucherLine, Account
from app.models.user import User, Department

router = APIRouter()


@router.post("/vouchers/upload")
async def upload_vouchers_excel(
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db)
):
    """
    엑셀 파일에서 전표 데이터 업로드

    엑셀 컬럼 형식:
    - 전표일자 (YYYY-MM-DD)
    - 거래일자 (YYYY-MM-DD)
    - 적요
    - 거래처명
    - 차변금액
    - 대변금액
    - 계정코드
    - 부서코드
    """
    if not file.filename.endswith(('.xlsx', '.xls')):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="엑셀 파일(.xlsx, .xls)만 업로드 가능합니다."
        )

    try:
        contents = await file.read()
        df = pd.read_excel(io.BytesIO(contents))

        # 필수 컬럼 확인
        required_columns = ['전표일자', '거래일자', '적요', '차변금액', '대변금액', '계정코드']
        missing_columns = [col for col in required_columns if col not in df.columns]

        if missing_columns:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"필수 컬럼이 누락되었습니다: {', '.join(missing_columns)}"
            )

        # 계정과목 조회
        accounts_result = await db.execute(select(Account))
        accounts = {acc.code: acc.id for acc in accounts_result.scalars().all()}

        # 부서 조회
        depts_result = await db.execute(select(Department))
        depts = {dept.code: dept.id for dept in depts_result.scalars().all()}

        # 기본 사용자 (첫 번째 관리자)
        user_result = await db.execute(
            select(User).where(User.is_superuser == True).limit(1)
        )
        default_user = user_result.scalar_one_or_none()

        if not default_user:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="관리자 계정이 없습니다."
            )

        # 기본 부서
        default_dept_result = await db.execute(
            select(Department).where(Department.code == "HQ").limit(1)
        )
        default_dept = default_dept_result.scalar_one_or_none()

        created_vouchers = []
        errors = []

        for idx, row in df.iterrows():
            try:
                # 날짜 파싱
                voucher_date = pd.to_datetime(row['전표일자']).date()
                transaction_date = pd.to_datetime(row['거래일자']).date()

                # 계정코드 확인
                account_code = str(row['계정코드']).strip()
                if account_code not in accounts:
                    errors.append(f"행 {idx + 2}: 계정코드 '{account_code}'를 찾을 수 없습니다.")
                    continue

                # 부서코드 확인 (옵션)
                dept_id = default_dept.id if default_dept else None
                if '부서코드' in row and pd.notna(row['부서코드']):
                    dept_code = str(row['부서코드']).strip()
                    dept_id = depts.get(dept_code, dept_id)

                # 금액
                debit_amount = float(row['차변금액']) if pd.notna(row['차변금액']) else 0
                credit_amount = float(row['대변금액']) if pd.notna(row['대변금액']) else 0

                # 전표 번호 생성
                voucher_number = f"V{voucher_date.strftime('%Y%m%d')}{idx:04d}"

                # 전표 생성
                voucher = Voucher(
                    voucher_number=voucher_number,
                    voucher_date=voucher_date,
                    transaction_date=transaction_date,
                    description=str(row['적요']),
                    transaction_type="general",
                    department_id=dept_id,
                    created_by=default_user.id,
                    total_debit=debit_amount,
                    total_credit=credit_amount,
                    status="draft",
                    merchant_name=str(row['거래처명']) if '거래처명' in row and pd.notna(row['거래처명']) else None
                )
                db.add(voucher)
                await db.flush()  # ID 확보

                # 전표 라인 생성
                voucher_line = VoucherLine(
                    voucher_id=voucher.id,
                    line_number=1,
                    account_id=accounts[account_code],
                    debit_amount=debit_amount,
                    credit_amount=credit_amount,
                    vat_amount=0,
                    supply_amount=debit_amount if debit_amount > 0 else credit_amount,
                    description=str(row['적요']),
                    counterparty_name=str(row['거래처명']) if '거래처명' in row and pd.notna(row['거래처명']) else None
                )
                db.add(voucher_line)

                created_vouchers.append(voucher_number)

            except Exception as e:
                errors.append(f"행 {idx + 2}: {str(e)}")

        await db.commit()

        return {
            "message": f"{len(created_vouchers)}개 전표가 생성되었습니다.",
            "created_count": len(created_vouchers),
            "created_vouchers": created_vouchers[:20],  # 최대 20개만 표시
            "errors": errors[:10] if errors else []  # 최대 10개 에러만 표시
        }

    except pd.errors.EmptyDataError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="빈 파일입니다."
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"파일 처리 중 오류가 발생했습니다: {str(e)}"
        )


@router.get("/vouchers/download")
async def download_vouchers_excel(
    start_date: Optional[str] = Query(None, description="시작일 (YYYY-MM-DD)"),
    end_date: Optional[str] = Query(None, description="종료일 (YYYY-MM-DD)"),
    status_filter: Optional[str] = Query(None, description="상태 필터"),
    db: AsyncSession = Depends(get_db)
):
    """전표 데이터를 엑셀로 다운로드"""
    try:
        # 쿼리 생성
        query = select(Voucher).order_by(Voucher.voucher_date.desc())

        if start_date:
            start = datetime.strptime(start_date, "%Y-%m-%d").date()
            query = query.where(Voucher.voucher_date >= start)

        if end_date:
            end = datetime.strptime(end_date, "%Y-%m-%d").date()
            query = query.where(Voucher.voucher_date <= end)

        if status_filter:
            query = query.where(Voucher.status == status_filter)

        result = await db.execute(query)
        vouchers = result.scalars().all()

        # DataFrame 생성
        data = []
        for v in vouchers:
            data.append({
                "전표번호": v.voucher_number,
                "전표일자": v.voucher_date.strftime("%Y-%m-%d"),
                "거래일자": v.transaction_date.strftime("%Y-%m-%d"),
                "적요": v.description,
                "거래처명": v.merchant_name or "",
                "차변합계": float(v.total_debit),
                "대변합계": float(v.total_credit),
                "상태": v.status,
                "생성일시": v.created_at.strftime("%Y-%m-%d %H:%M:%S")
            })

        df = pd.DataFrame(data)

        # 엑셀 파일 생성
        output = io.BytesIO()
        with pd.ExcelWriter(output, engine='openpyxl') as writer:
            df.to_excel(writer, index=False, sheet_name='전표목록')

        output.seek(0)

        filename = f"vouchers_{datetime.now().strftime('%Y%m%d_%H%M%S')}.xlsx"

        return StreamingResponse(
            output,
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": f"attachment; filename={filename}"}
        )

    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"다운로드 중 오류가 발생했습니다: {str(e)}"
        )


@router.get("/vouchers/template")
async def download_vouchers_template():
    """전표 업로드용 템플릿 다운로드"""
    # 템플릿 데이터
    data = {
        "전표일자": ["2024-01-15", "2024-01-15"],
        "거래일자": ["2024-01-15", "2024-01-15"],
        "적요": ["1월 사무용품 구입", "1월 교통비"],
        "거래처명": ["알파문구", "택시"],
        "차변금액": [50000, 30000],
        "대변금액": [0, 0],
        "계정코드": ["510", "503"],
        "부서코드": ["DEV", "DEV"]
    }

    df = pd.DataFrame(data)

    output = io.BytesIO()
    with pd.ExcelWriter(output, engine='openpyxl') as writer:
        df.to_excel(writer, index=False, sheet_name='전표입력')

        # 설명 시트 추가
        instructions = pd.DataFrame({
            "컬럼명": ["전표일자", "거래일자", "적요", "거래처명", "차변금액", "대변금액", "계정코드", "부서코드"],
            "설명": [
                "전표가 기록되는 날짜 (YYYY-MM-DD)",
                "실제 거래가 발생한 날짜 (YYYY-MM-DD)",
                "거래 내용 설명",
                "거래처 이름 (선택)",
                "차변 금액",
                "대변 금액",
                "계정과목 코드 (예: 501=급여, 502=복리후생비)",
                "부서 코드 (예: DEV, FIN, HR)"
            ],
            "필수여부": ["필수", "필수", "필수", "선택", "필수", "필수", "필수", "선택"]
        })
        instructions.to_excel(writer, index=False, sheet_name='작성안내')

    output.seek(0)

    return StreamingResponse(
        output,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": "attachment; filename=voucher_template.xlsx"}
    )


@router.get("/accounts/download")
async def download_accounts_list(
    db: AsyncSession = Depends(get_db)
):
    """계정과목 목록 다운로드"""
    result = await db.execute(
        select(Account).where(Account.is_active == True).order_by(Account.code)
    )
    accounts = result.scalars().all()

    data = []
    for acc in accounts:
        data.append({
            "계정코드": acc.code,
            "계정명": acc.name,
            "키워드": acc.keywords or "",
            "대표가맹점": acc.common_merchants or ""
        })

    df = pd.DataFrame(data)

    output = io.BytesIO()
    with pd.ExcelWriter(output, engine='openpyxl') as writer:
        df.to_excel(writer, index=False, sheet_name='계정과목목록')

    output.seek(0)

    return StreamingResponse(
        output,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": "attachment; filename=accounts_list.xlsx"}
    )


@router.post("/historical-data/upload")
async def upload_historical_data(
    file: UploadFile = File(...),
    data_type: str = Query(..., description="데이터 유형 (vouchers, receivables, payables)"),
    db: AsyncSession = Depends(get_db)
):
    """
    과거 데이터 일괄 업로드

    - vouchers: 과거 전표 데이터
    - receivables: 과거 채권 데이터
    - payables: 과거 채무 데이터
    """
    if data_type == "vouchers":
        return await upload_vouchers_excel(file, db)

    # 다른 유형은 추후 구현
    raise HTTPException(
        status_code=status.HTTP_501_NOT_IMPLEMENTED,
        detail=f"'{data_type}' 데이터 유형은 아직 지원되지 않습니다."
    )
