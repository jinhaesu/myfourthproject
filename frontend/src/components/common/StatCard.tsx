import { ReactNode } from 'react'

type Tone = 'primary' | 'success' | 'warning' | 'danger' | 'neutral' | 'mint'

const toneClasses: Record<Tone, { bg: string; text: string; ring: string }> = {
  primary: { bg: 'bg-primary-50', text: 'text-primary-700', ring: 'ring-primary-100' },
  success: { bg: 'bg-emerald-50', text: 'text-emerald-700', ring: 'ring-emerald-100' },
  warning: { bg: 'bg-amber-50', text: 'text-amber-700', ring: 'ring-amber-100' },
  danger: { bg: 'bg-rose-50', text: 'text-rose-700', ring: 'ring-rose-100' },
  neutral: { bg: 'bg-gray-50', text: 'text-gray-700', ring: 'ring-gray-100' },
  mint: { bg: 'bg-teal-50', text: 'text-teal-700', ring: 'ring-teal-100' },
}

interface StatCardProps {
  label: string
  value: string | number
  unit?: string
  hint?: string
  delta?: { value: string; positive?: boolean }
  icon?: ReactNode
  tone?: Tone
}

export default function StatCard({ label, value, unit, hint, delta, icon, tone = 'primary' }: StatCardProps) {
  const classes = toneClasses[tone]
  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-5">
      <div className="flex items-start justify-between">
        <div className="text-sm text-gray-500">{label}</div>
        {icon && (
          <div className={`p-2 rounded-md ${classes.bg} ${classes.text} ring-1 ${classes.ring}`}>{icon}</div>
        )}
      </div>
      <div className="mt-2 flex items-baseline gap-1">
        <div className="text-2xl font-bold text-gray-900 tabular-nums">{value}</div>
        {unit && <div className="text-sm text-gray-500">{unit}</div>}
      </div>
      {(hint || delta) && (
        <div className="mt-2 flex items-center gap-2 text-xs">
          {delta && (
            <span className={delta.positive ? 'text-emerald-600 font-medium' : 'text-rose-600 font-medium'}>
              {delta.positive ? '▲' : '▼'} {delta.value}
            </span>
          )}
          {hint && <span className="text-gray-400">{hint}</span>}
        </div>
      )}
    </div>
  )
}
