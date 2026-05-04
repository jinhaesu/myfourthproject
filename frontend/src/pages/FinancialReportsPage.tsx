import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  CalendarDaysIcon,
  ArrowDownTrayIcon,
  TableCellsIcon,
  ArrowPathIcon,
} from '@heroicons/react/24/outline'
import { cashPLApi, ledgerApi } from '@/services/api'
import { formatCurrency, formatPct } from '@/utils/format'

type PeriodType = 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'yearly'

const PERIOD_LABEL: Record<PeriodType, string> = {
  daily: '일',
  weekly: '주',
  monthly: '월',
  quarterly: '분기',
  yearly: '년',
}

interface Summary {
  period_label: string
  period_start: string
  period_end: string
  revenue: number | string
  cogs: number | string
  gross_profit: number | string
  gross_margin_pct: number
  opex: number | string
  operating_profit: number | string
  operating_margin_pct: number
  non_operating_income: number | string
  non_operating_expense: number | string
  net_profit: number | string
  net_margin_pct: number
}

type RowKind = 'header' | 'data' | 'subtotal' | 'ratio' | 'spacer'

interface RowDef {
  kind: RowKind
  label: string
  level?: number  // 0 root, 1 sub, 2 subsub
  pick: (s: Summary) => number  // 해당 기간의 값
  isPct?: boolean
  emphasize?: boolean
}

const ROW_DEFS: RowDef[] = [
  { kind: 'header', label: 'I. 매출액', level: 0, pick: (s) => Number(s.revenue) },

  { kind: 'header', label: 'II. 매출원가', level: 0, pick: (s) => Number(s.cogs) },
  { kind: 'ratio', label: '   매출원가율', level: 1, pick: (s) => (Number(s.revenue) ? (Number(s.cogs) / Number(s.revenue)) * 100 : 0), isPct: true },

  { kind: 'subtotal', label: 'III. 매출총이익 (I − II)', level: 0, pick: (s) => Number(s.gross_profit), emphasize: true },
  { kind: 'ratio', label: '   매출총이익률', level: 1, pick: (s) => Number(s.gross_margin_pct), isPct: true },

  { kind: 'spacer', label: '', pick: () => 0 },

  { kind: 'header', label: 'IV. 판매비와관리비', level: 0, pick: (s) => Number(s.opex) },
  { kind: 'ratio', label: '   판관비율', level: 1, pick: (s) => (Number(s.revenue) ? (Number(s.opex) / Number(s.revenue)) * 100 : 0), isPct: true },

  { kind: 'subtotal', label: 'V. 영업이익 (III − IV)', level: 0, pick: (s) => Number(s.operating_profit), emphasize: true },
  { kind: 'ratio', label: '   영업이익률', level: 1, pick: (s) => Number(s.operating_margin_pct), isPct: true },

  { kind: 'spacer', label: '', pick: () => 0 },

  { kind: 'header', label: 'VI. 영업외수익', level: 0, pick: (s) => Number(s.non_operating_income) },
  { kind: 'header', label: 'VII. 영업외비용', level: 0, pick: (s) => Number(s.non_operating_expense) },

  { kind: 'subtotal', label: 'VIII. 당기순이익', level: 0, pick: (s) => Number(s.net_profit), emphasize: true },
  { kind: 'ratio', label: '   순이익률', level: 1, pick: (s) => Number(s.net_margin_pct), isPct: true },
]

function startOfYearISO(year: number) {
  return `${year}-01-01`
}
function endOfYearISO(year: number) {
  return `${year}-12-31`
}

