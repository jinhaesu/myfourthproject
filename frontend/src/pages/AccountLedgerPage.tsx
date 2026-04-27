import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AgGridReact } from 'ag-grid-react'
import 'ag-grid-community/styles/ag-grid.css'
import 'ag-grid-community/styles/ag-theme-alpine.css'
import {
  MagnifyingGlassIcon,
  ArrowDownTrayIcon,
  ArrowPathIcon,
  CalendarDaysIcon,
  TagIcon,
} from '@heroicons/react/24/outline'
import { ledgerApi } from '@/services/api'
import { formatCurrency, formatCompactWon, formatDate } from '@/utils/format'

const CATEGORY_META: Record<string, { label: string; color: string; chip: string }> = {
  asset: { label: '자산', color: 'text-blue-700', chip: 'bg-blue-50 text-blue-700' },
  liability: { label: '부채', color: 'text-rose-700', chip: 'bg-rose-50 text-rose-700' },
  equity: { label: '자본', color: 'text-purple-700', chip: 'bg-purple-50 text-purple-700' },
  revenue: { label: '수익', color: 'text-emerald-700', chip: 'bg-emerald-50 text-emerald-700' },
  expense: { label: '비용', color: 'text-amber-700', chip: 'bg-amber-50 text-amber-700' },
  non_operating: { label: '영업외', color: 'text-gray-700', chip: 'bg-gray-100 text-gray-700' },
}

function todayISO() {
  return new Date().toISOString().slice(0, 10)
}
function startOfYearISO() {
  const d = new Date()
  d.setMonth(0, 1)
  return d.toISOString().slice(0, 10)
}

