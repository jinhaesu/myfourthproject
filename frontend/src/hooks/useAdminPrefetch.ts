import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  cashDigestApi, cardsApi, treasuryApi, granterApi,
  forecastApi, vouchersApi, autoVoucherApi, ledgerApi, financialApi,
} from '@/services/api'
import { usePeriodStore } from '@/store/periodStore'
import { isoLocal } from '@/utils/format'

function todayISO() { return isoLocal(new Date()) }
function daysAgoISO(n: number) { const d = new Date(); d.setDate(d.getDate() - n); return isoLocal(d) }

const STALE = 180_000  // 프리페치 데이터 fresh 유지 (전역 staleTime과 동일)

/**
 * 관리자 진입 시 좌측 메뉴 순서대로 기본 조회를 백그라운드 순차 선조회.
 *
 * 핵심: 각 페이지가 실제로 쓰는 쿼리키·queryFn과 '동일하게' 프리페치 →
 *       메뉴 클릭 시 캐시 즉시 표시(재조회 없음). 전역 staleTime 3분과 정합.
 * 순서: 실시간 자금관리 → 경영 인사이트 → 전표 처리 → 회계/분석
 * 렉 방지: 순차 실행 + 각 사이 requestIdleCallback 양보. 실패는 조용히 무시.
 */
export function useAdminPrefetch(enabled: boolean) {
  const qc = useQueryClient()
  const ran = useRef(false)

  useEffect(() => {
    if (!enabled || ran.current) return
    ran.current = true

    const to = todayISO()
    const from30 = daysAgoISO(30)
    const year = new Date().getFullYear()
    // 통합조회·채널수익성은 글로벌 기간(periodStore) 사용 — 페이지와 동일한 날짜로 맞춤
    const st = usePeriodStore.getState()
    const pFrom = st.from
    const pTo = st.to

    const pf = (queryKey: any[], queryFn: () => Promise<any>) =>
      () => qc.prefetchQuery({ queryKey, queryFn, staleTime: STALE })

    // 메뉴 위→아래 순서. 각 페이지의 실제 쿼리키에 맞춤.
    const steps: Array<() => Promise<any>> = [
      // ── 실시간 자금관리 ──
      pf(['dashboard-live'], () => cashDigestApi.dashboardLive().then((r) => r.data)),               // 대시보드
      pf(['granter-assets-all', false], () => granterApi.listAllAssets(false).then((r) => r.data)),  // 통합조회 자산
      pf(['granter-tickets-usage', pFrom, pTo], () => granterApi.listTicketsAllTypes(pFrom, pTo).then((r) => r.data)), // 통합조회 티켓
      pf(['unified-card-expenses', pFrom, pTo], () => granterApi.listTickets({ ticketType: 'EXPENSE_TICKET', startDate: pFrom, endDate: pTo }).then((r) => r.data)),
      pf(['card-aliases-list'], () => cardsApi.list(pFrom, pTo).then((r) => r.data.cards)),
      () => cashDigestApi.preview(),                                                                  // AI 자금 다이제스트(스냅샷 캐시)
      pf(['cards-list', from30, to], () => cardsApi.list(from30, to).then((r) => r.data.cards)),      // 카드 관리
      pf(['internal-transfers', from30, to], () => treasuryApi.internalTransfers(from30, to).then((r) => r.data)), // 은행간 내부거래

      // ── 경영 인사이트 ──
      pf(['channel-profitability', pFrom, pTo], async () => {                                         // 채널별 수익성
        const bank = await granterApi.listTickets({ ticketType: 'BANK_TRANSACTION_TICKET', startDate: pFrom, endDate: pTo })
        const tax = await granterApi.listTickets({ ticketType: 'TAX_INVOICE_TICKET', startDate: pFrom, endDate: pTo })
        const expense = await granterApi.listTickets({ ticketType: 'EXPENSE_TICKET', startDate: pFrom, endDate: pTo })
        const arr = (r: any) => (Array.isArray(r.data) ? r.data : r.data?.data || [])
        return { bank: arr(bank), tax: arr(tax), expense: arr(expense) }
      }),
      () => forecastApi.getCashFlow(28).catch(() => null),                                            // 캐시플로우 예측

      // ── 전표 처리 ──
      () => autoVoucherApi.list({ page: 1, size: 20 }).catch(() => null),                             // 자동 전표 검수
      () => vouchersApi.list({ page: 1, size: 20 } as any).catch(() => null),                         // 전표관리

      // ── 회계/분석 ──
      () => ledgerApi.listAccounts({ fiscal_year: year, only_with_activity: true }).catch(() => null), // 계정별 원장
      () => financialApi.getAvailableYears().catch(() => null),                                       // 재무보고서
    ]

    let cancelled = false
    const idle = (fn: () => void) =>
      (window as any).requestIdleCallback
        ? (window as any).requestIdleCallback(fn, { timeout: 1500 })
        : setTimeout(fn, 300)

    async function run() {
      for (const step of steps) {
        if (cancelled) return
        try { await step() } catch { /* 무시 */ }
        await new Promise<void>((res) => idle(() => res()))  // 다음 조회 전 idle 양보
      }
    }
    const t = setTimeout(run, 600)  // 첫 화면 렌더 후 시작
    return () => { cancelled = true; clearTimeout(t) }
  }, [enabled, qc])
}
