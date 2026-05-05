import { useMemo, useState } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import {
  CalendarDaysIcon,
  ArrowPathIcon,
  MagnifyingGlassIcon,
  ExclamationTriangleIcon,
  CheckCircleIcon,
  ClockIcon,
  StarIcon,
  BuildingStorefrontIcon,
  TruckIcon,
  ArrowsRightLeftIcon,
} from '@heroicons/react/24/outline'
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Cell,
} from 'recharts'
import { granterApi } from '@/services/api'
import { formatCurrency, formatCompactWon } from '@/utils/format'

// ─────────────────────────────────────────────
// 헬퍼 유틸
// ─────────────────────────────────────────────
function todayISO() {
  return new Date().toISOString().slice(0, 10)
}
function thisMonthStartISO() {
  const d = new Date()
  d.setDate(1)
  return d.toISOString().slice(0, 10)
}
function daysBetween(a: string, b: string) {
  return Math.max(
    1,
    Math.floor((new Date(b).getTime() - new Date(a).getTime()) / 86400000) + 1
  )
}
function num(obj: any, ...keys: string[]): number {
  for (const k of keys) {
    const v = obj?.[k]
    if (v !== undefined && v !== null && v !== '') return Number(v) || 0
  }
  return 0
}
function str(obj: any, ...keys: string[]): string {
  for (const k of keys) {
    const v = obj?.[k]
    if (v !== undefined && v !== null && v !== '') return String(v)
  }
  return ''
}

// ─────────────────────────────────────────────
// 타입
// ─────────────────────────────────────────────
type ContactType = 'sales' | 'purchase' | 'both'
type Grade = 'A+' | 'A' | 'B+' | 'B' | 'C' | 'D'

interface ContactScore {
  name: string
  type: ContactType
  txCount: number
  totalAmount: number
  inAmount: number
  outAmount: number
  lastDate: string
  avgPayDays: number   // 결제까지 평균 일수 (낮을수록 좋음)
  consistency: number  // 변동계수 (낮을수록 일관)
  score: number        // 0~100
  grade: Grade
  dates: string[]      // 거래일 목록 (차트용)
}

type SortKey = 'score' | 'totalAmount' | 'txCount' | 'lastDate' | 'avgPayDays'

// ─────────────────────────────────────────────
// 거래처 추출 (SettlementPage 패턴 기반)
// ─────────────────────────────────────────────
function extractContact(t: any): string {
  // 우선순위 1: ticket.contact
  if (str(t, 'contact')) return str(t, 'contact')
  // 세금계산서
  if (t?.taxInvoice) {
    const ti = t.taxInvoice
    if (str(t, 'transactionType') === 'IN') {
      return str(ti?.contractor, 'companyName') || str(ti?.supplier, 'companyName') || '(미지정)'
    }
    return str(ti?.supplier, 'companyName') || str(ti?.contractor, 'companyName') || '(미지정)'
  }
  // 현금영수증
  if (t?.cashReceipt) {
    return (
      str(t.cashReceipt?.issuer, 'companyName') ||
      str(t.cashReceipt?.issuer, 'userName') ||
      '(미지정)'
    )
  }
  // 통장
  if (t?.bankTransaction) {
    return str(t.bankTransaction, 'counterparty') || str(t.bankTransaction, 'content') || '(미지정)'
  }
  // 카드
  if (t?.cardUsage) {
    return str(t.cardUsage, 'storeName') || '(미지정)'
  }
  return str(t, 'counterpartyName', 'vendor', 'merchantName') || '(미지정)'
}

