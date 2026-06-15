import { ReactNode } from 'react'
import Sparkline from './Sparkline'

type Tone = 'primary' | 'success' | 'warning' | 'danger' | 'neutral' | 'mint'

const toneClasses: Record<Tone, { dot: string; text: string }> = {
  primary: { dot: 'bg-primary-500', text: 'text-primary-700' },
  success: { dot: 'bg-emerald-500', text: 'text-emerald-700' },
  warning: { dot: 'bg-amber-500', text: 'text-amber-700' },
  danger: { dot: 'bg-rose-500', text: 'text-rose-700' },
  neutral: { dot: 'bg-ink-400', text: 'text-ink-700' },
  mint: { dot: 'bg-primary-500', text: 'text-primary-700' },
}

interface StatCardProps {
  label: string
  value: string | number
  unit?: string
  hint?: string
  delta?: { value: string; positive?: boolean }
  icon?: ReactNode
  tone?: Tone
  trend?: number[]
  loading?: boolean
}

export default function StatCard({
  label,
  value,
  unit,
  hint,
  delta,
  icon,
  tone = 'neutral',
  trend,
  loading = false,
}: StatCardProps) {
  const t = toneClasses[tone]

  if (loading) {
    return (
      <div className="card animate-pulse">
        <div className="h-3 bg-ink-100 rounded w-20" />
        <div className="h-7 bg-ink-100 rounded mt-3 w-32" />
        <div className="h-2.5 bg-ink-100 rounded mt-2 w-24" />
      </div>
    )
  }

  const sparkColors: Record<Tone, { stroke: string; fill: string }> = {
    primary: { stroke: '#0d8e88', fill: 'rgba(13,142,136,0.10)' },
    mint:    { stroke: '#0d8e88', fill: 'rgba(13,142,136,0.10)' },
    success: { stroke: '#10b981', fill: 'rgba(16,185,129,0.10)' },
    warning: { stroke: '#f59e0b', fill: 'rgba(245,158,11,0.10)' },
    danger:  { stroke: '#ef4444', fill: 'rgba(239,68,68,0.10)' },
    neutral: { stroke: '#71717a', fill: 'rgba(113,113,122,0.10)' },
  }
  const spark = sparkColors[tone]

  return (
    <div className="card hover:border-ink-300 transition-colors duration-150">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className={`w-1 h-1 rounded-full ${t.dot} flex-shrink-0`} />
          <span className="text-2xs font-medium text-ink-500 uppercase tracking-wider truncate">
            {label}
          </span>
        </div>
        {icon && <span className={`${t.text} flex-shrink-0`}>{icon}</span>}
      </div>

      <div className="mt-2.5 flex items-baseline gap-1">
        <span className="text-xl font-semibold text-ink-900 tabular-nums tracking-tightish">
          {value}
        </span>
        {unit && <span className="text-xs text-ink-400 font-medium">{unit}</span>}
      </div>

      <div className="mt-1.5 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-2xs min-w-0">
          {delta && (
            <span
              className={`font-semibold tabular-nums flex-shrink-0 ${
                delta.positive ? 'text-emerald-600' : 'text-rose-600'
              }`}
            >
              {delta.positive ? '↑' : '↓'} {delta.value}
            </span>
          )}
          {hint && <span className="text-ink-400 truncate">{hint}</span>}
        </div>
        {trend && trend.length > 1 && (
          <Sparkline values={trend} width={56} height={18} stroke={spark.stroke} fill={spark.fill} />
        )}
      </div>
    </div>
  )
}
