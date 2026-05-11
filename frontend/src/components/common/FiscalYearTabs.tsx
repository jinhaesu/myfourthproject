/**
 * 회계연도 선택 탭 — 당해 포함 5개년 (예: 2022/2023/2024/2025/2026).
 * 회계/분석 섹션의 모든 페이지에서 공통 사용.
 *
 * 사용 예:
 *   <FiscalYearTabs year={year} onChange={setYear} />
 *
 * 페이지의 from/to 상태와 연동 시:
 *   onChange={(y) => {
 *     setYear(y)
 *     setPeriodStart(`${y}-01-01`)
 *     setPeriodEnd(y === currentYear ? todayISO() : `${y}-12-31`)
 *   }}
 */
interface FiscalYearTabsProps {
  year: number
  onChange: (y: number) => void
  /** 표시할 년수 (default 5: 당해 포함 직전 4년) */
  span?: number
  /** "당해" 표시 여부 (default true) */
  showCurrentLabel?: boolean
  /** 작게 표시 (default false) */
  compact?: boolean
}

export default function FiscalYearTabs({
  year,
  onChange,
  span = 5,
  showCurrentLabel = true,
  compact = false,
}: FiscalYearTabsProps) {
  const currentYear = new Date().getFullYear()
  const years: number[] = []
  for (let i = span - 1; i >= 0; i--) years.push(currentYear - i)

  const padX = compact ? 'px-2' : 'px-3'
  const padY = compact ? 'py-0.5' : 'py-1'

  return (
    <div className="flex items-center gap-0.5 p-0.5 rounded-md bg-white border border-ink-200 w-fit">
      {years.map((y) => (
        <button
          key={y}
          onClick={() => onChange(y)}
          className={`${padX} ${padY} rounded text-2xs font-semibold transition ${
            year === y ? 'bg-ink-900 text-white' : 'text-ink-600 hover:bg-ink-50'
          }`}
        >
          {y}
          {showCurrentLabel && y === currentYear && (
            <span className="ml-1 text-2xs opacity-70">(당해)</span>
          )}
        </button>
      ))}
    </div>
  )
}
