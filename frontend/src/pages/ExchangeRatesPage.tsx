import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts'
import {
  ArrowPathIcon,
  GlobeAltIcon,
  ExclamationTriangleIcon,
} from '@heroicons/react/24/outline'
import api, { granterApi } from '@/services/api'
import { isoLocal } from '@/utils/format'
import PeriodPicker, { periodForPreset, type PeriodPreset } from '@/components/common/PeriodPicker'

// ---------------------------------------------------------------------------
// 통화 메타 / 색상
// ---------------------------------------------------------------------------

const CURRENCY_COLORS: Record<string, string> = {
  USD: '#0d8e88',
  JPY: '#f59e0b',
  CNY: '#ef4444',
  SGD: '#3b82f6',
  EUR: '#8b5cf6',
  GBP: '#10b981',
  HKD: '#ec4899',
}

const CURRENCY_META: Record<string, { name: string; flag: string; unit: string }> = {
  USD: { name: '미국 달러', flag: '🇺🇸', unit: 'USD' },
  JPY: { name: '일본 엔', flag: '🇯🇵', unit: 'JPY (100엔)' },
  CNY: { name: '중국 위안', flag: '🇨🇳', unit: 'CNY' },
  SGD: { name: '싱가포르 달러', flag: '🇸🇬', unit: 'SGD' },
  EUR: { name: '유로', flag: '🇪🇺', unit: 'EUR' },
  GBP: { name: '영국 파운드', flag: '🇬🇧', unit: 'GBP' },
  HKD: { name: '홍콩 달러', flag: '🇭🇰', unit: 'HKD' },
}

const ALL_CURRENCIES = ['USD', 'JPY', 'CNY', 'SGD', 'EUR', 'GBP', 'HKD']
const DEFAULT_CURRENCIES = ['USD', 'JPY', 'CNY', 'SGD']

// ---------------------------------------------------------------------------
// 타입
// ---------------------------------------------------------------------------

interface ExchangeRatePoint {
  date: string
  rates: Record<string, number> // KRW 기준 환율 (JPY는 100엔)
}

// 그랜터 응답 단일 항목
interface GranterRateItem {
  currencyCode: string
  presentName?: string
  baseForeignAmount: number // JPY=100, 나머지=1
  krwAmount: number
  baseDate: string
}

// ---------------------------------------------------------------------------
// 날짜 헬퍼
// ---------------------------------------------------------------------------

function daysBetween(a: string, b: string): number {
  return Math.floor((new Date(b).getTime() - new Date(a).getTime()) / 86400000) + 1
}

function addDays(iso: string, n: number): string {
  const d = new Date(iso + 'T00:00:00')
  d.setDate(d.getDate() + n)
  return isoLocal(d)
}

// ---------------------------------------------------------------------------
// 백엔드 프록시 경유 시계열 가져오기
// from=KRW 방식: 1 KRW = x USD → 뒤집어서 1 USD = y KRW 로 변환
// ---------------------------------------------------------------------------

