import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  ShieldExclamationIcon,
  ExclamationTriangleIcon,
  ClockIcon,
  EyeSlashIcon,
  CalendarDaysIcon,
  ArrowPathIcon,
  XMarkIcon,
  CheckCircleIcon,
  CheckIcon,
} from '@heroicons/react/24/outline'
import { granterApi } from '@/services/api'
import { formatCurrency, formatDate, formatDateTime } from '@/utils/format'

// ─── 날짜 유틸 ──────────────────────────────────────────────────────────────

function todayISO(): string {
  return new Date().toISOString().slice(0, 10)
}
function thisMonthStartISO(): string {
  const d = new Date()
  d.setDate(1)
  return d.toISOString().slice(0, 10)
}
function daysBetween(a: string, b: string): number {
  return Math.floor((new Date(b).getTime() - new Date(a).getTime()) / 86400000) + 1
}

// ─── Ticket 헬퍼 ────────────────────────────────────────────────────────────

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

/** 거래처명 추출 (그랜터 ticket 구조 기준) */
function extractContact(t: any): string {
  if (t?.taxInvoice) {
    const ti = t.taxInvoice
    if (str(t, 'transactionType') === 'IN') {
      return str(ti?.contractor, 'companyName') || str(ti?.supplier, 'companyName') || '(미지정)'
    }
    return str(ti?.supplier, 'companyName') || str(ti?.contractor, 'companyName') || '(미지정)'
  }
  if (t?.cashReceipt) {
    return str(t.cashReceipt?.issuer, 'companyName') || str(t.cashReceipt?.issuer, 'userName') || '(미지정)'
  }
  return (
    str(t, 'contact') ||
    str(t?.bankTransaction, 'counterparty') ||
    str(t?.cardUsage, 'storeName') ||
    str(t?.bankTransaction, 'content') ||
    '(미지정)'
  )
}

/** ticket 배열을 시간순(내림차순)으로 정규화 */
function normalizeTickets(data: any): any[] {
  if (!data) return []
  if (Array.isArray(data)) return data
  if (typeof data === 'object') {
    const all: any[] = []
    for (const v of Object.values(data)) {
      if (Array.isArray(v)) all.push(...(v as any[]))
    }
    return all.sort((a, b) =>
      String(b.transactAt || b.transactionDate || '').localeCompare(
        String(a.transactAt || a.transactionDate || '')
      )
    )
  }
  return []
}

// ─── 검출 규칙 타입 ─────────────────────────────────────────────────────────

type AuditCategory = 'anomaly' | 'missing_docs' | 'long_pending' | 'not_included'

type RiskLevel = 'high' | 'medium' | 'low'

interface FlaggedTicket {
  ticket: any
  category: AuditCategory
  riskLevel: RiskLevel
  reasons: string[]
  contact: string
  amount: number
  transactAt: string
}

// ─── 검출 규칙 함수들 (순수함수, 각각 독립) ─────────────────────────────────

/** 규칙 1: 그랜터 자동 이상 표시 */
function ruleGranterAnomaly(t: any): string | null {
  return t?.anomalyStatus === 'ANOMALY' ? '그랜터 이상 거래 자동 표시' : null
}

/** 규칙 2: 같은 거래처+금액 24시간 이내 중복 */
function ruleDuplicate(t: any, allTickets: any[]): string | null {
  const contact = extractContact(t)
  const amount = num(t, 'amount')
  const tAt = new Date(t.transactAt || t.transactionDate || '').getTime()
  if (!tAt || !amount || contact === '(미지정)') return null

  const isDup = allTickets.some((other) => {
    if (other.id === t.id || other === t) return false
    const oContact = extractContact(other)
    const oAmount = num(other, 'amount')
    const oAt = new Date(other.transactAt || other.transactionDate || '').getTime()
    if (!oAt) return false
    return (
      oContact === contact &&
      oAmount === amount &&
      Math.abs(tAt - oAt) <= 24 * 3600 * 1000
    )
  })
  return isDup ? `24시간 이내 동일 거래처·금액 중복 (${contact}, ${formatCurrency(amount, false)}원)` : null
}

