import { CalendarDaysIcon } from '@heroicons/react/24/outline'

export type PeriodPreset =
  | 'today'
  | 'yesterday'
  | 'this_week'
  | 'last_week'
  | 'this_month'
  | 'last_month'
  | 'this_quarter'
  | 'last_quarter'
  | 'this_year'
  | 'last_year'
  | 'last_7d'
  | 'last_30d'
  | 'custom'

const PRESET_LABEL: Record<PeriodPreset, string> = {
  today: '오늘',
  yesterday: '어제',
  this_week: '이번주',
  last_week: '지난주',
  this_month: '이번달',
  last_month: '지난달',
  this_quarter: '이번분기',
  last_quarter: '지난분기',
  this_year: '올해',
  last_year: '작년',
  last_7d: '7일',
  last_30d: '30일',
  custom: '사용자',
}

export const PRESET_GROUPS: { label: string; presets: PeriodPreset[] }[] = [
  { label: '일/주', presets: ['today', 'yesterday', 'this_week', 'last_week'] },
  { label: '월', presets: ['this_month', 'last_month'] },
  { label: '분기/연', presets: ['this_quarter', 'last_quarter', 'this_year', 'last_year'] },
  { label: '범위', presets: ['last_7d', 'last_30d'] },
]

// 로컬 timezone 기준 yyyy-MM-dd (toISOString은 UTC 기준이라 KST 자정이 전날로 변환되는 버그 방지)
const iso = (d: Date) => {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function periodForPreset(preset: PeriodPreset): { start: string; end: string } {
  const today = new Date()
  const y = today.getFullYear()
  const m = today.getMonth()
  const d = today.getDate()

  switch (preset) {
    case 'today':
      return { start: iso(today), end: iso(today) }
    case 'yesterday': {
      const yest = new Date(today)
      yest.setDate(d - 1)
      return { start: iso(yest), end: iso(yest) }
    }
    case 'this_week': {
      const dayOfWeek = today.getDay() || 7
      const monday = new Date(today)
      monday.setDate(d - dayOfWeek + 1)
      return { start: iso(monday), end: iso(today) }
    }
    case 'last_week': {
      const dayOfWeek = today.getDay() || 7
      const lastMon = new Date(today)
      lastMon.setDate(d - dayOfWeek + 1 - 7)
      const lastSun = new Date(lastMon)
      lastSun.setDate(lastMon.getDate() + 6)
      return { start: iso(lastMon), end: iso(lastSun) }
    }
    case 'this_month':
      return { start: iso(new Date(y, m, 1)), end: iso(today) }
    case 'last_month': {
      const lastStart = new Date(y, m - 1, 1)
      const lastEnd = new Date(y, m, 0)
      return { start: iso(lastStart), end: iso(lastEnd) }
    }
    case 'this_quarter': {
      const qStart = Math.floor(m / 3) * 3
      return { start: iso(new Date(y, qStart, 1)), end: iso(today) }
    }
    case 'last_quarter': {
      const qStart = Math.floor(m / 3) * 3 - 3
      const adjY = qStart < 0 ? y - 1 : y
      const adjStart = qStart < 0 ? qStart + 12 : qStart
      const startDate = new Date(adjY, adjStart, 1)
      const endDate = new Date(adjY, adjStart + 3, 0)
      return { start: iso(startDate), end: iso(endDate) }
    }
    case 'this_year':
      return { start: `${y}-01-01`, end: iso(today) }
    case 'last_year':
      return { start: `${y - 1}-01-01`, end: `${y - 1}-12-31` }
    case 'last_7d': {
      const start = new Date(today)
      start.setDate(d - 6)
      return { start: iso(start), end: iso(today) }
    }
    case 'last_30d': {
      const start = new Date(today)
      start.setDate(d - 29)
      return { start: iso(start), end: iso(today) }
    }
    default:
      return { start: '', end: '' }
  }
}

interface PeriodPickerProps {
  preset: PeriodPreset
  from: string
  to: string
  onChange: (preset: PeriodPreset, from: string, to: string) => void
  /** 표시할 프리셋 그룹 (default: 모두) */
  groups?: { label: string; presets: PeriodPreset[] }[]
}

export default function PeriodPicker({
  preset,
  from,
  to,
  onChange,
  groups = PRESET_GROUPS,
}: PeriodPickerProps) {
  const handlePreset = (p: PeriodPreset) => {
    if (p === 'custom') {
      onChange('custom', from, to)
      return
    }
    const r = periodForPreset(p)
    onChange(p, r.start, r.end)
  }

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {groups.map((g, gi) => (
        <div
          key={gi}
          className="flex items-center gap-0.5 p-0.5 rounded-md bg-white border border-ink-200"
        >
          {g.presets.map((p) => (
            <button
              key={p}
              onClick={() => handlePreset(p)}
              className={`px-2 py-1 rounded text-2xs font-semibold transition ${
                preset === p ? 'bg-ink-900 text-white' : 'text-ink-600 hover:bg-ink-50'
              }`}
            >
              {PRESET_LABEL[p]}
            </button>
          ))}
        </div>
      ))}
      <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-white border border-ink-200">
        <CalendarDaysIcon className="h-3 w-3 text-ink-400" />
        <input
          type="date"
          value={from}
          onChange={(e) => onChange('custom', e.target.value, to)}
          className="bg-transparent text-2xs text-ink-700 w-24 focus:outline-none"
        />
        <span className="text-ink-300">→</span>
        <input
          type="date"
          value={to}
          onChange={(e) => onChange('custom', from, e.target.value)}
          className="bg-transparent text-2xs text-ink-700 w-24 focus:outline-none"
        />
      </div>
    </div>
  )
}
