import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  ShieldExclamationIcon,
  ExclamationTriangleIcon,
  ArrowPathIcon,
  XMarkIcon,
  CheckCircleIcon,
  CheckIcon,
} from '@heroicons/react/24/outline'
import PeriodPicker, { periodForPreset, type PeriodPreset } from '@/components/common/PeriodPicker'
import { granterApi } from '@/services/api'
import { formatCurrency, formatDateTime, isoLocal } from '@/utils/format'

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

/** 거래처명 추출 — SettlementPage 패턴 그대로 */
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
    str(t, 'content', 'merchantName', 'counterpartyName', 'vendor') ||
    '(미지정)'
  )
}

/** API 응답 정규화 — 객체면 values 펼치기 */
function normalizeTickets(data: any): any[] {
  if (!data) return []
  if (Array.isArray(data)) return data
  if (typeof data === 'object') {
    const all: any[] = []
    for (const v of Object.values(data)) {
      if (Array.isArray(v)) all.push(...(v as any[]))
    }
    return all
  }
  return []
}

// ─── Issue 타입 ───────────────────────────────────────────────────────────────

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

interface Issue {
  ticketId: number
  ticket: any
  ruleKey: RuleKey
  ruleLabel: string
  severity: Severity
  amount: number
  contact: string
  date: string
  message: string
}

// ─── 탭 메타 ─────────────────────────────────────────────────────────────────

type TabKey = 'all' | RuleKey

interface TabMeta {
  label: string
  ruleKey?: RuleKey
  severityColor: string // Tailwind border color for active tab
  badgeClass: string
}

const TAB_META: TabMeta[] = [
  { label: '전체',    severityColor: 'border-ink-900 text-ink-900',       badgeClass: 'bg-ink-100 text-ink-700 border-ink-200' },
  { label: '이상거래',  ruleKey: 'anomaly',        severityColor: 'border-rose-500 text-rose-700',   badgeClass: 'bg-rose-50 text-rose-700 border-rose-200' },
  { label: '큰 금액',  ruleKey: 'large',           severityColor: 'border-rose-500 text-rose-700',   badgeClass: 'bg-rose-50 text-rose-700 border-rose-200' },
  { label: '새벽',    ruleKey: 'night',            severityColor: 'border-amber-500 text-amber-700', badgeClass: 'bg-amber-50 text-amber-700 border-amber-200' },
  { label: '미분류',  ruleKey: 'no_category',      severityColor: 'border-amber-500 text-amber-700', badgeClass: 'bg-amber-50 text-amber-700 border-amber-200' },
  { label: '증빙없음', ruleKey: 'no_attachment',   severityColor: 'border-amber-500 text-amber-700', badgeClass: 'bg-amber-50 text-amber-700 border-amber-200' },
  { label: '미확인',  ruleKey: 'long_pending',     severityColor: 'border-primary-500 text-primary-700', badgeClass: 'bg-primary-50 text-primary-700 border-primary-200' },
  { label: '미포함',  ruleKey: 'not_included',     severityColor: 'border-ink-500 text-ink-700',     badgeClass: 'bg-ink-50 text-ink-700 border-ink-200' },
  { label: '중복',    ruleKey: 'duplicate',        severityColor: 'border-rose-500 text-rose-700',   badgeClass: 'bg-rose-50 text-rose-700 border-rose-200' },
]

// ─── 검출 함수 (단일 순회 + O(n) duplicate) ──────────────────────────────────

/**
 * 8가지 룰을 단일 순회로 검출한다.
 * duplicate만 사전 그룹핑(Map)으로 O(n) 처리.
 * console.time으로 성능 측정.
 */