// ─────────────────────────────────────────────
// 스코어링 로직
// ─────────────────────────────────────────────
function scoreContacts(tickets: any[], periodDays: number): ContactScore[] {
  // 거래처별 집계 맵
  const map: Record<
    string,
    {
      inAmounts: number[]
      outAmounts: number[]
      inDates: string[]
      outDates: string[]
      allDates: string[]
      payGaps: number[] // 세금계산서 발행일과 입금일 사이 일수
    }
  > = {}

  const ensure = (name: string) => {
    if (!map[name]) {
      map[name] = {
        inAmounts: [],
        outAmounts: [],
        inDates: [],
        outDates: [],
        allDates: [],
        payGaps: [],
      }
    }
    return map[name]
  }

  for (const t of tickets) {
    const name = extractContact(t)
    if (!name || name === '(미지정)') continue
    const row = ensure(name)
    const txType = str(t, 'transactionType') // 'IN' | 'OUT'
    const amount = num(t, 'amount')
    const dateStr = str(t, 'transactAt', 'date').slice(0, 10)
    if (dateStr) row.allDates.push(dateStr)
    if (txType === 'IN') {
      row.inAmounts.push(amount)
      if (dateStr) row.inDates.push(dateStr)
    } else if (txType === 'OUT') {
      row.outAmounts.push(amount)
      if (dateStr) row.outDates.push(dateStr)
    }
  }

  // 전체 최대금액 (log 정규화용)
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

    // 구분
    const type: ContactType =
      inAmount > 0 && outAmount > 0
        ? 'both'
        : inAmount >= outAmount
        ? 'sales'
        : 'purchase'

    // 마지막 거래일
    const allDates = [...row.allDates].sort()
    const lastDate = allDates[allDates.length - 1] ?? ''

    // --- 스코어 요소 ---

    // 1. 거래 빈도 (0~30점): 일 평균 거래 건수, 최대 1건/일 기준 정규화
    const freqPerDay = txCount / periodDays
    const freqScore = Math.min(30, Math.round(freqPerDay * 30 * 10)) // 10건/일 이상 = 만점

    // 2. 거래 금액 (0~35점): log scale 정규화
    const logScore =
      totalAmount > 0
        ? Math.min(35, Math.round((Math.log(totalAmount + 1) / Math.log(maxTotal + 1)) * 35))
        : 0

    // 3. 결제 안정성 (0~20점): 입금 거래가 있는 경우만, avgPayDays 낮을수록 높음
    let avgPayDays = 0
    let payScore = 10 // 데이터 없으면 중간값
    if (row.inDates.length > 0) {
      const sortedIn = [...row.inDates].sort()
      const gaps: number[] = []
      for (let i = 1; i < sortedIn.length; i++) {
        const gap = daysBetween(sortedIn[i - 1], sortedIn[i])
        if (gap > 0 && gap < 120) gaps.push(gap)
      }
      avgPayDays = gaps.length > 0 ? gaps.reduce((s, v) => s + v, 0) / gaps.length : 0
      // 7일 이내 = 20점, 30일 = 15점, 60일 = 8점, 90일+ = 2점
      payScore =
        avgPayDays === 0
          ? 10
          : avgPayDays <= 7
          ? 20
          : avgPayDays <= 15
          ? 17
          : avgPayDays <= 30
          ? 14
          : avgPayDays <= 60
          ? 9
          : 3
    }

    // 4. 거래 일관성 (0~15점): 변동계수(CV) = 표준편차/평균, 낮을수록 좋음
    const allAmounts = [...row.inAmounts, ...row.outAmounts]
    let consistency = 0
    let consistScore = 8 // 기본 중간값
    if (allAmounts.length >= 2) {
      const mean = allAmounts.reduce((s, v) => s + v, 0) / allAmounts.length
      if (mean > 0) {
        const variance =
          allAmounts.reduce((s, v) => s + (v - mean) ** 2, 0) / allAmounts.length
        consistency = Math.sqrt(variance) / mean
        // CV <= 0.3 = 15점, 0.5 = 12점, 1.0 = 8점, 2.0+ = 3점
        consistScore =
          consistency <= 0.3
            ? 15
            : consistency <= 0.5
            ? 12
            : consistency <= 1.0
            ? 8
            : 4
      }
    }

    const score = Math.min(100, freqScore + logScore + payScore + consistScore)

    // 등급
    const grade: Grade =
      score >= 90
        ? 'A+'
        : score >= 75
        ? 'A'
        : score >= 60
        ? 'B+'
        : score >= 45
        ? 'B'
        : score >= 30
        ? 'C'
        : 'D'

    results.push({
      name,
      type,
      txCount,
      totalAmount,
      inAmount,
      outAmount,
      lastDate,
      avgPayDays: Math.round(avgPayDays),
      consistency: Math.round(consistency * 100) / 100,
      score,
      grade,
      dates: allDates,
    })
  }

  return results.sort((a, b) => b.score - a.score)
}