async function fetchFrankfurterRange(from: string, to: string): Promise<ExchangeRatePoint[]> {
  // 백엔드 프록시를 통해 Frankfurter 데이터 조회 (CORS/광고차단 우회)
  const resp = await api.get('/exchange-rates/timeseries', {
    params: {
      start_date: from,
      end_date: to,
      base: 'USD',
      targets: 'KRW,JPY,CNY,SGD,EUR,GBP,HKD',
    },
  })
  const data = resp.data

  // data.base = "USD", data.rates[date] = { KRW: 1472.4, JPY: 148.5, ... }
  if (!data.rates) return []

  // Frankfurter는 from 이전의 마지막 영업일 데이터를 start_date로 반환하는 경우가 있으므로
  // 요청 범위(from ~ to) 내 날짜만 포함되도록 필터링
  const result: ExchangeRatePoint[] = []
  for (const [date, dayRates] of Object.entries(data.rates as Record<string, Record<string, number>>)) {
    // 요청 범위 밖 날짜 제외
    if (date < from || date > to) continue

    const krwPerUsd = (dayRates as any).KRW as number | undefined
    if (!krwPerUsd || krwPerUsd <= 0) continue

    const rates: Record<string, number> = {}
    // USD: 1 USD = krwPerUsd KRW
    rates['USD'] = krwPerUsd
    // 다른 통화: 1 CODE = x USD → KRW = x * krwPerUsd
    // Frankfurter에서 base=USD면 다른 통화의 val = (code per 1 USD)
    // 즉 1 USD = val_JPY JPY → 1 JPY = (1/val_JPY) USD = krwPerUsd/val_JPY KRW
    for (const code of ['JPY', 'CNY', 'SGD', 'EUR', 'GBP', 'HKD']) {
      const perUsd = (dayRates as any)[code] as number | undefined
      if (!perUsd || perUsd <= 0) continue
      const krwPerCode = krwPerUsd / perUsd
      // JPY는 100엔 단위로 표시
      rates[code] = code === 'JPY' ? krwPerCode * 100 : krwPerCode
    }

    result.push({ date, rates })
  }

  // 날짜 범위 내 영업일 데이터가 전혀 없으면 범위 직전 1개 포인트라도 반환
  // (예: 주말/공휴일만 있는 단기 범위 — 최소한 현재 환율은 보여줌)
  if (result.length === 0 && Object.keys(data.rates).length > 0) {
    const allDates = Object.keys(data.rates).sort()
    const closestDate = allDates[allDates.length - 1]
    const dayRates = (data.rates as Record<string, Record<string, number>>)[closestDate]
    const krwPerUsd = dayRates?.KRW
    if (krwPerUsd && krwPerUsd > 0) {
      const rates: Record<string, number> = { USD: krwPerUsd }
      for (const code of ['JPY', 'CNY', 'SGD', 'EUR', 'GBP', 'HKD']) {
        const perUsd = dayRates[code]
        if (!perUsd || perUsd <= 0) continue
        rates[code] = code === 'JPY' ? (krwPerUsd / perUsd) * 100 : krwPerUsd / perUsd
      }
      result.push({ date: closestDate, rates })
    }
  }

  return result.sort((a, b) => a.date.localeCompare(b.date))
}

// ---------------------------------------------------------------------------
// 차트 Tooltip
// ---------------------------------------------------------------------------

