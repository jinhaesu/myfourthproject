import { useEffect, useMemo, useState } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import {
  ArrowPathIcon,
  ChartBarIcon,
  ExclamationTriangleIcon,
  CheckCircleIcon,
  ClockIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline'
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
  Legend,
} from 'recharts'
import { granterApi } from '@/services/api'
import { formatCurrency, formatCompactWon, formatPct } from '@/utils/format'
import PeriodPicker, { periodForPreset, type PeriodPreset } from '@/components/common/PeriodPicker'

// ─── 채널 분류 상수 ───────────────────────────────────────────────────────────
export const CHANNEL_RULES: { key: string; label: string; keywords: string[]; color: string }[] = [
  { key: 'coupang',     label: '쿠팡',        keywords: ['쿠팡', 'coupang'],                        color: '#FF6B35' },
  { key: 'naver',       label: '스마트스토어', keywords: ['스마트스토어', '네이버', 'NAVER'],        color: '#03C75A' },
  { key: 'emart',       label: '이마트',       keywords: ['이마트', 'EMART'],                        color: '#FFD600' },
  { key: 'lotte',       label: '롯데마트',     keywords: ['롯데마트', '롯데'],                       color: '#E60012' },
  { key: 'homeplus',    label: '홈플러스',     keywords: ['홈플러스', 'HOMEPLUS'],                   color: '#E2231A' },
  { key: 'cu',          label: 'CU',           keywords: ['CU', '비지에프', 'BGF'],                  color: '#7B2CBF' },
  { key: 'gs25',        label: 'GS25',         keywords: ['GS25', 'GS리테일'],                       color: '#0064FF' },
  { key: 'sevenelevn',  label: '세븐일레븐',   keywords: ['세븐일레븐', 'SEVEN'],                    color: '#FF7900' },
  { key: 'delivery',    label: '배달앱',       keywords: ['쿠팡이츠', '배달의민족', '요기요'],       color: '#FF3D00' },
  { key: 'others',      label: '기타',         keywords: [],                                          color: '#71717a' },
]

// ─── 헬퍼 함수 ───────────────────────────────────────────────────────────────
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

