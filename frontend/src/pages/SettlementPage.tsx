import { useMemo, useState } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import {
  CalendarDaysIcon,
  ArrowPathIcon,
  ArrowsRightLeftIcon,
  MagnifyingGlassIcon,
  ExclamationTriangleIcon,
  CheckCircleIcon,
  CheckIcon,
  XMarkIcon,
  ClockIcon,
} from '@heroicons/react/24/outline'
import { granterApi } from '@/services/api'
import { formatCurrency } from '@/utils/format'

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

interface ContactRow {
  contact: string
  invoiceCount: number
  invoiceTotal: number
  depositCount: number
  depositTotal: number
  diff: number  // invoiceTotal - depositTotal (양수: 미회수, 음수: 초과 입금)
  matchedAmount: number  // min(invoice, deposit)
  invoices: any[]
  deposits: any[]
}

export default function SettlementPage() {
  const [from, setFrom] = useState(thisMonthStartISO())
  const [to, setTo] = useState(todayISO())
  const [search, setSearch] = useState('')
  const [selectedContact, setSelectedContact] = useState<string | null>(null)
  const [filter, setFilter] = useState<'all' | 'unmatched' | 'matched'>('all')

  const ready = Boolean(from && to)
  const exceeds31 = ready && daysBetween(from, to) > 31

  const healthQuery = useQuery({
    queryKey: ['granter-health'],
    queryFn: () => granterApi.health().then((r) => r.data),
    retry: false,
  })
  const isConfigured = healthQuery.data?.configured

  // 세금계산서(매출) + 통장 거래(입금) 동시 조회
  const dataQuery = useQuery({
    queryKey: ['granter-settlement', from, to],
    queryFn: async () => {
      let actualStart = from
      if (exceeds31) {
        const d = new Date(to)
        d.setDate(d.getDate() - 30)
        actualStart = d.toISOString().slice(0, 10)
      }
      const [taxRes, bankRes] = await Promise.all([
        granterApi.listTickets({
          ticketType: 'TAX_INVOICE_TICKET',
          startDate: actualStart,
          endDate: to,
        }),
        granterApi.listTickets({
          ticketType: 'BANK_TRANSACTION_TICKET',
          startDate: actualStart,
          endDate: to,
        }),
      ])
      const taxData = taxRes.data
      const bankData = bankRes.data
      const tax = Array.isArray(taxData) ? taxData : taxData?.data || []
      const bank = Array.isArray(bankData) ? bankData : bankData?.data || []
      return { tax, bank }
    },
    enabled: !!isConfigured && ready,
    retry: false,
  })

  const { tax: taxTickets, bank: bankTickets } = dataQuery.data || { tax: [], bank: [] }

  // 최근 거래 자동 탐색 (세금계산서 OR 통장 거래 둘 중 하나라도 있는 구간)
  const findRecentMut = useMutation({
    mutationFn: async () => {
      const today = new Date()
      for (let offset = 0; offset < 24; offset++) {
        const end = new Date(today)
        end.setDate(end.getDate() - offset * 31)
        const start = new Date(end)
        start.setDate(start.getDate() - 31)
        const startStr = start.toISOString().slice(0, 10)
        const endStr = end.toISOString().slice(0, 10)
        try {
          const [taxR, bankR] = await Promise.all([
            granterApi.listTickets({ ticketType: 'TAX_INVOICE_TICKET', startDate: startStr, endDate: endStr }),
            granterApi.listTickets({ ticketType: 'BANK_TRANSACTION_TICKET', startDate: startStr, endDate: endStr }),
          ])
          const taxItems = Array.isArray(taxR.data) ? taxR.data : taxR.data?.data || []
          const bankItems = Array.isArray(bankR.data) ? bankR.data : bankR.data?.data || []
          if (taxItems.length + bankItems.length > 0) {
            return {
              start: startStr,
              end: endStr,
              taxCount: taxItems.length,
              bankCount: bankItems.length,
              monthsBack: offset,
            }
          }
        } catch {
          // 무시
        }
      }
      return { start: null, end: null, taxCount: 0, bankCount: 0, monthsBack: 0 }
    },
    onSuccess: (res) => {
      if (res.start && res.end) {
        setFrom(res.start)
        setTo(res.end)
        toast.success(
          `${res.monthsBack === 0 ? '이번달' : `${res.monthsBack}개월 전`} · 매출 ${res.taxCount}건, 입금 ${res.bankCount}건`
        )
      } else {
        toast.error('최근 24개월 내 매칭할 거래가 없습니다.')
      }
    },
  })

  // 거래처 추출 (그랜터 가이드의 정확한 ticket 응답 구조 기준):
  // - bankTransaction.counterparty (계좌)
  // - cardUsage.storeName (카드)
  // - taxInvoice: 매출(IN)이면 contractor.companyName, 매입(OUT)이면 supplier.companyName
  // - cashReceipt: issuer.companyName
  const extractContact = (t: any): string => {
    if (t?.taxInvoice) {
      const ti = t.taxInvoice
      if (str(t, 'transactionType') === 'IN') {
        // 매출: 공급받는자(contractor)가 거래처
        return str(ti?.contractor, 'companyName') || str(ti?.supplier, 'companyName') || '(미지정)'
      }
      // 매입: 공급자(supplier)가 거래처
      return str(ti?.supplier, 'companyName') || str(ti?.contractor, 'companyName') || '(미지정)'
    }
    if (t?.cashReceipt) {
      return str(t.cashReceipt?.issuer, 'companyName') || str(t.cashReceipt?.issuer, 'userName') || '(미지정)'
    }
    return (
      str(t, 'contact') ||
      str(t?.bankTransaction, 'counterparty') ||
      str(t?.cardUsage, 'storeName') ||
      str(t?.bankTransaction, 'content') ||
      str(t, 'content', 'merchantName', 'counterpartyName', 'vendor') ||
      '(미지정)'
    )
  }

  // 거래처별 매출 집계 (세금계산서 IN) + 통장 입금 (BANK_TRANSACTION_TICKET IN)
  const contacts: ContactRow[] = useMemo(() => {
    const map: Record<string, ContactRow> = {}

    const ensure = (contact: string): ContactRow => {
      if (!map[contact]) {
        map[contact] = {
          contact,
          invoiceCount: 0,
          invoiceTotal: 0,
          depositCount: 0,
          depositTotal: 0,
          diff: 0,
          matchedAmount: 0,
          invoices: [],
          deposits: [],
        }
      }
      return map[contact]
    }

    for (const t of taxTickets) {
      if (str(t, 'transactionType') !== 'IN') continue  // 매출만
      const row = ensure(extractContact(t))
      row.invoiceCount += 1
      row.invoiceTotal += num(t, 'amount')
      row.invoices.push(t)
    }

    for (const t of bankTickets) {
      if (str(t, 'transactionType') !== 'IN') continue  // 입금만
      const row = ensure(extractContact(t))
      row.depositCount += 1
      row.depositTotal += num(t, 'amount')
      row.deposits.push(t)
    }

    // 차이/매칭 계산
    for (const r of Object.values(map)) {
      r.matchedAmount = Math.min(r.invoiceTotal, r.depositTotal)
      r.diff = r.invoiceTotal - r.depositTotal
    }

    // 거래 합계 큰 순으로 정렬
    return Object.values(map).sort((a, b) => {
      const aMax = Math.max(a.invoiceTotal, a.depositTotal)
      const bMax = Math.max(b.invoiceTotal, b.depositTotal)
      return bMax - aMax
    })
  }, [taxTickets, bankTickets])

  const filteredContacts = useMemo(() => {
    let arr = contacts
    if (search) {
      const s = search.toLowerCase()
      arr = arr.filter((c) => c.contact.toLowerCase().includes(s))
    }
    if (filter === 'unmatched') {
      arr = arr.filter((c) => Math.abs(c.diff) > 0)
    } else if (filter === 'matched') {
      arr = arr.filter((c) => c.diff === 0 && c.invoiceCount > 0 && c.depositCount > 0)
    }
    return arr
  }, [contacts, search, filter])

  const summary = useMemo(() => {
    const totalInvoice = contacts.reduce((s, c) => s + c.invoiceTotal, 0)
    const totalDeposit = contacts.reduce((s, c) => s + c.depositTotal, 0)
    const matched = contacts.reduce((s, c) => s + c.matchedAmount, 0)
    const unmatched = contacts.filter((c) => c.diff !== 0).length
    return { totalInvoice, totalDeposit, matched, diff: totalInvoice - totalDeposit, unmatched }
  }, [contacts])

  const selected = useMemo(
    () => contacts.find((c) => c.contact === selectedContact),
    [contacts, selectedContact]
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
            <ArrowsRightLeftIcon className="h-4 w-4 text-ink-500" />
            거래처 정산
          </h1>
          <p className="text-2xs text-ink-500 mt-0.5">
            거래처별 세금계산서 매출 vs 통장 입금 매칭 — 미회수 자동 검출
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
            <button onClick={() => setQuickRange(31)} className="px-2 py-1 rounded text-2xs font-semibold text-ink-600 hover:bg-ink-50">
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
          >
            <ClockIcon className="h-3 w-3 mr-1" />
            {findRecentMut.isPending ? '탐색 중...' : '최근 거래 한 달'}
          </button>
          <button onClick={() => dataQuery.refetch()} className="btn-secondary">
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
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
        <KPI label="거래처 수" value={contacts.length} unit="곳" />
        <KPI label="매출 합계 (세금계산서)" value={summary.totalInvoice} tone="emerald" />
        <KPI label="입금 합계 (통장)" value={summary.totalDeposit} tone="primary" />
        <KPI label="매칭 금액" value={summary.matched} tone="success" />
        <KPI
          label="차이 (매출 − 입금)"
          value={summary.diff}
          tone={summary.diff >= 0 ? 'warning' : 'danger'}
        />
      </div>

      {/* Filter bar */}
      <div className="panel p-2 flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-0.5 p-0.5 rounded-md bg-canvas-50 border border-ink-200">
          {(['all', 'unmatched', 'matched'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-2.5 py-1 rounded text-2xs font-semibold ${
                filter === f ? 'bg-ink-900 text-white' : 'text-ink-600 hover:bg-white'
              }`}
            >
              {f === 'all' ? '전체' : f === 'unmatched' ? '미매칭' : '매칭완료'}
            </button>
          ))}
        </div>
        <div className="text-2xs text-ink-500">
          미매칭 거래처 <span className="font-semibold text-ink-700">{summary.unmatched}곳</span>
        </div>
        <div className="relative ml-auto">
          <MagnifyingGlassIcon className="h-3 w-3 absolute left-2 top-1/2 -translate-y-1/2 text-ink-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="거래처 검색"
            className="pl-7 input w-44 text-2xs"
          />
        </div>
      </div>

      {/* 2-pane: 거래처 표 + 상세 */}
      <div className="grid grid-cols-12 gap-3">
        <div className={selected ? 'col-span-7' : 'col-span-12'}>
          <div className="panel overflow-hidden">
            <div className="overflow-x-auto max-h-[calc(100vh-26rem)] overflow-y-auto">
              <table className="min-w-full">
                <thead className="bg-canvas-50 sticky top-0 z-10 border-b border-ink-200">
                  <tr>
                    <th className="px-3 py-1.5 text-left text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                      거래처
                    </th>
                    <th className="px-3 py-1.5 text-right text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                      매출 (세금계산서)
                    </th>
                    <th className="px-3 py-1.5 text-right text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                      입금 (통장)
                    </th>
                    <th className="px-3 py-1.5 text-right text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                      차이
                    </th>
                    <th className="px-3 py-1.5 text-center text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                      상태
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {dataQuery.isLoading && (
                    <tr>
                      <td colSpan={5} className="text-center py-6 text-2xs text-ink-400">
                        불러오는 중…
                      </td>
                    </tr>
                  )}
                  {filteredContacts.map((c) => {
                    const isSel = selectedContact === c.contact
                    const status =
                      c.diff > 0 ? 'unrecovered' : c.diff < 0 ? 'over' : 'matched'
                    return (
                      <tr
                        key={c.contact}
                        onClick={() => setSelectedContact(c.contact)}
                        className={`cursor-pointer ${
                          isSel ? 'bg-ink-50' : 'hover:bg-canvas-50'
                        }`}
                      >
                        <td className="px-3 py-1.5 text-xs">
                          <div className={`font-medium ${isSel ? 'text-ink-900 font-semibold' : 'text-ink-900'}`}>
                            {c.contact}
                          </div>
                          <div className="text-2xs text-ink-500">
                            매출 {c.invoiceCount}건 · 입금 {c.depositCount}건
                          </div>
                        </td>
                        <td className="px-3 py-1.5 text-right font-mono tabular-nums text-xs text-emerald-700 font-semibold">
                          {c.invoiceTotal > 0 ? formatCurrency(c.invoiceTotal, false) : <span className="text-ink-200">-</span>}
                        </td>
                        <td className="px-3 py-1.5 text-right font-mono tabular-nums text-xs text-primary-700 font-semibold">
                          {c.depositTotal > 0 ? formatCurrency(c.depositTotal, false) : <span className="text-ink-200">-</span>}
                        </td>
                        <td
                          className={`px-3 py-1.5 text-right font-mono tabular-nums text-xs font-semibold ${
                            c.diff > 0 ? 'text-amber-700' : c.diff < 0 ? 'text-rose-700' : 'text-emerald-700'
                          }`}
                        >
                          {c.diff !== 0 && (c.diff > 0 ? '+' : '')}
                          {formatCurrency(c.diff, false)}
                        </td>
                        <td className="px-3 py-1.5 text-center">
                          {status === 'matched' ? (
                            <span className="badge bg-emerald-50 text-emerald-700 border-emerald-200">
                              <CheckIcon className="h-2.5 w-2.5 mr-0.5" />
                              매칭
                            </span>
                          ) : status === 'unrecovered' ? (
                            <span className="badge bg-amber-50 text-amber-700 border-amber-200">
                              미회수
                            </span>
                          ) : (
                            <span className="badge bg-rose-50 text-rose-700 border-rose-200">
                              초과 입금
                            </span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                  {!dataQuery.isLoading && filteredContacts.length === 0 && (
                    <tr>
                      <td colSpan={5} className="text-center py-6 text-2xs text-ink-400">
                        <div>조건에 맞는 거래처가 없습니다.</div>
                        <div className="mt-2">
                          <button
                            onClick={() => findRecentMut.mutate()}
                            disabled={findRecentMut.isPending}
                            className="text-primary-700 hover:underline font-semibold"
                          >
                            ⏱️ 최근 12개월에서 매출 + 입금 자동 탐색
                          </button>
                          <div className="text-2xs text-ink-400 mt-1">
                            세금계산서가 없으면 그랜터에 홈택스 자산이 연동됐는지, 통장 거래가 없으면 계좌 자산이 연동됐는지 확인하세요.
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* Detail panel */}
        {selected && (
          <div className="col-span-5">
            <div className="panel overflow-hidden h-full flex flex-col">
              <div className="px-3 py-2 border-b border-ink-200 flex items-center justify-between">
                <div className="min-w-0">
                  <h2 className="text-sm truncate">{selected.contact}</h2>
                  <div className="text-2xs text-ink-500">
                    매칭 {formatCurrency(selected.matchedAmount, false)} · 차이{' '}
                    <span className={selected.diff !== 0 ? 'text-rose-600 font-semibold' : ''}>
                      {formatCurrency(selected.diff, false)}
                    </span>
                  </div>
                </div>
                <button onClick={() => setSelectedContact(null)} className="text-ink-400 hover:text-ink-700">
                  <XMarkIcon className="h-4 w-4" />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto p-3 space-y-3">
                {/* 세금계산서 매출 */}
                <div>
                  <div className="text-2xs font-semibold text-emerald-700 uppercase tracking-wider mb-1.5">
                    세금계산서 매출 ({selected.invoices.length}건)
                  </div>
                  {selected.invoices.length === 0 ? (
                    <div className="text-2xs text-ink-400 py-2">없음</div>
                  ) : (
                    <div className="space-y-1">
                      {selected.invoices.map((it, idx) => (
                        <div key={it.id || idx} className="flex items-start justify-between text-2xs border border-emerald-100 bg-emerald-50/30 rounded p-1.5">
                          <div className="min-w-0 flex-1">
                            <div className="font-mono text-ink-700">{str(it, 'transactAt').slice(0, 10)}</div>
                            <div className="text-ink-600 truncate">{str(it, 'content', 'description')}</div>
                          </div>
                          <div className="font-mono font-semibold text-emerald-700">
                            {formatCurrency(num(it, 'amount'), false)}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* 통장 입금 */}
                <div>
                  <div className="text-2xs font-semibold text-primary-700 uppercase tracking-wider mb-1.5">
                    통장 입금 ({selected.deposits.length}건)
                  </div>
                  {selected.deposits.length === 0 ? (
                    <div className="text-2xs text-ink-400 py-2">없음</div>
                  ) : (
                    <div className="space-y-1">
                      {selected.deposits.map((it, idx) => (
                        <div key={it.id || idx} className="flex items-start justify-between text-2xs border border-primary-100 bg-primary-50/30 rounded p-1.5">
                          <div className="min-w-0 flex-1">
                            <div className="font-mono text-ink-700">{str(it, 'transactAt').slice(0, 10)}</div>
                            <div className="text-ink-600 truncate">{str(it, 'content', 'description')}</div>
                          </div>
                          <div className="font-mono font-semibold text-primary-700">
                            {formatCurrency(num(it, 'amount'), false)}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="text-2xs text-ink-400 px-1">
        ※ 자동 매칭은 거래처명 + 합계 비교 기준. 정확한 매칭은 일자/금액 일치 확인 필요.
      </div>
    </div>
  )
}

function KPI({
  label,
  value,
  unit = '원',
  tone = 'neutral',
}: {
  label: string
  value: number | undefined
  unit?: string
  tone?: 'neutral' | 'primary' | 'success' | 'emerald' | 'danger' | 'warning'
}) {
  const v = Number(value || 0)
  const toneClass: Record<string, string> = {
    neutral: 'text-ink-900',
    primary: 'text-primary-700',
    success: 'text-emerald-700',
    emerald: 'text-emerald-700',
    danger: 'text-rose-700',
    warning: 'text-amber-700',
  }
  return (
    <div className="panel px-3 py-2">
      <div className="text-2xs font-medium text-ink-500 uppercase tracking-wider">{label}</div>
      <div className={`mt-0.5 font-mono tabular-nums font-bold text-sm ${toneClass[tone]}`}>
        {unit === '곳' ? v : formatCurrency(v, false)}
        {unit !== '원' && <span className="text-2xs text-ink-400 ml-1 font-medium">{unit}</span>}
      </div>
    </div>
  )
}
