/**
 * 거래처 정산 페이지 v2
 * - 매출/매입 양방향 정산
 * - 거래처 클릭 시 우측 상세 패널 슬라이드
 * - 월별 Recharts BarChart
 * - 세금계산서 발행 버튼 (TaxInvoicePage로 prefill 이동)
 */
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts'
import {
  ArrowPathIcon,
  ArrowsRightLeftIcon,
  MagnifyingGlassIcon,
  ExclamationTriangleIcon,
  CheckCircleIcon,
  XMarkIcon,
  ReceiptPercentIcon,
  BuildingOffice2Icon,
} from '@heroicons/react/24/outline'
import { granterApi } from '@/services/api'
import { formatCurrency, formatCompactWon, isoLocal } from '@/utils/format'
import PeriodPicker from '@/components/common/PeriodPicker'
import { usePeriodStore } from '@/store/periodStore'
import { buildOwnAccountSet, filterOutInternalTransfers, isSelfCompany } from '@/utils/internalTransfer'

// ─────────────────────────────────────────────────────────────────────────────
// 타입 정의
// ─────────────────────────────────────────────────────────────────────────────

interface ContactRow {
  key: string                      // 사업자번호 또는 회사명
  companyName: string
  businessNumber: string
  // 세금계산서
  salesInvoiceAmount: number       // 매출 세금계산서 (transactionType IN)
  salesInvoiceCount: number
  purchaseInvoiceAmount: number    // 매입 세금계산서 (transactionType OUT)
  purchaseInvoiceCount: number
  // 통장
  bankInAmount: number             // 입금
  bankInCount: number
  bankOutAmount: number            // 출금
  bankOutCount: number
  // 잔액
  salesBalance: number             // = salesInvoiceAmount - bankInAmount
  purchaseBalance: number          // = purchaseInvoiceAmount - bankOutAmount
  // 상세정보
  representativeName: string
  address: string
  email: string
  phone: string
  businessType: string
  businessItem: string
  // 거래 내역
  invoices: any[]
  bankTxs: any[]
}

type FilterMode = 'all' | 'receivable' | 'payable' | 'settled'

// ─────────────────────────────────────────────────────────────────────────────
// 유틸
// ─────────────────────────────────────────────────────────────────────────────

function daysBetween(a: string, b: string) {
  return Math.floor((new Date(b).getTime() - new Date(a).getTime()) / 86400000) + 1
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d)
  r.setDate(r.getDate() + n)
  return r
}

