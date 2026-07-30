import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter } from 'react-router-dom'
import { Toaster } from 'react-hot-toast'
import App from './App'
import { useThemeStore } from './store/themeStore'
import './styles/globals.css'

// Ensure <html class="dark"> matches the persisted preference. index.html's
// inline script already avoids a flash on first paint; this keeps the DOM in
// sync with the zustand store on every load (SPA re-entry, HMR, etc).
useThemeStore.getState().setTheme(useThemeStore.getState().theme)

// 캐시 정책 (체감 속도 + 안정성 균형):
// - staleTime: 3분 — 관리자 진입 시 선조회한 데이터가 fresh로 유지되어, 메뉴 클릭 시 재조회 없이 즉시 표시.
//   (그랜터 백엔드 캐시도 5분이라 정합. 최신값 필요하면 각 페이지의 새로고침 버튼)
// - gcTime: 3시간 — 페이지 이동 후 3시간 동안 캐시 보관
// - refetchOnMount: true — stale일 때만 refetch. fresh면 네트워크 0(메뉴 전환 즉시)
// - refetchOnWindowFocus: false — 창 포커스로는 refetch 안 함
const GC_3H = 3 * 60 * 60 * 1000

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 180_000,
      gcTime: GC_3H,
      refetchOnWindowFocus: false,
      refetchOnMount: true,
      // 401/403/429는 retry해도 같은 결과 → retry 안 함 (그랜터 rate limit 폭주 방지)
      retry: (failureCount, error: any) => {
        const status = error?.response?.status
        if (status === 401 || status === 403 || status === 429) return false
        return failureCount < 1
      },
      retryDelay: (attempt) => Math.min(1500 * 2 ** attempt, 6000),
    },
  },
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
        <Toaster position="top-right" />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
)
