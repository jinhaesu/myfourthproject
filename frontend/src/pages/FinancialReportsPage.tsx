import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  CalendarDaysIcon,
  ArrowDownTrayIcon,
  TableCellsIcon,
  ArrowPathIcon,
  ChevronDownIcon,
  ChevronRightIcon,
} from '@heroicons/react/24/outline'
import { cashPLApi, ledgerApi, financialApi } from '@/services/api'
import { formatCurrency, formatPct } from '@/utils/format'
import FiscalYearTabs from '@/components/common/FiscalYearTabs'

type ViewMode = 'pl' | 'bs'

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
  level?: number
  pick: (s: Summary) => number
  isPct?: boolean
  emphasize?: boolean
  expandKey?: 'revenue' | 'cogs' | 'opex' | 'non_operating'  // 펼치기 가능한 행
}

const ROW_DEFS: RowDef[] = [
  { kind: 'header', label: 'I. 매출액', level: 0, pick: (s) => Number(s.revenue), expandKey: 'revenue' },

  { kind: 'header', label: 'II. 매출원가', level: 0, pick: (s) => Number(s.cogs), expandKey: 'cogs' },
  { kind: 'ratio', label: '   매출원가율', level: 1, pick: (s) => (Number(s.revenue) ? (Number(s.cogs) / Number(s.revenue)) * 100 : 0), isPct: true },

  { kind: 'subtotal', label: 'III. 매출총이익 (I − II)', level: 0, pick: (s) => Number(s.gross_profit), emphasize: true },
  { kind: 'ratio', label: '   매출총이익률', level: 1, pick: (s) => Number(s.gross_margin_pct), isPct: true },

  { kind: 'spacer', label: '', pick: () => 0 },

  { kind: 'header', label: 'IV. 판매비와관리비', level: 0, pick: (s) => Number(s.opex), expandKey: 'opex' },
  { kind: 'ratio', label: '   판관비율', level: 1, pick: (s) => (Number(s.revenue) ? (Number(s.opex) / Number(s.revenue)) * 100 : 0), isPct: true },

  { kind: 'subtotal', label: 'V. 영업이익 (III − IV)', level: 0, pick: (s) => Number(s.operating_profit), emphasize: true },
  { kind: 'ratio', label: '   영업이익률', level: 1, pick: (s) => Number(s.operating_margin_pct), isPct: true },

  { kind: 'spacer', label: '', pick: () => 0 },

  { kind: 'header', label: 'VI. 영업외 (수익/비용)', level: 0, pick: (s) => Number(s.non_operating_income) - Number(s.non_operating_expense), expandKey: 'non_operating' },

  { kind: 'subtotal', label: 'VII. 당기순이익', level: 0, pick: (s) => Number(s.net_profit), emphasize: true },
  { kind: 'ratio', label: '   순이익률', level: 1, pick: (s) => Number(s.net_margin_pct), isPct: true },
]

function startOfYearISO(year: number) {
  return `${year}-01-01`
}
function endOfYearISO(year: number) {
  return `${year}-12-31`
}