/** 규칙 3: 평균 금액의 5배 이상 */
function ruleLargeAmount(t: any, avgAmount: number): string | null {
  const amount = num(t, 'amount')
  if (avgAmount <= 0 || amount <= 0) return null
  if (amount >= avgAmount * 5) {
    return `평균 거래금액(${formatCurrency(Math.round(avgAmount), false)}원)의 5배 이상`
  }
  return null
}

/** 규칙 4: 새벽 0~6시 거래 */
function ruleNightTransaction(t: any): string | null {
  const raw = t.transactAt || t.transactionDate || ''
  if (!raw) return null
  const d = new Date(raw)
  if (Number.isNaN(d.getTime())) return null
  const hour = d.getHours()
  if (hour >= 0 && hour < 6) {
    return `새벽 시간대 거래 (${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')})`
  }
  return null
}

/** 규칙 5: 계정과목(expenseCategory) 미분류 */
function ruleMissingCategory(t: any): string | null {
  const cat = t?.expenseCategory
  if (!cat || (typeof cat === 'object' && !cat?.name && !cat?.code)) {
    return '계정과목(expenseCategory) 미분류'
  }
  return null
}

/** 규칙 6: 첨부 없는 100만원 이상 거래 */
function ruleMissingAttachment(t: any): string | null {
  const amount = num(t, 'amount')
  const count = num(t, 'attachmentCount')
  if (amount >= 1_000_000 && count === 0) {
    return `100만원 이상 거래 첨부 없음 (${formatCurrency(amount, false)}원)`
  }
  return null
}

/** 규칙 7: 30일 이상 미확정(NONE) 거래 */
function ruleLongPending(t: any, now: Date): string | null {
  if (t?.status !== 'NONE') return null
  const raw = t.transactAt || t.createdAt || ''
  if (!raw) return null
  const d = new Date(raw)
  if (Number.isNaN(d.getTime())) return null
  const days = Math.floor((now.getTime() - d.getTime()) / 86400000)
  if (days >= 30) {
    return `${days}일간 미확정 (status: NONE)`
  }
  return null
}

/** 규칙 8: 회계 미포함 거래 */
function ruleNotIncluded(t: any): string | null {
  if (t?.isIncluded === false) {
    return '회계 미포함 처리 (isIncluded: false)'
  }
  return null
}

// ─── 위험도 결정 ─────────────────────────────────────────────────────────────

function calcRiskLevel(category: AuditCategory, amount: number, reasons: string[]): RiskLevel {
  if (category === 'anomaly') {
    // 그랜터 자동 표시 or 대금액이면 고위험
    if (reasons.some((r) => r.startsWith('그랜터')) || amount >= 5_000_000) return 'high'
    return 'medium'
  }
  if (category === 'missing_docs') {
    if (amount >= 5_000_000) return 'high'
    if (amount >= 1_000_000) return 'medium'
    return 'low'
  }
  if (category === 'long_pending') {
    if (amount >= 1_000_000) return 'medium'
    return 'low'
  }
  if (category === 'not_included') {
    if (amount >= 1_000_000) return 'medium'
    return 'low'
  }
  return 'low'
}

// ─── 메인 검출 함수 ─────────────────────────────────────────────────────────

