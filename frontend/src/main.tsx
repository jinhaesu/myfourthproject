import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter } from 'react-router-dom'
import { Toaster } from 'react-hot-toast'
import App from './App'
import './styles/globals.css'

// 캐시 정책 (체감 속도 + 안정성 균형):
// - staleTime: 30초 — 30초 내 재방문은 캐시 즉시 표시(네트워크 0). 30초 지나면 stale.
// - gcTime: 3시간 — 페이지 이동 후 3시간 동안 캐시 보관 (재진입 시 즉시 표시 + 백그라운드 갱신)
// - refetchOnMount: true — stale일 때만 refetch. 캐시가 fresh면 네트워크 호출 안 함(메뉴 전환 즉시).
//   (이전 'always'는 매 진입마다 무조건 네트워크 → 한국↔싱가포르 ~200ms 누적의 주범이라 완화)
// - refetchOnWindowFocus: false — 창 포커스로는 refetch 안 함
const GC_3H = 3 * 60 * 60 * 1000

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
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