export default function FinancialReportsPage() {
  // 가용 년도 (빈 결과 시 빠른 이동용 — 데이터 있는 년도 안내)
  const yearsQuery = useQuery({
    queryKey: ['ledger-years'],
    queryFn: () => ledgerApi.getAvailableYears().then((r) => r.data),
  })

  // 기본: 이번 회계연도 (오늘 기준 1.1 ~ 12.31), 사용자가 직접 변경 가능
  const [periodType, setPeriodType] = useState<PeriodType>('monthly')
  const _today = new Date()
  const _thisYear = _today.getFullYear()
  const [fiscalYear, setFiscalYear] = useState(_thisYear)
  const [fromDate, setFromDate] = useState(startOfYearISO(_thisYear))
  const [toDate, setToDate] = useState(endOfYearISO(_thisYear))

  const availableYears: number[] = yearsQuery.data?.years || []

  const ready = Boolean(fromDate && toDate)

  const plQuery = useQuery({
    queryKey: ['financial-pl', periodType, fromDate, toDate],
    queryFn: () =>
      cashPLApi
        .getCashPL({ from_date: fromDate, to_date: toDate, basis: 'cash', period_type: periodType })
        .then((r) => r.data),
    enabled: ready,
  })

  const breakdownQuery = useQuery({
    queryKey: ['financial-breakdown', periodType, fromDate, toDate],
    queryFn: () =>
      cashPLApi
        .getByAccountCrossTab({ from_date: fromDate, to_date: toDate, basis: 'cash', period_type: periodType })
        .then((r) => r.data),
    enabled: ready,
  })

  const [viewMode, setViewMode] = useState<ViewMode>('pl')

  const bsQuery = useQuery({
    queryKey: ['financial-bs-monthly', fiscalYear],
    queryFn: () => financialApi.getBalanceSheetMonthly(fiscalYear).then((r) => r.data),
    enabled: viewMode === 'bs',
  })

  const [expanded, setExpanded] = useState<Set<string>>(new Set(['opex']))
  const toggle = (key: string) => {
    const next = new Set(expanded)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setExpanded(next)
  }

  const summaries: Summary[] = useMemo(() => plQuery.data?.summaries || [], [plQuery.data])
  const breakdown: any = breakdownQuery.data

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
            {viewMode === 'pl' ? '기간별 손익계산서 (cross-tab) · 현금주의' : '월별 재무상태표 — 각 월말의 누적 잔액'}
          </p>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          {/* View 토글 (P&L / BS) */}
          <div className="flex items-center gap-0.5 p-0.5 rounded-md bg-white border border-ink-200">
            <button
              onClick={() => setViewMode('pl')}
              className={`px-2.5 py-1 rounded text-2xs font-semibold transition ${
                viewMode === 'pl' ? 'bg-ink-900 text-white' : 'text-ink-600 hover:bg-ink-50'
              }`}
            >
              손익계산서
            </button>
            <button
              onClick={() => setViewMode('bs')}
              className={`px-2.5 py-1 rounded text-2xs font-semibold transition ${
                viewMode === 'bs' ? 'bg-ink-900 text-white' : 'text-ink-600 hover:bg-ink-50'
              }`}
            >
              재무상태표
            </button>
          </div>
          <FiscalYearTabs
            year={fiscalYear}
            onChange={(y) => {
              setFiscalYear(y)
              setFromDate(startOfYearISO(y))
              setToDate(y === _thisYear ? new Date().toISOString().slice(0, 10) : endOfYearISO(y))
            }}
          />
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

      {viewMode === 'bs' && (
        <MonthlyBSPanel
          data={bsQuery.data}
          loading={bsQuery.isLoading}
          availableYears={availableYears}
          onPickYear={(y) => setFiscalYear(y)}
        />
      )}

      {viewMode === 'pl' && (<>
      {/* Cross-tab P&L */}
      <div className="panel overflow-hidden">
        {plQuery.isLoading ? (
          <div className="p-8 text-center text-2xs text-ink-400">
            불러오는 중…
          </div>
        ) : summaries.length === 0 ? (
          <div className="p-8 text-center text-2xs text-ink-400">
            <div>이 기간에 데이터가 없습니다.</div>
            {availableYears.length > 0 && (
              <div className="mt-3 inline-flex items-center gap-1.5">
                <span>데이터 있는 년도:</span>
                {availableYears.slice(0, 5).map((y) => (
                  <button
                    key={y}
                    onClick={() => {
                      setFromDate(startOfYearISO(y))
                      setToDate(endOfYearISO(y))
                    }}
                    className="px-2 py-0.5 rounded border border-ink-200 bg-white text-ink-700 hover:bg-ink-50 font-semibold"
                  >
                    {y}
                  </button>
                ))}
              </div>
            )}
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
                  const expandable = !!row.expandKey
                  const isExpanded = expandable && expanded.has(row.expandKey!)
                  const subAccounts: any[] = expandable && breakdown?.accounts?.[row.expandKey!]
                    ? breakdown.accounts[row.expandKey!]
                    : []

                  return (
                    <>
                      <tr
                        key={`row-${idx}`}
                        className={
                          isSubtotal
                            ? 'bg-canvas-50 border-y border-ink-200'
                            : isRatio
                            ? 'bg-white'
                            : expandable
                            ? 'hover:bg-canvas-50/50 cursor-pointer'
                            : 'hover:bg-canvas-50/50'
                        }
                        onClick={() => expandable && toggle(row.expandKey!)}
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
                          <span className="inline-flex items-center gap-1">
                            {expandable && (
                              <span className="text-ink-400">
                                {isExpanded ? (
                                  <ChevronDownIcon className="h-3 w-3" />
                                ) : (
                                  <ChevronRightIcon className="h-3 w-3" />
                                )}
                              </span>
                            )}
                            {row.label}
                            {expandable && subAccounts.length > 0 && (
                              <span className="text-2xs text-ink-400 font-normal ml-0.5">
                                ({subAccounts.length})
                              </span>
                            )}
                          </span>
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

                      {/* Sub-rows: 펼쳐진 카테고리의 계정과목별 */}
                      {expandable && isExpanded && subAccounts.map((acc: any) => {
                        const totalForRow = acc.values.reduce((a: number, b: number) => a + b, 0)
                        return (
                          <tr key={`${row.expandKey}-${acc.code}`} className="bg-white hover:bg-canvas-50/30">
                            <td className="sticky left-0 z-10 px-3 py-1 pl-9 border-r border-ink-200 bg-white whitespace-nowrap text-2xs">
                              <span className="font-mono text-ink-400 mr-1.5">{acc.code}</span>
                              <span className="text-ink-700">{acc.name}</span>
                            </td>
                            {acc.values.map((v: number, vi: number) => (
                              <td
                                key={`${acc.code}-${vi}`}
                                className="px-3 py-1 text-right font-mono tabular-nums whitespace-nowrap text-2xs text-ink-600"
                              >
                                {v === 0 ? (
                                  <span className="text-ink-200">-</span>
                                ) : v < 0 ? (
                                  <span className="text-rose-600">({formatCurrency(Math.abs(v), false)})</span>
                                ) : (
                                  formatCurrency(v, false)
                                )}
                              </td>
                            ))}
                            <td className="px-3 py-1 text-right font-mono tabular-nums bg-ink-50 text-2xs font-semibold text-ink-900 whitespace-nowrap">
                              {formatCurrency(totalForRow, false)}
                            </td>
                          </tr>
                        )
                      })}
                    </>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      </>)}

      {/* Footnote */}
      <div className="text-2xs text-ink-400 px-1">
        {viewMode === 'pl'
          ? '※ 현금주의 기준. 발생주의(세금계산서 발생일)와 다를 수 있습니다. 음수는 ( )로 표시.'
          : '※ 각 컬럼은 해당 월말까지의 누적 잔액. 자산은 + (차변 우세), 부채·자본은 + (대변 우세) 기준.'}
      </div>
    </div>
  )
}

// ====================== 월별 재무상태표 ======================

interface BSItem { code: string; name: string; amount: number }
interface BSSub { name: string; items: BSItem[]; total: number }
interface BSSection { id: string; name: string; subsections: BSSub[]; total: number }
interface BSMonth {
  month: number
  month_label: string
  month_end: string
  sections: BSSection[]
  total_assets: number
  total_liabilities: number
  total_equity: number
}
interface BSData { year: number; ledger_mode: string; months: BSMonth[] }

function MonthlyBSPanel({
  data,
  loading,
  availableYears,
  onPickYear,
}: {
  data?: BSData
  loading: boolean
  availableYears: number[]
  onPickYear: (y: number) => void
}) {
  // 모든 월의 (sectionId, subName)별 계정 union — 계정별 월별 금액 매트릭스
  const matrix = useMemo(() => {
    if (!data?.months?.length) return null
    const months = data.months
    type Row = { code: string; name: string; amounts: Record<number, number> }
    const collect = (sectionId: string, subName: string): Row[] => {
      const map = new Map<string, Row>()
      for (const m of months) {
        const sec = m.sections.find((s) => s.id === sectionId)
        const sub = sec?.subsections.find((s) => s.name === subName)
        if (!sub) continue
        for (const it of sub.items) {
          if (!map.has(it.code)) {
            map.set(it.code, { code: it.code, name: it.name, amounts: {} })
          }
          map.get(it.code)!.amounts[m.month] = Number(it.amount)
        }
      }
      // 최근 월 금액 절대값 기준 정렬
      return Array.from(map.values()).sort(
        (a, b) =>
          Math.abs(b.amounts[months[months.length - 1].month] || 0) -
          Math.abs(a.amounts[months[months.length - 1].month] || 0)
      )
    }
    const subSum = (sectionId: string, subName: string, m: number) => {
      const month = months.find((x) => x.month === m)
      const sec = month?.sections.find((s) => s.id === sectionId)
      const sub = sec?.subsections.find((s) => s.name === subName)
      return Number(sub?.total || 0)
    }
    return { months, collect, subSum }
  }, [data])

  if (loading) {
    return (
      <div className="panel p-8 text-center text-2xs text-ink-400">불러오는 중…</div>
    )
  }

  if (!matrix || matrix.months.length === 0) {
    return (
      <div className="panel p-8 text-center text-2xs text-ink-400">
        <div>이 회계연도에 데이터가 없습니다.</div>
        {availableYears.length > 0 && (
          <div className="mt-3 inline-flex items-center gap-1.5">
            <span>데이터 있는 년도:</span>
            {availableYears.slice(0, 5).map((y) => (
              <button
                key={y}
                onClick={() => onPickYear(y)}
                className="px-2 py-0.5 rounded border border-ink-200 bg-white text-ink-700 hover:bg-ink-50 font-semibold"
              >
                {y}
              </button>
            ))}
          </div>
        )}
      </div>
    )
  }

  const { months, collect, subSum } = matrix
  const cellRight =
    'px-3 py-1.5 text-right font-mono tabular-nums text-ink-800'
  const headerCell =
    'px-3 py-2 text-right font-semibold text-ink-500 uppercase tracking-wider min-w-[110px]'

  const SECTIONS = [
    {
      id: 'assets',
      label: '자산',
      tone: 'text-blue-700 bg-blue-50',
      subs: ['I. 유동자산', 'II. 비유동자산'],
      totalKey: 'total_assets' as const,
    },
    {
      id: 'liabilities',
      label: '부채',
      tone: 'text-rose-700 bg-rose-50',
      subs: ['I. 유동부채', 'II. 비유동부채'],
      totalKey: 'total_liabilities' as const,
    },
    {
      id: 'equity',
      label: '자본',
      tone: 'text-purple-700 bg-purple-50',
      subs: ['자본 항목'],
      totalKey: 'total_equity' as const,
    },
  ]

  return (
    <div className="panel overflow-hidden">
      <div className="overflow-x-auto">
        <table className="min-w-full text-2xs">
          <thead>
            <tr className="bg-canvas-50 border-b border-ink-200">
              <th className="sticky left-0 bg-canvas-50 z-10 px-3 py-2 text-left font-semibold text-ink-500 uppercase tracking-wider min-w-[220px] border-r border-ink-200">
                계정과목
              </th>
              {months.map((m) => (
                <th key={m.month_label} className={headerCell}>
                  {m.month_label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {SECTIONS.map((sec) => (
              <>
                {/* 섹션 헤더 */}
                <tr key={`sec-${sec.id}`} className={`${sec.tone} border-y border-ink-200`}>
                  <td className={`sticky left-0 z-10 px-3 py-1.5 font-semibold ${sec.tone}`}>
                    {sec.label}
                  </td>
                  {months.map((m) => (
                    <td key={m.month} className={`${cellRight} font-bold`}>
                      {formatCurrency(Number(m[sec.totalKey] || 0), false)}
                    </td>
                  ))}
                </tr>
                {sec.subs.map((subName) => {
                  const rows = collect(sec.id, subName)
                  if (rows.length === 0) return null
                  return (
                    <>
                      <tr key={`sub-${sec.id}-${subName}`} className="bg-ink-50/50 border-y border-ink-200/40">
                        <td className="sticky left-0 bg-ink-50/50 z-10 px-3 py-1 font-semibold text-ink-700">
                          {subName}
                        </td>
                        {months.map((m) => (
                          <td key={m.month} className={`${cellRight} font-semibold`}>
                            {formatCurrency(subSum(sec.id, subName, m.month), false)}
                          </td>
                        ))}
                      </tr>
                      {rows.map((r) => (
                        <tr key={`${sec.id}-${r.code}`} className="hover:bg-ink-50/30 border-b border-ink-100">
                          <td className="sticky left-0 bg-white z-10 px-3 py-1 pl-6 text-ink-700">
                            <span className="font-mono text-ink-400 mr-1.5">{r.code}</span>
                            {r.name}
                          </td>
                          {months.map((m) => (
                            <td key={m.month} className={cellRight}>
                              {r.amounts[m.month]
                                ? formatCurrency(r.amounts[m.month], false)
                                : '-'}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </>
                  )
                })}
              </>
            ))}
            {/* 합계 행 (부채+자본) */}
            <tr className="bg-ink-900 text-white border-t-2 border-ink-900">
              <td className="sticky left-0 bg-ink-900 z-10 px-3 py-2 font-bold">
                부채 + 자본
              </td>
              {months.map((m) => (
                <td key={m.month} className={`${cellRight} text-white font-bold`}>
                  {formatCurrency(
                    Number(m.total_liabilities || 0) + Number(m.total_equity || 0),
                    false
                  )}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  )
}
