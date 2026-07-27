import { useEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import api from '@/services/api'
import { usePeriodStore } from '@/store/periodStore'
import { isoLocal } from '@/utils/format'

function todayISO() { return isoLocal(new Date()) }
function daysAgoISO(n: number) { const d = new Date(); d.setDate(d.getDate() - n); return isoLocal(d) }

const STALE = 180_000
// 선조회 요청임을 백엔드에 표시 — 그랜터 레인에서 사용자 요청에 양보(우선순위 낮음)
const PF = { headers: { 'X-Prefetch': '1' }, timeout: 180_000 }

/**
 * 관리자 진입 시 좌측 메뉴 순서대로 전체 기본 조회를 백그라운드 순차 선조회.
 *
 * 두 마리 토끼:
 *  - 선조회는 전 메뉴를 계속 데움(클릭 시 즉시 표시, 3분 캐시).
 *  - 모든 선조회 그랜터 호출에 X-Prefetch 헤더 → 백엔드가 사용자 요청에 레인 양보.
 *    사용자가 메뉴를 눌러도 진행 중이던 '한 건'만 끝나면 바로 처리(렉 최소화).
 *  - 사용자가 경로를 바꾸면 선조회도 중단(이중 안전장치).
 */
export function useAdminPrefetch(enabled: boolean) {
  const qc = useQueryClient()
  const location = useLocation()
  const ran = useRef(false)
  const startPath = useRef(location.pathname)
  const cancelled = useRef(false)

  useEffect(() => {
    if (location.pathname !== startPath.current) cancelled.current = true
  }, [location.pathname])

  useEffect(() => {
    if (!enabled || ran.current) return
    ran.current = true

    const to = todayISO()
    const from30 = daysAgoISO(30)
    const year = new Date().getFullYear()
    const st = usePeriodStore.getState()
    const pFrom = st.from
    const pTo = st.to

    // 쿼리캐시에 정확한 키로 채우는 헬퍼
    const warm = (queryKey: any[], fn: () => Promise<any>) =>
      () => qc.prefetchQuery({ queryKey, queryFn: fn, staleTime: STALE })

    const post = (url: string, body: any, cfg: any = {}) => api.post(url, body, { ...PF, ...cfg })
    const get = (url: string, cfg: any = {}) => api.get(url, { ...PF, ...cfg })
    const ticket = (type: string, s: string, e: string) =>
      post('/granter/tickets', { ticketType: type, startDate: s, endDate: e })

    // 메뉴 위→아래 순서 (실시간 자금관리 → 경영 인사이트 → 전표 처리 → 회계/분석)
    const steps: Array<() => Promise<any>> = [
      warm(['dashboard-live'], () => get('/daily-cash-report/dashboard-live', { timeout: 60_000 }).then((r) => r.data)),
      warm(['granter-assets-all', false], () => get('/granter/assets/all', { params: { only_active: false } }).then((r) => r.data)),
      warm(['granter-tickets-usage', pFrom, pTo], () =>
        post('/granter/tickets/all', null, { params: { start_date: pFrom, end_date: pTo, slim: false } }).then((r) => r.data)),
      warm(['unified-card-expenses', pFrom, pTo], () => ticket('EXPENSE_TICKET', pFrom, pTo).then((r) => r.data)),
      warm(['card-aliases-list'], () => get('/cards/list', { params: { start_date: pFrom, end_date: pTo } }).then((r) => r.data.cards)),
      () => get('/daily-cash-report/preview'),
      warm(['cards-list', from30, to], () => get('/cards/list', { params: { start_date: from30, end_date: to } }).then((r) => r.data.cards)),
      warm(['internal-transfers', from30, to], () => get('/treasury/internal-transfers', { params: { start_date: from30, end_date: to } }).then((r) => r.data)),
      // 채널수익성 — TAX/BANK 티켓 캐시 워밍 (EXPENSE는 위에서 이미)
      () => ticket('TAX_INVOICE_TICKET', pFrom, pTo),
      () => ticket('BANK_TRANSACTION_TICKET', pFrom, pTo),
      () => get('/forecast/cash-flow', { params: { forecast_days: 28 } }).catch(() => null),
      () => get('/auto-voucher/list', { params: { page: 1, size: 20 } }).catch(() => null),
      () => get('/vouchers/', { params: { page: 1, size: 20 } }).catch(() => null),
      () => get('/ledger/accounts', { params: { fiscal_year: year, only_with_activity: true } }).catch(() => null),
      () => get('/financial/available-years').catch(() => null),
    ]

    async function run() {
      for (const step of steps) {
        if (cancelled.current) return
        try { await step() } catch { /* 무시 */ }
      }
    }
    const t = setTimeout(run, 1200)
    return () => { cancelled.current = true; clearTimeout(t) }
  }, [enabled, qc])
}
