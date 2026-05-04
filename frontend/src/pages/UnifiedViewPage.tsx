import { useEffect, useMemo, useState } from 'react'
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
  ExclamationTriangleIcon,
  CheckCircleIcon,
  CloudArrowDownIcon,
} from '@heroicons/react/24/outline'
import { granterApi } from '@/services/api'
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

function periodForPreset(preset: PeriodPreset): { start: string; end: string } {
  const today = new Date()
  const y = today.getFullYear()
  const m = today.getMonth()
  const d = today.getDate()
  const iso = (dt: Date) => dt.toISOString().slice(0, 10)
  switch (preset) {
    case 'today':
      return { start: iso(today), end: iso(today) }
    case 'this_week': {
      const dayOfWeek = today.getDay() || 7
      const monday = new Date(today)
      monday.setDate(d - dayOfWeek + 1)
      return { start: iso(monday), end: iso(today) }
    }
    case 'this_month':
      return { start: iso(new Date(y, m, 1)), end: iso(today) }
    case 'this_quarter': {
      const qStart = Math.floor(m / 3) * 3
      return { start: iso(new Date(y, qStart, 1)), end: iso(today) }
    }
    case 'this_year':
      return { start: `${y}-01-01`, end: `${y}-12-31` }
    default:
      return { start: '', end: '' }
  }
}

interface SelectedSource {
  type: 'all' | 'account' | 'card' | 'tax_sales' | 'tax_purchase' | 'cash_receipt'
  id?: string
  label: string
  kind?: string  // granter transactions kind 필터
}

function fieldNum(obj: any, ...keys: string[]): number {
  for (const k of keys) {
    const v = obj?.[k]
    if (v !== undefined && v !== null && v !== '') return Number(v) || 0
  }
  return 0
}

function fieldStr(obj: any, ...keys: string[]): string {
  for (const k of keys) {
    const v = obj?.[k]
    if (v !== undefined && v !== null && v !== '') return String(v)
  }
  return ''
}