function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  return (
    <div className="panel px-3 py-2 text-2xs shadow-pop min-w-[160px]">
      <div className="font-semibold text-ink-700 mb-1">{label}</div>
      {payload.map((p: any) => (
        <div key={p.dataKey} className="flex items-center justify-between gap-3">
          <span style={{ color: p.color }}>
            {CURRENCY_META[p.dataKey]?.flag} {p.dataKey}
            {p.dataKey === 'JPY' ? ' (100엔)' : ''}
          </span>
          <span className="font-mono tabular-nums text-ink-900">
            {typeof p.value === 'number'
              ? `${new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 2 }).format(p.value)}원`
              : '-'}
          </span>
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// KPI 카드 — 현재 환율 + 전일 대비 변동
// ---------------------------------------------------------------------------

function RateKpiCard({
  currency,
  currentRate,
  prevRate,
}: {
  currency: string
  currentRate: number | undefined
  prevRate: number | undefined
}) {
  const meta = CURRENCY_META[currency]
  const color = CURRENCY_COLORS[currency] ?? '#888'

  const diff = currentRate !== undefined && prevRate !== undefined ? currentRate - prevRate : undefined
  const pct = diff !== undefined && prevRate ? (diff / prevRate) * 100 : undefined

  return (
    <div className="panel px-3 py-2.5" style={{ borderLeft: `3px solid ${color}` }}>
      <div className="flex items-center gap-1 mb-1">
        <span className="text-base leading-none">{meta?.flag}</span>
        <span className="text-2xs font-semibold text-ink-700">{currency}</span>
        <span className="text-2xs text-ink-400 ml-1">{meta?.unit}</span>
      </div>
      <div className="font-mono tabular-nums font-bold text-sm text-ink-900">
        {currentRate !== undefined
          ? `${new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 2 }).format(currentRate)}원`
          : '-'}
      </div>
      {pct !== undefined && (
        <div
          className={`text-2xs font-medium mt-0.5 ${
            pct > 0 ? 'text-rose-600' : pct < 0 ? 'text-emerald-600' : 'text-ink-400'
          }`}
        >
          {pct > 0 ? '▲' : pct < 0 ? '▼' : '—'}
          {' '}
          {Math.abs(pct).toFixed(2)}%
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 메인 페이지
// ---------------------------------------------------------------------------

export default function ExchangeRatesPage() {
  const initial = periodForPreset('last_30d')
  const [preset, setPreset] = useState<PeriodPreset>('last_30d')
  const [from, setFrom] = useState(initial.start)
  const [to, setTo] = useState(initial.end)

  // 31일 초과 자동 클램프
  const span = daysBetween(from, to)
  const effectiveFrom = span > 31 ? addDays(to, -30) : from

  const [selectedCurrencies, setSelectedCurrencies] = useState<Set<string>>(
    new Set(DEFAULT_CURRENCIES)
  )

  function toggleCurrency(code: string) {
    setSelectedCurrencies((prev) => {
      const next = new Set(prev)
      if (next.has(code)) {
        if (next.size > 1) next.delete(code) // 최소 1개 유지
      } else {
        next.add(code)
      }
      return next
    })
  }

  // -------------------------------------------------------------------------
  // 1차: 그랜터 — 오늘 기준 환율 (시계열 없음, 최신값만)
  // -------------------------------------------------------------------------
  const today = isoLocal(new Date())

  const granterQuery = useQuery({
    queryKey: ['granter-exchange-rates-latest', today],
    queryFn: async () => {
      const resp = await granterApi.getExchangeRates({ baseDate: today })
      return resp.data as GranterRateItem[]
    },
    staleTime: 5 * 60_000,
    retry: 1,
  })

  // -------------------------------------------------------------------------
  // 2차: Frankfurter — 시계열 (그랜터 성공 여부와 무관하게 항상 로드)
  // -------------------------------------------------------------------------
  const frankfurterQuery = useQuery({
    queryKey: ['frankfurter-exchange-rates', effectiveFrom, to],
    queryFn: () => fetchFrankfurterRange(effectiveFrom, to),
    staleTime: 5 * 60_000,
    retry: 1,
    enabled: Boolean(effectiveFrom && to),
  })

  // -------------------------------------------------------------------------
  // 데이터 병합: Frankfurter 시계열 우선
  // 그랜터는 KPI 카드용 최신 환율만 제공 (단일 날짜) — 시계열 차트에는 사용하지 않음
  // -------------------------------------------------------------------------
  const timeSeriesData = useMemo<ExchangeRatePoint[]>(() => {
    if (frankfurterQuery.data && frankfurterQuery.data.length > 0) {
      return frankfurterQuery.data
    }
    return []
  }, [frankfurterQuery.data])

  // 차트용 flat 데이터 (X축: 날짜 레이블)
  const chartData = useMemo(() => {
    return timeSeriesData.map((point) => ({
      label: point.date.slice(5), // MM-DD
      ...point.rates,
    }))
  }, [timeSeriesData])

  // 최신 포인트 (KPI용)
  const latestPoint = timeSeriesData[timeSeriesData.length - 1]
  const prevPoint = timeSeriesData[timeSeriesData.length - 2]

  // 그랜터 최신값 (우선 표시) — 시계열 마지막값보다 신뢰도 높음
  const granterLatestMap = useMemo<Record<string, number>>(() => {
    if (!granterQuery.data || !Array.isArray(granterQuery.data)) return {}
    const map: Record<string, number> = {}
    for (const item of granterQuery.data as GranterRateItem[]) {
      map[item.currencyCode] = item.krwAmount // 그랜터는 이미 단위 적용 (JPY=100)
    }
    return map
  }, [granterQuery.data])

  const isLoading = frankfurterQuery.isLoading
  const hasError = frankfurterQuery.isError
  const dataSource = frankfurterQuery.data?.length ? 'Frankfurter (ECB)' : '-'

  // Y축 범위 자동 계산 (선택 통화 기준)
  const yDomain = useMemo<[number, number] | ['auto', 'auto']>(() => {
    if (chartData.length === 0) return ['auto', 'auto']
    const vals: number[] = []
    for (const pt of chartData) {
      for (const code of selectedCurrencies) {
        const v = (pt as any)[code]
        if (typeof v === 'number' && v > 0) vals.push(v)
      }
    }
    if (vals.length === 0) return ['auto', 'auto']
    const minV = Math.min(...vals)
    const maxV = Math.max(...vals)
    const pad = (maxV - minV) * 0.05 || maxV * 0.02
    return [Math.floor(minV - pad), Math.ceil(maxV + pad)]
  }, [chartData, selectedCurrencies])

  const tickInterval = Math.max(1, Math.floor(chartData.length / 10))

  return (
    <div className="space-y-3">
      {/* 헤더 */}
      <div className="flex items-end justify-between flex-wrap gap-2">
        <div>
          <h1 className="flex items-center gap-2">
            <GlobeAltIcon className="h-4 w-4 text-ink-500" />
            환율 흐름
          </h1>
          <p className="text-2xs text-ink-500 mt-0.5">
            KRW 기준 주요 통화 환율 시계열 — 출처: {dataSource}
          </p>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <PeriodPicker
            preset={preset}
            from={from}
            to={to}
            onChange={(p, f, t) => {
              setPreset(p)
              setFrom(f)
              setTo(t)
            }}
            groups={[
              { label: '월', presets: ['this_month', 'last_month'] },
              { label: '범위', presets: ['last_7d', 'last_30d'] },
            ]}
          />
          <button
            onClick={() => {
              granterQuery.refetch()
              frankfurterQuery.refetch()
            }}
            disabled={isLoading}
            className="btn-secondary"
          >
            <ArrowPathIcon className={`h-3 w-3 ${isLoading ? 'animate-spin' : ''}`} />
            새로고침
          </button>
        </div>
      </div>

      {/* 31일 초과 클램프 안내 */}
      {span > 31 && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-1.5 text-2xs text-amber-800">
          조회 기간이 31일을 초과합니다 — 종료일 기준 최근 31일({effectiveFrom} ~ {to})로 자동 조정됩니다.
        </div>
      )}

      {/* 에러 배너 */}
      {hasError && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 flex items-center gap-2">
          <ExclamationTriangleIcon className="h-4 w-4 text-rose-600 shrink-0" />
          <span className="text-2xs text-rose-800">
            환율 데이터를 불러오지 못했습니다 — 백엔드 프록시 또는 Frankfurter(ECB) API 응답 실패. 잠시 후 다시 시도하세요.
            {frankfurterQuery.error && (
              <span className="block mt-0.5 text-rose-600 font-mono">
                {(frankfurterQuery.error as any)?.response?.data?.detail ??
                  (frankfurterQuery.error as any)?.message}
              </span>
            )}
          </span>
          <button
            className="btn-secondary text-2xs ml-auto"
            onClick={() => {
              granterQuery.refetch()
              frankfurterQuery.refetch()
            }}
          >
            재시도
          </button>
        </div>
      )}

      {/* 통화 선택 토글 */}
      <div className="panel px-3 py-2">
        <div className="text-2xs font-semibold text-ink-500 uppercase tracking-wider mb-1.5">
          통화 선택
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {ALL_CURRENCIES.map((code) => {
            const meta = CURRENCY_META[code]
            const active = selectedCurrencies.has(code)
            const color = CURRENCY_COLORS[code]
            return (
              <button
                key={code}
                onClick={() => toggleCurrency(code)}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-2xs font-medium transition ${
                  active
                    ? 'text-white border-transparent'
                    : 'bg-white text-ink-500 border-ink-200 hover:border-ink-400'
                }`}
                style={active ? { backgroundColor: color, borderColor: color } : undefined}
              >
                <span>{meta.flag}</span>
                <span>{code}</span>
                {code === 'JPY' && <span className="opacity-70">(100엔)</span>}
              </button>
            )
          })}
        </div>
      </div>

      {/* KPI 카드 — 현재 환율 */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
        {ALL_CURRENCIES.filter((c) => selectedCurrencies.has(c)).map((code) => {
          // 그랜터 최신값 우선, 없으면 Frankfurter 마지막 포인트
          const currentRate =
            granterLatestMap[code] ?? latestPoint?.rates[code]
          const prevRate = prevPoint?.rates[code]
          return (
            <RateKpiCard
              key={code}
              currency={code}
              currentRate={currentRate}
              prevRate={prevRate}
            />
          )
        })}
      </div>

      {/* 메인 차트 */}
      <div className="panel p-3">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-ink-800">환율 시계열 (원화 기준)</h2>
          <span className="text-2xs text-ink-400">
            {effectiveFrom} ~ {to}
          </span>
        </div>

        {isLoading ? (
          <div className="h-60 flex items-center justify-center text-2xs text-ink-400">
            데이터 불러오는 중…
          </div>
        ) : chartData.length === 0 ? (
          <div className="h-60 flex items-center justify-center text-2xs text-ink-400">
            {frankfurterQuery.isError
              ? '백엔드 프록시 오류 — 잠시 후 재시도하세요.'
              : '선택 기간에 해당하는 영업일 데이터가 없습니다.'}
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e4e4e7" />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 9, fill: '#a1a1aa' }}
                interval={tickInterval}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                tick={{ fontSize: 9, fill: '#a1a1aa' }}
                tickFormatter={(v) =>
                  new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 0 }).format(v)
                }
                tickLine={false}
                axisLine={false}
                width={52}
                domain={yDomain}
              />
              <Tooltip content={<ChartTooltip />} />
              <Legend
                wrapperStyle={{ fontSize: '10px', paddingTop: '8px' }}
                formatter={(value) => {
                  const meta = CURRENCY_META[value]
                  return `${meta?.flag ?? ''} ${value}${value === 'JPY' ? ' (100엔)' : ''}`
                }}
              />
              {ALL_CURRENCIES.filter((c) => selectedCurrencies.has(c)).map((code) => (
                <Line
                  key={code}
                  type="monotone"
                  dataKey={code}
                  stroke={CURRENCY_COLORS[code]}
                  strokeWidth={1.5}
                  dot={false}
                  connectNulls
                  name={code}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* 시계열 데이터 테이블 */}
      {timeSeriesData.length > 0 && (
        <div className="panel overflow-hidden">
          <div className="px-3 py-2 border-b border-ink-200 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-ink-800">날짜별 환율 상세</h2>
            <span className="text-2xs text-ink-400">{timeSeriesData.length}일</span>
          </div>
          <div className="overflow-x-auto max-h-72 overflow-y-auto">
            <table className="min-w-full">
              <thead className="bg-canvas-50 sticky top-0 z-10">
                <tr>
                  <th className="px-3 py-1.5 text-left text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                    날짜
                  </th>
                  {ALL_CURRENCIES.filter((c) => selectedCurrencies.has(c)).map((code) => (
                    <th
                      key={code}
                      className="px-3 py-1.5 text-right text-2xs font-semibold text-ink-500 uppercase tracking-wider whitespace-nowrap"
                    >
                      {CURRENCY_META[code]?.flag} {code}
                      {code === 'JPY' ? ' (100엔)' : ''}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {[...timeSeriesData].reverse().map((point) => {
                  return (
                    <tr key={point.date} className="hover:bg-canvas-50">
                      <td className="px-3 py-1.5 font-mono text-2xs text-ink-600 whitespace-nowrap">
                        {point.date}
                      </td>
                      {ALL_CURRENCIES.filter((c) => selectedCurrencies.has(c)).map((code) => {
                        const val = point.rates[code]
                        return (
                          <td
                            key={code}
                            className="px-3 py-1.5 text-right font-mono tabular-nums text-xs text-ink-800"
                          >
                            {val !== undefined
                              ? new Intl.NumberFormat('ko-KR', {
                                  maximumFractionDigits: 2,
                                }).format(val)
                              : <span className="text-ink-200">-</span>}
                          </td>
                        )
                      })}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 푸터 */}
      <p className="text-2xs text-ink-400 pb-2">
        시계열 데이터: Frankfurter API (ECB 공식 환율) 기준. JPY는 100엔 단위 표시.
        그랜터 API 최신 환율은 KPI 카드에 반영됩니다.
      </p>
    </div>
  )
}
