import { isoLocal } from '@/utils/format'

/** 기간 프리셋 → {from, to} (로컬 날짜) */
export function presetRange(key: string): { from: string; to: string } {
  const now = new Date()
  const y = now.getFullYear()
  const m = now.getMonth()
  const iso = (d: Date) => isoLocal(d)
  const daysAgo = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return d }

  switch (key) {
    case '7d': return { from: iso(daysAgo(6)), to: iso(now) }
    case '14d': return { from: iso(daysAgo(13)), to: iso(now) }
    case '30d': return { from: iso(daysAgo(29)), to: iso(now) }
    case 'this_month': return { from: iso(new Date(y, m, 1)), to: iso(now) }
    case 'last_month': return { from: iso(new Date(y, m - 1, 1)), to: iso(new Date(y, m, 0)) }
    case '3m_ago': { // 3개월 전 한 달
      const s = new Date(y, m - 3, 1); const e = new Date(y, m - 2, 0)
      return { from: iso(s), to: iso(e) }
    }
    case '3m': return { from: iso(new Date(y, m - 2, 1)), to: iso(now) } // 최근 3개월
    case 'this_year': return { from: iso(new Date(y, 0, 1)), to: iso(now) }
    case 'last_year': return { from: iso(new Date(y - 1, 0, 1)), to: iso(new Date(y - 1, 11, 31)) }
    default: return { from: iso(daysAgo(29)), to: iso(now) }
  }
}

const PRESETS: { key: string; label: string }[] = [
  { key: '7d', label: '7일' },
  { key: '14d', label: '14일' },
  { key: '30d', label: '30일' },
  { key: 'this_month', label: '당월' },
  { key: 'last_month', label: '전월' },
  { key: '3m', label: '최근3개월' },
  { key: '3m_ago', label: '3개월전' },
  { key: 'this_year', label: '올해' },
  { key: 'last_year', label: '작년' },
]

/** 기간 프리셋 토글 버튼 행 */
export default function DateRangePresets({
  from, to, onChange, presets = PRESETS,
}: {
  from: string
  to: string
  onChange: (from: string, to: string) => void
  presets?: { key: string; label: string }[]
}) {
  return (
    <div className="flex items-center gap-1 flex-wrap">
      {presets.map((p) => {
        const r = presetRange(p.key)
        const active = r.from === from && r.to === to
        return (
          <button
            key={p.key}
            onClick={() => onChange(r.from, r.to)}
            className={`px-2 py-1 text-2xs rounded-full border transition ${
              active
                ? 'bg-ink-900 text-white border-ink-900'
                : 'bg-white text-ink-600 border-ink-200 hover:border-ink-400'
            }`}
          >
            {p.label}
          </button>
        )
      })}
    </div>
  )
}