export default function UnifiedViewPage() {
  const [preset, setPreset] = useState<PeriodPreset>('this_month')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [showSettings, setShowSettings] = useState(false)
  const [selected, setSelected] = useState<SelectedSource>({ type: 'all', label: '전체 거래' })

  useEffect(() => {
    const r = periodForPreset('this_month')
    setFrom(r.start)
    setTo(r.end)
  }, [])

  const ready = Boolean(from && to)

  // 그랜터 상태 확인
  const healthQuery = useQuery({
    queryKey: ['granter-health'],
    queryFn: () => granterApi.health().then((r) => r.data),
    retry: false,
  })
  const isConfigured = healthQuery.data?.configured

  // 그랜터 데이터들
  const accountsQuery = useQuery({
    queryKey: ['granter-accounts'],
    queryFn: () => granterApi.listAccounts().then((r) => r.data),
    enabled: !!isConfigured,
    retry: false,
  })
  const cardsQuery = useQuery({
    queryKey: ['granter-cards'],
    queryFn: () => granterApi.listCards().then((r) => r.data),
    enabled: !!isConfigured,
    retry: false,
  })
  const balancesQuery = useQuery({
    queryKey: ['granter-balances'],
    queryFn: () => granterApi.getBalances().then((r) => r.data),
    enabled: !!isConfigured,
    retry: false,
  })
  const taxSalesQuery = useQuery({
    queryKey: ['granter-tax-sales', from, to],
    queryFn: () =>
      granterApi
        .listTransactions({ from_date: from, to_date: to, kind: 'tax_invoice', limit: 200 })
        .then((r) => r.data),
    enabled: !!isConfigured && ready,
    retry: false,
  })

  const txQuery = useQuery({
    queryKey: ['granter-tx', selected, from, to],
    queryFn: () =>
      granterApi
        .listTransactions({
          from_date: from,
          to_date: to,
          kind: selected.kind,
          connection_id: selected.id,
          limit: 200,
        })
        .then((r) => r.data),
    enabled: !!isConfigured && ready,
    retry: false,
  })

  const accounts: any[] = useMemo(
    () => (Array.isArray(accountsQuery.data) ? accountsQuery.data : accountsQuery.data?.data || []),
    [accountsQuery.data]
  )
  const cards: any[] = useMemo(
    () => (Array.isArray(cardsQuery.data) ? cardsQuery.data : cardsQuery.data?.data || []),
    [cardsQuery.data]
  )
  const balances: any[] = useMemo(() => {
    const d = balancesQuery.data
    if (Array.isArray(d)) return d
    return d?.data || d?.balances || []
  }, [balancesQuery.data])

  const totalCash = useMemo(
    () => balances.reduce((s, b: any) => s + fieldNum(b, 'balance', 'amount', 'available'), 0),
    [balances]
  )

  const txItems: any[] = useMemo(() => {
    const d = txQuery.data
    if (Array.isArray(d)) return d
    return d?.data || []
  }, [txQuery.data])

  const taxSalesItems: any[] = useMemo(() => {
    const d = taxSalesQuery.data
    if (Array.isArray(d)) return d
    return d?.data || []
  }, [taxSalesQuery.data])

  const taxSalesSum = useMemo(
    () =>
      taxSalesItems
        .filter((t: any) => fieldStr(t, 'direction', 'type', 'kind').toLowerCase().includes('sale') || Number(fieldNum(t, 'amount')) > 0)
        .reduce((s, t: any) => s + fieldNum(t, 'amount', 'total', 'supply_amount'), 0),
    [taxSalesItems]
  )
  const taxPurchaseSum = useMemo(
    () =>
      taxSalesItems
        .filter((t: any) => fieldStr(t, 'direction', 'type', 'kind').toLowerCase().includes('purchase'))
        .reduce((s, t: any) => s + fieldNum(t, 'amount', 'total', 'supply_amount'), 0),
    [taxSalesItems]
  )

  const handlePreset = (p: PeriodPreset) => {
    setPreset(p)
    if (p !== 'custom') {
      const r = periodForPreset(p)
      setFrom(r.start)
      setTo(r.end)
    }
  }

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-end justify-between flex-wrap gap-2">
        <div>
          <h1>통합 조회</h1>
          <p className="text-2xs text-ink-500 mt-0.5">
            그랜터에서 실시간으로 받아오는 계좌·카드·세금계산서 거래 — 엑셀 업로드 데이터와 분리
          </p>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <div className="flex items-center gap-0.5 p-0.5 rounded-md bg-white border border-ink-200">
            {(['today', 'this_week', 'this_month', 'this_quarter', 'this_year'] as PeriodPreset[]).map(
              (p) => (
                <button
                  key={p}
                  onClick={() => handlePreset(p)}
                  className={`px-2 py-1 rounded text-2xs font-semibold transition ${
                    preset === p ? 'bg-ink-900 text-white' : 'text-ink-600 hover:bg-ink-50'
                  }`}
                >
                  {PRESET_LABEL[p]}
                </button>
              )
            )}
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
          <button onClick={() => txQuery.refetch()} className="btn-secondary" title="새로고침">
            <ArrowPathIcon className="h-3 w-3" />
          </button>
          <button onClick={() => setShowSettings(true)} className="btn-secondary">
            <Cog6ToothIcon className="h-3 w-3 mr-1" />
            설정
          </button>
        </div>
      </div>

      {/* Granter status banner */}
      {healthQuery.isLoading ? (
        <div className="panel px-3 py-2 text-2xs text-ink-500">그랜터 상태 확인 중…</div>
      ) : !isConfigured ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 flex items-start gap-2">
          <ExclamationTriangleIcon className="h-4 w-4 text-amber-600 flex-shrink-0 mt-0.5" />
          <div className="flex-1 text-2xs">
            <div className="font-semibold text-amber-900">그랜터 API 키 미설정</div>
            <div className="text-amber-800 mt-0.5">
              Railway 대시보드 → Variables 에서 <code className="font-mono bg-white px-1 rounded">GRANTER_API_KEY</code>를
              등록하면 실제 계좌·카드 거래가 자동으로 여기 표시됩니다.
            </div>
          </div>
        </div>
      ) : (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-1.5 flex items-center gap-2">
          <CheckCircleIcon className="h-3.5 w-3.5 text-emerald-600" />
          <div className="text-2xs text-emerald-800">
            그랜터 연결됨 · 실시간 거래 데이터 활성화
          </div>
        </div>
      )}

      {/* 2-pane layout */}
      <div className="grid grid-cols-12 gap-3 min-h-[calc(100vh-12rem)]">
        {/* Left — sidebar */}
        <aside className="col-span-12 lg:col-span-5 xl:col-span-4 space-y-3 overflow-y-auto">
          {/* 가용자금 */}
          <div className="panel p-4">
            <div className="text-2xs text-ink-500 font-semibold uppercase tracking-wider">
              가용자금
            </div>
            <div className="mt-1 text-2xl font-bold text-ink-900 tabular-nums tracking-crisp">
              {formatCurrency(totalCash, false)}
              <span className="text-xs text-ink-400 font-medium ml-1">원</span>
            </div>
            <div className="text-2xs text-ink-400 mt-0.5">
              그랜터 잔액 합계 · {balances.length}개 계좌
            </div>
          </div>

          {/* 계좌 */}
          <Section
            title="입출금 계좌"
            icon={<BuildingLibraryIcon className="h-3.5 w-3.5" />}
            count={accounts.length}
            onClickAll={() =>
              setSelected({ type: 'all', label: '계좌 전체', kind: 'account' })
            }
            allLabel="계좌 전체"
            isAllActive={selected.type === 'all' && selected.kind === 'account'}
          >
            {accounts.length === 0 && !accountsQuery.isLoading && (
              <div className="text-2xs text-ink-400 px-2 py-3 text-center">
                {isConfigured ? '연동된 계좌 없음' : '그랜터 미설정'}
              </div>
            )}
            {accounts.map((a: any, idx: number) => {
              const id = fieldStr(a, 'id', 'account_id', 'connection_id')
              const name =
                fieldStr(a, 'alias', 'name', 'institution', 'bank_name') ||
                fieldStr(a, 'account_number') ||
                `계좌 ${idx + 1}`
              const balance = fieldNum(a, 'balance', 'available', 'amount')
              const isActive = selected.type === 'account' && selected.id === id
              return (
                <button
                  key={id || idx}
                  onClick={() =>
                    setSelected({ type: 'account', id, label: name, kind: 'account' })
                  }
                  className={`w-full flex items-center justify-between px-2 py-1.5 rounded text-2xs transition ${
                    isActive ? 'bg-ink-900 text-white' : 'hover:bg-ink-50'
                  }`}
                >
                  <div className="text-left min-w-0 flex-1">
                    <div
                      className={`truncate ${
                        isActive ? 'font-semibold' : 'text-ink-700 font-medium'
                      }`}
                    >
                      {name}
                    </div>
                    <div
                      className={`text-2xs ${
                        isActive ? 'text-ink-300' : 'text-ink-400'
                      } truncate font-mono`}
                    >
                      {fieldStr(a, 'account_number', 'masked_number') || '-'}
                    </div>
                  </div>
                  <div className="text-right ml-2 flex-shrink-0">
                    <div
                      className={`font-mono tabular-nums font-semibold ${
                        isActive ? '' : balance >= 0 ? 'text-ink-900' : 'text-rose-600'
                      }`}
                    >
                      {formatCompactWon(balance)}
                    </div>
                  </div>
                </button>
              )
            })}
          </Section>

          {/* 카드 */}
          <Section
            title="신용카드"
            icon={<CreditCardIcon className="h-3.5 w-3.5" />}
            count={cards.length}
            onClickAll={() =>
              setSelected({ type: 'all', label: '카드 전체', kind: 'card' })
            }
            allLabel="카드 전체"
            isAllActive={selected.type === 'all' && selected.kind === 'card'}
          >
            {cards.length === 0 && !cardsQuery.isLoading && (
              <div className="text-2xs text-ink-400 px-2 py-3 text-center">
                {isConfigured ? '연동된 카드 없음' : '그랜터 미설정'}
              </div>
            )}
            {cards.map((c: any, idx: number) => {
              const id = fieldStr(c, 'id', 'card_id', 'connection_id')
              const name =
                fieldStr(c, 'alias', 'name', 'issuer', 'card_company') ||
                `카드 ${idx + 1}`
              const usage = fieldNum(c, 'usage', 'this_month_usage', 'current_balance')
              const isActive = selected.type === 'card' && selected.id === id
              return (
                <button
                  key={id || idx}
                  onClick={() =>
                    setSelected({ type: 'card', id, label: name, kind: 'card' })
                  }
                  className={`w-full flex items-center justify-between px-2 py-1.5 rounded text-2xs transition ${
                    isActive ? 'bg-ink-900 text-white' : 'hover:bg-ink-50'
                  }`}
                >
                  <div className="text-left min-w-0 flex-1">
                    <div
                      className={`truncate ${
                        isActive ? 'font-semibold' : 'text-ink-700 font-medium'
                      }`}
                    >
                      {name}
                    </div>
                    <div
                      className={`text-2xs ${
                        isActive ? 'text-ink-300' : 'text-ink-400'
                      } truncate font-mono`}
                    >
                      {fieldStr(c, 'masked_number', 'card_number') || '-'}
                    </div>
                  </div>
                  <div className="text-right ml-2 flex-shrink-0">
                    <div className="font-mono tabular-nums font-semibold">
                      {formatCompactWon(usage)}
                    </div>
                  </div>
                </button>
              )
            })}
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
                  label: '매출 세금계산서',
                  kind: 'tax_invoice',
                })
              }
              className={`w-full flex items-center justify-between px-2 py-2 rounded text-2xs transition ${
                selected.type === 'tax_sales' ? 'bg-ink-900 text-white' : 'hover:bg-ink-50'
              }`}
            >
              <div className="text-left">
                <div
                  className={
                    selected.type === 'tax_sales' ? 'font-semibold' : 'text-ink-700 font-medium'
                  }
                >
                  매출
                </div>
                <div
                  className={`text-2xs ${
                    selected.type === 'tax_sales' ? 'text-ink-300' : 'text-ink-400'
                  }`}
                >
                  발행 합계
                </div>
              </div>
              <div className="font-mono tabular-nums font-semibold text-emerald-700">
                {formatCompactWon(taxSalesSum)}
              </div>
            </button>
            <button
              onClick={() =>
                setSelected({
                  type: 'tax_purchase',
                  label: '매입 세금계산서',
                  kind: 'tax_invoice',
                })
              }
              className={`w-full flex items-center justify-between px-2 py-2 rounded text-2xs transition ${
                selected.type === 'tax_purchase'
                  ? 'bg-ink-900 text-white'
                  : 'hover:bg-ink-50'
              }`}
            >
              <div className="text-left">
                <div
                  className={
                    selected.type === 'tax_purchase'
                      ? 'font-semibold'
                      : 'text-ink-700 font-medium'
                  }
                >
                  매입
                </div>
                <div
                  className={`text-2xs ${
                    selected.type === 'tax_purchase' ? 'text-ink-300' : 'text-ink-400'
                  }`}
                >
                  수취 합계
                </div>
              </div>
              <div className="font-mono tabular-nums font-semibold text-rose-700">
                {formatCompactWon(taxPurchaseSum)}
              </div>
            </button>
          </Section>

          {/* 엑셀로 적재 (선택사항) */}
          <div className="rounded-md border border-ink-200 bg-canvas-50 px-3 py-2">
            <div className="flex items-start gap-2">
              <CloudArrowDownIcon className="h-3.5 w-3.5 text-ink-500 flex-shrink-0 mt-0.5" />
              <div className="text-2xs text-ink-600 leading-relaxed">
                여기 보이는 그랜터 거래는 <strong>실시간 raw 데이터</strong>입니다. 회계 처리(전표/원장/재무) 는 AI 분류 메뉴에서 업로드한 엑셀 데이터로 진행하세요.
              </div>
            </div>
          </div>
        </aside>

        {/* Right — selected source's transactions */}
        <main className="col-span-12 lg:col-span-7 xl:col-span-8">
          <div className="panel h-full flex flex-col overflow-hidden">
            <div className="px-3 py-2 border-b border-ink-200 flex items-center justify-between">
              <div className="flex items-center gap-2 min-w-0">
                <ArrowsRightLeftIcon className="h-3.5 w-3.5 text-ink-500" />
                <h2 className="text-sm">{selected.label}</h2>
                {txItems.length > 0 && (
                  <span className="text-2xs text-ink-400">
                    · {txItems.length.toLocaleString('ko-KR')}건
                  </span>
                )}
              </div>
            </div>

            {!isConfigured ? (
              <div className="flex-1 flex items-center justify-center text-2xs text-ink-400 p-6 text-center">
                그랜터 API 키 등록 후 실시간 거래가 표시됩니다.
              </div>
            ) : txQuery.isLoading ? (
              <div className="flex-1 flex items-center justify-center text-2xs text-ink-400">
                불러오는 중…
              </div>
            ) : txQuery.isError ? (
              <div className="flex-1 flex items-center justify-center text-2xs text-rose-500 p-6 text-center">
                그랜터 API 호출 실패. 잠시 후 다시 시도해 주세요.
              </div>
            ) : txItems.length === 0 ? (
              <div className="flex-1 flex items-center justify-center text-2xs text-ink-400">
                이 기간에 거래가 없습니다.
              </div>
            ) : (
              <div className="flex-1 overflow-y-auto">
                <table className="min-w-full">
                  <thead className="bg-canvas-50 sticky top-0 z-10">
                    <tr>
                      <th className="px-3 py-1.5 text-left text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                        일시
                      </th>
                      <th className="px-3 py-1.5 text-left text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                        유형
                      </th>
                      <th className="px-3 py-1.5 text-left text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                        거래처/적요
                      </th>
                      <th className="px-3 py-1.5 text-right text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                        <span className="inline-flex items-center gap-0.5">
                          <ArrowDownLeftIcon className="h-2.5 w-2.5 text-emerald-500" />
                          입금/매출
                        </span>
                      </th>
                      <th className="px-3 py-1.5 text-right text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                        <span className="inline-flex items-center gap-0.5">
                          <ArrowUpRightIcon className="h-2.5 w-2.5 text-rose-500" />
                          출금/매입
                        </span>
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-100">
                    {txItems.map((t: any, idx: number) => {
                      const inbound = fieldNum(t, 'inbound', 'deposit', 'debit_amount')
                      const outbound = fieldNum(t, 'outbound', 'withdraw', 'credit_amount')
                      const amount = fieldNum(t, 'amount')
                      // amount + direction fallback
                      const dir = fieldStr(t, 'direction', 'type').toLowerCase()
                      const finalIn =
                        inbound > 0
                          ? inbound
                          : dir.includes('inbound') || dir.includes('deposit') || dir.includes('income')
                          ? amount
                          : 0
                      const finalOut =
                        outbound > 0
                          ? outbound
                          : dir.includes('outbound') || dir.includes('withdraw') || dir.includes('expense')
                          ? amount
                          : 0
                      return (
                        <tr key={t.id || idx} className="hover:bg-canvas-50">
                          <td className="px-3 py-1.5 whitespace-nowrap text-2xs text-ink-700 font-mono">
                            {fieldStr(t, 'transaction_date', 'date', 'timestamp').slice(0, 16)}
                          </td>
                          <td className="px-3 py-1.5 whitespace-nowrap">
                            <span className="badge bg-ink-50 text-ink-700 border-ink-200">
                              {fieldStr(t, 'kind', 'type', 'category') || '-'}
                            </span>
                          </td>
                          <td className="px-3 py-1.5 text-xs text-ink-900">
                            <div className="font-medium">
                              {fieldStr(t, 'merchant_name', 'counterparty', 'vendor', 'description') ||
                                '-'}
                            </div>
                            <div className="text-2xs text-ink-500 truncate max-w-md">
                              {fieldStr(t, 'description', 'memo')}
                            </div>
                          </td>
                          <td className="px-3 py-1.5 text-right font-mono tabular-nums whitespace-nowrap">
                            {finalIn > 0 ? (
                              <span className="text-emerald-700 font-semibold">
                                {formatCurrency(finalIn, false)}
                              </span>
                            ) : (
                              <span className="text-ink-200">-</span>
                            )}
                          </td>
                          <td className="px-3 py-1.5 text-right font-mono tabular-nums whitespace-nowrap">
                            {finalOut > 0 ? (
                              <span className="text-rose-700 font-semibold">
                                {formatCurrency(finalOut, false)}
                              </span>
                            ) : (
                              <span className="text-ink-200">-</span>
                            )}
                          </td>
                        </tr>
                      )
                    })}
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
  onClickAll,
  allLabel,
  isAllActive,
}: {
  title: string
  icon: React.ReactNode
  count?: number
  children: React.ReactNode
  onClickAll?: () => void
  allLabel?: string
  isAllActive?: boolean
}) {
  return (
    <div className="panel">
      <div className="px-3 py-2 border-b border-ink-200 flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-2xs font-semibold text-ink-700 uppercase tracking-wider">
          {icon}
          <span>{title}</span>
        </div>
        <div className="flex items-center gap-2">
          {onClickAll && (
            <button
              onClick={onClickAll}
              className={`text-2xs font-semibold ${
                isAllActive ? 'text-ink-900' : 'text-ink-400 hover:text-ink-700'
              }`}
            >
              {allLabel || '전체'}
            </button>
          )}
          {count !== undefined && count > 0 && (
            <span className="text-2xs text-ink-400 font-mono">{count}</span>
          )}
        </div>
      </div>
      <div className="p-1.5 space-y-0.5">{children}</div>
    </div>
  )
}

