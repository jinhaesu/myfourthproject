import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Cog6ToothIcon,
  BuildingLibraryIcon,
  CreditCardIcon,
  DocumentTextIcon,
  ArrowsRightLeftIcon,
  ArrowDownLeftIcon,
  ArrowUpRightIcon,
  XMarkIcon,
  ArrowPathIcon,
  PlusIcon,
} from '@heroicons/react/24/outline'
import { unifiedApi, ledgerApi } from '@/services/api'
import { formatCurrency, formatCompactWon } from '@/utils/format'

type PeriodPreset = 'today' | 'this_week' | 'this_month' | 'this_quarter' | 'this_year' | 'custom'

const PRESET_LABEL: Record<PeriodPreset, string> = {
  today: '오늘',
  this_week: '이번주',
  this_month: '이번달',
  this_quarter: '이번분기',
  this_year: '이번년도',
  custom: '사용자',
}

function periodForPreset(preset: PeriodPreset, refYear?: number): { start: string; end: string } {
  const today = new Date()
  if (refYear && (preset === 'this_year' || preset === 'this_quarter' || preset === 'this_month')) {
    today.setFullYear(refYear)
  }
  const y = today.getFullYear()
  const m = today.getMonth()
  const d = today.getDate()

  switch (preset) {
    case 'today':
      return { start: today.toISOString().slice(0, 10), end: today.toISOString().slice(0, 10) }
    case 'this_week': {
      const dayOfWeek = today.getDay() || 7
      const monday = new Date(today)
      monday.setDate(d - dayOfWeek + 1)
      return { start: monday.toISOString().slice(0, 10), end: today.toISOString().slice(0, 10) }
    }
    case 'this_month':
      return {
        start: new Date(y, m, 1).toISOString().slice(0, 10),
        end: today.toISOString().slice(0, 10),
      }
    case 'this_quarter': {
      const qStart = Math.floor(m / 3) * 3
      return {
        start: new Date(y, qStart, 1).toISOString().slice(0, 10),
        end: today.toISOString().slice(0, 10),
      }
    }
    case 'this_year':
      return { start: `${y}-01-01`, end: `${y}-12-31` }
    default:
      return { start: '', end: '' }
  }
}

interface SelectedSource {
  type: 'cash' | 'bank' | 'card' | 'tax_sales' | 'tax_purchase'
  source_account_code?: string
  merchant_name?: string
  label: string
}

