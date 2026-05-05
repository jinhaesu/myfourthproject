import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts'
import {
  ArrowPathIcon,
  CalendarDaysIcon,
  ExclamationTriangleIcon,
  CheckCircleIcon,
  ArrowDownLeftIcon,
  ArrowUpRightIcon,
  ChartBarIcon,
  BanknotesIcon,
} from '@heroicons/react/24/outline'
import { granterApi } from '@/services/api'
import { formatCurrency, formatCompactWon, formatDate } from '@/utils/format'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DailyBalancePoint {
  date: string        // yyyy-MM-dd
  balance: number
  isPast: boolean
}

interface RecurringPattern {
  counterparty: string
  direction: 'IN' | 'OUT'
  /** 대표 금액 (평균) */
  avgAmount: number
  /** 관찰 횟수 */
  count: number
  /** 평균 주기 (일) */
  avgIntervalDays: number
  /** 마지막 발생일 */
  lastDate: string
  /** 신뢰도 0-1 */
  confidence: number
}

interface ForecastEvent {
  date: string
  counterparty: string
  direction: 'IN' | 'OUT'
  amount: number
  confidence: number
}

interface ForecastDay {
  date: string
  expectedIn: number
  expectedOut: number
  balance: number
  isForecast: true
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

function isoToday(): string {
  return new Date().toISOString().slice(0, 10)
}

function isoNDaysAgo(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}

function addDays(isoDate: string, n: number): string {
  const d = new Date(isoDate)
  d.setDate(d.getDate() + n)
  return d.toISOString().slice(0, 10)
}

function diffDays(a: string, b: string): number {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86400000)
}

/** Split a [from, to] range into chunks ≤ maxDays days */
function splitRange(from: string, to: string, maxDays = 31): Array<[string, string]> {
  const chunks: Array<[string, string]> = []
  let cursor = from
  while (cursor <= to) {
    const end = addDays(cursor, maxDays - 1)
    chunks.push([cursor, end > to ? to : end])
    cursor = addDays(end > to ? to : end, 1)
  }
  return chunks
}

// ---------------------------------------------------------------------------
// Pattern detection helpers
// ---------------------------------------------------------------------------

/**
 * Detect recurring patterns from ticket list.
 * Groups by counterparty + direction, looks for ≥2 occurrences,
 * ±10% amount band, 7–31 day interval.
 */
function detectPatterns(tickets: any[]): RecurringPattern[] {
  type Group = {
    dates: string[]
    amounts: number[]
  }
  const map = new Map<string, Group>()

  for (const t of tickets) {
    const counterparty: string =
      t.bankTransaction?.counterparty ?? t.counterparty ?? ''
    if (!counterparty) continue
    const direction: 'IN' | 'OUT' = t.transactionType === 'IN' ? 'IN' : 'OUT'
    const amount = Math.abs(Number(t.amount ?? 0))
    if (amount <= 0) continue
    const date: string = (t.transactAt ?? t.createdAt ?? '').slice(0, 10)
    if (!date) continue

    const key = `${direction}|${counterparty}`
    if (!map.has(key)) map.set(key, { dates: [], amounts: [] })
    const g = map.get(key)!
    g.dates.push(date)
    g.amounts.push(amount)
  }

  const results: RecurringPattern[] = []

  for (const [key, g] of map.entries()) {
    if (g.dates.length < 2) continue

    const [direction, counterparty] = key.split('|') as ['IN' | 'OUT', string]

    // Sort dates ascending
    const sorted = g.dates
      .map((d, i) => ({ date: d, amount: g.amounts[i] }))
      .sort((a, b) => a.date.localeCompare(b.date))

    // Check amounts are within ±10% of the median
    const sortedAmounts = [...sorted.map((s) => s.amount)].sort((a, b) => a - b)
    const median = sortedAmounts[Math.floor(sortedAmounts.length / 2)]
    const consistent = sorted.filter(
      (s) => s.amount >= median * 0.9 && s.amount <= median * 1.1
    )
    if (consistent.length < 2) continue

    // Compute intervals
    const intervals: number[] = []
    for (let i = 1; i < consistent.length; i++) {
      const d = diffDays(consistent[i - 1].date, consistent[i].date)
      intervals.push(d)
    }
    const avgInterval =
      intervals.reduce((s, v) => s + v, 0) / intervals.length

    // Only keep 7–31 day cycles
    if (avgInterval < 7 || avgInterval > 31) continue

    const avgAmount =
      consistent.reduce((s, v) => s + v.amount, 0) / consistent.length
    const count = consistent.length
    const confidence = count >= 5 ? 0.9 : count >= 3 ? 0.7 : 0.5
    const lastDate = consistent[consistent.length - 1].date

    results.push({
      counterparty,
      direction,
      avgAmount,
      count,
      avgIntervalDays: Math.round(avgInterval),
      lastDate,
      confidence,
    })
  }

  return results
}