function SettingsModal({ onClose }: { onClose: () => void }) {
  const connectionsQuery = useQuery({
    queryKey: ['granter-connections'],
    queryFn: () => granterApi.listConnections().then((r) => r.data),
    retry: false,
  })

  const conns: any[] = useMemo(() => {
    const d = connectionsQuery.data
    if (Array.isArray(d)) return d
    return d?.data || []
  }, [connectionsQuery.data])

  return (
    <div className="fixed inset-0 z-50 bg-ink-900/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-pop w-full max-w-2xl max-h-[80vh] overflow-y-auto border border-ink-200">
        <div className="sticky top-0 bg-white border-b border-ink-200 px-4 py-2.5 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-ink-900">데이터 소스 (그랜터 연동)</h3>
          <button onClick={onClose} className="text-ink-400 hover:text-ink-700">
            <XMarkIcon className="h-4 w-4" />
          </button>
        </div>

        <div className="p-4 space-y-3">
          <div className="rounded-md bg-canvas-50 border border-ink-200 px-3 py-2 text-2xs text-ink-600 leading-relaxed">
            그랜터에서 연동된 자산(계좌·카드·홈택스·PG·오픈마켓) 목록입니다. 새 연결은 그랜터 대시보드에서 추가하세요.
          </div>
          <div className="space-y-1.5">
            {conns.map((c: any, idx: number) => (
              <div
                key={c.id || idx}
                className="flex items-center justify-between px-3 py-2 border border-ink-200 rounded"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-medium text-ink-900 truncate">
                    {fieldStr(c, 'alias', 'name', 'institution') || `연결 ${idx + 1}`}
                  </div>
                  <div className="text-2xs text-ink-500">
                    {fieldStr(c, 'kind', 'type', 'category')} ·{' '}
                    {fieldStr(c, 'status', 'sync_status') || 'unknown'}
                  </div>
                </div>
              </div>
            ))}
            {conns.length === 0 && (
              <div className="text-center text-2xs text-ink-400 py-6">
                연동된 소스가 없습니다.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