function detectFlaggedTickets(tickets: any[]): FlaggedTicket[] {
  if (!tickets.length) return []

  const now = new Date()

  // 평균 금액 계산 (0 제외)
  const amounts = tickets.map((t) => num(t, 'amount')).filter((a) => a > 0)
  const avgAmount = amounts.length ? amounts.reduce((s, a) => s + a, 0) / amounts.length : 0

  const results: FlaggedTicket[] = []

  for (const t of tickets) {
    const contact = extractContact(t)
    const amount = num(t, 'amount')
    const transactAt = t.transactAt || t.transactionDate || t.createdAt || ''

    // 카테고리별 이유 수집
    const anomalyReasons: string[] = []
    const missingReasons: string[] = []
    const pendingReasons: string[] = []
    const notIncludedReasons: string[] = []

    // 이상 거래 검출
    const r1 = ruleGranterAnomaly(t)
    if (r1) anomalyReasons.push(r1)

    const r2 = ruleDuplicate(t, tickets)
    if (r2) anomalyReasons.push(r2)

    const r3 = ruleLargeAmount(t, avgAmount)
    if (r3) anomalyReasons.push(r3)

    const r4 = ruleNightTransaction(t)
    if (r4) anomalyReasons.push(r4)

    // 증빙 누락 검출
    const r5 = ruleMissingCategory(t)
    if (r5) missingReasons.push(r5)

    const r6 = ruleMissingAttachment(t)
    if (r6) missingReasons.push(r6)

    // 장기 미확인 검출
    const r7 = ruleLongPending(t, now)
    if (r7) pendingReasons.push(r7)

    // 미포함 거래 검출
    const r8 = ruleNotIncluded(t)
    if (r8) notIncludedReasons.push(r8)

    // 카테고리별로 각각 개별 항목으로 등록 (중복 건은 우선순위 카테고리로만)
    const addFlag = (category: AuditCategory, reasons: string[]) => {
      if (!reasons.length) return
      const riskLevel = calcRiskLevel(category, amount, reasons)
      results.push({ ticket: t, category, riskLevel, reasons, contact, amount, transactAt })
    }

    addFlag('anomaly', anomalyReasons)
    addFlag('missing_docs', missingReasons)
    addFlag('long_pending', pendingReasons)
    addFlag('not_included', notIncludedReasons)
  }

  // 동일 ticket이 여러 카테고리에 걸릴 수 있음(의도적) — 감사 목적
  return results.sort((a, b) => {
    // 고위험 먼저, 같으면 금액 내림차순
    const riskOrder: Record<RiskLevel, number> = { high: 0, medium: 1, low: 2 }
    const rd = riskOrder[a.riskLevel] - riskOrder[b.riskLevel]
    if (rd !== 0) return rd
    return b.amount - a.amount
  })
}

// ─── 카테고리 메타 ──────────────────────────────────────────────────────────

const CATEGORY_META: Record<
  AuditCategory,
  { label: string; icon: React.ReactNode; color: string }
> = {
  anomaly: {
    label: '이상 거래',
    icon: <ShieldExclamationIcon className="h-3.5 w-3.5" />,
    color: 'rose',
  },
  missing_docs: {
    label: '증빙 누락',
    icon: <ExclamationTriangleIcon className="h-3.5 w-3.5" />,
    color: 'amber',
  },
  long_pending: {
    label: '장기 미확인',
    icon: <ClockIcon className="h-3.5 w-3.5" />,
    color: 'primary',
  },
  not_included: {
    label: '미포함 거래',
    icon: <EyeSlashIcon className="h-3.5 w-3.5" />,
    color: 'ink',
  },
}

const TICKET_TYPE_LABEL: Record<string, string> = {
  EXPENSE_TICKET: '카드',
  BANK_TRANSACTION_TICKET: '계좌',
  TAX_INVOICE_TICKET: '세금계산서',
  CASH_RECEIPT_TICKET: '현금영수증',
  WORKFLOW: '결재',
  MANUAL_TRANSACTION_TICKET: '수기',
}

// ─── 메인 페이지 컴포넌트 ───────────────────────────────────────────────────

