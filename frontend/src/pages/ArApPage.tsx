import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  ArrowDownLeftIcon,
  ArrowUpRightIcon,
  ArrowPathIcon,
  ExclamationTriangleIcon,
  ScaleIcon,
} from '@heroicons/react/24/outline'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  Legend,
} from 'recharts'
import { ledgerApi } from '@/services/api'
import { formatCurrency, formatCompactWon } from '@/utils/format'
import FiscalYearTabs from '@/components/common/FiscalYearTabs'

type ArApType = 'receivable' | 'payable'

interface Counterparty {
  name: string
  opening_balance: number
  period_debit: number
  period_credit: number
  period_change: number
  closing_balance: number
  transaction_count: number
  latest_date: string | null
  earliest_date: string | null
}

interface MonthlyPoint {
  month: string
  period_debit: number
  period_credit: number
  period_change: number
  closing_balance: number
  transaction_count: number
}

interface ArApSummary {
  fiscal_year: number
  type: ArApType
  account_codes: string[]
  opening_balance: number
  closing_balance: number
  period_debit: number
  period_credit: number
  period_change: number
  counterparty_count: number
  transaction_count: number
  monthly: MonthlyPoint[]
  counterparties: Counterparty[]
}

type SortKey = 'name' | 'opening' | 'debit' | 'credit' | 'change' | 'closing' | 'count' | 'latest'
type SortDir = 'asc' | 'desc'

const TYPE_LABEL: Record<ArApType, string> = {
  receivable: '매출채권',
  payable: '매입채무',
}

interface SubAccount {
  code: string
  label: string
}

const SUB_ACCOUNTS: Record<ArApType, SubAccount[]> = {
  receivable: [
    { code: '108', label: '외상매출금' },
    { code: '110', label: '받을어음' },
  ],
  payable: [
    { code: '251', label: '외상매입금' },
    { code: '253', label: '미지급금' },
  ],
}

const TYPE_HINT: Record<ArApType, string> = {
  receivable: '회수해야 할 자산',
  payable: '지급해야 할 부채',
}