/**
 * Project recurring patterns over the next 30 days.
 */
function projectForecastEvents(
  patterns: RecurringPattern[],
  fromDate: string,
  days = 30
): ForecastEvent[] {
  const events: ForecastEvent[] = []
  const toDate = addDays(fromDate, days - 1)

  for (const p of patterns) {
    let nextDate = addDays(p.lastDate, p.avgIntervalDays)
    // Advance until within window
    while (nextDate < fromDate) {
      nextDate = addDays(nextDate, p.avgIntervalDays)
    }
    while (nextDate <= toDate) {
      events.push({
        date: nextDate,
        counterparty: p.counterparty,
        direction: p.direction,
        amount: p.avgAmount,
        confidence: p.confidence,
      })
      nextDate = addDays(nextDate, p.avgIntervalDays)
    }
  }

  return events.sort((a, b) => a.date.localeCompare(b.date))
}

// ---------------------------------------------------------------------------
// Custom tooltip
// ---------------------------------------------------------------------------

function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  const point = payload[0]?.payload
  return (
    <div className="panel px-3 py-2 text-2xs shadow-pop min-w-[140px]">
      <div className="font-semibold text-ink-700 mb-1">{label}</div>
      {point?.isPast === false && point?.isForecast && (
        <div className="text-2xs text-amber-600 font-medium mb-1">예측</div>
      )}
      {payload.map((p: any) => (
        <div key={p.dataKey} className="flex items-center justify-between gap-3">
          <span style={{ color: p.color }}>{p.name}</span>
          <span className="font-mono tabular-nums text-ink-900">
            {formatCompactWon(p.value)}
          </span>
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// KPI card
// ---------------------------------------------------------------------------

function KPI({
  label,
  value,
  tone = 'neutral',
  highlight = false,
  icon,
  sub,
}: {
  label: string
  value: number | undefined
  tone?: 'neutral' | 'primary' | 'success' | 'danger' | 'warning'
  highlight?: boolean
  icon?: React.ReactNode
  sub?: React.ReactNode
}) {
  const v = Number(value ?? 0)
  const toneClass: Record<string, string> = {
    neutral: 'text-ink-900',
    primary: 'text-primary-700',
    success: 'text-emerald-700',
    danger: 'text-rose-700',
    warning: 'text-amber-700',
  }
  return (
    <div className={`panel px-3 py-2.5 ${highlight ? 'border-2 border-ink-900' : ''}`}>
      <div className="text-2xs font-medium text-ink-500 uppercase tracking-wider flex items-center gap-1 mb-0.5">
        {icon}
        {label}
      </div>
      <div
        className={`font-mono tabular-nums font-bold ${highlight ? 'text-base' : 'text-sm'} ${toneClass[tone]}`}
      >
        {formatCurrency(v, false)}
      </div>
      {sub && <div className="mt-0.5">{sub}</div>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Confidence badge
// ---------------------------------------------------------------------------

function ConfBadge({ confidence }: { confidence: number }) {
  const pct = Math.round(confidence * 100)
  const cls =
    pct >= 90
      ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
      : pct >= 70
      ? 'bg-primary-50 text-primary-700 border-primary-200'
      : 'bg-ink-50 text-ink-600 border-ink-200'
  return <span className={`badge ${cls}`}>{pct}%</span>
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function CashflowForecastPage() {
  const today = isoToday()
  const [from, setFrom] = useState(() => isoNDaysAgo(59))
  const [to, setTo] = useState(today)

  // ---------------------------------------------------------------------------
  // Health check
  // ---------------------------------------------------------------------------

  const healthQuery = useQuery({
    queryKey: ['granter-health'],
    queryFn: () => granterApi.health().then((r) => r.data),
    retry: false,
  })
  const isConfigured = healthQuery.data?.configured

  // ---------------------------------------------------------------------------
  // Daily report — split into ≤31-day chunks (granter limit)
  // ---------------------------------------------------------------------------

  const reportQuery = useQuery({
    queryKey: ['cashflow-daily-report', from, to],
    queryFn: async () => {
      const chunks = splitRange(from, to, 31)
      const results = await Promise.all(
        chunks.map((c) =>
          granterApi
            .getDailyReport({ startDate: c[0], endDate: c[1] })
            .then((r) => r.data)
        )
      )
      return results
    },
    enabled: !!isConfigured,
    retry: false,
  })

  // ---------------------------------------------------------------------------
  // Tickets for pattern analysis — also chunked
  // ---------------------------------------------------------------------------

  const ticketsQuery = useQuery({
    queryKey: ['cashflow-tickets', from, to],
    queryFn: async () => {
      const chunks = splitRange(from, to, 31)
      const results = await Promise.all(
        chunks.map((c) =>
          granterApi
            .listTicketsAllTypes(c[0], c[1])
            .then((r) => r.data)
        )
      )
      // Merge ticket arrays from all chunks
      const allTickets: any[] = []
      for (const r of results) {
        const tickets = r?.tickets ?? r?.data ?? r ?? []
        if (Array.isArray(tickets)) allTickets.push(...tickets)
      }
      return allTickets
    },
    enabled: !!isConfigured,
    retry: false,
  })

  // ---------------------------------------------------------------------------
  // Build historical balance time-series from daily report chunks
  // ---------------------------------------------------------------------------

  const historicalPoints = useMemo<DailyBalancePoint[]>(() => {
    if (!reportQuery.data) return []
    const pointMap = new Map<string, number>()

    for (const reportData of reportQuery.data) {
      const assets: any[] = reportData?.assets ?? []
      for (const asset of assets) {
        if (asset.isLoan) continue
        for (const b of asset.balances ?? []) {
          const date: string = b.baseDate?.slice(0, 10)
          if (!date) continue
          const bal = Number(b.accountBalance ?? 0)
          pointMap.set(date, (pointMap.get(date) ?? 0) + bal)
        }
      }
    }

    if (pointMap.size === 0) {
      // Fallback: use total currentBalance on today
      const last = reportQuery.data[reportQuery.data.length - 1]
      const cb = Number(last?.total?.currentBalance ?? 0)
      if (cb) pointMap.set(today, cb)
    }

    return Array.from(pointMap.entries())
      .map(([date, balance]) => ({ date, balance, isPast: true }))
      .sort((a, b) => a.date.localeCompare(b.date))
  }, [reportQuery.data, today])

  // Current balance = last known balance
  const currentBalance = useMemo(() => {
    if (historicalPoints.length > 0) {
      return historicalPoints[historicalPoints.length - 1].balance
    }
    const last = reportQuery.data?.[reportQuery.data.length - 1]
    return Number(last?.total?.currentBalance ?? 0)
  }, [historicalPoints, reportQuery.data])

  // ---------------------------------------------------------------------------
  // Pattern detection
  // ---------------------------------------------------------------------------

  const patterns = useMemo<RecurringPattern[]>(() => {
    if (!ticketsQuery.data) return []
    return detectPatterns(ticketsQuery.data)
  }, [ticketsQuery.data])

  // ---------------------------------------------------------------------------
  // 30-day forecast
  // ---------------------------------------------------------------------------

  const forecastEvents = useMemo<ForecastEvent[]>(
    () => projectForecastEvents(patterns, addDays(today, 1), 30),
    [patterns, today]
  )

  const forecastDays = useMemo<ForecastDay[]>(() => {
    const days: ForecastDay[] = []
    let runningBalance = currentBalance

    for (let i = 1; i <= 30; i++) {
      const date = addDays(today, i)
      const dayEvents = forecastEvents.filter((e) => e.date === date)
      const expectedIn = dayEvents
        .filter((e) => e.direction === 'IN')
        .reduce((s, e) => s + e.amount * e.confidence, 0)
      const expectedOut = dayEvents
        .filter((e) => e.direction === 'OUT')
        .reduce((s, e) => s + e.amount * e.confidence, 0)
      runningBalance += expectedIn - expectedOut
      days.push({ date, expectedIn, expectedOut, balance: runningBalance, isForecast: true })
    }
    return days
  }, [currentBalance, forecastEvents, today])

  // ---------------------------------------------------------------------------
  // Chart data — past + forecast merged
  // ---------------------------------------------------------------------------

  const chartData = useMemo(() => {
    const past = historicalPoints.map((p) => ({
      date: p.date,
      label: p.date.slice(5), // MM-DD
      잔액: p.balance,
      예측잔액: undefined as number | undefined,
      isPast: true,
      isForecast: false,
    }))

    // Add today's balance as bridge point for forecast line
    const bridge = {
      date: today,
      label: today.slice(5),
      잔액: currentBalance,
      예측잔액: currentBalance,
      isPast: true,
      isForecast: false,
    }

    const forecast = forecastDays.map((d) => ({
      date: d.date,
      label: d.date.slice(5),
      잔액: undefined as number | undefined,
      예측잔액: d.balance,
      isPast: false,
      isForecast: true,
    }))

    // Merge — if today already in past, update its 예측잔액
    const merged = past.map((p) =>
      p.date === today ? { ...p, 예측잔액: currentBalance } : p
    )
    const todayInPast = merged.some((p) => p.date === today)
    return [...merged, ...(todayInPast ? [] : [bridge]), ...forecast]
  }, [historicalPoints, forecastDays, currentBalance, today])

  // ---------------------------------------------------------------------------
  // KPIs
  // ---------------------------------------------------------------------------

  const balance30d = forecastDays[forecastDays.length - 1]?.balance ?? currentBalance
  const totalForecastIn = forecastDays.reduce((s, d) => s + d.expectedIn, 0)
  const totalForecastOut = forecastDays.reduce((s, d) => s + d.expectedOut, 0)

  // First day balance goes negative
  const riskDay = forecastDays.find((d) => d.balance < 0)

  // ---------------------------------------------------------------------------
  // Loading / error states
  // ---------------------------------------------------------------------------

  const isLoading = reportQuery.isLoading || ticketsQuery.isLoading
  const hasError = reportQuery.isError || ticketsQuery.isError

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-end justify-between flex-wrap gap-2">
        <div>
          <h1 className="flex items-center gap-2">
            <ChartBarIcon className="h-4 w-4 text-ink-500" />
            캐시플로우 예측
          </h1>
          <p className="text-2xs text-ink-500 mt-0.5">
            과거 {diffDays(from, to) + 1}일 거래 패턴 분석 → 향후 30일 잔액 예측
          </p>
        </div>

        <div className="flex items-center gap-1.5 flex-wrap">
          {/* Quick ranges */}
          <div className="flex items-center gap-0.5 p-0.5 rounded-md bg-white border border-ink-200">
            {[30, 60, 90].map((n) => (
              <button
                key={n}
                onClick={() => setFrom(isoNDaysAgo(n - 1))}
                className={`px-2 py-1 rounded text-2xs font-semibold hover:bg-ink-50 ${
                  diffDays(from, today) + 1 === n
                    ? 'bg-ink-100 text-ink-900'
                    : 'text-ink-600'
                }`}
              >
                {n}일
              </button>
            ))}
          </div>

          {/* Date range */}
          <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-white border border-ink-200">
            <CalendarDaysIcon className="h-3 w-3 text-ink-400" />
            <input
              type="date"
              value={from}
              max={to}
              onChange={(e) => setFrom(e.target.value)}
              className="bg-transparent text-2xs text-ink-700 w-24 focus:outline-none"
            />
            <span className="text-ink-300">→</span>
            <input
              type="date"
              value={to}
              max={today}
              onChange={(e) => setTo(e.target.value)}
              className="bg-transparent text-2xs text-ink-700 w-24 focus:outline-none"
            />
          </div>

          <button
            onClick={() => {
              reportQuery.refetch()
              ticketsQuery.refetch()
            }}
            disabled={isLoading}
            className="btn-secondary"
          >
            <ArrowPathIcon className={`h-3 w-3 ${isLoading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Connection status */}
      {healthQuery.isFetched && !isConfigured && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 flex items-center gap-2">
          <ExclamationTriangleIcon className="h-4 w-4 text-amber-600 shrink-0" />
          <span className="text-2xs text-amber-800">
            그랜터 API 키 미설정 — Railway 환경변수 등록 필요
          </span>
        </div>
      )}

      {healthQuery.isFetched && isConfigured && (
        <div className="flex items-center gap-2 flex-wrap">
          <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-1 flex items-center gap-2">
            <CheckCircleIcon className="h-3.5 w-3.5 text-emerald-600" />
            <span className="text-2xs text-emerald-800">그랜터 연결됨</span>
          </div>
          {patterns.length > 0 && (
            <div className="text-2xs text-ink-500">
              반복 패턴 감지{' '}
              <span className="font-semibold text-ink-700">{patterns.length}개</span>
            </div>
          )}
        </div>
      )}

      {/* Risk warning */}
      {riskDay && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 flex items-center gap-2">
          <ExclamationTriangleIcon className="h-4 w-4 text-rose-600 shrink-0" />
          <div className="text-2xs text-rose-800">
            <span className="font-semibold">자금 부족 위험</span> — {formatDate(riskDay.date)}에
            잔액이{' '}
            <span className="font-mono font-semibold">
              {formatCurrency(riskDay.balance, false)}원
            </span>
            으로 전환 예상. 사전 자금 조달 또는 지출 조정 검토 필요.
          </div>
        </div>
      )}

      {/* KPI row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <KPI
          label="현재 잔액"
          value={currentBalance}
          tone="primary"
          highlight
          icon={<BanknotesIcon className="h-3 w-3" />}
        />
        <KPI
          label="30일 후 예상 잔액"
          value={balance30d}
          tone={balance30d < 0 ? 'danger' : balance30d < currentBalance ? 'warning' : 'success'}
          icon={<ChartBarIcon className="h-3 w-3" />}
        />
        <KPI
          label="예상 입금 합계"
          value={totalForecastIn}
          tone="success"
          icon={<ArrowDownLeftIcon className="h-3 w-3" />}
          sub={
            <span className="text-2xs text-ink-400">
              {forecastEvents.filter((e) => e.direction === 'IN').length}건 예정
            </span>
          }
        />
        <KPI
          label="예상 출금 합계"
          value={totalForecastOut}
          tone="danger"
          icon={<ArrowUpRightIcon className="h-3 w-3" />}
          sub={
            riskDay ? (
              <span className="text-2xs text-amber-600 font-medium">
                위험일: {riskDay.date.slice(5)}
              </span>
            ) : (
              <span className="text-2xs text-ink-400">
                {forecastEvents.filter((e) => e.direction === 'OUT').length}건 예정
              </span>
            )
          }
        />
      </div>

      {/* Chart */}
      <div className="panel p-3">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-ink-800">잔액 추이 + 30일 예측</h2>
          <div className="flex items-center gap-3 text-2xs text-ink-500">
            <span className="flex items-center gap-1">
              <span className="inline-block w-4 h-0.5 bg-primary-500 rounded" />
              실제 잔액
            </span>
            <span className="flex items-center gap-1">
              <span
                className="inline-block w-4 h-0.5 rounded"
                style={{
                  background: 'repeating-linear-gradient(90deg,#f59e0b 0,#f59e0b 4px,transparent 4px,transparent 8px)',
                }}
              />
              예측 잔액
            </span>
          </div>
        </div>

        {isLoading ? (
          <div className="h-56 flex items-center justify-center text-2xs text-ink-400">
            데이터 불러오는 중…
          </div>
        ) : hasError ? (
          <div className="h-56 flex items-center justify-center text-2xs text-rose-500">
            데이터 로드 실패. 다시 시도해 주세요.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e4e4e7" />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 9, fill: '#a1a1aa' }}
                interval={Math.floor(chartData.length / 8)}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                tick={{ fontSize: 9, fill: '#a1a1aa' }}
                tickFormatter={(v) => formatCompactWon(v)}
                tickLine={false}
                axisLine={false}
                width={52}
              />
              <Tooltip content={<ChartTooltip />} />
              <ReferenceLine y={0} stroke="#ef4444" strokeDasharray="4 2" strokeWidth={1} />
              {riskDay && (
                <ReferenceLine
                  x={riskDay.date.slice(5)}
                  stroke="#f59e0b"
                  strokeDasharray="4 2"
                  label={{ value: '위험', fill: '#d97706', fontSize: 9 }}
                />
              )}
              <Line
                type="monotone"
                dataKey="잔액"
                stroke="#15b0a8"
                strokeWidth={1.5}
                dot={false}
                connectNulls={false}
                name="실제 잔액"
              />
              <Line
                type="monotone"
                dataKey="예측잔액"
                stroke="#f59e0b"
                strokeWidth={1.5}
                strokeDasharray="5 3"
                dot={false}
                connectNulls={false}
                name="예측 잔액"
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Two-column lower section */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {/* Forecast schedule table */}
        <div className="panel overflow-hidden">
          <div className="px-3 py-2 border-b border-ink-200 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-ink-800">예상 입출금 일정 (30일)</h2>
            <span className="text-2xs text-ink-400">{forecastEvents.length}건</span>
          </div>

          {forecastEvents.length === 0 && !isLoading ? (
            <div className="px-3 py-6 text-center text-2xs text-ink-400">
              분석할 반복 패턴이 없습니다. 기간을 늘려 더 많은 데이터를 수집하세요.
            </div>
          ) : (
            <div className="overflow-x-auto max-h-72 overflow-y-auto">
              <table className="min-w-full">
                <thead className="bg-canvas-50 sticky top-0 z-10">
                  <tr>
                    <th className="px-3 py-1.5 text-left text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                      날짜
                    </th>
                    <th className="px-3 py-1.5 text-left text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                      거래처
                    </th>
                    <th className="px-3 py-1.5 text-right text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                      금액
                    </th>
                    <th className="px-3 py-1.5 text-right text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                      신뢰도
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {isLoading && (
                    <tr>
                      <td colSpan={4} className="py-6 text-center text-2xs text-ink-400">
                        불러오는 중…
                      </td>
                    </tr>
                  )}
                  {!isLoading &&
                    forecastEvents.map((ev, idx) => (
                      <tr key={idx} className="hover:bg-canvas-50">
                        <td className="px-3 py-1.5 font-mono text-2xs text-ink-600 whitespace-nowrap">
                          {ev.date}
                        </td>
                        <td className="px-3 py-1.5 text-xs text-ink-800 max-w-[130px] truncate">
                          {ev.counterparty}
                        </td>
                        <td
                          className={`px-3 py-1.5 text-right font-mono tabular-nums text-xs font-semibold ${
                            ev.direction === 'IN' ? 'text-emerald-700' : 'text-rose-700'
                          }`}
                        >
                          {ev.direction === 'IN' ? '+' : '-'}
                          {formatCurrency(ev.amount, false)}
                        </td>
                        <td className="px-3 py-1.5 text-right">
                          <ConfBadge confidence={ev.confidence} />
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Recurring patterns table */}
        <div className="panel overflow-hidden">
          <div className="px-3 py-2 border-b border-ink-200 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-ink-800">감지된 반복 패턴</h2>
            <span className="text-2xs text-ink-400">{patterns.length}개</span>
          </div>

          {patterns.length === 0 && !isLoading ? (
            <div className="px-3 py-6 text-center text-2xs text-ink-400">
              반복 패턴 없음 — 데이터 기간을 늘리거나 그랜터 연결 상태를 확인하세요.
            </div>
          ) : (
            <div className="overflow-x-auto max-h-72 overflow-y-auto">
              <table className="min-w-full">
                <thead className="bg-canvas-50 sticky top-0 z-10">
                  <tr>
                    <th className="px-3 py-1.5 text-left text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                      거래처
                    </th>
                    <th className="px-3 py-1.5 text-left text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                      구분
                    </th>
                    <th className="px-3 py-1.5 text-right text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                      평균 금액
                    </th>
                    <th className="px-3 py-1.5 text-right text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                      주기
                    </th>
                    <th className="px-3 py-1.5 text-right text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                      횟수
                    </th>
                    <th className="px-3 py-1.5 text-right text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                      신뢰도
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {isLoading && (
                    <tr>
                      <td colSpan={6} className="py-6 text-center text-2xs text-ink-400">
                        불러오는 중…
                      </td>
                    </tr>
                  )}
                  {!isLoading &&
                    patterns
                      .sort((a, b) => b.avgAmount - a.avgAmount)
                      .map((p, idx) => (
                        <tr key={idx} className="hover:bg-canvas-50">
                          <td className="px-3 py-1.5 text-xs text-ink-800 max-w-[140px] truncate">
                            {p.counterparty}
                          </td>
                          <td className="px-3 py-1.5">
                            {p.direction === 'IN' ? (
                              <span className="badge bg-emerald-50 text-emerald-700 border-emerald-200">
                                입금
                              </span>
                            ) : (
                              <span className="badge bg-rose-50 text-rose-700 border-rose-200">
                                출금
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-1.5 text-right font-mono tabular-nums text-xs text-ink-800">
                            {formatCurrency(p.avgAmount, false)}
                          </td>
                          <td className="px-3 py-1.5 text-right text-2xs text-ink-600 whitespace-nowrap">
                            ~{p.avgIntervalDays}일
                          </td>
                          <td className="px-3 py-1.5 text-right text-2xs text-ink-600">
                            {p.count}회
                          </td>
                          <td className="px-3 py-1.5 text-right">
                            <ConfBadge confidence={p.confidence} />
                          </td>
                        </tr>
                      ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* 30-day daily forecast detail */}
      <div className="panel overflow-hidden">
        <div className="px-3 py-2 border-b border-ink-200 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink-800">30일 일별 예측 상세</h2>
          <span className="text-2xs text-ink-500">예상 입금 - 출금 = 잔액 변화</span>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full">
            <thead className="bg-canvas-50">
              <tr>
                <th className="px-3 py-1.5 text-left text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                  날짜
                </th>
                <th className="px-3 py-1.5 text-right text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                  예상 입금
                </th>
                <th className="px-3 py-1.5 text-right text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                  예상 출금
                </th>
                <th className="px-3 py-1.5 text-right text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                  일 순변동
                </th>
                <th className="px-3 py-1.5 text-right text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                  예상 잔액
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {forecastDays.map((d) => {
                const net = d.expectedIn - d.expectedOut
                const isRisk = d.balance < 0
                return (
                  <tr
                    key={d.date}
                    className={`hover:bg-canvas-50 ${isRisk ? 'bg-rose-50/60' : ''}`}
                  >
                    <td
                      className={`px-3 py-1.5 font-mono text-2xs whitespace-nowrap ${
                        isRisk ? 'text-rose-700 font-semibold' : 'text-ink-600'
                      }`}
                    >
                      {d.date}
                      {isRisk && (
                        <ExclamationTriangleIcon className="inline-block ml-1 h-3 w-3 text-rose-500" />
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono tabular-nums text-2xs text-emerald-700">
                      {d.expectedIn > 0 ? `+${formatCurrency(d.expectedIn, false)}` : <span className="text-ink-200">-</span>}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono tabular-nums text-2xs text-rose-700">
                      {d.expectedOut > 0 ? `-${formatCurrency(d.expectedOut, false)}` : <span className="text-ink-200">-</span>}
                    </td>
                    <td
                      className={`px-3 py-1.5 text-right font-mono tabular-nums text-2xs font-medium ${
                        net > 0 ? 'text-emerald-700' : net < 0 ? 'text-rose-700' : 'text-ink-300'
                      }`}
                    >
                      {net !== 0 ? (
                        <>
                          {net > 0 ? '+' : ''}
                          {formatCurrency(net, false)}
                        </>
                      ) : (
                        <span className="text-ink-200">0</span>
                      )}
                    </td>
                    <td
                      className={`px-3 py-1.5 text-right font-mono tabular-nums text-xs font-semibold ${
                        isRisk ? 'text-rose-700' : 'text-ink-900'
                      }`}
                    >
                      {formatCurrency(d.balance, false)}
                    </td>
                  </tr>
                )
              })}
              {forecastDays.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-6 text-center text-2xs text-ink-400">
                    예측 데이터 없음
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Footer note */}
      <p className="text-2xs text-ink-400 pb-2">
        예측은 과거 반복 패턴(동일 거래처 ± 10% 금액, 7~31일 주기) 기반이며 실제와 다를 수 있습니다.
        3회 이상 반복 → 70% · 5회 이상 → 90% 신뢰도. 신규 거래·일회성 이벤트는 미반영.
      </p>
    </div>
  )
}