export default function AccountLedgerPage() {
  const qc = useQueryClient()
  const [periodStart, setPeriodStart] = useState(startOfYearISO())
  const [periodEnd, setPeriodEnd] = useState(todayISO())
  const [searchAcc, setSearchAcc] = useState('')
  const [categoryFilter, setCategoryFilter] = useState<string | undefined>(undefined)
  const [onlyActivity, setOnlyActivity] = useState(true)
  const [selectedCode, setSelectedCode] = useState<string | null>(null)
  const [entrySearch, setEntrySearch] = useState('')

  const fiscalYear = new Date(periodEnd).getFullYear()

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
    enabled: !!selectedCode,
  })

  const accounts: any[] = accountsQuery.data || []
  const entries: any[] = entriesQuery.data?.entries || []
  const summary = entriesQuery.data?.summary

  // 자동으로 첫 번째 계정 선택
  if (!selectedCode && accounts.length > 0) {
    setSelectedCode(accounts[0].account_code)
  }

  // 카테고리별로 그룹핑
  const groupedAccounts = useMemo(() => {
    const groups: Record<string, any[]> = {}
    for (const a of accounts) {
      groups[a.category] = groups[a.category] || []
      groups[a.category].push(a)
    }
    return groups
  }, [accounts])

  const columnDefs = useMemo(
    () => [
      {
        headerName: '날짜',
        field: 'transaction_date',
        width: 110,
        pinned: 'left' as const,
        valueFormatter: (p: any) => formatDate(p.value),
      },
      {
        headerName: '전표번호',
        field: 'transaction_number',
        width: 150,
        pinned: 'left' as const,
        cellClass: 'font-mono text-xs',
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
        minWidth: 250,
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
        width: 140,
        cellRenderer: (p: any) =>
          p.data?.counterparty_account_code
            ? `${p.value} (${p.data.counterparty_account_code})`
            : '-',
      },
      {
        headerName: '부서',
        field: 'department_name',
        width: 110,
      },
      {
        headerName: '프로젝트',
        field: 'project_tag',
        width: 130,
        editable: true,
        cellRenderer: (p: any) =>
          p.value ? (
            <span className="badge bg-primary-50 text-primary-700">
              {p.value}
            </span>
          ) : (
            <span className="text-gray-300">-</span>
          ),
      },
      {
        headerName: '메모',
        field: 'memo',
        width: 180,
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

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1>계정별 원장</h1>
          <p className="text-gray-500 mt-1.5">
            좌측 계정과목에서 선택하면 우측에서 거래 내역을 엑셀처럼 편집할 수 있습니다.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <CalendarDaysIcon className="h-5 w-5 text-gray-400" />
          <input
            type="date"
            value={periodStart}
            onChange={(e) => setPeriodStart(e.target.value)}
            className="input w-40"
          />
          <span className="text-gray-400">~</span>
          <input
            type="date"
            value={periodEnd}
            onChange={(e) => setPeriodEnd(e.target.value)}
            className="input w-40"
          />
          <button
            onClick={() => qc.invalidateQueries({ queryKey: ['ledger-accounts'] })}
            className="btn-secondary"
            title="새로고침"
          >
            <ArrowPathIcon className="h-5 w-5" />
          </button>
        </div>
      </div>

      {/* Master-detail shell */}
      <div className="ledger-shell">
        {/* Sidebar — accounts */}
        <aside className="ledger-sidebar">
          <div className="p-3 border-b border-gray-200 space-y-2">
            <div className="relative">
              <MagnifyingGlassIcon className="h-4 w-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                value={searchAcc}
                onChange={(e) => setSearchAcc(e.target.value)}
                placeholder="계정 검색"
                className="pl-8 input"
              />
            </div>
            <div className="flex gap-1 overflow-x-auto pb-1">
              <button
                onClick={() => setCategoryFilter(undefined)}
                className={`whitespace-nowrap px-2.5 py-1 rounded-md text-xs font-semibold ${
                  !categoryFilter ? 'bg-primary-600 text-white' : 'bg-white text-gray-700 border border-gray-200'
                }`}
              >
                전체
              </button>
              {Object.entries(CATEGORY_META).map(([k, v]) => (
                <button
                  key={k}
                  onClick={() => setCategoryFilter(k)}
                  className={`whitespace-nowrap px-2.5 py-1 rounded-md text-xs font-semibold ${
                    categoryFilter === k
                      ? 'bg-primary-600 text-white'
                      : 'bg-white text-gray-700 border border-gray-200'
                  }`}
                >
                  {v.label}
                </button>
              ))}
            </div>
            <label className="flex items-center gap-2 text-xs text-gray-600">
              <input
                type="checkbox"
                checked={onlyActivity}
                onChange={(e) => setOnlyActivity(e.target.checked)}
                className="rounded border-gray-300 text-primary-600 focus:ring-primary-500"
              />
              거래 있는 계정만
            </label>
          </div>

          <div className="flex-1 overflow-y-auto py-2">
            {accountsQuery.isLoading && (
              <div className="text-center text-gray-400 text-sm py-8">불러오는 중…</div>
            )}
            {Object.entries(groupedAccounts).map(([cat, group]) => {
              const meta = CATEGORY_META[cat] || CATEGORY_META.expense
              return (
                <div key={cat} className="mb-3">
                  <div className="px-4 py-1.5 text-xs font-bold uppercase tracking-wider text-gray-500">
                    {meta.label}
                  </div>
                  {group.map((a) => {
                    const isActive = selectedCode === a.account_code
                    return (
                      <button
                        key={a.account_code}
                        onClick={() => setSelectedCode(a.account_code)}
                        className={`ledger-account-row ${isActive ? 'active' : ''}`}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-mono text-gray-400">{a.account_code}</span>
                            <span className={`text-sm font-medium truncate ${isActive ? 'text-gray-900' : 'text-gray-700'}`}>
                              {a.account_name}
                            </span>
                          </div>
                          <div className="text-xs text-gray-400 mt-0.5">
                            {a.transaction_count}건
                          </div>
                        </div>
                        <div className="text-right flex-shrink-0">
                          <div
                            className={`text-sm font-mono tabular-nums font-semibold ${
                              Number(a.closing_balance) >= 0 ? 'text-gray-900' : 'text-rose-600'
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
            {accounts.length === 0 && !accountsQuery.isLoading && (
              <div className="text-center text-gray-400 text-sm py-8">계정이 없습니다.</div>
            )}
          </div>
        </aside>

        {/* Main — selected account ledger */}
        <main className="ledger-main">
          {summary ? (
            <>
              {/* Summary header */}
              <div className="px-6 py-4 border-b border-gray-200 bg-canvas-50">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs font-mono text-gray-500">{summary.account_code}</span>
                      <h2 className="text-2xl font-bold text-gray-900">{summary.account_name}</h2>
                      <span className={`badge ${CATEGORY_META[summary.category]?.chip}`}>
                        {CATEGORY_META[summary.category]?.label}
                      </span>
                    </div>
                    <div className="text-sm text-gray-500 mt-1">
                      {formatDate(summary.period_start)} ~ {formatDate(summary.period_end)} · 거래 {summary.transaction_count}건
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <div className="relative">
                      <MagnifyingGlassIcon className="h-4 w-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
                      <input
                        value={entrySearch}
                        onChange={(e) => setEntrySearch(e.target.value)}
                        placeholder="거래 검색"
                        className="pl-8 input w-56"
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
                      <ArrowDownTrayIcon className="h-5 w-5 mr-1" />
                      엑셀
                    </button>
                  </div>
                </div>

                <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <SummaryStat label="기초 잔액" value={summary.opening_balance} />
                  <SummaryStat label="차변 합계" value={summary.period_debit} tone="primary" />
                  <SummaryStat label="대변 합계" value={summary.period_credit} tone="danger" />
                  <SummaryStat
                    label="기말 잔액"
                    value={summary.closing_balance}
                    tone={Number(summary.closing_balance) >= 0 ? 'success' : 'danger'}
                    big
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
                  rowHeight={38}
                  headerHeight={42}
                  suppressMovableColumns={false}
                  pagination
                  paginationPageSize={50}
                  paginationPageSizeSelector={[50, 100, 200, 500]}
                />
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-gray-400">
              <div className="text-center">
                <TagIcon className="h-12 w-12 mx-auto text-gray-300" />
                <div className="mt-3 text-base">좌측에서 계정과목을 선택하세요.</div>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  )
}

function SummaryStat({
  label,
  value,
  tone = 'neutral',
  big = false,
}: {
  label: string
  value: number | string
  tone?: 'neutral' | 'primary' | 'success' | 'danger'
  big?: boolean
}) {
  const toneClass: Record<string, string> = {
    neutral: 'text-gray-900',
    primary: 'text-primary-700',
    success: 'text-emerald-700',
    danger: 'text-rose-700',
  }
  return (
    <div className="bg-white rounded-lg border border-gray-200/80 px-4 py-3">
      <div className="text-xs text-gray-500">{label}</div>
      <div
        className={`mt-1 font-mono tabular-nums font-bold ${toneClass[tone]} ${
          big ? 'text-xl' : 'text-base'
        }`}
      >
        {formatCurrency(value, false)}
      </div>
    </div>
  )
}
