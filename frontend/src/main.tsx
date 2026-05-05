import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter } from 'react-router-dom'
import { Toaster } from 'react-hot-toast'
import App from './App'
import './styles/globals.css'

// 캐시 정책 (안정성 우선):
// - staleTime: 0 — mount 시 항상 fresh fetch (빈 응답 고착 방지)
// - gcTime: 3시간 — 페이지 이동 후 3시간 동안 캐시 보관 (즉시 표시 + 백그라운드 갱신)
// - refetchOnMount: 'always' — mount마다 무조건 fetch
// - refetchOnWindowFocus: false — 창 포커스로는 refetch 안 함
const GC_3H = 3 * 60 * 60 * 1000

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 0,
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
