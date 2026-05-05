import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter } from 'react-router-dom'
import { Toaster } from 'react-hot-toast'
import App from './App'
import './styles/globals.css'

// 캐시 정책:
// - staleTime: 5분 — 짧게 하여 빈 응답이 캐시되어도 5분 내 자동 백그라운드 refetch
// - gcTime: 3시간 — 페이지 이동 후 3시간 동안 캐시 보관 (사용자 요구 '3시간 캐시 유지')
// - refetchOnMount: 'always' — mount마다 캐시 즉시 표시 + 백그라운드 새로고침
const STALE_5M = 5 * 60 * 1000
const GC_3H = 3 * 60 * 60 * 1000

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: STALE_5M,
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