// ─────────────────────────────────────────────
// 등급 배지
// ─────────────────────────────────────────────
function GradeBadge({ grade }: { grade: Grade }) {
  const cls: Record<Grade, string> = {
    'A+': 'bg-emerald-50 text-emerald-700 border-emerald-200',
    A: 'bg-emerald-50 text-emerald-600 border-emerald-200',
    'B+': 'bg-primary-50 text-primary-700 border-primary-200',
    B: 'bg-primary-50 text-primary-600 border-primary-200',
    C: 'bg-amber-50 text-amber-700 border-amber-200',
    D: 'bg-rose-50 text-rose-700 border-rose-200',
  }
  return <span className={`badge font-bold ${cls[grade]}`}>{grade}</span>
}

// ─────────────────────────────────────────────
// 구분 배지
// ─────────────────────────────────────────────
function TypeBadge({ type }: { type: ContactType }) {
  if (type === 'sales')
    return (
      <span className="badge bg-emerald-50 text-emerald-700 border-emerald-200 gap-0.5">
        <BuildingStorefrontIcon className="h-2.5 w-2.5" />
        매출처
      </span>
    )
  if (type === 'purchase')
    return (
      <span className="badge bg-amber-50 text-amber-700 border-amber-200 gap-0.5">
        <TruckIcon className="h-2.5 w-2.5" />
        매입처
      </span>
    )
  return (
    <span className="badge bg-ink-50 text-ink-600 border-ink-200 gap-0.5">
      <ArrowsRightLeftIcon className="h-2.5 w-2.5" />
      양방향
    </span>
  )
}

// ─────────────────────────────────────────────
// KPI 카드
// ─────────────────────────────────────────────
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
    amber: 'text-amber-700',
    rose: 'text-rose-700',
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

