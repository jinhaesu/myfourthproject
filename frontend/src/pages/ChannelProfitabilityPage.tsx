import { useEffect, useMemo, useRef, useState } from 'react'
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
import { buildOwnAccountSet, filterOutInternalTransfers, isSelfContact } from '@/utils/internalTransfer'
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
  Legend,
  PieChart,
  Pie,
  Sector,
} from 'recharts'
import type { PieSectorDataItem } from 'recharts/types/polar/Pie'
import { granterApi } from '@/services/api'
import { formatCurrency, formatCompactWon, formatPct, isoLocal } from '@/utils/format'
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
function num(obj: unknown, ...keys: string[]): number {
  for (const k of keys) {
    const v = (obj as Record<string, unknown>)?.[k]
    if (v !== undefined && v !== null && v !== '') return Number(v) || 0
  }
  return 0
}
function str(obj: unknown, ...keys: string[]): string {
  for (const k of keys) {
    const v = (obj as Record<string, unknown>)?.[k]
    if (v !== undefined && v !== null && v !== '') return String(v)
  }
  return ''
}

/** SettlementPage 패턴과 동일한 거래처 추출 */
function extractContact(t: unknown): string {
  const tx = t as Record<string, unknown>
  if (tx?.taxInvoice) {
    const ti = tx.taxInvoice as Record<string, unknown>
    if (str(t, 'transactionType') === 'IN')
      return str(ti?.contractor, 'companyName') || str(ti?.supplier, 'companyName') || '(미지정)'
    return str(ti?.supplier, 'companyName') || str(ti?.contractor, 'companyName') || '(미지정)'
  }
  if (tx?.cashReceipt) {
    const cr = tx.cashReceipt as Record<string, unknown>
    return str(cr?.issuer, 'companyName') || str(cr?.issuer, 'userName') || '(미지정)'
  }
  return (
    str(t, 'contact') ||
    str((tx?.bankTransaction as Record<string, unknown>), 'counterparty') ||
    str((tx?.cardUsage as Record<string, unknown>), 'storeName') ||
    str((tx?.bankTransaction as Record<string, unknown>), 'content') ||
    str(t, 'content', 'merchantName', 'counterpartyName', 'vendor') ||
    '(미지정)'
  )
}

