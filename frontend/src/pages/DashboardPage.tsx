import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts'
import {
  BanknotesIcon, ArrowDownLeftIcon, ArrowUpRightIcon, CreditCardIcon,
  ArrowTrendingUpIcon, ArrowTrendingDownIcon, SparklesIcon, ArrowRightIcon,
  BuildingLibraryIcon,
} from '@heroicons/react/24/outline'
import { cashDigestApi, hyphenApi } from '@/services/api'
import { useAuthStore } from '@/store/authStore'
import { formatCurrency } from '@/utils/format'
import { useChartTheme } from '@/lib/chartTheme'

export default function DashboardPage() {
  const { user } = useAuthStore()
  const chartTheme = useChartTheme()

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['dashboard-live'],
    queryFn: () => cashDigestApi.dashboardLive().then((r) => r.data),
    staleTime: 60_000,
  })

  // 통장별 잔액 시계열 — Hyphen 원장 EOD 잔액 시계열
  const BAL_PALETTE = ['#10b981', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16', '#f97316', '#14b8a6']
  const [hiddenAccts, setHiddenAccts] = useState<Set<string>>(new Set())

  const BANK_NAMES: Record<string, string> = {
    '003': '기업은행', '004': '국민은행', '011': '농협', '020': '우리은행', '023': 'SC제일',
    '027': '씨티', '031': '대구', '032': '부산', '081': '하나은행', '088': '신한은행',
    '090': '카카오뱅크', '092': '토스뱅크', '002': '산업', '007': '수협', '071': '우체국',
  }

  const balSeriesQuery = useQuery({
    queryKey: ['hyphen-balance-series', 30],
    queryFn: () => hyphenApi.balanceSeries(30).then((r) => r.data),
    staleTime: 60_000,
    retry: false,
  })

  const { balAccounts, balChartData } = useMemo(() => {
    const accounts: any[] = (balSeriesQuery.data as any)?.accounts || []
    const accs = accounts
      .map((a, i) => ({
        id: String(a?.acct_no),
        label: `${BANK_NAMES[a?.bank_cd] || a?.bank_cd}(${a?.last4})`,
        balance: Number(a?.balance || 0),
        color: BAL_PALETTE[i % BAL_PALETTE.length],
      }))
      .sort((x, y) => y.balance - x.balance)

    const series: any[] = (balSeriesQuery.data as any)?.series || []
    const data = series.map((row) => ({
      ...row,
      date: String(row?.date || '').slice(5).replace('-', '/'),
    }))
    return { balAccounts: accs, balChartData: data }
  }, [balSeriesQuery.data])

  const cardDelta = data?.card?.delta_pct || 0

  return (
    <div className="space-y-3">
      <div className="flex items-end justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-lg font-bold text-ink-900 dark:text-ink-50">
            안녕하세요{user?.fullName ? `, ${user.fullName}님` : ''} 👋
          </h1>
          <p className="text-xs text-ink-500 dark:text-ink-400 mt-0.5">
            실시간 연동 자금 현황 {data?.as_of ? `· ${data.as_of} 기준` : ''}
          </p>
        </div>
        <Link to="/cash-digest" className="text-xs px-2.5 py-1.5 rounded-md border border-emerald-300 dark:border-emerald-700 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-50 dark:hover:bg-emerald-950/40 flex items-center gap-1">
          <SparklesIcon className="h-3.5 w-3.5" /> AI 자금 다이제스트
        </Link>
      </div>

      {isLoading ? (
        <div className="panel p-12 text-center text-2xs text-ink-400">자금 현황 불러오는 중… (연동 조회)</div>
      ) : isError ? (
        <div className="panel p-10 text-center text-2xs text-red-500">
          불러오기 실패: {(error as any)?.response?.data?.detail || '네트워크 오류'}
          <button onClick={() => refetch()} className="block mx-auto mt-2 px-2 py-1 rounded border border-ink-200 dark:border-ink-800 text-ink-600 dark:text-ink-400">다시 시도</button>
        </div>
      ) : !data ? null : (
        <>
          {/* 핵심 KPI */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
            <div className="panel p-3 border-l-2 border-l-blue-400">
              <div className="text-2xs text-ink-500 dark:text-ink-400 flex items-center gap-1"><BanknotesIcon className="h-3 w-3" />현재 가용자금</div>
              <div className="text-xl font-bold text-ink-900 dark:text-ink-50 mt-0.5">{formatCurrency(data.balance, false)}</div>
              <div className="text-2xs text-ink-400">실시간 통장 잔액 (통합조회와 동일)</div>
            </div>
            <div className="panel p-3">
              <div className="text-2xs text-ink-500 dark:text-ink-400">어제 순증감</div>
              <div className={`text-xl font-bold mt-0.5 ${data.yesterday.net >= 0 ? 'text-emerald-700 dark:text-emerald-300' : 'text-rose-700 dark:text-rose-300'}`}>
                {data.yesterday.net >= 0 ? '+' : ''}{formatCurrency(data.yesterday.net, false)}
              </div>
              <div className="text-2xs text-ink-400">입 {formatCurrency(data.yesterday.inflow, false)} · 출 {formatCurrency(data.yesterday.outflow, false)}</div>
            </div>
            <div className="panel p-3">
              <div className="text-2xs text-ink-500 dark:text-ink-400">최근 7일 순흐름</div>
              <div className={`text-xl font-bold mt-0.5 ${data.week.net >= 0 ? 'text-emerald-700 dark:text-emerald-300' : 'text-rose-700 dark:text-rose-300'}`}>
                {data.week.net >= 0 ? '+' : ''}{formatCurrency(data.week.net, false)}
              </div>
            </div>
            <div className="panel p-3 border-l-2 border-l-amber-400">
              <div className="text-2xs text-ink-500 dark:text-ink-400 flex items-center gap-1"><CreditCardIcon className="h-3 w-3" />이번달 카드지출</div>
              <div className="text-xl font-bold text-ink-900 dark:text-ink-50 mt-0.5">{formatCurrency(data.card.this_month, false)}</div>
              <div className={`text-2xs flex items-center gap-0.5 ${cardDelta > 0 ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
                {cardDelta > 0 ? <ArrowTrendingUpIcon className="h-2.5 w-2.5" /> : <ArrowTrendingDownIcon className="h-2.5 w-2.5" />}
                전월 대비 {cardDelta >= 0 ? '+' : ''}{cardDelta.toFixed(0)}%
              </div>
            </div>
          </div>

          {/* 통장별 잔액 추이 (최근 30일, 일별) */}
          <div className="panel p-3">
            <div className="text-2xs font-semibold text-ink-600 dark:text-ink-400 uppercase tracking-wider mb-2 flex items-center gap-1">
              <BuildingLibraryIcon className="h-3.5 w-3.5" />통장별 잔액 추이
              {balAccounts.length > 0 && (
                <span className="text-ink-400 normal-case font-normal">· {balAccounts.length}개 계좌</span>
              )}
            </div>
            {balSeriesQuery.isLoading ? (
              <div className="h-56 flex items-center justify-center text-2xs text-ink-400">불러오는 중…</div>
            ) : balSeriesQuery.isError ? (
              <div className="h-56 flex items-center justify-center text-2xs text-ink-400">통장 잔액을 불러오지 못했습니다.</div>
            ) : balAccounts.length === 0 ? (
              <div className="h-56 flex items-center justify-center text-2xs text-ink-400">활성 계좌 없음</div>
            ) : (
              <>
                {/* 계좌 선택 토글 */}
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {balAccounts.map((a) => {
                    const on = !hiddenAccts.has(a.id)
                    return (
                      <button
                        key={a.id}
                        onClick={() =>
                          setHiddenAccts((prev) => {
                            const next = new Set(prev)
                            if (next.has(a.id)) next.delete(a.id)
                            else next.add(a.id)
                            return next
                          })
                        }
                        className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-2xs border transition ${
                          on
                            ? 'border-ink-200 dark:border-ink-700 text-ink-700 dark:text-ink-200'
                            : 'border-ink-100 dark:border-ink-800 text-ink-300 dark:text-ink-600 line-through'
                        }`}
                        title={on ? '숨기기' : '표시'}
                      >
                        <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: on ? a.color : 'transparent', border: `1px solid ${a.color}` }} />
                        {a.label}
                      </button>
                    )
                  })}
                </div>
                <ResponsiveContainer width="100%" height={220}>
                  <LineChart data={balChartData} margin={{ top: 4, right: 16, left: 4, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={chartTheme.gridColor} />
                    <XAxis dataKey="date" tick={{ fontSize: 9, fill: chartTheme.axisColor }} minTickGap={24} />
                    <YAxis
                      tick={{ fontSize: 9, fill: chartTheme.axisColor }}
                      width={64}
                      tickFormatter={(v: number) => formatCurrency(v, false)}
                    />
                    <Tooltip
                      contentStyle={{ fontSize: 11, backgroundColor: chartTheme.tooltipBg, border: `1px solid ${chartTheme.tooltipBorder}`, color: chartTheme.tooltipText }}
                      formatter={(v: number, name: string) => [formatCurrency(v, false), name]}
                    />
                    {balAccounts
                      .filter((a) => !hiddenAccts.has(a.id))
                      .map((a) => (
                        <Line
                          key={a.id}
                          type="monotone"
                          dataKey={a.id}
                          name={a.label}
                          stroke={a.color}
                          strokeWidth={1.5}
                          dot={false}
                          connectNulls
                        />
                      ))}
                  </LineChart>
                </ResponsiveContainer>
              </>
            )}
          </div>

          {/* 최근 입출금 */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <div className="panel overflow-hidden">
              <div className="px-3 py-2 border-b border-ink-200 dark:border-ink-800 text-2xs font-semibold text-emerald-700 dark:text-emerald-300 uppercase flex items-center gap-1">
                <ArrowDownLeftIcon className="h-3 w-3" />최근 7일 주요 입금
              </div>
              {data.week.top_inflows.length === 0 ? (
                <div className="p-6 text-center text-2xs text-ink-400">입금 내역 없음</div>
              ) : (
                <div className="divide-y divide-ink-50 dark:divide-ink-800">
                  {data.week.top_inflows.map((x: any, i: number) => (
                    <div key={i} className="px-3 py-1.5 flex items-center gap-2">
                      <span className="text-2xs text-ink-400 w-16 flex-shrink-0">{x.date?.slice(5)}</span>
                      <span className="flex-1 text-xs text-ink-800 dark:text-ink-100 truncate">{x.counterparty}{x.description ? ` · ${x.description}` : ''}</span>
                      <span className="text-xs font-mono font-semibold text-emerald-700 dark:text-emerald-300">{formatCurrency(x.amount, false)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="panel overflow-hidden">
              <div className="px-3 py-2 border-b border-ink-200 dark:border-ink-800 text-2xs font-semibold text-rose-700 dark:text-rose-300 uppercase flex items-center gap-1">
                <ArrowUpRightIcon className="h-3 w-3" />최근 7일 주요 출금
              </div>
              {data.week.top_outflows.length === 0 ? (
                <div className="p-6 text-center text-2xs text-ink-400">출금 내역 없음</div>
              ) : (
                <div className="divide-y divide-ink-50 dark:divide-ink-800">
                  {data.week.top_outflows.map((x: any, i: number) => (
                    <div key={i} className="px-3 py-1.5 flex items-center gap-2">
                      <span className="text-2xs text-ink-400 w-16 flex-shrink-0">{x.date?.slice(5)}</span>
                      <span className="flex-1 text-xs text-ink-800 dark:text-ink-100 truncate">{x.counterparty}{x.description ? ` · ${x.description}` : ''}</span>
                      <span className="text-xs font-mono font-semibold text-rose-700 dark:text-rose-300">{formatCurrency(x.amount, false)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* 바로가기 */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
            {[
              { to: '/unified', label: '통합 조회', desc: '계좌·카드·세금계산서' },
              { to: '/internal-transfers', label: '은행간 내부거래', desc: '계좌간 이체·순대차' },
              { to: '/cards', label: '카드 관리', desc: '카드별 사용·배정' },
              { to: '/channel-profitability', label: '채널별 수익성', desc: '매출 채널 분석' },
            ].map((s) => (
              <Link key={s.to} to={s.to} className="panel p-3 hover:bg-canvas-50 dark:hover:bg-ink-800 transition group">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-ink-900 dark:text-ink-50">{s.label}</span>
                  <ArrowRightIcon className="h-3 w-3 text-ink-300 dark:text-ink-600 group-hover:text-blue-500" />
                </div>
                <div className="text-2xs text-ink-400 mt-0.5">{s.desc}</div>
              </Link>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