export default function AuditReportPage() {
  const [from, setFrom] = useState(thisMonthStartISO())
  const [to, setTo] = useState(todayISO())
  const [activeTab, setActiveTab] = useState<AuditCategory | 'all'>('all')
  const [selectedFlag, setSelectedFlag] = useState<FlaggedTicket | null>(null)

  const ready = Boolean(from && to)
  const exceeds31 = ready && daysBetween(from, to) > 31

  // 그랜터 연결 확인
  const healthQuery = useQuery({
    queryKey: ['granter-health'],
    queryFn: () => granterApi.health().then((r) => r.data),
    retry: false,
  })
  const isConfigured = healthQuery.data?.configured

  // 모든 티켓 조회
  const ticketsQuery = useQuery({
    queryKey: ['audit-tickets', from, to],
    queryFn: async () => {
      let actualStart = from
      if (exceeds31) {
        const d = new Date(to)
        d.setDate(d.getDate() - 30)
        actualStart = d.toISOString().slice(0, 10)
      }
      return granterApi.listTicketsAllTypes(actualStart, to).then((r) => r.data)
    },
    enabled: !!isConfigured && ready,
    retry: false,
  })

  const tickets = useMemo(() => normalizeTickets(ticketsQuery.data), [ticketsQuery.data])

  const flagged = useMemo(() => detectFlaggedTickets(tickets), [tickets])

  // 카테고리별 카운트
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: flagged.length, anomaly: 0, missing_docs: 0, long_pending: 0, not_included: 0 }
    for (const f of flagged) c[f.category] = (c[f.category] || 0) + 1
    return c
  }, [flagged])

  // 위험도 합계 금액 (중복 제거: 동일 ticket은 최고 위험도 카테고리 기준 1회만)
  const totalRiskAmount = useMemo(() => {
    const seen = new Set<string>()
    let total = 0
    for (const f of flagged) {
      const key = str(f.ticket, 'id') || `${f.contact}-${f.amount}-${f.transactAt}`
      if (!seen.has(key)) {
        seen.add(key)
        total += f.amount
      }
    }
    return total
  }, [flagged])

  // 탭 필터
  const displayed = useMemo(() => {
    if (activeTab === 'all') return flagged
    return flagged.filter((f) => f.category === activeTab)
  }, [flagged, activeTab])

  const setQuickRange = (days: number) => {
    const end = new Date()
    const start = new Date()
    start.setDate(end.getDate() - days + 1)
    setFrom(start.toISOString().slice(0, 10))
    setTo(end.toISOString().slice(0, 10))
  }

  const isAllClean = !ticketsQuery.isLoading && tickets.length > 0 && flagged.length === 0
  const isLoading = ticketsQuery.isLoading

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
            이상 거래 · 증빙 누락 · 장기 미확인 · 미포함 거래 자동 검출
          </p>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          {/* 빠른 기간 선택 */}
          <div className="flex items-center gap-0.5 p-0.5 rounded-md bg-white border border-ink-200">
            <button
              onClick={() => {
                setFrom(thisMonthStartISO())
                setTo(todayISO())
              }}
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
              onClick={() => setQuickRange(7)}
              className="px-2 py-1 rounded text-2xs font-semibold text-ink-600 hover:bg-ink-50"
            >
              7일
            </button>
          </div>
          {/* 날짜 입력 */}
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
          <button onClick={() => ticketsQuery.refetch()} className="btn-secondary" title="새로고침">
            <ArrowPathIcon className="h-3 w-3" />
          </button>
        </div>
      </div>

      {/* 상태 배너 */}
      {!isConfigured ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 flex items-center gap-2">
          <ExclamationTriangleIcon className="h-4 w-4 text-amber-600 flex-shrink-0" />
          <div className="text-2xs text-amber-800">
            그랜터 API 키가 설정되지 않았습니다. 설정 후 감사 리포트를 이용할 수 있습니다.
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
              31일 초과 — 종료일 기준 최근 31일만 자동 조회
            </div>
          )}
        </div>
      )}

      {/* KPI 카드 */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
        <KpiCard
          label="총 검출 건수"
          value={counts.all}
          unit="건"
          tone={counts.all > 0 ? 'warning' : 'neutral'}
          loading={isLoading}
        />
        <KpiCard
          label="이상 거래"
          value={counts.anomaly}
          unit="건"
          tone={counts.anomaly > 0 ? 'danger' : 'neutral'}
          loading={isLoading}
        />
        <KpiCard
          label="증빙 누락"
          value={counts.missing_docs}
          unit="건"
          tone={counts.missing_docs > 0 ? 'warning' : 'neutral'}
          loading={isLoading}
        />
        <KpiCard
          label="장기 미확인"
          value={counts.long_pending}
          unit="건"
          tone={counts.long_pending > 0 ? 'primary' : 'neutral'}
          loading={isLoading}
        />
        <KpiCard
          label="위험도 합계 금액"
          value={totalRiskAmount}
          unit="원"
          tone={totalRiskAmount > 0 ? 'danger' : 'neutral'}
          loading={isLoading}
        />
      </div>

      {/* 이상 없음 상태 */}
      {isAllClean && (
        <div className="panel p-6 flex flex-col items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-emerald-50 flex items-center justify-center border border-emerald-200">
            <CheckCircleIcon className="h-5 w-5 text-emerald-600" />
          </div>
          <div className="text-center">
            <div className="text-sm font-semibold text-emerald-800">이상 없음</div>
            <div className="text-2xs text-ink-500 mt-1">
              조회 기간 내 {tickets.length.toLocaleString('ko-KR')}건 거래 — 모든 검출 룰을 통과했습니다.
            </div>
            <div className="text-2xs text-emerald-700 mt-0.5 font-medium">
              회계사도 좋아할 결과입니다.
            </div>
          </div>
        </div>
      )}

      {/* 탭 + 테이블 + 디테일 패널 */}
      {(flagged.length > 0 || isLoading) && (
        <div className="grid grid-cols-12 gap-3">
          {/* 좌측: 탭 + 테이블 */}
          <div className={selectedFlag ? 'col-span-7' : 'col-span-12'}>
            <div className="panel overflow-hidden">
              {/* 탭 바 */}
              <div className="px-3 pt-2 pb-0 border-b border-ink-200 flex items-center gap-0 overflow-x-auto">
                {/* 전체 탭 */}
                <button
                  onClick={() => setActiveTab('all')}
                  className={`px-3 py-1.5 text-2xs font-semibold border-b-2 transition -mb-px whitespace-nowrap ${
                    activeTab === 'all'
                      ? 'border-ink-900 text-ink-900'
                      : 'border-transparent text-ink-500 hover:text-ink-700'
                  }`}
                >
                  전체
                  {counts.all > 0 && (
                    <span className="ml-1 badge bg-ink-100 text-ink-700 border-ink-200">
                      {counts.all}
                    </span>
                  )}
                </button>
                {/* 카테고리별 탭 */}
                {(Object.keys(CATEGORY_META) as AuditCategory[]).map((cat) => {
                  const meta = CATEGORY_META[cat]
                  const cnt = counts[cat] || 0
                  const colorMap: Record<string, string> = {
                    rose: 'border-rose-500 text-rose-700',
                    amber: 'border-amber-500 text-amber-700',
                    primary: 'border-primary-500 text-primary-700',
                    ink: 'border-ink-500 text-ink-700',
                  }
                  return (
                    <button
                      key={cat}
                      onClick={() => setActiveTab(cat)}
                      className={`flex items-center gap-1 px-3 py-1.5 text-2xs font-semibold border-b-2 transition -mb-px whitespace-nowrap ${
                        activeTab === cat
                          ? colorMap[meta.color]
                          : 'border-transparent text-ink-500 hover:text-ink-700'
                      }`}
                    >
                      {meta.icon}
                      {meta.label}
                      {cnt > 0 && (
                        <span
                          className={`ml-0.5 badge ${
                            meta.color === 'rose'
                              ? 'bg-rose-50 text-rose-700 border-rose-200'
                              : meta.color === 'amber'
                              ? 'bg-amber-50 text-amber-700 border-amber-200'
                              : meta.color === 'primary'
                              ? 'bg-primary-50 text-primary-700 border-primary-200'
                              : 'bg-ink-50 text-ink-700 border-ink-200'
                          }`}
                        >
                          {cnt}
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>

              {/* 테이블 */}
              <div className="overflow-x-auto max-h-[calc(100vh-28rem)] overflow-y-auto">
                <table className="min-w-full">
                  <thead className="bg-canvas-50 sticky top-0 z-10 border-b border-ink-200">
                    <tr>
                      <th className="px-3 py-1.5 text-left text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                        일시
                      </th>
                      <th className="px-3 py-1.5 text-left text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                        거래처
                      </th>
                      <th className="px-3 py-1.5 text-right text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                        금액
                      </th>
                      <th className="px-3 py-1.5 text-left text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                        유형
                      </th>
                      <th className="px-3 py-1.5 text-left text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                        위험 사유
                      </th>
                      <th className="px-3 py-1.5 text-center text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                        위험도
                      </th>
                      <th className="px-3 py-1.5 text-center text-2xs font-semibold text-ink-500 uppercase tracking-wider w-16">
                        확인
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-100">
                    {isLoading && (
                      <tr>
                        <td colSpan={7} className="text-center py-8 text-2xs text-ink-400">
                          거래 데이터 분석 중…
                        </td>
                      </tr>
                    )}
                    {!isLoading && displayed.length === 0 && flagged.length > 0 && (
                      <tr>
                        <td colSpan={7} className="text-center py-6 text-2xs text-ink-400">
                          이 카테고리에 검출된 건이 없습니다.
                        </td>
                      </tr>
                    )}
                    {displayed.map((f, idx) => {
                      const isSel = selectedFlag === f
                      const ticketType = str(f.ticket, 'ticketType')
                      return (
                        <tr
                          key={`${f.category}-${str(f.ticket, 'id') || idx}`}
                          onClick={() => setSelectedFlag(f)}
                          className={`cursor-pointer ${isSel ? 'bg-ink-50' : 'hover:bg-canvas-50'}`}
                        >
                          {/* 일시 */}
                          <td className="px-3 py-1.5 whitespace-nowrap text-2xs text-ink-700 font-mono">
                            {f.transactAt
                              ? formatDateTime(f.transactAt)
                              : '-'}
                          </td>
                          {/* 거래처 */}
                          <td className="px-3 py-1.5 text-xs text-ink-900">
                            <div className="font-medium truncate max-w-[140px]">{f.contact}</div>
                          </td>
                          {/* 금액 */}
                          <td className="px-3 py-1.5 text-right font-mono tabular-nums text-xs font-semibold text-ink-900">
                            {f.amount > 0 ? formatCurrency(f.amount, false) : '-'}
                          </td>
                          {/* 유형 */}
                          <td className="px-3 py-1.5 whitespace-nowrap">
                            <div className="flex flex-col gap-0.5">
                              <span className="badge bg-ink-50 text-ink-700 border-ink-200">
                                {TICKET_TYPE_LABEL[ticketType] || ticketType?.replace('_TICKET', '') || '-'}
                              </span>
                              <CategoryBadge category={f.category} />
                            </div>
                          </td>
                          {/* 위험 사유 */}
                          <td className="px-3 py-1.5 text-2xs text-ink-700 max-w-[200px]">
                            <div className="space-y-0.5">
                              {f.reasons.map((r, ri) => (
                                <div key={ri} className="truncate" title={r}>
                                  · {r}
                                </div>
                              ))}
                            </div>
                          </td>
                          {/* 위험도 */}
                          <td className="px-3 py-1.5 text-center">
                            <RiskBadge level={f.riskLevel} />
                          </td>
                          {/* 확인 버튼 */}
                          <td className="px-3 py-1.5 text-center">
                            <button
                              onClick={(e) => {
                                e.stopPropagation()
                                // placeholder: 향후 확인 처리 연결
                              }}
                              className="btn-secondary text-2xs px-2 py-0.5"
                              title="확인 처리 (placeholder)"
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
            </div>
          </div>

          {/* 우측 디테일 패널 */}
          {selectedFlag && (
            <div className="col-span-5">
              <div className="panel overflow-hidden h-full flex flex-col">
                {/* 패널 헤더 */}
                <div className="px-3 py-2 border-b border-ink-200 flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <h2 className="text-sm truncate">{selectedFlag.contact}</h2>
                      <RiskBadge level={selectedFlag.riskLevel} />
                      <CategoryBadge category={selectedFlag.category} />
                    </div>
                    <div className="text-2xs text-ink-500 mt-0.5 font-mono">
                      {formatCurrency(selectedFlag.amount, false)}원 ·{' '}
                      {selectedFlag.transactAt ? formatDateTime(selectedFlag.transactAt) : '-'}
                    </div>
                  </div>
                  <button
                    onClick={() => setSelectedFlag(null)}
                    className="text-ink-400 hover:text-ink-700 flex-shrink-0"
                  >
                    <XMarkIcon className="h-4 w-4" />
                  </button>
                </div>

                {/* 위험 사유 */}
                <div className="px-3 py-2 border-b border-ink-100 bg-canvas-50">
                  <div className="text-2xs font-semibold text-ink-600 uppercase tracking-wider mb-1">
                    검출 사유
                  </div>
                  <ul className="space-y-0.5">
                    {selectedFlag.reasons.map((r, i) => (
                      <li key={i} className="text-2xs text-ink-700 flex items-start gap-1">
                        <span className="text-rose-500 mt-0.5">·</span>
                        <span>{r}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                {/* Raw 티켓 데이터 (감사용 전체 표시) */}
                <div className="flex-1 overflow-y-auto p-3 space-y-2">
                  <div className="text-2xs font-semibold text-ink-600 uppercase tracking-wider">
                    티켓 원본 데이터 (감사용)
                  </div>
                  <RawTicketFields ticket={selectedFlag.ticket} />
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* 미조회 상태 (데이터 없음) */}
      {!isLoading && tickets.length === 0 && isConfigured && (
        <div className="panel p-6 text-center">
          <div className="text-2xs text-ink-400">
            조회 기간 내 거래 데이터가 없습니다.
          </div>
          <div className="text-2xs text-ink-400 mt-1">
            기간을 변경하거나 그랜터 자산 연동 상태를 확인하세요.
          </div>
        </div>
      )}

      <div className="text-2xs text-ink-400 px-1">
        ※ 이상 거래 검출 기준: 그랜터 anomalyStatus, 24시간 중복, 평균 5배 이상, 새벽 0~6시.
        증빙 누락: expenseCategory 미분류, 100만원 이상 첨부 없음.
        장기 미확인: status NONE 30일 이상.
      </div>
    </div>
  )
}

// ─── 서브 컴포넌트 ───────────────────────────────────────────────────────────

function KpiCard({
  label,
  value,
  unit,
  tone,
  loading,
}: {
  label: string
  value: number
  unit: string
  tone: 'neutral' | 'danger' | 'warning' | 'primary' | 'emerald'
  loading?: boolean
}) {
  const toneClass: Record<string, string> = {
    neutral: 'text-ink-900',
    danger: 'text-rose-700',
    warning: 'text-amber-700',
    primary: 'text-primary-700',
    emerald: 'text-emerald-700',
  }
  return (
    <div className="panel px-3 py-2">
      <div className="text-2xs font-medium text-ink-500 uppercase tracking-wider truncate">{label}</div>
      <div className={`mt-0.5 font-mono tabular-nums font-bold text-sm ${toneClass[tone]}`}>
        {loading ? (
          <span className="text-ink-300">—</span>
        ) : unit === '원' ? (
          formatCurrency(value, false)
        ) : (
          <>
            {value.toLocaleString('ko-KR')}
            <span className="text-2xs text-ink-400 ml-1 font-medium">{unit}</span>
          </>
        )}
      </div>
    </div>
  )
}

function RiskBadge({ level }: { level: RiskLevel }) {
  if (level === 'high')
    return <span className="badge bg-rose-50 text-rose-700 border-rose-200">고위험</span>
  if (level === 'medium')
    return <span className="badge bg-amber-50 text-amber-700 border-amber-200">중위험</span>
  return <span className="badge bg-primary-50 text-primary-700 border-primary-200">저위험</span>
}

function CategoryBadge({ category }: { category: AuditCategory }) {
  const meta = CATEGORY_META[category]
  const colorMap: Record<string, string> = {
    rose: 'bg-rose-50 text-rose-700 border-rose-200',
    amber: 'bg-amber-50 text-amber-700 border-amber-200',
    primary: 'bg-primary-50 text-primary-700 border-primary-200',
    ink: 'bg-ink-50 text-ink-700 border-ink-200',
  }
  return (
    <span className={`badge ${colorMap[meta.color]}`}>
      {meta.label}
    </span>
  )
}

/** 티켓의 모든 필드를 감사용으로 표시 */
function RawTicketFields({ ticket }: { ticket: any }) {
  const FIELD_GROUPS: Array<{
    label: string
    fields: Array<{ key: string; label: string; fmt?: 'currency' | 'datetime' | 'date' | 'bool' }>
  }> = [
    {
      label: '기본 정보',
      fields: [
        { key: 'id', label: 'ID' },
        { key: 'ticketType', label: '티켓 유형' },
        { key: 'transactionType', label: '거래 유형' },
        { key: 'status', label: '상태' },
        { key: 'anomalyStatus', label: '이상 상태' },
        { key: 'isIncluded', label: '회계 포함', fmt: 'bool' },
        { key: 'transactAt', label: '거래 일시', fmt: 'datetime' },
        { key: 'createdAt', label: '생성일시', fmt: 'datetime' },
      ],
    },
    {
      label: '금액·분류',
      fields: [
        { key: 'amount', label: '금액', fmt: 'currency' },
        { key: 'attachmentCount', label: '첨부 수' },
        { key: 'messageCount', label: '메시지 수' },
        { key: 'contact', label: '거래처(직접)' },
      ],
    },
  ]

  const renderValue = (val: any, fmt?: string): React.ReactNode => {
    if (val === null || val === undefined || val === '') return <span className="text-ink-300">-</span>
    if (fmt === 'currency') return formatCurrency(Number(val), false)
    if (fmt === 'datetime') return formatDateTime(String(val))
    if (fmt === 'date') return formatDate(String(val))
    if (fmt === 'bool') return (
      <span className={val ? 'text-emerald-700' : 'text-rose-700'}>
        {val ? '포함' : '미포함'}
      </span>
    )
    if (typeof val === 'boolean') return val ? 'true' : 'false'
    return String(val)
  }

  // expenseCategory 객체 처리
  const cat = ticket?.expenseCategory
  const catStr = cat
    ? (cat?.name ? `${cat.name} (${cat?.code || ''})` : JSON.stringify(cat))
    : null

  // bankTransaction, cardUsage, taxInvoice, cashReceipt 서브 객체
  const subObjects: Array<{ label: string; obj: any }> = [
    { label: 'bankTransaction', obj: ticket?.bankTransaction },
    { label: 'cardUsage', obj: ticket?.cardUsage },
    { label: 'taxInvoice', obj: ticket?.taxInvoice },
    { label: 'cashReceipt', obj: ticket?.cashReceipt },
  ].filter((s) => s.obj && typeof s.obj === 'object')

  return (
    <div className="space-y-3">
      {FIELD_GROUPS.map((group) => (
        <div key={group.label}>
          <div className="text-2xs text-ink-400 uppercase tracking-wider font-semibold mb-1">
            {group.label}
          </div>
          <div className="rounded border border-ink-100 divide-y divide-ink-100">
            {group.fields.map(({ key, label, fmt }) => {
              const val = ticket?.[key]
              return (
                <div key={key} className="flex items-start px-2 py-1 gap-2">
                  <span className="text-2xs text-ink-400 w-28 flex-shrink-0 font-mono">{label}</span>
                  <span className="text-2xs text-ink-800 break-all">{renderValue(val, fmt)}</span>
                </div>
              )
            })}
            {/* expenseCategory 별도 */}
            {group.label === '금액·분류' && (
              <div className="flex items-start px-2 py-1 gap-2">
                <span className="text-2xs text-ink-400 w-28 flex-shrink-0 font-mono">계정과목</span>
                <span className="text-2xs text-ink-800 break-all">
                  {catStr ?? <span className="text-rose-500 font-medium">미분류</span>}
                </span>
              </div>
            )}
          </div>
        </div>
      ))}

      {/* 서브 오브젝트 */}
      {subObjects.map(({ label, obj }) => (
        <div key={label}>
          <div className="text-2xs text-ink-400 uppercase tracking-wider font-semibold mb-1">
            {label}
          </div>
          <div className="rounded border border-ink-100 divide-y divide-ink-100">
            {Object.entries(obj).map(([k, v]) => {
              if (v === null || v === undefined) return null
              const isObj = typeof v === 'object' && !Array.isArray(v)
              return (
                <div key={k} className="flex items-start px-2 py-1 gap-2">
                  <span className="text-2xs text-ink-400 w-28 flex-shrink-0 font-mono truncate" title={k}>
                    {k}
                  </span>
                  <span className="text-2xs text-ink-800 break-all">
                    {isObj ? (
                      <span className="text-ink-400 font-mono">
                        {JSON.stringify(v, null, 0).slice(0, 120)}
                        {JSON.stringify(v).length > 120 ? '…' : ''}
                      </span>
                    ) : (
                      String(v)
                    )}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}
