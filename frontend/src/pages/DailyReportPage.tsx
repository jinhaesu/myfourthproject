import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  ArrowPathIcon,
  ArrowDownLeftIcon,
  ArrowUpRightIcon,
  SunIcon,
  ExclamationTriangleIcon,
  CheckCircleIcon,
  BuildingLibraryIcon,
} from '@heroicons/react/24/outline'
import { granterApi } from '@/services/api'
import { formatCurrency, isoLocal, formatLastUpdated } from '@/utils/format'
import PeriodPicker from '@/components/common/PeriodPicker'
import { usePeriodStore } from '@/store/periodStore'

function daysBetween(a: string, b: string) {
  return Math.floor((new Date(b).getTime() - new Date(a).getTime()) / 86400000) + 1
}

export default function DailyReportPage() {
  const preset = usePeriodStore((s) => s.preset)
  const from = usePeriodStore((s) => s.from)
  const to = usePeriodStore((s) => s.to)
  const setPeriod = usePeriodStore((s) => s.set)
  const [useCurrentRate, setUseCurrentRate] = useState(false)

  const ready = Boolean(from && to)
  const exceeds31 = ready && daysBetween(from, to) > 31

  const healthQuery = useQuery({
    queryKey: ['granter-health'],
    queryFn: () => granterApi.health().then((r) => r.data),
    retry: false,
  })
  const isConfigured = healthQuery.data?.configured

  const reportQuery = useQuery({
    queryKey: ['granter-daily-report', from, to, useCurrentRate],
    queryFn: () => {
      let actualStart = from
      if (exceeds31) {
        const d = new Date(to)
        d.setDate(d.getDate() - 30)
        actualStart = isoLocal(d)
      }
      return granterApi
        .getDailyReport({
          startDate: actualStart,
          endDate: to,
          useCurrentExchangeRate: useCurrentRate,
        })
        .then((r) => r.data)
    },
    enabled: !!isConfigured && ready,
    retry: false,
  })

  const data = reportQuery.data
  const total = data?.total || {}
  const assets: any[] = data?.assets || []
  const currencyTotals: any[] = data?.currencyTotals || []

  // 대출 제외 + 대출 분리
  const nonLoanAssets = useMemo(() => assets.filter((a) => !a.isLoan), [assets])
  const loanAssets = useMemo(() => assets.filter((a) => a.isLoan), [assets])

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-end justify-between flex-wrap gap-2">
        <div>
          <h1 className="flex items-center gap-2">
            <SunIcon className="h-4 w-4 text-ink-500" />
            자금일보
          </h1>
          <p className="text-2xs text-ink-500 mt-0.5">
            그랜터 daily-financial-report 기반 — 자산별 일별 잔액·입출금·대출 분리
          </p>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          {/* 공통 날짜 프리셋 피커 */}
          <PeriodPicker
            preset={preset}
            from={from}
            to={to}
            onChange={(p, f, t) => setPeriod(p, f, t)}
            groups={[
              { label: '일/주', presets: ['today', 'yesterday', 'this_week', 'last_week'] },
              { label: '월', presets: ['this_month', 'last_month'] },
              { label: '범위', presets: ['last_7d', 'last_30d'] },
            ]}
          />
          <label className="flex items-center gap-1 text-2xs text-ink-600 cursor-pointer px-2">
            <input
              type="checkbox"
              checked={useCurrentRate}
              onChange={(e) => setUseCurrentRate(e.target.checked)}
              className="rounded border-ink-300 text-ink-900 focus:ring-ink-300 w-3 h-3"
            />
            현재 환율 통일
          </label>
          {reportQuery.dataUpdatedAt > 0 && (
            <span className="text-2xs text-ink-400 font-mono px-1">
              업데이트 {formatLastUpdated(reportQuery.dataUpdatedAt)}
            </span>
          )}
          <button
            onClick={async () => {
              try { await granterApi.clearCache() } catch { /* 무시 */ }
              await reportQuery.refetch()
            }}
            disabled={reportQuery.isFetching}
            className="btn-secondary"
          >
            <ArrowPathIcon className={`h-3 w-3 ${reportQuery.isFetching ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {!isConfigured ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 flex items-center gap-2">
          <ExclamationTriangleIcon className="h-4 w-4 text-amber-600" />
          <div className="text-2xs text-amber-800">그랜터 API 키 미설정 — Railway 환경변수 등록 필요</div>
        </div>
      ) : (
        <div className="flex items-center gap-2 flex-wrap">
          <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-1 flex items-center gap-2">
            <CheckCircleIcon className="h-3.5 w-3.5 text-emerald-600" />
            <span className="text-2xs text-emerald-800">그랜터 연결됨</span>
          </div>
          {data?.effectiveEndDate && data?.previousDate && (
            <div className="text-2xs text-ink-500">
              실제 종료일 <span className="font-mono text-ink-700">{data.effectiveEndDate}</span> · 이전 기준일{' '}
              <span className="font-mono text-ink-700">{data.previousDate}</span>
            </div>
          )}
          {exceeds31 && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-1 text-2xs text-amber-800">
              31일 초과 — 종료일 기준 최근 31일만 자동 조회
            </div>
          )}
        </div>
      )}

      {/* KPI cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
        <KPI label="이전 잔액" value={total.previousBalance} />
        <KPI label="현재 잔액" value={total.currentBalance} highlight />
        <KPI label="증감" value={total.difference} delta />
        <KPI label="입금 합계" value={total.inAmount} tone="success" icon={<ArrowDownLeftIcon className="h-3 w-3" />} />
        <KPI label="출금 합계" value={total.outAmount} tone="danger" icon={<ArrowUpRightIcon className="h-3 w-3" />} />
      </div>

      {/* 대출 분리 */}
      {(total.loanBalance > 0 || loanAssets.length > 0) && (
        <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
          <KPI label="대출 잔액" value={total.loanBalance} tone="warning" />
          <KPI label="순포지션 (잔액 − 대출)" value={total.netPosition} tone="primary" highlight />
          <KPI label="대출 계좌 수" value={loanAssets.length} unit="개" />
        </div>
      )}

      {/* 통화별 합계 */}
      {currencyTotals.length > 1 && (
        <div className="panel p-3">
          <div className="text-2xs font-semibold text-ink-500 uppercase tracking-wider mb-2">
            통화별 합계
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            {currencyTotals.map((c) => (
              <div key={c.currencyCode} className="border border-ink-200 rounded p-2">
                <div className="text-2xs text-ink-500">{c.currencyCode}</div>
                <div className="font-mono tabular-nums font-semibold text-ink-900">
                  {formatCurrency(c.currentBalance, false)}
                </div>
                <div className="text-2xs text-ink-400 mt-0.5">
                  Δ {formatCurrency(c.difference, false)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 자산별 표 */}
      <div className="panel overflow-hidden">
        <div className="px-3 py-2 border-b border-ink-200 flex items-center justify-between">
          <h2 className="text-sm flex items-center gap-1.5">
            <BuildingLibraryIcon className="h-3.5 w-3.5 text-ink-500" />
            계좌별 잔액 (대출 제외)
          </h2>
          <span className="text-2xs text-ink-400">{nonLoanAssets.length}개 계좌</span>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full">
            <thead className="bg-canvas-50">
              <tr>
                <th className="px-3 py-1.5 text-left text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                  자산
                </th>
                <th className="px-3 py-1.5 text-left text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                  계좌번호
                </th>
                <th className="px-3 py-1.5 text-left text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                  통화
                </th>
                <th className="px-3 py-1.5 text-right text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                  이전 잔액
                </th>
                <th className="px-3 py-1.5 text-right text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                  현재 잔액
                </th>
                <th className="px-3 py-1.5 text-right text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                  증감
                </th>
                <th className="px-3 py-1.5 text-right text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                  입금
                </th>
                <th className="px-3 py-1.5 text-right text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                  출금
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {reportQuery.isLoading && (
                <tr>
                  <td colSpan={8} className="text-center py-6 text-2xs text-ink-400">
                    불러오는 중…
                  </td>
                </tr>
              )}
              {!reportQuery.isLoading &&
                nonLoanAssets.map((a) => {
                  const diff = Number(a.difference || 0)
                  return (
                    <tr key={a.assetId} className="hover:bg-canvas-50">
                      <td className="px-3 py-1.5 text-xs">
                        <div className="font-medium text-ink-900">{a.assetName}</div>
                        <div className="text-2xs text-ink-500">{a.organizationName}</div>
                      </td>
                      <td className="px-3 py-1.5 font-mono text-2xs text-ink-700">{a.assetNumber}</td>
                      <td className="px-3 py-1.5 text-2xs">
                        <span className="badge bg-ink-50 text-ink-700 border-ink-200">
                          {a.currencyCode}
                        </span>
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono tabular-nums text-xs text-ink-600">
                        {formatCurrency(a.previousBalance, false)}
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono tabular-nums text-xs font-semibold text-ink-900">
                        {formatCurrency(a.currentBalance, false)}
                      </td>
                      <td
                        className={`px-3 py-1.5 text-right font-mono tabular-nums text-xs font-semibold ${
                          diff >= 0 ? 'text-emerald-700' : 'text-rose-700'
                        }`}
                      >
                        {diff >= 0 ? '+' : ''}
                        {formatCurrency(diff, false)}
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono tabular-nums text-xs text-emerald-700">
                        {Number(a.inAmount) > 0 ? formatCurrency(a.inAmount, false) : <span className="text-ink-200">-</span>}
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono tabular-nums text-xs text-rose-700">
                        {Number(a.outAmount) !== 0 ? formatCurrency(Math.abs(Number(a.outAmount)), false) : <span className="text-ink-200">-</span>}
                      </td>
                    </tr>
                  )
                })}
              {!reportQuery.isLoading && nonLoanAssets.length === 0 && (
                <tr>
                  <td colSpan={8} className="text-center py-6 text-2xs text-ink-400">
                    이 기간에 데이터가 없습니다.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* 대출 계좌 별도 표 */}
      {loanAssets.length > 0 && (
        <div className="panel overflow-hidden">
          <div className="px-3 py-2 border-b border-ink-200 bg-amber-50/40">
            <h2 className="text-sm">대출 계좌 (잔액 합계와 별도)</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full">
              <thead className="bg-canvas-50">
                <tr>
                  <th className="px-3 py-1.5 text-left text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                    자산
                  </th>
                  <th className="px-3 py-1.5 text-left text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                    계좌번호
                  </th>
                  <th className="px-3 py-1.5 text-right text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                    이전
                  </th>
                  <th className="px-3 py-1.5 text-right text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                    현재
                  </th>
                  <th className="px-3 py-1.5 text-right text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                    증감
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {loanAssets.map((a) => {
                  const diff = Number(a.difference || 0)
                  return (
                    <tr key={a.assetId} className="hover:bg-canvas-50">
                      <td className="px-3 py-1.5 text-xs">
                        <div className="font-medium text-ink-900">{a.assetName}</div>
                        <div className="text-2xs text-ink-500">{a.organizationName}</div>
                      </td>
                      <td className="px-3 py-1.5 font-mono text-2xs text-ink-700">{a.assetNumber}</td>
                      <td className="px-3 py-1.5 text-right font-mono tabular-nums text-xs text-ink-600">
                        {formatCurrency(a.previousBalance, false)}
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono tabular-nums text-xs font-semibold text-amber-700">
                        {formatCurrency(a.currentBalance, false)}
                      </td>
                      <td
                        className={`px-3 py-1.5 text-right font-mono tabular-nums text-xs font-semibold ${
                          diff >= 0 ? 'text-amber-700' : 'text-emerald-700'
                        }`}
                      >
                        {diff >= 0 ? '+' : ''}
                        {formatCurrency(diff, false)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

function KPI({
  label,
  value,
  unit = '원',
  tone = 'neutral',
  highlight = false,
  delta = false,
  icon,
}: {
  label: string
  value: number | undefined
  unit?: string
  tone?: 'neutral' | 'primary' | 'success' | 'danger' | 'warning'
  highlight?: boolean
  delta?: boolean
  icon?: React.ReactNode
}) {
  const v = Number(value || 0)
  const toneClass: Record<string, string> = {
    neutral: 'text-ink-900',
    primary: 'text-primary-700',
    success: 'text-emerald-700',
    danger: 'text-rose-700',
    warning: 'text-amber-700',
  }
  let deltaClass = ''
  if (delta) deltaClass = v >= 0 ? 'text-emerald-700' : 'text-rose-700'
  return (
    <div className={`panel px-3 py-2 ${highlight ? 'border-ink-900 border-2' : ''}`}>
      <div className="text-2xs font-medium text-ink-500 uppercase tracking-wider flex items-center gap-1">
        {icon}
        {label}
      </div>
      <div
        className={`mt-0.5 font-mono tabular-nums font-bold ${highlight ? 'text-base' : 'text-sm'} ${
          delta ? deltaClass : toneClass[tone]
        }`}
      >
        {delta && v >= 0 && '+'}
        {formatCurrency(Math.abs(v), false)}
        {unit !== '원' && <span className="text-2xs text-ink-400 ml-1 font-medium">{unit}</span>}
      </div>
    </div>
  )
}