export default function ArApPage() {
  const currentYear = new Date().getFullYear()
  const [year, setYear] = useState<number>(currentYear)
  const [type, setType] = useState<ArApType>('receivable')
  // 계정 단위 선택 — 기본은 type의 모든 계정 (둘 다)
  const [selectedCodes, setSelectedCodes] = useState<string[]>(SUB_ACCOUNTS.receivable.map((s) => s.code))
  const [search, setSearch] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('closing')
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  // type 변경 시 codes를 새 type의 default(전체)로 reset
  function handleTypeChange(t: ArApType) {
    setType(t)
    setSelectedCodes(SUB_ACCOUNTS[t].map((s) => s.code))
  }

  function toggleCode(code: string) {
    setSelectedCodes((prev) => {
      if (prev.includes(code)) {
        // 마지막 한 개는 해제 불가 (최소 1개 보장)
        if (prev.length === 1) return prev
        return prev.filter((c) => c !== code)
      }
      return [...prev, code]
    })
  }

  const summaryQuery = useQuery({
    queryKey: ['ar-ap-summary', year, type, selectedCodes.join(',')],
    queryFn: () =>
      ledgerApi.getArApSummary(year, type, selectedCodes).then((r) => r.data as ArApSummary),
    staleTime: 5 * 60_000,
    retry: 1,
  })

  const data = summaryQuery.data

  // 검색 + 정렬
  const filteredCounterparties = useMemo(() => {
    const list = data?.counterparties ?? []
    const term = search.trim().toLowerCase()
    const filtered = term ? list.filter((c) => c.name.toLowerCase().includes(term)) : list
    const sorted = [...filtered].sort((a, b) => {
      let cmp = 0
      switch (sortKey) {
        case 'name':
          cmp = a.name.localeCompare(b.name, 'ko')
          break
        case 'opening':
          cmp = a.opening_balance - b.opening_balance
          break
        case 'debit':
          cmp = a.period_debit - b.period_debit
          break
        case 'credit':
          cmp = a.period_credit - b.period_credit
          break
        case 'change':
          cmp = a.period_change - b.period_change
          break
        case 'closing':
          cmp = a.closing_balance - b.closing_balance
          break
        case 'count':
          cmp = a.transaction_count - b.transaction_count
          break
        case 'latest':
          cmp = (a.latest_date || '').localeCompare(b.latest_date || '')
          break
      }
      return sortDir === 'asc' ? cmp : -cmp
    })
    return sorted
  }, [data, search, sortKey, sortDir])

  function handleSort(k: SortKey) {
    if (sortKey === k) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else {
      setSortKey(k)
      setSortDir(k === 'name' ? 'asc' : 'desc')
    }
  }

  const isLoading = summaryQuery.isLoading
  const hasError = summaryQuery.isError

  return (
    <div className="space-y-3">
      <div className="flex items-end justify-between flex-wrap gap-2">
        <div>
          <h1 className="flex items-center gap-2">
            <ScaleIcon className="h-4 w-4 text-ink-500" />
            매출채권 · 매입채무 관리
          </h1>
          <p className="text-2xs text-ink-500 mt-0.5">
            계정별 원장 기반 거래처 잔액 + 월말 변화 분석
          </p>
        </div>
        <button
          onClick={() => summaryQuery.refetch()}
          disabled={isLoading}
          className="btn-secondary"
        >
          <ArrowPathIcon className={`h-3 w-3 ${isLoading ? 'animate-spin' : ''}`} />
          새로고침
        </button>
      </div>

      {/* 회계연도 선택 (5개년) + 타입 탭 */}
      <div className="panel p-3 space-y-3">
        <div>
          <div className="text-2xs font-semibold text-ink-600 mb-1.5 uppercase tracking-wider">
            회계연도
          </div>
          <FiscalYearTabs year={year} onChange={setYear} />
        </div>

        <div>
          <div className="text-2xs font-semibold text-ink-600 mb-1.5 uppercase tracking-wider">
            계정 구분
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex items-center gap-0.5 p-0.5 rounded-md bg-white border border-ink-200">
              {(['receivable', 'payable'] as ArApType[]).map((t) => (
                <button
                  key={t}
                  onClick={() => handleTypeChange(t)}
                  className={`px-3 py-1 rounded text-2xs font-semibold transition ${
                    type === t ? 'bg-ink-900 text-white' : 'text-ink-600 hover:bg-ink-50'
                  }`}
                >
                  {TYPE_LABEL[t]}
                </button>
              ))}
            </div>
            <span className="text-2xs text-ink-400">·</span>
            {/* 세부 계정 선택 (multi-toggle) */}
            <div className="flex items-center gap-0.5 p-0.5 rounded-md bg-white border border-ink-200">
              {SUB_ACCOUNTS[type].map((s) => {
                const active = selectedCodes.includes(s.code)
                return (
                  <button
                    key={s.code}
                    onClick={() => toggleCode(s.code)}
                    className={`px-2.5 py-1 rounded text-2xs font-medium transition ${
                      active
                        ? 'bg-primary-700 text-white'
                        : 'text-ink-500 hover:bg-ink-50 hover:text-ink-700'
                    }`}
                    title={active ? '클릭하여 제외' : '클릭하여 포함'}
                  >
                    <span className="font-mono text-2xs opacity-70 mr-1">{s.code}</span>
                    {s.label}
                  </button>
                )
              })}
            </div>
            <span className="text-2xs text-ink-500">
              {TYPE_HINT[type]} · 선택 계정 {selectedCodes.length}개
            </span>
          </div>
        </div>
      </div>

      {/* 에러 */}
      {hasError && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 flex items-center gap-2">
          <ExclamationTriangleIcon className="h-4 w-4 text-rose-600 shrink-0" />
          <span className="text-2xs text-rose-800">데이터 조회 실패</span>
          <button className="btn-secondary text-2xs ml-auto" onClick={() => summaryQuery.refetch()}>
            재시도
          </button>
        </div>
      )}

      {/* 로딩 */}
      {isLoading && (
        <div className="rounded-md border border-ink-200 bg-canvas-50 px-3 py-4 flex items-center justify-center gap-2">
          <ArrowPathIcon className="h-4 w-4 text-ink-500 animate-spin" />
          <span className="text-2xs text-ink-700">데이터 로드 중…</span>
        </div>
      )}

      {/* 데이터 없음 */}
      {!isLoading && data && data.transaction_count === 0 && data.opening_balance === 0 && (
        <div className="panel px-4 py-8 text-center">
          <p className="text-2xs text-ink-500">
            {year}년 {TYPE_LABEL[type]} 데이터가 없습니다.
            다른 회계연도 또는 계정 구분을 선택해주세요.
          </p>
        </div>
      )}

      {/* KPI 4종 */}
      {data && data.transaction_count > 0 && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
            <KPI
              label="기초 잔액"
              value={data.opening_balance}
              tone="neutral"
              sub={`${year}-01-01`}
            />
            <KPI
              label="기간 증가"
              value={data.period_debit}
              tone={type === 'receivable' ? 'success' : 'danger'}
              icon={<ArrowDownLeftIcon className="h-3 w-3" />}
            />
            <KPI
              label="기간 감소"
              value={data.period_credit}
              tone={type === 'receivable' ? 'danger' : 'success'}
              icon={<ArrowUpRightIcon className="h-3 w-3" />}
            />
            <KPI
              label="순 증감"
              value={data.period_change}
              tone={data.period_change >= 0 ? 'success' : 'danger'}
              showSign
            />
            <KPI
              label="기말 잔액"
              value={data.closing_balance}
              tone="primary"
              highlight
              sub={`${year}-12-31`}
            />
          </div>

          {/* 거래처/거래 수 */}
          <div className="text-2xs text-ink-500 flex items-center gap-4">
            <span>
              거래처 <span className="font-semibold text-ink-700">{data.counterparty_count}곳</span>
            </span>
            <span>
              거래건수 <span className="font-semibold text-ink-700">{data.transaction_count.toLocaleString()}건</span>
            </span>
            <span>
              계정 <span className="font-semibold text-ink-700">{data.account_codes.join(', ')}</span>
            </span>
          </div>

          {/* 월별 차트 — 잔액(라인) + 증감(바) */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <div className="panel p-3">
              <h2 className="text-sm font-semibold text-ink-800 mb-2">월말 잔액 추이</h2>
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={data.monthly}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e4e4e7" />
                  <XAxis dataKey="month" tick={{ fontSize: 9, fill: '#a1a1aa' }} tickLine={false} axisLine={false} />
                  <YAxis
                    tickFormatter={(v) => formatCompactWon(v)}
                    tick={{ fontSize: 9, fill: '#a1a1aa' }}
                    tickLine={false}
                    axisLine={false}
                    width={56}
                  />
                  <Tooltip
                    formatter={(v: any) => formatCurrency(Number(v), false) + '원'}
                    contentStyle={{ fontSize: 11 }}
                  />
                  <Line
                    type="monotone"
                    dataKey="closing_balance"
                    stroke={type === 'receivable' ? '#0d8e88' : '#e11d48'}
                    strokeWidth={2}
                    dot={{ r: 3 }}
                    name="월말 잔액"
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>

            <div className="panel p-3">
              <h2 className="text-sm font-semibold text-ink-800 mb-2">월별 증감 (차변/대변)</h2>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={data.monthly}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e4e4e7" />
                  <XAxis dataKey="month" tick={{ fontSize: 9, fill: '#a1a1aa' }} tickLine={false} axisLine={false} />
                  <YAxis
                    tickFormatter={(v) => formatCompactWon(v)}
                    tick={{ fontSize: 9, fill: '#a1a1aa' }}
                    tickLine={false}
                    axisLine={false}
                    width={56}
                  />
                  <Tooltip
                    formatter={(v: any) => formatCurrency(Number(v), false) + '원'}
                    contentStyle={{ fontSize: 11 }}
                  />
                  <Legend wrapperStyle={{ fontSize: 10 }} />
                  <Bar
                    dataKey="period_debit"
                    fill="#0d8e88"
                    name={type === 'receivable' ? '발생(차변)' : '결제(차변)'}
                  />
                  <Bar
                    dataKey="period_credit"
                    fill="#e11d48"
                    name={type === 'receivable' ? '회수(대변)' : '발생(대변)'}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* 거래처 테이블 */}
          <div className="panel overflow-hidden">
            <div className="px-3 py-2 border-b border-ink-200 flex items-center justify-between gap-2 flex-wrap">
              <h2 className="text-sm font-semibold text-ink-800">
                거래처별 잔액 ({filteredCounterparties.length}곳)
              </h2>
              <input
                type="text"
                className="input text-2xs w-48"
                placeholder="거래처명 검색"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <div className="overflow-x-auto max-h-[500px] overflow-y-auto">
              <table className="min-w-full">
                <thead className="bg-canvas-50 sticky top-0 z-10">
                  <tr>
                    <ThSort label="거래처" sk="name" curr={sortKey} dir={sortDir} onSort={handleSort} align="left" />
                    <ThSort label="기초" sk="opening" curr={sortKey} dir={sortDir} onSort={handleSort} align="right" />
                    <ThSort
                      label={type === 'receivable' ? '발생' : '결제'}
                      sk="debit"
                      curr={sortKey}
                      dir={sortDir}
                      onSort={handleSort}
                      align="right"
                    />
                    <ThSort
                      label={type === 'receivable' ? '회수' : '발생'}
                      sk="credit"
                      curr={sortKey}
                      dir={sortDir}
                      onSort={handleSort}
                      align="right"
                    />
                    <ThSort label="순증감" sk="change" curr={sortKey} dir={sortDir} onSort={handleSort} align="right" />
                    <ThSort label="기말" sk="closing" curr={sortKey} dir={sortDir} onSort={handleSort} align="right" />
                    <ThSort label="거래수" sk="count" curr={sortKey} dir={sortDir} onSort={handleSort} align="right" />
                    <ThSort label="최근거래" sk="latest" curr={sortKey} dir={sortDir} onSort={handleSort} align="right" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {filteredCounterparties.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="px-3 py-6 text-center text-2xs text-ink-400">
                        검색 결과 없음
                      </td>
                    </tr>
                  ) : (
                    filteredCounterparties.map((c) => (
                      <tr key={c.name} className="hover:bg-canvas-50">
                        <td className="px-3 py-1.5 text-xs text-ink-800 max-w-[200px] truncate">{c.name}</td>
                        <Td value={c.opening_balance} />
                        <Td value={c.period_debit} muted={c.period_debit === 0} />
                        <Td value={c.period_credit} muted={c.period_credit === 0} />
                        <Td
                          value={c.period_change}
                          showSign
                          className={
                            c.period_change > 0
                              ? 'text-emerald-700'
                              : c.period_change < 0
                              ? 'text-rose-700'
                              : 'text-ink-300'
                          }
                        />
                        <Td value={c.closing_balance} bold />
                        <td className="px-3 py-1.5 text-right text-2xs text-ink-600">
                          {c.transaction_count.toLocaleString()}
                        </td>
                        <td className="px-3 py-1.5 text-right text-2xs text-ink-500 font-mono">
                          {c.latest_date || '-'}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      <p className="text-2xs text-ink-400 pb-2">
        ※ 매출채권 = 자산(차변 발생 / 대변 회수) · 매입채무 = 부채(대변 발생 / 차변 결제) ·
        기말 잔액은 기초 + 순증감 으로 산출.
      </p>
    </div>
  )
}

// -----------------------------------------------------------------------------
// 보조 컴포넌트
// -----------------------------------------------------------------------------

function KPI({
  label,
  value,
  tone = 'neutral',
  highlight,
  icon,
  sub,
  showSign,
}: {
  label: string
  value: number
  tone?: 'neutral' | 'primary' | 'success' | 'danger'
  highlight?: boolean
  icon?: React.ReactNode
  sub?: React.ReactNode
  showSign?: boolean
}) {
  const toneMap = {
    neutral: 'text-ink-900',
    primary: 'text-primary-700',
    success: 'text-emerald-700',
    danger: 'text-rose-700',
  }
  const sign = showSign && value > 0 ? '+' : ''
  return (
    <div className={`panel px-3 py-2.5 ${highlight ? 'border-2 border-ink-900' : ''}`}>
      <div className="text-2xs font-medium text-ink-500 uppercase tracking-wider flex items-center gap-1 mb-0.5">
        {icon}
        {label}
      </div>
      <div className={`font-mono tabular-nums font-bold ${highlight ? 'text-base' : 'text-sm'} ${toneMap[tone]}`}>
        {sign}
        {formatCurrency(value, false)}
      </div>
      {sub && <div className="text-2xs text-ink-400 mt-0.5">{sub}</div>}
    </div>
  )
}

function Td({
  value,
  muted,
  bold,
  showSign,
  className = '',
}: {
  value: number
  muted?: boolean
  bold?: boolean
  showSign?: boolean
  className?: string
}) {
  if (muted) {
    return <td className="px-3 py-1.5 text-right text-2xs text-ink-200">-</td>
  }
  const sign = showSign && value > 0 ? '+' : ''
  return (
    <td
      className={`px-3 py-1.5 text-right font-mono tabular-nums text-2xs ${
        bold ? 'font-semibold text-ink-900' : 'text-ink-700'
      } ${className}`}
    >
      {sign}
      {formatCurrency(value, false)}
    </td>
  )
}

function ThSort({
  label,
  sk,
  curr,
  dir,
  onSort,
  align,
}: {
  label: string
  sk: SortKey
  curr: SortKey
  dir: SortDir
  onSort: (k: SortKey) => void
  align: 'left' | 'right' | 'center'
}) {
  const active = curr === sk
  const arrow = active ? (dir === 'asc' ? '▲' : '▼') : ''
  const justify =
    align === 'right' ? 'justify-end' : align === 'center' ? 'justify-center' : 'justify-start'
  return (
    <th
      className={`px-3 py-1.5 text-${align} text-2xs font-semibold uppercase tracking-wider cursor-pointer select-none transition ${
        active ? 'text-ink-900 bg-canvas-100' : 'text-ink-500 hover:text-ink-700 hover:bg-canvas-100'
      }`}
      onClick={() => onSort(sk)}
    >
      <span className={`inline-flex items-center gap-1 ${justify}`}>
        {label}
        <span className="text-[8px] w-2 inline-block">{arrow}</span>
      </span>
    </th>
  )
}
