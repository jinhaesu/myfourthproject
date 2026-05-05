import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { periodForPreset, type PeriodPreset } from '@/components/common/PeriodPicker'

/**
 * 글로벌 기간(from/to/preset) 상태.
 * 사용자가 여러 페이지를 이동해도 마지막으로 선택한 기간이 유지된다.
 * persist로 sessionStorage 영속화 (브라우저 재시작하면 default로 복귀).
 */
interface PeriodState {
  preset: PeriodPreset
  from: string
  to: string
  set: (preset: PeriodPreset, from: string, to: string) => void
}

const initial = periodForPreset('this_month')

export const usePeriodStore = create<PeriodState>()(
  persist(
    (set) => ({
      preset: 'this_month',
      from: initial.start,
      to: initial.end,
      set: (preset, from, to) => set({ preset, from, to }),
    }),
    {
      name: 'period-storage',
      // sessionStorage — 브라우저 닫으면 기본값으로 (탭 닫으면 초기화)
      // localStorage 원하면 createJSONStorage(() => localStorage)
    }
  )
)
