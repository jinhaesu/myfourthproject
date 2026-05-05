import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter } from 'react-router-dom'
import { Toaster } from 'react-hot-toast'
import App from './App'
import './styles/globals.css'

// 캐시 정책:
// - staleTime: 30분 — 30분 안에 mount하면 캐시 즉시 사용, 그 후 mount 시 백그라운드 refetch
// - gcTime: 3시간 — 페이지 이동 후 3시간 동안 캐시 보관 → 돌아와도 즉시 결과 표시 (사용자 요구 충족)
// - refetchOnMount: 'always' — mount마다 stale check + 캐시 표시 유지 + 백그라운드 새로고침
// - 이전 staleTime=3h+refetchOnMount=false 조합은 빈 응답이 3시간 고착되는 문제 있음
const STALE_30M = 30 * 60 * 1000
const GC_3H = 3 * 60 * 60 * 1000

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: STALE_30M,
      gcTime: GC_3H,
      refetchOnWindowFocus: false,
      refetchOnMount: 'always',
      retry: 1,
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
