import { useMemo, useState } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import {
  CalendarDaysIcon,
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
} from 'recharts'
import { granterApi } from '@/services/api'
import { formatCurrency, formatCompactWon, formatPct } from '@/utils/format'

// ─── 채널 분류 상수 (향후 확장 가능) ───────────────────────────────────────────
export const CHANNEL_RULES: Array<{
  key: string
  label: string
  keywords: string[]
  color: string
}> = [
  { key: 'coupang',      label: '쿠팡',        keywords: ['쿠팡'],                    color: '#e53e3e' },
  { key: 'emart',        label: '이마트',       keywords: ['이마트'],                  color: '#38a169' },
  { key: 'smartstore',   label: '스마트스토어',  keywords: ['스마트스토어', '네이버'],  color: '#2f855a' },
  { key: 'gs25',         label: 'GS25',         keywords: ['GS25', 'GS리테일'],        color: '#3182ce' },
  { key: 'cu',           label: 'CU',           keywords: ['CU', '비지에프'],          color: '#6b46c1' },
  { key: 'seveneleven',  label: '세븐일레븐',   keywords: ['세븐일레븐'],              color: '#d69e2e' },
  { key: 'lottemart',    label: '롯데마트',     keywords: ['롯데마트', '롯데'],        color: '#dd6b20' },
  { key: 'homeplus',     label: '홈플러스',     keywords: ['홈플러스'],               color: '#2b6cb0' },
  { key: 'delivery',     label: '배달앱',       keywords: ['쿠팡이츠', '배달의민족', '요기요'], color: '#e53e3e' },
]
const OTHER_CHANNEL = { key: 'etc', label: '기타 거래처', color: '#718096' }

function classifyChannel(contactName: string): string {
  const name = contactName.toLowerCase()
  for (const rule of CHANNEL_RULES) {
    if (rule.keywords.some((kw) => name.includes(kw.toLowerCase()))) {
      return rule.key
    }
  }
  return OTHER_CHANNEL.key
}

function channelMeta(key: string): { label: string; color: string } {
  const found = CHANNEL_RULES.find((r) => r.key === key)
  return found ?? OTHER_CHANNEL
}

// ─── 날짜 헬퍼 ──────────────────────────────────────────────────────────────
function todayISO() { return new Date().toISOString().slice(0, 10) }
function thisMonthStartISO() {
  const d = new Date(); d.setDate(1); return d.toISOString().slice(0, 10)
}
function daysBetween(a: string, b: string) {
  return Math.floor((new Date(b).getTime() - new Date(a).getTime()) / 86400000) + 1
}

// ─── 필드 추출 헬퍼 ──────────────────────────────────────────────────────────
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

function extractContact(t: any): string {
  if (t?.taxInvoice) {
    const ti = t.taxInvoice
    if (str(t, 'transactionType') === 'IN')
      return str(ti?.contractor, 'companyName') || str(ti?.supplier, 'companyName') || '(미지정)'
    return str(ti?.supplier, 'companyName') || str(ti?.contractor, 'companyName') || '(미지정)'
  }
  return (
    str(t, 'contact') ||
    str(t?.bankTransaction, 'counterparty') ||
    str(t?.cardUsage, 'storeName') ||
    str(t?.bankTransaction, 'content') ||
    str(t, 'content', 'merchantName', 'counterpartyName') ||
    '(미지정)'
  )
}

// ─── 타입 ────────────────────────────────────────────────────────────────────
interface ChannelRow {
  key: string
  label: string
  color: string
  total: number
  count: number
  avgAmount: number
  sharePct: number
  tickets: any[]
  dailyData: { date: string; amount: number }[]
}

