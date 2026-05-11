import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { periodForPreset, type PeriodPreset } from '@/components/common/PeriodPicker'

/**
 * 글로벌 기간(from/to/preset) 상태.
 *
 * 핵심: preset이 동적(this_month/last_7d 등)이면 항상 today 기준으로 from/to 재계산.
 * 사용자가 'custom'으로 직접 지정한 경우만 저장된 값을 그대로 사용.
 *
 * 기본 preset: 'last_7d' (사용자 요구: 당일 기준 지난 7일)
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
      // 버전 변경 → 이전 sessionStorage(stale 5/4~5/6 등) 무효화하고 default로 새로 시작
      version: 3,
      migrate: () => {
        const r = periodForPreset(DEFAULT_PRESET)
        return {
          preset: DEFAULT_PRESET,
          from: r.start,
          to: r.end,
          set: () => {},  // store가 실제 set을 덮어쓸 것
        } as PeriodState
      },
      // 복원 직후 preset이 동적이면 today 기반 재계산 (setState 명시 호출로 확실히 적용)
      onRehydrateStorage: () => (state) => {
        if (!state) return
        if (state.preset !== 'custom') {
          const r = periodForPreset(state.preset)
          usePeriodStore.setState({ from: r.start, to: r.end })
        }
      },
    }
  )
)