/** 거래처 집계 */
function buildContactRows(taxTickets: any[], bankTickets: any[]): ContactRow[] {
  const map = new Map<string, ContactRow>()

  const makeRow = (key: string, name: string, bn: string): ContactRow => ({
    key,
    companyName: name,
    businessNumber: bn,
    salesInvoiceAmount: 0, salesInvoiceCount: 0,
    purchaseInvoiceAmount: 0, purchaseInvoiceCount: 0,
    bankInAmount: 0, bankInCount: 0,
    bankOutAmount: 0, bankOutCount: 0,
    salesBalance: 0, purchaseBalance: 0,
    representativeName: '', address: '', email: '', phone: '', businessType: '', businessItem: '',
    invoices: [], bankTxs: [],
  })

  // 1. 세금계산서 처리
  for (const t of taxTickets) {
    const ti = t?.taxInvoice
    if (!ti) continue
    const isSales = String(t.transactionType) === 'IN'
    const counterParty = isSales ? ti.contractor : ti.supplier
    if (!counterParty) continue

    // registrationNumber 우선, 없으면 businessNumber
    const bn = String(
      counterParty.registrationNumber || counterParty.businessNumber || ''
    ).trim().replace(/[^0-9-]/g, '')
    const name = String(counterParty.companyName || counterParty.name || '').trim()
    if (!bn && !name) continue
    if (isSelfCompany({ businessNumber: bn, companyName: name })) continue

    const key = bn || name
    const row = map.get(key) || makeRow(key, name, bn)
    row.invoices.push(t)

    const amount = Math.abs(Number(t.amount || 0))
    if (isSales) {
      row.salesInvoiceAmount += amount
      row.salesInvoiceCount += 1
    } else {
      row.purchaseInvoiceAmount += amount
      row.purchaseInvoiceCount += 1
    }

    // 상세정보 보강 (빈 필드만)
    if (!row.representativeName)
      row.representativeName = String(counterParty.ceoName || counterParty.representativeName || '').trim()
    if (!row.address)
      row.address = String(counterParty.businessPlace || counterParty.address || '').trim()
    if (!row.email) row.email = String(counterParty.email || '').trim()
    if (!row.phone) row.phone = String(counterParty.phone || counterParty.tel || '').trim()
    if (!row.businessType)
      row.businessType = String(counterParty.businessTypes || counterParty.businessType || '').trim()
    if (!row.businessItem)
      row.businessItem = String(counterParty.businessItems || counterParty.businessItem || '').trim()
    if (!row.companyName && name) row.companyName = name
    if (!row.businessNumber && bn) row.businessNumber = bn

    map.set(key, row)
  }

  // 2. 통장 거래 처리 — 회사명 정규화 후 매칭
  const norm = (s: string) => s.replace(/\s+/g, '').toLowerCase()
  const nameToKey = new Map<string, string>()
  for (const [key, row] of map.entries()) {
    if (row.companyName) nameToKey.set(norm(row.companyName), key)
  }

  for (const t of bankTickets) {
    const bt = t?.bankTransaction
    if (!bt) continue
    const counterparty = String(bt.counterparty || bt.opponent || '').trim()
    if (!counterparty) continue
    if (isSelfCompany({ companyName: counterparty })) continue

    const normCp = norm(counterparty)
    let matchedKey: string | undefined = nameToKey.get(normCp)

    // 부분 매칭
    if (!matchedKey) {
      for (const [n, k] of nameToKey.entries()) {
        if (n.length >= 3 && (normCp.includes(n) || n.includes(normCp))) {
          matchedKey = k
          break
        }
      }
    }

    // 매칭 실패 → 통장 단독 거래처 생성
    if (!matchedKey) {
      const key = `bank::${counterparty}`
      if (!map.has(key)) map.set(key, makeRow(key, counterparty, ''))
      matchedKey = key
    }

    const row = map.get(matchedKey)!
    row.bankTxs.push(t)
    const isIn = String(t.transactionType) === 'IN'
    const amount = Math.abs(Number(t.amount || 0))
    if (isIn) {
      row.bankInAmount += amount
      row.bankInCount += 1
    } else {
      row.bankOutAmount += amount
      row.bankOutCount += 1
    }
  }

  // 잔액 계산
  for (const row of map.values()) {
    row.salesBalance = row.salesInvoiceAmount - row.bankInAmount
    row.purchaseBalance = row.purchaseInvoiceAmount - row.bankOutAmount
  }

  // 정렬: |매출잔액| + |매입잔액| 큰 순
  return Array.from(map.values()).sort(
    (a, b) =>
      (Math.abs(b.salesBalance) + Math.abs(b.purchaseBalance)) -
      (Math.abs(a.salesBalance) + Math.abs(a.purchaseBalance))
  )
}

/** 월별 그래프 데이터 */
function buildMonthlyChart(row: ContactRow) {
  const map = new Map<string, { salesInv: number; purchaseInv: number; bankIn: number; bankOut: number }>()
  const ensure = (m: string) => {
    if (!map.has(m)) map.set(m, { salesInv: 0, purchaseInv: 0, bankIn: 0, bankOut: 0 })
    return map.get(m)!
  }

  for (const t of row.invoices) {
    const date = String(t.transactAt || t.transactionDate || '').slice(0, 7)
    if (!date) continue
    const cur = ensure(date)
    const amt = Math.abs(Number(t.amount || 0))
    if (String(t.transactionType) === 'IN') cur.salesInv += amt
    else cur.purchaseInv += amt
  }

  for (const t of row.bankTxs) {
    const date = String(t.transactAt || t.transactionDate || '').slice(0, 7)
    if (!date) continue
    const cur = ensure(date)
    const amt = Math.abs(Number(t.amount || 0))
    if (String(t.transactionType) === 'IN') cur.bankIn += amt
    else cur.bankOut += amt
  }

  return Array.from(map.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, v]) => ({ month, ...v }))
}