// ─── 메인 컴포넌트 ────────────────────────────────────────────────────────────
export default function ChannelProfitabilityPage() {
  const [from, setFrom] = useState(thisMonthStartISO())
  const [to, setTo] = useState(todayISO())
  const [selectedKey, setSelectedKey] = useState<string | null>(null)

  const ready = Boolean(from && to)
  const exceeds31 = ready && daysBetween(from, to) > 31

  // 실제 조회 시작일 (31일 초과 시 종료일 기준 최근 31일)
  const actualFrom = useMemo(() => {
    if (!exceeds31) return from
    const d = new Date(to)
    d.setDate(d.getDate() - 30)
    return d.toISOString().slice(0, 10)
  }, [from, to, exceeds31])

  // ─── 그랜터 설정 확인 ────────────────────────────────────────────────────
  const healthQuery = useQuery({
    queryKey: ['granter-health'],
    queryFn: () => granterApi.health().then((r) => r.data),
    retry: false,
  })
  const isConfigured = healthQuery.data?.configured

  // ─── 티켓 조회 (통장 IN + 세금계산서 IN) ─────────────────────────────────
  const dataQuery = useQuery({
    queryKey: ['channel-profitability', actualFrom, to],
    queryFn: async () => {
      const [bankRes, taxRes] = await Promise.all([
        granterApi.listTickets({ ticketType: 'BANK_TRANSACTION_TICKET', startDate: actualFrom, endDate: to }),
        granterApi.listTickets({ ticketType: 'TAX_INVOICE_TICKET',      startDate: actualFrom, endDate: to }),
      ])
      const bank = Array.isArray(bankRes.data) ? bankRes.data : bankRes.data?.data || []
      const tax  = Array.isArray(taxRes.data)  ? taxRes.data  : taxRes.data?.data  || []
      return { bank, tax }
    },
    enabled: !!isConfigured && ready,
    retry: false,
  })

  // ─── 최근 거래 탐색 ───────────────────────────────────────────────────────
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
          if (inCount > 0) {
            return { start: startStr, end: endStr, count: inCount, monthsBack: offset }
          }
        } catch { /* 무시 */ }
      }
      return { start: null, end: null, count: 0, monthsBack: 0 }
    },
    onSuccess: (res) => {
      if (res.start && res.end) {
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

  // ─── 채널별 집계 ──────────────────────────────────────────────────────────
  const channels: ChannelRow[] = useMemo(() => {
    const { bank = [], tax = [] } = dataQuery.data || {}

    // 매출(IN)만 모음
    const salesTickets = [
      ...bank.filter((t: any) => str(t, 'transactionType') === 'IN'),
      ...tax.filter((t: any) => str(t, 'transactionType') === 'IN'),
    ]

    const totalAmount = salesTickets.reduce((s: number, t: any) => s + num(t, 'amount'), 0)

    // 채널별 map
    const map: Record<string, { tickets: any[]; dailyMap: Record<string, number> }> = {}
    const ensureChannel = (key: string) => {
      if (!map[key]) map[key] = { tickets: [], dailyMap: {} }
      return map[key]
    }

    for (const t of salesTickets) {
      const contact = extractContact(t)
      const key = classifyChannel(contact)
      const ch = ensureChannel(key)
      ch.tickets.push(t)
      const date = str(t, 'transactAt', 'date').slice(0, 10) || 'unknown'
      ch.dailyMap[date] = (ch.dailyMap[date] || 0) + num(t, 'amount')
    }

    return Object.entries(map)
      .map(([key, { tickets, dailyMap }]) => {
        const meta = channelMeta(key)
        const total = tickets.reduce((s, t) => s + num(t, 'amount'), 0)
        const count = tickets.length
        const avgAmount = count > 0 ? Math.round(total / count) : 0
        const sharePct = totalAmount > 0 ? (total / totalAmount) * 100 : 0
        const dailyData = Object.entries(dailyMap)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([date, amount]) => ({ date: date.slice(5), amount })) // MM-DD 형식
        return { key, label: meta.label, color: meta.color, total, count, avgAmount, sharePct, dailyData, tickets }
      })
      .sort((a, b) => b.total - a.total)
  }, [dataQuery.data])

  const totalSales = useMemo(() => channels.reduce((s, c) => s + c.total, 0), [channels])
  const topChannel = channels[0] ?? null

  const selected = useMemo(() => channels.find((c) => c.key === selectedKey) ?? null, [channels, selectedKey])

  const setQuickRange = (days: number) => {
    const end = new Date()
    const start = new Date()
    start.setDate(end.getDate() - days + 1)
    setFrom(start.toISOString().slice(0, 10))
    setTo(end.toISOString().slice(0, 10))
  }

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
            스마트스토어·쿠팡·편의점·대형마트 등 판매채널별 매출 분류 및 점유율
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
          </div>
          <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-white border border-ink-200">
            <CalendarDaysIcon className="h-3 w-3 text-ink-400" />
            <input
              type="date" value={from} onChange={(e) => setFrom(e.target.value)}
              className="bg-transparent text-2xs text-ink-700 w-24 focus:outline-none"
            />
            <span className="text-ink-300">→</span>
            <input
              type="date" value={to} onChange={(e) => setTo(e.target.value)}
              className="bg-transparent text-2xs text-ink-700 w-24 focus:outline-none"
            />
          </div>
          <button
            onClick={() => findRecentMut.mutate()}
            disabled={findRecentMut.isPending}
            className="btn-secondary"
          >
            <ClockIcon className="h-3 w-3 mr-1" />
            {findRecentMut.isPending ? '탐색 중...' : '최근 거래 한 달'}
          </button>
          <button onClick={() => dataQuery.refetch()} className="btn-secondary">
            <ArrowPathIcon className="h-3 w-3" />
          </button>
        </div>
      </div>

      {/* ── 상태 배너 ── */}
      {!isConfigured ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 flex items-center gap-2">
          <ExclamationTriangleIcon className="h-4 w-4 text-amber-600" />
          <span className="text-2xs text-amber-800">그랜터 API 키 미설정 — 설정에서 그랜터 연동을 먼저 완료하세요.</span>
        </div>
      ) : (
        <div className="flex items-center gap-2 flex-wrap">
          <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-1 flex items-center gap-2">
            <CheckCircleIcon className="h-3.5 w-3.5 text-emerald-600" />
            <span className="text-2xs text-emerald-800">그랜터 연결됨</span>
          </div>
          {exceeds31 && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-1 text-2xs text-amber-800">
              31일 초과 — 종료일 기준 최근 31일({actualFrom} ~ {to})만 자동 조회
            </div>
          )}
        </div>
      )}

      {/* ── KPI 카드 ── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <div className="panel px-3 py-2">
          <div className="text-2xs font-medium text-ink-500 uppercase tracking-wider">총 매출</div>
          <div className="mt-0.5 font-mono tabular-nums font-bold text-base text-ink-900">
            {formatCompactWon(totalSales)}
          </div>
          <div className="text-2xs text-ink-400">{formatCurrency(totalSales, false)}원</div>
        </div>
        <div className="panel px-3 py-2">
          <div className="text-2xs font-medium text-ink-500 uppercase tracking-wider">활성 채널</div>
          <div className="mt-0.5 font-mono tabular-nums font-bold text-base text-primary-700">
            {channels.length}개
          </div>
        </div>
        <div className="panel px-3 py-2">
          <div className="text-2xs font-medium text-ink-500 uppercase tracking-wider">최대 매출 채널</div>
          <div className="mt-0.5 font-bold text-sm text-emerald-700 truncate">
            {topChannel?.label ?? '-'}
          </div>
          <div className="text-2xs text-ink-400">
            {topChannel ? formatCompactWon(topChannel.total) : '-'}
          </div>
        </div>
        <div className="panel px-3 py-2">
          <div className="text-2xs font-medium text-ink-500 uppercase tracking-wider">1위 점유율</div>
          <div className="mt-0.5 font-mono tabular-nums font-bold text-base text-amber-700">
            {topChannel ? formatPct(topChannel.sharePct) : '-'}
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
                채널별 매출 순위
              </span>
            </div>
            <div className="overflow-y-auto max-h-[calc(100vh-26rem)]">
              {isLoading && (
                <div className="text-center py-8 text-2xs text-ink-400">불러오는 중…</div>
              )}
              {!isLoading && channels.length === 0 && (
                <div className="text-center py-8 text-2xs text-ink-400">
                  <div>이 기간에 매출 거래가 없습니다.</div>
                  <div className="mt-2">
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
                return (
                  <div
                    key={ch.key}
                    onClick={() => setSelectedKey(ch.key)}
                    className={`px-3 py-2.5 border-b border-ink-100 cursor-pointer flex items-center gap-3 ${
                      isSel ? 'bg-ink-50' : 'hover:bg-canvas-50'
                    }`}
                  >
                    {/* 순위 */}
                    <span className="text-2xs font-mono text-ink-400 w-4 shrink-0">{idx + 1}</span>
                    {/* 채널 색상 dot */}
                    <span className="h-2 w-2 rounded-full shrink-0" style={{ background: ch.color }} />
                    {/* 채널명 + 건수 */}
                    <div className="flex-1 min-w-0">
                      <div className={`text-xs font-semibold ${isSel ? 'text-ink-900' : 'text-ink-800'}`}>
                        {ch.label}
                      </div>
                      <div className="text-2xs text-ink-500">{ch.count}건 · 평균 {formatCompactWon(ch.avgAmount)}</div>
                    </div>
                    {/* 금액 + 점유율 */}
                    <div className="text-right shrink-0">
                      <div className="font-mono tabular-nums text-xs font-semibold text-ink-900">
                        {formatCompactWon(ch.total)}
                      </div>
                      <div className="text-2xs text-ink-400">{formatPct(ch.sharePct)}</div>
                    </div>
                    {/* 점유율 바 */}
                    {!selected && (
                      <div className="w-16 shrink-0">
                        <div className="h-1.5 rounded-full bg-ink-100 overflow-hidden">
                          <div
                            className="h-full rounded-full"
                            style={{ width: `${Math.min(ch.sharePct, 100)}%`, background: ch.color }}
                          />
                        </div>
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
                      {selected.count}건 · 점유율 {formatPct(selected.sharePct)}
                    </span>
                  </div>
                </div>
                <button onClick={() => setSelectedKey(null)} className="text-ink-400 hover:text-ink-700">
                  <XMarkIcon className="h-4 w-4" />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto p-3 space-y-3">
                {/* KPI 소계 */}
                <div className="grid grid-cols-3 gap-2">
                  <div className="card px-2.5 py-2 text-center">
                    <div className="text-2xs text-ink-500">매출 합계</div>
                    <div className="font-mono font-bold text-sm text-emerald-700 mt-0.5">
                      {formatCompactWon(selected.total)}
                    </div>
                  </div>
                  <div className="card px-2.5 py-2 text-center">
                    <div className="text-2xs text-ink-500">건수</div>
                    <div className="font-mono font-bold text-sm text-ink-900 mt-0.5">
                      {selected.count}건
                    </div>
                  </div>
                  <div className="card px-2.5 py-2 text-center">
                    <div className="text-2xs text-ink-500">평균 단가</div>
                    <div className="font-mono font-bold text-sm text-primary-700 mt-0.5">
                      {formatCompactWon(selected.avgAmount)}
                    </div>
                  </div>
                </div>

                {/* 일별 매출 추이 차트 */}
                {selected.dailyData.length > 0 && (
                  <div>
                    <div className="text-2xs font-semibold text-ink-600 uppercase tracking-wider mb-2">
                      일별 매출 추이
                    </div>
                    <div className="h-36">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={selected.dailyData} margin={{ top: 2, right: 4, bottom: 2, left: 0 }}>
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
                          <Bar dataKey="amount" radius={[2, 2, 0, 0]}>
                            {selected.dailyData.map((_, i) => (
                              <Cell key={i} fill={selected.color} fillOpacity={0.8} />
                            ))}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                )}

                {/* 거래 상세 목록 */}
                <div>
                  <div className="text-2xs font-semibold text-ink-600 uppercase tracking-wider mb-1.5">
                    거래 상세 ({selected.tickets.length}건)
                  </div>
                  <div className="space-y-1">
                    {selected.tickets
                      .slice()
                      .sort((a, b) =>
                        str(b, 'transactAt', 'date').localeCompare(str(a, 'transactAt', 'date'))
                      )
                      .map((t, idx) => {
                        const contact = extractContact(t)
                        const date = str(t, 'transactAt', 'date').slice(0, 10)
                        const desc = str(t, 'content', 'description')
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
                                    background: `${selected.color}15`,
                                    color: selected.color,
                                    borderColor: `${selected.color}40`,
                                  }}
                                >
                                  {t.taxInvoice ? '세금계산서' : '통장'}
                                </span>
                              </div>
                              <div className="text-ink-700 font-medium truncate">{contact}</div>
                              {desc && <div className="text-ink-400 truncate">{desc}</div>}
                            </div>
                            <div className="font-mono font-semibold text-emerald-700 shrink-0 pt-0.5">
                              {formatCurrency(num(t, 'amount'), false)}
                            </div>
                          </div>
                        )
                      })}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── 전체 채널 추이 차트 (상세 패널 닫힌 경우) ── */}
      {!selected && channels.length > 0 && (
        <div className="panel p-3">
          <div className="text-2xs font-semibold text-ink-600 uppercase tracking-wider mb-2">
            채널별 매출 비교
          </div>
          <div className="h-40">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={channels.map((c) => ({ label: c.label, amount: c.total, color: c.color }))}
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
                  formatter={(v: number) => [formatCurrency(v, false) + '원', '매출']}
                  labelStyle={{ fontSize: 10 }}
                  contentStyle={{ fontSize: 10, padding: '4px 8px' }}
                />
                <Bar dataKey="amount" radius={[3, 3, 0, 0]}>
                  {channels.map((c, i) => (
                    <Cell key={i} fill={c.color} fillOpacity={0.85} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      <div className="text-2xs text-ink-400 px-1">
        ※ 채널 분류는 거래처명 키워드 매칭. 분류 기준은 CHANNEL_RULES 상수에서 수정 가능. 통장 입금(BANK_TRANSACTION_TICKET IN) + 세금계산서 매출(TAX_INVOICE_TICKET IN) 합산.
      </div>
    </div>
  )
}
