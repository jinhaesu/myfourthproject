import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  cashDigestApi, cardsApi, treasuryApi, granterApi,
} from '@/services/api'
import { isoLocal } from '@/utils/format'

function todayISO() { return isoLocal(new Date()) }
function daysAgoISO(n: number) { const d = new Date(); d.setDate(d.getDate() - n); return isoLocal(d) }

/**
 * 관리자 진입 시 좌측 메뉴 순서대로 기본 조회를 백그라운드 선조회.
 * 목적: 실제 메뉴 클릭 시 즉시 열람(백엔드 그랜터 5분 캐시 워밍 + 대시보드/카드는 쿼리캐시 채움).
 * 렉 방지: 순차 실행 + 각 사이 idle 양보. 실패는 조용히 무시.
 */
export function useAdminPrefetch(enabled: boolean) {
  const qc = useQueryClient()
  const ran = useRef(false)

  useEffect(() => {
    if (!enabled || ran.current) return
    ran.current = true

    const to = todayISO()
    const from30 = daysAgoISO(30)
    const from7 = daysAgoISO(7)

    // 메뉴 위→아래 순서. 앞쪽(대시보드/통합/자금일보/카드)일수록 우선.
    const steps: Array<() => Promise<any>> = [
      // 대시보드 — 쿼리캐시까지 채워 즉시 표시
      () => qc.prefetchQuery({
        queryKey: ['dashboard-live'],
        queryFn: () => cashDigestApi.dashboardLive().then((r) => r.data),
        staleTime: 60_000,
      }),
      // 통합 조회 — 그랜터 자산/티켓 캐시 워밍
      () => granterApi.listAllAssets(false),
      () => granterApi.listTickets({ ticketType: 'BANK_TRANSACTION_TICKET', startDate: from7, endDate: to }),
      // 자금 다이제스트
      () => cashDigestApi.preview(),
      // 카드 관리 — 쿼리캐시 매칭 키
      () => qc.prefetchQuery({
        queryKey: ['cards-list', from30, to],
        queryFn: () => cardsApi.list(from30, to).then((r) => r.data.cards),
      }),
      // 은행간 내부거래
      () => treasuryApi.internalTransfers(from30, to),
    ]

    let cancelled = false
    const idle = (fn: () => void) =>
      (window as any).requestIdleCallback ? (window as any).requestIdleCallback(fn, { timeout: 1500 }) : setTimeout(fn, 300)

    async function run() {
      for (const step of steps) {
        if (cancelled) return
        try { await step() } catch { /* 무시 */ }
        // 다음 조회 전 idle 양보 — UI 렉 방지
        await new Promise<void>((res) => idle(() => res()))
      }
    }
    // 첫 화면 렌더 후 시작
    const t = setTimeout(run, 800)
    return () => { cancelled = true; clearTimeout(t) }
  }, [enabled, qc])
}
