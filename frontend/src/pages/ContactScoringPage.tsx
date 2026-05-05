import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import {
  ArrowPathIcon,
  MagnifyingGlassIcon,
  ExclamationTriangleIcon,
  CheckCircleIcon,
  ClockIcon,
  StarIcon,
  BuildingStorefrontIcon,
  TruckIcon,
  ArrowsRightLeftIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline'
import { buildOwnAccountSet, filterOutInternalTransfers, isSelfContact } from '@/utils/internalTransfer'
import {
  PieChart,
  Pie,
  Cell,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  LineChart,
  Line,
  CartesianGrid,
  Legend,
} from 'recharts'
import { granterApi } from '@/services/api'
import { formatCurrency, formatCompactWon, isoLocal, flattenTickets } from '@/utils/format'
import PeriodPicker, { type PeriodPreset } from '@/components/common/PeriodPicker'
import { usePeriodStore } from '@/store/periodStore'

// ─────────────────────────────────────────────
// 유틸
// ─────────────────────────────────────────────
function daysBetween(a: string, b: string): number {
  return Math.max(1, Math.floor((new Date(b).getTime() - new Date(a).getTime()) / 86400000) + 1)
}
function str(obj: any, ...keys: string[]): string {
  for (const k of keys) {
    const v = obj?.[k]
    if (v !== undefined && v !== null && v !== '') return String(v)
  }
  return ''
}
function num(obj: any, ...keys: string[]): number {
  for (const k of keys) {
    const v = obj?.[k]
    if (v !== undefined && v !== null && v !== '') return Number(v) || 0
  }
  return 0
}

// ─────────────────────────────────────────────
// 타입
// ─────────────────────────────────────────────
type ContactType = 'sales' | 'purchase' | 'both'
type Grade = 'A+' | 'A' | 'B+' | 'B' | 'C' | 'D'
type SortKey = 'score' | 'totalAmount' | 'txCount' | 'outCount' | 'avgPayDays' | 'lastDate'

interface ScoreBreakdown {
  /** 결제 빈도 (0~25): OUT 거래 건수 기반 */
  payFreq: number
  /** 결제 정시성 (0~25): 평균 결제 일수, 낮을수록 높은 점수 */
  payPunct: number
  /** 거래 안정성 (0~25): CV(변동계수) 낮을수록 높은 점수 */
  stability: number
  /** 거래 누적 (0~25): 총 거래 금액 log scale */
  accumulation: number
}

interface ContactScore {
  name: string
  type: ContactType
  txCount: number
  totalAmount: number
  inAmount: number
  outAmount: number
  outCount: number    // OUT 결제 건수 (당사가 거래처에 이체한 횟수)
  lastDate: string
  avgPayDays: number  // 매입 세금계산서 발행 → 결제일 평균
  cv: number          // 변동계수
  score: number       // 0~100
  grade: Grade
  breakdown: ScoreBreakdown
}

/** 거래처별 일별 거래 데이터 (LineChart용) */
interface DailyTx {
  date: string
  in: number
  out: number
}

// ─────────────────────────────────────────────
// 거래처 추출 (SettlementPage 패턴)
// ─────────────────────────────────────────────
function extractContact(t: any): string {
  if (str(t, 'contact')) return str(t, 'contact')
  if (t?.taxInvoice) {
    const ti = t.taxInvoice
    if (str(t, 'transactionType') === 'IN') {
      return str(ti?.contractor, 'companyName') || str(ti?.supplier, 'companyName') || ''
    }
    return str(ti?.supplier, 'companyName') || str(ti?.contractor, 'companyName') || ''
  }
  if (t?.cashReceipt) {
    return str(t.cashReceipt?.issuer, 'companyName') || str(t.cashReceipt?.issuer, 'userName') || ''
  }
  if (t?.bankTransaction) {
    return str(t.bankTransaction, 'counterparty') || str(t.bankTransaction, 'content') || ''
  }
  if (t?.cardUsage) {
    return str(t.cardUsage, 'storeName') || ''
  }
  return str(t, 'counterpartyName', 'vendor', 'merchantName')
}

// ─────────────────────────────────────────────
// 스코어링 (신규 룰: OUT 결제 이력 + 거래 데이터)
// ─────────────────────────────────────────────
function scoreContacts(tickets: any[]): ContactScore[] {
  type Row = {
    inAmounts: number[]
    outAmounts: number[]
    inDates: string[]
    outDates: string[]
    allDates: string[]
    // 매입 세금계산서: 발행일 → OUT 결제일 간격 계산용
    taxIssueDates: string[]
  }
  const map: Record<string, Row> = {}
  const ensure = (name: string): Row => {
    if (!map[name]) {
      map[name] = { inAmounts: [], outAmounts: [], inDates: [], outDates: [], allDates: [], taxIssueDates: [] }
    }
    return map[name]
  }

  for (const t of tickets) {
    const name = extractContact(t)
    if (!name) continue
    // 본인 회사(조인앤조인) 제외 — extractContact가 이미 거래상대방 반환
    if (isSelfContact(name)) continue
    const row = ensure(name)
    const txType = str(t, 'transactionType')
    const amount = num(t, 'amount')
    const dateStr = str(t, 'transactAt', 'date').slice(0, 10)
    if (dateStr) row.allDates.push(dateStr)

    if (txType === 'IN') {
      row.inAmounts.push(amount)
      if (dateStr) row.inDates.push(dateStr)
      // 매입 세금계산서 발행일 수집 (issue_date 또는 taxInvoice.writtenDate)
      const issueDate =
        str(t?.taxInvoice, 'writtenDate', 'issueDate').slice(0, 10) ||
        str(t, 'issueDate').slice(0, 10)
      if (issueDate) row.taxIssueDates.push(issueDate)
    } else if (txType === 'OUT') {
      row.outAmounts.push(amount)
      if (dateStr) row.outDates.push(dateStr)
    }
  }

  // log 정규화 기준: 전체 중 최대 총 거래액
  const allTotals = Object.values(map).map(
    (r) => r.inAmounts.reduce((s, v) => s + v, 0) + r.outAmounts.reduce((s, v) => s + v, 0)
  )
  const maxTotal = Math.max(...allTotals, 1)

  const results: ContactScore[] = []

  for (const [name, row] of Object.entries(map)) {
    const txCount = row.inAmounts.length + row.outAmounts.length
    if (txCount === 0) continue

    const inAmount = row.inAmounts.reduce((s, v) => s + v, 0)
    const outAmount = row.outAmounts.reduce((s, v) => s + v, 0)
    const totalAmount = inAmount + outAmount
    const outCount = row.outAmounts.length

    const type: ContactType =
      inAmount > 0 && outAmount > 0 ? 'both' : outAmount >= inAmount ? 'purchase' : 'sales'

    const allDates = [...row.allDates].sort()
    const lastDate = allDates[allDates.length - 1] ?? ''

    // --- 1. 결제 빈도 (0~25): OUT 건수 기반, 월 5건 이상이면 만점 근접 ---
    const payFreq = Math.min(25, Math.round((outCount / 5) * 25))

    // --- 2. 결제 정시성 (0~25): 매입 세금계산서 발행일 vs 최초 OUT 날짜 간격 ---
    let avgPayDays = 0
    let payPunct = 12 // 데이터 없으면 중간값
    if (row.taxIssueDates.length > 0 && row.outDates.length > 0) {
      const sortedOut = [...row.outDates].sort()
      const gaps: number[] = []
      for (const issueDate of row.taxIssueDates) {
        const afterOut = sortedOut.find((d) => d >= issueDate)
        if (afterOut) {
          const gap = daysBetween(issueDate, afterOut)
          if (gap >= 0 && gap <= 180) gaps.push(gap)
        }
      }
      if (gaps.length > 0) {
        avgPayDays = Math.round(gaps.reduce((s, v) => s + v, 0) / gaps.length)
        payPunct =
          avgPayDays <= 3 ? 25 :
          avgPayDays <= 7 ? 22 :
          avgPayDays <= 15 ? 18 :
          avgPayDays <= 30 ? 13 :
          avgPayDays <= 60 ? 7 : 2
      }
    } else if (row.outDates.length >= 2) {
      const sortedOut = [...row.outDates].sort()
      const gaps: number[] = []
      for (let i = 1; i < sortedOut.length; i++) {
        const gap = daysBetween(sortedOut[i - 1], sortedOut[i])
        if (gap > 0 && gap <= 180) gaps.push(gap)
      }
      if (gaps.length > 0) {
        avgPayDays = Math.round(gaps.reduce((s, v) => s + v, 0) / gaps.length)
        payPunct =
          avgPayDays <= 7 ? 22 :
          avgPayDays <= 15 ? 18 :
          avgPayDays <= 30 ? 13 :
          avgPayDays <= 60 ? 7 : 2
      }
    }

    // --- 3. 거래 안정성 (0~25): 변동계수(CV = 표준편차/평균) 낮을수록 좋음 ---
    const allAmounts = [...row.inAmounts, ...row.outAmounts]
    let cv = 0
    let stability = 12 // 데이터 부족 시 중간값
    if (allAmounts.length >= 2) {
      const mean = allAmounts.reduce((s, v) => s + v, 0) / allAmounts.length
      if (mean > 0) {
        const variance = allAmounts.reduce((s, v) => s + (v - mean) ** 2, 0) / allAmounts.length
        cv = Math.sqrt(variance) / mean
        stability =
          cv <= 0.2 ? 25 :
          cv <= 0.5 ? 20 :
          cv <= 1.0 ? 14 :
          cv <= 2.0 ? 8 : 3
      }
    }

    // --- 4. 거래 누적 (0~25): 총 거래액 log scale 정규화 ---
    const accumulation =
      totalAmount > 0
        ? Math.min(25, Math.round((Math.log(totalAmount + 1) / Math.log(maxTotal + 1)) * 25))
        : 0

    const score = Math.min(100, payFreq + payPunct + stability + accumulation)

    const grade: Grade =
      score >= 90 ? 'A+' :
      score >= 80 ? 'A' :
      score >= 70 ? 'B+' :
      score >= 60 ? 'B' :
      score >= 50 ? 'C' : 'D'

    results.push({
      name,
      type,
      txCount,
      totalAmount,
      inAmount,
      outAmount,
      outCount,
      lastDate,
      avgPayDays,
      cv: Math.round(cv * 100) / 100,
      score,
      grade,
      breakdown: { payFreq, payPunct, stability, accumulation },
    })
  }

  return results.sort((a, b) => b.score - a.score)
}

/** 특정 거래처의 일별 IN/OUT 집계 (LineChart용) */
function buildDailyTx(tickets: any[], contactName: string): DailyTx[] {
  const dayMap: Record<string, { in: number; out: number }> = {}
  for (const t of tickets) {
    if (extractContact(t) !== contactName) continue
    const dateStr = str(t, 'transactAt', 'date').slice(0, 10)
    if (!dateStr) continue
    const txType = str(t, 'transactionType')
    const amount = num(t, 'amount')
    if (!dayMap[dateStr]) dayMap[dateStr] = { in: 0, out: 0 }
    if (txType === 'IN') dayMap[dateStr].in += amount
    else if (txType === 'OUT') dayMap[dateStr].out += amount
  }
  return Object.entries(dayMap)
    .map(([date, v]) => ({ date, in: v.in, out: v.out }))
    .sort((a, b) => a.date.localeCompare(b.date))
}

// ─────────────────────────────────────────────
// 등급별 색상
// ─────────────────────────────────────────────
const GRADE_CLS: Record<Grade, string> = {
  'A+': 'bg-emerald-50 text-emerald-700 border-emerald-200',
  A:   'bg-emerald-50 text-emerald-600 border-emerald-200',
  'B+':'bg-primary-50 text-primary-700 border-primary-200',
  B:   'bg-primary-50 text-primary-600 border-primary-200',
  C:   'bg-amber-50  text-amber-700  border-amber-200',
  D:   'bg-rose-50   text-rose-700   border-rose-200',
}
const GRADE_BG: Record<Grade, string> = {
  'A+': 'bg-emerald-500',
  A:   'bg-emerald-400',
  'B+':'bg-cyan-500',
  B:   'bg-cyan-400',
  C:   'bg-amber-400',
  D:   'bg-rose-500',
}
/** Recharts Cell용 hex 색상 */
const GRADE_HEX: Record<Grade, string> = {
  'A+': '#10b981',
  A:   '#34d399',
  'B+': '#06b6d4',
  B:   '#67e8f9',
  C:   '#f59e0b',
  D:   '#f43f5e',
}

// ─────────────────────────────────────────────
// 서브 컴포넌트
// ─────────────────────────────────────────────
function GradeBadge({ grade }: { grade: Grade }) {
  return <span className={`badge font-bold ${GRADE_CLS[grade]}`}>{grade}</span>
}

function TypeBadge({ type }: { type: ContactType }) {
  if (type === 'sales')
    return (
      <span className="badge bg-emerald-50 text-emerald-700 border-emerald-200 gap-0.5">
        <BuildingStorefrontIcon className="h-2.5 w-2.5" />매출처
      </span>
    )
  if (type === 'purchase')
    return (
      <span className="badge bg-amber-50 text-amber-700 border-amber-200 gap-0.5">
        <TruckIcon className="h-2.5 w-2.5" />매입처
      </span>
    )
  return (
    <span className="badge bg-ink-50 text-ink-600 border-ink-200 gap-0.5">
      <ArrowsRightLeftIcon className="h-2.5 w-2.5" />양방향
    </span>
  )
}

function KPI({
  label,
  value,
  unit = '곳',
  tone = 'neutral',
  sub,
}: {
  label: string
  value: number
  unit?: string
  tone?: 'neutral' | 'emerald' | 'primary' | 'amber' | 'rose'
  sub?: string
}) {
  const toneClass: Record<string, string> = {
    neutral: 'text-ink-900',
    emerald: 'text-emerald-700',
    primary: 'text-primary-700',
    amber:   'text-amber-700',
    rose:    'text-rose-700',
  }
  return (
    <div className="panel px-3 py-2">
      <div className="text-2xs font-medium text-ink-500 uppercase tracking-wider">{label}</div>
      <div className={`mt-0.5 font-mono tabular-nums font-bold text-sm ${toneClass[tone]}`}>
        {value.toLocaleString()}
        <span className="text-2xs text-ink-400 ml-1 font-medium">{unit}</span>
      </div>
      {sub && <div className="text-2xs text-ink-400 mt-0.5">{sub}</div>}
    </div>
  )
}

function ScoreBar({ score }: { score: number }) {
  const color =
    score >= 80 ? '#10b981' :
    score >= 60 ? '#06b6d4' :
    score >= 50 ? '#f59e0b' : '#f43f5e'
  return (
    <div className="flex items-center gap-1.5">
      <div className="flex-1 h-1.5 rounded-full bg-ink-100 overflow-hidden">
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${score}%`, backgroundColor: color }}
        />
      </div>
      <span className="text-2xs font-mono font-semibold w-6 text-right text-ink-700">{score}</span>
    </div>
  )
}

function ScoreBreakRow({
  label,
  value,
  max,
  hint,
}: {
  label: string
  value: number
  max: number
  hint: string
}) {
  const pct = Math.round((value / max) * 100)
  return (
    <div>
      <div className="flex justify-between items-center mb-0.5">
        <span className="text-2xs text-ink-600">{label}</span>
        <span className="text-2xs font-mono font-semibold text-ink-700">
          {value}/{max}
          <span className="text-ink-400 font-normal ml-1">({hint})</span>
        </span>
      </div>
      <div className="h-1 rounded-full bg-ink-100 overflow-hidden">
        <div className="h-full rounded-full bg-primary-500" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between items-center text-2xs">
      <span className="text-ink-500">{label}</span>
      <span className="font-mono text-ink-700 font-medium">{value}</span>
    </div>
  )
}

// ─────────────────────────────────────────────
// 커스텀 툴팁 (Recharts)
// ─────────────────────────────────────────────
function ChartTooltip({ active, payload, label, formatter }: any) {
  if (!active || !payload || !payload.length) return null
  return (
    <div className="rounded-md border border-ink-200 bg-white shadow-md px-2.5 py-2 text-2xs">
      {label && <div className="font-semibold text-ink-700 mb-1">{label}</div>}
      {payload.map((p: any, i: number) => (
        <div key={i} className="flex items-center gap-1.5">
          <span className="inline-block w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: p.color || p.fill }} />
          <span className="text-ink-600">{p.name}:</span>
          <span className="font-mono font-semibold text-ink-900">
            {formatter ? formatter(p.value, p.name) : p.value}
          </span>
        </div>
      ))}
    </div>
  )
}

// ─────────────────────────────────────────────
// 차트 섹션 컴포넌트
// ─────────────────────────────────────────────

/** A. 등급별 분포 도넛 차트 */
function GradeDistributionChart({ scores }: { scores: ContactScore[] }) {
  const GRADES: Grade[] = ['A+', 'A', 'B+', 'B', 'C', 'D']
  const data = GRADES.map((g) => ({
    name: g,
    value: scores.filter((s) => s.grade === g).length,
  })).filter((d) => d.value > 0)

  if (data.length === 0) return <EmptyChartPlaceholder />

  const total = data.reduce((s, d) => s + d.value, 0)

  return (
    <div className="panel px-3 py-2.5">
      <div className="text-2xs font-semibold text-ink-500 uppercase tracking-wider mb-2">
        등급별 분포
      </div>
      <div className="flex items-center gap-3">
        <ResponsiveContainer width={120} height={120}>
          <PieChart>
            <Pie
              data={data}
              cx="50%"
              cy="50%"
              innerRadius={32}
              outerRadius={54}
              paddingAngle={2}
              dataKey="value"
            >
              {data.map((entry, index) => (
                <Cell key={index} fill={GRADE_HEX[entry.name as Grade]} />
              ))}
            </Pie>
            <Tooltip
              content={
                <ChartTooltip
                  formatter={(v: number) => `${v}곳 (${Math.round((v / total) * 100)}%)`}
                />
              }
            />
          </PieChart>
        </ResponsiveContainer>
        <div className="flex-1 space-y-1">
          {data.map((d) => (
            <div key={d.name} className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5">
                <span
                  className="inline-block w-2 h-2 rounded-full flex-shrink-0"
                  style={{ backgroundColor: GRADE_HEX[d.name as Grade] }}
                />
                <span className="text-2xs font-bold text-ink-700">{d.name}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="w-16 h-1 rounded-full bg-ink-100 overflow-hidden">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${Math.round((d.value / total) * 100)}%`,
                      backgroundColor: GRADE_HEX[d.name as Grade],
                    }}
                  />
                </div>
                <span className="text-2xs font-mono text-ink-600 w-8 text-right">
                  {d.value}곳
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

/** B. 상위 거래처 매출 가로 막대 차트 */
function TopContactsBarChart({ scores }: { scores: ContactScore[] }) {
  const top10 = [...scores]
    .sort((a, b) => b.totalAmount - a.totalAmount)
    .slice(0, 10)
    .map((s) => ({
      name: s.name.length > 8 ? s.name.slice(0, 8) + '…' : s.name,
      fullName: s.name,
      매출IN: Math.round(s.inAmount / 10000),
      매입OUT: Math.round(s.outAmount / 10000),
      grade: s.grade,
      type: s.type,
    }))
    .reverse() // 가로 막대는 아래에서 위로 정렬

  if (top10.length === 0) return <EmptyChartPlaceholder />

  return (
    <div className="panel px-3 py-2.5">
      <div className="text-2xs font-semibold text-ink-500 uppercase tracking-wider mb-2">
        상위 거래처 거래액 (TOP 10, 만원)
      </div>
      <ResponsiveContainer width="100%" height={220}>
        <BarChart
          data={top10}
          layout="vertical"
          margin={{ top: 0, right: 8, left: 4, bottom: 0 }}
        >
          <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#e5e7eb" />
          <XAxis
            type="number"
            tick={{ fontSize: 9, fill: '#9ca3af' }}
            tickFormatter={(v) => `${v.toLocaleString()}만`}
          />
          <YAxis
            type="category"
            dataKey="name"
            tick={{ fontSize: 9, fill: '#374151' }}
            width={64}
          />
          <Tooltip
            content={
              <ChartTooltip
                formatter={(v: number, _name: string) =>
                  `${v.toLocaleString()}만원`
                }
              />
            }
          />
          <Legend
            iconSize={8}
            wrapperStyle={{ fontSize: 9, paddingTop: 4 }}
          />
          <Bar dataKey="매출IN" stackId="a" fill="#10b981" radius={[0, 0, 0, 0]} maxBarSize={14} />
          <Bar dataKey="매입OUT" stackId="a" fill="#f43f5e" radius={[0, 2, 2, 0]} maxBarSize={14} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

/** C. 점수 분포 히스토그램 */
function ScoreHistogram({ scores }: { scores: ContactScore[] }) {
  const bins = [
    { label: '0~50', min: 0,  max: 50,  fill: '#f43f5e' },
    { label: '50~60', min: 50, max: 60, fill: '#fb923c' },
    { label: '60~70', min: 60, max: 70, fill: '#f59e0b' },
    { label: '70~80', min: 70, max: 80, fill: '#06b6d4' },
    { label: '80~90', min: 80, max: 90, fill: '#34d399' },
    { label: '90~100', min: 90, max: 101, fill: '#10b981' },
  ]

  const data = bins.map((b) => ({
    label: b.label,
    count: scores.filter((s) => s.score >= b.min && s.score < b.max).length,
    fill: b.fill,
  }))

  if (scores.length === 0) return <EmptyChartPlaceholder />

  return (
    <div className="panel px-3 py-2.5">
      <div className="text-2xs font-semibold text-ink-500 uppercase tracking-wider mb-2">
        점수 구간별 분포
      </div>
      <ResponsiveContainer width="100%" height={130}>
        <BarChart data={data} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
          <XAxis dataKey="label" tick={{ fontSize: 9, fill: '#9ca3af' }} />
          <YAxis tick={{ fontSize: 9, fill: '#9ca3af' }} allowDecimals={false} />
          <Tooltip
            content={
              <ChartTooltip formatter={(v: number) => `${v}곳`} />
            }
          />
          <Bar dataKey="count" name="거래처 수" radius={[2, 2, 0, 0]} maxBarSize={40}>
            {data.map((entry, index) => (
              <Cell key={index} fill={entry.fill} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

function EmptyChartPlaceholder() {
  return (
    <div className="panel px-3 py-2.5 flex items-center justify-center h-32">
      <span className="text-2xs text-ink-400">데이터 없음</span>
    </div>
  )
}

// ─────────────────────────────────────────────
// 매출처 / 매입처 TOP 5 패널
// ─────────────────────────────────────────────
function TopContactsPanel({
  scores,
  mode,
}: {
  scores: ContactScore[]
  mode: 'sales' | 'purchase'
}) {
  const isSales = mode === 'sales'
  const list = scores
    .filter((s) => s.type === mode || s.type === 'both')
    .sort((a, b) => (isSales ? b.inAmount - a.inAmount : b.outAmount - a.outAmount))
    .slice(0, 5)

  return (
    <div className="panel px-3 py-2.5">
      <div className="flex items-center gap-1.5 mb-2">
        {isSales ? (
          <BuildingStorefrontIcon className="h-3 w-3 text-emerald-600" />
        ) : (
          <TruckIcon className="h-3 w-3 text-amber-600" />
        )}
        <span className="text-2xs font-semibold text-ink-600 uppercase tracking-wider">
          {isSales ? '매출처 TOP 5' : '매입처 TOP 5'}
        </span>
      </div>
      {list.length === 0 ? (
        <div className="text-2xs text-ink-400 text-center py-3">데이터 없음</div>
      ) : (
        <div className="space-y-1.5">
          {list.map((c, i) => (
            <div key={c.name} className="flex items-center gap-2">
              <span className="text-2xs text-ink-400 font-mono w-3">{i + 1}</span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-2xs font-medium text-ink-800 truncate">{c.name}</span>
                  <GradeBadge grade={c.grade} />
                </div>
                <div className="text-2xs text-ink-400 font-mono">
                  {isSales
                    ? `${c.txCount}건 · ${formatCompactWon(c.inAmount)}`
                    : `${c.outCount}건 · ${formatCompactWon(c.outAmount)}`}
                </div>
              </div>
              <div
                className={`text-2xs font-mono font-semibold ${
                  isSales ? 'text-emerald-700' : 'text-amber-700'
                }`}
              >
                {isSales ? formatCompactWon(c.inAmount) : formatCompactWon(c.outAmount)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────
// 상세 패널 (거래 추이 LineChart 포함)
// ─────────────────────────────────────────────
function ContactDetail({
  contact,
  tickets,
  onClose,
}: {
  contact: ContactScore
  tickets: any[]
  onClose: () => void
}) {
  const dailyTx = useMemo(
    () => buildDailyTx(tickets, contact.name),
    [tickets, contact.name]
  )

  const gradeDesc: Record<Grade, string> = {
    'A+': '최우량 거래처. 결제가 빠르고 거래 규모·빈도 모두 탁월합니다.',
    A:   '우량 거래처. 결제 주기 및 거래 패턴이 전반적으로 안정적입니다.',
    'B+':'양호한 거래처. 일부 지표에서 소폭 개선 여지가 있습니다.',
    B:   '보통 거래처. 거래 지속 여부를 모니터링하는 것을 권장합니다.',
    C:   '주의 거래처. 결제 지연 또는 거래 불규칙성이 확인됩니다.',
    D:   '관리 대상. 신용 한도 축소 또는 거래 조건 재검토를 권장합니다.',
  }
  const recommend: Record<Grade, string> = {
    'A+': '현행 거래 조건 유지. 우대 조건 제공 검토 가능.',
    A:   '현행 거래 조건 유지.',
    'B+':'거래 빈도 또는 결제 속도 개선 시 A등급 진입 가능.',
    B:   '결제 조건 재협의 및 정기 점검 권장.',
    C:   '결제 지연 빈번 시 신용 한도 재검토 필요.',
    D:   '선결제 또는 현금 거래 조건 적용 권장.',
  }

  /** LineChart용 만원 단위 변환 */
  const chartData = dailyTx.map((d) => ({
    date: d.date.slice(5), // MM-DD
    'IN(만원)': Math.round(d.in / 10000),
    'OUT(만원)': Math.round(d.out / 10000),
  }))

  return (
    <div className="panel overflow-hidden flex flex-col sticky top-4 max-h-[calc(100vh-8rem)]">
      {/* 헤더 */}
      <div className="px-3 py-2 border-b border-ink-200 flex items-center justify-between gap-2 flex-shrink-0">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={`inline-flex items-center justify-center w-7 h-7 rounded-full text-white text-xs font-bold flex-shrink-0 ${GRADE_BG[contact.grade]}`}>
              {contact.grade}
            </span>
            <h2 className="text-sm truncate">{contact.name}</h2>
          </div>
          <div className="flex items-center gap-1.5 mt-1">
            <TypeBadge type={contact.type} />
            <span className="text-2xs text-ink-500">신용점수 {contact.score}점</span>
          </div>
        </div>
        <button onClick={onClose} className="text-ink-400 hover:text-ink-700 flex-shrink-0 p-0.5">
          <XMarkIcon className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* 점수 분해 */}
        <div className="px-3 py-2 border-b border-ink-100">
          <div className="text-2xs font-semibold text-ink-500 uppercase tracking-wider mb-2">
            점수 분해
          </div>
          <div className="space-y-2">
            <ScoreBreakRow
              label="결제 빈도 (OUT 횟수)"
              value={contact.breakdown.payFreq}
              max={25}
              hint={`${contact.outCount}건`}
            />
            <ScoreBreakRow
              label="결제 정시성 (평균 결제일)"
              value={contact.breakdown.payPunct}
              max={25}
              hint={contact.avgPayDays > 0 ? `평균 ${contact.avgPayDays}일` : '데이터 없음'}
            />
            <ScoreBreakRow
              label="거래 안정성 (변동계수)"
              value={contact.breakdown.stability}
              max={25}
              hint={`CV ${contact.cv.toFixed(2)}`}
            />
            <ScoreBreakRow
              label="거래 누적 (총 거래액)"
              value={contact.breakdown.accumulation}
              max={25}
              hint={formatCompactWon(contact.totalAmount)}
            />
          </div>
        </div>

        {/* 거래 추이 LineChart */}
        {chartData.length > 0 && (
          <div className="px-3 py-2 border-b border-ink-100">
            <div className="text-2xs font-semibold text-ink-500 uppercase tracking-wider mb-2">
              거래 추이 (일별, 만원)
            </div>
            <ResponsiveContainer width="100%" height={110}>
              <LineChart
                data={chartData}
                margin={{ top: 4, right: 4, left: -20, bottom: 0 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 8, fill: '#9ca3af' }}
                  interval="preserveStartEnd"
                />
                <YAxis tick={{ fontSize: 8, fill: '#9ca3af' }} allowDecimals={false} />
                <Tooltip
                  content={
                    <ChartTooltip
                      formatter={(v: number, _name: string) => `${v.toLocaleString()}만원`}
                    />
                  }
                />
                <Legend iconSize={7} wrapperStyle={{ fontSize: 9 }} />
                <Line
                  type="monotone"
                  dataKey="IN(만원)"
                  stroke="#10b981"
                  strokeWidth={1.5}
                  dot={chartData.length <= 10 ? { r: 2, fill: '#10b981' } : false}
                  activeDot={{ r: 3 }}
                />
                <Line
                  type="monotone"
                  dataKey="OUT(만원)"
                  stroke="#f43f5e"
                  strokeWidth={1.5}
                  dot={chartData.length <= 10 ? { r: 2, fill: '#f43f5e' } : false}
                  activeDot={{ r: 3 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* 거래 내역 요약 */}
        <div className="px-3 py-2 border-b border-ink-100">
          <div className="text-2xs font-semibold text-ink-500 uppercase tracking-wider mb-2">
            거래 내역
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-md bg-canvas-50 border border-ink-100 px-2.5 py-2">
              <div className="text-2xs text-ink-500 mb-0.5">총 거래 건수</div>
              <div className="text-sm font-bold font-mono text-ink-900">{contact.txCount}건</div>
            </div>
            <div className="rounded-md bg-canvas-50 border border-ink-100 px-2.5 py-2">
              <div className="text-2xs text-ink-500 mb-0.5">총 거래 금액</div>
              <div className="text-sm font-bold font-mono text-ink-900">{formatCompactWon(contact.totalAmount)}</div>
            </div>
            {contact.inAmount > 0 && (
              <div className="rounded-md bg-emerald-50 border border-emerald-100 px-2.5 py-2">
                <div className="text-2xs text-emerald-600 mb-0.5">매출 (IN)</div>
                <div className="text-sm font-bold font-mono text-emerald-700">{formatCompactWon(contact.inAmount)}</div>
              </div>
            )}
            {contact.outAmount > 0 && (
              <div className="rounded-md bg-amber-50 border border-amber-100 px-2.5 py-2">
                <div className="text-2xs text-amber-600 mb-0.5">결제 OUT ({contact.outCount}건)</div>
                <div className="text-sm font-bold font-mono text-amber-700">{formatCompactWon(contact.outAmount)}</div>
              </div>
            )}
          </div>
          <div className="mt-2 space-y-1">
            <DetailRow label="마지막 거래일" value={contact.lastDate || '-'} />
            <DetailRow
              label="평균 결제 일수"
              value={contact.avgPayDays > 0 ? `${contact.avgPayDays}일` : '-'}
            />
            <DetailRow label="변동계수 (안정성)" value={contact.cv.toFixed(2)} />
            <DetailRow label="총 거래액 (정확)" value={formatCurrency(contact.totalAmount, false)} />
          </div>
        </div>

        {/* 권장 사항 */}
        <div className="px-3 py-2">
          <div className="text-2xs font-semibold text-ink-500 uppercase tracking-wider mb-2">
            평가 및 권장 사항
          </div>
          <div className="rounded-md border border-ink-100 bg-canvas-50 px-2.5 py-2 space-y-1.5">
            <p className="text-2xs text-ink-600 leading-relaxed">{gradeDesc[contact.grade]}</p>
            <p className="text-2xs text-primary-700 font-medium leading-relaxed">
              권장: {recommend[contact.grade]}
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────
// 메인 페이지
// ─────────────────────────────────────────────
export default function ContactScoringPage() {
  const preset = usePeriodStore((s) => s.preset)
  const from = usePeriodStore((s) => s.from)
  const to = usePeriodStore((s) => s.to)
  const setPeriod = usePeriodStore((s) => s.set)

  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState<'all' | ContactType>('all')
  const [gradeFilter, setGradeFilter] = useState<'all' | Grade>('all')
  const [sortKey, setSortKey] = useState<SortKey>('score')
  const [sortAsc, setSortAsc] = useState(false)
  const [selected, setSelected] = useState<ContactScore | null>(null)

  const ready = Boolean(from && to)
  const periodDays = ready ? daysBetween(from, to) : 1
  const exceeds31 = ready && periodDays > 31

  // 그랜터 헬스 체크
  const healthQuery = useQuery({
    queryKey: ['granter-health'],
    queryFn: () => granterApi.health().then((r) => r.data),
    retry: false,
  })
  const isConfigured = healthQuery.data?.configured

  // 단일 31일 호출 (필수 - chunked 절대 사용 안 함)
  const ticketsQuery = useQuery({
    queryKey: ['contact-scoring', from, to],
    queryFn: () => {
      let actualStart = from
      if (daysBetween(from, to) > 31) {
        const d = new Date(to)
        d.setDate(d.getDate() - 30)
        actualStart = isoLocal(d)
      }
      return granterApi.listTicketsAllTypes(actualStart, to).then((r) => {
        const tickets = flattenTickets(r.data)
        return { tickets, actualStart }
      })
    },
    enabled: ready && !!isConfigured,
    retry: false,
  })

  // 본인 계좌 세트 (법인 계좌 간 이체 필터용)
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

  const rawTickets: any[] = ticketsQuery.data?.tickets ?? []
  const tickets: any[] = useMemo(
    () => filterOutInternalTransfers(rawTickets, ownAccounts),
    [rawTickets, ownAccounts]
  )
  const filteredCount = rawTickets.length - tickets.length
  const actualStart: string = ticketsQuery.data?.actualStart ?? from

  // 최근 거래 자동 탐색 (24개월 거꾸로)
  const findRecentMut = useMutation({
    mutationFn: async () => {
      const today = new Date()
      for (let offset = 0; offset < 24; offset++) {
        const end = new Date(today)
        end.setDate(end.getDate() - offset * 31)
        const start = new Date(end)
        start.setDate(start.getDate() - 30)
        const startStr = isoLocal(start)
        const endStr = isoLocal(end)
        try {
          const res = await granterApi.listTicketsAllTypes(startStr, endStr)
          const items = flattenTickets(res.data)
          if (items.length > 0) return { start: startStr, end: endStr, count: items.length, offset }
        } catch {
          // 다음 구간 시도
        }
      }
      return { start: null, end: null, count: 0, offset: 0 }
    },
    onSuccess: (res) => {
      if (res.start && res.end) {
        setPeriod('custom', res.start, res.end)
        toast.success(`${res.offset === 0 ? '이번달' : `약 ${res.offset}개월 전`} · ${res.count}건 발견`)
      } else {
        toast.error('최근 24개월 내 거래 데이터가 없습니다.')
      }
    },
  })

  // 첫 조회 결과가 0건이면 자동 탐색 트리거
  const autoTriedRef = useRef(false)
  useEffect(() => {
    if (
      !autoTriedRef.current &&
      ticketsQuery.isSuccess &&
      ticketsQuery.data?.tickets?.length === 0 &&
      !findRecentMut.isPending
    ) {
      autoTriedRef.current = true
      findRecentMut.mutate()
    }
  }, [ticketsQuery.isSuccess, ticketsQuery.data, findRecentMut])

  // 스코어링 계산 (순수 함수, 메모이제이션)
  const scores = useMemo(() => scoreContacts(tickets), [tickets])

  // KPI
  const kpi = useMemo(() => {
    const salesCount    = scores.filter((s) => s.type === 'sales').length
    const purchaseCount = scores.filter((s) => s.type === 'purchase').length
    const aCount        = scores.filter((s) => s.grade === 'A+' || s.grade === 'A').length
    const dCount        = scores.filter((s) => s.grade === 'D').length
    const totalInAmount  = scores.reduce((s, c) => s + c.inAmount, 0)
    const totalOutAmount = scores.reduce((s, c) => s + c.outAmount, 0)
    return { total: scores.length, salesCount, purchaseCount, aCount, dCount, totalInAmount, totalOutAmount }
  }, [scores])

  // 필터 + 정렬
  const filtered = useMemo(() => {
    let arr = scores
    if (search) {
      const q = search.toLowerCase()
      arr = arr.filter((c) => c.name.toLowerCase().includes(q))
    }
    if (typeFilter !== 'all') arr = arr.filter((c) => c.type === typeFilter)
    if (gradeFilter !== 'all') arr = arr.filter((c) => c.grade === gradeFilter)
    return [...arr].sort((a, b) => {
      let va = 0, vb = 0
      if (sortKey === 'score')       { va = a.score;       vb = b.score }
      else if (sortKey === 'totalAmount') { va = a.totalAmount; vb = b.totalAmount }
      else if (sortKey === 'txCount')     { va = a.txCount;     vb = b.txCount }
      else if (sortKey === 'outCount')    { va = a.outCount;    vb = b.outCount }
      else if (sortKey === 'avgPayDays')  { va = a.avgPayDays;  vb = b.avgPayDays }
      else if (sortKey === 'lastDate')    { va = a.lastDate < b.lastDate ? -1 : 1; vb = 0 }
      return sortAsc ? va - vb : vb - va
    })
  }, [scores, search, typeFilter, gradeFilter, sortKey, sortAsc])

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortAsc((v) => !v)
    else { setSortKey(key); setSortAsc(false) }
  }
  const SortArrow = ({ k }: { k: SortKey }) =>
    sortKey === k ? <span className="ml-0.5 text-ink-400">{sortAsc ? '↑' : '↓'}</span> : null

  const handlePeriodChange = (p: PeriodPreset, f: string, t: string) => {
    setPeriod(p, f, t)
    setSelected(null)
  }

  const isLoading = healthQuery.isLoading || ticketsQuery.isFetching

  return (
    <div className="space-y-3">
      {/* 헤더 */}
      <div className="flex items-end justify-between flex-wrap gap-2">
        <div>
          <h1 className="flex items-center gap-2">
            <StarIcon className="h-4 w-4 text-ink-500" />
            거래처 신용도 평가
          </h1>
          <p className="text-2xs text-ink-500 mt-0.5">
            결제 이력(OUT) + 거래 데이터 기반 자동 스코어링
          </p>
          {filteredCount > 0 && (
            <span className="text-2xs text-ink-400">
              · 법인 계좌 간 이체 {filteredCount}건 제외됨
            </span>
          )}
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
            onClick={() => findRecentMut.mutate()}
            disabled={findRecentMut.isPending}
            className="btn-secondary"
          >
            <ClockIcon className="h-3 w-3 mr-1" />
            {findRecentMut.isPending ? '탐색 중...' : '최근 거래 한 달'}
          </button>
          <button
            onClick={() => ticketsQuery.refetch()}
            disabled={isLoading}
            className="btn-secondary"
          >
            <ArrowPathIcon className={`h-3 w-3 ${isLoading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* 상태 배너 */}
      {!isConfigured ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 flex items-center gap-2">
          <ExclamationTriangleIcon className="h-4 w-4 text-amber-600 flex-shrink-0" />
          <div className="text-2xs text-amber-800">
            그랜터 API 키가 설정되지 않았습니다. 설정 페이지에서 연결해 주세요.
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2 flex-wrap">
          <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-1 flex items-center gap-2">
            <CheckCircleIcon className="h-3.5 w-3.5 text-emerald-600" />
            <span className="text-2xs text-emerald-800">그랜터 연결됨</span>
          </div>
          {exceeds31 && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-1 text-2xs text-amber-800">
              31일 초과 선택 — 종료일 기준 최근 31일로 자동 조정
              {actualStart !== from && ` (실제 조회: ${actualStart} ~ ${to})`}
            </div>
          )}
          {ticketsQuery.isError && (
            <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-1 flex items-center gap-2 text-2xs text-rose-800">
              <ExclamationTriangleIcon className="h-3.5 w-3.5 text-rose-600" />
              데이터 조회 실패 — 새로고침 버튼을 눌러 재시도하세요.
            </div>
          )}
        </div>
      )}

      {/* KPI 5개 */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
        <KPI label="총 거래처" value={kpi.total} tone="neutral" />
        <KPI
          label="매출처"
          value={kpi.salesCount}
          tone="emerald"
          sub={kpi.total ? `${Math.round((kpi.salesCount / kpi.total) * 100)}%` : '-'}
        />
        <KPI
          label="매입처"
          value={kpi.purchaseCount}
          tone="amber"
          sub={kpi.total ? `${Math.round((kpi.purchaseCount / kpi.total) * 100)}%` : '-'}
        />
        <KPI
          label="A등급 이상"
          value={kpi.aCount}
          tone="primary"
          sub={kpi.total ? `${Math.round((kpi.aCount / kpi.total) * 100)}%` : '-'}
        />
        <KPI
          label="위험(D등급)"
          value={kpi.dCount}
          tone="rose"
          sub={kpi.total ? `${Math.round((kpi.dCount / kpi.total) * 100)}%` : '-'}
        />
      </div>

      {/* 시각화 섹션: 차트 3개 + TOP5 패널 2개 */}
      {scores.length > 0 && (
        <div className="grid grid-cols-12 gap-3">
          {/* 차트 A: 등급별 분포 도넛 */}
          <div className="col-span-12 md:col-span-4">
            <GradeDistributionChart scores={scores} />
          </div>
          {/* 차트 C: 점수 구간별 분포 */}
          <div className="col-span-12 md:col-span-4">
            <ScoreHistogram scores={scores} />
          </div>
          {/* 매출처/매입처 합산 미니 KPI */}
          <div className="col-span-12 md:col-span-4 flex flex-col gap-2">
            <div className="panel px-3 py-2.5 flex-1">
              <div className="text-2xs font-semibold text-ink-500 uppercase tracking-wider mb-1.5">
                기간 합계
              </div>
              <div className="space-y-1.5">
                <div className="flex justify-between items-center">
                  <span className="text-2xs text-ink-500">총 매출 (IN 합계)</span>
                  <span className="text-xs font-mono font-bold text-emerald-700">
                    {formatCompactWon(kpi.totalInAmount)}
                  </span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-2xs text-ink-500">총 매입 (OUT 합계)</span>
                  <span className="text-xs font-mono font-bold text-amber-700">
                    {formatCompactWon(kpi.totalOutAmount)}
                  </span>
                </div>
                <div className="h-px bg-ink-100" />
                <div className="flex justify-between items-center">
                  <span className="text-2xs text-ink-500">순차액 (IN-OUT)</span>
                  <span
                    className={`text-xs font-mono font-bold ${
                      kpi.totalInAmount - kpi.totalOutAmount >= 0
                        ? 'text-emerald-700'
                        : 'text-rose-700'
                    }`}
                  >
                    {formatCompactWon(kpi.totalInAmount - kpi.totalOutAmount)}
                  </span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-2xs text-ink-500">평균 신용점수</span>
                  <span className="text-xs font-mono font-bold text-primary-700">
                    {scores.length > 0
                      ? Math.round(scores.reduce((s, c) => s + c.score, 0) / scores.length)
                      : 0}점
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* 차트 B: 상위 거래처 가로 막대 (전체 너비) */}
          <div className="col-span-12">
            <TopContactsBarChart scores={scores} />
          </div>

          {/* 매출처 TOP5 / 매입처 TOP5 */}
          <div className="col-span-12 md:col-span-6">
            <TopContactsPanel scores={scores} mode="sales" />
          </div>
          <div className="col-span-12 md:col-span-6">
            <TopContactsPanel scores={scores} mode="purchase" />
          </div>
        </div>
      )}

      {/* 메인 콘텐츠: 테이블 + 상세 패널 */}
      <div className="grid grid-cols-12 gap-3">
        {/* 테이블 영역 */}
        <div className={selected ? 'col-span-7' : 'col-span-12'}>
          <div className="space-y-2">
            {/* 필터 바 */}
            <div className="panel p-2 flex flex-wrap items-center gap-2">
              {/* 구분 필터 */}
              <div className="flex items-center gap-0.5 p-0.5 rounded-md bg-canvas-50 border border-ink-200">
                {(['all', 'sales', 'purchase', 'both'] as const).map((f) => (
                  <button
                    key={f}
                    onClick={() => setTypeFilter(f)}
                    className={`px-2.5 py-1 rounded text-2xs font-semibold transition ${
                      typeFilter === f ? 'bg-ink-900 text-white' : 'text-ink-600 hover:bg-white'
                    }`}
                  >
                    {f === 'all' ? '전체' : f === 'sales' ? '매출처' : f === 'purchase' ? '매입처' : '양방향'}
                  </button>
                ))}
              </div>
              {/* 등급 필터 */}
              <div className="flex items-center gap-0.5 p-0.5 rounded-md bg-canvas-50 border border-ink-200">
                {(['all', 'A+', 'A', 'B+', 'B', 'C', 'D'] as const).map((g) => (
                  <button
                    key={g}
                    onClick={() => setGradeFilter(g)}
                    className={`px-2 py-1 rounded text-2xs font-bold transition ${
                      gradeFilter === g ? 'bg-ink-900 text-white' : 'text-ink-500 hover:bg-white'
                    }`}
                  >
                    {g === 'all' ? '전체' : g}
                  </button>
                ))}
              </div>
              <div className="relative ml-auto">
                <MagnifyingGlassIcon className="h-3 w-3 absolute left-2 top-1/2 -translate-y-1/2 text-ink-400" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="거래처 검색"
                  className="pl-7 input w-40 text-2xs"
                />
              </div>
            </div>

            {/* 테이블 */}
            <div className="panel overflow-hidden">
              <div className="overflow-x-auto max-h-[calc(100vh-26rem)] overflow-y-auto">
                <table className="min-w-full">
                  <thead className="bg-canvas-50 sticky top-0 z-10 border-b border-ink-200">
                    <tr>
                      <th className="px-3 py-1.5 text-left text-2xs font-semibold text-ink-500 uppercase tracking-wider w-6">#</th>
                      <th className="px-3 py-1.5 text-left text-2xs font-semibold text-ink-500 uppercase tracking-wider">등급</th>
                      <th className="px-3 py-1.5 text-left text-2xs font-semibold text-ink-500 uppercase tracking-wider">거래처명</th>
                      <th className="px-3 py-1.5 text-left text-2xs font-semibold text-ink-500 uppercase tracking-wider">구분</th>
                      <th
                        className="px-3 py-1.5 text-right text-2xs font-semibold text-ink-500 uppercase tracking-wider cursor-pointer hover:text-ink-700"
                        onClick={() => toggleSort('txCount')}
                      >
                        거래 건수<SortArrow k="txCount" />
                      </th>
                      <th
                        className="px-3 py-1.5 text-right text-2xs font-semibold text-ink-500 uppercase tracking-wider cursor-pointer hover:text-ink-700"
                        onClick={() => toggleSort('totalAmount')}
                      >
                        총 거래액<SortArrow k="totalAmount" />
                      </th>
                      <th
                        className="px-3 py-1.5 text-right text-2xs font-semibold text-ink-500 uppercase tracking-wider cursor-pointer hover:text-ink-700"
                        onClick={() => toggleSort('outCount')}
                      >
                        결제 횟수<SortArrow k="outCount" />
                      </th>
                      <th
                        className="px-3 py-1.5 text-right text-2xs font-semibold text-ink-500 uppercase tracking-wider cursor-pointer hover:text-ink-700"
                        onClick={() => toggleSort('avgPayDays')}
                      >
                        평균 결제일<SortArrow k="avgPayDays" />
                      </th>
                      <th
                        className="px-3 py-1.5 text-right text-2xs font-semibold text-ink-500 uppercase tracking-wider cursor-pointer hover:text-ink-700"
                        onClick={() => toggleSort('lastDate')}
                      >
                        마지막 거래<SortArrow k="lastDate" />
                      </th>
                      <th
                        className="px-3 py-1.5 text-left text-2xs font-semibold text-ink-500 uppercase tracking-wider cursor-pointer hover:text-ink-700 w-32"
                        onClick={() => toggleSort('score')}
                      >
                        점수<SortArrow k="score" />
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-100">
                    {isLoading && (
                      <tr>
                        <td colSpan={10} className="text-center py-8 text-2xs text-ink-400">
                          거래 데이터 분석 중...
                        </td>
                      </tr>
                    )}
                    {!isLoading && filtered.length === 0 && (
                      <tr>
                        <td colSpan={10} className="text-center py-8">
                          <div className="text-2xs text-ink-400">
                            {tickets.length === 0
                              ? '이 기간에 거래 데이터가 없습니다.'
                              : '조건에 맞는 거래처가 없습니다.'}
                          </div>
                          {tickets.length === 0 && !ticketsQuery.isError && (
                            <button
                              onClick={() => findRecentMut.mutate()}
                              disabled={findRecentMut.isPending}
                              className="mt-2 text-primary-700 hover:underline text-2xs font-semibold"
                            >
                              {findRecentMut.isPending ? '탐색 중...' : '최근 24개월에서 거래 자동 탐색'}
                            </button>
                          )}
                        </td>
                      </tr>
                    )}
                    {!isLoading && filtered.map((c) => {
                      const isSel = selected?.name === c.name
                      const rank = scores.findIndex((s) => s.name === c.name) + 1
                      return (
                        <tr
                          key={c.name}
                          onClick={() => setSelected(isSel ? null : c)}
                          className={`cursor-pointer transition-colors ${
                            isSel ? 'bg-primary-50' : 'hover:bg-canvas-50'
                          }`}
                        >
                          <td className="px-3 py-1.5 text-2xs text-ink-400 font-mono">{rank}</td>
                          <td className="px-3 py-1.5"><GradeBadge grade={c.grade} /></td>
                          <td className="px-3 py-1.5">
                            <div className="text-xs font-medium text-ink-900 leading-tight">{c.name}</div>
                          </td>
                          <td className="px-3 py-1.5"><TypeBadge type={c.type} /></td>
                          <td className="px-3 py-1.5 text-right font-mono tabular-nums text-2xs text-ink-700">
                            {c.txCount.toLocaleString()}건
                          </td>
                          <td className="px-3 py-1.5 text-right font-mono tabular-nums text-xs font-semibold text-ink-900">
                            {formatCompactWon(c.totalAmount)}
                          </td>
                          <td className="px-3 py-1.5 text-right font-mono tabular-nums text-2xs text-ink-700">
                            {c.outCount > 0 ? `${c.outCount}회` : '-'}
                          </td>
                          <td className="px-3 py-1.5 text-right text-2xs font-mono text-ink-600">
                            {c.avgPayDays > 0 ? `${c.avgPayDays}일` : '-'}
                          </td>
                          <td className="px-3 py-1.5 text-right text-2xs text-ink-500 font-mono">
                            {c.lastDate || '-'}
                          </td>
                          <td className="px-3 py-1.5 min-w-[7rem]">
                            <ScoreBar score={c.score} />
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              {filtered.length > 0 && (
                <div className="px-3 py-1.5 border-t border-ink-100 bg-canvas-50">
                  <span className="text-2xs text-ink-400">
                    {filtered.length}개 거래처 표시 (전체 {scores.length}개 / 원본 {tickets.length}건)
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* 상세 패널 */}
        {selected && (
          <div className="col-span-5">
            <ContactDetail
              contact={selected}
              tickets={tickets}
              onClose={() => setSelected(null)}
            />
          </div>
        )}
      </div>

      <div className="text-2xs text-ink-400 px-1">
        ※ 신용 점수 = 결제 빈도(25) + 결제 정시성(25) + 거래 안정성(25) + 거래 누적(25). 단기 데이터일수록 정확도가 낮을 수 있습니다.
      </div>
    </div>
  )
}
