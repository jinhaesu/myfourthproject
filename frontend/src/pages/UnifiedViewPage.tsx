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
import { formatCurrency } from '@/utils/format'

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

type TicketKind = 'CARD_TICKET' | 'BANK_TICKET' | 'TAX_INVOICE_TICKET' | 'CASH_RECEIPT_TICKET'

interface SelectedSource {
  type: 'all' | 'bank' | 'card' | 'tax_sales' | 'tax_purchase'
  assetId?: number | string
  label: string
  ticketTypes?: TicketKind[]
}

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

  // 그랜터 상태
  const healthQuery = useQuery({
    queryKey: ['granter-health'],
    queryFn: () => granterApi.health().then((r) => r.data),
    retry: false,
  })
  const isConfigured = healthQuery.data?.configured

  // 자산 목록 (계좌/카드/홈택스)
  const assetsQuery = useQuery({
    queryKey: ['granter-assets'],
    queryFn: () => granterApi.listAssets({}).then((r) => r.data),
    enabled: !!isConfigured,
    retry: false,
  })

  // 잔액 시계열
  const balancesQuery = useQuery({
    queryKey: ['granter-balances', from, to],
    queryFn: () =>
      granterApi
        .listBalances({ fromDate: from, toDate: to })
        .then((r) => r.data),
    enabled: !!isConfigured && ready,
    retry: false,
  })

  // 선택한 자산/유형의 거래 (tickets)
  const ticketsQuery = useQuery({
    queryKey: ['granter-tickets', selected, from, to],
    queryFn: () => {
      const payload: any = {
        fromDate: from,
        toDate: to,
        limit: 200,
      }
      if (selected.ticketTypes) payload.ticketTypes = selected.ticketTypes
      if (selected.assetId) payload.assetIds = [selected.assetId]
      return granterApi.listTickets(payload).then((r) => r.data)
    },
    enabled: !!isConfigured && ready,
    retry: false,
  })

  const assetsData = assetsQuery.data
  const assets: any[] = useMemo(() => {
    if (Array.isArray(assetsData)) return assetsData
    return assetsData?.data || assetsData?.assets || []
  }, [assetsData])

  const bankAssets = useMemo(
    () => assets.filter((a) => str(a, 'assetType', 'type').includes('BANK')),
    [assets]
  )
  const cardAssets = useMemo(
    () => assets.filter((a) => str(a, 'assetType', 'type').includes('CARD')),
    [assets]
  )
  const homeTaxAssets = useMemo(
    () => assets.filter((a) => str(a, 'assetType', 'type').includes('HOME_TAX')),
    [assets]
  )

  // 잔액 합계
  const balances: any[] = useMemo(() => {
    const d = balancesQuery.data
    if (Array.isArray(d)) return d
    return d?.data || d?.balances || []
  }, [balancesQuery.data])
  const totalCash = useMemo(
    () => balances.reduce((s, b) => s + num(b, 'balance', 'amount', 'closingBalance'), 0),
    [balances]
  )

  const tickets: any[] = useMemo(() => {
    const d = ticketsQuery.data
    if (Array.isArray(d)) return d
    return d?.data || []
  }, [ticketsQuery.data])

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
            그랜터 실시간 — 카드·계좌·세금계산서·현금영수증 거래 통합 조회
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
          <button onClick={() => ticketsQuery.refetch()} className="btn-secondary" title="새로고침">
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
              Railway → Variables → <code className="font-mono bg-white px-1 rounded">GRANTER_API_KEY</code>{' '}
              등록 후 자동 활성화.
            </div>
          </div>
        </div>
      ) : (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-1.5 flex items-center gap-2">
          <CheckCircleIcon className="h-3.5 w-3.5 text-emerald-600" />
          <div className="text-2xs text-emerald-800">그랜터 연결됨 · 실시간 데이터 활성화</div>
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
              그랜터 잔액 합계 · {balances.length}건
            </div>
          </div>

          {/* 입출금 계좌 */}
          <Section
            title="입출금 계좌"
            icon={<BuildingLibraryIcon className="h-3.5 w-3.5" />}
            count={bankAssets.length}
            onClickAll={() =>
              setSelected({ type: 'all', label: '전체 계좌 거래', ticketTypes: ['BANK_TICKET'] })
            }
            allLabel="계좌 전체"
            isAllActive={selected.type === 'all' && selected.ticketTypes?.[0] === 'BANK_TICKET'}
          >
            {bankAssets.length === 0 && !assetsQuery.isLoading && (
              <div className="text-2xs text-ink-400 px-2 py-3 text-center">
                {isConfigured ? '연동된 계좌 없음' : '그랜터 미설정'}
              </div>
            )}
            {bankAssets.map((a, idx) => {
              const id = num(a, 'id', 'assetId')
              const name =
                str(a, 'alias', 'nickname', 'institutionName', 'companyName', 'name') ||
                `계좌 ${idx + 1}`
              const accountNumber = str(a, 'accountNumber', 'maskedAccountNumber', 'identifier')
              const isActive = selected.type === 'bank' && selected.assetId === id
              return (
                <button
                  key={id || idx}
                  onClick={() =>
                    setSelected({ type: 'bank', assetId: id, label: name, ticketTypes: ['BANK_TICKET'] })
                  }
                  className={`w-full flex items-center justify-between px-2 py-1.5 rounded text-2xs transition ${
                    isActive ? 'bg-ink-900 text-white' : 'hover:bg-ink-50'
                  }`}
                >
                  <div className="text-left min-w-0 flex-1">
                    <div className={`truncate ${isActive ? 'font-semibold' : 'text-ink-700 font-medium'}`}>
                      {name}
                    </div>
                    <div className={`text-2xs ${isActive ? 'text-ink-300' : 'text-ink-400'} truncate font-mono`}>
                      {accountNumber || '-'}
                    </div>
                  </div>
                </button>
              )
            })}
          </Section>

          {/* 신용카드 */}
          <Section
            title="신용카드"
            icon={<CreditCardIcon className="h-3.5 w-3.5" />}
            count={cardAssets.length}
            onClickAll={() =>
              setSelected({ type: 'all', label: '전체 카드 거래', ticketTypes: ['CARD_TICKET'] })
            }
            allLabel="카드 전체"
            isAllActive={selected.type === 'all' && selected.ticketTypes?.[0] === 'CARD_TICKET'}
          >
            {cardAssets.length === 0 && !assetsQuery.isLoading && (
              <div className="text-2xs text-ink-400 px-2 py-3 text-center">
                {isConfigured ? '연동된 카드 없음' : '그랜터 미설정'}
              </div>
            )}
            {cardAssets.map((c, idx) => {
              const id = num(c, 'id', 'assetId')
              const name =
                str(c, 'alias', 'nickname', 'institutionName', 'companyName', 'name') ||
                `카드 ${idx + 1}`
              const cardNumber = str(c, 'cardNumber', 'maskedCardNumber', 'identifier')
              const isActive = selected.type === 'card' && selected.assetId === id
              return (
                <button
                  key={id || idx}
                  onClick={() =>
                    setSelected({ type: 'card', assetId: id, label: name, ticketTypes: ['CARD_TICKET'] })
                  }
                  className={`w-full flex items-center justify-between px-2 py-1.5 rounded text-2xs transition ${
                    isActive ? 'bg-ink-900 text-white' : 'hover:bg-ink-50'
                  }`}
                >
                  <div className="text-left min-w-0 flex-1">
                    <div className={`truncate ${isActive ? 'font-semibold' : 'text-ink-700 font-medium'}`}>
                      {name}
                    </div>
                    <div className={`text-2xs ${isActive ? 'text-ink-300' : 'text-ink-400'} truncate font-mono`}>
                      {cardNumber || '-'}
                    </div>
                  </div>
                </button>
              )
            })}
          </Section>

          {/* 세금계산서 */}
          <Section
            title="세금계산서"
            icon={<DocumentTextIcon className="h-3.5 w-3.5" />}
            count={homeTaxAssets.length}
          >
            <button
              onClick={() =>
                setSelected({
                  type: 'tax_sales',
                  label: '세금계산서 전체',
                  ticketTypes: ['TAX_INVOICE_TICKET'],
                })
              }
              className={`w-full flex items-center justify-between px-2 py-2 rounded text-2xs transition ${
                selected.type === 'tax_sales' ? 'bg-ink-900 text-white' : 'hover:bg-ink-50'
              }`}
            >
              <div className="text-left">
                <div className={selected.type === 'tax_sales' ? 'font-semibold' : 'text-ink-700 font-medium'}>
                  세금계산서 거래
                </div>
                <div className={`text-2xs ${selected.type === 'tax_sales' ? 'text-ink-300' : 'text-ink-400'}`}>
                  매출/매입 통합
                </div>
              </div>
              <ArrowsRightLeftIcon className="h-3.5 w-3.5 opacity-60" />
            </button>
            <button
              onClick={() =>
                setSelected({
                  type: 'tax_purchase',
                  label: '현금영수증 거래',
                  ticketTypes: ['CASH_RECEIPT_TICKET'],
                })
              }
              className={`w-full flex items-center justify-between px-2 py-2 rounded text-2xs transition ${
                selected.type === 'tax_purchase' ? 'bg-ink-900 text-white' : 'hover:bg-ink-50'
              }`}
            >
              <div className="text-left">
                <div className={selected.type === 'tax_purchase' ? 'font-semibold' : 'text-ink-700 font-medium'}>
                  현금영수증 거래
                </div>
                <div className={`text-2xs ${selected.type === 'tax_purchase' ? 'text-ink-300' : 'text-ink-400'}`}>
                  발행/수취
                </div>
              </div>
              <ArrowsRightLeftIcon className="h-3.5 w-3.5 opacity-60" />
            </button>
          </Section>

          <div className="rounded-md border border-ink-200 bg-canvas-50 px-3 py-2">
            <div className="flex items-start gap-2">
              <CloudArrowDownIcon className="h-3.5 w-3.5 text-ink-500 flex-shrink-0 mt-0.5" />
              <div className="text-2xs text-ink-600 leading-relaxed">
                여기는 그랜터 <strong>실시간 raw 데이터</strong>입니다. 회계 처리(전표/원장/재무)는
                AI 분류 메뉴에서 업로드한 엑셀 데이터로 진행합니다.
              </div>
            </div>
          </div>
        </aside>

        {/* Right — tickets */}
        <main className="col-span-12 lg:col-span-7 xl:col-span-8">
          <div className="panel h-full flex flex-col overflow-hidden">
            <div className="px-3 py-2 border-b border-ink-200 flex items-center justify-between">
              <div className="flex items-center gap-2 min-w-0">
                <ArrowsRightLeftIcon className="h-3.5 w-3.5 text-ink-500" />
                <h2 className="text-sm">{selected.label}</h2>
                {tickets.length > 0 && (
                  <span className="text-2xs text-ink-400">
                    · {tickets.length.toLocaleString('ko-KR')}건
                  </span>
                )}
              </div>
            </div>

            {!isConfigured ? (
              <div className="flex-1 flex items-center justify-center text-2xs text-ink-400 p-6 text-center">
                그랜터 API 키 등록 후 실시간 거래가 표시됩니다.
              </div>
            ) : ticketsQuery.isLoading ? (
              <div className="flex-1 flex items-center justify-center text-2xs text-ink-400">
                불러오는 중…
              </div>
            ) : ticketsQuery.isError ? (
              <div className="flex-1 flex items-center justify-center text-2xs text-rose-500 p-6 text-center">
                그랜터 API 호출 실패. 키 권한 또는 엔드포인트 확인 필요.
              </div>
            ) : tickets.length === 0 ? (
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
                          입금
                        </span>
                      </th>
                      <th className="px-3 py-1.5 text-right text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                        <span className="inline-flex items-center gap-0.5">
                          <ArrowUpRightIcon className="h-2.5 w-2.5 text-rose-500" />
                          출금
                        </span>
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-100">
                    {tickets.map((t, idx) => {
                      const txType = str(t, 'transactionType')
                      const amount = num(t, 'amount')
                      const inAmount = txType === 'IN' ? amount : 0
                      const outAmount = txType === 'OUT' ? amount : 0
                      return (
                        <tr key={t.id || idx} className="hover:bg-canvas-50">
                          <td className="px-3 py-1.5 whitespace-nowrap text-2xs text-ink-700 font-mono">
                            {str(t, 'transactAt', 'transactionDate', 'date').slice(0, 16)}
                          </td>
                          <td className="px-3 py-1.5 whitespace-nowrap">
                            <span className="badge bg-ink-50 text-ink-700 border-ink-200">
                              {str(t, 'ticketType', 'kind').replace('_TICKET', '') || '-'}
                            </span>
                          </td>
                          <td className="px-3 py-1.5 text-xs text-ink-900">
                            <div className="font-medium">
                              {str(t, 'merchantName', 'counterpartyName', 'vendor', 'content') || '-'}
                            </div>
                            <div className="text-2xs text-ink-500 truncate max-w-md">
                              {str(t, 'content', 'memo', 'description')}
                            </div>
                          </td>
                          <td className="px-3 py-1.5 text-right font-mono tabular-nums whitespace-nowrap">
                            {inAmount > 0 ? (
                              <span className="text-emerald-700 font-semibold">
                                {formatCurrency(inAmount, false)}
                              </span>
                            ) : (
                              <span className="text-ink-200">-</span>
                            )}
                          </td>
                          <td className="px-3 py-1.5 text-right font-mono tabular-nums whitespace-nowrap">
                            {outAmount > 0 ? (
                              <span className="text-rose-700 font-semibold">
                                {formatCurrency(outAmount, false)}
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
  const assetsQuery = useQuery({
    queryKey: ['granter-assets-settings'],
    queryFn: () => granterApi.listAssets({}).then((r) => r.data),
    retry: false,
  })

  const assets: any[] = useMemo(() => {
    const d = assetsQuery.data
    if (Array.isArray(d)) return d
    return d?.data || []
  }, [assetsQuery.data])

  return (
    <div className="fixed inset-0 z-50 bg-ink-900/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-pop w-full max-w-2xl max-h-[80vh] overflow-y-auto border border-ink-200">
        <div className="sticky top-0 bg-white border-b border-ink-200 px-4 py-2.5 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-ink-900">데이터 소스 (그랜터 자산)</h3>
          <button onClick={onClose} className="text-ink-400 hover:text-ink-700">
            <XMarkIcon className="h-4 w-4" />
          </button>
        </div>

        <div className="p-4 space-y-3">
          <div className="rounded-md bg-canvas-50 border border-ink-200 px-3 py-2 text-2xs text-ink-600 leading-relaxed">
            그랜터에 연동된 자산입니다. 새 연결은 그랜터 대시보드에서 추가하세요.
          </div>
          <div className="space-y-1.5">
            {assets.map((a, idx) => (
              <div
                key={a.id || idx}
                className="flex items-center justify-between px-3 py-2 border border-ink-200 rounded"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-medium text-ink-900 truncate">
                    {str(a, 'alias', 'nickname', 'institutionName', 'companyName', 'name') ||
                      `자산 ${idx + 1}`}
                  </div>
                  <div className="text-2xs text-ink-500">
                    {str(a, 'assetType', 'type')} ·{' '}
                    {str(a, 'identifier', 'accountNumber', 'cardNumber', 'maskedNumber')}
                  </div>
                </div>
              </div>
            ))}
            {assets.length === 0 && (
              <div className="text-center text-2xs text-ink-400 py-6">자산이 없습니다.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
