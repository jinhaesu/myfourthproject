import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import {
  BanknotesIcon, ArrowDownLeftIcon, ArrowUpRightIcon, CreditCardIcon,
  ArrowTrendingUpIcon, ArrowTrendingDownIcon, SparklesIcon, ArrowRightIcon,
} from '@heroicons/react/24/outline'
import { cashDigestApi } from '@/services/api'
import { useAuthStore } from '@/store/authStore'
import { formatCurrency } from '@/utils/format'

export default function DashboardPage() {
  const { user } = useAuthStore()

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['dashboard-live'],
    queryFn: () => cashDigestApi.dashboardLive().then((r) => r.data),
    staleTime: 60_000,
  })

  const cardDelta = data?.card?.delta_pct || 0

  return (
    <div className="space-y-3">
      <div className="flex items-end justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-lg font-bold text-ink-900">
            안녕하세요{user?.fullName ? `, ${user.fullName}님` : ''} 👋
          </h1>
          <p className="text-xs text-ink-500 mt-0.5">
            그랜터 실시간 자금 현황 {data?.as_of ? `· ${data.as_of} 기준` : ''}
          </p>
        </div>
        <Link to="/cash-digest" className="text-xs px-2.5 py-1.5 rounded-md border border-emerald-300 text-emerald-700 hover:bg-emerald-50 flex items-center gap-1">
          <SparklesIcon className="h-3.5 w-3.5" /> AI 자금 다이제스트
        </Link>
      </div>

      {isLoading ? (
        <div className="panel p-12 text-center text-2xs text-ink-400">자금 현황 불러오는 중… (그랜터 조회)</div>
      ) : isError ? (
        <div className="panel p-10 text-center text-2xs text-red-500">
          불러오기 실패: {(error as any)?.response?.data?.detail || '네트워크 오류'}
          <button onClick={() => refetch()} className="block mx-auto mt-2 px-2 py-1 rounded border border-ink-200 text-ink-600">다시 시도</button>
        </div>
      ) : !data ? null : (
        <>
          {/* 핵심 KPI */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
            <div className="panel p-3 border-l-2 border-l-blue-400">
              <div className="text-2xs text-ink-500 flex items-center gap-1"><BanknotesIcon className="h-3 w-3" />현재 가용자금</div>
              <div className="text-xl font-bold text-ink-900 mt-0.5">{formatCurrency(data.balance, false)}</div>
            </div>
            <div className="panel p-3">
              <div className="text-2xs text-ink-500">어제 순증감</div>
              <div className={`text-xl font-bold mt-0.5 ${data.yesterday.net >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
                {data.yesterday.net >= 0 ? '+' : ''}{formatCurrency(data.yesterday.net, false)}
              </div>
              <div className="text-2xs text-ink-400">입 {formatCurrency(data.yesterday.inflow, false)} · 출 {formatCurrency(data.yesterday.outflow, false)}</div>
            </div>
            <div className="panel p-3">
              <div className="text-2xs text-ink-500">최근 7일 순흐름</div>
              <div className={`text-xl font-bold mt-0.5 ${data.week.net >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
                {data.week.net >= 0 ? '+' : ''}{formatCurrency(data.week.net, false)}
              </div>
            </div>
            <div className="panel p-3 border-l-2 border-l-amber-400">
              <div className="text-2xs text-ink-500 flex items-center gap-1"><CreditCardIcon className="h-3 w-3" />이번달 카드지출</div>
              <div className="text-xl font-bold text-ink-900 mt-0.5">{formatCurrency(data.card.this_month, false)}</div>
              <div className={`text-2xs flex items-center gap-0.5 ${cardDelta > 0 ? 'text-rose-600' : 'text-emerald-600'}`}>
                {cardDelta > 0 ? <ArrowTrendingUpIcon className="h-2.5 w-2.5" /> : <ArrowTrendingDownIcon className="h-2.5 w-2.5" />}
                전월 대비 {cardDelta >= 0 ? '+' : ''}{cardDelta.toFixed(0)}%
              </div>
            </div>
          </div>

          {/* 최근 입출금 */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <div className="panel overflow-hidden">
              <div className="px-3 py-2 border-b border-ink-200 text-2xs font-semibold text-emerald-700 uppercase flex items-center gap-1">
                <ArrowDownLeftIcon className="h-3 w-3" />최근 7일 주요 입금
              </div>
              {data.week.top_inflows.length === 0 ? (
                <div className="p-6 text-center text-2xs text-ink-400">입금 내역 없음</div>
              ) : (
                <div className="divide-y divide-ink-50">
                  {data.week.top_inflows.map((x: any, i: number) => (
                    <div key={i} className="px-3 py-1.5 flex items-center gap-2">
                      <span className="text-2xs text-ink-400 w-16 flex-shrink-0">{x.date?.slice(5)}</span>
                      <span className="flex-1 text-xs text-ink-800 truncate">{x.counterparty}{x.description ? ` · ${x.description}` : ''}</span>
                      <span className="text-xs font-mono font-semibold text-emerald-700">{formatCurrency(x.amount, false)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="panel overflow-hidden">
              <div className="px-3 py-2 border-b border-ink-200 text-2xs font-semibold text-rose-700 uppercase flex items-center gap-1">
                <ArrowUpRightIcon className="h-3 w-3" />최근 7일 주요 출금
              </div>
              {data.week.top_outflows.length === 0 ? (
                <div className="p-6 text-center text-2xs text-ink-400">출금 내역 없음</div>
              ) : (
                <div className="divide-y divide-ink-50">
                  {data.week.top_outflows.map((x: any, i: number) => (
                    <div key={i} className="px-3 py-1.5 flex items-center gap-2">
                      <span className="text-2xs text-ink-400 w-16 flex-shrink-0">{x.date?.slice(5)}</span>
                      <span className="flex-1 text-xs text-ink-800 truncate">{x.counterparty}{x.description ? ` · ${x.description}` : ''}</span>
                      <span className="text-xs font-mono font-semibold text-rose-700">{formatCurrency(x.amount, false)}</span>
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
              <Link key={s.to} to={s.to} className="panel p-3 hover:bg-canvas-50 transition group">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-ink-900">{s.label}</span>
                  <ArrowRightIcon className="h-3 w-3 text-ink-300 group-hover:text-blue-500" />
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
