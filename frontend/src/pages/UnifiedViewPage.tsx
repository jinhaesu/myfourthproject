import { useEffect, useMemo, useState } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import toast from 'react-hot-toast'
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
  ChartPieIcon,
  ClockIcon,
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
      return { start: `${y}-01-01`, end: iso(today) }
    default:
      return { start: '', end: '' }
  }
}

function daysBetween(from: string, to: string): number {
  const f = new Date(from).getTime()
  const t = new Date(to).getTime()
  return Math.floor((t - f) / (24 * 3600 * 1000)) + 1
}

interface SelectedSource {
  scope: 'all' | 'asset_only'
  ticketType?: 'EXPENSE_TICKET' | 'BANK_TRANSACTION_TICKET' | 'TAX_INVOICE_TICKET' | 'CASH_RECEIPT_TICKET'
  assetId?: number
  label: string
  sublabel?: string
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

const TICKET_TYPE_LABEL: Record<string, string> = {
  EXPENSE_TICKET: '카드',
  BANK_TRANSACTION_TICKET: '계좌',
  TAX_INVOICE_TICKET: '세금계산서',
  CASH_RECEIPT_TICKET: '현금영수증',
  WORKFLOW: '결재',
  MERCHANT_CARD_TRANSACTION_TICKET: '포스기',
  ECOMMERCE_SETTLEMENT: '이커머스',
  PG_SETTLEMENT: 'PG',
  SALARY_HISTORY: '급여',
  MANUAL_TRANSACTION_TICKET: '수기',
}

export default function UnifiedViewPage() {
  const [preset, setPreset] = useState<PeriodPreset>('this_month')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [showSettings, setShowSettings] = useState(false)
  const [showInactive, setShowInactive] = useState(false)
  const [selected, setSelected] = useState<SelectedSource>({
    scope: 'all',
    label: '전체 거래',
  })

  useEffect(() => {
    const r = periodForPreset('this_month')
    setFrom(r.start)
    setTo(r.end)
  }, [])

  const ready = Boolean(from && to)
  const periodDays = ready ? daysBetween(from, to) : 0
  const exceeds31Days = periodDays > 31

  const healthQuery = useQuery({
    queryKey: ['granter-health'],
    queryFn: () => granterApi.health().then((r) => r.data),
    retry: false,
  })
  const isConfigured = healthQuery.data?.configured

  // 자산 (활성만 default)
  const assetsQuery = useQuery({
    queryKey: ['granter-assets-all', showInactive],
    queryFn: () => granterApi.listAllAssets(!showInactive).then((r) => r.data),
    enabled: !!isConfigured,
    retry: false,
  })

  const assetsData = assetsQuery.data || {}
  const allBankAssets: any[] = useMemo(() => assetsData?.BANK_ACCOUNT || [], [assetsData])
  const cardAssets: any[] = useMemo(() => assetsData?.CARD || [], [assetsData])
  const homeTaxAssets: any[] = useMemo(() => assetsData?.HOME_TAX_ACCOUNT || [], [assetsData])
  const securitiesAssets: any[] = useMemo(() => assetsData?.SECURITIES_ACCOUNT || [], [assetsData])
  const ecommerceAssets: any[] = useMemo(() => assetsData?.ECOMMERCE || [], [assetsData])

  // 대출 계좌 분리 (accountType=LOAN 또는 isLoan)
  const isLoanAccount = (a: any) => {
    const accType = String(a?.bankAccount?.accountType || '').toUpperCase()
    return accType === 'LOAN' || a?.bankAccount?.isLoan === true || a?.isLoan === true
  }
  const bankAssets: any[] = useMemo(
    () => allBankAssets.filter((a) => !isLoanAccount(a)),
    [allBankAssets]
  )
  const loanAssets: any[] = useMemo(
    () => allBankAssets.filter(isLoanAccount),
    [allBankAssets]
  )

  // 가용자금: 일반 계좌(대출 제외) KRW 잔액 합
  const totalCash = useMemo(
    () =>
      bankAssets.reduce((s, a) => {
        const ba = a?.bankAccount || {}
        const code = String(ba?.currencyCode || 'KRW').toUpperCase()
        if (code !== 'KRW') return s
        return s + Number(ba?.accountBalance || ba?.originalBalance || 0)
      }, 0),
    [bankAssets]
  )
  const foreignCashAccounts = useMemo(
    () =>
      bankAssets.filter((a) => {
        const code = String(a?.bankAccount?.currencyCode || 'KRW').toUpperCase()
        return code !== 'KRW'
      }),
    [bankAssets]
  )

  // 대출 총액
  const totalLoan = useMemo(
    () =>
      loanAssets.reduce(
        (s, a) =>
          s + Number(a?.bankAccount?.accountBalance || a?.bankAccount?.originalBalance || 0),
        0
      ),
    [loanAssets]
  )

  // 순포지션 = 가용자금 - 대출
  const netPosition = totalCash - totalLoan
  const totalSecurities = useMemo(
    () => securitiesAssets.reduce((s, a) => s + num(a?.securitiesAccount, 'totalAmount'), 0),
    [securitiesAssets]
  )

  // 기간 내 자산별 사용/입출금 자동 집계 (모든 ticket 합산)
  // 31일 초과 시 백엔드가 종료일 기준 31일만 반환
  const usageQuery = useQuery({
    queryKey: ['granter-tickets-usage', from, to],
    queryFn: () => {
      let actualStart = from
      if (exceeds31Days) {
        const d = new Date(to)
        d.setDate(d.getDate() - 30)
        actualStart = d.toISOString().slice(0, 10)
      }
      return granterApi.listTicketsAllTypes(actualStart, to).then((r) => r.data)
    },
    enabled: !!isConfigured && ready,
    retry: false,
  })

  // assetId → 기간 내 사용금액 합
  const usageByAsset = useMemo(() => {
    const map: Record<number, { total: number; inAmt: number; outAmt: number; count: number }> = {}
    const data = usageQuery.data || {}
    for (const tickets of Object.values(data)) {
      if (!Array.isArray(tickets)) continue
      for (const t of tickets) {
        const aid = Number(t.assetId || t.asset?.id || 0)
        if (!aid) continue
        const amt = Number(t.amount || 0)
        const isIn = String(t.transactionType) === 'IN'
        if (!map[aid]) map[aid] = { total: 0, inAmt: 0, outAmt: 0, count: 0 }
        map[aid].total += amt
        if (isIn) map[aid].inAmt += amt
        else map[aid].outAmt += amt
        map[aid].count += 1
      }
    }
    return map
  }, [usageQuery.data])

  const totalCardUsed = useMemo(
    () =>
      cardAssets.reduce((s, a) => {
        const id = Number(a?.id || 0)
        const fromTickets = usageByAsset[id]?.outAmt || 0
        const fromMeta = num(a?.card, 'usedAmount')
        return s + (fromTickets > 0 ? fromTickets : fromMeta)
      }, 0),
    [cardAssets, usageByAsset]
  )

  // 최근 거래 자동 탐색
  const findRecentMut = useMutation({
    mutationFn: () => granterApi.recentActivityPeriod(),
    onSuccess: (res) => {
      const d = res.data
      if (d?.start && d?.end) {
        setFrom(d.start)
        setTo(d.end)
        setPreset('custom')
        toast.success(
          `최근 거래 ${d.months_back === 0 ? '이번달' : `${d.months_back}개월 전`} 구간으로 이동 (${d.count}건)`
        )
      } else {
        toast.error('최근 12개월 내 거래를 찾을 수 없습니다.')
      }
    },
    onError: () => toast.error('탐색 실패'),
  })

  // 거래 (선택에 따라 단일 타입 또는 모든 타입 통합)
  const ticketsQuery = useQuery({
    queryKey: ['granter-tickets-v2', selected, from, to],
    queryFn: () => {
      // 31일 초과 시 자동으로 마지막 31일만 (사용자에게 안내)
      let actualStart = from
      if (exceeds31Days) {
        const d = new Date(to)
        d.setDate(d.getDate() - 30)
        actualStart = d.toISOString().slice(0, 10)
      }
      if (selected.scope === 'all' || !selected.ticketType) {
        // 모든 타입 통합 호출
        return granterApi
          .listTicketsAllTypes(actualStart, to, selected.assetId)
          .then((r) => r.data)
      }
      // 단일 타입
      const payload: any = {
        ticketType: selected.ticketType,
        startDate: actualStart,
        endDate: to,
      }
      if (selected.assetId) payload.assetId = selected.assetId
      return granterApi.listTickets(payload).then((r) => r.data)
    },
    enabled: !!isConfigured && ready,
    retry: false,
  })

  // 거래 데이터 정규화 (단일 타입 → 배열, 통합 → 객체를 합쳐서 배열)
  const tickets: any[] = useMemo(() => {
    const d = ticketsQuery.data
    if (!d) return []
    if (Array.isArray(d)) return d
    // 통합 응답: { EXPENSE_TICKET: [...], BANK_TRANSACTION_TICKET: [...], ... }
    if (typeof d === 'object') {
      const all: any[] = []
      for (const v of Object.values(d)) {
        if (Array.isArray(v)) all.push(...v)
      }
      // 시간 역순
      return all.sort((a, b) => {
        const at = String(a.transactAt || a.transactionDate || '')
        const bt = String(b.transactAt || b.transactionDate || '')
        return bt.localeCompare(at)
      })
    }
    return []
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
            그랜터 실시간 — 활성 자산만 노출 · 카드·계좌·세금계산서·현금영수증 통합
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
          <button
            onClick={() => findRecentMut.mutate()}
            disabled={findRecentMut.isPending}
            className="btn-secondary"
            title="최근 거래가 있는 31일 구간으로 자동 이동"
          >
            <ClockIcon className="h-3 w-3 mr-1" />
            {findRecentMut.isPending ? '탐색 중...' : '최근 거래 한 달'}
          </button>
          <button onClick={() => ticketsQuery.refetch()} className="btn-secondary" title="새로고침">
            <ArrowPathIcon className="h-3 w-3" />
          </button>
          <button onClick={() => setShowSettings(true)} className="btn-secondary">
            <Cog6ToothIcon className="h-3 w-3 mr-1" />
            설정
          </button>
        </div>
      </div>

      {/* Status / 31일 제한 안내 */}
      {!isConfigured ? (
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
        <div className="flex items-center gap-2 flex-wrap">
          <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-1 flex items-center gap-2">
            <CheckCircleIcon className="h-3.5 w-3.5 text-emerald-600" />
            <span className="text-2xs text-emerald-800">그랜터 연결됨</span>
          </div>
          {exceeds31Days && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-1 text-2xs text-amber-800">
              ⓘ 그랜터는 1회 조회 최대 31일 — 자동으로 종료일 기준 최근 31일만 조회됩니다
            </div>
          )}
          <label className="ml-auto flex items-center gap-1.5 text-2xs text-ink-600 cursor-pointer">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
              className="rounded border-ink-300 text-ink-900 focus:ring-ink-300 w-3 h-3"
            />
            만료/비활성 자산도 보기
          </label>
        </div>
      )}

      {/* 2-pane layout */}
      <div className="grid grid-cols-12 gap-3 min-h-[calc(100vh-13rem)]">
        {/* Left — sidebar */}
        <aside className="col-span-12 lg:col-span-5 xl:col-span-4 space-y-3 overflow-y-auto">
          {/* 가용자금 + 카드 사용 + 증권 종합 카드 */}
          <div className="panel p-4 space-y-3">
            <div>
              <div className="text-2xs text-ink-500 font-semibold uppercase tracking-wider">
                가용자금 (대출 제외)
              </div>
              <div className="mt-1 text-xl font-bold text-ink-900 tabular-nums tracking-crisp">
                {formatCurrency(totalCash, false)}
                <span className="text-xs text-ink-400 font-medium ml-1">원</span>
              </div>
              <div className="text-2xs text-ink-400 mt-0.5">
                KRW 입출금 계좌 {bankAssets.length}개
                {foreignCashAccounts.length > 0 && ` · 외화 ${foreignCashAccounts.length}건 별도`}
              </div>
            </div>

            {/* 대출 / 순포지션 */}
            {(loanAssets.length > 0 || totalLoan > 0) && (
              <div className="grid grid-cols-2 gap-2 pt-2 border-t border-ink-100">
                <div>
                  <div className="text-2xs text-amber-700 font-semibold">대출 잔액</div>
                  <div className="mt-0.5 text-sm font-semibold text-amber-700 font-mono tabular-nums">
                    {formatCurrency(totalLoan, false)}
                  </div>
                  <div className="text-2xs text-ink-400 mt-0.5">{loanAssets.length}개 계좌</div>
                </div>
                <div>
                  <div className="text-2xs text-primary-700 font-semibold">순포지션</div>
                  <div
                    className={`mt-0.5 text-sm font-semibold font-mono tabular-nums ${
                      netPosition >= 0 ? 'text-primary-700' : 'text-rose-700'
                    }`}
                  >
                    {formatCurrency(netPosition, false)}
                  </div>
                  <div className="text-2xs text-ink-400 mt-0.5">가용자금 − 대출</div>
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-2 pt-2 border-t border-ink-100">
              <div>
                <div className="text-2xs text-ink-500">기간 카드 사용</div>
                <div className="mt-0.5 text-sm font-semibold text-rose-700 font-mono tabular-nums">
                  {formatCurrency(totalCardUsed, false)}
                </div>
                <div className="text-2xs text-ink-400 mt-0.5">{usageQuery.isLoading ? '집계 중...' : 'EXPENSE_TICKET'}</div>
              </div>
              <div>
                <div className="text-2xs text-ink-500">증권 평가</div>
                <div className="mt-0.5 text-sm font-semibold text-ink-900 font-mono tabular-nums">
                  {formatCurrency(totalSecurities, false)}
                </div>
                <div className="text-2xs text-ink-400 mt-0.5">현재 시점</div>
              </div>
            </div>
          </div>

          {/* 입출금 계좌 */}
          <Section
            title="입출금 계좌"
            icon={<BuildingLibraryIcon className="h-3.5 w-3.5" />}
            count={bankAssets.length}
            onClickAll={() =>
              setSelected({
                scope: 'all',
                ticketType: 'BANK_TRANSACTION_TICKET',
                label: '계좌 전체 거래',
                sublabel: `${bankAssets.length}개 계좌`,
              })
            }
            allLabel="전체"
            isAllActive={selected.ticketType === 'BANK_TRANSACTION_TICKET' && !selected.assetId}
          >
            {bankAssets.length === 0 && !assetsQuery.isLoading && (
              <div className="text-2xs text-ink-400 px-2 py-3 text-center">활성 계좌 없음</div>
            )}
            {bankAssets.map((a, idx) => {
              const id = num(a, 'id')
              const ba = a.bankAccount || {}
              const bankName = str(a, 'organizationName', 'name')
              const alias = str(a, 'nickname') || str(ba, 'nickName', 'accountName')
              const acctNum = str(ba, 'accountNumber') || str(a, 'number')
              const balance = num(ba, 'accountBalance', 'originalBalance')
              const currency = String(ba?.currencyCode || 'KRW').toUpperCase()
              const periodFlow = usageByAsset[id]
              const isActive = selected.assetId === id
              return (
                <button
                  key={id || idx}
                  onClick={() =>
                    setSelected({
                      scope: 'asset_only',
                      ticketType: 'BANK_TRANSACTION_TICKET',
                      assetId: id,
                      label: alias || bankName,
                      sublabel: `${bankName} ${acctNum}`,
                    })
                  }
                  className={`w-full flex items-start justify-between px-2 py-1.5 rounded text-2xs transition gap-2 ${
                    isActive ? 'bg-ink-900 text-white' : 'hover:bg-ink-50'
                  }`}
                >
                  <div className="text-left min-w-0 flex-1">
                    <div className={`truncate ${isActive ? 'font-semibold' : 'text-ink-700 font-medium'}`}>
                      {alias || bankName}
                    </div>
                    <div className={`text-2xs ${isActive ? 'text-ink-300' : 'text-ink-400'} truncate font-mono`}>
                      {bankName} · {acctNum} {currency !== 'KRW' && `(${currency})`}
                    </div>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <div
                      className={`font-mono tabular-nums font-semibold ${
                        isActive ? '' : balance >= 0 ? 'text-ink-900' : 'text-rose-600'
                      }`}
                    >
                      {formatCurrency(balance, false)}
                    </div>
                    {periodFlow && periodFlow.count > 0 && (
                      <div className={`text-2xs font-mono ${isActive ? 'text-ink-300' : 'text-ink-400'}`}>
                        +{formatCurrency(periodFlow.inAmt, false).replace('₩ ', '')} / -
                        {formatCurrency(periodFlow.outAmt, false).replace('₩ ', '')}
                      </div>
                    )}
                  </div>
                </button>
              )
            })}
          </Section>

          {/* 대출 계좌 (별도) */}
          {loanAssets.length > 0 && (
            <Section
              title="대출 계좌"
              icon={<BuildingLibraryIcon className="h-3.5 w-3.5" />}
              count={loanAssets.length}
            >
              <div className="px-2 py-1 text-2xs text-amber-700 bg-amber-50 rounded mb-1">
                ⚠️ 가용자금에 합산되지 않음
              </div>
              {loanAssets.map((a, idx) => {
                const id = num(a, 'id')
                const ba = a.bankAccount || {}
                const bankName = str(a, 'organizationName', 'name')
                const alias = str(a, 'nickname') || str(ba, 'nickName', 'accountName')
                const acctNum = str(ba, 'accountNumber') || str(a, 'number')
                const balance = num(ba, 'accountBalance', 'originalBalance')
                const isActive = selected.assetId === id
                return (
                  <button
                    key={id || idx}
                    onClick={() =>
                      setSelected({
                        scope: 'asset_only',
                        ticketType: 'BANK_TRANSACTION_TICKET',
                        assetId: id,
                        label: alias || bankName,
                        sublabel: `${bankName} ${acctNum} (대출)`,
                      })
                    }
                    className={`w-full flex items-start justify-between px-2 py-1.5 rounded text-2xs transition gap-2 ${
                      isActive ? 'bg-ink-900 text-white' : 'hover:bg-amber-50'
                    }`}
                  >
                    <div className="text-left min-w-0 flex-1">
                      <div className={`truncate ${isActive ? 'font-semibold' : 'text-ink-700 font-medium'}`}>
                        {alias || bankName}
                      </div>
                      <div className={`text-2xs ${isActive ? 'text-ink-300' : 'text-ink-400'} truncate font-mono`}>
                        {bankName} · {acctNum}
                      </div>
                    </div>
                    <div className="text-right flex-shrink-0">
                      <div
                        className={`font-mono tabular-nums font-semibold ${
                          isActive ? '' : 'text-amber-700'
                        }`}
                      >
                        {formatCurrency(balance, false)}
                      </div>
                    </div>
                  </button>
                )
              })}
            </Section>
          )}

          {/* 신용카드 */}
          <Section
            title="신용카드"
            icon={<CreditCardIcon className="h-3.5 w-3.5" />}
            count={cardAssets.length}
            onClickAll={() =>
              setSelected({
                scope: 'all',
                ticketType: 'EXPENSE_TICKET',
                label: '카드 전체 거래',
                sublabel: `${cardAssets.length}개 카드`,
              })
            }
            allLabel="전체"
            isAllActive={selected.ticketType === 'EXPENSE_TICKET' && !selected.assetId}
          >
            {cardAssets.length === 0 && !assetsQuery.isLoading && (
              <div className="text-2xs text-ink-400 px-2 py-3 text-center">활성 카드 없음</div>
            )}
            {cardAssets.map((c, idx) => {
              const id = num(c, 'id')
              const cardInfo = c.card || {}
              const issuer = str(c, 'organizationName', 'name')
              const alias = str(c, 'nickname')
              const cardNum = str(c, 'number')
              // 사용금액: 우선 ticket 합산, fallback으로 자산 메타의 usedAmount
              const periodUsage = usageByAsset[id]?.outAmt || 0
              const fallbackUsed = num(cardInfo, 'usedAmount')
              const used = periodUsage > 0 ? periodUsage : fallbackUsed
              const limit = num(cardInfo, 'limitAmount')
              const txCount = usageByAsset[id]?.count || 0
              const isActive = selected.assetId === id
              return (
                <button
                  key={id || idx}
                  onClick={() =>
                    setSelected({
                      scope: 'asset_only',
                      ticketType: 'EXPENSE_TICKET',
                      assetId: id,
                      label: alias || issuer,
                      sublabel: `${issuer} ${cardNum}`,
                    })
                  }
                  className={`w-full flex items-start justify-between px-2 py-1.5 rounded text-2xs transition gap-2 ${
                    isActive ? 'bg-ink-900 text-white' : 'hover:bg-ink-50'
                  }`}
                >
                  <div className="text-left min-w-0 flex-1">
                    <div className={`truncate ${isActive ? 'font-semibold' : 'text-ink-700 font-medium'}`}>
                      {alias || issuer}
                    </div>
                    <div className={`text-2xs ${isActive ? 'text-ink-300' : 'text-ink-400'} truncate font-mono`}>
                      {issuer} · {cardNum}
                      {txCount > 0 && ` · ${txCount}건`}
                    </div>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <div className={`font-mono tabular-nums font-semibold ${isActive ? '' : 'text-rose-700'}`}>
                      {formatCurrency(used, false)}
                    </div>
                    {limit > 0 && (
                      <div className={`text-2xs ${isActive ? 'text-ink-300' : 'text-ink-400'}`}>
                        한도 {formatCurrency(limit, false)}
                      </div>
                    )}
                  </div>
                </button>
              )
            })}
          </Section>

          {/* 세금계산서/현금영수증 */}
          <Section
            title="세금계산서·현금영수증"
            icon={<DocumentTextIcon className="h-3.5 w-3.5" />}
            count={homeTaxAssets.length}
          >
            {homeTaxAssets.map((h, idx) => {
              const id = num(h, 'id')
              const ht = h.homeTaxAccount || {}
              const company = str(ht, 'companyName') || str(h, 'name')
              const bizNo = str(ht, 'registrationNumber')
              const category = str(ht, 'category')
              return (
                <div key={id || idx} className="px-2 py-1.5 rounded text-2xs border border-ink-100 mb-1">
                  <div className="flex items-center justify-between">
                    <div className="font-medium text-ink-900 truncate">{company}</div>
                    <span className="badge bg-ink-50 text-ink-700 border-ink-200">
                      {category === 'TAX_INVOICE' ? '세금계산서' : category === 'CASH_RECEIPT' ? '현금영수증' : category || '홈택스'}
                    </span>
                  </div>
                  <div className="text-2xs text-ink-500 font-mono mt-0.5">{bizNo}</div>
                </div>
              )
            })}
            <button
              onClick={() =>
                setSelected({
                  scope: 'all',
                  ticketType: 'TAX_INVOICE_TICKET',
                  label: '세금계산서 거래',
                })
              }
              className={`w-full flex items-center justify-between px-2 py-1.5 rounded text-2xs transition mt-1 ${
                selected.ticketType === 'TAX_INVOICE_TICKET' ? 'bg-ink-900 text-white' : 'hover:bg-ink-50'
              }`}
            >
              <span>세금계산서 거래 보기</span>
              <ArrowsRightLeftIcon className="h-3 w-3 opacity-60" />
            </button>
            <button
              onClick={() =>
                setSelected({
                  scope: 'all',
                  ticketType: 'CASH_RECEIPT_TICKET',
                  label: '현금영수증 거래',
                })
              }
              className={`w-full flex items-center justify-between px-2 py-1.5 rounded text-2xs transition mt-1 ${
                selected.ticketType === 'CASH_RECEIPT_TICKET' ? 'bg-ink-900 text-white' : 'hover:bg-ink-50'
              }`}
            >
              <span>현금영수증 거래 보기</span>
              <ArrowsRightLeftIcon className="h-3 w-3 opacity-60" />
            </button>
          </Section>

          {/* 증권 / 이커머스 */}
          {(securitiesAssets.length > 0 || ecommerceAssets.length > 0) && (
            <Section
              title="기타 자산"
              icon={<ChartPieIcon className="h-3.5 w-3.5" />}
              count={securitiesAssets.length + ecommerceAssets.length}
            >
              {securitiesAssets.map((s, idx) => {
                const sa = s.securitiesAccount || {}
                return (
                  <div key={s.id || idx} className="px-2 py-1.5 rounded text-2xs border border-ink-100 mb-1">
                    <div className="flex items-center justify-between">
                      <div className="font-medium text-ink-900 truncate">{str(s, 'name')}</div>
                      <div className="font-mono text-ink-700 font-semibold">
                        {formatCurrency(num(sa, 'totalAmount'), false)}
                      </div>
                    </div>
                    <div className="text-2xs text-ink-500 mt-0.5 font-mono">
                      예수금 {formatCurrency(num(sa, 'depositAmount'), false)} · 평가{' '}
                      {formatCurrency(num(sa, 'totalValuationAmount'), false)}
                    </div>
                  </div>
                )
              })}
              {ecommerceAssets.map((e, idx) => (
                <div key={e.id || idx} className="px-2 py-1.5 rounded text-2xs border border-ink-100 mb-1">
                  <div className="font-medium text-ink-900 truncate">{str(e, 'name', 'organizationName')}</div>
                  <div className="text-2xs text-ink-500 mt-0.5">{str(e, 'organizationName')}</div>
                </div>
              ))}
            </Section>
          )}

          {/* 전체 통합 */}
          <button
            onClick={() => setSelected({ scope: 'all', label: '전체 거래' })}
            className={`w-full panel px-3 py-2 text-left text-2xs hover:bg-ink-50 transition ${
              !selected.ticketType && selected.scope === 'all' ? 'border-ink-900 border-2' : ''
            }`}
          >
            <div className="font-semibold text-ink-900">전체 거래 통합</div>
            <div className="text-ink-500 mt-0.5">카드 + 계좌 + 세금계산서 + 현금영수증 한 번에</div>
          </button>
        </aside>

        {/* Right — tickets */}
        <main className="col-span-12 lg:col-span-7 xl:col-span-8">
          <div className="panel h-full flex flex-col overflow-hidden">
            <div className="px-3 py-2 border-b border-ink-200 flex items-center justify-between">
              <div className="flex items-center gap-2 min-w-0">
                <ArrowsRightLeftIcon className="h-3.5 w-3.5 text-ink-500" />
                <div className="min-w-0">
                  <h2 className="text-sm">{selected.label}</h2>
                  {selected.sublabel && (
                    <div className="text-2xs text-ink-400 truncate">{selected.sublabel}</div>
                  )}
                </div>
                {tickets.length > 0 && (
                  <span className="text-2xs text-ink-400 ml-2">
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
                그랜터 API 호출 실패. 권한·기간 확인.
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
                      <th className="px-3 py-1.5 text-left text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                        계정과목
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
                      const ticketType = str(t, 'ticketType')
                      const cat = t.expenseCategory || {}
                      // 거래처: contact > bankTransaction.counterparty > cardUsage.storeName > content
                      const contact =
                        str(t, 'contact') ||
                        str(t?.bankTransaction, 'counterparty') ||
                        str(t?.cardUsage, 'storeName') ||
                        str(t, 'merchantName', 'counterpartyName', 'vendor')
                      const memo =
                        str(t?.bankTransaction, 'descriptionType', 'description') ||
                        str(t?.cardUsage, 'storeAddress') ||
                        str(t, 'description', 'memo', 'content')
                      return (
                        <tr key={t.id || idx} className="hover:bg-canvas-50">
                          <td className="px-3 py-1.5 whitespace-nowrap text-2xs text-ink-700 font-mono">
                            {str(t, 'transactAt', 'transactionDate', 'date').slice(0, 16).replace('T', ' ')}
                          </td>
                          <td className="px-3 py-1.5 whitespace-nowrap">
                            <span className="badge bg-ink-50 text-ink-700 border-ink-200">
                              {TICKET_TYPE_LABEL[ticketType] || ticketType.replace('_TICKET', '')}
                            </span>
                          </td>
                          <td className="px-3 py-1.5 text-xs text-ink-900">
                            <div className="font-medium">
                              {contact || str(t, 'content') || '-'}
                            </div>
                            <div className="text-2xs text-ink-500 truncate max-w-md">{memo}</div>
                          </td>
                          <td className="px-3 py-1.5 whitespace-nowrap text-2xs">
                            {str(cat, 'name') ? (
                              <span className="inline-flex items-center gap-1">
                                <span className="font-mono text-ink-400">{str(cat, 'code')}</span>
                                <span className="text-ink-700">{str(cat, 'name')}</span>
                              </span>
                            ) : (
                              <span className="text-ink-300">-</span>
                            )}
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
  const [showInactive, setShowInactive] = useState(true)  // 설정에서는 모든 자산 보이기

  const assetsQuery = useQuery({
    queryKey: ['granter-assets-settings', showInactive],
    queryFn: () => granterApi.listAllAssets(!showInactive).then((r) => r.data),
    retry: false,
  })

  const allAssets: any[] = useMemo(() => {
    const d = assetsQuery.data || {}
    const result: any[] = []
    for (const [type, items] of Object.entries(d)) {
      if (Array.isArray(items)) {
        for (const item of items) {
          result.push({ ...item, _typeKey: type })
        }
      }
    }
    return result
  }, [assetsQuery.data])

  return (
    <div className="fixed inset-0 z-50 bg-ink-900/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-pop w-full max-w-3xl max-h-[80vh] overflow-y-auto border border-ink-200">
        <div className="sticky top-0 bg-white border-b border-ink-200 px-4 py-2.5 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-ink-900">데이터 소스 (그랜터 자산)</h3>
          <button onClick={onClose} className="text-ink-400 hover:text-ink-700">
            <XMarkIcon className="h-4 w-4" />
          </button>
        </div>

        <div className="p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="rounded-md bg-canvas-50 border border-ink-200 px-3 py-2 text-2xs text-ink-600 leading-relaxed flex-1 mr-3">
              그랜터에 연동된 자산입니다. 새 연결은 그랜터 대시보드에서 추가합니다.
            </div>
            <label className="flex items-center gap-1.5 text-2xs text-ink-600 cursor-pointer">
              <input
                type="checkbox"
                checked={!showInactive}
                onChange={(e) => setShowInactive(!e.target.checked)}
                className="rounded border-ink-300 text-ink-900 focus:ring-ink-300 w-3 h-3"
              />
              활성만
            </label>
          </div>
          <div className="space-y-1.5">
            {allAssets.map((a, idx) => {
              const isActive = a.isActive && !a.isHidden && !a.isDormant
              return (
                <div
                  key={`${a._typeKey}-${a.id || idx}`}
                  className="flex items-center justify-between px-3 py-2 border border-ink-200 rounded"
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-medium text-ink-900 truncate flex items-center gap-1.5">
                      {str(a, 'nickname') || str(a, 'name')}
                      {!isActive && (
                        <span className="badge bg-rose-50 text-rose-700 border-rose-200">비활성</span>
                      )}
                      {a.isDormant && (
                        <span className="badge bg-amber-50 text-amber-700 border-amber-200">휴면</span>
                      )}
                    </div>
                    <div className="text-2xs text-ink-500 font-mono">
                      {a._typeKey} · {str(a, 'organizationName')} · {str(a, 'number') || str(a?.bankAccount, 'accountNumber')}
                    </div>
                  </div>
                </div>
              )
            })}
            {allAssets.length === 0 && !assetsQuery.isLoading && (
              <div className="text-center text-2xs text-ink-400 py-6">자산이 없습니다.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