// ─────────────────────────────────────────────────────────────────────────────
// KPI 카드
// ─────────────────────────────────────────────────────────────────────────────

function KPICard({
  label,
  value,
  tone = 'neutral',
  unit = '원',
}: {
  label: string
  value: number
  tone?: 'neutral' | 'emerald' | 'rose' | 'blue' | 'amber'
  unit?: string
}) {
  const colorMap: Record<string, string> = {
    neutral: 'text-ink-900',
    emerald: 'text-emerald-700',
    rose: 'text-rose-700',
    blue: 'text-blue-700',
    amber: 'text-amber-700',
  }
  return (
    <div className="panel px-3 py-2">
      <div className="text-2xs font-medium text-ink-500 uppercase tracking-wider">{label}</div>
      <div className={`mt-0.5 font-mono tabular-nums font-bold text-sm ${colorMap[tone]}`}>
        {unit === '원' ? formatCurrency(value, false) : `${value.toLocaleString('ko-KR')}${unit}`}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// 거래 유형 배지
// ─────────────────────────────────────────────────────────────────────────────

function TxTypeBadge({ type }: { type: '매출세계' | '매입세계' | '통장입금' | '통장출금' }) {
  const cls: Record<string, string> = {
    매출세계: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    매입세계: 'bg-rose-50 text-rose-700 border-rose-200',
    통장입금: 'bg-blue-50 text-blue-700 border-blue-200',
    통장출금: 'bg-amber-50 text-amber-700 border-amber-200',
  }
  return <span className={`badge ${cls[type]}`}>{type}</span>
}

// ─────────────────────────────────────────────────────────────────────────────
// 상세 패널
// ─────────────────────────────────────────────────────────────────────────────

function DetailPanel({
  row,
  onClose,
  onIssueInvoice,
}: {
  row: ContactRow
  onClose: () => void
  onIssueInvoice: (row: ContactRow) => void
}) {
  const chartData = useMemo(() => buildMonthlyChart(row), [row])

  // 거래 내역 통합 (시간 역순)
  const allTxs = useMemo(() => {
    type TxEntry = {
      id: string
      date: string
      txType: '매출세계' | '매입세계' | '통장입금' | '통장출금'
      amount: number
      note: string
    }
    const entries: TxEntry[] = []

    for (const t of row.invoices) {
      entries.push({
        id: t.id || Math.random().toString(),
        date: String(t.transactAt || t.transactionDate || '').slice(0, 10),
        txType: String(t.transactionType) === 'IN' ? '매출세계' : '매입세계',
        amount: Math.abs(Number(t.amount || 0)),
        note: String(t.content || t.description || ''),
      })
    }

    for (const t of row.bankTxs) {
      const bt = t?.bankTransaction || {}
      entries.push({
        id: t.id || Math.random().toString(),
        date: String(t.transactAt || t.transactionDate || '').slice(0, 10),
        txType: String(t.transactionType) === 'IN' ? '통장입금' : '통장출금',
        amount: Math.abs(Number(t.amount || 0)),
        note: String(bt.content || bt.remark || t.content || ''),
      })
    }

    return entries.sort((a, b) => b.date.localeCompare(a.date))
  }, [row])

  const infoFields: { label: string; value: string }[] = [
    { label: '회사명', value: row.companyName || '-' },
    { label: '사업자번호', value: row.businessNumber || '-' },
    { label: '대표자', value: row.representativeName || '-' },
    { label: '주소', value: row.address || '-' },
    { label: '이메일', value: row.email || '-' },
    { label: '전화', value: row.phone || '-' },
    { label: '업태', value: row.businessType || '-' },
    { label: '종목', value: row.businessItem || '-' },
  ]

  const totalInvoice = row.salesInvoiceAmount + row.purchaseInvoiceAmount
  const totalBank = row.bankInAmount + row.bankOutAmount

  return (
    <div className="panel flex flex-col h-full overflow-hidden">
      {/* A. 헤더 */}
      <div className="px-3 py-2 border-b border-ink-200 flex items-start justify-between gap-2 flex-shrink-0">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-ink-900 truncate">
            {row.companyName || row.key}
          </h2>
          {row.businessNumber && (
            <div className="text-2xs text-ink-500 font-mono">{row.businessNumber}</div>
          )}
        </div>
        <button
          onClick={onClose}
          className="text-ink-400 hover:text-ink-700 flex-shrink-0"
          aria-label="패널 닫기"
        >
          <XMarkIcon className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-4">
        {/* B. 핵심 KPI 4개 */}
        <div className="grid grid-cols-2 gap-2">
          <KPICard
            label="매출 잔액"
            value={row.salesBalance}
            tone={row.salesBalance > 0 ? 'amber' : row.salesBalance < 0 ? 'blue' : 'emerald'}
          />
          <KPICard
            label="매입 잔액"
            value={row.purchaseBalance}
            tone={row.purchaseBalance > 0 ? 'rose' : row.purchaseBalance < 0 ? 'blue' : 'emerald'}
          />
          <KPICard label="총 거래액 (세금계산서)" value={totalInvoice} tone="neutral" />
          <KPICard label="통장 거래 합" value={totalBank} tone="neutral" />
        </div>

        {/* C. 월별 그래프 */}
        {chartData.length > 0 && (
          <div>
            <div className="text-2xs font-semibold text-ink-600 uppercase tracking-wider mb-2">
              월별 거래 추이
            </div>
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={chartData} margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
                <XAxis
                  dataKey="month"
                  tick={{ fontSize: 9 }}
                  tickFormatter={(v: string) => v.slice(5)}
                />
                <YAxis
                  tick={{ fontSize: 9 }}
                  tickFormatter={(v: number) => formatCompactWon(v)}
                  width={46}
                />
                <Tooltip
                  formatter={(value: number, name: string) => [
                    formatCurrency(value, false),
                    name,
                  ]}
                  labelStyle={{ fontSize: 10 }}
                  contentStyle={{ fontSize: 10 }}
                />
                <Legend wrapperStyle={{ fontSize: 9 }} iconSize={8} />
                <Bar dataKey="salesInv" name="매출세금계산서" fill="#10b981" radius={[2, 2, 0, 0]} />
                <Bar dataKey="purchaseInv" name="매입세금계산서" fill="#f43f5e" radius={[2, 2, 0, 0]} />
                <Bar dataKey="bankIn" name="통장입금" fill="#3b82f6" radius={[2, 2, 0, 0]} />
                <Bar dataKey="bankOut" name="통장출금" fill="#f59e0b" radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* D. 거래처 상세정보 */}
        <div>
          <div className="text-2xs font-semibold text-ink-600 uppercase tracking-wider mb-2">
            거래처 정보
          </div>
          <div className="rounded-lg border border-ink-100 divide-y divide-ink-100">
            {infoFields.map(({ label, value }) => (
              <div key={label} className="flex gap-2 px-3 py-1.5">
                <span className="text-2xs text-ink-500 w-16 flex-shrink-0">{label}</span>
                <span className="text-2xs text-ink-900 break-all">{value}</span>
              </div>
            ))}
          </div>
        </div>

        {/* E. 세금계산서 발행 버튼 */}
        <button
          onClick={() => onIssueInvoice(row)}
          className="btn-primary w-full flex items-center justify-center gap-2 py-2"
        >
          <ReceiptPercentIcon className="h-4 w-4" />
          이 거래처에 세금계산서 발행
        </button>

        {/* F. 거래 내역 테이블 */}
        <div>
          <div className="text-2xs font-semibold text-ink-600 uppercase tracking-wider mb-2">
            거래 내역 ({allTxs.length}건)
          </div>
          <div className="max-h-72 overflow-y-auto rounded-lg border border-ink-100">
            <table className="min-w-full">
              <thead className="bg-canvas-50 sticky top-0 z-10 border-b border-ink-100">
                <tr>
                  <th className="px-2 py-1.5 text-left text-2xs font-semibold text-ink-500">일자</th>
                  <th className="px-2 py-1.5 text-left text-2xs font-semibold text-ink-500">유형</th>
                  <th className="px-2 py-1.5 text-right text-2xs font-semibold text-ink-500">금액</th>
                  <th className="px-2 py-1.5 text-left text-2xs font-semibold text-ink-500">적요</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-50">
                {allTxs.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="text-center py-4 text-2xs text-ink-400">
                      거래 내역 없음
                    </td>
                  </tr>
                ) : (
                  allTxs.map((tx) => (
                    <tr key={tx.id} className="hover:bg-canvas-50">
                      <td className="px-2 py-1 text-2xs font-mono text-ink-700 whitespace-nowrap">
                        {tx.date ? tx.date.slice(5).replace('-', '/') : '-'}
                      </td>
                      <td className="px-2 py-1">
                        <TxTypeBadge type={tx.txType} />
                      </td>
                      <td className="px-2 py-1 text-right font-mono text-2xs font-semibold text-ink-900 whitespace-nowrap">
                        {formatCurrency(tx.amount, false)}
                      </td>
                      <td className="px-2 py-1 text-2xs text-ink-600 truncate max-w-[100px]">
                        {tx.note || '-'}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// 메인 페이지
// ─────────────────────────────────────────────────────────────────────────────

export default function SettlementPage() {
  const navigate = useNavigate()

  const preset = usePeriodStore((s) => s.preset)
  const from = usePeriodStore((s) => s.from)
  const to = usePeriodStore((s) => s.to)
  const setPeriod = usePeriodStore((s) => s.set)
  const [search, setSearch] = useState('')
  const [filterMode, setFilterMode] = useState<FilterMode>('all')
  const [selectedKey, setSelectedKey] = useState<string | null>(null)

  const ready = Boolean(from && to)

  // 31일 클램프
  const periodSpan = ready ? daysBetween(from, to) : 0
  const exceeds31 = periodSpan > 31
  const actualStart = exceeds31 ? isoLocal(addDays(new Date(to), -30)) : from

  // 그랜터 연결 상태
  const healthQuery = useQuery({
    queryKey: ['granter-health'],
    queryFn: () => granterApi.health().then((r) => r.data),
    retry: false,
  })
  const isConfigured = healthQuery.data?.configured

  // 세금계산서 + 통장 거래 동시 조회
  const dataQuery = useQuery({
    queryKey: ['settlement-v2', actualStart, to],
    queryFn: async () => {
      // 그랜터 동시 호출 간헐 401 회피 — 순차 호출
      const taxRes = await granterApi.listTickets({ ticketType: 'TAX_INVOICE_TICKET', startDate: actualStart, endDate: to })
      const bankRes = await granterApi.listTickets({ ticketType: 'BANK_TRANSACTION_TICKET', startDate: actualStart, endDate: to })
      const tax = Array.isArray(taxRes.data) ? taxRes.data : (taxRes.data?.data || [])
      const bank = Array.isArray(bankRes.data) ? bankRes.data : (bankRes.data?.data || [])
      return { tax, bank }
    },
    enabled: !!isConfigured && ready,
    staleTime: 30 * 60_000,
    gcTime: 3 * 60 * 60_000,
    retry: 1,
  })

  // 본인 계좌 세트
  const assetsQuery = useQuery({
    queryKey: ['granter-all-assets'],
    queryFn: () => granterApi.listAllAssets(true).then((r) => r.data),
    enabled: !!isConfigured,
    staleTime: 5 * 60_000,
  })
  const ownAccounts = useMemo(() => buildOwnAccountSet(assetsQuery.data), [assetsQuery.data])

  // 법인 계좌 간 이체 제외
  const filteredBank = useMemo(
    () => filterOutInternalTransfers(dataQuery.data?.bank || [], ownAccounts),
    [dataQuery.data?.bank, ownAccounts]
  )
  const internalFilteredCount = (dataQuery.data?.bank?.length || 0) - filteredBank.length

  // 거래처 집계
  const contactRows = useMemo(
    () => buildContactRows(dataQuery.data?.tax || [], filteredBank),
    [dataQuery.data?.tax, filteredBank]
  )

  // 필터 + 검색
  const displayRows = useMemo(() => {
    let arr = contactRows

    if (search) {
      const s = search.toLowerCase().replace(/\s+/g, '')
      arr = arr.filter(
        (r) =>
          r.companyName.toLowerCase().replace(/\s+/g, '').includes(s) ||
          r.businessNumber.replace(/-/g, '').includes(s.replace(/-/g, ''))
      )
    }

    if (filterMode === 'receivable') {
      arr = arr.filter((r) => r.salesBalance > 0)
    } else if (filterMode === 'payable') {
      arr = arr.filter((r) => r.purchaseBalance > 0)
    } else if (filterMode === 'settled') {
      arr = arr.filter((r) => r.salesBalance === 0 && r.purchaseBalance === 0)
    }

    return arr
  }, [contactRows, search, filterMode])

  const selectedRow = useMemo(
    () => contactRows.find((r) => r.key === selectedKey) ?? null,
    [contactRows, selectedKey]
  )

  // 요약 KPI
  const summary = useMemo(() => {
    const totalSalesInv = contactRows.reduce((s, r) => s + r.salesInvoiceAmount, 0)
    const totalPurchaseInv = contactRows.reduce((s, r) => s + r.purchaseInvoiceAmount, 0)
    const totalBankIn = contactRows.reduce((s, r) => s + r.bankInAmount, 0)
    const totalBankOut = contactRows.reduce((s, r) => s + r.bankOutAmount, 0)
    const receivableCount = contactRows.filter((r) => r.salesBalance > 0).length
    const payableCount = contactRows.filter((r) => r.purchaseBalance > 0).length
    return { totalSalesInv, totalPurchaseInv, totalBankIn, totalBankOut, receivableCount, payableCount }
  }, [contactRows])

  // 세금계산서 발행 이동 (sessionStorage prefill)
  function handleIssueInvoice(row: ContactRow) {
    sessionStorage.setItem(
      'taxInvoicePrefill',
      JSON.stringify({
        businessNumber: row.businessNumber,
        companyName: row.companyName,
        representativeName: row.representativeName,
        address: row.address,
        email: row.email,
        phone: row.phone,
        businessType: row.businessType,
        businessItem: row.businessItem,
      })
    )
    navigate('/tax-invoices')
  }

  return (
    <div className="space-y-3">
      {/* 헤더 */}
      <div className="flex items-end justify-between flex-wrap gap-2">
        <div>
          <h1 className="flex items-center gap-2">
            <ArrowsRightLeftIcon className="h-4 w-4 text-ink-500" />
            거래처 정산
          </h1>
          <p className="text-2xs text-ink-500 mt-0.5">
            매출·매입 세금계산서 + 통장 거래를 거래처별로 양방향 정산
          </p>
          {internalFilteredCount > 0 && (
            <span className="text-2xs text-ink-400">
              · 법인 계좌 간 이체 {internalFilteredCount}건 제외
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
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
          <button
            onClick={() => dataQuery.refetch()}
            disabled={dataQuery.isFetching}
            className="btn-secondary"
            title="새로고침"
          >
            <ArrowPathIcon className={`h-3 w-3 ${dataQuery.isFetching ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* 연결 상태 */}
      {!isConfigured ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 flex items-center gap-2">
          <ExclamationTriangleIcon className="h-4 w-4 text-amber-600" />
          <span className="text-2xs text-amber-800">그랜터 API 키 미설정 — 설정 페이지에서 연동하세요</span>
        </div>
      ) : (
        <div className="flex items-center gap-2 flex-wrap">
          <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-1 flex items-center gap-2">
            <CheckCircleIcon className="h-3.5 w-3.5 text-emerald-600" />
            <span className="text-2xs text-emerald-800">그랜터 연결됨</span>
          </div>
          {exceeds31 && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-1 text-2xs text-amber-800">
              31일 초과 — 종료일 기준 최근 31일만 조회
            </div>
          )}
        </div>
      )}

      {/* 요약 KPI */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-2">
        <KPICard label="거래처 수" value={contactRows.length} unit="곳" tone="neutral" />
        <KPICard label="매출 세금계산서" value={summary.totalSalesInv} tone="emerald" />
        <KPICard label="매입 세금계산서" value={summary.totalPurchaseInv} tone="rose" />
        <KPICard label="통장 입금" value={summary.totalBankIn} tone="blue" />
        <KPICard label="통장 출금" value={summary.totalBankOut} tone="amber" />
        <div className="panel px-3 py-2">
          <div className="text-2xs font-medium text-ink-500 uppercase tracking-wider">미정산</div>
          <div className="mt-0.5 text-sm font-bold text-ink-900">
            <span className="text-amber-700">{summary.receivableCount}</span>
            <span className="text-ink-400 text-2xs font-normal mx-1">미수</span>
            <span className="text-rose-700">{summary.payableCount}</span>
            <span className="text-ink-400 text-2xs font-normal ml-1">미지급</span>
          </div>
        </div>
      </div>

      {/* 필터 바 */}
      <div className="panel p-2 flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-0.5 p-0.5 rounded-md bg-canvas-50 border border-ink-200">
          {(
            [
              { key: 'all', label: '전체' },
              { key: 'receivable', label: '미수있음' },
              { key: 'payable', label: '미지급있음' },
              { key: 'settled', label: '매칭완료' },
            ] as { key: FilterMode; label: string }[]
          ).map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setFilterMode(key)}
              className={`px-2.5 py-1 rounded text-2xs font-semibold ${
                filterMode === key ? 'bg-ink-900 text-white' : 'text-ink-600 hover:bg-white'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="text-2xs text-ink-400">
          {displayRows.length}/{contactRows.length}곳
        </span>
        <div className="relative ml-auto">
          <MagnifyingGlassIcon className="h-3 w-3 absolute left-2 top-1/2 -translate-y-1/2 text-ink-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="회사명/사업자번호 검색"
            className="pl-7 input w-48 text-2xs"
          />
        </div>
      </div>

      {/* 2-pane: 거래처 테이블 + 상세 패널 */}
      <div className="grid grid-cols-12 gap-3">
        {/* 좌측: 거래처 리스트 */}
        <div className={selectedRow ? 'col-span-6' : 'col-span-12'}>
          <div className="panel overflow-hidden">
            <div className="overflow-x-auto max-h-[calc(100vh-26rem)] overflow-y-auto">
              <table className="min-w-full">
                <thead className="bg-canvas-50 sticky top-0 z-10 border-b border-ink-200">
                  <tr>
                    <th className="px-3 py-1.5 text-left text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                      거래처
                    </th>
                    <th className="px-2 py-1.5 text-right text-2xs font-semibold text-emerald-600 uppercase tracking-wider whitespace-nowrap">
                      매출세금계산서
                    </th>
                    <th className="px-2 py-1.5 text-right text-2xs font-semibold text-rose-600 uppercase tracking-wider whitespace-nowrap">
                      매입세금계산서
                    </th>
                    <th className="px-2 py-1.5 text-right text-2xs font-semibold text-blue-600 uppercase tracking-wider whitespace-nowrap">
                      통장입금
                    </th>
                    <th className="px-2 py-1.5 text-right text-2xs font-semibold text-amber-600 uppercase tracking-wider whitespace-nowrap">
                      통장출금
                    </th>
                    <th className="px-2 py-1.5 text-right text-2xs font-semibold text-ink-500 uppercase tracking-wider whitespace-nowrap">
                      매출잔액
                    </th>
                    <th className="px-2 py-1.5 text-right text-2xs font-semibold text-ink-500 uppercase tracking-wider whitespace-nowrap">
                      매입잔액
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {dataQuery.isLoading && (
                    <tr>
                      <td colSpan={7} className="text-center py-8 text-2xs text-ink-400">
                        불러오는 중…
                      </td>
                    </tr>
                  )}
                  {!dataQuery.isLoading && displayRows.length === 0 && (
                    <tr>
                      <td colSpan={7} className="text-center py-8 text-2xs text-ink-400">
                        <BuildingOffice2Icon className="h-6 w-6 mx-auto mb-2 text-ink-300" />
                        <div>조건에 맞는 거래처가 없습니다.</div>
                        <div className="mt-1 text-ink-300">기간을 변경하거나 필터를 조정해보세요.</div>
                      </td>
                    </tr>
                  )}
                  {displayRows.map((row) => {
                    const isSel = selectedKey === row.key
                    return (
                      <tr
                        key={row.key}
                        onClick={() => setSelectedKey(isSel ? null : row.key)}
                        className={`cursor-pointer transition-colors ${
                          isSel ? 'bg-primary-50' : 'hover:bg-canvas-50'
                        }`}
                      >
                        {/* 거래처명 */}
                        <td className="px-3 py-1.5 max-w-[120px]">
                          <div className={`text-xs font-medium truncate ${isSel ? 'text-primary-800' : 'text-ink-900'}`}>
                            {row.companyName || row.key}
                          </div>
                          {row.businessNumber && (
                            <div className="text-2xs text-ink-400 font-mono truncate">
                              {row.businessNumber}
                            </div>
                          )}
                        </td>
                        {/* 매출 세금계산서 */}
                        <td className="px-2 py-1.5 text-right font-mono tabular-nums text-2xs text-emerald-700 font-semibold whitespace-nowrap">
                          {row.salesInvoiceAmount > 0
                            ? formatCurrency(row.salesInvoiceAmount, false)
                            : <span className="text-ink-200">-</span>}
                        </td>
                        {/* 매입 세금계산서 */}
                        <td className="px-2 py-1.5 text-right font-mono tabular-nums text-2xs text-rose-700 font-semibold whitespace-nowrap">
                          {row.purchaseInvoiceAmount > 0
                            ? formatCurrency(row.purchaseInvoiceAmount, false)
                            : <span className="text-ink-200">-</span>}
                        </td>
                        {/* 통장 입금 */}
                        <td className="px-2 py-1.5 text-right font-mono tabular-nums text-2xs text-blue-700 font-semibold whitespace-nowrap">
                          {row.bankInAmount > 0
                            ? formatCurrency(row.bankInAmount, false)
                            : <span className="text-ink-200">-</span>}
                        </td>
                        {/* 통장 출금 */}
                        <td className="px-2 py-1.5 text-right font-mono tabular-nums text-2xs text-amber-700 font-semibold whitespace-nowrap">
                          {row.bankOutAmount > 0
                            ? formatCurrency(row.bankOutAmount, false)
                            : <span className="text-ink-200">-</span>}
                        </td>
                        {/* 매출 잔액 */}
                        <td className="px-2 py-1.5 text-right font-mono tabular-nums text-2xs font-semibold whitespace-nowrap">
                          {row.salesInvoiceAmount > 0 || row.bankInAmount > 0 ? (
                            <span className={
                              row.salesBalance > 0
                                ? 'text-amber-700'
                                : row.salesBalance < 0
                                ? 'text-blue-700'
                                : 'text-emerald-700'
                            }>
                              {row.salesBalance > 0 ? '+' : ''}
                              {formatCurrency(row.salesBalance, false)}
                            </span>
                          ) : (
                            <span className="text-ink-200">-</span>
                          )}
                        </td>
                        {/* 매입 잔액 */}
                        <td className="px-2 py-1.5 text-right font-mono tabular-nums text-2xs font-semibold whitespace-nowrap">
                          {row.purchaseInvoiceAmount > 0 || row.bankOutAmount > 0 ? (
                            <span className={
                              row.purchaseBalance > 0
                                ? 'text-rose-700'
                                : row.purchaseBalance < 0
                                ? 'text-blue-700'
                                : 'text-emerald-700'
                            }>
                              {row.purchaseBalance > 0 ? '+' : ''}
                              {formatCurrency(row.purchaseBalance, false)}
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
          </div>
        </div>

        {/* 우측: 상세 패널 */}
        {selectedRow && (
          <div className="col-span-6">
            <div className="max-h-[calc(100vh-20rem)] overflow-hidden">
              <DetailPanel
                row={selectedRow}
                onClose={() => setSelectedKey(null)}
                onIssueInvoice={handleIssueInvoice}
              />
            </div>
          </div>
        )}
      </div>

      <div className="text-2xs text-ink-400 px-1">
        ※ 매출잔액 = 매출세금계산서 − 통장입금, 매입잔액 = 매입세금계산서 − 통장출금.
        양수=미수/미지급, 음수=초과입금/초과지급. 통장 매칭은 거래처명 유사도 기준.
      </div>
    </div>
  )
}
