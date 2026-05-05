import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts'
import {
  ArrowPathIcon,
  ExclamationTriangleIcon,
  CheckCircleIcon,
  ArrowDownLeftIcon,
  ArrowUpRightIcon,
  ChartBarIcon,
  BanknotesIcon,
} from '@heroicons/react/24/outline'
import { granterApi } from '@/services/api'
import { formatCurrency, formatCompactWon, formatDate, isoLocal, flattenTickets } from '@/utils/format'
import PeriodPicker, {
  periodForPreset,
  type PeriodPreset,
} from '@/components/common/PeriodPicker'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DailyBalancePoint {
  date: string
  balance: number
}

interface RecurringPattern {
  counterparty: string
  direction: 'IN' | 'OUT'
  avgAmount: number
  count: number
  avgIntervalDays: number
  lastDate: string
  confidence: number
}

interface ForecastDay {
  date: string
  expectedIn: number
  expectedOut: number
  balance: number
}

interface AccountRow {
  assetId: number
  assetName: string
  organizationName: string
  isLoan: boolean
  currentBalance: number
  forecast30d: number
}

interface MonthlyRevBar {
  label: string   // "M-2", "M-1", "이번달"
  amount: number
  isPartial: boolean
}

// ---------------------------------------------------------------------------
// Date utilities
// ---------------------------------------------------------------------------

function isoToday(): string {
  return isoLocal(new Date())
}

function addDays(iso: string, n: number): string {
  const d = new Date(iso)
  d.setDate(d.getDate() + n)
  return isoLocal(d)
}

function diffDays(a: string, b: string): number {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86400000)
}

/** 31일 단일 호출 범위: 종료일 기준 31일 클램프 */
function clampTo31(start: string, end: string): { effectiveStart: string; clamped: boolean } {
  const span = diffDays(start, end) + 1
  if (span <= 31) return { effectiveStart: start, clamped: false }
  return { effectiveStart: addDays(end, -30), clamped: true }
}

// ---------------------------------------------------------------------------
// Counterparty extraction (SettlementPage pattern)
// ---------------------------------------------------------------------------

function str(obj: any, ...keys: string[]): string {
  for (const k of keys) {
    const v = obj?.[k]
    if (v !== undefined && v !== null && v !== '') return String(v)
  }
  return ''
}

function extractCounterparty(t: any): string {
  if (t?.taxInvoice) {
    const ti = t.taxInvoice
    if (str(t, 'transactionType') === 'IN')
      return str(ti?.contractor, 'companyName') || str(ti?.supplier, 'companyName') || ''
    return str(ti?.supplier, 'companyName') || str(ti?.contractor, 'companyName') || ''
  }
  if (t?.cashReceipt)
    return (
      str(t.cashReceipt?.issuer, 'companyName') ||
      str(t.cashReceipt?.issuer, 'userName') ||
      ''
    )
  return (
    str(t, 'contact') ||
    str(t?.bankTransaction, 'counterparty') ||
    str(t?.cardUsage, 'storeName') ||
    str(t?.bankTransaction, 'content') ||
    str(t, 'content', 'merchantName', 'counterpartyName', 'vendor') ||
    ''
  )
}

// ---------------------------------------------------------------------------
// Pattern detection  (≥3 occurrences, ±10% amount, 7–31 day interval)
// ---------------------------------------------------------------------------

function detectPatterns(tickets: any[]): RecurringPattern[] {
  type Group = { dates: string[]; amounts: number[] }
  const map = new Map<string, Group>()

  for (const t of tickets) {
    const cp = extractCounterparty(t)
    if (!cp) continue
    const dir: 'IN' | 'OUT' = t.transactionType === 'IN' ? 'IN' : 'OUT'
    const amount = Math.abs(Number(t.amount ?? 0))
    if (amount <= 0) continue
    const date: string = (t.transactAt ?? t.createdAt ?? '').slice(0, 10)
    if (!date) continue
    const key = `${dir}|${cp}`
    if (!map.has(key)) map.set(key, { dates: [], amounts: [] })
    const g = map.get(key)!
    g.dates.push(date)
    g.amounts.push(amount)
  }

  const results: RecurringPattern[] = []
  for (const [key, g] of map.entries()) {
    if (g.dates.length < 3) continue
    const [direction, counterparty] = key.split('|') as ['IN' | 'OUT', string]

    const sorted = g.dates
      .map((d, i) => ({ date: d, amount: g.amounts[i] }))
      .sort((a, b) => a.date.localeCompare(b.date))

    const sortedAmt = [...sorted.map((s) => s.amount)].sort((a, b) => a - b)
    const median = sortedAmt[Math.floor(sortedAmt.length / 2)]
    const consistent = sorted.filter(
      (s) => s.amount >= median * 0.9 && s.amount <= median * 1.1
    )
    if (consistent.length < 3) continue

    const intervals: number[] = []
    for (let i = 1; i < consistent.length; i++) {
      intervals.push(diffDays(consistent[i - 1].date, consistent[i].date))
    }
    const avgInterval = intervals.reduce((s, v) => s + v, 0) / intervals.length
    if (avgInterval < 7 || avgInterval > 31) continue

    const avgAmount = consistent.reduce((s, v) => s + v.amount, 0) / consistent.length
    const count = consistent.length
    const confidence = count >= 5 ? 0.9 : count >= 3 ? 0.7 : 0.5
    const lastDate = consistent[consistent.length - 1].date

    results.push({ counterparty, direction, avgAmount, count, avgIntervalDays: Math.round(avgInterval), lastDate, confidence })
  }
  return results
}

