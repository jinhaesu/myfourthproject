import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { periodForPreset, type PeriodPreset } from '@/components/common/PeriodPicker'

/**
 * 글로벌 기간(from/to/preset) 상태.
 *
 * 핵심 설계: preset이 동적인 경우(this_month, last_7d 등)는 **오늘 날짜 기준 매번 재계산**.
 * sessionStorage에 from/to를 저장하긴 하지만 hydration 시 preset이 'custom'이 아니면 today 기반으로 덮어씀.
 * → 어제 페이지를 켜놓고 오늘 켜도 항상 최신 today 기준 기간으로 표시.
 *
 * 기본값: 'last_7d' (지난 7일) — 사용자 요구: "기본 날짜는 당일 기준 지난 7일"
 */
interface PeriodState {
  preset: PeriodPreset
  from: string
  to: string
  set: (preset: PeriodPreset, from: string, to: string) => void
}

const DEFAULT_PRESET: PeriodPreset = 'last_7d'
const initial = periodForPreset(DEFAULT_PRESET)

export const usePeriodStore = create<PeriodState>()(
  persist(
    (set) => ({
      preset: DEFAULT_PRESET,
      from: initial.start,
      to: initial.end,
      set: (preset, from, to) => set({ preset, from, to }),
    }),
    {
      name: 'period-storage',
      // 복원 직후 preset이 'custom'이 아니면 today 기준 재계산해서 stale 날짜 방지
      onRehydrateStorage: () => (state) => {
        if (!state) return
        if (state.preset !== 'custom') {
          const r = periodForPreset(state.preset)
          state.from = r.start
          state.to = r.end
        }
      },
    }
  )
)
