import React, { useState, useMemo, useEffect, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend,
} from 'recharts'
import {
  ShieldExclamationIcon,
  ExclamationTriangleIcon,
  ArrowPathIcon,
  XMarkIcon,
  CheckCircleIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
} from '@heroicons/react/24/outline'
import PeriodPicker from '@/components/common/PeriodPicker'
import { usePeriodStore } from '@/store/periodStore'
import { granterApi } from '@/services/api'
import { formatCurrency, formatDateTime, isoLocal } from '@/utils/format'
import { buildOwnAccountSet, filterOutInternalTransfers, isSelfContact } from '@/utils/internalTransfer'

// ─── 안전한 직렬화 ────────────────────────────────────────────────────────────

function safeStringify(obj: any): string {
  const seen = new WeakSet()
  return JSON.stringify(
    obj,
    (_, v) => {
      if (typeof v === 'object' && v !== null) {
        if (seen.has(v)) return '[Circular]'
        seen.add(v)
      }
      return v
    },
    2
  )
}

// ─── 날짜 유틸 ───────────────────────────────────────────────────────────────

function daysBetween(a: string, b: string): number {
  return Math.floor((new Date(b).getTime() - new Date(a).getTime()) / 86400000) + 1
}

// ─── 헬퍼 ────────────────────────────────────────────────────────────────────

function str(obj: any, ...keys: string[]): string {
  for (const k of keys) {
    const v = obj?.[k]
    if (v !== undefined && v !== null && v !== '') return String(v)
  }
  return ''
}

/** 거래처명 추출 — SettlementPage 패턴 */
function extractContact(t: any): string {
  if (t?.taxInvoice) {
    const ti = t.taxInvoice
    if (str(t, 'transactionType') === 'IN') {
      return str(ti?.contractor, 'companyName') || str(ti?.supplier, 'companyName') || '(미지정)'
    }
    return str(ti?.supplier, 'companyName') || str(ti?.contractor, 'companyName') || '(미지정)'
  }
  if (t?.cashReceipt) {
    return (
      str(t.cashReceipt?.issuer, 'companyName') ||
      str(t.cashReceipt?.issuer, 'userName') ||
      '(미지정)'
    )
  }
  return (
    str(t, 'contact') ||
    str(t?.bankTransaction, 'counterparty') ||
    str(t?.cardUsage, 'storeName') ||
    str(t?.bankTransaction, 'content') ||
    str(t, 'content', 'merchantName', 'counterpartyName', 'vendor') ||
    '(미지정)'
  )
}

/** API 응답 정규화 */
function normalizeTickets(data: any): any[] {
  if (!data) return []
  if (Array.isArray(data)) return data
  if (typeof data === 'object') {
    const all: any[] = []
    for (const v of Object.values(data)) {
      if (Array.isArray(v)) all.push(...(v as any[]))
      else if (v && typeof v === 'object' && Array.isArray((v as any).data)) {
        all.push(...(v as any).data)
      }
    }
    if (all.length > 0) return all
    if (Array.isArray((data as any).data)) return (data as any).data
  }
  return []
}

// ─── 타입 ─────────────────────────────────────────────────────────────────────

type RuleKey =
  | 'anomaly'
  | 'large'
  | 'night'
  | 'no_category'
  | 'no_attachment'
  | 'long_pending'
  | 'not_included'
  | 'duplicate'

type Severity = 'high' | 'medium' | 'low'
type Side = 'revenue' | 'expense' | 'neutral'
type SortKey = 'date' | 'amount' | 'severity'
type SortDir = 'asc' | 'desc'

interface Issue {
  ticketId: number
  ticket: any
  ruleKey: RuleKey
  ruleLabel: string
  severity: Severity
  side: Side
  amount: number
  contact: string
  date: string
  message: string
}

/** 같은 ticketId가 여러 룰에 걸렸을 때 한 행으로 묶는 그룹 단위 */
interface IssueGroup {
  ticketId: number
  ticket: any
  contact: string
  date: string
  side: Side
  amount: number
  highestSeverity: Severity
  issues: Issue[]
}

// ─── 탭 메타 ──────────────────────────────────────────────────────────────────

type TabKey = 'all' | 'revenue' | 'expense' | RuleKey

interface TabMeta {
  key: TabKey
  label: string
  severityColor: string
  badgeClass: string
}

const TAB_META: TabMeta[] = [
  { key: 'all',           label: '전체',   severityColor: 'border-ink-900 text-ink-900',           badgeClass: 'bg-ink-100 text-ink-700 border-ink-200' },
  { key: 'revenue',       label: '매출사이드', severityColor: 'border-emerald-500 text-emerald-700', badgeClass: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  { key: 'expense',       label: '비용사이드', severityColor: 'border-rose-400 text-rose-600',       badgeClass: 'bg-rose-50 text-rose-700 border-rose-200' },
  { key: 'anomaly',       label: '이상거래', severityColor: 'border-rose-500 text-rose-700',         badgeClass: 'bg-rose-50 text-rose-700 border-rose-200' },
  { key: 'duplicate',     label: '중복',    severityColor: 'border-rose-500 text-rose-700',         badgeClass: 'bg-rose-50 text-rose-700 border-rose-200' },
  { key: 'large',         label: '큰금액',  severityColor: 'border-rose-500 text-rose-700',         badgeClass: 'bg-rose-50 text-rose-700 border-rose-200' },
  { key: 'night',         label: '새벽',    severityColor: 'border-amber-500 text-amber-700',       badgeClass: 'bg-amber-50 text-amber-700 border-amber-200' },
  { key: 'no_category',   label: '미분류',  severityColor: 'border-amber-500 text-amber-700',       badgeClass: 'bg-amber-50 text-amber-700 border-amber-200' },
  { key: 'no_attachment', label: '증빙없음', severityColor: 'border-amber-500 text-amber-700',      badgeClass: 'bg-amber-50 text-amber-700 border-amber-200' },
  { key: 'long_pending',  label: '미확인',  severityColor: 'border-primary-500 text-primary-700',   badgeClass: 'bg-primary-50 text-primary-700 border-primary-200' },
  { key: 'not_included',  label: '미포함',  severityColor: 'border-ink-500 text-ink-700',           badgeClass: 'bg-ink-50 text-ink-700 border-ink-200' },
]

const RULE_COLOR: Record<RuleKey, string> = {
  anomaly:        'bg-rose-50 text-rose-700 border-rose-200',
  large:          'bg-rose-50 text-rose-700 border-rose-200',
  night:          'bg-amber-50 text-amber-700 border-amber-200',
  no_category:    'bg-amber-50 text-amber-700 border-amber-200',
  no_attachment:  'bg-amber-50 text-amber-700 border-amber-200',
  long_pending:   'bg-primary-50 text-primary-700 border-primary-200',
  not_included:   'bg-ink-50 text-ink-700 border-ink-200',
  duplicate:      'bg-rose-50 text-rose-700 border-rose-200',
}

const SEV_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 }

