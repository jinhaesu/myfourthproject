import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter } from 'react-router-dom'
import { Toaster } from 'react-hot-toast'
import App from './App'
import './styles/globals.css'

// 페이지 간 이동 시 조회 결과 유지 + 3시간 캐시 (사용자 명시 요구)
// staleTime: 3시간 동안은 fresh로 간주 → mount/focus 시 자동 refetch 안 함
// gcTime: unmount 후에도 3시간 동안 캐시 보관 → 다른 페이지 갔다 와도 결과 유지
const THREE_HOURS = 3 * 60 * 60 * 1000

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: THREE_HOURS,
      gcTime: THREE_HOURS,
      refetchOnWindowFocus: false,
      refetchOnMount: false,
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