// ---------------------------------------------------------------------------
// Forecast projection
// ---------------------------------------------------------------------------

function buildForecast(
  patterns: RecurringPattern[],
  startBalance: number,
  fromDate: string,
  days = 30
): ForecastDay[] {
  // Pre-index forecast events by date
  const eventsByDate = new Map<string, { totalIn: number; totalOut: number }>()
  const toDate = addDays(fromDate, days - 1)

  for (const p of patterns) {
    let next = addDays(p.lastDate, p.avgIntervalDays)
    while (next < fromDate) next = addDays(next, p.avgIntervalDays)
    while (next <= toDate) {
      if (!eventsByDate.has(next)) eventsByDate.set(next, { totalIn: 0, totalOut: 0 })
      const ev = eventsByDate.get(next)!
      if (p.direction === 'IN') ev.totalIn += p.avgAmount * p.confidence
      else ev.totalOut += p.avgAmount * p.confidence
      next = addDays(next, p.avgIntervalDays)
    }
  }

  const result: ForecastDay[] = []
  let running = startBalance
  for (let i = 0; i < days; i++) {
    const date = addDays(fromDate, i)
    const ev = eventsByDate.get(date) ?? { totalIn: 0, totalOut: 0 }
    running += ev.totalIn - ev.totalOut
    result.push({ date, expectedIn: ev.totalIn, expectedOut: ev.totalOut, balance: running })
  }
  return result
}

// ---------------------------------------------------------------------------
// Monthly revenue bars from BANK IN daily sums
// ---------------------------------------------------------------------------

function buildMonthlyRevBars(
  tickets: any[],
  today: string
): MonthlyRevBar[] {
  // Sum BANK IN per day, then aggregate by month
  const dailyIn = new Map<string, number>()
  for (const t of tickets) {
    if (t.transactionType !== 'IN') continue
    // Only bank transactions count as revenue proxy
    if (!t.bankTransaction && t.taxInvoice) continue
    const amount = Math.abs(Number(t.amount ?? 0))
    if (amount <= 0) continue
    const date = (t.transactAt ?? t.createdAt ?? '').slice(0, 10)
    if (!date) continue
    dailyIn.set(date, (dailyIn.get(date) ?? 0) + amount)
  }

  // Aggregate to month YYYY-MM
  const monthMap = new Map<string, number>()
  for (const [date, amt] of dailyIn.entries()) {
    const m = date.slice(0, 7)
    monthMap.set(m, (monthMap.get(m) ?? 0) + amt)
  }

  if (monthMap.size === 0) return []

  const currentMonth = today.slice(0, 7)
  const sortedMonths = Array.from(monthMap.keys()).sort()
  // Take last 3 months max
  const last3 = sortedMonths.slice(-3)

  const todayDay = Number(today.slice(8, 10))
  const daysInMonth = new Date(
    Number(today.slice(0, 4)),
    Number(today.slice(5, 7)),
    0
  ).getDate()

  return last3.map((m, i) => {
    const isPartial = m === currentMonth
    const raw = monthMap.get(m) ?? 0
    // Annualise partial month for current month display
    const amount = isPartial && todayDay > 0
      ? Math.round((raw / todayDay) * daysInMonth)
      : raw
    const label = i === last3.length - 1 ? '이번달' : i === last3.length - 2 ? '지난달' : '2달전'
    return { label, amount, isPartial }
  })
}

