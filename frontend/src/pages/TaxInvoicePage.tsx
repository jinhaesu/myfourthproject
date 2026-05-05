import { useMemo, useState } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import {
  CalendarDaysIcon,
  ArrowPathIcon,
  ReceiptPercentIcon,
  ArrowDownLeftIcon,
  ArrowUpRightIcon,
  MagnifyingGlassIcon,
  ExclamationTriangleIcon,
  CheckCircleIcon,
  ClockIcon,
} from '@heroicons/react/24/outline'
import { granterApi } from '@/services/api'
import { formatCurrency } from '@/utils/format'

type Direction = 'all' | 'sales' | 'purchase'

function todayISO() {
  return new Date().toISOString().slice(0, 10)
}
function thisMonthStartISO() {
  const d = new Date()
  d.setDate(1)
  return d.toISOString().slice(0, 10)
}
function daysBetween(a: string, b: string) {
  return Math.floor((new Date(b).getTime() - new Date(a).getTime()) / 86400000) + 1
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

export default function TaxInvoicePage() {
  const [from, setFrom] = useState(thisMonthStartISO())
  const [to, setTo] = useState(todayISO())
  const [direction, setDirection] = useState<Direction>('all')
  const [search, setSearch] = useState('')

  const ready = Boolean(from && to)
  const exceeds31 = ready && daysBetween(from, to) > 31

  const healthQuery = useQuery({
    queryKey: ['granter-health'],
    queryFn: () => granterApi.health().then((r) => r.data),
    retry: false,
  })
  const isConfigured = healthQuery.data?.configured

  const ticketsQuery = useQuery({
    queryKey: ['granter-tax-invoices', from, to],
    queryFn: () => {
      let actualStart = from
      if (exceeds31) {
        const d = new Date(to)
        d.setDate(d.getDate() - 30)
        actualStart = d.toISOString().slice(0, 10)
      }
      return granterApi
        .listTickets({
          ticketType: 'TAX_INVOICE_TICKET',
          startDate: actualStart,
          endDate: to,
        })
        .then((r) => r.data)
    },
    enabled: !!isConfigured && ready,
    retry: false,
  })

  const allTickets: any[] = useMemo(() => {
    const d = ticketsQuery.data
    if (Array.isArray(d)) return d
    return d?.data || []
  }, [ticketsQuery.data])

  // 최근 세금계산서 자동 탐색
  const findRecentMut = useMutation({
    mutationFn: async () => {
      // /granter/recent-activity-period가 모든 타입을 시도하니
      // TAX_INVOICE_TICKET만 명시적으로 시도하려면 직접 호출
      const today = new Date()
      for (let offset = 0; offset < 24; offset++) {
        const end = new Date(today)
        end.setDate(end.getDate() - offset * 31)
        const start = new Date(end)
        start.setDate(start.getDate() - 31)
        const startStr = start.toISOString().slice(0, 10)
        const endStr = end.toISOString().slice(0, 10)
        try {
          const r = await granterApi.listTickets({
            ticketType: 'TAX_INVOICE_TICKET',
            startDate: startStr,
            endDate: endStr,
          })
          const items = Array.isArray(r.data) ? r.data : r.data?.data || []
          if (items.length > 0) {
            return { start: startStr, end: endStr, count: items.length, monthsBack: offset }
          }
        } catch {
          // 무시
        }
      }
      return { start: null, end: null, count: 0, monthsBack: 0 }
    },
    onSuccess: (res) => {
      if (res.start && res.end) {
        setFrom(res.start)
        setTo(res.end)
        toast.success(
          `${res.monthsBack === 0 ? '이번달' : `${res.monthsBack}개월 전`} 구간 (${res.count}건)`
        )
      } else {
        toast.error('최근 24개월 내 세금계산서가 없습니다. 그랜터에서 홈택스 데이터 동기화가 진행 중일 수 있습니다.')
      }
    },
  })

  // 매출/매입 분리: transactionType IN=매출, OUT=매입 (그랜터 관행)
  const salesTickets = useMemo(
    () => allTickets.filter((t) => str(t, 'transactionType') === 'IN'),
    [allTickets]
  )
  const purchaseTickets = useMemo(
    () => allTickets.filter((t) => str(t, 'transactionType') === 'OUT'),
    [allTickets]
  )

  const filtered = useMemo(() => {
    let arr =
      direction === 'sales' ? salesTickets : direction === 'purchase' ? purchaseTickets : allTickets
    if (search) {
      const s = search.toLowerCase()
      arr = arr.filter((t) => {
        const text =
          (str(t, 'content') + str(t, 'description') + str(t, 'contact') + str(t, 'merchantName')).toLowerCase()
        return text.includes(s)
      })
    }
    return arr
  }, [direction, salesTickets, purchaseTickets, allTickets, search])

  const salesTotal = useMemo(() => salesTickets.reduce((s, t) => s + num(t, 'amount'), 0), [salesTickets])
  const purchaseTotal = useMemo(
    () => purchaseTickets.reduce((s, t) => s + num(t, 'amount'), 0),
    [purchaseTickets]
  )

  const setQuickRange = (days: number) => {
    const end = new Date()
    const start = new Date()
    start.setDate(end.getDate() - days + 1)
    setFrom(start.toISOString().slice(0, 10))
    setTo(end.toISOString().slice(0, 10))
  }

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-end justify-between flex-wrap gap-2">
        <div>
          <h1 className="flex items-center gap-2">
            <ReceiptPercentIcon className="h-4 w-4 text-ink-500" />
            세금계산서
          </h1>
          <p className="text-2xs text-ink-500 mt-0.5">
            그랜터 TAX_INVOICE_TICKET — 매출(IN) / 매입(OUT) 자동 분리
          </p>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <div className="flex items-center gap-0.5 p-0.5 rounded-md bg-white border border-ink-200">
            <button
              onClick={() => {
                setFrom(thisMonthStartISO())
                setTo(todayISO())
              }}
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
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="bg-transparent text-2xs text-ink-700 w-24 focus:outline-none"
            />
            <span className="text-ink-300">→</span>
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="bg-transparent text-2xs text-ink-700 w-24 focus:outline-none"
            />
          </div>
          <button
            onClick={() => findRecentMut.mutate()}
            disabled={findRecentMut.isPending}
            className="btn-secondary"
            title="최근 세금계산서가 있는 31일 구간 자동 탐색"
          >
            <ClockIcon className="h-3 w-3 mr-1" />
            {findRecentMut.isPending ? '탐색 중...' : '최근 거래 한 달'}
          </button>
          <button onClick={() => ticketsQuery.refetch()} className="btn-secondary">
            <ArrowPathIcon className="h-3 w-3" />
          </button>
        </div>
      </div>

      {!isConfigured ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 flex items-center gap-2">
          <ExclamationTriangleIcon className="h-4 w-4 text-amber-600" />
          <div className="text-2xs text-amber-800">그랜터 API 키 미설정</div>
        </div>
      ) : (
        <div className="flex items-center gap-2 flex-wrap">
          <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-1 flex items-center gap-2">
            <CheckCircleIcon className="h-3.5 w-3.5 text-emerald-600" />
            <span className="text-2xs text-emerald-800">그랜터 연결됨</span>
          </div>
          {exceeds31 && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-1 text-2xs text-amber-800">
              31일 초과 — 종료일 기준 최근 31일만 자동 조회
            </div>
          )}
        </div>
      )}

      {/* KPI */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <div className="panel px-3 py-2">
          <div className="text-2xs font-medium text-ink-500 uppercase tracking-wider">총 발행/수취</div>
          <div className="mt-0.5 font-mono tabular-nums font-bold text-base text-ink-900">
            {allTickets.length}건
          </div>
        </div>
        <div className="panel px-3 py-2">
          <div className="text-2xs font-medium text-ink-500 uppercase tracking-wider flex items-center gap-1">
            <ArrowDownLeftIcon className="h-3 w-3 text-emerald-500" />
            매출 (발행)
          </div>
          <div className="mt-0.5 font-mono tabular-nums font-bold text-base text-emerald-700">
            {formatCurrency(salesTotal, false)}
          </div>
          <div className="text-2xs text-ink-400 mt-0.5">{salesTickets.length}건</div>
        </div>
        <div className="panel px-3 py-2">
          <div className="text-2xs font-medium text-ink-500 uppercase tracking-wider flex items-center gap-1">
            <ArrowUpRightIcon className="h-3 w-3 text-rose-500" />
            매입 (수취)
          </div>
          <div className="mt-0.5 font-mono tabular-nums font-bold text-base text-rose-700">
            {formatCurrency(purchaseTotal, false)}
          </div>
          <div className="text-2xs text-ink-400 mt-0.5">{purchaseTickets.length}건</div>
        </div>
        <div className="panel px-3 py-2">
          <div className="text-2xs font-medium text-ink-500 uppercase tracking-wider">매출 − 매입</div>
          <div
            className={`mt-0.5 font-mono tabular-nums font-bold text-base ${
              salesTotal - purchaseTotal >= 0 ? 'text-primary-700' : 'text-rose-700'
            }`}
          >
            {formatCurrency(salesTotal - purchaseTotal, false)}
          </div>
        </div>
      </div>

      {/* Filter */}
      <div className="panel p-2 flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-0.5 p-0.5 rounded-md bg-canvas-50 border border-ink-200">
          {(['all', 'sales', 'purchase'] as Direction[]).map((d) => (
            <button
              key={d}
              onClick={() => setDirection(d)}
              className={`px-2.5 py-1 rounded text-2xs font-semibold ${
                direction === d ? 'bg-ink-900 text-white' : 'text-ink-600 hover:bg-white'
              }`}
            >
              {d === 'all' ? '전체' : d === 'sales' ? '매출' : '매입'}
            </button>
          ))}
        </div>
        <div className="relative ml-auto">
          <MagnifyingGlassIcon className="h-3 w-3 absolute left-2 top-1/2 -translate-y-1/2 text-ink-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="거래처/적요 검색"
            className="pl-7 input w-44 text-2xs"
          />
        </div>
      </div>

      {/* Table */}
      <div className="panel overflow-hidden">
        <div className="overflow-x-auto max-h-[calc(100vh-26rem)] overflow-y-auto">
          <table className="min-w-full">
            <thead className="bg-canvas-50 sticky top-0 z-10 border-b border-ink-200">
              <tr>
                <th className="px-3 py-1.5 text-left text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                  발행일자
                </th>
                <th className="px-3 py-1.5 text-left text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                  구분
                </th>
                <th className="px-3 py-1.5 text-left text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                  거래처
                </th>
                <th className="px-3 py-1.5 text-left text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                  내용
                </th>
                <th className="px-3 py-1.5 text-right text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                  공급가액
                </th>
                <th className="px-3 py-1.5 text-left text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                  계정과목
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {ticketsQuery.isLoading && (
                <tr>
                  <td colSpan={6} className="text-center py-6 text-2xs text-ink-400">
                    불러오는 중…
                  </td>
                </tr>
              )}
              {filtered.map((t, idx) => {
                const isSales = str(t, 'transactionType') === 'IN'
                const cat = t.expenseCategory || {}
                const ti = t?.taxInvoice
                // 매출(IN): contractor(공급받는자) = 거래처 / 매입(OUT): supplier(공급자) = 거래처
                const contact = isSales
                  ? str(ti?.contractor, 'companyName') || str(t, 'contact', 'content')
                  : str(ti?.supplier, 'companyName') || str(t, 'contact', 'content')
                const counterRegNo = isSales
                  ? str(ti?.contractor, 'registrationNumber')
                  : str(ti?.supplier, 'registrationNumber')
                return (
                  <tr key={t.id || idx} className="hover:bg-canvas-50">
                    <td className="px-3 py-1.5 whitespace-nowrap text-2xs text-ink-700 font-mono">
                      {str(t, 'transactAt', 'date').slice(0, 10)}
                    </td>
                    <td className="px-3 py-1.5">
                      <span
                        className={`badge ${
                          isSales
                            ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                            : 'bg-rose-50 text-rose-700 border-rose-200'
                        }`}
                      >
                        {isSales ? '매출' : '매입'}
                      </span>
                    </td>
                    <td className="px-3 py-1.5 text-xs text-ink-900">
                      <div className="font-medium">{contact || '-'}</div>
                      {counterRegNo && (
                        <div className="text-2xs text-ink-500 font-mono">{counterRegNo}</div>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-xs text-ink-700 max-w-md truncate">
                      {str(t, 'content', 'description')}
                    </td>
                    <td
                      className={`px-3 py-1.5 text-right font-mono tabular-nums text-xs font-semibold ${
                        isSales ? 'text-emerald-700' : 'text-rose-700'
                      }`}
                    >
                      {formatCurrency(num(t, 'amount'), false)}
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
                  </tr>
                )
              })}
              {!ticketsQuery.isLoading && filtered.length === 0 && (
                <tr>
                  <td colSpan={6} className="text-center py-6 text-2xs text-ink-400">
                    <div>이 기간에 세금계산서가 없습니다.</div>
                    <div className="mt-2 space-y-1">
                      <button
                        onClick={() => findRecentMut.mutate()}
                        disabled={findRecentMut.isPending}
                        className="text-primary-700 hover:underline font-semibold"
                      >
                        ⏱️ 최근 12개월에서 자동 탐색
                      </button>
                      <div className="text-2xs text-ink-400">
                        그랜터 홈택스 자산 연동 상태는 [통합조회 → ⚙️ 설정]에서 확인하세요.
                      </div>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="text-2xs text-ink-400 px-1">
        ※ transactionType = IN 매출, OUT 매입 자동 분리. 세금계산서 발행/수정/취소는 그랜터 발행 API로 가능 (별도 워크플로).
      </div>
    </div>
  )
}