function detectIssues(tickets: any[]): Issue[] {
  if (!tickets.length) return []

  console.time('[audit] detectIssues')

  const issues: Issue[] = []
  const now = Date.now()

  // 평균 금액 (0 제외)
  let amountSum = 0
  let amountCount = 0
  for (const t of tickets) {
    const a = Number(t.amount || 0)
    if (a > 0) { amountSum += a; amountCount++ }
  }
  const avgAmount = amountCount > 0 ? amountSum / amountCount : 0

  // rule 8 사전 처리: 거래처+금액 키 → 타임스탬프 배열 (O(n))
  // duplicate 여부는 후속 순회에서 이 맵을 조회
  const dupMap = new Map<string, number[]>()
  for (const t of tickets) {
    const contact = extractContact(t)
    const amount = Number(t.amount || 0)
    if (!amount || contact === '(미지정)') continue
    const ts = new Date(t.transactAt || t.transactionDate || '').getTime()
    if (!ts) continue
    const key = `${contact}||${amount}`
    const arr = dupMap.get(key)
    if (arr) arr.push(ts)
    else dupMap.set(key, [ts])
  }
  // 각 그룹에서 24시간 내 다중 건이 있는지 빠른 확인용 Set
  const dupTicketSet = new Set<any>()
  for (const t of tickets) {
    const contact = extractContact(t)
    const amount = Number(t.amount || 0)
    if (!amount || contact === '(미지정)') continue
    const ts = new Date(t.transactAt || t.transactionDate || '').getTime()
    if (!ts) continue
    const key = `${contact}||${amount}`
    const arr = dupMap.get(key)
    if (!arr || arr.length < 2) continue
    // 현재 티켓 ts 기준 24h 내 다른 건이 존재하는지
    const hasPair = arr.some((other) => other !== ts && Math.abs(ts - other) <= 86400000)
    if (hasPair) dupTicketSet.add(t)
  }

  // 단일 순회 — rule 1~7
  for (const t of tickets) {
    const ticketId = Number(t.id || 0)
    const contact = extractContact(t)
    const amount = Number(t.amount || 0)
    const date = String(t.transactAt || t.transactionDate || t.createdAt || '')

    const push = (ruleKey: RuleKey, ruleLabel: string, severity: Severity, message: string) => {
      issues.push({ ticketId, ticket: t, ruleKey, ruleLabel, severity, amount, contact, date, message })
    }

    // rule 1: anomalyStatus
    if (t.anomalyStatus === 'ANOMALY') {
      push('anomaly', '이상거래', 'high', '그랜터 이상 거래 자동 표시')
    }

    // rule 2: 큰 금액 (avg × 5)
    if (avgAmount > 0 && amount > avgAmount * 5) {
      push('large', '큰 금액', amount >= 5_000_000 ? 'high' : 'medium',
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
      push('not_included', '미포함', amount >= 1_000_000 ? 'medium' : 'low', '회계 미포함 처리 (isIncluded: false)')
    }

    // rule 8: duplicate (사전 Set 조회)
    if (dupTicketSet.has(t)) {
      push('duplicate', '중복', 'high',
        `24시간 내 동일 거래처·금액 중복 (${contact}, ${formatCurrency(amount, false)}원)`)
    }
  }

  // 위험도 내림차순 → 금액 내림차순
  const sev: Record<Severity, number> = { high: 0, medium: 1, low: 2 }
  issues.sort((a, b) => sev[a.severity] - sev[b.severity] || b.amount - a.amount)

  console.timeEnd('[audit] detectIssues')
  return issues
}

// ─── 메인 컴포넌트 ────────────────────────────────────────────────────────────

export default function AuditReportPage() {
  const initPeriod = periodForPreset('this_month')
  const [preset, setPreset]   = useState<PeriodPreset>('this_month')
  const [from,   setFrom]     = useState(initPeriod.start)
  const [to,     setTo]       = useState(initPeriod.end)
  const [activeTab, setActiveTab] = useState<TabKey>('all')
  const [selected, setSelected]   = useState<Issue | null>(null)

  const ready      = Boolean(from && to)
  const exceeds31  = ready && daysBetween(from, to) > 31

  // 그랜터 연결 확인
  const healthQuery = useQuery({
    queryKey: ['granter-health'],
    queryFn: () => granterApi.health().then((r) => r.data),
    retry: false,
  })
  const isConfigured = healthQuery.data?.configured

  // 단일 31일 호출 (chunked 절대 금지)
  const ticketsQuery = useQuery({
    queryKey: ['audit', from, to],
    queryFn: () => {
      let actualStart = from
      if (exceeds31) {
        const d = new Date(to); d.setDate(d.getDate() - 30)
        actualStart = isoLocal(d)
      }
      console.time('[audit] listTicketsAllTypes')
      return granterApi.listTicketsAllTypes(actualStart, to).then((r) => {
        console.timeEnd('[audit] listTicketsAllTypes')
        return r.data
      })
    },
    enabled: ready && !!isConfigured,
    retry: false,
  })

  // 동기 계산 — useMemo 없이 렌더 시 직접 계산 (1500건 미만이면 충분히 빠름)
  const tickets = normalizeTickets(ticketsQuery.data)
  const issues  = ticketsQuery.isSuccess ? detectIssues(tickets) : []

  // KPI
  const totalCount  = issues.length
  const highCount   = issues.filter((i) => i.severity === 'high').length
  const mediumCount = issues.filter((i) => i.severity === 'medium').length
  const lowCount    = issues.filter((i) => i.severity === 'low').length
  const riskAmount  = (() => {
    const seen = new Set<number>()
    let sum = 0
    for (const i of issues) {
      if (!seen.has(i.ticketId)) { seen.add(i.ticketId); sum += i.amount }
    }
    return sum
  })()

  // 탭별 카운트
  const tabCounts: Record<string, number> = { all: totalCount }
  for (const i of issues) {
    tabCounts[i.ruleKey] = (tabCounts[i.ruleKey] || 0) + 1
  }

  // 표시 목록
  const displayed = activeTab === 'all' ? issues : issues.filter((i) => i.ruleKey === activeTab)

  const isLoading  = ticketsQuery.isLoading
  const isAllClean = ticketsQuery.isSuccess && tickets.length > 0 && issues.length === 0

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
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <PeriodPicker
            preset={preset}
            from={from}
            to={to}
            onChange={(p, f, t) => { setPreset(p); setFrom(f); setTo(t) }}
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
      {!isConfigured ? (
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
          {exceeds31 && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-1 text-2xs text-amber-800">
              31일 초과 — 종료일 기준 최근 31일만 조회
            </div>
          )}
        </div>
      )}

      {/* KPI 카드 */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
        <KpiCard label="총 검출"      value={totalCount}  unit="건" tone="warning" loading={isLoading} />
        <KpiCard label="고위험"       value={highCount}   unit="건" tone="danger"  loading={isLoading} />
        <KpiCard label="중위험"       value={mediumCount} unit="건" tone="warning" loading={isLoading} />
        <KpiCard label="저위험"       value={lowCount}    unit="건" tone="primary" loading={isLoading} />
        <KpiCard label="위험도 합계"  value={riskAmount}  unit="원" tone="danger"  loading={isLoading} />
      </div>

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
            <div className="text-2xs text-emerald-700 mt-0.5 font-medium">
              회계사도 좋아할 결과입니다.
            </div>
          </div>
        </div>
      )}

      {/* 탭 + 테이블 + 디테일 패널 */}
      {(issues.length > 0 || isLoading) && (
        <div className="grid grid-cols-12 gap-3">
          {/* 좌측 */}
          <div className={selected ? 'col-span-7' : 'col-span-12'}>
            <div className="panel overflow-hidden">
              {/* 탭 바 */}
              <div className="px-3 pt-2 pb-0 border-b border-ink-200 flex items-center gap-0 overflow-x-auto">
                {TAB_META.map((tab) => {
                  const key: TabKey = tab.ruleKey ?? 'all'
                  const cnt = tabCounts[key] || 0
                  const isActive = activeTab === key
                  return (
                    <button
                      key={key}
                      onClick={() => setActiveTab(key)}
                      className={`px-3 py-1.5 text-2xs font-semibold border-b-2 transition -mb-px whitespace-nowrap ${
                        isActive ? tab.severityColor : 'border-transparent text-ink-500 hover:text-ink-700'
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
              <div className="overflow-x-auto max-h-[calc(100vh-30rem)] overflow-y-auto">
                <table className="min-w-full">
                  <thead className="bg-canvas-50 sticky top-0 z-10 border-b border-ink-200">
                    <tr>
                      {['일시', '거래처', '금액', '룰', '위험도', '사유', '확인'].map((h, i) => (
                        <th
                          key={h}
                          className={`px-3 py-1.5 text-2xs font-semibold text-ink-500 uppercase tracking-wider ${
                            i === 2 ? 'text-right' : i === 4 || i === 6 ? 'text-center' : 'text-left'
                          }`}
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-100">
                    {isLoading && (
                      <tr>
                        <td colSpan={7} className="text-center py-8 text-2xs text-ink-400">
                          데이터 불러오는 중…
                        </td>
                      </tr>
                    )}
                    {!isLoading && displayed.length === 0 && issues.length > 0 && (
                      <tr>
                        <td colSpan={7} className="text-center py-6 text-2xs text-ink-400">
                          이 탭에 검출된 건이 없습니다.
                        </td>
                      </tr>
                    )}
                    {displayed.map((issue, idx) => {
                      const isSel = selected === issue
                      return (
                        <tr
                          key={`${issue.ruleKey}-${issue.ticketId || idx}`}
                          onClick={() => setSelected(issue)}
                          className={`cursor-pointer ${isSel ? 'bg-ink-50' : 'hover:bg-canvas-50'}`}
                        >
                          {/* 일시 */}
                          <td className="px-3 py-1.5 whitespace-nowrap text-2xs text-ink-700 font-mono">
                            {issue.date ? formatDateTime(issue.date) : '-'}
                          </td>
                          {/* 거래처 */}
                          <td className="px-3 py-1.5 text-xs text-ink-900">
                            <div className="font-medium truncate max-w-[140px]">{issue.contact}</div>
                          </td>
                          {/* 금액 */}
                          <td className="px-3 py-1.5 text-right font-mono tabular-nums text-xs font-semibold text-ink-900">
                            {issue.amount > 0 ? formatCurrency(issue.amount, false) : '-'}
                          </td>
                          {/* 룰 */}
                          <td className="px-3 py-1.5 whitespace-nowrap">
                            <RuleBadge ruleKey={issue.ruleKey} label={issue.ruleLabel} />
                          </td>
                          {/* 위험도 */}
                          <td className="px-3 py-1.5 text-center">
                            <SeverityBadge severity={issue.severity} />
                          </td>
                          {/* 사유 */}
                          <td className="px-3 py-1.5 text-2xs text-ink-700 max-w-[200px]">
                            <div className="truncate" title={issue.message}>
                              {issue.message}
                            </div>
                          </td>
                          {/* 확인 버튼 */}
                          <td className="px-3 py-1.5 text-center">
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
            </div>
          </div>

          {/* 우측 디테일 패널 */}
          {selected && (
            <div className="col-span-5">
              <div className="panel overflow-hidden h-full flex flex-col">
                <div className="px-3 py-2 border-b border-ink-200 flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <h2 className="text-sm truncate">{selected.contact}</h2>
                      <SeverityBadge severity={selected.severity} />
                      <RuleBadge ruleKey={selected.ruleKey} label={selected.ruleLabel} />
                    </div>
                    <div className="text-2xs text-ink-500 mt-0.5 font-mono">
                      {formatCurrency(selected.amount, false)}원
                      {selected.date ? ` · ${formatDateTime(selected.date)}` : ''}
                    </div>
                  </div>
                  <button
                    onClick={() => setSelected(null)}
                    className="text-ink-400 hover:text-ink-700 flex-shrink-0"
                  >
                    <XMarkIcon className="h-4 w-4" />
                  </button>
                </div>

                {/* 검출 사유 */}
                <div className="px-3 py-2 border-b border-ink-100 bg-canvas-50">
                  <div className="text-2xs font-semibold text-ink-600 uppercase tracking-wider mb-1">
                    검출 사유
                  </div>
                  <div className="text-2xs text-ink-700 flex items-start gap-1">
                    <span className="text-rose-500">·</span>
                    <span>{selected.message}</span>
                  </div>
                </div>

                {/* Raw JSON */}
                <div className="flex-1 overflow-y-auto p-3">
                  <div className="text-2xs font-semibold text-ink-600 uppercase tracking-wider mb-2">
                    티켓 원본 (감사용)
                  </div>
                  <RawTicket ticket={selected.ticket} />
                </div>
              </div>
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
        ※ 검출 룰: anomalyStatus ANOMALY / 평균 5배 이상 / 새벽 0~6시 / 계정과목 미분류 / 100만원+ 첨부 없음 / NONE 30일+ / isIncluded false / 24시간 중복
      </div>
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
      <div className="text-2xs font-medium text-ink-500 uppercase tracking-wider truncate">{label}</div>
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

function RuleBadge({ ruleKey, label }: { ruleKey: RuleKey; label: string }) {
  return <span className={`badge ${RULE_COLOR[ruleKey]}`}>{label}</span>
}

/** Raw ticket JSON — 주요 필드 우선, 나머지 JSON.stringify */
function RawTicket({ ticket }: { ticket: any }) {
  const TOP_KEYS = [
    'id', 'ticketType', 'transactionType', 'status', 'anomalyStatus',
    'isIncluded', 'transactAt', 'createdAt', 'amount', 'attachmentCount', 'messageCount',
  ]

  const fmtVal = (k: string, v: any): string => {
    if (v === null || v === undefined) return '-'
    if ((k === 'amount') && typeof v !== 'object') return `${formatCurrency(Number(v), false)}원`
    if ((k.endsWith('At') || k.endsWith('Date')) && typeof v === 'string') {
      try { return formatDateTime(v) } catch { return v }
    }
    if (typeof v === 'boolean') return v ? 'true' : 'false'
    if (typeof v === 'object') return JSON.stringify(v, null, 0).slice(0, 150)
    return String(v)
  }

  const topEntries = TOP_KEYS.map((k) => [k, ticket?.[k]] as [string, any]).filter(([, v]) => v !== undefined)
  const catStr = (() => {
    const c = ticket?.expenseCategory
    if (!c) return null
    return c?.name ? `${c.name} (${c?.code || ''})` : JSON.stringify(c)
  })()

  const subObjects = ['bankTransaction', 'cardUsage', 'taxInvoice', 'cashReceipt']
    .map((k) => ({ key: k, val: ticket?.[k] }))
    .filter(({ val }) => val && typeof val === 'object')

  const Row = ({ k, v }: { k: string; v: any }) => (
    <div className="flex items-start px-2 py-1 gap-2 border-b border-ink-100 last:border-0">
      <span className="text-2xs text-ink-400 w-28 flex-shrink-0 font-mono truncate" title={k}>{k}</span>
      <span className="text-2xs text-ink-800 break-all">{fmtVal(k, v)}</span>
    </div>
  )

  return (
    <div className="space-y-3">
      <div className="rounded border border-ink-100">
        {topEntries.map(([k, v]) => <Row key={k} k={k} v={v} />)}
        <div className="flex items-start px-2 py-1 gap-2 border-b border-ink-100 last:border-0">
          <span className="text-2xs text-ink-400 w-28 flex-shrink-0 font-mono">expenseCategory</span>
          <span className={`text-2xs break-all ${catStr ? 'text-ink-800' : 'text-rose-500 font-medium'}`}>
            {catStr ?? '미분류'}
          </span>
        </div>
      </div>

      {subObjects.map(({ key, val }) => (
        <div key={key}>
          <div className="text-2xs text-ink-400 uppercase tracking-wider font-semibold mb-1">{key}</div>
          <div className="rounded border border-ink-100">
            {Object.entries(val).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => (
              <Row key={k} k={k} v={v} />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