function classifyChannel(contactName: string): string {
  for (const rule of CHANNEL_RULES) {
    if (rule.keywords.some((kw) => contactName.includes(kw))) return rule.key
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
  revenue: number
  revenueCount: number
  revenueTickets: unknown[]
  directCost: number
  allocatedCost: number
  totalCost: number
  margin: number
  marginPct: number
  dailySales: { date: string; revenue: number }[]
  directCostTickets: unknown[]
}

interface ContactRow {
  name: string
  count: number
  revenue: number
  avgPrice: number
  sharePct: number
}

// ─── Recharts 커스텀 ActiveShape ──────────────────────────────────────────────
function renderActiveShape(props: PieSectorDataItem) {
  const {
    cx = 0, cy = 0,
    innerRadius = 0, outerRadius = 0,
    startAngle = 0, endAngle = 0,
    fill = '#ccc',
    payload,
    percent = 0,
  } = props
  const RADIAN = Math.PI / 180
  const midAngle = (startAngle + endAngle) / 2
  const sin = Math.sin(-RADIAN * midAngle)
  const cos = Math.cos(-RADIAN * midAngle)
  const mx = cx + (outerRadius + 16) * cos
  const my = cy + (outerRadius + 16) * sin
  const ex = mx + (cos >= 0 ? 1 : -1) * 10
  const ey = my
  const anchor = cos >= 0 ? 'start' : 'end'
  const name = (payload as { label?: string; name?: string })?.label ?? (payload as { name?: string })?.name ?? ''
  const value = (payload as { revenue?: number })?.revenue ?? 0

  return (
    <g>
      <Sector
        cx={cx} cy={cy}
        innerRadius={innerRadius} outerRadius={outerRadius + 4}
        startAngle={startAngle} endAngle={endAngle}
        fill={fill}
      />
      <path d={`M${mx},${my}L${ex},${ey}`} stroke={fill} fill="none" strokeWidth={1.5} />
      <circle cx={ex} cy={ey} r={2} fill={fill} />
      <text x={ex + (cos >= 0 ? 4 : -4)} y={ey} textAnchor={anchor} fill="#374151" fontSize={9} fontWeight={600}>
        {name}
      </text>
      <text x={ex + (cos >= 0 ? 4 : -4)} y={ey + 12} textAnchor={anchor} fill="#6b7280" fontSize={8}>
        {formatCompactWon(value)} ({(percent * 100).toFixed(1)}%)
      </text>
    </g>
  )
}

// ─── 메인 컴포넌트 ────────────────────────────────────────────────────────────
export default function ChannelProfitabilityPage() {
  const [tab, setTab] = useState<AnalysisTab>('bank')
  // default를 last_30d로 변경
  const [preset, setPreset] = useState<PeriodPreset>('last_30d')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [pieActiveIdx, setPieActiveIdx] = useState(0)
  const [detailPieActiveIdx, setDetailPieActiveIdx] = useState(0)
  // 빈 결과 자동 탐색 가드
  const autoSearchFired = useRef(false)

  // 초기 기간 설정 (last_30d)
  useEffect(() => {
    const r = periodForPreset('last_30d')
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
    return isoLocal(d)
  }, [from, to, exceeds31])

  // ─── 그랜터 설정 확인 ──────────────────────────────────────────────────────
  const healthQuery = useQuery({
    queryKey: ['granter-health'],
    queryFn: () => granterApi.health().then((r) => r.data),
    retry: false,
  })
  const isConfigured = healthQuery.data?.configured

  // ─── 본인 계좌 세트 (법인 계좌 간 이체 필터용) ────────────────────────────
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

  // ─── 티켓 조회 (단일 호출, chunked 절대 사용 금지) ────────────────────────
  const dataQuery = useQuery({
    queryKey: ['channel-profitability', actualFrom, to],
    queryFn: async () => {
      // 그랜터 동시 호출 시 간헐 401 회피 — 순차 호출
      const bankRes = await granterApi.listTickets({ ticketType: 'BANK_TRANSACTION_TICKET', startDate: actualFrom, endDate: to })
      const taxRes = await granterApi.listTickets({ ticketType: 'TAX_INVOICE_TICKET', startDate: actualFrom, endDate: to })
      const expenseRes = await granterApi.listTickets({ ticketType: 'EXPENSE_TICKET', startDate: actualFrom, endDate: to })
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
        const startStr = isoLocal(start)
        const endStr   = isoLocal(end)
        try {
          const bankR = await granterApi.listTickets({ ticketType: 'BANK_TRANSACTION_TICKET', startDate: startStr, endDate: endStr })
          const taxR = await granterApi.listTickets({ ticketType: 'TAX_INVOICE_TICKET', startDate: startStr, endDate: endStr })
          const bankItems = Array.isArray(bankR.data) ? bankR.data : bankR.data?.data || []
          const taxItems  = Array.isArray(taxR.data)  ? taxR.data  : taxR.data?.data  || []
          const inCount =
            bankItems.filter((t: unknown) => str(t, 'transactionType') === 'IN').length +
            taxItems.filter((t: unknown) => str(t, 'transactionType') === 'IN').length
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

  // ─── 빈 결과 자동 탐색 (한 번만) ────────────────────────────────────────────
  useEffect(() => {
    if (
      !dataQuery.isLoading &&
      dataQuery.isFetched &&
      !autoSearchFired.current &&
      isConfigured
    ) {
      const { bank = [], tax = [], expense: _exp = [] } = dataQuery.data || {}
      const inCount =
        (bank as unknown[]).filter((t) => str(t, 'transactionType') === 'IN').length +
        (tax as unknown[]).filter((t) => str(t, 'transactionType') === 'IN').length
      if (inCount === 0) {
        autoSearchFired.current = true
        findRecentMut.mutate()
      }
    }
  }, [dataQuery.isLoading, dataQuery.isFetched, dataQuery.data, isConfigured, findRecentMut])

  // ─── 법인 계좌 간 이체 제외 카운트 ─────────────────────────────────────────
  const internalFilteredCount = useMemo(() => {
    const rawBank = (dataQuery.data?.bank as unknown[]) || []
    const filtered = filterOutInternalTransfers(rawBank, ownAccounts)
    return rawBank.length - filtered.length
  }, [dataQuery.data, ownAccounts])

  // ─── 채널별 수익성 집계 ───────────────────────────────────────────────────
  const channels: ChannelRow[] = useMemo(() => {
    const { bank: rawBank = [], tax = [], expense = [] } = dataQuery.data || {}

    // 법인 계좌 간 이체 제외 (bank 티켓만 필터 대상)
    const bank = filterOutInternalTransfers(rawBank as unknown[], ownAccounts)

    let salesTickets: unknown[]
    if (tab === 'bank') {
      salesTickets = (bank as unknown[]).filter((t) => str(t, 'transactionType') === 'IN')
    } else {
      salesTickets = (tax as unknown[]).filter((t) => str(t, 'transactionType') === 'IN')
    }

    const costTickets: unknown[] = [
      ...(expense as unknown[]),
      ...(bank as unknown[]).filter((t) => str(t, 'transactionType') === 'OUT'),
    ]

    const totalRevenue = salesTickets.reduce((s: number, t) => s + num(t, 'amount'), 0)

    const revenueMap: Record<string, { tickets: unknown[]; dailyMap: Record<string, number> }> = {}
    for (const t of salesTickets) {
      const contact = extractContact(t)
      // 본인 회사(조인앤조인) 매출 제외
      if (isSelfContact(contact)) continue
      const key = classifyChannel(contact)
      if (!revenueMap[key]) revenueMap[key] = { tickets: [], dailyMap: {} }
      revenueMap[key].tickets.push(t)
      const date = str(t, 'transactAt', 'date').slice(0, 10) || 'unknown'
      revenueMap[key].dailyMap[date] = (revenueMap[key].dailyMap[date] || 0) + num(t, 'amount')
    }

    const directCostMap: Record<string, { tickets: unknown[]; total: number }> = {}
    let commonCostTotal = 0

    for (const t of costTickets) {
      const contact = extractContact(t)
      if (isSelfContact(contact)) continue
      const key = classifyChannel(contact)
      if (key !== 'others') {
        if (!directCostMap[key]) directCostMap[key] = { tickets: [], total: 0 }
        directCostMap[key].tickets.push(t)
        directCostMap[key].total += num(t, 'amount')
      } else {
        commonCostTotal += num(t, 'amount')
      }
    }

    const result: ChannelRow[] = Object.entries(revenueMap).map(([key, { tickets, dailyMap }]) => {
      const meta = channelMeta(key)
      const revenue = tickets.reduce((s: number, t) => s + num(t, 'amount'), 0)
      const sharePct = totalRevenue > 0 ? revenue / totalRevenue : 0

      const directInfo = directCostMap[key] ?? { tickets: [], total: 0 }
      const directCost = directInfo.total
      const allocatedCost = Math.round(commonCostTotal * sharePct)
      const totalCost = directCost + allocatedCost
      const margin = revenue - totalCost
      const marginPct = revenue > 0 ? (margin / revenue) * 100 : 0

      const dailySales = Object.entries(dailyMap)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, rev]) => ({ date: date.slice(5), revenue: rev }))

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

  // ─── 일별 stacked BarChart 데이터 ────────────────────────────────────────────
  const dailyStackedData = useMemo(() => {
    // 최대 6개 채널 + 기타
    const topChannels = channels.slice(0, 6)
    const otherChannels = channels.slice(6)

    const dateSet = new Set<string>()
    for (const ch of channels) {
      for (const d of ch.dailySales) dateSet.add(d.date)
    }
    const dates = Array.from(dateSet).sort()

    return dates.map((date) => {
      const row: Record<string, string | number> = { date }
      for (const ch of topChannels) {
        const found = ch.dailySales.find((d) => d.date === date)
        row[ch.label] = found ? found.revenue : 0
      }
      if (otherChannels.length > 0) {
        row['기타'] = otherChannels.reduce((s, ch) => {
          const found = ch.dailySales.find((d) => d.date === date)
          return s + (found ? found.revenue : 0)
        }, 0)
      }
      return row
    })
  }, [channels])

  // ─── PieChart 데이터 ─────────────────────────────────────────────────────────
  const pieData = useMemo(() =>
    channels.map((c) => ({ label: c.label, name: c.label, revenue: c.revenue, fill: c.color })),
    [channels]
  )

  // ─── 거래처별 매출 표 (상위 20) ──────────────────────────────────────────────
  const contactRows: ContactRow[] = useMemo(() => {
    const { bank: rawBank = [], tax = [], expense: _exp = [] } = dataQuery.data || {}
    // 법인 계좌 간 이체 제외
    const bank = filterOutInternalTransfers(rawBank as unknown[], ownAccounts)
    let salesTickets: unknown[]
    if (tab === 'bank') {
      salesTickets = (bank as unknown[]).filter((t) => str(t, 'transactionType') === 'IN')
    } else {
      salesTickets = (tax as unknown[]).filter((t) => str(t, 'transactionType') === 'IN')
    }
    const totalRevenue = salesTickets.reduce((s: number, t) => s + num(t, 'amount'), 0)

    const map: Record<string, { count: number; revenue: number }> = {}
    for (const t of salesTickets) {
      const rawName = extractContact(t)
      const name = rawName || '(미지정)'  // 빈 contact도 '(미지정)'으로 집계
      // 본인 회사(조인앤조인)만 정확 매칭 시 제외
      if (isSelfContact(name)) continue
      if (!map[name]) map[name] = { count: 0, revenue: 0 }
      map[name].count += 1
      map[name].revenue += num(t, 'amount')
    }
    return Object.entries(map)
      .map(([name, { count, revenue }]) => ({
        name,
        count,
        revenue,
        avgPrice: count > 0 ? Math.round(revenue / count) : 0,
        sharePct: totalRevenue > 0 ? (revenue / totalRevenue) * 100 : 0,
      }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 50)
  }, [dataQuery.data, tab])

  // ─── 선택 채널 거래 종류별 PieChart 데이터 ───────────────────────────────────
  const detailTypePieData = useMemo(() => {
    if (!selected) return []
    const counts: Record<string, number> = {
      '세금계산서': 0,
      '통장입금': 0,
      '카드·지출': 0,
    }
    for (const t of selected.revenueTickets) {
      const tx = t as Record<string, unknown>
      if (tx.taxInvoice) counts['세금계산서']++
      else if (tx.bankTransaction) counts['통장입금']++
      else counts['카드·지출']++
    }
    const colors = ['#6366f1', '#10b981', '#f59e0b']
    return Object.entries(counts)
      .filter(([, v]) => v > 0)
      .map(([name, value], i) => ({ name, value, fill: colors[i % colors.length] }))
  }, [selected])

  const isLoading = dataQuery.isLoading

  // 일별 차트에 표시할 채널 목록 (최대 6개 + '기타')
  const stackedChannelKeys = useMemo(() => {
    const keys = channels.slice(0, 6).map((c) => ({ label: c.label, color: c.color }))
    if (channels.length > 6) keys.push({ label: '기타', color: '#71717a' })
    return keys
  }, [channels])

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
          {internalFilteredCount > 0 && (
            <span className="text-2xs text-ink-400">
              · 법인 계좌 간 이체 {internalFilteredCount}건 제외됨
            </span>
          )}
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

      {/* ── 시각화 섹션 (채널 선택 없을 때) ── */}
      {!selected && channels.length > 0 && (
        <div className="space-y-3">
          {/* A + C: 채널별 비교 BarChart + PieChart */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {/* A. 채널별 매출/마진 비교 BarChart */}
            <div className="panel p-3">
              <div className="text-2xs font-semibold text-ink-600 uppercase tracking-wider mb-2">
                채널별 매출 vs 마진
              </div>
              <div className="h-48">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={channels.map((c) => ({
                      label: c.label,
                      revenue: c.revenue,
                      margin: Math.max(c.margin, 0),
                      marginPct: c.marginPct,
                      color: c.color,
                    }))}
                    margin={{ top: 4, right: 8, bottom: 2, left: 0 }}
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
                    <Bar dataKey="revenue" radius={[3, 3, 0, 0]} name="revenue">
                      {channels.map((c, i) => (
                        <Cell key={i} fill={c.color} fillOpacity={0.4} />
                      ))}
                    </Bar>
                    <Bar dataKey="margin" radius={[3, 3, 0, 0]} name="margin">
                      {channels.map((c, i) => (
                        <Cell key={i} fill={c.color} fillOpacity={0.9} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
              {/* 마진율 라벨 */}
              <div className="mt-1 flex flex-wrap gap-1.5">
                {channels.map((c) => (
                  <span
                    key={c.key}
                    className="text-2xs px-1.5 py-0.5 rounded-full font-mono"
                    style={{ background: `${c.color}18`, color: c.color }}
                  >
                    {c.label} {formatPct(c.marginPct)}
                  </span>
                ))}
              </div>
            </div>

            {/* C. 채널 매출 점유율 도넛 PieChart */}
            <div className="panel p-3">
              <div className="text-2xs font-semibold text-ink-600 uppercase tracking-wider mb-2">
                채널 매출 점유율
              </div>
              <div className="h-48">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      activeIndex={pieActiveIdx}
                      activeShape={renderActiveShape}
                      data={pieData}
                      cx="50%"
                      cy="50%"
                      innerRadius={48}
                      outerRadius={68}
                      dataKey="revenue"
                      onMouseEnter={(_, index) => setPieActiveIdx(index)}
                    >
                      {pieData.map((entry, i) => (
                        <Cell key={i} fill={entry.fill} />
                      ))}
                    </Pie>
                  </PieChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>

          {/* B. 일별 매출 추이 stacked BarChart */}
          {dailyStackedData.length > 0 && (
            <div className="panel p-3">
              <div className="text-2xs font-semibold text-ink-600 uppercase tracking-wider mb-2">
                일별 채널 매출 추이 (기간: {actualFrom} ~ {to})
              </div>
              <div className="h-48">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={dailyStackedData} margin={{ top: 4, right: 4, bottom: 2, left: 0 }}>
                    <XAxis
                      dataKey="date"
                      tick={{ fontSize: 8, fill: '#9ca3af' }}
                      tickLine={false}
                      axisLine={false}
                      interval="preserveStartEnd"
                    />
                    <YAxis hide />
                    <Tooltip
                      formatter={(v: number) => [formatCurrency(v, false) + '원']}
                      labelStyle={{ fontSize: 10 }}
                      contentStyle={{ fontSize: 10, padding: '4px 8px' }}
                    />
                    <Legend iconSize={8} wrapperStyle={{ fontSize: 9 }} />
                    {stackedChannelKeys.map((ch) => (
                      <Bar
                        key={ch.label}
                        dataKey={ch.label}
                        stackId="daily"
                        fill={ch.color}
                        radius={stackedChannelKeys[stackedChannelKeys.length - 1].label === ch.label ? [2, 2, 0, 0] : [0, 0, 0, 0]}
                      />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}
        </div>
      )}

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
                {/* KPI 소계 (5개) */}
                <div className="grid grid-cols-5 gap-1.5">
                  <div className="panel px-2 py-2 text-center">
                    <div className="text-2xs text-ink-500">매출</div>
                    <div className="font-mono font-bold text-xs text-emerald-700 mt-0.5">
                      {formatCompactWon(selected.revenue)}
                    </div>
                  </div>
                  <div className="panel px-2 py-2 text-center">
                    <div className="text-2xs text-ink-500">직접비용</div>
                    <div className="font-mono font-bold text-xs text-rose-700 mt-0.5">
                      {formatCompactWon(selected.directCost)}
                    </div>
                  </div>
                  <div className="panel px-2 py-2 text-center">
                    <div className="text-2xs text-ink-500">안분비용</div>
                    <div className="font-mono font-bold text-xs text-rose-600 mt-0.5">
                      {formatCompactWon(selected.allocatedCost)}
                    </div>
                  </div>
                  <div className="panel px-2 py-2 text-center">
                    <div className="text-2xs text-ink-500">마진</div>
                    <div className={`font-mono font-bold text-xs mt-0.5 ${selected.margin >= 0 ? 'text-primary-700' : 'text-rose-700'}`}>
                      {formatCompactWon(selected.margin)}
                    </div>
                  </div>
                  <div className="panel px-2 py-2 text-center">
                    <div className="text-2xs text-ink-500">마진율</div>
                    <div className={`font-mono font-bold text-xs mt-0.5 ${selected.marginPct >= 0 ? 'text-primary-700' : 'text-rose-700'}`}>
                      {formatPct(selected.marginPct)}
                    </div>
                  </div>
                </div>

                {/* 일별 매출 추이 BarChart */}
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
                            formatter={(v: number) => [formatCurrency(v, false) + '원', '매출']}
                            labelStyle={{ fontSize: 10 }}
                            contentStyle={{ fontSize: 10, padding: '4px 8px' }}
                          />
                          <Bar dataKey="revenue" radius={[2, 2, 0, 0]} name="매출">
                            {selected.dailySales.map((_, i) => (
                              <Cell key={i} fill={selected.color} fillOpacity={0.85} />
                            ))}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                )}

                {/* 거래 종류별 분포 PieChart */}
                {detailTypePieData.length > 0 && (
                  <div>
                    <div className="text-2xs font-semibold text-ink-600 uppercase tracking-wider mb-2">
                      거래 종류별 분포
                    </div>
                    <div className="h-32">
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie
                            activeIndex={detailPieActiveIdx}
                            activeShape={renderActiveShape}
                            data={detailTypePieData}
                            cx="50%"
                            cy="50%"
                            innerRadius={36}
                            outerRadius={52}
                            dataKey="value"
                            onMouseEnter={(_, index) => setDetailPieActiveIdx(index)}
                          >
                            {detailTypePieData.map((entry, i) => (
                              <Cell key={i} fill={entry.fill} />
                            ))}
                          </Pie>
                          <Tooltip
                            formatter={(v: number) => [`${v}건`]}
                            contentStyle={{ fontSize: 10, padding: '4px 8px' }}
                          />
                        </PieChart>
                      </ResponsiveContainer>
                    </div>
                    <div className="flex flex-wrap gap-2 mt-1">
                      {detailTypePieData.map((d) => (
                        <span
                          key={d.name}
                          className="text-2xs flex items-center gap-1"
                        >
                          <span className="h-1.5 w-1.5 rounded-full inline-block" style={{ background: d.fill }} />
                          {d.name} {d.value}건
                        </span>
                      ))}
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

      {/* ── 거래처별 매출 표 (상위 20) ── */}
      {!selected && contactRows.length > 0 && (
        <div className="panel overflow-hidden">
          <div className="px-3 py-2 border-b border-ink-200 flex items-center justify-between">
            <span className="text-2xs font-semibold text-ink-600 uppercase tracking-wider">
              거래처별 매출 (상위 20)
            </span>
            <span className="text-2xs text-ink-400">매출 큰 순</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-2xs">
              <thead>
                <tr className="border-b border-ink-100">
                  <th className="px-3 py-1.5 text-left text-ink-500 font-semibold w-6">#</th>
                  <th className="px-3 py-1.5 text-left text-ink-500 font-semibold">거래처명</th>
                  <th className="px-3 py-1.5 text-right text-ink-500 font-semibold w-16">건수</th>
                  <th className="px-3 py-1.5 text-right text-ink-500 font-semibold w-24">매출 합계</th>
                  <th className="px-3 py-1.5 text-right text-ink-500 font-semibold w-24">평균 단가</th>
                  <th className="px-3 py-1.5 text-right text-ink-500 font-semibold w-16">점유율</th>
                </tr>
              </thead>
              <tbody>
                {contactRows.map((row, idx) => (
                  <tr key={idx} className="border-b border-ink-50 hover:bg-canvas-50">
                    <td className="px-3 py-1.5 font-mono text-ink-400">{idx + 1}</td>
                    <td className="px-3 py-1.5 font-medium text-ink-800 max-w-[12rem] truncate">{row.name}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-ink-600">{row.count.toLocaleString()}</td>
                    <td className="px-3 py-1.5 text-right font-mono font-semibold text-emerald-700">
                      {formatCurrency(row.revenue, false)}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono text-ink-600">
                      {formatCurrency(row.avgPrice, false)}
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        <div className="w-12 h-1.5 rounded-full bg-ink-100 overflow-hidden">
                          <div
                            className="h-full rounded-full bg-primary-500"
                            style={{ width: `${Math.min(row.sharePct, 100)}%` }}
                          />
                        </div>
                        <span className="font-mono text-ink-600">{formatPct(row.sharePct)}</span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── 기간별 채널 합계 표 ── */}
      {!selected && channels.length > 0 && (
        <div className="panel overflow-hidden">
          <div className="px-3 py-2 border-b border-ink-200">
            <span className="text-2xs font-semibold text-ink-600 uppercase tracking-wider">
              기간 합계 ({actualFrom} ~ {to})
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-2xs">
              <thead>
                <tr className="border-b border-ink-100">
                  <th className="px-3 py-1.5 text-left text-ink-500 font-semibold">채널</th>
                  <th className="px-3 py-1.5 text-right text-ink-500 font-semibold">건수</th>
                  <th className="px-3 py-1.5 text-right text-ink-500 font-semibold">매출 합계</th>
                  <th className="px-3 py-1.5 text-right text-ink-500 font-semibold">직접 비용</th>
                  <th className="px-3 py-1.5 text-right text-ink-500 font-semibold">안분 비용</th>
                  <th className="px-3 py-1.5 text-right text-ink-500 font-semibold">총 비용</th>
                  <th className="px-3 py-1.5 text-right text-ink-500 font-semibold">마진</th>
                  <th className="px-3 py-1.5 text-right text-ink-500 font-semibold">마진율</th>
                </tr>
              </thead>
              <tbody>
                {channels.map((ch) => (
                  <tr
                    key={ch.key}
                    className="border-b border-ink-50 hover:bg-canvas-50 cursor-pointer"
                    onClick={() => setSelectedKey(ch.key)}
                  >
                    <td className="px-3 py-1.5">
                      <div className="flex items-center gap-1.5">
                        <span className="h-2 w-2 rounded-full shrink-0" style={{ background: ch.color }} />
                        <span className="font-semibold text-ink-800">{ch.label}</span>
                      </div>
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono text-ink-600">{ch.revenueCount}</td>
                    <td className="px-3 py-1.5 text-right font-mono font-semibold text-emerald-700">
                      {formatCurrency(ch.revenue, false)}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono text-rose-600">
                      {formatCurrency(ch.directCost, false)}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono text-rose-400">
                      {formatCurrency(ch.allocatedCost, false)}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono text-rose-700">
                      {formatCurrency(ch.totalCost, false)}
                    </td>
                    <td className={`px-3 py-1.5 text-right font-mono font-semibold ${ch.margin >= 0 ? 'text-primary-700' : 'text-rose-700'}`}>
                      {ch.margin >= 0 ? '+' : ''}{formatCurrency(ch.margin, false)}
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      <span className={`badge text-2xs ${
                        ch.marginPct >= 20
                          ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                          : ch.marginPct >= 0
                          ? 'bg-amber-50 text-amber-700 border-amber-200'
                          : 'bg-rose-50 text-rose-700 border-rose-200'
                      }`}>
                        {formatPct(ch.marginPct)}
                      </span>
                    </td>
                  </tr>
                ))}
                {/* 합계 행 */}
                <tr className="border-t-2 border-ink-200 bg-ink-50 font-semibold">
                  <td className="px-3 py-1.5 text-ink-700">합계</td>
                  <td className="px-3 py-1.5 text-right font-mono text-ink-700">
                    {channels.reduce((s, c) => s + c.revenueCount, 0)}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono text-emerald-700">
                    {formatCurrency(summary.totalRevenue, false)}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono text-rose-600">
                    {formatCurrency(channels.reduce((s, c) => s + c.directCost, 0), false)}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono text-rose-400">
                    {formatCurrency(channels.reduce((s, c) => s + c.allocatedCost, 0), false)}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono text-rose-700">
                    {formatCurrency(summary.totalCost, false)}
                  </td>
                  <td className={`px-3 py-1.5 text-right font-mono ${summary.totalMargin >= 0 ? 'text-primary-700' : 'text-rose-700'}`}>
                    {summary.totalMargin >= 0 ? '+' : ''}{formatCurrency(summary.totalMargin, false)}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono text-ink-700">
                    {formatPct(summary.avgMarginPct)}
                  </td>
                </tr>
              </tbody>
            </table>
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
  tickets: unknown[]
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
          const tx      = t as Record<string, unknown>
          const type    = tx.taxInvoice ? '세금계산서' : tx.cardUsage ? '카드' : '통장'
          return (
            <div
              key={idx}
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