export default function FinancialReportsPage() {
  // 가용 년도 자동 감지 (ledger와 동일)
  const yearsQuery = useQuery({
    queryKey: ['ledger-years'],
    queryFn: () => ledgerApi.getAvailableYears().then((r) => r.data),
  })
  const latestYear: number | null = yearsQuery.data?.latest ?? null

  const [periodType, setPeriodType] = useState<PeriodType>('monthly')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')

  useEffect(() => {
    if (latestYear && (!fromDate || !toDate)) {
      setFromDate(startOfYearISO(latestYear))
      setToDate(endOfYearISO(latestYear))
    }
  }, [latestYear]) // eslint-disable-line react-hooks/exhaustive-deps

  const ready = Boolean(fromDate && toDate)

  const plQuery = useQuery({
    queryKey: ['financial-pl', periodType, fromDate, toDate],
    queryFn: () =>
      cashPLApi
        .getCashPL({ from_date: fromDate, to_date: toDate, basis: 'cash', period_type: periodType })
        .then((r) => r.data),
    enabled: ready,
  })

  const summaries: Summary[] = useMemo(() => plQuery.data?.summaries || [], [plQuery.data])

  // 합계 컬럼 (전 기간 합산)
  const totals: Summary | null = useMemo(() => {
    if (!summaries.length) return null
    const sum = (key: keyof Summary) => summaries.reduce((acc, s) => acc + Number(s[key] || 0), 0)
    const revenue = sum('revenue')
    const cogs = sum('cogs')
    const opex = sum('opex')
    const gross = revenue - cogs
    const op = gross - opex
    const nopExp = sum('non_operating_expense')
    const net = op - nopExp
    const pct = (n: number) => (revenue ? (n / revenue) * 100 : 0)
    return {
      period_label: '합계',
      period_start: fromDate,
      period_end: toDate,
      revenue,
      cogs,
      gross_profit: gross,
      gross_margin_pct: pct(gross),
      opex,
      operating_profit: op,
      operating_margin_pct: pct(op),
      non_operating_income: sum('non_operating_income'),
      non_operating_expense: nopExp,
      net_profit: net,
      net_margin_pct: pct(net),
    }
  }, [summaries, fromDate, toDate])

  const allColumns: Summary[] = totals ? [...summaries, totals] : summaries

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-end justify-between flex-wrap gap-2">
        <div>
          <h1 className="flex items-center gap-2">
            <TableCellsIcon className="h-4 w-4 text-ink-500" />
            재무보고서
          </h1>
          <p className="text-2xs text-ink-500 mt-0.5">
            기간별 손익 비교표 (cross-tab) · 현금주의 기준
          </p>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          {/* Period type 토글 */}
          <div className="flex items-center gap-0.5 p-0.5 rounded-md bg-white border border-ink-200">
            {(['daily', 'weekly', 'monthly', 'quarterly', 'yearly'] as PeriodType[]).map((p) => (
              <button
                key={p}
                onClick={() => setPeriodType(p)}
                className={`px-2.5 py-1 rounded text-2xs font-semibold transition ${
                  periodType === p
                    ? 'bg-ink-900 text-white'
                    : 'text-ink-600 hover:bg-ink-50'
                }`}
              >
                {PERIOD_LABEL[p]}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-white border border-ink-200">
            <CalendarDaysIcon className="h-3 w-3 text-ink-400" />
            <input
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
              className="bg-transparent text-2xs font-medium text-ink-700 focus:outline-none w-24"
            />
            <span className="text-ink-300">→</span>
            <input
              type="date"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
              className="bg-transparent text-2xs font-medium text-ink-700 focus:outline-none w-24"
            />
          </div>

          <button onClick={() => plQuery.refetch()} className="btn-secondary" title="새로고침">
            <ArrowPathIcon className="h-3 w-3" />
          </button>
          <button className="btn-secondary">
            <ArrowDownTrayIcon className="h-3 w-3 mr-1" />
            엑셀
          </button>
        </div>
      </div>

      {/* Cross-tab P&L */}
      <div className="panel overflow-hidden">
        {plQuery.isLoading ? (
          <div className="p-8 text-center text-2xs text-ink-400">
            불러오는 중…
          </div>
        ) : summaries.length === 0 ? (
          <div className="p-8 text-center text-2xs text-ink-400">
            이 기간에 데이터가 없습니다.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-2xs">
              <thead>
                <tr className="bg-canvas-50 border-b border-ink-200">
                  <th className="sticky left-0 bg-canvas-50 z-10 px-3 py-2 text-left font-semibold text-ink-500 uppercase tracking-wider min-w-[200px] border-r border-ink-200">
                    계정과목
                  </th>
                  {summaries.map((s) => (
                    <th
                      key={s.period_label}
                      className="px-3 py-2 text-right font-semibold text-ink-500 uppercase tracking-wider min-w-[110px]"
                    >
                      {s.period_label}
                    </th>
                  ))}
                  <th className="px-3 py-2 text-right font-semibold text-ink-700 uppercase tracking-wider min-w-[120px] bg-ink-100">
                    합계
                  </th>
                </tr>
              </thead>
              <tbody>
                {ROW_DEFS.map((row, idx) => {
                  if (row.kind === 'spacer') {
                    return (
                      <tr key={`spacer-${idx}`}>
                        <td colSpan={summaries.length + 2} className="h-2 bg-canvas-50 border-y border-ink-200/40" />
                      </tr>
                    )
                  }

                  const isSubtotal = row.kind === 'subtotal'
                  const isHeader = row.kind === 'header'
                  const isRatio = row.kind === 'ratio'

                  return (
                    <tr
                      key={`row-${idx}`}
                      className={
                        isSubtotal
                          ? 'bg-canvas-50 border-y border-ink-200'
                          : isRatio
                          ? 'bg-white'
                          : 'hover:bg-canvas-50/50'
                      }
                    >
                      <td
                        className={`sticky left-0 z-10 px-3 py-1.5 border-r border-ink-200 whitespace-nowrap ${
                          isSubtotal
                            ? 'bg-canvas-50 font-bold text-ink-900'
                            : isRatio
                            ? 'bg-white text-ink-500 font-medium pl-6'
                            : isHeader
                            ? 'bg-white text-ink-700 font-semibold'
                            : 'bg-white text-ink-700'
                        }`}
                      >
                        {row.label}
                      </td>
                      {allColumns.map((col, ci) => {
                        const v = row.pick(col)
                        const isTotalCol = ci === allColumns.length - 1
                        return (
                          <td
                            key={`${row.label}-${col.period_label}`}
                            className={`px-3 py-1.5 text-right font-mono tabular-nums whitespace-nowrap ${
                              isTotalCol
                                ? 'bg-ink-50 font-bold text-ink-900'
                                : isSubtotal
                                ? 'bg-canvas-50 font-semibold text-ink-900'
                                : isRatio
                                ? 'text-ink-500 text-2xs italic'
                                : 'text-ink-700'
                            }`}
                          >
                            {row.isPct
                              ? formatPct(v, 1)
                              : v === 0
                              ? <span className="text-ink-300">-</span>
                              : (v < 0 ? <span className="text-rose-600">({formatCurrency(Math.abs(v), false)})</span> : formatCurrency(v, false))}
                          </td>
                        )
                      })}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Footnote */}
      <div className="text-2xs text-ink-400 px-1">
        ※ 현금주의 기준. 발생주의(세금계산서 발생일)와 다를 수 있습니다. 음수는 ( )로 표시.
      </div>
    </div>
  )
}