// ─────────────────────────────────────────────
// 점수 바
// ─────────────────────────────────────────────
function ScoreBar({ score }: { score: number }) {
  const color =
    score >= 75 ? '#10b981' : score >= 45 ? '#06b6d4' : score >= 30 ? '#f59e0b' : '#f43f5e'
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

// ─────────────────────────────────────────────
// 메인 컴포넌트
// ─────────────────────────────────────────────
export default function ContactScoringPage() {
  const [from, setFrom] = useState(thisMonthStartISO())
  const [to, setTo] = useState(todayISO())
  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState<'all' | ContactType>('all')
  const [gradeFilter, setGradeFilter] = useState<'all' | Grade>('all')
  const [sortKey, setSortKey] = useState<SortKey>('score')
  const [sortAsc, setSortAsc] = useState(false)
  const [selected, setSelected] = useState<ContactScore | null>(null)

  const ready = Boolean(from && to)
  const periodDays = ready ? daysBetween(from, to) : 31
  const exceeds31 = ready && periodDays > 31

  // 그랜터 헬스 체크
  const healthQuery = useQuery({
    queryKey: ['granter-health'],
    queryFn: () => granterApi.health().then((r) => r.data),
    retry: false,
  })
  const isConfigured = healthQuery.data?.configured

  // 티켓 전체 조회
  const dataQuery = useQuery({
    queryKey: ['contact-scoring', from, to],
    queryFn: async () => {
      let actualStart = from
      if (exceeds31) {
        const d = new Date(to)
        d.setDate(d.getDate() - 30)
        actualStart = d.toISOString().slice(0, 10)
      }
      const res = await granterApi.listTicketsAllTypes(actualStart, to)
      const raw = res.data
      const tickets: any[] = Array.isArray(raw) ? raw : raw?.data || []
      return { tickets, actualStart }
    },
    enabled: !!isConfigured && ready,
    retry: false,
  })

  const { tickets = [], actualStart } = dataQuery.data || {}

  // 최근 거래 자동 탐색 (24개월)
  const findRecentMut = useMutation({
    mutationFn: async () => {
      const today = new Date()
      for (let offset = 0; offset < 24; offset++) {
        const end = new Date(today)
        end.setDate(end.getDate() - offset * 31)
        const start = new Date(end)
        start.setDate(start.getDate() - 30)
        const startStr = start.toISOString().slice(0, 10)
        const endStr = end.toISOString().slice(0, 10)
        try {
          const res = await granterApi.listTicketsAllTypes(startStr, endStr)
          const items: any[] = Array.isArray(res.data) ? res.data : res.data?.data || []
          if (items.length > 0) {
            return { start: startStr, end: endStr, count: items.length, offset }
          }
        } catch {
          // 다음 구간 시도
        }
      }
      return { start: null, end: null, count: 0, offset: 0 }
    },
    onSuccess: (res) => {
      if (res.start && res.end) {
        setFrom(res.start)
        setTo(res.end)
        toast.success(
          `${res.offset === 0 ? '이번달' : `약 ${res.offset}개월 전`} · ${res.count}건 발견`
        )
      } else {
        toast.error('최근 24개월 내 거래 데이터가 없습니다.')
      }
    },
  })

  // 스코어링 계산
  const scores = useMemo(
    () => scoreContacts(tickets, periodDays),
    [tickets, periodDays]
  )

  // KPI
  const kpi = useMemo(() => {
    const salesCount = scores.filter((s) => s.type === 'sales').length
    const purchaseCount = scores.filter((s) => s.type === 'purchase').length
    const aCount = scores.filter((s) => s.grade === 'A+' || s.grade === 'A').length
    return { total: scores.length, salesCount, purchaseCount, aCount }
  }, [scores])

  // 필터 + 정렬
  const filtered = useMemo(() => {
    let arr = scores
    if (search) {
      const s = search.toLowerCase()
      arr = arr.filter((c) => c.name.toLowerCase().includes(s))
    }
    if (typeFilter !== 'all') arr = arr.filter((c) => c.type === typeFilter)
    if (gradeFilter !== 'all') arr = arr.filter((c) => c.grade === gradeFilter)
    return [...arr].sort((a, b) => {
      let va: number, vb: number
      if (sortKey === 'score') { va = a.score; vb = b.score }
      else if (sortKey === 'totalAmount') { va = a.totalAmount; vb = b.totalAmount }
      else if (sortKey === 'txCount') { va = a.txCount; vb = b.txCount }
      else if (sortKey === 'avgPayDays') { va = a.avgPayDays; vb = b.avgPayDays }
      else { va = a.lastDate < b.lastDate ? -1 : 1; vb = 0 }
      return sortAsc ? va - vb : vb - va
    })
  }, [scores, search, typeFilter, gradeFilter, sortKey, sortAsc])

  // 차트 데이터 (상위 10개)
  const chartData = useMemo(
    () =>
      scores.slice(0, 10).map((c) => ({
        name: c.name.length > 6 ? c.name.slice(0, 6) + '…' : c.name,
        score: c.score,
        grade: c.grade,
      })),
    [scores]
  )

  const GRADE_COLORS: Record<Grade, string> = {
    'A+': '#10b981',
    A: '#34d399',
    'B+': '#06b6d4',
    B: '#67e8f9',
    C: '#f59e0b',
    D: '#f43f5e',
  }

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortAsc((v) => !v)
    else { setSortKey(key); setSortAsc(false) }
  }
  const SortIcon = ({ k }: { k: SortKey }) =>
    sortKey === k ? (
      <span className="ml-0.5 text-ink-400">{sortAsc ? '↑' : '↓'}</span>
    ) : null

  const setQuickRange = (days: number) => {
    const end = new Date()
    const start = new Date()
    start.setDate(end.getDate() - days + 1)
    setFrom(start.toISOString().slice(0, 10))
    setTo(end.toISOString().slice(0, 10))
  }

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-end justify-between flex-wrap gap-2">
        <div>
          <h1 className="flex items-center gap-2">
            <StarIcon className="h-4 w-4 text-ink-500" />
            거래처 신용도 평가
          </h1>
          <p className="text-2xs text-ink-500 mt-0.5">
            그랜터 거래 데이터 기반 자동 스코어링 — 매출처·매입처 전체 평가
          </p>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <div className="flex items-center gap-0.5 p-0.5 rounded-md bg-white border border-ink-200">
            <button
              onClick={() => { setFrom(thisMonthStartISO()); setTo(todayISO()) }}
              className="px-2 py-1 rounded text-2xs font-semibold text-ink-600 hover:bg-ink-50"
            >
              이번달
            </button>
            <button
              onClick={() => setQuickRange(31)}
              className="px-2 py-1 rounded text-2xs font-semibold text-ink-600 hover:bg-ink-50"
            >
              31일
            </button>
            <button
              onClick={() => setQuickRange(90)}
              className="px-2 py-1 rounded text-2xs font-semibold text-ink-600 hover:bg-ink-50"
            >
              3개월
            </button>
          </div>
          <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-white border border-ink-200">
            <CalendarDaysIcon className="h-3 w-3 text-ink-400" />
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="bg-transparent text-2xs text-ink-700 w-24 focus:outline-none"
            />
            <span className="text-ink-300">→</span>
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="bg-transparent text-2xs text-ink-700 w-24 focus:outline-none"
            />
          </div>
          <button
            onClick={() => findRecentMut.mutate()}
            disabled={findRecentMut.isPending}
            className="btn-secondary"
          >
            <ClockIcon className="h-3 w-3 mr-1" />
            {findRecentMut.isPending ? '탐색 중...' : '자동 탐색'}
          </button>
          <button onClick={() => dataQuery.refetch()} className="btn-secondary">
            <ArrowPathIcon className="h-3 w-3" />
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
              {actualStart && ` (실제 조회: ${actualStart} ~ ${to})`}
            </div>
          )}
        </div>
      )}

      {/* KPI */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <KPI label="총 거래처" value={kpi.total} tone="neutral" />
        <KPI
          label="매출처"
          value={kpi.salesCount}
          tone="emerald"
          sub={`전체의 ${kpi.total ? Math.round((kpi.salesCount / kpi.total) * 100) : 0}%`}
        />
        <KPI
          label="매입처"
          value={kpi.purchaseCount}
          tone="amber"
          sub={`전체의 ${kpi.total ? Math.round((kpi.purchaseCount / kpi.total) * 100) : 0}%`}
        />
        <KPI
          label="A등급 이상"
          value={kpi.aCount}
          tone="primary"
          sub={`전체의 ${kpi.total ? Math.round((kpi.aCount / kpi.total) * 100) : 0}%`}
        />
      </div>

      {/* 차트 + 상세 */}
      <div className="grid grid-cols-12 gap-3">
        {/* 상위 10개 점수 차트 */}
        <div className={selected ? 'col-span-7' : 'col-span-12'}>
          <div className="space-y-3">
            {/* 필터 바 */}
            <div className="panel p-2 flex flex-wrap items-center gap-2">
              {/* 구분 필터 */}
              <div className="flex items-center gap-0.5 p-0.5 rounded-md bg-canvas-50 border border-ink-200">
                {(['all', 'sales', 'purchase', 'both'] as const).map((f) => (
                  <button
                    key={f}
                    onClick={() => setTypeFilter(f)}
                    className={`px-2.5 py-1 rounded text-2xs font-semibold ${
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
                    className={`px-2 py-1 rounded text-2xs font-bold ${
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
                  className="pl-7 input w-44 text-2xs"
                />
              </div>
            </div>

            {/* 상위 10 차트 (데이터가 있을 때만) */}
            {chartData.length > 0 && (
              <div className="panel px-3 py-2">
                <div className="text-2xs font-semibold text-ink-500 uppercase tracking-wider mb-2">
                  상위 거래처 점수 (Top {Math.min(10, chartData.length)})
                </div>
                <ResponsiveContainer width="100%" height={120}>
                  <BarChart data={chartData} margin={{ top: 0, right: 4, left: -20, bottom: 0 }}>
                    <XAxis
                      dataKey="name"
                      tick={{ fontSize: 9, fill: '#71717a' }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <YAxis
                      domain={[0, 100]}
                      tick={{ fontSize: 9, fill: '#71717a' }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <Tooltip
                      contentStyle={{
                        fontSize: 11,
                        padding: '4px 8px',
                        borderRadius: 6,
                        border: '1px solid #e4e4e7',
                      }}
                      formatter={(v: any) => [`${v}점`, '신용점수']}
                    />
                    <Bar dataKey="score" radius={[3, 3, 0, 0]} maxBarSize={32}>
                      {chartData.map((entry, idx) => (
                        <Cell
                          key={idx}
                          fill={GRADE_COLORS[entry.grade as Grade] || '#a1a1aa'}
                        />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* 테이블 */}
            <div className="panel overflow-hidden">
              <div className="overflow-x-auto max-h-[calc(100vh-30rem)] overflow-y-auto">
                <table className="min-w-full">
                  <thead className="bg-canvas-50 sticky top-0 z-10 border-b border-ink-200">
                    <tr>
                      <th className="px-3 py-1.5 text-left text-2xs font-semibold text-ink-500 uppercase tracking-wider w-6">
                        #
                      </th>
                      <th className="px-3 py-1.5 text-left text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                        등급
                      </th>
                      <th className="px-3 py-1.5 text-left text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                        거래처명
                      </th>
                      <th className="px-3 py-1.5 text-left text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                        구분
                      </th>
                      <th
                        className="px-3 py-1.5 text-right text-2xs font-semibold text-ink-500 uppercase tracking-wider cursor-pointer hover:text-ink-700"
                        onClick={() => toggleSort('txCount')}
                      >
                        거래 건수 <SortIcon k="txCount" />
                      </th>
                      <th
                        className="px-3 py-1.5 text-right text-2xs font-semibold text-ink-500 uppercase tracking-wider cursor-pointer hover:text-ink-700"
                        onClick={() => toggleSort('totalAmount')}
                      >
                        금액 합 <SortIcon k="totalAmount" />
                      </th>
                      <th
                        className="px-3 py-1.5 text-right text-2xs font-semibold text-ink-500 uppercase tracking-wider cursor-pointer hover:text-ink-700"
                        onClick={() => toggleSort('lastDate')}
                      >
                        마지막 거래 <SortIcon k="lastDate" />
                      </th>
                      <th
                        className="px-3 py-1.5 text-right text-2xs font-semibold text-ink-500 uppercase tracking-wider cursor-pointer hover:text-ink-700"
                        onClick={() => toggleSort('avgPayDays')}
                      >
                        결제 평균일 <SortIcon k="avgPayDays" />
                      </th>
                      <th
                        className="px-3 py-1.5 text-left text-2xs font-semibold text-ink-500 uppercase tracking-wider cursor-pointer hover:text-ink-700 w-32"
                        onClick={() => toggleSort('score')}
                      >
                        점수 <SortIcon k="score" />
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-100">
                    {dataQuery.isLoading && (
                      <tr>
                        <td colSpan={9} className="text-center py-8 text-2xs text-ink-400">
                          거래 데이터 분석 중…
                        </td>
                      </tr>
                    )}
                    {!dataQuery.isLoading && filtered.length === 0 && (
                      <tr>
                        <td colSpan={9} className="text-center py-8">
                          <div className="text-2xs text-ink-400">
                            {tickets.length === 0
                              ? '이 기간에 거래 데이터가 없습니다.'
                              : '조건에 맞는 거래처가 없습니다.'}
                          </div>
                          {tickets.length === 0 && (
                            <div className="mt-2">
                              <button
                                onClick={() => findRecentMut.mutate()}
                                disabled={findRecentMut.isPending}
                                className="text-primary-700 hover:underline text-2xs font-semibold"
                              >
                                최근 24개월에서 거래 자동 탐색
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                    {filtered.map((c) => {
                      const isSel = selected?.name === c.name
                      const rank = scores.findIndex((s) => s.name === c.name) + 1
                      return (
                        <tr
                          key={c.name}
                          onClick={() => setSelected(isSel ? null : c)}
                          className={`cursor-pointer ${isSel ? 'bg-ink-50' : 'hover:bg-canvas-50'}`}
                        >
                          <td className="px-3 py-1.5 text-2xs text-ink-400 font-mono">{rank}</td>
                          <td className="px-3 py-1.5">
                            <GradeBadge grade={c.grade} />
                          </td>
                          <td className="px-3 py-1.5">
                            <div className="text-xs font-medium text-ink-900 leading-tight">
                              {c.name}
                            </div>
                          </td>
                          <td className="px-3 py-1.5">
                            <TypeBadge type={c.type} />
                          </td>
                          <td className="px-3 py-1.5 text-right font-mono tabular-nums text-2xs text-ink-700">
                            {c.txCount.toLocaleString()}건
                          </td>
                          <td className="px-3 py-1.5 text-right font-mono tabular-nums text-xs font-semibold text-ink-900">
                            {formatCompactWon(c.totalAmount)}
                          </td>
                          <td className="px-3 py-1.5 text-right text-2xs text-ink-500 font-mono">
                            {c.lastDate || '-'}
                          </td>
                          <td className="px-3 py-1.5 text-right text-2xs font-mono text-ink-600">
                            {c.avgPayDays > 0 ? `${c.avgPayDays}일` : '-'}
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
                    {filtered.length}개 거래처 표시 (전체 {scores.length}개)
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* 상세 패널 */}
        {selected && (
          <div className="col-span-5">
            <ContactDetail contact={selected} onClose={() => setSelected(null)} />
          </div>
        )}
      </div>

      <div className="text-2xs text-ink-400 px-1">
        ※ 신용 점수는 거래 빈도(30점)·거래 금액(35점)·결제 안정성(20점)·일관성(15점) 합산.
        단기 데이터일수록 정확도가 낮을 수 있습니다.
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────
// 상세 패널
// ─────────────────────────────────────────────
function ContactDetail({
  contact,
  onClose,
}: {
  contact: ContactScore
  onClose: () => void
}) {
  const GRADE_BG: Record<Grade, string> = {
    'A+': 'bg-emerald-500',
    A: 'bg-emerald-400',
    'B+': 'bg-cyan-500',
    B: 'bg-cyan-400',
    C: 'bg-amber-400',
    D: 'bg-rose-500',
  }

  return (
    <div className="panel overflow-hidden h-full flex flex-col sticky top-4">
      {/* 패널 헤더 */}
      <div className="px-3 py-2 border-b border-ink-200 flex items-center justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              className={`inline-flex items-center justify-center w-7 h-7 rounded-full text-white text-xs font-bold ${GRADE_BG[contact.grade]}`}
            >
              {contact.grade}
            </span>
            <h2 className="text-sm truncate">{contact.name}</h2>
          </div>
          <div className="flex items-center gap-1.5 mt-1">
            <TypeBadge type={contact.type} />
            <span className="text-2xs text-ink-500">신용점수 {contact.score}점</span>
          </div>
        </div>
        <button onClick={onClose} className="text-ink-400 hover:text-ink-700 flex-shrink-0">
          <span className="text-sm">✕</span>
        </button>
      </div>

      {/* 점수 분해 */}
      <div className="px-3 py-2 border-b border-ink-100">
        <div className="text-2xs font-semibold text-ink-500 uppercase tracking-wider mb-2">
          점수 분석
        </div>
        <div className="space-y-1.5">
          <ScoreBreakRow label="거래 빈도" max={30} value={Math.min(30, Math.round((contact.txCount / 10) * 3))} hint={`${contact.txCount}건`} />
          <ScoreBreakRow
            label="거래 금액"
            max={35}
            value={Math.min(35, Math.round((Math.log(contact.totalAmount + 1) / Math.log(1_000_000_000 + 1)) * 35))}
            hint={formatCompactWon(contact.totalAmount)}
          />
          <ScoreBreakRow
            label="결제 안정성"
            max={20}
            value={
              contact.avgPayDays === 0
                ? 10
                : contact.avgPayDays <= 7
                ? 20
                : contact.avgPayDays <= 15
                ? 17
                : contact.avgPayDays <= 30
                ? 14
                : contact.avgPayDays <= 60
                ? 9
                : 3
            }
            hint={contact.avgPayDays > 0 ? `평균 ${contact.avgPayDays}일` : '데이터 없음'}
          />
          <ScoreBreakRow
            label="거래 일관성"
            max={15}
            value={contact.consistency <= 0.3 ? 15 : contact.consistency <= 0.5 ? 12 : contact.consistency <= 1.0 ? 8 : 4}
            hint={`변동계수 ${contact.consistency.toFixed(2)}`}
          />
        </div>
      </div>

      {/* 거래 요약 */}
      <div className="px-3 py-2 flex-1 overflow-y-auto">
        <div className="text-2xs font-semibold text-ink-500 uppercase tracking-wider mb-2">
          거래 요약
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-md bg-canvas-50 border border-ink-100 px-2.5 py-2">
            <div className="text-2xs text-ink-500 mb-0.5">총 거래 건수</div>
            <div className="text-sm font-bold font-mono text-ink-900">
              {contact.txCount.toLocaleString()}건
            </div>
          </div>
          <div className="rounded-md bg-canvas-50 border border-ink-100 px-2.5 py-2">
            <div className="text-2xs text-ink-500 mb-0.5">총 거래 금액</div>
            <div className="text-sm font-bold font-mono text-ink-900">
              {formatCompactWon(contact.totalAmount)}
            </div>
          </div>
          {contact.inAmount > 0 && (
            <div className="rounded-md bg-emerald-50 border border-emerald-100 px-2.5 py-2">
              <div className="text-2xs text-emerald-600 mb-0.5">입금 (IN)</div>
              <div className="text-sm font-bold font-mono text-emerald-700">
                {formatCompactWon(contact.inAmount)}
              </div>
            </div>
          )}
          {contact.outAmount > 0 && (
            <div className="rounded-md bg-amber-50 border border-amber-100 px-2.5 py-2">
              <div className="text-2xs text-amber-600 mb-0.5">출금 (OUT)</div>
              <div className="text-sm font-bold font-mono text-amber-700">
                {formatCompactWon(contact.outAmount)}
              </div>
            </div>
          )}
        </div>

        {/* 상세 수치 */}
        <div className="mt-3 space-y-1">
          <DetailRow label="마지막 거래일" value={contact.lastDate || '-'} />
          <DetailRow
            label="결제 평균 일수"
            value={contact.avgPayDays > 0 ? `${contact.avgPayDays}일` : '-'}
          />
          <DetailRow label="변동계수 (일관성)" value={contact.consistency.toFixed(2)} />
          <DetailRow
            label="금액 상세"
            value={formatCurrency(contact.totalAmount, false)}
          />
        </div>

        {/* 등급 해설 */}
        <div className="mt-3 rounded-md border border-ink-100 bg-canvas-50 px-2.5 py-2">
          <div className="text-2xs font-semibold text-ink-600 mb-1">등급 해설</div>
          <p className="text-2xs text-ink-500 leading-relaxed">
            {contact.grade === 'A+' && '최우량 거래처. 거래 빈도·금액 모두 안정적이며 신뢰도가 매우 높습니다.'}
            {contact.grade === 'A' && '우량 거래처. 전반적으로 안정적인 거래 패턴을 보입니다.'}
            {contact.grade === 'B+' && '양호한 거래처. 일부 지표에서 개선 여지가 있습니다.'}
            {contact.grade === 'B' && '보통 거래처. 거래 지속 모니터링이 권장됩니다.'}
            {contact.grade === 'C' && '주의 거래처. 거래 빈도 또는 금액 안정성이 낮습니다.'}
            {contact.grade === 'D' && '관리 대상 거래처. 거래 지속 여부를 재검토하세요.'}
          </p>
        </div>
      </div>
    </div>
  )
}

function ScoreBreakRow({
  label,
  max,
  value,
  hint,
}: {
  label: string
  max: number
  value: number
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
        <div
          className="h-full rounded-full bg-primary-500"
          style={{ width: `${pct}%` }}
        />
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