/** SettlementPage 패턴과 동일한 거래처 추출 */
function extractContact(t: any): string {
  if (t?.taxInvoice) {
    const ti = t.taxInvoice
    if (str(t, 'transactionType') === 'IN')
      return str(ti?.contractor, 'companyName') || str(ti?.supplier, 'companyName') || '(미지정)'
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

function classifyChannel(contactName: string): string {
  const name = contactName
  for (const rule of CHANNEL_RULES) {
    if (rule.keywords.some((kw) => name.includes(kw))) return rule.key
  }
  return 'others'
}

function channelMeta(key: string) {
  return CHANNEL_RULES.find((r) => r.key === key) ?? CHANNEL_RULES[CHANNEL_RULES.length - 1]
}

function daysBetween(a: string, b: string) {
  return Math.floor((new Date(b).getTime() - new Date(a).getTime()) / 86400000) + 1
}

// ─── 타입 ─────────────────────────────────────────────────────────────────────
type AnalysisTab = 'bank' | 'tax'

interface ChannelRow {
  key: string
  label: string
  color: string
  // 매출
  revenue: number
  revenueCount: number
  revenueTickets: any[]
  // 비용
  directCost: number      // 채널 키워드 직접 매칭 비용
  allocatedCost: number   // 매출 점유율 안분 비용
  totalCost: number
  margin: number
  marginPct: number
  // 차트용 일별 데이터
  dailySales: { date: string; revenue: number; cost: number }[]
  // 직접 비용 티켓
  directCostTickets: any[]
}

// ─── 메인 컴포넌트 ────────────────────────────────────────────────────────────
export default function ChannelProfitabilityPage() {
  const [tab, setTab] = useState<AnalysisTab>('bank')
  const [preset, setPreset] = useState<PeriodPreset>('this_month')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [selectedKey, setSelectedKey] = useState<string | null>(null)

  // 초기 기간 설정
  useEffect(() => {
    const r = periodForPreset('this_month')
    setFrom(r.start)
    setTo(r.end)
  }, [])

  const ready = Boolean(from && to)
  const exceeds31 = ready && daysBetween(from, to) > 31

  // 31일 초과 시 종료일 기준 최근 31일
  const actualFrom = useMemo(() => {
    if (!exceeds31) return from
    const d = new Date(to)
    d.setDate(d.getDate() - 30)
    return d.toISOString().slice(0, 10)
  }, [from, to, exceeds31])

  // ─── 그랜터 설정 확인 ──────────────────────────────────────────────────────
  const healthQuery = useQuery({
    queryKey: ['granter-health'],
    queryFn: () => granterApi.health().then((r) => r.data),
    retry: false,
  })
  const isConfigured = healthQuery.data?.configured

  // ─── 티켓 조회 (단일 호출, chunked 절대 사용 금지) ────────────────────────
  const dataQuery = useQuery({
    queryKey: ['channel-profitability', actualFrom, to],
    queryFn: async () => {
      const [bankRes, taxRes, expenseRes] = await Promise.all([
        granterApi.listTickets({ ticketType: 'BANK_TRANSACTION_TICKET', startDate: actualFrom, endDate: to }),
        granterApi.listTickets({ ticketType: 'TAX_INVOICE_TICKET',      startDate: actualFrom, endDate: to }),
        granterApi.listTickets({ ticketType: 'EXPENSE_TICKET',          startDate: actualFrom, endDate: to }),
      ])
      const bank    = Array.isArray(bankRes.data)    ? bankRes.data    : bankRes.data?.data    || []
      const tax     = Array.isArray(taxRes.data)     ? taxRes.data     : taxRes.data?.data     || []
      const expense = Array.isArray(expenseRes.data) ? expenseRes.data : expenseRes.data?.data || []
      return { bank, tax, expense }
    },
    enabled: !!isConfigured && ready,
    retry: false,
  })

  // ─── 최근 거래 탐색 ─────────────────────────────────────────────────────────
  const findRecentMut = useMutation({
    mutationFn: async () => {
      const today = new Date()
      for (let offset = 0; offset < 24; offset++) {
        const end = new Date(today)
        end.setDate(end.getDate() - offset * 31)
        const start = new Date(end)
        start.setDate(start.getDate() - 31)
        const startStr = start.toISOString().slice(0, 10)
        const endStr   = end.toISOString().slice(0, 10)
        try {
          const [bankR, taxR] = await Promise.all([
            granterApi.listTickets({ ticketType: 'BANK_TRANSACTION_TICKET', startDate: startStr, endDate: endStr }),
            granterApi.listTickets({ ticketType: 'TAX_INVOICE_TICKET',      startDate: startStr, endDate: endStr }),
          ])
          const bankItems = Array.isArray(bankR.data) ? bankR.data : bankR.data?.data || []
          const taxItems  = Array.isArray(taxR.data)  ? taxR.data  : taxR.data?.data  || []
          const inCount =
            bankItems.filter((t: any) => str(t, 'transactionType') === 'IN').length +
            taxItems.filter((t: any) => str(t, 'transactionType') === 'IN').length
          if (inCount > 0) return { start: startStr, end: endStr, count: inCount, monthsBack: offset }
        } catch { /* 무시 */ }
      }
      return { start: null, end: null, count: 0, monthsBack: 0 }
    },
    onSuccess: (res) => {
      if (res.start && res.end) {
        setPreset('custom')
        setFrom(res.start)
        setTo(res.end)
        toast.success(
          `${res.monthsBack === 0 ? '이번달' : `${res.monthsBack}개월 전`} 구간 (매출 ${res.count}건)`
        )
      } else {
        toast.error('최근 24개월 내 매출 거래가 없습니다.')
      }
    },
  })

  // ─── 채널별 수익성 집계 ───────────────────────────────────────────────────
  const channels: ChannelRow[] = useMemo(() => {
    const { bank = [], tax = [], expense = [] } = dataQuery.data || {}

    // 분석 탭에 따라 매출 티켓 선택
    let salesTickets: any[]
    if (tab === 'bank') {
      salesTickets = bank.filter((t: any) => str(t, 'transactionType') === 'IN')
    } else {
      salesTickets = tax.filter((t: any) => str(t, 'transactionType') === 'IN')
    }

    // 비용 티켓: EXPENSE_TICKET(카드) + BANK_TRANSACTION_TICKET OUT(출금)
    const costTickets: any[] = [
      ...expense,
      ...bank.filter((t: any) => str(t, 'transactionType') === 'OUT'),
    ]

    // 총 매출 (안분 계산용)
    const totalRevenue = salesTickets.reduce((s: number, t: any) => s + num(t, 'amount'), 0)

    // 채널별 매출 집계
    const revenueMap: Record<string, { tickets: any[]; dailyMap: Record<string, number> }> = {}
    for (const t of salesTickets) {
      const contact = extractContact(t)
      const key = classifyChannel(contact)
      if (!revenueMap[key]) revenueMap[key] = { tickets: [], dailyMap: {} }
      revenueMap[key].tickets.push(t)
      const date = str(t, 'transactAt', 'date').slice(0, 10) || 'unknown'
      revenueMap[key].dailyMap[date] = (revenueMap[key].dailyMap[date] || 0) + num(t, 'amount')
    }

    // 채널별 직접 비용 + 공통 비용 분리
    const directCostMap: Record<string, { tickets: any[]; total: number }> = {}
    let commonCostTotal = 0

    for (const t of costTickets) {
      const contact = extractContact(t)
      const key = classifyChannel(contact)
      if (key !== 'others') {
        // 채널 키워드 매칭 — 해당 채널에 직접 귀속
        if (!directCostMap[key]) directCostMap[key] = { tickets: [], total: 0 }
        directCostMap[key].tickets.push(t)
        directCostMap[key].total += num(t, 'amount')
      } else {
        // 공통 비용
        commonCostTotal += num(t, 'amount')
      }
    }

    // 채널 리스트 빌드
    const result: ChannelRow[] = Object.entries(revenueMap).map(([key, { tickets, dailyMap }]) => {
      const meta = channelMeta(key)
      const revenue = tickets.reduce((s: number, t: any) => s + num(t, 'amount'), 0)
      const sharePct = totalRevenue > 0 ? revenue / totalRevenue : 0

      const directInfo = directCostMap[key] ?? { tickets: [], total: 0 }
      const directCost = directInfo.total
      const allocatedCost = Math.round(commonCostTotal * sharePct)
      const totalCost = directCost + allocatedCost
      const margin = revenue - totalCost
      const marginPct = revenue > 0 ? (margin / revenue) * 100 : 0

      // 일별 차트 데이터 (매출)
      const dailySales = Object.entries(dailyMap)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, rev]) => ({ date: date.slice(5), revenue: rev, cost: 0 }))

      return {
        key,
        label: meta.label,
        color: meta.color,
        revenue,
        revenueCount: tickets.length,
        revenueTickets: tickets,
        directCost,
        allocatedCost,
        totalCost,
        margin,
        marginPct,
        dailySales,
        directCostTickets: directInfo.tickets,
      }
    })

    return result.sort((a, b) => b.revenue - a.revenue)
  }, [dataQuery.data, tab])

  // ─── 요약 KPI ────────────────────────────────────────────────────────────────
  const summary = useMemo(() => {
    const totalRevenue  = channels.reduce((s, c) => s + c.revenue, 0)
    const totalCost     = channels.reduce((s, c) => s + c.totalCost, 0)
    const totalMargin   = totalRevenue - totalCost
    const avgMarginPct  = totalRevenue > 0 ? (totalMargin / totalRevenue) * 100 : 0
    const topChannel    = channels[0] ?? null
    return { totalRevenue, totalCost, totalMargin, avgMarginPct, topChannel }
  }, [channels])

  const selected = useMemo(
    () => channels.find((c) => c.key === selectedKey) ?? null,
    [channels, selectedKey]
  )

  const isLoading = dataQuery.isLoading

  return (
    <div className="space-y-3">
      {/* ── 헤더 ── */}
      <div className="flex items-end justify-between flex-wrap gap-2">
        <div>
          <h1 className="flex items-center gap-2">
            <ChartBarIcon className="h-4 w-4 text-ink-500" />
            채널별 수익성 분석
          </h1>
          <p className="text-2xs text-ink-500 mt-0.5">
            채널별 매출 - 직접비용 - 안분비용 = 마진 분석
          </p>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <PeriodPicker
            preset={preset}
            from={from}
            to={to}
            onChange={(p, f, t) => { setPreset(p); setFrom(f); setTo(t) }}
          />
          <button
            onClick={() => findRecentMut.mutate()}
            disabled={findRecentMut.isPending}
            className="btn-secondary"
          >
            <ClockIcon className="h-3 w-3 mr-1" />
            {findRecentMut.isPending ? '탐색 중...' : '최근 거래 한 달'}
          </button>
          <button onClick={() => dataQuery.refetch()} disabled={isLoading} className="btn-secondary">
            <ArrowPathIcon className={`h-3 w-3 ${isLoading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* ── 상태 배너 ── */}
      {!isConfigured ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 flex items-center gap-2">
          <ExclamationTriangleIcon className="h-4 w-4 text-amber-600" />
          <span className="text-2xs text-amber-800">
            그랜터 API 키 미설정 — 설정에서 그랜터 연동을 먼저 완료하세요.
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
              31일 초과 — 종료일 기준 최근 31일 ({actualFrom} ~ {to}) 자동 조회
            </div>
          )}
        </div>
      )}

      {/* ── 분석 기준 탭 ── */}
      <div className="flex items-center gap-0.5 p-0.5 rounded-lg bg-white border border-ink-200 w-fit">
        <button
          onClick={() => { setTab('bank'); setSelectedKey(null) }}
          className={`px-3 py-1.5 rounded text-xs font-semibold transition ${
            tab === 'bank' ? 'bg-ink-900 text-white' : 'text-ink-600 hover:bg-ink-50'
          }`}
        >
          현금 기준 (입금)
        </button>
        <button
          onClick={() => { setTab('tax'); setSelectedKey(null) }}
          className={`px-3 py-1.5 rounded text-xs font-semibold transition ${
            tab === 'tax' ? 'bg-ink-900 text-white' : 'text-ink-600 hover:bg-ink-50'
          }`}
        >
          세금계산서 기준
        </button>
      </div>

      {/* ── KPI 카드 ── */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
        <div className="panel px-3 py-2">
          <div className="text-2xs font-medium text-ink-500 uppercase tracking-wider">총 매출</div>
          <div className="mt-0.5 font-mono tabular-nums font-bold text-base text-emerald-700">
            {formatCompactWon(summary.totalRevenue)}
          </div>
          <div className="text-2xs text-ink-400">{formatCurrency(summary.totalRevenue, false)}원</div>
        </div>
        <div className="panel px-3 py-2">
          <div className="text-2xs font-medium text-ink-500 uppercase tracking-wider">총 비용</div>
          <div className="mt-0.5 font-mono tabular-nums font-bold text-base text-rose-700">
            {formatCompactWon(summary.totalCost)}
          </div>
          <div className="text-2xs text-ink-400">{formatCurrency(summary.totalCost, false)}원</div>
        </div>
        <div className="panel px-3 py-2">
          <div className="text-2xs font-medium text-ink-500 uppercase tracking-wider">마진</div>
          <div className={`mt-0.5 font-mono tabular-nums font-bold text-base ${summary.totalMargin >= 0 ? 'text-primary-700' : 'text-rose-700'}`}>
            {formatCompactWon(summary.totalMargin)}
          </div>
          <div className="text-2xs text-ink-400">{formatCurrency(summary.totalMargin, false)}원</div>
        </div>
        <div className="panel px-3 py-2">
          <div className="text-2xs font-medium text-ink-500 uppercase tracking-wider">평균 마진율</div>
          <div className={`mt-0.5 font-mono tabular-nums font-bold text-base ${summary.avgMarginPct >= 0 ? 'text-primary-700' : 'text-rose-700'}`}>
            {formatPct(summary.avgMarginPct)}
          </div>
        </div>
        <div className="panel px-3 py-2">
          <div className="text-2xs font-medium text-ink-500 uppercase tracking-wider">1위 채널</div>
          <div className="mt-0.5 font-bold text-sm text-amber-700 truncate">
            {summary.topChannel?.label ?? '-'}
          </div>
          <div className="text-2xs text-ink-400">
            {summary.topChannel ? formatCompactWon(summary.topChannel.revenue) : '-'}
          </div>
        </div>
      </div>

      {/* ── 2-pane: 채널 리스트 + 상세 ── */}
      <div className="grid grid-cols-12 gap-3">
        {/* 좌측: 채널 리스트 */}
        <div className={selected ? 'col-span-5' : 'col-span-12'}>
          <div className="panel overflow-hidden">
            <div className="px-3 py-2 border-b border-ink-200">
              <span className="text-2xs font-semibold text-ink-600 uppercase tracking-wider">
                채널별 수익성 순위
              </span>
            </div>
            <div className="overflow-y-auto max-h-[calc(100vh-28rem)]">
              {isLoading && (
                <div className="text-center py-8 text-2xs text-ink-400">불러오는 중…</div>
              )}
              {!isLoading && channels.length === 0 && (
                <div className="text-center py-10 text-2xs text-ink-400">
                  <div>이 기간에 매출 거래가 없습니다.</div>
                  <div className="mt-3">
                    <button
                      onClick={() => findRecentMut.mutate()}
                      disabled={findRecentMut.isPending}
                      className="text-primary-700 hover:underline font-semibold"
                    >
                      최근 거래 한 달 자동 탐색
                    </button>
                  </div>
                </div>
              )}
              {channels.map((ch, idx) => {
                const isSel = selectedKey === ch.key
                const marginColor = ch.marginPct >= 20
                  ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                  : ch.marginPct >= 0
                  ? 'bg-amber-50 text-amber-700 border-amber-200'
                  : 'bg-rose-50 text-rose-700 border-rose-200'
                return (
                  <div
                    key={ch.key}
                    onClick={() => setSelectedKey(isSel ? null : ch.key)}
                    className={`px-3 py-2.5 border-b border-ink-100 cursor-pointer ${
                      isSel ? 'bg-ink-50' : 'hover:bg-canvas-50'
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <span className="text-2xs font-mono text-ink-400 w-4 shrink-0">{idx + 1}</span>
                      <span className="h-2 w-2 rounded-full shrink-0" style={{ background: ch.color }} />
                      <div className="flex-1 min-w-0">
                        <div className={`text-xs font-semibold ${isSel ? 'text-ink-900' : 'text-ink-800'}`}>
                          {ch.label}
                        </div>
                        <div className="text-2xs text-ink-500">{ch.revenueCount}건</div>
                      </div>
                      {/* 마진율 배지 */}
                      <span className={`badge text-2xs shrink-0 ${marginColor}`}>
                        {formatPct(ch.marginPct)}
                      </span>
                      <div className="text-right shrink-0">
                        <div className="font-mono tabular-nums text-xs font-semibold text-ink-900">
                          {formatCompactWon(ch.revenue)}
                        </div>
                        <div className={`text-2xs font-mono ${ch.margin >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                          {ch.margin >= 0 ? '+' : ''}{formatCompactWon(ch.margin)}
                        </div>
                      </div>
                      {!selected && (
                        <div className="w-16 shrink-0">
                          <div className="h-1.5 rounded-full bg-ink-100 overflow-hidden">
                            <div
                              className="h-full rounded-full"
                              style={{
                                width: `${channels[0] ? Math.min((ch.revenue / channels[0].revenue) * 100, 100) : 0}%`,
                                background: ch.color,
                              }}
                            />
                          </div>
                        </div>
                      )}
                    </div>
                    {/* 비용 미니 바 */}
                    {ch.totalCost > 0 && (
                      <div className="mt-1.5 ml-7 flex items-center gap-1.5 text-2xs text-ink-400">
                        <span>비용 {formatCompactWon(ch.totalCost)}</span>
                        <span className="text-ink-200">|</span>
                        <span>직접 {formatCompactWon(ch.directCost)}</span>
                        <span className="text-ink-200">+</span>
                        <span>안분 {formatCompactWon(ch.allocatedCost)}</span>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        </div>

        {/* 우측: 선택 채널 상세 */}
        {selected && (
          <div className="col-span-7">
            <div className="panel overflow-hidden h-full flex flex-col">
              {/* 상세 헤더 */}
              <div className="px-3 py-2 border-b border-ink-200 flex items-center justify-between">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ background: selected.color }} />
                  <div className="min-w-0">
                    <span className="text-sm font-semibold text-ink-900">{selected.label}</span>
                    <span className="text-2xs text-ink-500 ml-2">
                      {selected.revenueCount}건 · 마진율 {formatPct(selected.marginPct)}
                    </span>
                  </div>
                </div>
                <button onClick={() => setSelectedKey(null)} className="text-ink-400 hover:text-ink-700">
                  <XMarkIcon className="h-4 w-4" />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto p-3 space-y-4">
                {/* KPI 소계 */}
                <div className="grid grid-cols-3 gap-2">
                  <div className="panel px-2.5 py-2 text-center">
                    <div className="text-2xs text-ink-500">매출</div>
                    <div className="font-mono font-bold text-sm text-emerald-700 mt-0.5">
                      {formatCompactWon(selected.revenue)}
                    </div>
                  </div>
                  <div className="panel px-2.5 py-2 text-center">
                    <div className="text-2xs text-ink-500">총 비용</div>
                    <div className="font-mono font-bold text-sm text-rose-700 mt-0.5">
                      {formatCompactWon(selected.totalCost)}
                    </div>
                    <div className="text-2xs text-ink-400">
                      직접 {formatCompactWon(selected.directCost)} + 안분 {formatCompactWon(selected.allocatedCost)}
                    </div>
                  </div>
                  <div className="panel px-2.5 py-2 text-center">
                    <div className="text-2xs text-ink-500">마진</div>
                    <div className={`font-mono font-bold text-sm mt-0.5 ${selected.margin >= 0 ? 'text-primary-700' : 'text-rose-700'}`}>
                      {formatCompactWon(selected.margin)}
                    </div>
                    <div className="text-2xs text-ink-400">{formatPct(selected.marginPct)}</div>
                  </div>
                </div>

                {/* 매출 + 비용 추이 차트 */}
                {selected.dailySales.length > 0 && (
                  <div>
                    <div className="text-2xs font-semibold text-ink-600 uppercase tracking-wider mb-2">
                      일별 매출 추이
                    </div>
                    <div className="h-40">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={selected.dailySales} margin={{ top: 2, right: 4, bottom: 2, left: 0 }}>
                          <XAxis
                            dataKey="date"
                            tick={{ fontSize: 9, fill: '#9ca3af' }}
                            tickLine={false}
                            axisLine={false}
                            interval="preserveStartEnd"
                          />
                          <YAxis hide />
                          <Tooltip
                            formatter={(v: number, name: string) => [
                              formatCurrency(v, false) + '원',
                              name === 'revenue' ? '매출' : '비용',
                            ]}
                            labelStyle={{ fontSize: 10 }}
                            contentStyle={{ fontSize: 10, padding: '4px 8px' }}
                          />
                          <Legend
                            iconSize={8}
                            wrapperStyle={{ fontSize: 9 }}
                            formatter={(value) => (value === 'revenue' ? '매출' : '비용')}
                          />
                          <Bar dataKey="revenue" radius={[2, 2, 0, 0]}>
                            {selected.dailySales.map((_, i) => (
                              <Cell key={i} fill={selected.color} fillOpacity={0.85} />
                            ))}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                )}

                {/* 매출 거래 테이블 */}
                <TxTable
                  title={`매출 거래 (${selected.revenueTickets.length}건)`}
                  tickets={selected.revenueTickets}
                  color={selected.color}
                  amountColor="text-emerald-700"
                />

                {/* 직접 비용 거래 테이블 */}
                {selected.directCostTickets.length > 0 && (
                  <TxTable
                    title={`직접 비용 (${selected.directCostTickets.length}건)`}
                    tickets={selected.directCostTickets}
                    color="#e11d48"
                    amountColor="text-rose-700"
                  />
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── 전체 채널 비교 차트 (상세 패널 닫힌 경우) ── */}
      {!selected && channels.length > 0 && (
        <div className="panel p-3">
          <div className="text-2xs font-semibold text-ink-600 uppercase tracking-wider mb-2">
            채널별 매출 vs 마진 비교
          </div>
          <div className="h-44">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={channels.map((c) => ({ label: c.label, revenue: c.revenue, margin: Math.max(c.margin, 0), color: c.color }))}
                margin={{ top: 2, right: 4, bottom: 2, left: 0 }}
              >
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 9, fill: '#9ca3af' }}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis hide />
                <Tooltip
                  formatter={(v: number, name: string) => [
                    formatCurrency(v, false) + '원',
                    name === 'revenue' ? '매출' : '마진',
                  ]}
                  labelStyle={{ fontSize: 10 }}
                  contentStyle={{ fontSize: 10, padding: '4px 8px' }}
                />
                <Legend
                  iconSize={8}
                  wrapperStyle={{ fontSize: 9 }}
                  formatter={(value) => (value === 'revenue' ? '매출' : '마진')}
                />
                <Bar dataKey="revenue" radius={[3, 3, 0, 0]} fill="#d1d5db" opacity={0.6}>
                  {channels.map((c, i) => (
                    <Cell key={i} fill={c.color} fillOpacity={0.4} />
                  ))}
                </Bar>
                <Bar dataKey="margin" radius={[3, 3, 0, 0]}>
                  {channels.map((c, i) => (
                    <Cell key={i} fill={c.color} fillOpacity={0.9} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      <div className="text-2xs text-ink-400 px-1">
        ※ 채널 분류는 거래처명 키워드 매칭 기준. 직접비용 = 채널 키워드 포함 출금·카드. 안분비용 = 공통 비용 × 매출 점유율.
        {tab === 'bank' ? ' 현금 기준: 통장 입금(BANK_TRANSACTION_TICKET IN).' : ' 세금계산서 기준: TAX_INVOICE_TICKET IN.'}
      </div>
    </div>
  )
}

// ─── 거래 테이블 서브컴포넌트 ─────────────────────────────────────────────────
function TxTable({
  title,
  tickets,
  color,
  amountColor,
}: {
  title: string
  tickets: any[]
  color: string
  amountColor: string
}) {
  const sorted = useMemo(
    () =>
      [...tickets].sort((a, b) =>
        str(b, 'transactAt', 'date').localeCompare(str(a, 'transactAt', 'date'))
      ),
    [tickets]
  )

  return (
    <div>
      <div className="text-2xs font-semibold text-ink-600 uppercase tracking-wider mb-1.5">
        {title}
      </div>
      <div className="space-y-1">
        {sorted.map((t, idx) => {
          const contact = extractContact(t)
          const date    = str(t, 'transactAt', 'date').slice(0, 10)
          const desc    = str(t, 'content', 'description')
          const type    = t.taxInvoice ? '세금계산서' : t.cardUsage ? '카드' : '통장'
          return (
            <div
              key={t.id || idx}
              className="flex items-start justify-between text-2xs border border-ink-100 bg-canvas-50 rounded p-1.5 gap-2"
            >
              <div className="min-w-0 flex-1 space-y-0.5">
                <div className="flex items-center gap-1.5">
                  <span className="font-mono text-ink-500">{date}</span>
                  <span
                    className="badge text-2xs"
                    style={{
                      background: `${color}15`,
                      color: color,
                      borderColor: `${color}40`,
                    }}
                  >
                    {type}
                  </span>
                </div>
                <div className="text-ink-700 font-medium truncate">{contact}</div>
                {desc && <div className="text-ink-400 truncate">{desc}</div>}
              </div>
              <div className={`font-mono font-semibold shrink-0 pt-0.5 ${amountColor}`}>
                {formatCurrency(num(t, 'amount'), false)}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
