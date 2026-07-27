import { useEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { cashDigestApi, granterApi } from '@/services/api'
import { usePeriodStore } from '@/store/periodStore'

const STALE = 180_000

/**
 * 관리자 진입 시 '가벼운' 핵심 데이터만 백그라운드 선조회.
 *
 * 주의: 그랜터는 동시호출 금지(semaphore=1)라 모든 그랜터 호출이 전역 직렬 처리됨.
 *       선조회를 많이 하면 오히려 사용자 클릭이 그 뒤에 줄 서 느려짐.
 *       → 최소한(대시보드 + 통합/채널이 공유하는 티켓 캐시)만 데우고,
 *         사용자가 메뉴를 클릭(경로 변경)하면 즉시 중단해서 레인을 양보.
 *       나머지 메뉴는 최초 방문 시 로드되고 3분 캐시로 재방문은 즉시.
 */
export function useAdminPrefetch(enabled: boolean) {
  const qc = useQueryClient()
  const location = useLocation()
  const ran = useRef(false)
  const startPath = useRef(location.pathname)
  const cancelled = useRef(false)

  // 사용자가 다른 메뉴로 이동하면 선조회 중단 (그랜터 레인 양보)
  useEffect(() => {
    if (location.pathname !== startPath.current) cancelled.current = true
  }, [location.pathname])

  useEffect(() => {
    if (!enabled || ran.current) return
    ran.current = true

    const st = usePeriodStore.getState()
    const pFrom = st.from
    const pTo = st.to

    // 가벼운 핵심만: 대시보드(랜딩) + 통합/채널이 공유하는 티켓 캐시 워밍
    const steps: Array<() => Promise<any>> = [
      () => qc.prefetchQuery({
        queryKey: ['dashboard-live'],
        queryFn: () => cashDigestApi.dashboardLive().then((r) => r.data),
        staleTime: STALE,
      }),
      // 통합조회 + 채널수익성이 공유하는 그랜터 티켓(같은 기간 캐시) — 한 번 데우면 둘 다 빨라짐
      () => qc.prefetchQuery({
        queryKey: ['granter-tickets-usage', pFrom, pTo],
        queryFn: () => granterApi.listTicketsAllTypes(pFrom, pTo).then((r) => r.data),
        staleTime: STALE,
      }),
    ]

    async function run() {
      for (const step of steps) {
        if (cancelled.current) return  // 사용자가 클릭하면 즉시 중단
        try { await step() } catch { /* 무시 */ }
      }
    }
    // 랜딩(대시보드) 첫 렌더가 끝난 뒤 시작 — 넉넉히 지연해 초기 렉 방지
    const t = setTimeout(run, 1500)
    return () => { cancelled.current = true; clearTimeout(t) }
  }, [enabled, qc])
}
