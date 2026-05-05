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
import { buildOwnAccountSet, filterOutInternalTransfers } from '@/utils/internalTransfer'
import {
  ArrowPathIcon,
  ExclamationTriangleIcon,
  CheckCircleIcon,
  ArrowDownLeftIcon,
  ArrowUpRightIcon,
  ChartBarIcon,
  BanknotesIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  PlusCircleIcon,
  TrashIcon,
} from '@heroicons/react/24/outline'
import { granterApi } from '@/services/api'
import { formatCurrency, formatCompactWon, formatDate, isoLocal, flattenTickets } from '@/utils/format'
import PeriodPicker, { periodForPreset, type PeriodPreset } from '@/components/common/PeriodPicker'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Confidence = 'high' | 'medium' | 'low'

interface ContactPattern {
  contact: string
  direction: 'IN' | 'OUT'
  avgAmount: number
  txCount: number
  cycleDays: number          // 항상 추정 (1건이면 30일 가정)
  totalAmount: number
  lastDate: string
  preferredDayOfMonth: number | null
  shareRatio: number
  intervalCV: number | null  // 변동계수 (stdDev / mean), null이면 산출 불가
  confidence: Confidence     // 예측 정확도 (high/medium/low)
}

interface OneTimeCost {
  id: string
  date: string
  amount: string
  memo: string
}

interface ForecastDay {
  date: string
  expectedIn: number
  expectedOut: number
  balance: number
  isDanger: boolean
}

interface DailyBalancePoint {
  date: string
  balance: number
}

type ForecastPreset = 'next30' | 'next60' | 'next_month' | 'next_next_month' | 'next_quarter' | 'custom'

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

function isoToday(): string {
  return isoLocal(new Date())
}

function addDays(iso: string, n: number): string {
  const d = new Date(iso + 'T00:00:00')
  d.setDate(d.getDate() + n)
  return isoLocal(d)
}

function diffDays(a: string, b: string): number {
  return Math.round(
    (new Date(b + 'T00:00:00').getTime() - new Date(a + 'T00:00:00').getTime()) / 86400000
  )
}

function startOfNextMonth(from: string): string {
  const d = new Date(from + 'T00:00:00')
  d.setDate(1)
  d.setMonth(d.getMonth() + 1)
  return isoLocal(d)
}

function endOfMonth(iso: string): string {
  const d = new Date(iso + 'T00:00:00')
  d.setDate(1)
  d.setMonth(d.getMonth() + 1)
  d.setDate(0)
  return isoLocal(d)
}

// 주말 영업일 보정 — 방향에 따라 다른 관행:
// - IN(입금): 토/일이면 직전 금요일로 당김 (거래처가 미리 입금하는 관행)
// - OUT(출금): 토/일이면 다음 월요일로 미룸 (회사 자금 관리상 늦게 출금)
function shiftToWeekday(iso: string, direction: 'IN' | 'OUT' = 'OUT'): string {
  const d = new Date(iso + 'T00:00:00')
  const dow = d.getDay()
  if (direction === 'IN') {
    if (dow === 6) return addDays(iso, -1) // 토 → 금
    if (dow === 0) return addDays(iso, -2) // 일 → 금
  } else {
    if (dow === 6) return addDays(iso, 2)  // 토 → 월
    if (dow === 0) return addDays(iso, 1)  // 일 → 월
  }
  return iso
}

function forecastRangeForPreset(preset: ForecastPreset, today: string): { from: string; to: string } {
  switch (preset) {
    case 'next30':
      return { from: addDays(today, 1), to: addDays(today, 30) }
    case 'next60':
      return { from: addDays(today, 1), to: addDays(today, 60) }
    case 'next_month': {
      const nm = startOfNextMonth(today)
      return { from: nm, to: endOfMonth(nm) }
    }
    case 'next_next_month': {
      const nm = startOfNextMonth(today)
      const nnm = startOfNextMonth(nm)
      return { from: nnm, to: endOfMonth(nnm) }
    }
    case 'next_quarter': {
      return { from: addDays(today, 1), to: addDays(today, 90) }
    }
    default:
      return { from: addDays(today, 1), to: addDays(today, 30) }
  }
}

// ---------------------------------------------------------------------------
// Contact extraction
// ---------------------------------------------------------------------------

function extractContact(t: any): string {
  if (t?.taxInvoice) {
    const ti = t.taxInvoice
    if (t.transactionType === 'IN') {
      return ti?.contractor?.companyName || ti?.supplier?.companyName || '(미지정)'
    }
    return ti?.supplier?.companyName || ti?.contractor?.companyName || '(미지정)'
  }
  if (t?.cashReceipt) return t.cashReceipt?.issuer?.companyName || '(미지정)'
  return (
    t.contact ||
    t?.bankTransaction?.counterparty ||
    t?.cardUsage?.storeName ||
    t?.bankTransaction?.content ||
    '(미지정)'
  )
}

// ---------------------------------------------------------------------------
// Pattern analysis
// ---------------------------------------------------------------------------