// ---------------------------------------------------------------------------
// Custom tooltip
// ---------------------------------------------------------------------------

function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  const isForecast = payload[0]?.payload?.isForecast
  return (
    <div className="panel px-3 py-2 text-2xs shadow-pop min-w-[140px]">
      <div className="font-semibold text-ink-700 mb-1">{label}</div>
      {isForecast && (
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

type KpiTone = 'neutral' | 'primary' | 'success' | 'danger' | 'warning'

function KPI({
  label,
  value,
  tone = 'neutral',
  highlight,
  icon,
  sub,
}: {
  label: string
  value: number | undefined
  tone?: KpiTone
  highlight?: boolean
  icon?: React.ReactNode
  sub?: React.ReactNode
}) {
  const v = Number(value ?? 0)
  const toneMap: Record<KpiTone, string> = {
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
        className={`font-mono tabular-nums font-bold ${
          highlight ? 'text-base' : 'text-sm'
        } ${toneMap[tone]}`}
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

  // Period state — default last_30d (30 days = ≤31 day limit)
  const defaultPeriod = periodForPreset('last_30d')
  const [preset, setPreset] = useState<PeriodPreset>('last_30d')
  const [from, setFrom] = useState(defaultPeriod.start)
  const [to, setTo] = useState(defaultPeriod.end)

  // Clamp to 31 days from the end date
  const { effectiveStart, clamped } = clampTo31(from, to)

  // ---------------------------------------------------------------------------
  // Health check
  // ---------------------------------------------------------------------------

  const healthQuery = useQuery({
    queryKey: ['granter-health'],
    queryFn: () => granterApi.health().then((r) => r.data),
    retry: false,
    staleTime: 60_000,
  })
  const isConfigured = healthQuery.data?.configured

  // ---------------------------------------------------------------------------
  // Single 31-day daily report call — NO chunking
  // ---------------------------------------------------------------------------

  const reportQuery = useQuery({
    queryKey: ['cashflow-daily-report', effectiveStart, to],
    queryFn: () =>
      granterApi
        .getDailyReport({ startDate: effectiveStart, endDate: to })
        .then((r) => r.data),
    enabled: !!isConfigured,
    retry: 1,
    staleTime: 120_000,
  })

  // ---------------------------------------------------------------------------
  // Single 31-day ticket call for pattern analysis — NO chunking
  // ---------------------------------------------------------------------------

  const ticketsQuery = useQuery({
    queryKey: ['cashflow-tickets', effectiveStart, to],
    queryFn: () =>
      granterApi
        .listTicketsAllTypes(effectiveStart, to)
        .then((r) => flattenTickets(r.data)),
    enabled: !!isConfigured,
    retry: 1,
    staleTime: 120_000,
  })

  // ---------------------------------------------------------------------------
  // Historical balance time-series
  // ---------------------------------------------------------------------------

  const historicalPoints = useMemo<DailyBalancePoint[]>(() => {
    const reportData = reportQuery.data
    if (!reportData) return []
    const pointMap = new Map<string, number>()

    const assets: any[] = reportData?.assets ?? []
    for (const asset of assets) {
      if (asset.isLoan) continue
      for (const b of asset.balances ?? []) {
        const date: string = b.baseDate?.slice(0, 10)
        if (!date) continue
        pointMap.set(date, (pointMap.get(date) ?? 0) + Number(b.accountBalance ?? 0))
      }
    }

    // Fallback: single point from total
    if (pointMap.size === 0) {
      const cb = Number(reportData?.total?.currentBalance ?? 0)
      if (cb) pointMap.set(today, cb)
    }

    return Array.from(pointMap.entries())
      .map(([date, balance]) => ({ date, balance }))
      .sort((a, b) => a.date.localeCompare(b.date))
  }, [reportQuery.data, today])

  const currentBalance = useMemo(() => {
    if (historicalPoints.length > 0)
      return historicalPoints[historicalPoints.length - 1].balance
    return Number(reportQuery.data?.total?.currentBalance ?? 0)
  }, [historicalPoints, reportQuery.data])

  // ---------------------------------------------------------------------------
  // Account rows
  // ---------------------------------------------------------------------------

  const accountRows = useMemo<AccountRow[]>(() => {
    const assets: any[] = reportQuery.data?.assets ?? []
    return assets.map((a) => ({
      assetId: a.assetId,
      assetName: a.assetName ?? '',
      organizationName: a.organizationName ?? '',
      isLoan: !!a.isLoan,
      currentBalance: Number(a.currentBalance ?? 0),
      forecast30d: 0, // filled below after forecast
    }))
  }, [reportQuery.data])

  // ---------------------------------------------------------------------------
  // Pattern detection
  // ---------------------------------------------------------------------------

  const patterns = useMemo<RecurringPattern[]>(
    () => detectPatterns(ticketsQuery.data ?? []),
    [ticketsQuery.data]
  )

  // ---------------------------------------------------------------------------
  // 30-day forecast
  // ---------------------------------------------------------------------------

  const forecastDays = useMemo<ForecastDay[]>(
    () => buildForecast(patterns, currentBalance, addDays(today, 1), 30),
    [patterns, currentBalance, today]
  )

  const balance30d = forecastDays[forecastDays.length - 1]?.balance ?? currentBalance
  const totalForecastIn = forecastDays.reduce((s, d) => s + d.expectedIn, 0)
  const totalForecastOut = forecastDays.reduce((s, d) => s + d.expectedOut, 0)
  const riskDay = forecastDays.find((d) => d.balance < 0)

  // ---------------------------------------------------------------------------
  // Monthly revenue bars
  // ---------------------------------------------------------------------------

  const monthlyBars = useMemo<MonthlyRevBar[]>(
    () => buildMonthlyRevBars(ticketsQuery.data ?? [], today),
    [ticketsQuery.data, today]
  )

  // ---------------------------------------------------------------------------
  // Chart data — past actuals + 30-day forecast
  // ---------------------------------------------------------------------------

  const chartData = useMemo(() => {
    const past = historicalPoints.map((p) => ({
      label: p.date.slice(5),
      date: p.date,
      잔액: p.balance,
      예측잔액: undefined as number | undefined,
      isForecast: false,
    }))

    // Bridge: carry current balance into forecast line
    const hasTodayInPast = past.some((p) => p.date === today)
    const bridge = hasTodayInPast
      ? []
      : [{ label: today.slice(5), date: today, 잔액: currentBalance, 예측잔액: currentBalance, isForecast: false }]

    const forecastPts = forecastDays.map((d) => ({
      label: d.date.slice(5),
      date: d.date,
      잔액: undefined as number | undefined,
      예측잔액: d.balance,
      isForecast: true,
    }))

    const merged = past.map((p) =>
      p.date === today ? { ...p, 예측잔액: currentBalance } : p
    )
    return [...merged, ...bridge, ...forecastPts]
  }, [historicalPoints, forecastDays, currentBalance, today])

  // ---------------------------------------------------------------------------
  // Current month revenue estimate
  // ---------------------------------------------------------------------------

  const currentMonthRevEstimate = useMemo(() => {
    const bar = monthlyBars.find((b) => b.label === '이번달')
    return bar?.amount ?? 0
  }, [monthlyBars])

  // ---------------------------------------------------------------------------
  // Loading / error
  // ---------------------------------------------------------------------------

  const isLoading = reportQuery.isLoading || ticketsQuery.isLoading
  const hasError = reportQuery.isError || ticketsQuery.isError

  // ---------------------------------------------------------------------------
  // Period picker handler
  // ---------------------------------------------------------------------------

  function handlePeriodChange(p: PeriodPreset, f: string, t: string) {
    setPreset(p)
    setFrom(f)
    setTo(t)
  }

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
            최근 31일 거래 패턴 분석 → 향후 30일 잔액 예측
          </p>
        </div>

        <div className="flex items-center gap-1.5 flex-wrap">
          <PeriodPicker
            preset={preset}
            from={from}
            to={to}
            onChange={handlePeriodChange}
            groups={[
              { label: '월', presets: ['this_month', 'last_month'] },
              { label: '범위', presets: ['last_7d', 'last_30d'] },
            ]}
          />
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

      {/* 31-day clamp warning */}
      {clamped && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 flex items-center gap-2">
          <ExclamationTriangleIcon className="h-4 w-4 text-amber-600 shrink-0" />
          <span className="text-2xs text-amber-800">
            그랜터 API 31일 제한 — 종료일 기준 31일({effectiveStart} ~ {to})만 조회합니다.
          </span>
        </div>
      )}

      {/* Connection banners */}
      {healthQuery.isFetched && !isConfigured && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 flex items-center gap-2">
          <ExclamationTriangleIcon className="h-4 w-4 text-amber-600 shrink-0" />
          <span className="text-2xs text-amber-800">
            그랜터 API 키 미설정 — Railway 환경변수 GRANTER_API_KEY 등록이 필요합니다.
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
            <span className="text-2xs text-ink-500">
              반복 패턴{' '}
              <span className="font-semibold text-ink-700">{patterns.length}개</span> 감지
            </span>
          )}
        </div>
      )}

      {/* Risk warning */}
      {riskDay && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 flex items-center gap-2">
          <ExclamationTriangleIcon className="h-4 w-4 text-rose-600 shrink-0" />
          <div className="text-2xs text-rose-800">
            <span className="font-semibold">자금 부족 위험</span> —{' '}
            {formatDate(riskDay.date)}에 잔액{' '}
            <span className="font-mono font-semibold">{formatCurrency(riskDay.balance, false)}원</span>으로
            전환 예상. 사전 자금 조달 또는 지출 조정 검토 필요.
          </div>
        </div>
      )}

      {/* No-data state */}
      {!isLoading && !hasError && isConfigured && historicalPoints.length === 0 && (
        <div className="panel px-4 py-8 text-center space-y-3">
          <p className="text-2xs text-ink-500">선택 기간에 잔액 데이터가 없습니다.</p>
          <button
            className="btn-secondary text-2xs"
            onClick={() => {
              const p = periodForPreset('last_30d')
              setPreset('last_30d')
              setFrom(p.start)
              setTo(p.end)
            }}
          >
            최근 30일로 다시 조회
          </button>
        </div>
      )}

      {/* KPI row */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
        <KPI
          label="현재 잔액"
          value={currentBalance}
          tone="primary"
          highlight
          icon={<BanknotesIcon className="h-3 w-3" />}
        />
        <KPI
          label="30일 후 예상"
          value={balance30d}
          tone={balance30d < 0 ? 'danger' : balance30d < currentBalance ? 'warning' : 'success'}
          icon={<ChartBarIcon className="h-3 w-3" />}
        />
        <KPI
          label="예상 입금 합계"
          value={totalForecastIn}
          tone="success"
          icon={<ArrowDownLeftIcon className="h-3 w-3" />}
        />
        <KPI
          label="예상 출금 합계"
          value={totalForecastOut}
          tone="danger"
          icon={<ArrowUpRightIcon className="h-3 w-3" />}
        />
        {/* Risk KPI */}
        <div
          className={`panel px-3 py-2.5 ${
            riskDay ? 'border-rose-300 bg-rose-50' : 'border-emerald-200 bg-emerald-50'
          } border`}
        >
          <div className="text-2xs font-medium uppercase tracking-wider flex items-center gap-1 mb-0.5 text-ink-500">
            <ExclamationTriangleIcon className="h-3 w-3" />
            자금 부족 위험
          </div>
          {riskDay ? (
            <div className="font-semibold text-sm text-rose-700">{riskDay.date.slice(5)}</div>
          ) : (
            <div className="font-semibold text-sm text-emerald-700">안정</div>
          )}
        </div>
      </div>

      {/* Balance + Forecast chart */}
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
                  background:
                    'repeating-linear-gradient(90deg,#f59e0b 0,#f59e0b 4px,transparent 4px,transparent 8px)',
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
            데이터 로드 실패 — 다시 시도해 주세요.
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
                  stroke="#f43f5e"
                  strokeDasharray="4 2"
                  label={{ value: '위험', fill: '#be123c', fontSize: 9 }}
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

      {/* Revenue bar chart + account table */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {/* Monthly revenue estimate */}
        <div className="panel p-3">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-ink-800">매출액 월별 추정</h2>
            {currentMonthRevEstimate > 0 && (
              <span className="text-2xs text-ink-500">
                당월 예상{' '}
                <span className="font-semibold text-primary-700">
                  {formatCompactWon(currentMonthRevEstimate)}
                </span>
              </span>
            )}
          </div>
          {isLoading ? (
            <div className="h-36 flex items-center justify-center text-2xs text-ink-400">
              불러오는 중…
            </div>
          ) : monthlyBars.length === 0 ? (
            <div className="h-36 flex items-center justify-center text-2xs text-ink-400">
              BANK IN 데이터 없음
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={140}>
              <BarChart data={monthlyBars} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e4e4e7" vertical={false} />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 9, fill: '#a1a1aa' }}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  tick={{ fontSize: 9, fill: '#a1a1aa' }}
                  tickFormatter={(v) => formatCompactWon(v)}
                  tickLine={false}
                  axisLine={false}
                  width={48}
                />
                <Tooltip
                  formatter={(v: number, _: string, props: any) => [
                    `${formatCompactWon(v)}${props.payload?.isPartial ? ' (추정)' : ''}`,
                    '매출',
                  ]}
                  contentStyle={{ fontSize: 11 }}
                />
                <Bar dataKey="amount" fill="#15b0a8" radius={[3, 3, 0, 0]} name="매출" />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* Account status */}
        <div className="panel overflow-hidden">
          <div className="px-3 py-2 border-b border-ink-200">
            <h2 className="text-sm font-semibold text-ink-800">계좌별 현황</h2>
          </div>
          {isLoading ? (
            <div className="px-3 py-6 text-center text-2xs text-ink-400">불러오는 중…</div>
          ) : accountRows.length === 0 ? (
            <div className="px-3 py-6 text-center text-2xs text-ink-400">계좌 데이터 없음</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full">
                <thead className="bg-canvas-50">
                  <tr>
                    <th className="px-3 py-1.5 text-left text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                      계좌
                    </th>
                    <th className="px-3 py-1.5 text-right text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                      현재 잔액
                    </th>
                    <th className="px-3 py-1.5 text-center text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                      구분
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {accountRows.map((a) => (
                    <tr key={a.assetId} className="hover:bg-canvas-50">
                      <td className="px-3 py-1.5">
                        <div className="text-xs font-medium text-ink-800 truncate max-w-[140px]">
                          {a.assetName}
                        </div>
                        <div className="text-2xs text-ink-400 truncate max-w-[140px]">
                          {a.organizationName}
                        </div>
                      </td>
                      <td
                        className={`px-3 py-1.5 text-right font-mono tabular-nums text-xs font-semibold ${
                          a.isLoan ? 'text-rose-700' : 'text-ink-900'
                        }`}
                      >
                        {formatCurrency(a.currentBalance, false)}
                      </td>
                      <td className="px-3 py-1.5 text-center">
                        {a.isLoan ? (
                          <span className="badge bg-rose-50 text-rose-700 border-rose-200">
                            대출
                          </span>
                        ) : (
                          <span className="badge bg-emerald-50 text-emerald-700 border-emerald-200">
                            일반
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Recurring patterns */}
      <div className="panel overflow-hidden">
        <div className="px-3 py-2 border-b border-ink-200 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink-800">감지된 반복 패턴</h2>
          <span className="text-2xs text-ink-400">{patterns.length}개</span>
        </div>

        {!isLoading && patterns.length === 0 ? (
          <div className="px-3 py-6 text-center text-2xs text-ink-400">
            반복 패턴 없음 — 동일 거래처 ±10% 금액, 7~31일 주기, 3회 이상 조건 미충족
          </div>
        ) : (
          <div className="overflow-x-auto max-h-64 overflow-y-auto">
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
                {isLoading ? (
                  <tr>
                    <td colSpan={6} className="py-6 text-center text-2xs text-ink-400">
                      불러오는 중…
                    </td>
                  </tr>
                ) : (
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
                    ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* 30-day daily forecast detail */}
      <div className="panel overflow-hidden">
        <div className="px-3 py-2 border-b border-ink-200 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink-800">30일 일별 예측 상세</h2>
          <span className="text-2xs text-ink-500">예상 입금 - 출금 = 잔액 변화</span>
        </div>
        <div className="overflow-x-auto max-h-72 overflow-y-auto">
          <table className="min-w-full">
            <thead className="bg-canvas-50 sticky top-0 z-10">
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
                  순변동
                </th>
                <th className="px-3 py-1.5 text-right text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                  예상 잔액
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {forecastDays.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-6 text-center text-2xs text-ink-400">
                    예측 데이터 없음
                  </td>
                </tr>
              ) : (
                forecastDays.map((d) => {
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
                        {d.expectedIn > 0
                          ? `+${formatCurrency(d.expectedIn, false)}`
                          : <span className="text-ink-200">-</span>}
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono tabular-nums text-2xs text-rose-700">
                        {d.expectedOut > 0
                          ? `-${formatCurrency(d.expectedOut, false)}`
                          : <span className="text-ink-200">-</span>}
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
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Footer note */}
      <p className="text-2xs text-ink-400 pb-2">
        예측은 동일 거래처 ±10% 금액·7~31일 주기·3회 이상 반복 패턴 기반이며 실제와 다를 수 있습니다.
        3회 이상 → 70% · 5회 이상 → 90% 신뢰도. 신규 거래·일회성 이벤트·계절성은 미반영.
      </p>
    </div>
  )
}