// ─── 검출 함수 (단일 순회 O(n)) ──────────────────────────────────────────────

function detectIssues(tickets: any[]): Issue[] {
  if (!tickets.length) return []

  console.time('[audit] detectIssues')

  const issues: Issue[] = []
  const now = Date.now()
  const N = tickets.length

  // ── 1패스: 티켓별 메타데이터 캐시 (extractContact 호출 1회만) ────────────
  const contactArr = new Array<string>(N)
  const amountArr  = new Array<number>(N)
  const tsArr      = new Array<number>(N)
  const dateArr    = new Array<string>(N)
  const txTypeArr  = new Array<string>(N)

  let amountSum = 0
  let amountCount = 0

  for (let i = 0; i < N; i++) {
    const t = tickets[i]
    const amount = Number(t.amount || 0)
    const date   = String(t.transactAt || t.transactionDate || t.createdAt || '')
    const ts     = date ? new Date(date).getTime() || 0 : 0
    const txType = str(t, 'transactionType')

    contactArr[i] = extractContact(t)
    amountArr[i]  = amount
    tsArr[i]      = ts
    dateArr[i]    = date
    txTypeArr[i]  = txType

    if (amount > 0) { amountSum += amount; amountCount++ }
  }

  const avgAmount = amountCount > 0 ? amountSum / amountCount : 0

  // ── 2패스: 중복 사전 처리 (100만원 이상만 — 소액 반복결제 노이즈 제거) ───
  const DUP_MIN_AMOUNT = 1_000_000
  const dupMap = new Map<string, number[]>()
  for (let i = 0; i < N; i++) {
    const contact = contactArr[i]
    const amount  = amountArr[i]
    const ts      = tsArr[i]
    if (amount < DUP_MIN_AMOUNT || contact === '(미지정)' || !ts) continue
    const key = `${contact}||${amount}`
    const arr = dupMap.get(key)
    if (arr) arr.push(ts)
    else dupMap.set(key, [ts])
  }

  const dupSet = new Set<number>() // index-based — Set<any>(ticket)는 객체 비교 비용↑
  for (let i = 0; i < N; i++) {
    const contact = contactArr[i]
    const amount  = amountArr[i]
    const ts      = tsArr[i]
    if (amount < DUP_MIN_AMOUNT || contact === '(미지정)' || !ts) continue
    const arr = dupMap.get(`${contact}||${amount}`)
    if (!arr || arr.length < 2) continue
    if (arr.some((other) => other !== ts && Math.abs(ts - other) <= 86400000)) {
      dupSet.add(i)
    }
  }

  // ── 3패스: 룰 검출 (본인 회사 거래는 검출 대상에서 제외) ─────────────
  for (let i = 0; i < N; i++) {
    const t = tickets[i]
    const ticketId = Number(t.id || 0)
    const contact  = contactArr[i]
    // 본인 회사(조인앤조인)와의 거래는 자체 거래이므로 감사 대상 아님
    if (isSelfContact(contact)) continue
    const amount   = amountArr[i]
    const date     = dateArr[i]
    const txType   = txTypeArr[i]
    const side: Side = txType === 'IN' ? 'revenue' : txType === 'OUT' ? 'expense' : 'neutral'

    const push = (ruleKey: RuleKey, ruleLabel: string, severity: Severity, message: string) => {
      issues.push({ ticketId, ticket: t, ruleKey, ruleLabel, severity, side, amount, contact, date, message })
    }

    // rule 1: anomalyStatus
    if (t.anomalyStatus === 'ANOMALY') {
      push('anomaly', '이상거래', 'high', '그랜터 이상 거래 자동 표시')
    }

    // rule 2: 큰 금액 (avg × 5)
    if (avgAmount > 0 && amount > avgAmount * 5) {
      push('large', '큰금액', amount >= 5_000_000 ? 'high' : 'medium',
        `평균(${formatCurrency(Math.round(avgAmount), false)}원)의 5배 초과`)
    }

    // rule 3: 새벽 거래 (0~6시)
    if (date) {
      const d = new Date(date)
      if (!Number.isNaN(d.getTime())) {
        const hour = d.getHours()
        if (hour >= 0 && hour < 6) {
          const hm = `${String(hour).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
          push('night', '새벽', 'medium', `새벽 시간대 거래 (${hm})`)
        }
      }
    }

    // rule 4: 카테고리 미분류
    const cat = t.expenseCategory
    const hasCat = cat && (typeof cat !== 'object' || cat?.name || cat?.code)
    if (!hasCat) {
      push('no_category', '미분류', 'low', '계정과목(expenseCategory) 미분류')
    }

    // rule 5: 100만원+ 첨부 없음
    if (amount >= 1_000_000 && (t.attachmentCount || 0) === 0) {
      push('no_attachment', '증빙없음', amount >= 5_000_000 ? 'high' : 'medium',
        `100만원 이상 거래 첨부 없음 (${formatCurrency(amount, false)}원)`)
    }

    // rule 6: 30일+ 미확인 (status NONE)
    if (t.status === 'NONE') {
      const ageDays = (now - new Date(t.createdAt || date || '').getTime()) / 86400000
      if (ageDays > 30) {
        push('long_pending', '미확인', amount >= 1_000_000 ? 'medium' : 'low',
          `${Math.floor(ageDays)}일간 미확인 (status: NONE)`)
      }
    }

    // rule 7: 미포함
    if (t.isIncluded === false) {
      push('not_included', '미포함', amount >= 1_000_000 ? 'medium' : 'low',
        '회계 미포함 처리 (isIncluded: false)')
    }

    // rule 8: duplicate (100만원 이상)
    if (dupSet.has(i)) {
      push('duplicate', '중복', 'high',
        `24시간 내 동일 거래처·금액 중복 (${contact}, ${formatCurrency(amount, false)}원)`)
    }
  }

  issues.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || b.amount - a.amount)
  console.timeEnd('[audit] detectIssues')
  return issues
}

// ─── 자동 탐색 기간 목록 (6개월 거꾸로 — 그랜터 rate limit 보호) ──────────────

function buildFallbackPeriods(): Array<{ start: string; end: string }> {
  const periods: Array<{ start: string; end: string }> = []
  const today = new Date()
  for (let i = 0; i < 6; i++) {
    const end = new Date(today.getFullYear(), today.getMonth() - i, 0) // 해당 달 말일
    const start = new Date(end.getFullYear(), end.getMonth() - 1 + 1, 1) // 해당 달 1일
    // 30일 이내로 클램프
    const clampedStart = new Date(Math.max(start.getTime(), end.getTime() - 29 * 86400000))
    periods.push({ start: isoLocal(clampedStart), end: isoLocal(end) })
  }
  return periods
}

// ─── 메인 컴포넌트 ────────────────────────────────────────────────────────────

export default function AuditReportPage() {
  const preset = usePeriodStore((s) => s.preset)
  const from = usePeriodStore((s) => s.from)
  const to = usePeriodStore((s) => s.to)
  const setPeriod = usePeriodStore((s) => s.set)
  const [activeTab, setActiveTab] = useState<TabKey>('all')
  const [selected,  setSelected]  = useState<IssueGroup | null>(null)
  const [sortKey,   setSortKey]   = useState<SortKey>('severity')
  const [sortDir,   setSortDir]   = useState<SortDir>('asc')
  const [chartsOpen, setChartsOpen] = useState(false)  // 차트는 default 접힘 — 성능

  // 빈 결과 자동 탐색
  const fallbackPeriods = useRef(buildFallbackPeriods())
  const fallbackIdx     = useRef(0)
  const autoSearching   = useRef(false)
  const [fbFrom, setFbFrom] = useState('')
  const [fbTo,   setFbTo]   = useState('')

  const effectiveFrom = fbFrom || from
  const effectiveTo   = fbTo   || to

  const ready     = Boolean(effectiveFrom && effectiveTo)
  const exceeds31 = ready && daysBetween(effectiveFrom, effectiveTo) > 31

  // 그랜터 연결 확인
  const healthQuery = useQuery({
    queryKey: ['granter-health'],
    queryFn: () => granterApi.health().then((r) => r.data),
    retry: 3,
    retryDelay: (n) => Math.min(1000 * 2 ** n, 10000),
    staleTime: 60_000,
  })
  const isConfigured = healthQuery.data?.configured

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

  // backend 자동 분할 — frontend 클램프 불필요
  const ticketsQuery = useQuery({
    queryKey: ['audit', effectiveFrom, effectiveTo],
    queryFn: () => {
      console.time('[audit] listTicketsAllTypes')
      return granterApi.listTicketsAllTypes(effectiveFrom, effectiveTo).then((r) => {
        console.timeEnd('[audit] listTicketsAllTypes')
        return r.data
      })
    },
    enabled: ready && !!isConfigured,
    retry: false,
  })

  // 빈 결과 자동 탐색 — 빈 응답마다 다음 fallback으로 진행 (최대 24번)
  useEffect(() => {
    if (!isConfigured) return
    if (!ticketsQuery.isSuccess) return
    const tickets = normalizeTickets(ticketsQuery.data)
    if (tickets.length > 0) {
      // 데이터 발견 — 자동 탐색 종료
      return
    }
    // 빈 응답 — 다음 fallback period 시도
    if (fallbackIdx.current >= fallbackPeriods.current.length) return
    const next = fallbackPeriods.current[fallbackIdx.current++]
    setFbFrom(next.start)
    setFbTo(next.end)
  }, [ticketsQuery.isSuccess, ticketsQuery.data, isConfigured])

  // 계산 — 감사 리포트는 모든 거래(법인계좌 간 이체 포함)를 봐야 함.
  // 이체 카운트는 참고용으로만 표시.
  const rawTickets = useMemo(() => normalizeTickets(ticketsQuery.data), [ticketsQuery.data])
  const internalTransferTickets = useMemo(
    () => filterOutInternalTransfers(rawTickets, ownAccounts),
    [rawTickets, ownAccounts]
  )
  const filteredCount = rawTickets.length - internalTransferTickets.length
  const tickets = rawTickets // 감사 리포트는 모든 거래 검출
  const issues  = useMemo(
    () => (ticketsQuery.isSuccess ? detectIssues(tickets) : []),
    [ticketsQuery.isSuccess, tickets]
  )

  // KPI — 모든 합계는 ticketId 기준 unique 처리 (한 거래가 여러 룰에 걸려도 1회만 카운트)
  const kpi = useMemo(() => {
    const totalCount   = issues.length  // 검출 건수는 룰 단위
    const highCount    = issues.filter((i) => i.severity === 'high').length
    const mediumCount  = issues.filter((i) => i.severity === 'medium').length
    const lowCount     = issues.filter((i) => i.severity === 'low').length

    // ticketId별 1회만 집계 (revenue/expense, totalAmount 모두)
    const seenAll = new Set<number>()
    const seenRev = new Set<number>()
    const seenExp = new Set<number>()
    let totalAmount = 0
    let revAmount = 0
    let expAmount = 0

    for (const i of issues) {
      if (!seenAll.has(i.ticketId)) {
        seenAll.add(i.ticketId)
        totalAmount += i.amount
      }
      if (i.side === 'revenue' && !seenRev.has(i.ticketId)) {
        seenRev.add(i.ticketId)
        revAmount += i.amount
      }
      if (i.side === 'expense' && !seenExp.has(i.ticketId)) {
        seenExp.add(i.ticketId)
        expAmount += i.amount
      }
    }

    return {
      totalCount, highCount, mediumCount, lowCount,
      revCount: seenRev.size, revAmount,
      expCount: seenExp.size, expAmount,
      totalAmount,
    }
  }, [issues])

  // ticketId별 그룹핑 — 같은 거래에 여러 룰 매칭 시 한 행으로 합침
  const groupedIssues = useMemo<IssueGroup[]>(() => {
    const map = new Map<number, IssueGroup>()
    for (const issue of issues) {
      const existing = map.get(issue.ticketId)
      if (existing) {
        existing.issues.push(issue)
        if (SEV_ORDER[issue.severity] < SEV_ORDER[existing.highestSeverity]) {
          existing.highestSeverity = issue.severity
        }
      } else {
        map.set(issue.ticketId, {
          ticketId: issue.ticketId,
          ticket: issue.ticket,
          contact: issue.contact,
          date: issue.date,
          side: issue.side,
          amount: issue.amount,
          highestSeverity: issue.severity,
          issues: [issue],
        })
      }
    }
    return Array.from(map.values())
  }, [issues])

  // 탭별 카운트 — 룰 단위(전체/매출/비용 제외) 외엔 거래 단위 매칭
  const tabCounts = useMemo(() => {
    const c: Record<string, number> = {
      all: groupedIssues.length,
      revenue: 0,
      expense: 0,
    }
    for (const g of groupedIssues) {
      if (g.side === 'revenue') c.revenue++
      if (g.side === 'expense') c.expense++
      const seenRules = new Set<string>()
      for (const i of g.issues) {
        if (seenRules.has(i.ruleKey)) continue
        seenRules.add(i.ruleKey)
        c[i.ruleKey] = (c[i.ruleKey] || 0) + 1
      }
    }
    return c
  }, [groupedIssues])

  // 표시 목록 (탭 필터 + 정렬) — 거래(IssueGroup) 단위
  const displayed = useMemo<IssueGroup[]>(() => {
    let list = groupedIssues
    if (activeTab === 'revenue') list = list.filter((g) => g.side === 'revenue')
    else if (activeTab === 'expense') list = list.filter((g) => g.side === 'expense')
    else if (activeTab !== 'all') list = list.filter((g) => g.issues.some((i) => i.ruleKey === activeTab))

    return [...list].sort((a, b) => {
      let cmp = 0
      if (sortKey === 'date')     cmp = new Date(a.date).getTime() - new Date(b.date).getTime()
      if (sortKey === 'amount')   cmp = a.amount - b.amount
      if (sortKey === 'severity') cmp = SEV_ORDER[a.highestSeverity] - SEV_ORDER[b.highestSeverity]
      return sortDir === 'asc' ? cmp : -cmp
    })
  }, [groupedIssues, activeTab, sortKey, sortDir])

  // 페이지네이션 (성능 — DOM 폭발 방지)
  const PAGE_SIZE = 50
  const [pageNum, setPageNum] = useState(1)
  // 탭/정렬 변경 시 1페이지로 리셋
  useEffect(() => { setPageNum(1) }, [activeTab, sortKey, sortDir])
  const totalPages = Math.max(1, Math.ceil(displayed.length / PAGE_SIZE))
  const pagedIssues = useMemo(
    () => displayed.slice((pageNum - 1) * PAGE_SIZE, pageNum * PAGE_SIZE),
    [displayed, pageNum]
  )

  // 차트 데이터
  const monthlyChartData = useMemo(() => {
    const map = new Map<string, { count: number; amount: number }>()
    for (const i of issues) {
      if (!i.date) continue
      const d = new Date(i.date)
      if (Number.isNaN(d.getTime())) continue
      const label = `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}`
      const cur = map.get(label) || { count: 0, amount: 0 }
      map.set(label, { count: cur.count + 1, amount: cur.amount + i.amount })
    }
    return Array.from(map.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, v]) => ({ month, ...v }))
  }, [issues])

  const ruleChartData = useMemo(() => {
    const map = new Map<string, number>()
    for (const i of issues) {
      map.set(i.ruleLabel, (map.get(i.ruleLabel) || 0) + 1)
    }
    return Array.from(map.entries())
      .sort(([, a], [, b]) => b - a)
      .map(([name, value]) => ({ name, value }))
  }, [issues])

  const sideChartData = useMemo(() => [
    { name: '매출사이드', value: kpi.revCount,                              color: '#10b981' },
    { name: '비용사이드', value: kpi.expCount,                              color: '#f43f5e' },
    { name: '기타',       value: issues.filter((i) => i.side === 'neutral').length, color: '#94a3b8' },
  ].filter((d) => d.value > 0), [kpi, issues])

  const isLoading  = ticketsQuery.isLoading
  const isAllClean = ticketsQuery.isSuccess && tickets.length > 0 && issues.length === 0

  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortKey(key); setSortDir('asc') }
  }

  const SortIcon = ({ k }: { k: SortKey }) => {
    if (sortKey !== k) return <span className="opacity-30">↕</span>
    return <span>{sortDir === 'asc' ? '↑' : '↓'}</span>
  }

  return (
    <div className="space-y-3">
      {/* 헤더 */}
      <div className="flex items-end justify-between flex-wrap gap-2">
        <div>
          <h1 className="flex items-center gap-2">
            <ShieldExclamationIcon className="h-4 w-4 text-ink-500" />
            감사 대응 리포트
          </h1>
          <p className="text-2xs text-ink-500 mt-0.5">
            8가지 룰 자동 검출 — 이상거래 · 큰금액 · 새벽 · 미분류 · 증빙없음 · 미확인 · 미포함 · 중복
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
            onChange={(p, f, t) => {
              setPeriod(p, f, t)
              setFbFrom(''); setFbTo('')
              fallbackIdx.current = 0
              autoSearching.current = false
            }}
            groups={[
              { label: '월', presets: ['this_month', 'last_month'] },
              { label: '범위', presets: ['last_7d', 'last_30d'] },
            ]}
          />
          <button
            onClick={() => ticketsQuery.refetch()}
            className="btn-secondary"
            title="새로고침"
          >
            <ArrowPathIcon className="h-3 w-3" />
          </button>
        </div>
      </div>

      {/* 연결 상태 배너 */}
      {!healthQuery.isFetched ? (
        <div className="rounded-md border border-ink-200 bg-ink-50 px-3 py-2 flex items-center gap-2">
          <span className="text-2xs text-ink-600">그랜터 연결 확인 중…</span>
        </div>
      ) : !isConfigured ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 flex items-center gap-2">
          <ExclamationTriangleIcon className="h-4 w-4 text-amber-600 flex-shrink-0" />
          <span className="text-2xs text-amber-800">
            그랜터 API 키가 설정되지 않았습니다. 설정 후 감사 리포트를 이용할 수 있습니다.
          </span>
        </div>
      ) : (
        <div className="flex items-center gap-2 flex-wrap">
          <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-1 flex items-center gap-2">
            <CheckCircleIcon className="h-3.5 w-3.5 text-emerald-600" />
            <span className="text-2xs text-emerald-800">그랜터 연결됨</span>
          </div>
          {fbFrom && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-1 text-2xs text-amber-800">
              {`데이터 없음 — ${fbFrom} ~ ${fbTo} 자동 탐색 중`}
            </div>
          )}
          {!fbFrom && exceeds31 && (
            <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-1 text-2xs text-blue-800">
              ⓘ {daysBetween(effectiveFrom, effectiveTo)}일 분석 — 31일씩 자동 분할 호출({Math.ceil(daysBetween(effectiveFrom, effectiveTo) / 31)}회)되어 첫 로드가 다소 길 수 있음
            </div>
          )}
        </div>
      )}

      {/* KPI 카드 8개 */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2">
        <KpiCard label="총 검출"      value={kpi.totalCount}  unit="건" tone="warning"  loading={isLoading} />
        <KpiCard label="고위험"       value={kpi.highCount}   unit="건" tone="danger"   loading={isLoading} />
        <KpiCard label="중위험"       value={kpi.mediumCount} unit="건" tone="warning"  loading={isLoading} />
        <KpiCard label="저위험"       value={kpi.lowCount}    unit="건" tone="primary"  loading={isLoading} />
        <KpiCard label="매출사이드 건수" value={kpi.revCount}  unit="건" tone="emerald"  loading={isLoading} />
        <KpiCard label="매출사이드 금액" value={kpi.revAmount} unit="원" tone="emerald"  loading={isLoading} />
        <KpiCard label="비용사이드 건수" value={kpi.expCount}  unit="건" tone="danger"   loading={isLoading} />
        <KpiCard label="비용사이드 금액" value={kpi.expAmount} unit="원" tone="danger"   loading={isLoading} />
      </div>

      {/* 검출 금액 합계 배너 */}
      {!isLoading && issues.length > 0 && (
        <div className="panel px-4 py-2 flex items-center justify-between flex-wrap gap-2">
          <span className="text-2xs text-ink-500 font-semibold uppercase tracking-wider">검출 금액 합계 (중복 제외)</span>
          <span className="font-mono font-bold text-sm text-rose-700 tabular-nums">
            {formatCurrency(kpi.totalAmount, false)}
            <span className="text-2xs text-ink-400 ml-1 font-medium">원</span>
          </span>
        </div>
      )}

      {/* 모두 정상 */}
      {isAllClean && (
        <div className="panel p-6 flex flex-col items-center gap-3 border-emerald-200 bg-emerald-50">
          <div className="w-10 h-10 rounded-full bg-white flex items-center justify-center border border-emerald-200">
            <CheckCircleIcon className="h-5 w-5 text-emerald-600" />
          </div>
          <div className="text-center">
            <div className="text-sm font-semibold text-emerald-800">이상 없음</div>
            <div className="text-2xs text-ink-500 mt-1">
              조회 기간 내 {tickets.length.toLocaleString('ko-KR')}건 거래 — 모든 검출 룰을 통과했습니다.
            </div>
          </div>
        </div>
      )}

      {/* 차트 섹션 (사용자가 펼쳐야 렌더 — 성능) */}
      {!isLoading && issues.length > 0 && (
        <div className="panel">
          <button
            onClick={() => setChartsOpen((v) => !v)}
            className="w-full px-3 py-2 flex items-center justify-between text-2xs font-semibold text-ink-700 hover:bg-canvas-50"
          >
            <span>📊 시각화 (월별·룰별·사이드)</span>
            {chartsOpen ? <ChevronUpIcon className="h-3 w-3" /> : <ChevronDownIcon className="h-3 w-3" />}
          </button>
          {chartsOpen && <ChartsSection issues={issues} monthlyChartData={monthlyChartData} ruleChartData={ruleChartData} sideChartData={sideChartData} />}
        </div>
      )}

      {/* 탭 + 테이블 + 디테일 패널 */}
      {(issues.length > 0 || isLoading) && (
        <div className="grid grid-cols-12 gap-3">
          {/* 좌측 */}
          <div className={selected ? 'col-span-7' : 'col-span-12'}>
            <div className="panel overflow-hidden">
              {/* 탭 바 */}
              <div className="px-3 pt-2 pb-0 border-b border-ink-200 flex items-center overflow-x-auto">
                {TAB_META.map((tab) => {
                  const cnt = tabCounts[tab.key] || 0
                  const isActive = activeTab === tab.key
                  return (
                    <button
                      key={tab.key}
                      onClick={() => setActiveTab(tab.key)}
                      className={`px-3 py-1.5 text-2xs font-semibold border-b-2 transition -mb-px whitespace-nowrap ${
                        isActive
                          ? tab.severityColor
                          : 'border-transparent text-ink-500 hover:text-ink-700'
                      }`}
                    >
                      {tab.label}
                      {cnt > 0 && (
                        <span className={`ml-1 badge ${tab.badgeClass}`}>{cnt}</span>
                      )}
                    </button>
                  )
                })}
              </div>

              {/* 테이블 */}
              <div className="overflow-x-auto max-h-[calc(100vh-32rem)] overflow-y-auto">
                <table className="min-w-full">
                  <thead className="bg-canvas-50 sticky top-0 z-10 border-b border-ink-200">
                    <tr>
                      <th className="px-3 py-1.5 text-left text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                        <button onClick={() => handleSort('date')} className="flex items-center gap-0.5 hover:text-ink-700">
                          일시 <SortIcon k="date" />
                        </button>
                      </th>
                      <th className="px-3 py-1.5 text-left text-2xs font-semibold text-ink-500 uppercase tracking-wider">거래처</th>
                      <th className="px-3 py-1.5 text-left text-2xs font-semibold text-ink-500 uppercase tracking-wider">사이드</th>
                      <th className="px-3 py-1.5 text-right text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                        <button onClick={() => handleSort('amount')} className="flex items-center gap-0.5 hover:text-ink-700 ml-auto">
                          금액 <SortIcon k="amount" />
                        </button>
                      </th>
                      <th className="px-3 py-1.5 text-left text-2xs font-semibold text-ink-500 uppercase tracking-wider">룰</th>
                      <th className="px-3 py-1.5 text-center text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                        <button onClick={() => handleSort('severity')} className="flex items-center gap-0.5 hover:text-ink-700 mx-auto">
                          위험도 <SortIcon k="severity" />
                        </button>
                      </th>
                      <th className="px-3 py-1.5 text-left text-2xs font-semibold text-ink-500 uppercase tracking-wider">사유</th>
                      <th className="px-3 py-1.5 text-center text-2xs font-semibold text-ink-500 uppercase tracking-wider">확인</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-100">
                    {isLoading && (
                      <tr>
                        <td colSpan={8} className="text-center py-8 text-2xs text-ink-400">
                          데이터 불러오는 중…
                        </td>
                      </tr>
                    )}
                    {!isLoading && displayed.length === 0 && issues.length > 0 && (
                      <tr>
                        <td colSpan={8} className="text-center py-6 text-2xs text-ink-400">
                          이 탭에 검출된 건이 없습니다.
                        </td>
                      </tr>
                    )}
                    {pagedIssues.map((group, idx) => {
                      const isSel = selected?.ticketId === group.ticketId
                      return (
                        <tr
                          key={`${group.ticketId || idx}`}
                          onClick={() => setSelected(group)}
                          className={`cursor-pointer ${isSel ? 'bg-ink-50' : 'hover:bg-canvas-50'}`}
                        >
                          <td className="px-3 py-1.5 whitespace-nowrap text-2xs text-ink-700 font-mono align-top">
                            {group.date ? formatDateTime(group.date) : '-'}
                          </td>
                          <td className="px-3 py-1.5 text-xs text-ink-900 align-top">
                            <div className="font-medium truncate max-w-[130px]">{group.contact}</div>
                          </td>
                          <td className="px-3 py-1.5 whitespace-nowrap align-top">
                            <SideBadge side={group.side} />
                          </td>
                          <td className="px-3 py-1.5 text-right font-mono tabular-nums text-xs font-semibold text-ink-900 align-top">
                            {group.amount > 0 ? formatCurrency(group.amount, false) : '-'}
                          </td>
                          <td className="px-3 py-1.5 align-top">
                            <div className="flex flex-wrap gap-0.5 max-w-[180px]">
                              {group.issues.map((i, k) => (
                                <RuleBadge key={`${i.ruleKey}-${k}`} ruleKey={i.ruleKey} label={i.ruleLabel} />
                              ))}
                            </div>
                          </td>
                          <td className="px-3 py-1.5 text-center align-top">
                            <SeverityBadge severity={group.highestSeverity} />
                          </td>
                          <td className="px-3 py-1.5 text-2xs text-ink-700 max-w-[260px] align-top">
                            <div className="space-y-0.5">
                              {group.issues.map((i, k) => (
                                <div key={`${i.ruleKey}-${k}`} className="flex items-start gap-1" title={i.message}>
                                  <span className="text-ink-300">·</span>
                                  <span className="truncate">{i.message}</span>
                                </div>
                              ))}
                            </div>
                          </td>
                          <td className="px-3 py-1.5 text-center align-top">
                            <button
                              onClick={(e) => e.stopPropagation()}
                              className="btn-secondary text-2xs px-2 py-0.5"
                            >
                              <CheckIcon className="h-3 w-3 mr-0.5" />
                              확인
                            </button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              {/* 페이지네이션 컨트롤 */}
              {displayed.length > PAGE_SIZE && (
                <div className="px-3 py-2 border-t border-ink-200 flex items-center justify-between text-2xs">
                  <div className="text-ink-500">
                    {(pageNum - 1) * PAGE_SIZE + 1}–{Math.min(pageNum * PAGE_SIZE, displayed.length)} /{' '}
                    <span className="font-semibold text-ink-700">{displayed.length}</span>건
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => setPageNum(1)}
                      disabled={pageNum === 1}
                      className="btn-secondary text-2xs px-2 py-0.5 disabled:opacity-40"
                    >
                      ‹‹
                    </button>
                    <button
                      onClick={() => setPageNum((p) => Math.max(1, p - 1))}
                      disabled={pageNum === 1}
                      className="btn-secondary text-2xs px-2 py-0.5 disabled:opacity-40"
                    >
                      ‹
                    </button>
                    <span className="px-2 text-ink-700 font-mono">
                      {pageNum} / {totalPages}
                    </span>
                    <button
                      onClick={() => setPageNum((p) => Math.min(totalPages, p + 1))}
                      disabled={pageNum >= totalPages}
                      className="btn-secondary text-2xs px-2 py-0.5 disabled:opacity-40"
                    >
                      ›
                    </button>
                    <button
                      onClick={() => setPageNum(totalPages)}
                      disabled={pageNum >= totalPages}
                      className="btn-secondary text-2xs px-2 py-0.5 disabled:opacity-40"
                    >
                      ››
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* 우측 디테일 패널 */}
          {selected && (
            <div className="col-span-5">
              <DetailPanel group={selected} onClose={() => setSelected(null)} />
            </div>
          )}
        </div>
      )}

      {/* 데이터 없음 */}
      {!isLoading && ticketsQuery.isSuccess && tickets.length === 0 && isConfigured && (
        <div className="panel p-6 text-center">
          <div className="text-2xs text-ink-400">조회 기간 내 거래 데이터가 없습니다.</div>
          <div className="text-2xs text-ink-400 mt-1">기간을 변경하거나 그랜터 자산 연동 상태를 확인하세요.</div>
        </div>
      )}

      <div className="text-2xs text-ink-400 px-1">
        ※ 검출 룰: anomalyStatus ANOMALY / 평균 5배 이상 / 새벽 0~6시 / 계정과목 미분류 / 100만원+ 첨부 없음 / NONE 30일+ / isIncluded false / 100만원+ 24시간 중복 · 합계는 ticketId 단위 unique (룰 다중매칭 1회 카운트)
      </div>
    </div>
  )
}

// ─── 디테일 패널 ──────────────────────────────────────────────────────────────

function DetailPanel({ group, onClose }: { group: IssueGroup; onClose: () => void }) {
  const [rawOpen, setRawOpen] = useState(false)

  const t = group.ticket
  const catStr = useMemo(() => {
    const c = t?.expenseCategory
    if (!c) return null
    return c?.name ? `${c.name}${c?.code ? ` (${c.code})` : ''}` : null
  }, [t])
  const assetName = useMemo(
    () => t?.assetName || t?.asset?.name || t?.bankTransaction?.accountName || '',
    [t]
  )

  // 무거운 safeStringify는 사용자가 펼쳤을 때만 1회 실행 (메인 스레드 freeze 방지)
  const rawStr = useMemo(() => {
    if (!rawOpen) return ''
    try { return safeStringify(t) }
    catch { return '(직렬화 실패)' }
  }, [rawOpen, t])

  return (
    <div className="panel overflow-hidden h-full flex flex-col">
      {/* 헤더 */}
      <div className="px-3 py-2 border-b border-ink-200 flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            <h2 className="text-sm font-semibold truncate">{group.contact}</h2>
            <SideBadge side={group.side} />
          </div>
          <div className="text-2xs text-ink-500 mt-0.5 font-mono">
            {group.date ? formatDateTime(group.date) : '-'}
          </div>
        </div>
        <button
          onClick={onClose}
          className="text-ink-400 hover:text-ink-700 flex-shrink-0"
        >
          <XMarkIcon className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* 핵심 정보 카드 */}
        <div className="px-3 pt-3 pb-0 grid grid-cols-2 gap-2">
          <InfoCard label="금액">
            <span className="font-mono font-bold text-sm text-ink-900 tabular-nums">
              {group.amount > 0 ? `${formatCurrency(group.amount, false)}원` : '-'}
            </span>
          </InfoCard>
          <InfoCard label="구분">
            <SideBadge side={group.side} />
          </InfoCard>
          <InfoCard label="계정과목">
            <span className={`text-2xs ${catStr ? 'text-ink-800' : 'text-rose-500 font-medium'}`}>
              {catStr ?? '미분류'}
            </span>
          </InfoCard>
          <InfoCard label="자산명">
            <span className="text-2xs text-ink-800 truncate">{assetName || '-'}</span>
          </InfoCard>
        </div>

        {/* 검출된 룰 (모두 표시) */}
        <div className="px-3 pt-2">
          <div className="text-2xs font-semibold text-ink-500 uppercase tracking-wider mb-1">
            검출 룰 {group.issues.length > 1 && <span className="text-ink-400 font-normal">({group.issues.length}개)</span>}
          </div>
          <div className="flex flex-wrap gap-1">
            <SeverityBadge severity={group.highestSeverity} />
            {group.issues.map((i, k) => (
              <RuleBadge key={`${i.ruleKey}-${k}`} ruleKey={i.ruleKey} label={i.ruleLabel} />
            ))}
          </div>
          <div className="mt-1.5 space-y-1">
            {group.issues.map((i, k) => (
              <div key={`${i.ruleKey}-${k}`} className="text-2xs text-ink-700 flex items-start gap-1">
                <span className="text-rose-400 mt-0.5">·</span>
                <span><span className="font-semibold text-ink-900">[{i.ruleLabel}]</span> {i.message}</span>
              </div>
            ))}
          </div>
        </div>

        {/* 원본 Raw JSON (접고 펼치기) */}
        <div className="px-3 pt-3 pb-3">
          <button
            onClick={() => setRawOpen((v) => !v)}
            className="flex items-center gap-1 text-2xs font-semibold text-ink-500 uppercase tracking-wider hover:text-ink-700 transition"
          >
            {rawOpen
              ? <ChevronUpIcon className="h-3 w-3" />
              : <ChevronDownIcon className="h-3 w-3" />
            }
            원본 JSON (감사용)
          </button>
          {rawOpen && (
            <pre className="mt-2 text-2xs font-mono text-ink-700 bg-canvas-50 border border-ink-100 rounded p-2 overflow-x-auto whitespace-pre-wrap break-all max-h-72 overflow-y-auto">
              {rawStr}
            </pre>
          )}
        </div>
      </div>
    </div>
  )
}

function InfoCard({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded border border-ink-100 bg-canvas-50 px-2 py-1.5">
      <div className="text-2xs text-ink-400 mb-0.5">{label}</div>
      <div className="flex items-center min-h-[18px]">{children}</div>
    </div>
  )
}

// ─── 서브 컴포넌트 ────────────────────────────────────────────────────────────

function KpiCard({
  label, value, unit, tone, loading,
}: {
  label: string; value: number; unit: string
  tone: 'neutral' | 'danger' | 'warning' | 'primary' | 'emerald'
  loading?: boolean
}) {
  const cls: Record<string, string> = {
    neutral: 'text-ink-900', danger: 'text-rose-700', warning: 'text-amber-700',
    primary: 'text-primary-700', emerald: 'text-emerald-700',
  }
  return (
    <div className="panel px-3 py-2">
      <div className="text-2xs font-medium text-ink-500 uppercase tracking-wider truncate leading-tight">{label}</div>
      <div className={`mt-0.5 font-mono tabular-nums font-bold text-sm ${cls[tone]}`}>
        {loading ? (
          <span className="text-ink-300">—</span>
        ) : unit === '원' ? (
          <>{formatCurrency(value, false)}<span className="text-2xs text-ink-400 ml-1 font-medium">원</span></>
        ) : (
          <>{value.toLocaleString('ko-KR')}<span className="text-2xs text-ink-400 ml-1 font-medium">{unit}</span></>
        )}
      </div>
    </div>
  )
}

function SeverityBadge({ severity }: { severity: Severity }) {
  if (severity === 'high')   return <span className="badge bg-rose-50 text-rose-700 border-rose-200">고위험</span>
  if (severity === 'medium') return <span className="badge bg-amber-50 text-amber-700 border-amber-200">중위험</span>
  return <span className="badge bg-primary-50 text-primary-700 border-primary-200">저위험</span>
}

function SideBadge({ side }: { side: Side }) {
  if (side === 'revenue') return <span className="badge bg-emerald-50 text-emerald-700 border-emerald-200">매출 IN</span>
  if (side === 'expense') return <span className="badge bg-rose-50 text-rose-600 border-rose-200">비용 OUT</span>
  return <span className="badge bg-ink-50 text-ink-500 border-ink-200">기타</span>
}

function RuleBadge({ ruleKey, label }: { ruleKey: RuleKey; label: string }) {
  return <span className={`badge ${RULE_COLOR[ruleKey]}`}>{label}</span>
}

// React.memo로 감싼 차트 섹션 — issues 동일하면 리렌더 안 됨 (성능)
const ChartsSection = React.memo(function ChartsSection({
  monthlyChartData,
  ruleChartData,
  sideChartData,
}: {
  issues: Issue[]
  monthlyChartData: { month: string; count: number; amount: number }[]
  ruleChartData: { name: string; value: number }[]
  sideChartData: { name: string; value: number; color: string }[]
}) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 p-3">
      {/* 월별 검출 */}
      <div className="panel p-3">
        <div className="text-2xs font-semibold text-ink-600 uppercase tracking-wider mb-2">월별 검출 건수</div>
        {monthlyChartData.length === 0 ? (
          <div className="h-32 flex items-center justify-center text-2xs text-ink-400">데이터 없음</div>
        ) : (
          <ResponsiveContainer width="100%" height={140}>
            <BarChart data={monthlyChartData} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="month" tick={{ fontSize: 9 }} />
              <YAxis tick={{ fontSize: 9 }} allowDecimals={false} />
              <Tooltip contentStyle={{ fontSize: 11 }} formatter={(v: number) => [v.toLocaleString('ko-KR') + '건', '건수']} />
              <Bar dataKey="count" fill="#6366f1" radius={[2, 2, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
      {/* 룰별 */}
      <div className="panel p-3">
        <div className="text-2xs font-semibold text-ink-600 uppercase tracking-wider mb-2">룰별 검출 건수</div>
        {ruleChartData.length === 0 ? (
          <div className="h-32 flex items-center justify-center text-2xs text-ink-400">데이터 없음</div>
        ) : (
          <ResponsiveContainer width="100%" height={140}>
            <BarChart data={ruleChartData} layout="vertical" margin={{ top: 0, right: 12, left: 4, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis type="number" tick={{ fontSize: 9 }} allowDecimals={false} />
              <YAxis dataKey="name" type="category" tick={{ fontSize: 9 }} width={52} />
              <Tooltip contentStyle={{ fontSize: 11 }} formatter={(v: number) => [v.toLocaleString('ko-KR') + '건', '건수']} />
              <Bar dataKey="value" fill="#f43f5e" radius={[0, 2, 2, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
      {/* 사이드 */}
      <div className="panel p-3">
        <div className="text-2xs font-semibold text-ink-600 uppercase tracking-wider mb-2">매출 / 비용 사이드</div>
        {sideChartData.length === 0 ? (
          <div className="h-32 flex items-center justify-center text-2xs text-ink-400">데이터 없음</div>
        ) : (
          <ResponsiveContainer width="100%" height={140}>
            <PieChart>
              <Pie
                data={sideChartData}
                dataKey="value"
                nameKey="name"
                cx="50%"
                cy="50%"
                outerRadius={52}
                label={({ name, percent }: any) => `${name} ${(Number(percent) * 100).toFixed(0)}%`}
                labelLine={false}
              >
                {sideChartData.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={entry.color} />
                ))}
              </Pie>
              <Legend iconSize={8} formatter={(value) => <span style={{ fontSize: 10 }}>{value}</span>} />
              <Tooltip contentStyle={{ fontSize: 11 }} formatter={(v: number) => [v.toLocaleString('ko-KR') + '건', '건수']} />
            </PieChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  )
})
