import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AgGridReact } from 'ag-grid-react'
import 'ag-grid-community/styles/ag-grid.css'
import 'ag-grid-community/styles/ag-theme-alpine.css'
import {
  MagnifyingGlassIcon,
  ArrowDownTrayIcon,
  ArrowPathIcon,
  CalendarDaysIcon,
  BookOpenIcon,
  ChevronDownIcon,
  ChevronRightIcon,
} from '@heroicons/react/24/outline'
import { ledgerApi } from '@/services/api'
import { formatCurrency, formatCompactWon, formatDate } from '@/utils/format'
import EmptyState from '@/components/common/EmptyState'

const CATEGORY_META: Record<string, { label: string; dot: string; chip: string }> = {
  asset: { label: '자산', dot: 'bg-blue-500', chip: 'bg-blue-50 text-blue-700 border-blue-200' },
  liability: { label: '부채', dot: 'bg-rose-500', chip: 'bg-rose-50 text-rose-700 border-rose-200' },
  equity: { label: '자본', dot: 'bg-purple-500', chip: 'bg-purple-50 text-purple-700 border-purple-200' },
  revenue: { label: '수익', dot: 'bg-emerald-500', chip: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  expense: { label: '비용', dot: 'bg-amber-500', chip: 'bg-amber-50 text-amber-700 border-amber-200' },
  non_operating: { label: '영업외', dot: 'bg-ink-400', chip: 'bg-ink-50 text-ink-700 border-ink-200' },
}

const CATEGORY_ORDER = ['asset', 'liability', 'equity', 'revenue', 'expense', 'non_operating']

function todayISO() {
  return new Date().toISOString().slice(0, 10)
}
function isoYearStart(year: number) {
  return `${year}-01-01`
}
function isoYearEnd(year: number) {
  return `${year}-12-31`
}

export default function AccountLedgerPage() {
  const qc = useQueryClient()

  // 가용 년도 조회 — 데이터의 가장 최신 년도를 자동으로 default로
  const yearsQuery = useQuery({
    queryKey: ['ledger-years'],
    queryFn: () => ledgerApi.getAvailableYears().then((r) => r.data),
  })

  const availableYears: number[] = yearsQuery.data?.years || []
  const latestYear: number | null = yearsQuery.data?.latest ?? null

  const [periodStart, setPeriodStart] = useState<string>('')
  const [periodEnd, setPeriodEnd] = useState<string>('')

  // 가용 년도 로드 후 기본 기간 자동 설정 (가장 최신 년도 1.1 ~ 12.31)
  useEffect(() => {
    if (latestYear && (!periodStart || !periodEnd)) {
      setPeriodStart(isoYearStart(latestYear))
      setPeriodEnd(isoYearEnd(latestYear))
    } else if (!latestYear && yearsQuery.isFetched && (!periodStart || !periodEnd)) {
      // fallback: 데이터 없으면 올해
      const y = new Date().getFullYear()
      setPeriodStart(isoYearStart(y))
      setPeriodEnd(todayISO())
    }
  }, [latestYear, yearsQuery.isFetched]) // eslint-disable-line react-hooks/exhaustive-deps
  const [searchAcc, setSearchAcc] = useState('')
  const [categoryFilter, setCategoryFilter] = useState<string | undefined>(undefined)
  const [onlyActivity, setOnlyActivity] = useState(true)
  const [selectedCode, setSelectedCode] = useState<string | null>(null)
  const [entrySearch, setEntrySearch] = useState('')
  const [collapsedCats, setCollapsedCats] = useState<Set<string>>(new Set())
  const searchInputRef = useRef<HTMLInputElement | null>(null)

  const fiscalYear = periodEnd ? new Date(periodEnd).getFullYear() : new Date().getFullYear()
  const periodReady = Boolean(periodStart && periodEnd)

  const accountsQuery = useQuery({
    queryKey: ['ledger-accounts', fiscalYear, periodStart, periodEnd, categoryFilter, onlyActivity, searchAcc],
    queryFn: () =>
      ledgerApi
        .listAccounts({
          fiscal_year: fiscalYear,
          period_start: periodStart,
          period_end: periodEnd,
          category: categoryFilter,
          only_with_activity: onlyActivity,
          search: searchAcc || undefined,
        })
        .then((r) => r.data),
    enabled: periodReady,
  })

  const entriesQuery = useQuery({
    queryKey: ['ledger-entries', selectedCode, periodStart, periodEnd, entrySearch],
    queryFn: () =>
      ledgerApi
        .getEntries(selectedCode!, {
          period_start: periodStart,
          period_end: periodEnd,
          search: entrySearch || undefined,
          size: 1000,
        })
        .then((r) => r.data),
    enabled: !!selectedCode && periodReady,
  })

  const accounts: any[] = accountsQuery.data || []
  const entries: any[] = entriesQuery.data?.entries || []
  const summary = entriesQuery.data?.summary

  // Auto-select first account when list loads
  useEffect(() => {
    if (!selectedCode && accounts.length > 0) {
      setSelectedCode(accounts[0].account_code)
    }
  }, [accounts, selectedCode])

  // Cmd/Ctrl-K to focus account search
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        searchInputRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const groupedAccounts = useMemo(() => {
    const groups: Record<string, any[]> = {}
    for (const a of accounts) {
      groups[a.category] = groups[a.category] || []
      groups[a.category].push(a)
    }
    return groups
  }, [accounts])

  const totalCount = accounts.reduce((s, a) => s + (a.transaction_count || 0), 0)

  const columnDefs = useMemo(
    () => [
      {
        headerName: '날짜',
        field: 'transaction_date',
        width: 100,
        pinned: 'left' as const,
        valueFormatter: (p: any) => formatDate(p.value),
      },
      {
        headerName: '#',
        field: 'transaction_number',
        width: 70,
        pinned: 'left' as const,
        cellClass: 'font-mono text-ink-400 text-xs',
      },
      {
        headerName: '거래처',
        field: 'counterparty',
        width: 160,
        editable: true,
      },
      {
        headerName: '적요',
        field: 'description',
        flex: 1,
        minWidth: 240,
        editable: true,
      },
      {
        headerName: '차변',
        field: 'debit',
        width: 130,
        type: 'numericColumn',
        cellClass: 'amount font-mono',
        valueFormatter: (p: any) =>
          Number(p.value) > 0 ? formatCurrency(p.value, false) : '',
        cellStyle: (p: any) =>
          Number(p.value) > 0 ? { color: '#107e79', fontWeight: 600 } : undefined,
      },
      {
        headerName: '대변',
        field: 'credit',
        width: 130,
        type: 'numericColumn',
        cellClass: 'amount font-mono',
        valueFormatter: (p: any) =>
          Number(p.value) > 0 ? formatCurrency(p.value, false) : '',
        cellStyle: (p: any) =>
          Number(p.value) > 0 ? { color: '#b91c1c', fontWeight: 600 } : undefined,
      },
      {
        headerName: '잔액',
        field: 'running_balance',
        width: 140,
        type: 'numericColumn',
        cellClass: 'amount font-mono',
        valueFormatter: (p: any) => formatCurrency(p.value, false),
        cellStyle: { fontWeight: 600 },
      },
      {
        headerName: '상대 계정',
        field: 'counterparty_account_name',
        width: 150,
        cellRenderer: (p: any) =>
          p.data?.counterparty_account_code ? (
            <span className="inline-flex items-center gap-1.5">
              <span className="font-mono text-ink-400 text-2xs">
                {p.data.counterparty_account_code}
              </span>
              <span>{p.value}</span>
            </span>
          ) : (
            <span className="text-ink-300">-</span>
          ),
      },
      {
        headerName: '메모',
        field: 'memo',
        width: 200,
        editable: true,
      },
    ],
    []
  )

  const defaultColDef = useMemo(
    () => ({
      resizable: true,
      sortable: true,
      filter: true,
      suppressMenu: false,
    }),
    []
  )

  const toggleCat = (cat: string) => {
    const next = new Set(collapsedCats)
    if (next.has(cat)) next.delete(cat)
    else next.add(cat)
    setCollapsedCats(next)
  }

  return (
    <div className="space-y-3">
      {/* Compact header */}
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="flex items-center gap-2">
            <BookOpenIcon className="h-5 w-5 text-ink-500" />
            계정별 원장
          </h1>
          <p className="text-xs text-ink-500 mt-1">
            {accountsQuery.isLoading
              ? '불러오는 중…'
              : `${accounts.length}개 계정 · ${totalCount.toLocaleString('ko-KR')}건의 거래`}
          </p>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          {/* 가용 년도 빠른 선택 */}
          {availableYears.length > 0 && (
            <div className="flex items-center gap-0.5 p-0.5 rounded-md bg-white border border-ink-200">
              {availableYears.slice(0, 5).map((y) => {
                const isActive = periodStart === isoYearStart(y) && periodEnd === isoYearEnd(y)
                return (
                  <button
                    key={y}
                    onClick={() => {
                      setPeriodStart(isoYearStart(y))
                      setPeriodEnd(isoYearEnd(y))
                    }}
                    className={`px-2 py-1 rounded text-2xs font-semibold transition ${
                      isActive
                        ? 'bg-ink-900 text-white'
                        : 'text-ink-600 hover:bg-ink-50 hover:text-ink-900'
                    }`}
                  >
                    {y}
                  </button>
                )
              })}
            </div>
          )}
          <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-white border border-ink-200">
            <CalendarDaysIcon className="h-3.5 w-3.5 text-ink-400" />
            <input
              type="date"
              value={periodStart}
              onChange={(e) => setPeriodStart(e.target.value)}
              className="bg-transparent text-xs font-medium text-ink-700 focus:outline-none w-28"
            />
            <span className="text-ink-300">→</span>
            <input
              type="date"
              value={periodEnd}
              onChange={(e) => setPeriodEnd(e.target.value)}
              className="bg-transparent text-xs font-medium text-ink-700 focus:outline-none w-28"
            />
          </div>
          <button
            onClick={() => qc.invalidateQueries({ queryKey: ['ledger-accounts'] })}
            className="btn-secondary"
            title="새로고침"
          >
            <ArrowPathIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Master-detail */}
      <div className="ledger-shell">
        {/* Sidebar */}
        <aside className="ledger-sidebar">
          <div className="p-2.5 border-b border-ink-200 space-y-2">
            <div className="relative">
              <MagnifyingGlassIcon className="h-3.5 w-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-ink-400" />
              <input
                ref={searchInputRef}
                value={searchAcc}
                onChange={(e) => setSearchAcc(e.target.value)}
                placeholder="계정 검색"
                className="pl-7 pr-12 input text-xs"
              />
              <kbd className="absolute right-1.5 top-1/2 -translate-y-1/2 px-1 py-0.5 rounded border border-ink-200 bg-canvas-50 text-2xs text-ink-400 font-mono">
                ⌘K
              </kbd>
            </div>
            <div className="flex flex-wrap gap-1">
              <button
                onClick={() => setCategoryFilter(undefined)}
                className={`px-2 py-0.5 rounded text-2xs font-semibold transition ${
                  !categoryFilter
                    ? 'bg-ink-900 text-white'
                    : 'bg-white text-ink-600 border border-ink-200 hover:border-ink-300'
                }`}
              >
                전체
              </button>
              {CATEGORY_ORDER.map((k) => {
                const v = CATEGORY_META[k]
                const isActive = categoryFilter === k
                return (
                  <button
                    key={k}
                    onClick={() => setCategoryFilter(isActive ? undefined : k)}
                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-2xs font-semibold transition ${
                      isActive
                        ? 'bg-ink-900 text-white'
                        : 'bg-white text-ink-600 border border-ink-200 hover:border-ink-300'
                    }`}
                  >
                    <span className={`w-1 h-1 rounded-full ${v.dot}`} />
                    {v.label}
                  </button>
                )
              })}
            </div>
            <label className="flex items-center gap-1.5 text-2xs text-ink-500 select-none cursor-pointer">
              <input
                type="checkbox"
                checked={onlyActivity}
                onChange={(e) => setOnlyActivity(e.target.checked)}
                className="rounded border-ink-300 text-ink-900 focus:ring-ink-300 w-3 h-3"
              />
              거래 있는 계정만
            </label>
          </div>

          <div className="flex-1 overflow-y-auto py-1">
            {accountsQuery.isLoading && (
              <div className="px-3 py-4 space-y-2">
                {[1, 2, 3, 4, 5].map((i) => (
                  <div key={i} className="h-7 bg-ink-100 rounded animate-pulse" />
                ))}
              </div>
            )}

            {!accountsQuery.isLoading &&
              CATEGORY_ORDER.filter((c) => groupedAccounts[c]).map((cat) => {
                const meta = CATEGORY_META[cat]
                const group = groupedAccounts[cat]
                const collapsed = collapsedCats.has(cat)
                const groupTotal = group.reduce(
                  (s: number, a: any) => s + Number(a.closing_balance || 0),
                  0
                )
                return (
                  <div key={cat} className="mb-1.5">
                    <button
                      onClick={() => toggleCat(cat)}
                      className="w-full px-3 py-1 flex items-center justify-between text-2xs font-semibold uppercase tracking-wider text-ink-500 hover:text-ink-900"
                    >
                      <span className="flex items-center gap-1.5">
                        {collapsed ? (
                          <ChevronRightIcon className="h-3 w-3" />
                        ) : (
                          <ChevronDownIcon className="h-3 w-3" />
                        )}
                        <span className={`w-1.5 h-1.5 rounded-full ${meta.dot}`} />
                        {meta.label}
                        <span className="text-ink-300 font-normal">{group.length}</span>
                      </span>
                      <span className="font-mono text-2xs text-ink-400 normal-case tracking-normal">
                        {formatCompactWon(groupTotal)}
                      </span>
                    </button>
                    {!collapsed &&
                      group.map((a) => {
                        const isActive = selectedCode === a.account_code
                        return (
                          <button
                            key={a.account_code}
                            onClick={() => setSelectedCode(a.account_code)}
                            className={`ledger-account-row group ${isActive ? 'active' : ''}`}
                          >
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5">
                                <span className="text-2xs font-mono text-ink-400 flex-shrink-0">
                                  {a.account_code}
                                </span>
                                <span
                                  className={`text-xs truncate ${
                                    isActive ? 'font-semibold text-ink-900' : 'font-medium text-ink-700'
                                  }`}
                                >
                                  {a.account_name}
                                </span>
                              </div>
                              <div className="text-2xs text-ink-400 mt-0.5">
                                {a.transaction_count.toLocaleString('ko-KR')}건
                              </div>
                            </div>
                            <div className="text-right flex-shrink-0 ml-2">
                              <div
                                className={`text-xs font-mono tabular-nums font-semibold ${
                                  Number(a.closing_balance) >= 0 ? 'text-ink-900' : 'text-rose-600'
                                }`}
                              >
                                {formatCompactWon(a.closing_balance)}
                              </div>
                            </div>
                          </button>
                        )
                      })}
                  </div>
                )
              })}

            {!accountsQuery.isLoading && accounts.length === 0 && (
              <div className="px-4 py-6 text-center">
                <p className="text-xs text-ink-500">이 기간에 거래가 없습니다.</p>
                {availableYears.length > 0 && (
                  <div className="mt-3">
                    <p className="text-2xs text-ink-400 mb-1.5">데이터가 있는 년도</p>
                    <div className="flex flex-wrap justify-center gap-1">
                      {availableYears.map((y) => (
                        <button
                          key={y}
                          onClick={() => {
                            setPeriodStart(isoYearStart(y))
                            setPeriodEnd(isoYearEnd(y))
                          }}
                          className="px-2 py-0.5 rounded text-2xs font-semibold bg-white border border-ink-200 text-ink-700 hover:bg-ink-50 hover:border-ink-300"
                        >
                          {y}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </aside>

        {/* Main */}
        <main className="ledger-main">
          {summary ? (
            <>
              {/* Account header */}
              <div className="px-5 py-3.5 border-b border-ink-200 bg-white">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs font-mono text-ink-400">{summary.account_code}</span>
                      <h2 className="text-lg font-semibold text-ink-900 tracking-crisp">
                        {summary.account_name}
                      </h2>
                      <span className={`badge ${CATEGORY_META[summary.category]?.chip}`}>
                        <span className={`w-1 h-1 rounded-full ${CATEGORY_META[summary.category]?.dot} mr-1`} />
                        {CATEGORY_META[summary.category]?.label}
                      </span>
                    </div>
                    <div className="text-2xs text-ink-500 mt-0.5">
                      {formatDate(summary.period_start)} – {formatDate(summary.period_end)} ·{' '}
                      <span className="font-medium text-ink-700">
                        {summary.transaction_count.toLocaleString('ko-KR')}건
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <div className="relative">
                      <MagnifyingGlassIcon className="h-3.5 w-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-ink-400" />
                      <input
                        value={entrySearch}
                        onChange={(e) => setEntrySearch(e.target.value)}
                        placeholder="거래 검색"
                        className="pl-7 input w-44 text-xs"
                      />
                    </div>
                    <button
                      onClick={() =>
                        ledgerApi
                          .exportExcel(summary.account_code, periodStart, periodEnd)
                          .then((res) => {
                            if (res.data?.url) window.open(res.data.url, '_blank')
                          })
                      }
                      className="btn-secondary"
                    >
                      <ArrowDownTrayIcon className="h-3.5 w-3.5 mr-1" />
                      엑셀
                    </button>
                  </div>
                </div>

                {/* KPI strip — 4 stats horizontally */}
                <div className="mt-3.5 grid grid-cols-4 divide-x divide-ink-100 border border-ink-200 rounded-md bg-canvas-50">
                  <KPIBlock label="기초 잔액" value={summary.opening_balance} />
                  <KPIBlock label="차변" value={summary.period_debit} accent="primary" />
                  <KPIBlock label="대변" value={summary.period_credit} accent="danger" />
                  <KPIBlock
                    label="기말 잔액"
                    value={summary.closing_balance}
                    accent={Number(summary.closing_balance) >= 0 ? 'success' : 'danger'}
                    bold
                    delta={
                      summary.opening_balance && Number(summary.opening_balance) !== 0
                        ? {
                            value: `${(((Number(summary.closing_balance) - Number(summary.opening_balance)) / Math.abs(Number(summary.opening_balance))) * 100).toFixed(1)}%`,
                            positive:
                              Number(summary.closing_balance) - Number(summary.opening_balance) >= 0,
                          }
                        : undefined
                    }
                  />
                </div>
              </div>

              {/* Excel-like grid */}
              <div className="flex-1 ag-theme-alpine">
                <AgGridReact
                  rowData={entries}
                  columnDefs={columnDefs as any}
                  defaultColDef={defaultColDef}
                  animateRows
                  enableCellTextSelection
                  ensureDomOrder
                  rowHeight={32}
                  headerHeight={34}
                  pagination
                  paginationPageSize={100}
                  paginationPageSizeSelector={[50, 100, 200, 500]}
                  noRowsOverlayComponent={() => (
                    <div className="text-xs text-ink-400 p-4">
                      이 기간에 해당 계정의 거래가 없습니다.
                    </div>
                  )}
                />
              </div>
            </>
          ) : (
            <EmptyState
              icon={<BookOpenIcon className="h-6 w-6" />}
              title="계정을 선택하세요"
              description="좌측에서 계정과목을 클릭하면 해당 계정의 거래 내역을 엑셀처럼 편집·조회할 수 있습니다."
              shortcut="⌘K"
            />
          )}
        </main>
      </div>
    </div>
  )
}

function KPIBlock({
  label,
  value,
  accent = 'neutral',
  bold = false,
  delta,
}: {
  label: string
  value: number | string
  accent?: 'neutral' | 'primary' | 'success' | 'danger'
  bold?: boolean
  delta?: { value: string; positive: boolean }
}) {
  const accentClass: Record<string, string> = {
    neutral: 'text-ink-900',
    primary: 'text-primary-700',
    success: 'text-emerald-700',
    danger: 'text-rose-700',
  }
  return (
    <div className="px-3.5 py-2.5">
      <div className="text-2xs font-medium text-ink-500 uppercase tracking-wider">{label}</div>
      <div
        className={`mt-1 font-mono tabular-nums ${
          bold ? 'text-base font-bold' : 'text-sm font-semibold'
        } ${accentClass[accent]}`}
      >
        {formatCurrency(value, false)}
      </div>
      {delta && (
        <div className={`text-2xs font-medium mt-0.5 ${delta.positive ? 'text-emerald-600' : 'text-rose-600'}`}>
          {delta.positive ? '↑' : '↓'} {delta.value}
        </div>
      )}
    </div>
  )
}
