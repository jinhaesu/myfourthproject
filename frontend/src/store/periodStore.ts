import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { periodForPreset, type PeriodPreset } from '@/components/common/PeriodPicker'

/**
 * 글로벌 기간(from/to/preset) 상태 — 기간 선택 메뉴 전체가 공유.
 *
 * 규칙:
 * - 기본 preset = 'last_30d' (오늘 기준 최근 1개월).
 * - preset이 동적(last_30d/this_month 등)이면 접속(복원)할 때마다 today 기준으로 재계산.
 * - 사용자가 'custom'으로 직접 지정한 값은 12시간 동안만 유지되고,
 *   12시간 경과 후 새로 접속하면 기본(오늘 기준 1개월)으로 자동 리셋.
 * - lastSet = 사용자가 마지막으로 기간을 직접 설정한 시각(ms). 재앵커링은 타이머를 갱신하지 않음.
 */
interface PeriodState {
  preset: PeriodPreset
  from: string
  to: string
  lastSet: number
  set: (preset: PeriodPreset, from: string, to: string) => void
}

const DEFAULT_PRESET: PeriodPreset = 'last_30d'
const STALE_MS = 12 * 60 * 60 * 1000  // 12시간 경과 시 오늘 기준으로 리셋
const initial = periodForPreset(DEFAULT_PRESET)

function nowMs(): number {
  return new Date().getTime()
}

export const usePeriodStore = create<PeriodState>()(
  persist(
    (set) => ({
      preset: DEFAULT_PRESET,
      from: initial.start,
      to: initial.end,
      lastSet: nowMs(),
      set: (preset, from, to) => set({ preset, from, to, lastSet: nowMs() }),
    }),
    {
      name: 'period-storage',
      // 버전 변경 → 이전 저장값(구 기본 last_7d 등) 무효화하고 새 기본으로 시작
      version: 4,
      migrate: () => {
        const r = periodForPreset(DEFAULT_PRESET)
        return {
          preset: DEFAULT_PRESET,
          from: r.start,
          to: r.end,
          lastSet: nowMs(),
          set: () => {},  // store가 실제 set을 덮어씀
        } as PeriodState
      },
      // 복원(접속) 직후:
      //  - 마지막 설정 후 12시간 초과 → 기본(오늘 기준 1개월)으로 리셋
      //  - 12시간 이내 & 동적 preset → today 기준 재앵커링(항상 최신)
      //  - 12시간 이내 & custom → 저장된 사용자 지정값 유지
      onRehydrateStorage: () => (state) => {
        if (!state) return
        const age = nowMs() - (state.lastSet || 0)
        if (age > STALE_MS) {
          const r = periodForPreset(DEFAULT_PRESET)
          usePeriodStore.setState({ preset: DEFAULT_PRESET, from: r.start, to: r.end, lastSet: nowMs() })
        } else if (state.preset !== 'custom') {
          const r = periodForPreset(state.preset)
          usePeriodStore.setState({ from: r.start, to: r.end })
        }
      },
    }
  )
)
