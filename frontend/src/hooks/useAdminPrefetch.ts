import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  cashDigestApi, cardsApi, treasuryApi, granterApi,
  forecastApi, vouchersApi, autoVoucherApi, ledgerApi, financialApi,
  taxInvoiceApi,
} from '@/services/api'
import { isoLocal } from '@/utils/format'

function todayISO() { return isoLocal(new Date()) }
function daysAgoISO(n: number) { const d = new Date(); d.setDate(d.getDate() - n); return isoLocal(d) }

/**
 * 관리자 진입 시 좌측 메뉴 순서대로 기본 조회를 백그라운드 순차 선조회.
 *
 * 순서: 실시간 자금관리 → 경영 인사이트 → 전표 처리 → 회계/분석
 * 목적: 웹만 켜두면 각 메뉴가 미리 데워져서 실제 클릭 시 즉시 열람.
 * 렉 방지: 순차 실행 + 각 사이 requestIdleCallback 양보. 실패는 조용히 무시.
 * (그랜터 티켓/일일리포트는 백엔드 5분 캐시가 데워지고, 대시보드·카드는 쿼리캐시까지 채움)
 */
export function useAdminPrefetch(enabled: boolean) {
  const qc = useQueryClient()
  const ran = useRef(false)

  useEffect(() => {
    if (!enabled || ran.current) return
    ran.current = true

    const to = todayISO()
    const from7 = daysAgoISO(7)
    const from30 = daysAgoISO(30)
    const year = new Date().getFullYear()

    // 메뉴 위→아래 순서. 그랜터 캐시(느린 원인) 워밍을 우선.
    const steps: Array<() => Promise<any>> = [
      // ── 실시간 자금관리 ──
      () => qc.prefetchQuery({
        queryKey: ['dashboard-live'],
        queryFn: () => cashDigestApi.dashboardLive().then((r) => r.data),
        staleTime: 60_000,
      }),
      () => granterApi.listAllAssets(false),                                    // 통합조회 자산
      () => granterApi.listTickets({ ticketType: 'BANK_TRANSACTION_TICKET', startDate: from7, endDate: to }),
      () => granterApi.listTickets({ ticketType: 'EXPENSE_TICKET', startDate: from7, endDate: to }),
      () => granterApi.listTickets({ ticketType: 'TAX_INVOICE_TICKET', startDate: from7, endDate: to }),
      () => cashDigestApi.preview(),                                            // AI 자금 다이제스트
      () => qc.prefetchQuery({
        queryKey: ['cards-list', from30, to],
        queryFn: () => cardsApi.list(from30, to).then((r) => r.data.cards),
      }),
      () => treasuryApi.internalTransfers(from30, to),                          // 은행간 내부거래
      () => taxInvoiceApi.list({ page: 1, size: 20 } as any).catch(() => null), // 세금계산서

      // ── 경영 인사이트 ──
      // 채널별 수익성: 위 EXPENSE/TAX/BANK 티켓 캐시 재사용 (별도 호출 불필요)
      () => forecastApi.getCashFlow(28),                                        // 캐시플로우 예측
      () => forecastApi.getDashboard().catch(() => null),

      // ── 전표 처리 ──
      () => autoVoucherApi.list({ page: 1, size: 20 }).catch(() => null),       // 자동 전표 검수
      () => vouchersApi.list({ page: 1, size: 20 } as any).catch(() => null),   // 전표관리

      // ── 회계/분석 ──
      () => ledgerApi.listAccounts({ fiscal_year: year, only_with_activity: true }).catch(() => null), // 계정별 원장
      () => financialApi.getAvailableYears().catch(() => null),                 // 재무보고서
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
    const t = setTimeout(run, 800)  // 첫 화면 렌더 후 시작
    return () => { cancelled = true; clearTimeout(t) }
  }, [enabled, qc])
}