function analyzeContactPatterns(tickets: any[]): { inPatterns: ContactPattern[]; outPatterns: ContactPattern[] } {
  type Group = { dates: string[]; amounts: number[] }
  const inMap = new Map<string, Group>()
  const outMap = new Map<string, Group>()

  for (const t of tickets) {
    const contact = extractContact(t)
    const amount = Math.abs(Number(t.amount ?? 0))
    if (amount <= 0) continue
    const date = (t.transactAt ?? t.createdAt ?? '').slice(0, 10)
    if (!date) continue
    const dir: 'IN' | 'OUT' = t.transactionType === 'IN' ? 'IN' : 'OUT'
    const map = dir === 'IN' ? inMap : outMap
    if (!map.has(contact)) map.set(contact, { dates: [], amounts: [] })
    const g = map.get(contact)!
    g.dates.push(date)
    g.amounts.push(amount)
  }

  function buildPatterns(map: Map<string, Group>, direction: 'IN' | 'OUT'): ContactPattern[] {
    const totalAll = Array.from(map.values()).reduce(
      (sum, g) => sum + g.amounts.reduce((s, a) => s + a, 0),
      0
    )
    const patterns: ContactPattern[] = []

    for (const [contact, g] of map.entries()) {
      const txCount = g.dates.length
      const totalAmount = g.amounts.reduce((s, a) => s + a, 0)
      const avgAmount = totalAmount / txCount

      const sorted = g.dates
        .map((d, i) => ({ date: d, amount: g.amounts[i] }))
        .sort((a, b) => a.date.localeCompare(b.date))

      const lastDate = sorted[sorted.length - 1].date

      // Cycle detection — 거래 ≥2건이면 항상 추정. 변동성은 CV로 별도 표기.
      let cycleDays = 30
      let intervalCV: number | null = null
      if (sorted.length >= 2) {
        const intervals: number[] = []
        for (let i = 1; i < sorted.length; i++) {
          intervals.push(diffDays(sorted[i - 1].date, sorted[i].date))
        }
        const meanInterval = intervals.reduce((s, v) => s + v, 0) / intervals.length
        if (meanInterval > 0) {
          // 1일 미만 또는 90일 초과 평균은 비정상 → 30일로 클램프
          cycleDays = Math.max(1, Math.min(60, Math.round(meanInterval)))
        }
        if (intervals.length >= 2 && meanInterval > 0) {
          const variance =
            intervals.reduce((s, v) => s + (v - meanInterval) ** 2, 0) / intervals.length
          intervalCV = Math.sqrt(variance) / meanInterval
        }
      }

      // Preferred day-of-month detection (≥2 same day)
      const dayCountMap = new Map<number, number>()
      for (const s of sorted) {
        const dom = Number(s.date.slice(8, 10))
        dayCountMap.set(dom, (dayCountMap.get(dom) ?? 0) + 1)
      }
      let preferredDayOfMonth: number | null = null
      let preferredDayMatchRatio = 0
      for (const [dom, cnt] of dayCountMap.entries()) {
        const ratio = cnt / sorted.length
        if (cnt >= 2 && ratio > preferredDayMatchRatio) {
          preferredDayOfMonth = dom
          preferredDayMatchRatio = ratio
        }
      }

      // Confidence: 매월 고정일자 일치율 ≥ 75% → high,
      // 변동계수(CV) < 0.15 → high, < 0.40 → medium, 그 외 low.
      let confidence: Confidence = 'low'
      if (preferredDayOfMonth !== null && preferredDayMatchRatio >= 0.75) {
        confidence = 'high'
      } else if (intervalCV !== null && intervalCV < 0.15) {
        confidence = 'high'
      } else if (intervalCV !== null && intervalCV < 0.4) {
        confidence = 'medium'
      } else if (sorted.length >= 3) {
        confidence = 'medium'
      }

      const shareRatio = totalAll > 0 ? totalAmount / totalAll : 0

      patterns.push({
        contact,
        direction,
        avgAmount,
        txCount,
        cycleDays,
        totalAmount,
        lastDate,
        preferredDayOfMonth,
        shareRatio,
        intervalCV,
        confidence,
      })
    }

    return patterns.sort((a, b) => b.totalAmount - a.totalAmount).slice(0, 30)
  }

  return {
    inPatterns: buildPatterns(inMap, 'IN'),
    outPatterns: buildPatterns(outMap, 'OUT'),
  }
}

// ---------------------------------------------------------------------------
// Next occurrence calculation
// ---------------------------------------------------------------------------

// 모든 거래처에 대해 최소 1회 예상일을 반환. 주말은 월요일로 이동.
function nextOccurrences(p: ContactPattern, forecastFrom: string, forecastTo: string): string[] {
  const raw: string[] = []

  if (p.preferredDayOfMonth !== null) {
    // 매월 고정일자
    const cursor = new Date(forecastFrom + 'T00:00:00')
    cursor.setDate(1)
    for (let i = 0; i < 24; i++) {
      const candidate = isoLocal(
        new Date(cursor.getFullYear(), cursor.getMonth(), p.preferredDayOfMonth)
      )
      if (candidate >= forecastFrom && candidate <= forecastTo) {
        raw.push(candidate)
      }
      cursor.setMonth(cursor.getMonth() + 1)
      if (isoLocal(cursor) > forecastTo) break
    }
  }

  if (raw.length === 0) {
    // 평균 주기 반복 (cycleDays는 항상 ≥1)
    const cyc = Math.max(1, p.cycleDays)
    let next = addDays(p.lastDate, cyc)
    let safety = 0
    while (next < forecastFrom && safety++ < 200) next = addDays(next, cyc)
    while (next <= forecastTo && safety++ < 200) {
      raw.push(next)
      next = addDays(next, cyc)
    }
  }

  // Fallback — 어떤 추정으로도 forecast 윈도우 안에 안 들어오면,
  // forecast 시작일에 한 번 배치 (절대 "예측 불가"로 두지 않음).
  if (raw.length === 0) {
    raw.push(forecastFrom)
  }

  // 주말 보정 (IN: 직전 금요일로 당김 / OUT: 다음 월요일로 미룸), 중복 제거
  const seen = new Set<string>()
  const result: string[] = []
  for (const d of raw) {
    const shifted = shiftToWeekday(d, p.direction)
    if (shifted < forecastFrom || shifted > forecastTo) continue
    if (seen.has(shifted)) continue
    seen.add(shifted)
    result.push(shifted)
  }
  // 주말 이동 후 모두 사라졌으면 forecastFrom 시점에 한 번 배치
  if (result.length === 0) result.push(shiftToWeekday(forecastFrom, p.direction))
  return result
}

