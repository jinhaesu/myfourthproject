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
      // 복원 직후 항상 today 기준으로 재앵커링.
      // custom(직접 지정)은 그 세션 안에서만 유지 — 새로 들어오면 기본 last_7d(오늘 기준 7일)로 리셋.
      // (custom을 영구 저장하면 다음날 들어와도 과거 날짜로 고정되는 문제가 있었음)
      onRehydrateStorage: () => (state) => {
        if (!state) return
        if (state.preset === 'custom') {
          const r = periodForPreset(DEFAULT_PRESET)
          usePeriodStore.setState({ preset: DEFAULT_PRESET, from: r.start, to: r.end })
        } else {
          const r = periodForPreset(state.preset)
          usePeriodStore.setState({ from: r.start, to: r.end })
        }
      },
    }
  )
)