export default function UnifiedViewPage() {
  // 가용 년도 자동 감지 — 데이터에 맞게 default
  const yearsQuery = useQuery({
    queryKey: ['ledger-years'],
    queryFn: () => ledgerApi.getAvailableYears().then((r) => r.data),
  })
  const latestYear: number | null = yearsQuery.data?.latest ?? null

  const [preset, setPreset] = useState<PeriodPreset>('this_year')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [showSettings, setShowSettings] = useState(false)
  const [selected, setSelected] = useState<SelectedSource | null>(null)

  useEffect(() => {
    if (latestYear && (!from || !to)) {
      setFrom(`${latestYear}-01-01`)
      setTo(`${latestYear}-12-31`)
      setPreset('this_year')
    }
  }, [latestYear]) // eslint-disable-line react-hooks/exhaustive-deps

  const ready = Boolean(from && to)

  const dashboardQuery = useQuery({
    queryKey: ['unified-dashboard', from, to],
    queryFn: () =>
      unifiedApi.getDashboard({ period_start: from, period_end: to }).then((r) => r.data),
    enabled: ready,
  })

  const txQuery = useQuery({
    queryKey: ['unified-source-tx', selected, from, to],
    queryFn: () =>
      unifiedApi
        .getSourceTransactions({
          source_account_code: selected?.source_account_code,
          merchant_name: selected?.merchant_name,
          period_start: from,
          period_end: to,
          size: 200,
        })
        .then((r) => r.data),
    enabled: ready && !!selected,
  })

  const dash = dashboardQuery.data
  const tx = txQuery.data

  const handlePreset = (p: PeriodPreset) => {
    setPreset(p)
    if (p !== 'custom') {
      const r = periodForPreset(p, latestYear || undefined)
      if (r.start) setFrom(r.start)
      if (r.end) setTo(r.end)
    }
  }

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-end justify-between flex-wrap gap-2">
        <div>
          <h1>통합 조회</h1>
          <p className="text-2xs text-ink-500 mt-0.5">
            가용자금 · 입출금 · 카드 · 세금계산서를 한 화면에서
          </p>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <div className="flex items-center gap-0.5 p-0.5 rounded-md bg-white border border-ink-200">
            {(['today', 'this_week', 'this_month', 'this_quarter', 'this_year'] as PeriodPreset[]).map((p) => (
              <button
                key={p}
                onClick={() => handlePreset(p)}
                className={`px-2 py-1 rounded text-2xs font-semibold transition ${
                  preset === p
                    ? 'bg-ink-900 text-white'
                    : 'text-ink-600 hover:bg-ink-50'
                }`}
              >
                {PRESET_LABEL[p]}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1 px-2 py-1 rounded-md bg-white border border-ink-200">
            <input
              type="date"
              value={from}
              onChange={(e) => {
                setFrom(e.target.value)
                setPreset('custom')
              }}
              className="bg-transparent text-2xs text-ink-700 w-24 focus:outline-none"
            />
            <span className="text-ink-300">→</span>
            <input
              type="date"
              value={to}
              onChange={(e) => {
                setTo(e.target.value)
                setPreset('custom')
              }}
              className="bg-transparent text-2xs text-ink-700 w-24 focus:outline-none"
            />
          </div>
          <button onClick={() => dashboardQuery.refetch()} className="btn-secondary" title="새로고침">
            <ArrowPathIcon className="h-3 w-3" />
          </button>
          <button onClick={() => setShowSettings(true)} className="btn-secondary">
            <Cog6ToothIcon className="h-3 w-3 mr-1" />
            설정
          </button>
        </div>
      </div>

      {/* 2-pane layout */}
      <div className="grid grid-cols-12 gap-3 min-h-[calc(100vh-9rem)]">
        {/* Left — sidebar cards */}
        <aside className="col-span-12 lg:col-span-5 xl:col-span-4 space-y-3 overflow-y-auto">
          {/* 가용자금 (큰 카드) */}
          <div className="panel p-4">
            <div className="text-2xs text-ink-500 font-semibold uppercase tracking-wider">
              가용자금
            </div>
            <div className="mt-1 text-2xl font-bold text-ink-900 tabular-nums tracking-crisp">
              {formatCurrency(dash?.available_cash?.total || 0, false)}
              <span className="text-xs text-ink-400 font-medium ml-1">원</span>
            </div>
            {dash?.available_cash?.breakdown?.length > 0 && (
              <div className="mt-3 space-y-1.5">
                {dash.available_cash.breakdown.map((b: any) => {
                  const isActive =
                    selected?.type === 'cash' && selected?.source_account_code === b.code
                  return (
                    <button
                      key={b.code}
                      onClick={() =>
                        setSelected({
                          type: 'cash',
                          source_account_code: b.code,
                          label: `${b.name} (${b.code})`,
                        })
                      }
                      className={`w-full flex items-center justify-between px-2 py-1 rounded text-2xs transition ${
                        isActive ? 'bg-ink-900 text-white' : 'hover:bg-ink-50'
                      }`}
                    >
                      <span className="flex items-center gap-1.5">
                        <span className="font-mono text-ink-400">{b.code}</span>
                        <span className={isActive ? 'font-semibold' : 'text-ink-700'}>
                          {b.name}
                        </span>
                      </span>
                      <span className="font-mono tabular-nums font-semibold">
                        {formatCompactWon(b.balance)}
                      </span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          {/* 통장별 */}
          <Section
            title="입출금 통장"
            icon={<BuildingLibraryIcon className="h-3.5 w-3.5" />}
            count={dash?.bank_accounts?.length || 0}
          >
            {(dash?.bank_accounts || []).slice(0, 12).map((b: any, idx: number) => {
              const isActive =
                selected?.type === 'bank' &&
                selected?.merchant_name === b.merchant_name &&
                selected?.source_account_code === b.source_code
              return (
                <button
                  key={`${b.merchant_name}-${idx}`}
                  onClick={() =>
                    setSelected({
                      type: 'bank',
                      source_account_code: b.source_code,
                      merchant_name: b.merchant_name,
                      label: b.merchant_name,
                    })
                  }
                  className={`w-full flex items-center justify-between px-2 py-1.5 rounded text-2xs transition ${
                    isActive
                      ? 'bg-ink-900 text-white'
                      : 'hover:bg-ink-50 border-l-2 border-transparent'
                  }`}
                >
                  <div className="text-left min-w-0 flex-1">
                    <div className={`truncate ${isActive ? 'font-semibold' : 'text-ink-700 font-medium'}`}>
                      {b.merchant_name || '-'}
                    </div>
                    <div className={`text-2xs ${isActive ? 'text-ink-300' : 'text-ink-400'}`}>
                      {b.count.toLocaleString('ko-KR')}건
                    </div>
                  </div>
                  <div className="text-right ml-2 flex-shrink-0">
                    <div className={`font-mono tabular-nums font-semibold ${
                      isActive ? '' : Number(b.balance) >= 0 ? 'text-ink-900' : 'text-rose-600'
                    }`}>
                      {formatCompactWon(b.balance)}
                    </div>
                  </div>
                </button>
              )
            })}
            {(dash?.bank_accounts || []).length === 0 && (
              <div className="text-2xs text-ink-400 px-2 py-2">통장 데이터 없음</div>
            )}
          </Section>

          {/* 카드 */}
          <Section
            title="신용카드 사용"
            icon={<CreditCardIcon className="h-3.5 w-3.5" />}
            count={dash?.cards?.length || 0}
          >
            {(dash?.cards || []).slice(0, 12).map((c: any, idx: number) => {
              const isActive =
                selected?.type === 'card' &&
                selected?.merchant_name === c.merchant_name &&
                selected?.source_account_code === c.source_code
              return (
                <button
                  key={`${c.merchant_name}-${idx}`}
                  onClick={() =>
                    setSelected({
                      type: 'card',
                      source_account_code: c.source_code,
                      merchant_name: c.merchant_name,
                      label: c.merchant_name,
                    })
                  }
                  className={`w-full flex items-center justify-between px-2 py-1.5 rounded text-2xs transition ${
                    isActive ? 'bg-ink-900 text-white' : 'hover:bg-ink-50'
                  }`}
                >
                  <div className="text-left min-w-0 flex-1">
                    <div className={`truncate ${isActive ? 'font-semibold' : 'text-ink-700 font-medium'}`}>
                      {c.merchant_name || '-'}
                    </div>
                    <div className={`text-2xs ${isActive ? 'text-ink-300' : 'text-ink-400'}`}>
                      {c.count.toLocaleString('ko-KR')}건 · 미결제 {formatCompactWon(c.outstanding)}
                    </div>
                  </div>
                  <div className="text-right ml-2 flex-shrink-0">
                    <div className="font-mono tabular-nums font-semibold">
                      {formatCompactWon(c.usage)}
                    </div>
                  </div>
                </button>
              )
            })}
            {(dash?.cards || []).length === 0 && (
              <div className="text-2xs text-ink-400 px-2 py-2">카드 데이터 없음</div>
            )}
          </Section>

          {/* 세금계산서 요약 */}
          <Section
            title="세금계산서"
            icon={<DocumentTextIcon className="h-3.5 w-3.5" />}
          >
            <button
              onClick={() =>
                setSelected({
                  type: 'tax_sales',
                  source_account_code: '108',
                  label: '매출 세금계산서',
                })
              }
              className={`w-full flex items-center justify-between px-2 py-2 rounded text-2xs transition ${
                selected?.type === 'tax_sales' ? 'bg-ink-900 text-white' : 'hover:bg-ink-50'
              }`}
            >
              <div className="text-left">
                <div className={selected?.type === 'tax_sales' ? 'font-semibold' : 'text-ink-700 font-medium'}>
                  매출 (외상매출금)
                </div>
                <div className={`text-2xs ${selected?.type === 'tax_sales' ? 'text-ink-300' : 'text-ink-400'}`}>
                  {dash?.tax_invoice?.sales?.count?.toLocaleString('ko-KR') || 0}건
                </div>
              </div>
              <div className="text-right">
                <div className="font-mono tabular-nums font-semibold text-emerald-700">
                  {formatCompactWon(dash?.tax_invoice?.sales?.outstanding)}
                </div>
                <div className={`text-2xs ${selected?.type === 'tax_sales' ? 'text-ink-300' : 'text-ink-400'}`}>
                  미회수
                </div>
              </div>
            </button>
            <button
              onClick={() =>
                setSelected({
                  type: 'tax_purchase',
                  source_account_code: '251',
                  label: '매입 세금계산서',
                })
              }
              className={`w-full flex items-center justify-between px-2 py-2 rounded text-2xs transition ${
                selected?.type === 'tax_purchase' ? 'bg-ink-900 text-white' : 'hover:bg-ink-50'
              }`}
            >
              <div className="text-left">
                <div className={selected?.type === 'tax_purchase' ? 'font-semibold' : 'text-ink-700 font-medium'}>
                  매입 (외상매입금)
                </div>
                <div className={`text-2xs ${selected?.type === 'tax_purchase' ? 'text-ink-300' : 'text-ink-400'}`}>
                  {dash?.tax_invoice?.purchase?.count?.toLocaleString('ko-KR') || 0}건
                </div>
              </div>
              <div className="text-right">
                <div className="font-mono tabular-nums font-semibold text-rose-700">
                  {formatCompactWon(dash?.tax_invoice?.purchase?.outstanding)}
                </div>
                <div className={`text-2xs ${selected?.type === 'tax_purchase' ? 'text-ink-300' : 'text-ink-400'}`}>
                  미지급
                </div>
              </div>
            </button>
          </Section>
        </aside>

        {/* Right — selected source's transactions */}
        <main className="col-span-12 lg:col-span-7 xl:col-span-8">
          <div className="panel h-full flex flex-col overflow-hidden">
            <div className="px-3 py-2 border-b border-ink-200 flex items-center justify-between">
              <div className="flex items-center gap-2 min-w-0">
                <ArrowsRightLeftIcon className="h-3.5 w-3.5 text-ink-500" />
                <h2 className="text-sm">{selected?.label || '거래 내역'}</h2>
                {tx && (
                  <span className="text-2xs text-ink-400">
                    · {tx.total?.toLocaleString('ko-KR')}건
                  </span>
                )}
              </div>
            </div>

            {!selected ? (
              <div className="flex-1 flex items-center justify-center text-2xs text-ink-400 p-6 text-center">
                좌측에서 통장·카드·세금계산서를 클릭하면 거래 내역이 여기 표시됩니다.
              </div>
            ) : txQuery.isLoading ? (
              <div className="flex-1 flex items-center justify-center text-2xs text-ink-400">
                불러오는 중…
              </div>
            ) : (
              <div className="flex-1 overflow-y-auto">
                <table className="min-w-full">
                  <thead className="bg-canvas-50 sticky top-0 z-10">
                    <tr>
                      <th className="px-3 py-1.5 text-left text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                        날짜
                      </th>
                      <th className="px-3 py-1.5 text-left text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                        적요
                      </th>
                      <th className="px-3 py-1.5 text-left text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                        상대 계정
                      </th>
                      <th className="px-3 py-1.5 text-right text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                        <span className="inline-flex items-center gap-0.5">
                          <ArrowDownLeftIcon className="h-2.5 w-2.5 text-primary-500" />
                          차변
                        </span>
                      </th>
                      <th className="px-3 py-1.5 text-right text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                        <span className="inline-flex items-center gap-0.5">
                          <ArrowUpRightIcon className="h-2.5 w-2.5 text-rose-500" />
                          대변
                        </span>
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-100">
                    {(tx?.items || []).map((it: any) => (
                      <tr key={it.id} className="hover:bg-canvas-50">
                        <td className="px-3 py-1.5 whitespace-nowrap text-2xs text-ink-700 font-mono">
                          {it.transaction_date}
                        </td>
                        <td className="px-3 py-1.5 text-xs text-ink-900">
                          {it.description}
                        </td>
                        <td className="px-3 py-1.5 whitespace-nowrap">
                          {it.counterparty_account_code ? (
                            <span className="inline-flex items-center gap-1 text-2xs">
                              <span className="font-mono text-ink-400">
                                {it.counterparty_account_code}
                              </span>
                              <span className="text-ink-700">
                                {it.counterparty_account_name}
                              </span>
                            </span>
                          ) : (
                            <span className="text-ink-300 text-2xs">-</span>
                          )}
                        </td>
                        <td className="px-3 py-1.5 text-right font-mono tabular-nums whitespace-nowrap">
                          {Number(it.debit) > 0 ? (
                            <span className="text-primary-700 font-semibold">
                              {formatCurrency(it.debit, false)}
                            </span>
                          ) : (
                            <span className="text-ink-200">-</span>
                          )}
                        </td>
                        <td className="px-3 py-1.5 text-right font-mono tabular-nums whitespace-nowrap">
                          {Number(it.credit) > 0 ? (
                            <span className="text-rose-700 font-semibold">
                              {formatCurrency(it.credit, false)}
                            </span>
                          ) : (
                            <span className="text-ink-200">-</span>
                          )}
                        </td>
                      </tr>
                    ))}
                    {tx?.items?.length === 0 && (
                      <tr>
                        <td colSpan={5} className="px-3 py-6 text-center text-2xs text-ink-400">
                          이 기간에 거래 내역이 없습니다.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </main>
      </div>

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
    </div>
  )
}

function Section({
  title,
  icon,
  count,
  children,
}: {
  title: string
  icon: React.ReactNode
  count?: number
  children: React.ReactNode
}) {
  return (
    <div className="panel">
      <div className="px-3 py-2 border-b border-ink-200 flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-2xs font-semibold text-ink-700 uppercase tracking-wider">
          {icon}
          <span>{title}</span>
        </div>
        {count !== undefined && count > 0 && (
          <span className="text-2xs text-ink-400 font-mono">{count}</span>
        )}
      </div>
      <div className="p-1.5 space-y-0.5">{children}</div>
    </div>
  )
}

function SettingsModal({ onClose }: { onClose: () => void }) {
  const sourcesQuery = useQuery({
    queryKey: ['unified-sources'],
    queryFn: () => unifiedApi.listSources().then((r) => r.data),
  })

  return (
    <div className="fixed inset-0 z-50 bg-ink-900/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-pop w-full max-w-2xl max-h-[80vh] overflow-y-auto border border-ink-200">
        <div className="sticky top-0 bg-white border-b border-ink-200 px-4 py-2.5 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-ink-900">데이터 소스 연동 관리</h3>
          <button onClick={onClose} className="text-ink-400 hover:text-ink-700">
            <XMarkIcon className="h-4 w-4" />
          </button>
        </div>

        <div className="p-4 space-y-3">
          <div className="text-2xs text-ink-500">
            연동된 통장/카드/세금계산서 소스 목록입니다. 통장·카드는 그랜터, 세금계산서는 홈택스 직결로 수집됩니다.
          </div>
          <div className="space-y-1.5">
            {(sourcesQuery.data || []).map((s: any) => (
              <div
                key={s.id}
                className="flex items-center justify-between px-3 py-2 border border-ink-200 rounded"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-medium text-ink-900 truncate">{s.name}</div>
                  <div className="text-2xs text-ink-500">
                    {s.institution} ·{' '}
                    <span className={s.sync_status === 'ok' ? 'text-emerald-600' : 'text-rose-600'}>
                      {s.sync_status === 'ok' ? '정상' : s.sync_status}
                    </span>
                  </div>
                </div>
                <button className="btn-secondary text-2xs">
                  <ArrowPathIcon className="h-3 w-3" />
                </button>
              </div>
            ))}
            {(sourcesQuery.data || []).length === 0 && (
              <div className="text-center text-2xs text-ink-400 py-6">
                연동된 소스가 없습니다.
              </div>
            )}
          </div>
          <button className="btn-primary w-full justify-center">
            <PlusIcon className="h-3 w-3 mr-1" />
            소스 추가
          </button>
        </div>
      </div>
    </div>
  )
}
