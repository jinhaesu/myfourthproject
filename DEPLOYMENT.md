# Smart Finance Core - 배포 가이드

## 개요

이 문서는 Smart Finance Core 플랫폼을 Railway (백엔드) 와 Vercel (프론트엔드)에 배포하는 방법을 설명합니다.

---

## 1. Railway 백엔드 배포

### 1.1 사전 준비

1. [Railway](https://railway.app) 계정 생성
2. GitHub 저장소 연결

### 1.2 새 프로젝트 생성

1. Railway Dashboard에서 **New Project** 클릭
2. **Deploy from GitHub repo** 선택
3. 이 저장소 선택

### 1.3 PostgreSQL 데이터베이스 추가

1. 프로젝트 내에서 **+ New** → **Database** → **PostgreSQL** 선택
2. PostgreSQL이 생성되면 **Connect** 탭에서 연결 정보 확인

### 1.4 환경 변수 설정

Railway 프로젝트 설정에서 다음 환경 변수를 추가:

```
# Database (Railway가 자동 제공)
DATABASE_URL=postgresql+asyncpg://...

# Security (반드시 강력한 키로 변경!)
SECRET_KEY=your-super-secret-key-minimum-32-characters

# App Settings
DEBUG=false
LOG_LEVEL=INFO

# CORS (Vercel 프론트엔드 URL)
CORS_ORIGINS=["https://your-app-name.vercel.app","https://your-custom-domain.com"]
```

### 1.5 서비스 설정

Railway가 자동으로 `railway.json` 또는 `Procfile`을 감지합니다.

- **Root Directory**: `/backend`
- **Start Command**: `uvicorn app.main:app --host 0.0.0.0 --port $PORT`

### 1.6 배포 확인

배포 후 `https://your-backend.railway.app/health`에 접속하여 상태 확인

---

## 2. Vercel 프론트엔드 배포

### 2.1 사전 준비

1. [Vercel](https://vercel.com) 계정 생성
2. GitHub 저장소 연결

### 2.2 새 프로젝트 생성

1. Vercel Dashboard에서 **Add New** → **Project** 클릭
2. 이 저장소 Import
3. **Root Directory**를 `frontend`로 설정

### 2.3 환경 변수 설정

Vercel 프로젝트 설정에서 다음 환경 변수를 추가:

```
VITE_API_URL=https://your-backend.railway.app/api/v1
```

### 2.4 빌드 설정

Vercel이 자동으로 Vite 프로젝트를 감지하지만, 수동 설정이 필요한 경우:

- **Framework Preset**: Vite
- **Build Command**: `npm run build`
- **Output Directory**: `dist`
- **Install Command**: `npm install`

### 2.5 배포 확인

배포 후 Vercel이 제공하는 URL에 접속하여 확인

---

## 3. 초기 데이터 설정

### 3.1 로컬에서 시드 데이터 실행

백엔드 서버가 실행된 후, 다음 명령으로 초기 데이터를 생성:

```bash
cd backend
python -m app.scripts.seed_data
```

### 3.2 생성되는 기본 데이터

- **역할(Roles)**: 관리자, 재무담당자, 팀장, 일반직원
- **부서(Departments)**: 재무팀, 인사팀, 영업팀, 개발팀, 마케팅팀
- **계정과목**: 27개 기본 계정
- **테스트 사용자**:
  - `admin@smartfinance.com` / `admin123!` (관리자)
  - `finance@smartfinance.com` / `finance123!` (재무담당자)
  - `developer@smartfinance.com` / `dev123!` (일반직원)

---

## 4. 문제 해결

### CORS 오류

- Railway 환경 변수에서 `CORS_ORIGINS`에 Vercel URL이 포함되어 있는지 확인
- 형식: `CORS_ORIGINS=["https://your-app.vercel.app"]`

### 데이터베이스 연결 오류

- `DATABASE_URL`이 `postgresql+asyncpg://`로 시작하는지 확인
- Railway PostgreSQL 연결 정보 재확인

### 빌드 실패

- Node.js 버전 확인 (18+ 권장)
- Python 버전 확인 (3.10+ 권장)

---

## 5. 커스텀 도메인 설정

### Railway (백엔드)

1. 프로젝트 설정 → **Domains**
2. 커스텀 도메인 추가
3. DNS 설정 (CNAME 레코드)

### Vercel (프론트엔드)

1. 프로젝트 설정 → **Domains**
2. 커스텀 도메인 추가
3. DNS 설정 (A 또는 CNAME 레코드)

---

## 6. 환경별 설정 요약

| 항목 | 개발 (Local) | 프로덕션 (Railway/Vercel) |
|------|-------------|--------------------------|
| Backend URL | http://localhost:8000 | https://your-app.railway.app |
| Frontend URL | http://localhost:3000 | https://your-app.vercel.app |
| Database | SQLite | PostgreSQL |
| DEBUG | true | false |

---

## 7. 보안 체크리스트

- [ ] `SECRET_KEY`를 강력한 랜덤 문자열로 변경
- [ ] `DEBUG=false` 설정
- [ ] HTTPS 사용 확인
- [ ] CORS_ORIGINS에 허용된 도메인만 포함
- [ ] 데이터베이스 비밀번호 보안 확인
