/**
 * Tiny inline sparkline — no external chart lib, pure SVG.
 * Used in KPI cards and account rows for a sense of trend at a glance.
 */
interface SparklineProps {
  values: number[]
  width?: number
  height?: number
  stroke?: string
  fill?: string
  showDots?: boolean
}

export default function Sparkline({
  values,
  width = 80,
  height = 24,
  stroke = '#0d8e88',
  fill = 'rgba(13, 142, 136, 0.08)',
  showDots = false,
}: SparklineProps) {
  if (!values || values.length === 0) {
    return <div style={{ width, height }} className="bg-ink-50 rounded" />
  }

  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min || 1
  const step = values.length > 1 ? width / (values.length - 1) : 0

  const points = values
    .map((v, i) => {
      const x = i * step
      const y = height - ((v - min) / range) * (height - 2) - 1
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')

  const areaPath = `M0,${height} L${points
    .split(' ')
    .map((p) => p)
    .join(' L')} L${width},${height} Z`

  return (
    <svg width={width} height={height} className="overflow-visible">
      <path d={areaPath} fill={fill} />
      <polyline points={points} fill="none" stroke={stroke} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
      {showDots && values.map((v, i) => {
        const x = i * step
        const y = height - ((v - min) / range) * (height - 2) - 1
        return <circle key={i} cx={x} cy={y} r={1.5} fill={stroke} />
      })}
    </svg>
  )
}
