# Smart Finance Core

## AI 기반 능동형 회계/재무 관리 플랫폼

기존 회계 시스템의 한계를 극복하고, AI 기반 자동 분류와 전사적 결재 프로세스, 자금 관리 및 예측 기능을 제공하는 통합 재무 관리 플랫폼입니다.

---

## 주요 기능

### 1. AI 전표 자동 분류 엔진 (Active Learning Core)
- **자연어 처리(NLP)** 기반 적요/가맹점 분석
- **신뢰도 점수** 기반 자동 확정 / 검토 필요 판단
- **사용자 피드백 학습** - 수정 시 자동으로 재학습
- 프로젝트, TF 등 **커스텀 태그** 자동 분류

### 2. 전사적 기안 및 결재 시스템
- 비회계 직원도 쉽게 사용 가능한 **지출 결의서 자동 작성**
- 팀장 → 부문장 → 재무팀 **결재 라인** 설정
- **실시간 예산 체크** - 기안 시 잔여 예산 표시
- 반려/수정/재상신 워크플로우

### 3. 자금 관리 및 채권/채무 자동화
- **스마트 매칭** - 은행 입출금과 채권/채무 자동 매칭
- **가상계좌 연동** - 매출처별 100% 식별
- **지급 스케줄러** - 매입채무 지급 계획 관리
- **연령 분석** - AR/AP Aging Report

### 4. 손익 예측 및 시뮬레이션 (FP&A)
- **실시간 추정 손익계산서** - 확정 + 결재중 + 고정비 합산
- **자금 수지 예측** - 일별 현금 흐름 예측
- **What-If 시뮬레이션** - 매출/원가 변동 시나리오 분석

### 5. 데이터 관리 및 엑셀 호환성
- **웹 엑셀 인터페이스** (AG Grid 기반)
- **더존 양식 호환** - Import/Export
- **감사 추적** - 모든 변경 이력 기록
- **데이터 아카이빙** - 일별/월별 자동 백업

---

## 기술 스택

### Backend
- **Framework:** FastAPI (Python 3.11+)
- **Database:** PostgreSQL 15
- **Cache:** Redis 7
- **ORM:** SQLAlchemy 2.0 (Async)

### AI/ML
- **분류 모델:** Scikit-learn (Random Forest), PyTorch (Transformer)
- **시계열 예측:** Prophet
- **OCR:** Tesseract

### Frontend
- **Framework:** React 18 + TypeScript
- **State:** Zustand, React Query
- **UI:** Tailwind CSS, Headless UI
- **Data Grid:** AG Grid
- **Charts:** Recharts

### Infrastructure
- **Container:** Docker, Docker Compose
- **CI/CD:** GitHub Actions (선택)
- **Storage:** AWS S3 (아카이빙)

---

## 빠른 시작

### 사전 요구사항
- Docker & Docker Compose
- Node.js 20+ (개발 시)
- Python 3.11+ (개발 시)

### Docker로 실행

```bash
# 저장소 클론
git clone https://github.com/your-org/smart-finance-core.git
cd smart-finance-core

# 환경 변수 설정
cp backend/.env.example backend/.env

# Docker Compose로 실행
docker-compose up -d

# 서비스 확인
# - Frontend: http://localhost:3000
# - Backend API: http://localhost:8000
# - API 문서: http://localhost:8000/docs
```

### 개발 환경 실행

```bash
# Backend
cd backend
python -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --reload

# Frontend
cd frontend
npm install
npm run dev
```

---

## 프로젝트 구조

```
smart-finance-core/
├── backend/
│   ├── app/
│   │   ├── api/endpoints/    # API 엔드포인트
│   │   ├── core/             # 설정, 보안, DB
│   │   ├── models/           # SQLAlchemy 모델
│   │   ├── schemas/          # Pydantic 스키마
│   │   ├── services/         # 비즈니스 로직
│   │   └── main.py           # 앱 진입점
│   ├── ml/                   # AI 모델
│   ├── tests/                # 테스트
│   ├── requirements.txt
│   └── Dockerfile
├── frontend/
│   ├── src/
│   │   ├── components/       # React 컴포넌트
│   │   ├── pages/            # 페이지 컴포넌트
│   │   ├── services/         # API 클라이언트
│   │   ├── store/            # 상태 관리
│   │   └── App.tsx
│   ├── package.json
│   └── Dockerfile
├── docker-compose.yml
└── README.md
```

---

## API 문서

서버 실행 후 다음 URL에서 API 문서 확인:
- Swagger UI: http://localhost:8000/docs
- ReDoc: http://localhost:8000/redoc

### 주요 API 엔드포인트

| 경로 | 설명 |
|------|------|
| `POST /api/v1/auth/login` | 로그인 |
| `GET /api/v1/vouchers/` | 전표 목록 |
| `POST /api/v1/vouchers/` | 전표 생성 |
| `POST /api/v1/ai/classify` | AI 분류 |
| `GET /api/v1/approvals/pending` | 결재 대기 목록 |
| `POST /api/v1/approvals/{id}/action` | 결재 처리 |
| `GET /api/v1/treasury/cash-position` | 현금 포지션 |
| `GET /api/v1/forecast/pl` | 손익 예측 |

---

## 사용자 시나리오

### 영업팀 김대리 (비용 청구)
1. 거래처 미팅 후 법인카드 결제
2. 웹 접속 → 카드 내역 선택
3. "거래처 식사" 입력 → AI가 '접대비' 자동 분류
4. 결재 상신

### 영업팀 이팀장 (결재)
1. 결재함에서 알림 확인
2. 내역 검토 (접대비 예산 잔액 자동 표시)
3. 승인 클릭

### 재무팀 박과장 (전표 확정)
1. 승인된 건들 '전표 대기함'에 모임
2. AI 분류 확인 (수정 시 AI 자동 학습)
3. '전표 확정' 클릭

### CFO / 대표 (모니터링)
1. 대시보드에서 실시간 예상 이익 확인
2. 자금 수지표로 자금 계획 검토
3. 시나리오 시뮬레이션으로 의사결정

---

## 보안

- **비밀번호 정책:** 8자 이상, 대/소문자, 숫자, 특수문자 포함
- **2FA 지원:** TOTP 기반 2차 인증
- **데이터 암호화:** AES-256
- **감사 추적:** 모든 데이터 변경 이력 기록
- **세션 관리:** JWT 토큰 기반

---

## 라이선스

MIT License

---

## 문의

- 이슈 등록: [GitHub Issues](https://github.com/your-org/smart-finance-core/issues)
- 이메일: support@smartfinance.co.kr