function firstNextOccurrence(p: ContactPattern, forecastFrom: string, forecastTo: string): string {
  return nextOccurrences(p, forecastFrom, forecastTo)[0]
}

// ---------------------------------------------------------------------------
// Forecast builder
// ---------------------------------------------------------------------------

interface ForecastInput {
  inPatterns: ContactPattern[]
  outPatterns: ContactPattern[]
  overrideInAmounts: Record<string, number>   // contact -> amount
  overrideOutAmounts: Record<string, number>
  oneTimeCosts: OneTimeCost[]
  expectedRevenue: number | null              // null = auto
  startBalance: number
  forecastFrom: string
  forecastTo: string
}

function buildForecast(input: ForecastInput): ForecastDay[] {
  const {
    inPatterns,
    outPatterns,
    overrideInAmounts,
    overrideOutAmounts,
    oneTimeCosts,
    expectedRevenue,
    startBalance,
    forecastFrom,
    forecastTo,
  } = input

  const totalHistoricalIn = inPatterns.reduce((s, p) => s + p.totalAmount, 0)

  // Map: date -> { in: number; out: number }
  const eventMap = new Map<string, { totalIn: number; totalOut: number }>()

  function addEvent(date: string, dir: 'IN' | 'OUT', amount: number) {
    if (date < forecastFrom || date > forecastTo) return
    if (!eventMap.has(date)) eventMap.set(date, { totalIn: 0, totalOut: 0 })
    const ev = eventMap.get(date)!
    if (dir === 'IN') ev.totalIn += amount
    else ev.totalOut += amount
  }

  // IN patterns — 모든 거래처가 합계/일별에 반영됨 (예상일 무조건 추정)
  for (const p of inPatterns) {
    const baseAmount =
      overrideInAmounts[p.contact] !== undefined
        ? overrideInAmounts[p.contact]
        : expectedRevenue !== null
        ? expectedRevenue * p.shareRatio
        : p.avgAmount
    if (baseAmount <= 0) continue

    const dates = nextOccurrences(p, forecastFrom, forecastTo)
    // 다회 반복일 경우 1회당 amount = avgAmount (총 횟수만큼 발생)
    // 단 expectedRevenue 모드일 땐 분배된 양을 1회만 반영
    const perOccurrence =
      overrideInAmounts[p.contact] !== undefined || expectedRevenue !== null
        ? baseAmount / Math.max(1, dates.length)
        : baseAmount
    for (const d of dates) {
      addEvent(d, 'IN', perOccurrence)
    }
  }

  // OUT patterns — 동일하게 모두 반영
  for (const p of outPatterns) {
    const baseAmount =
      overrideOutAmounts[p.contact] !== undefined
        ? overrideOutAmounts[p.contact]
        : p.avgAmount
    if (baseAmount <= 0) continue

    const dates = nextOccurrences(p, forecastFrom, forecastTo)
    const perOccurrence =
      overrideOutAmounts[p.contact] !== undefined
        ? baseAmount / Math.max(1, dates.length)
        : baseAmount
    for (const d of dates) {
      addEvent(d, 'OUT', perOccurrence)
    }
  }

  // One-time costs
  for (const cost of oneTimeCosts) {
    const amt = parseFloat(cost.amount.replace(/,/g, ''))
    if (isNaN(amt) || amt <= 0) continue
    addEvent(cost.date, 'OUT', amt)
  }

  // If expectedRevenue provided but no patterns matched, distribute evenly
  if (expectedRevenue !== null && totalHistoricalIn === 0) {
    const span = diffDays(forecastFrom, forecastTo) + 1
    const perDay = expectedRevenue / span
    for (let i = 0; i < span; i++) {
      const d = addDays(forecastFrom, i)
      addEvent(d, 'IN', perDay)
    }
  }

  // Build day series
  const span = diffDays(forecastFrom, forecastTo) + 1
  const result: ForecastDay[] = []
  let running = startBalance

  for (let i = 0; i < span; i++) {
    const date = addDays(forecastFrom, i)
    const ev = eventMap.get(date) ?? { totalIn: 0, totalOut: 0 }
    running += ev.totalIn - ev.totalOut
    result.push({
      date,
      expectedIn: ev.totalIn,
      expectedOut: ev.totalOut,
      balance: running,
      isDanger: running < 0,
    })
  }

  return result
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

// -- UserInputPanel --

interface UserInputPanelProps {
  expectedRevenue: string
  onExpectedRevenueChange: (v: string) => void
  overrideInAmounts: Record<string, number>
  onOverrideIn: (contact: string, amount: number) => void
  overrideOutAmounts: Record<string, number>
  onOverrideOut: (contact: string, amount: number) => void
  oneTimeCosts: OneTimeCost[]
  onAddCost: () => void
  onRemoveCost: (id: string) => void
  onUpdateCost: (id: string, field: keyof OneTimeCost, value: string) => void
  inPatterns: ContactPattern[]
  outPatterns: ContactPattern[]
  forecastFrom: string
  forecastTo: string
}

function UserInputPanel({
  expectedRevenue,
  onExpectedRevenueChange,
  overrideInAmounts,
  onOverrideIn,
  overrideOutAmounts,
  onOverrideOut,
  oneTimeCosts,
  onAddCost,
  onRemoveCost,
  onUpdateCost,
  inPatterns,
  outPatterns,
  forecastFrom,
  forecastTo,
}: UserInputPanelProps) {
  const [open, setOpen] = useState(false)

  return (
    <div className="panel overflow-hidden">
      <button
        className="w-full flex items-center justify-between px-3 py-2 text-left hover:bg-canvas-50 transition"
        onClick={() => setOpen((p) => !p)}
      >
        <span className="text-sm font-semibold text-ink-800">예측 조건 입력 (선택)</span>
        {open ? (
          <ChevronUpIcon className="h-4 w-4 text-ink-400" />
        ) : (
          <ChevronDownIcon className="h-4 w-4 text-ink-400" />
        )}
      </button>

      {open && (
        <div className="px-3 pb-3 space-y-4 border-t border-ink-100 pt-3">
          {/* Expected Revenue */}
          <div>
            <label className="label">예측 기간 예상 매출 합계 (비워두면 과거 평균 기반 자동 추정)</label>
            <input
              type="text"
              className="input w-full max-w-xs mt-1"
              placeholder="예: 50000000"
              value={expectedRevenue}
              onChange={(e) => onExpectedRevenueChange(e.target.value)}
            />
            <p className="text-2xs text-ink-400 mt-0.5">
              입력 시 거래처별 과거 비율로 자동 분배됩니다.
            </p>
          </div>

          {/* IN contact overrides */}
          {inPatterns.length > 0 && (
            <div>
              <div className="text-xs font-semibold text-ink-700 mb-1.5">거래처별 예상 입금 조정 (선택)</div>
              <div className="overflow-x-auto">
                <table className="min-w-full text-2xs">
                  <thead>
                    <tr className="border-b border-ink-100">
                      <th className="text-left py-1 pr-3 font-medium text-ink-500">거래처</th>
                      <th className="text-right py-1 pr-3 font-medium text-ink-500">과거 평균</th>
                      <th className="text-right py-1 font-medium text-ink-500">예상 금액</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-50">
                    {inPatterns.slice(0, 15).map((p) => (
                      <tr key={p.contact}>
                        <td className="py-1 pr-3 text-ink-700 max-w-[140px] truncate">{p.contact}</td>
                        <td className="py-1 pr-3 text-right font-mono text-ink-500">
                          {formatCompactWon(p.avgAmount)}
                        </td>
                        <td className="py-1 text-right">
                          <input
                            type="number"
                            className="input text-right w-28 text-2xs py-0.5"
                            placeholder="자동"
                            value={overrideInAmounts[p.contact] ?? ''}
                            onChange={(e) => onOverrideIn(p.contact, Number(e.target.value))}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* OUT contact overrides */}
          {outPatterns.length > 0 && (
            <div>
              <div className="text-xs font-semibold text-ink-700 mb-1.5">거래처별 예상 출금 조정 (선택)</div>
              <div className="overflow-x-auto">
                <table className="min-w-full text-2xs">
                  <thead>
                    <tr className="border-b border-ink-100">
                      <th className="text-left py-1 pr-3 font-medium text-ink-500">거래처</th>
                      <th className="text-right py-1 pr-3 font-medium text-ink-500">과거 평균</th>
                      <th className="text-right py-1 font-medium text-ink-500">예상 금액</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-50">
                    {outPatterns.slice(0, 15).map((p) => (
                      <tr key={p.contact}>
                        <td className="py-1 pr-3 text-ink-700 max-w-[140px] truncate">{p.contact}</td>
                        <td className="py-1 pr-3 text-right font-mono text-ink-500">
                          {formatCompactWon(p.avgAmount)}
                        </td>
                        <td className="py-1 text-right">
                          <input
                            type="number"
                            className="input text-right w-28 text-2xs py-0.5"
                            placeholder="자동"
                            value={overrideOutAmounts[p.contact] ?? ''}
                            onChange={(e) => onOverrideOut(p.contact, Number(e.target.value))}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* One-time costs */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <div className="text-xs font-semibold text-ink-700">일회성 비용 추가</div>
              <button className="btn-secondary text-2xs" onClick={onAddCost}>
                <PlusCircleIcon className="h-3 w-3" />
                추가
              </button>
            </div>
            {oneTimeCosts.length === 0 ? (
              <p className="text-2xs text-ink-400">등록된 일회성 비용이 없습니다.</p>
            ) : (
              <div className="space-y-1.5">
                {oneTimeCosts.map((c) => (
                  <div key={c.id} className="flex items-center gap-2 flex-wrap">
                    <input
                      type="date"
                      className="input text-2xs w-32 py-0.5"
                      value={c.date}
                      min={forecastFrom}
                      max={forecastTo}
                      onChange={(e) => onUpdateCost(c.id, 'date', e.target.value)}
                    />
                    <input
                      type="text"
                      className="input text-2xs w-32 py-0.5"
                      placeholder="금액"
                      value={c.amount}
                      onChange={(e) => onUpdateCost(c.id, 'amount', e.target.value)}
                    />
                    <input
                      type="text"
                      className="input text-2xs flex-1 min-w-[120px] py-0.5"
                      placeholder="메모"
                      value={c.memo}
                      onChange={(e) => onUpdateCost(c.id, 'memo', e.target.value)}
                    />
                    <button
                      className="text-rose-500 hover:text-rose-700"
                      onClick={() => onRemoveCost(c.id)}
                    >
                      <TrashIcon className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// -- ContactPatternTable --

interface ContactPatternTableProps {
  patterns: ContactPattern[]
  direction: 'IN' | 'OUT'
  forecastFrom: string
  forecastTo: string
}

function ContactPatternTable({ patterns, direction, forecastFrom, forecastTo }: ContactPatternTableProps) {
  const label = direction === 'IN' ? '입금' : '출금'
  const badgeCls =
    direction === 'IN'
      ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
      : 'bg-rose-50 text-rose-700 border-rose-200'

  if (patterns.length === 0) {
    return (
      <div className="px-3 py-5 text-center text-2xs text-ink-400">
        분석 기간 내 {label} 거래처 없음
      </div>
    )
  }

  return (
    <div className="overflow-x-auto max-h-60 overflow-y-auto">
      <table className="min-w-full">
        <thead className="bg-canvas-50 sticky top-0 z-10">
          <tr>
            <th className="px-3 py-1.5 text-left text-2xs font-semibold text-ink-500 uppercase tracking-wider">
              거래처
            </th>
            <th className="px-3 py-1.5 text-right text-2xs font-semibold text-ink-500 uppercase tracking-wider">
              과거 평균
            </th>
            <th className="px-3 py-1.5 text-right text-2xs font-semibold text-ink-500 uppercase tracking-wider">
              건수
            </th>
            <th className="px-3 py-1.5 text-right text-2xs font-semibold text-ink-500 uppercase tracking-wider">
              주기
            </th>
            <th className="px-3 py-1.5 text-right text-2xs font-semibold text-ink-500 uppercase tracking-wider">
              다음 예상일
            </th>
            <th className="px-3 py-1.5 text-center text-2xs font-semibold text-ink-500 uppercase tracking-wider">
              정확도
            </th>
            <th className="px-3 py-1.5 text-right text-2xs font-semibold text-ink-500 uppercase tracking-wider">
              비율
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-ink-100">
          {patterns.map((p) => {
            const nextDate = firstNextOccurrence(p, forecastFrom, forecastTo)
            return (
              <tr key={p.contact} className="hover:bg-canvas-50">
                <td className="px-3 py-1.5 text-xs text-ink-800 max-w-[140px] truncate">
                  {p.contact}
                </td>
                <td className="px-3 py-1.5 text-right font-mono tabular-nums text-xs text-ink-800">
                  {formatCurrency(p.avgAmount, false)}
                </td>
                <td className="px-3 py-1.5 text-right text-2xs text-ink-600">{p.txCount}회</td>
                <td className="px-3 py-1.5 text-right text-2xs text-ink-600">
                  {p.preferredDayOfMonth !== null
                    ? `매월 ${p.preferredDayOfMonth}일`
                    : `~${p.cycleDays}일`}
                </td>
                <td className="px-3 py-1.5 text-right text-2xs">
                  <span className={`badge ${badgeCls}`}>{nextDate}</span>
                </td>
                <td className="px-3 py-1.5 text-center text-2xs">
                  <ConfidenceBadge confidence={p.confidence} />
                </td>
                <td className="px-3 py-1.5 text-right text-2xs text-ink-500">
                  {(p.shareRatio * 100).toFixed(1)}%
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function ConfidenceBadge({ confidence }: { confidence: Confidence }) {
  if (confidence === 'high') {
    return <span className="badge bg-emerald-50 text-emerald-700 border-emerald-200">높음</span>
  }
  if (confidence === 'medium') {
    return <span className="badge bg-amber-50 text-amber-700 border-amber-200">중간</span>
  }
  return <span className="badge bg-ink-50 text-ink-500 border-ink-200">낮음</span>
}

// -- CashflowChart --

interface ChartPoint {
  label: string
  date: string
  actual: number | undefined
  forecast: number | undefined
  isForecast: boolean
}

function ChartTooltipContent({ active, payload, label }: any) {
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

interface CashflowChartProps {
  historicalPoints: DailyBalancePoint[]
  forecastDays: ForecastDay[]
  currentBalance: number
  today: string
  riskDay: ForecastDay | undefined
  isLoading: boolean
  hasError: boolean
}

function CashflowChart({
  historicalPoints,
  forecastDays,
  currentBalance,
  today,
  riskDay,
  isLoading,
  hasError,
}: CashflowChartProps) {
  const chartData = useMemo<ChartPoint[]>(() => {
    const past: ChartPoint[] = historicalPoints.map((p) => ({
      label: p.date.slice(5),
      date: p.date,
      actual: p.balance,
      forecast: p.date === today ? currentBalance : undefined,
      isForecast: false,
    }))

    // If today not in past, add bridge point
    if (!historicalPoints.some((p) => p.date === today)) {
      past.push({
        label: today.slice(5),
        date: today,
        actual: currentBalance,
        forecast: currentBalance,
        isForecast: false,
      })
    }

    const futurePts: ChartPoint[] = forecastDays.map((d) => ({
      label: d.date.slice(5),
      date: d.date,
      actual: undefined,
      forecast: d.balance,
      isForecast: true,
    }))

    return [...past, ...futurePts]
  }, [historicalPoints, forecastDays, currentBalance, today])

  const tickInterval = Math.max(1, Math.floor(chartData.length / 10))

  return (
    <div className="panel p-3">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-ink-800">잔액 추이 + 예측</h2>
        <div className="flex items-center gap-3 text-2xs text-ink-500">
          <span className="flex items-center gap-1">
            <span className="inline-block w-4 h-0.5 bg-primary-700 rounded" />
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
          데이터 로드 실패
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={240}>
          <LineChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e4e4e7" />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 9, fill: '#a1a1aa' }}
              interval={tickInterval}
              tickLine={false}
              axisLine={false}
            />
            <YAxis
              tick={{ fontSize: 9, fill: '#a1a1aa' }}
              tickFormatter={(v) => formatCompactWon(v)}
              tickLine={false}
              axisLine={false}
              width={56}
            />
            <Tooltip content={<ChartTooltipContent />} />
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
              dataKey="actual"
              stroke="#0d8e88"
              strokeWidth={1.5}
              dot={false}
              connectNulls={false}
              name="실제 잔액"
            />
            <Line
              type="monotone"
              dataKey="forecast"
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
  )
}

// -- DailyDetailTable --

interface DailyDetailTableProps {
  forecastDays: ForecastDay[]
}

function DailyDetailTable({ forecastDays }: DailyDetailTableProps) {
  return (
    <div className="panel overflow-hidden">
      <div className="px-3 py-2 border-b border-ink-200 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-ink-800">일별 예측 상세</h2>
        <span className="text-2xs text-ink-400">{forecastDays.length}일</span>
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
                return (
                  <tr
                    key={d.date}
                    className={`hover:bg-canvas-50 ${d.isDanger ? 'bg-rose-50/60' : ''}`}
                  >
                    <td
                      className={`px-3 py-1.5 font-mono text-2xs whitespace-nowrap ${
                        d.isDanger ? 'text-rose-700 font-semibold' : 'text-ink-600'
                      }`}
                    >
                      {d.date}
                      {d.isDanger && (
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
                        d.isDanger ? 'text-rose-700' : 'text-ink-900'
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
  )
}

// -- KPI card --

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
// Forecast preset labels
// ---------------------------------------------------------------------------

const FORECAST_PRESET_LABELS: Record<ForecastPreset, string> = {
  next30: '다음 30일',
  next60: '다음 60일',
  next_month: '다음달',
  next_next_month: '다다음달',
  next_quarter: '다음분기(90일)',
  custom: '사용자 지정',
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function CashflowForecastPage() {
  const today = isoToday()

  // -- Lookback (분석 기간) --
  const defaultLookback = periodForPreset('last_30d')
  const [lookbackPreset, setLookbackPreset] = useState<PeriodPreset>('last_30d')
  const [lookbackFrom, setLookbackFrom] = useState(defaultLookback.start)
  const [lookbackTo, setLookbackTo] = useState(defaultLookback.end)

  // Clamp to ≤31 days
  const lookbackSpan = diffDays(lookbackFrom, lookbackTo) + 1
  const effectiveLookbackFrom =
    lookbackSpan > 31 ? addDays(lookbackTo, -30) : lookbackFrom

  // -- Forecast period --
  const [forecastPreset, setForecastPreset] = useState<ForecastPreset>('next30')
  const defaultForecastRange = forecastRangeForPreset('next30', today)
  const [forecastFrom, setForecastFrom] = useState(defaultForecastRange.from)
  const [forecastTo, setForecastTo] = useState(defaultForecastRange.to)

  function applyForecastPreset(p: ForecastPreset) {
    setForecastPreset(p)
    if (p !== 'custom') {
      const r = forecastRangeForPreset(p, today)
      setForecastFrom(r.from)
      setForecastTo(r.to)
    }
  }

  // -- User inputs (local state only, no query refetch) --
  const [expectedRevenue, setExpectedRevenue] = useState('')
  const [overrideInAmounts, setOverrideInAmounts] = useState<Record<string, number>>({})
  const [overrideOutAmounts, setOverrideOutAmounts] = useState<Record<string, number>>({})
  const [oneTimeCosts, setOneTimeCosts] = useState<OneTimeCost[]>([])

  function handleOverrideIn(contact: string, amount: number) {
    setOverrideInAmounts((prev) => ({ ...prev, [contact]: amount }))
  }
  function handleOverrideOut(contact: string, amount: number) {
    setOverrideOutAmounts((prev) => ({ ...prev, [contact]: amount }))
  }
  function addCost() {
    setOneTimeCosts((prev) => [
      ...prev,
      { id: crypto.randomUUID(), date: forecastFrom, amount: '', memo: '' },
    ])
  }
  function removeCost(id: string) {
    setOneTimeCosts((prev) => prev.filter((c) => c.id !== id))
  }
  function updateCost(id: string, field: keyof OneTimeCost, value: string) {
    setOneTimeCosts((prev) => prev.map((c) => (c.id === id ? { ...c, [field]: value } : c)))
  }

  // ---------------------------------------------------------------------------
  // Data queries (단일 호출, NO chunking)
  // ---------------------------------------------------------------------------

  const healthQuery = useQuery({
    queryKey: ['granter-health'],
    queryFn: () => granterApi.health().then((r) => r.data),
    retry: false,
    staleTime: 60_000,
  })
  const isConfigured = healthQuery.data?.configured

  const reportQuery = useQuery({
    queryKey: ['cashflow-balance', effectiveLookbackFrom, lookbackTo],
    queryFn: () =>
      granterApi
        .getDailyReport({ startDate: effectiveLookbackFrom, endDate: lookbackTo })
        .then((r) => r.data),
    enabled: !!isConfigured,
    retry: 1,
    staleTime: 120_000,
  })

  const assetsQuery = useQuery({
    queryKey: ['granter-all-assets'],
    queryFn: () => granterApi.listAllAssets(true).then((r) => r.data),
    enabled: !!isConfigured,
    staleTime: 5 * 60_000,
  })
  const ownAccounts = useMemo(
    () => buildOwnAccountSet(assetsQuery.data),
    [assetsQuery.data]
  )

  const ticketsQuery = useQuery({
    queryKey: ['cashflow-tickets', effectiveLookbackFrom, lookbackTo],
    queryFn: () =>
      granterApi
        .listTicketsAllTypes(effectiveLookbackFrom, lookbackTo)
        .then((r) => flattenTickets(r.data)),
    enabled: !!isConfigured,
    retry: 1,
    staleTime: 120_000,
  })

  // ---------------------------------------------------------------------------
  // Historical balance series
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
  // Contact pattern analysis (법인 계좌 간 이체 제외 후 분석)
  // ---------------------------------------------------------------------------

  const rawTicketsData = ticketsQuery.data ?? []
  const filteredTicketsData = useMemo(
    () => filterOutInternalTransfers(rawTicketsData, ownAccounts),
    [rawTicketsData, ownAccounts]
  )
  const filteredCount = rawTicketsData.length - filteredTicketsData.length

  const { inPatterns, outPatterns } = useMemo(
    () => analyzeContactPatterns(filteredTicketsData),
    [filteredTicketsData]
  )

  // ---------------------------------------------------------------------------
  // Forecast
  // ---------------------------------------------------------------------------

  const parsedExpectedRevenue = useMemo(() => {
    const raw = expectedRevenue.replace(/,/g, '').trim()
    if (!raw) return null
    const v = parseFloat(raw)
    return isNaN(v) ? null : v
  }, [expectedRevenue])

  const forecastDays = useMemo<ForecastDay[]>(
    () =>
      buildForecast({
        inPatterns,
        outPatterns,
        overrideInAmounts,
        overrideOutAmounts,
        oneTimeCosts,
        expectedRevenue: parsedExpectedRevenue,
        startBalance: currentBalance,
        forecastFrom,
        forecastTo,
      }),
    [
      inPatterns,
      outPatterns,
      overrideInAmounts,
      overrideOutAmounts,
      oneTimeCosts,
      parsedExpectedRevenue,
      currentBalance,
      forecastFrom,
      forecastTo,
    ]
  )

  const forecastEndBalance = forecastDays[forecastDays.length - 1]?.balance ?? currentBalance
  const totalForecastIn = useMemo(() => forecastDays.reduce((s, d) => s + d.expectedIn, 0), [forecastDays])
  const totalForecastOut = useMemo(() => forecastDays.reduce((s, d) => s + d.expectedOut, 0), [forecastDays])
  const riskDay = useMemo(() => forecastDays.find((d) => d.isDanger), [forecastDays])

  // ---------------------------------------------------------------------------
  // Loading / error
  // ---------------------------------------------------------------------------

  const isLoading = reportQuery.isLoading || ticketsQuery.isLoading
  const hasError = reportQuery.isError || ticketsQuery.isError

  // ---------------------------------------------------------------------------
  // Period picker handlers
  // ---------------------------------------------------------------------------

  function handleLookbackChange(p: PeriodPreset, f: string, t: string) {
    setLookbackPreset(p)
    setLookbackFrom(f)
    setLookbackTo(t)
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
            과거 패턴 분석 기반 미래 자금 예측 도구
          </p>
          {filteredCount > 0 && (
            <span className="text-2xs text-ink-400">
              · 법인 계좌 간 이체 {filteredCount}건 제외됨
            </span>
          )}
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
          새로고침
        </button>
      </div>

      {/* Period controls */}
      <div className="panel p-3 space-y-3">
        {/* Lookback */}
        <div>
          <div className="text-2xs font-semibold text-ink-600 mb-1.5 uppercase tracking-wider">
            분석 기준 기간 (과거 데이터)
          </div>
          <PeriodPicker
            preset={lookbackPreset}
            from={lookbackFrom}
            to={lookbackTo}
            onChange={handleLookbackChange}
            groups={[
              { label: '월', presets: ['this_month', 'last_month'] },
              { label: '범위', presets: ['last_7d', 'last_30d'] },
            ]}
          />
          {lookbackSpan > 31 && (
            <p className="text-2xs text-amber-700 mt-1">
              그랜터 API 31일 한도 — 종료일 기준 31일({effectiveLookbackFrom} ~ {lookbackTo})만 조회됩니다.
            </p>
          )}
        </div>

        {/* Forecast preset */}
        <div>
          <div className="text-2xs font-semibold text-ink-600 mb-1.5 uppercase tracking-wider">
            예측 기간
          </div>
          <div className="flex items-center gap-1 flex-wrap">
            <div className="flex items-center gap-0.5 p-0.5 rounded-md bg-white border border-ink-200">
              {(['next30', 'next60', 'next_month', 'next_next_month', 'next_quarter', 'custom'] as ForecastPreset[]).map(
                (p) => (
                  <button
                    key={p}
                    onClick={() => applyForecastPreset(p)}
                    className={`px-2 py-1 rounded text-2xs font-semibold transition ${
                      forecastPreset === p ? 'bg-ink-900 text-white' : 'text-ink-600 hover:bg-ink-50'
                    }`}
                  >
                    {FORECAST_PRESET_LABELS[p]}
                  </button>
                )
              )}
            </div>
            {forecastPreset === 'custom' && (
              <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-white border border-ink-200">
                <input
                  type="date"
                  className="bg-transparent text-2xs text-ink-700 w-28 focus:outline-none"
                  value={forecastFrom}
                  onChange={(e) => setForecastFrom(e.target.value)}
                />
                <span className="text-ink-300">→</span>
                <input
                  type="date"
                  className="bg-transparent text-2xs text-ink-700 w-28 focus:outline-none"
                  value={forecastTo}
                  onChange={(e) => setForecastTo(e.target.value)}
                />
              </div>
            )}
          </div>
          <p className="text-2xs text-ink-400 mt-1">
            {forecastFrom} ~ {forecastTo} ({diffDays(forecastFrom, forecastTo) + 1}일)
          </p>
        </div>
      </div>

      {/* Banners */}
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
          {inPatterns.length + outPatterns.length > 0 && (
            <span className="text-2xs text-ink-500">
              입금 거래처{' '}
              <span className="font-semibold text-ink-700">{inPatterns.length}곳</span> ·
              출금 거래처{' '}
              <span className="font-semibold text-ink-700">{outPatterns.length}곳</span> 분석 완료
            </span>
          )}
        </div>
      )}

      {ticketsQuery.isError && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 flex items-center gap-2">
          <ExclamationTriangleIcon className="h-4 w-4 text-rose-600 shrink-0" />
          <span className="text-2xs text-rose-800">거래 데이터 로드 실패</span>
          <button
            className="btn-secondary text-2xs ml-auto"
            onClick={() => ticketsQuery.refetch()}
          >
            재시도
          </button>
        </div>
      )}

      {riskDay && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 flex items-center gap-2">
          <ExclamationTriangleIcon className="h-4 w-4 text-rose-600 shrink-0" />
          <div className="text-2xs text-rose-800">
            <span className="font-semibold">자금 부족 위험</span> —{' '}
            {formatDate(riskDay.date)}에 잔액{' '}
            <span className="font-mono font-semibold">{formatCurrency(riskDay.balance, false)}원</span>으로
            전환 예상. 사전 자금 조달 또는 지출 조정이 필요합니다.
          </div>
        </div>
      )}

      {/* No data */}
      {!isLoading && !hasError && isConfigured && historicalPoints.length === 0 && (
        <div className="panel px-4 py-8 text-center space-y-3">
          <p className="text-2xs text-ink-500">선택 기간에 잔액 데이터가 없습니다.</p>
          <button
            className="btn-secondary text-2xs"
            onClick={() => {
              const p = periodForPreset('last_30d')
              setLookbackPreset('last_30d')
              setLookbackFrom(p.start)
              setLookbackTo(p.end)
            }}
          >
            최근 30일로 다시 조회
          </button>
        </div>
      )}

      {/* KPI row */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
        <KPI
          label="현재 총 잔액"
          value={currentBalance}
          tone="primary"
          highlight
          icon={<BanknotesIcon className="h-3 w-3" />}
        />
        <KPI
          label="예측 종료일 잔액"
          value={forecastEndBalance}
          tone={
            forecastEndBalance < 0
              ? 'danger'
              : forecastEndBalance < currentBalance
              ? 'warning'
              : 'success'
          }
          sub={
            <span className="text-2xs text-ink-400">{forecastTo}</span>
          }
          icon={<ChartBarIcon className="h-3 w-3" />}
        />
        <KPI
          label="예측 입금 합계"
          value={totalForecastIn}
          tone="success"
          icon={<ArrowDownLeftIcon className="h-3 w-3" />}
        />
        <KPI
          label="예측 출금 합계"
          value={totalForecastOut}
          tone="danger"
          icon={<ArrowUpRightIcon className="h-3 w-3" />}
        />
        {/* Risk KPI */}
        <div
          className={`panel px-3 py-2.5 border ${
            riskDay
              ? 'border-rose-300 bg-rose-50'
              : 'border-emerald-200 bg-emerald-50'
          }`}
        >
          <div className="text-2xs font-medium uppercase tracking-wider flex items-center gap-1 mb-0.5 text-ink-500">
            <ExclamationTriangleIcon className="h-3 w-3" />
            자금 부족 위험
          </div>
          {riskDay ? (
            <div className="font-semibold text-sm text-rose-700">{riskDay.date}</div>
          ) : (
            <div className="font-semibold text-sm text-emerald-700">안정</div>
          )}
        </div>
      </div>

      {/* User input panel */}
      <UserInputPanel
        expectedRevenue={expectedRevenue}
        onExpectedRevenueChange={setExpectedRevenue}
        overrideInAmounts={overrideInAmounts}
        onOverrideIn={handleOverrideIn}
        overrideOutAmounts={overrideOutAmounts}
        onOverrideOut={handleOverrideOut}
        oneTimeCosts={oneTimeCosts}
        onAddCost={addCost}
        onRemoveCost={removeCost}
        onUpdateCost={updateCost}
        inPatterns={inPatterns}
        outPatterns={outPatterns}
        forecastFrom={forecastFrom}
        forecastTo={forecastTo}
      />

      {/* Main chart */}
      <CashflowChart
        historicalPoints={historicalPoints}
        forecastDays={forecastDays}
        currentBalance={currentBalance}
        today={today}
        riskDay={riskDay}
        isLoading={isLoading}
        hasError={hasError}
      />

      {/* Contact pattern tables */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <div className="panel overflow-hidden">
          <div className="px-3 py-2 border-b border-ink-200 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-ink-800">입금 거래처 패턴</h2>
            <span className="text-2xs text-ink-400">{inPatterns.length}곳</span>
          </div>
          <ContactPatternTable
            patterns={inPatterns}
            direction="IN"
            forecastFrom={forecastFrom}
            forecastTo={forecastTo}
          />
        </div>
        <div className="panel overflow-hidden">
          <div className="px-3 py-2 border-b border-ink-200 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-ink-800">출금 거래처 패턴</h2>
            <span className="text-2xs text-ink-400">{outPatterns.length}곳</span>
          </div>
          <ContactPatternTable
            patterns={outPatterns}
            direction="OUT"
            forecastFrom={forecastFrom}
            forecastTo={forecastTo}
          />
        </div>
      </div>

      {/* Daily detail */}
      <DailyDetailTable forecastDays={forecastDays} />

      {/* Footer */}
      <p className="text-2xs text-ink-400 pb-2">
        예상일은 과거 거래처별 반복 패턴(매월 동일 일자 또는 평균 주기)으로 무조건 추정되며,
        주말 보정: 입금 거래처는 직전 영업일(금요일)로 당기고, 출금은 다음 영업일(월요일)로 미룹니다. 일정 변동성은 정확도(높음/중간/낮음) 배지로 표기됩니다.
        모든 거래처가 합계·일별 예측에 반영됩니다. 사용자 예상 매출 입력 시 과거 거래처별 비율로 자동 분배.
      </p>
    </div>
  )
}
