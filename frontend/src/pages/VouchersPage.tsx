import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import {
  CalendarDaysIcon,
  MagnifyingGlassIcon,
  ArrowDownTrayIcon,
  ArrowPathIcon,
  PlusIcon,
  PencilSquareIcon,
  CheckIcon,
  XMarkIcon,
  DocumentTextIcon,
} from '@heroicons/react/24/outline'
import { unifiedApi, ledgerApi } from '@/services/api'
import { useAuthStore } from '@/store/authStore'
import { formatCurrency, formatCompactWon } from '@/utils/format'

type Direction = 'all' | 'debit' | 'credit'
type ViewMode = 'period' | 'monthly'

export default function VouchersPage() {
  const userId = useAuthStore((s) => s.user?.id ?? 1)
  const qc = useQueryClient()

  const yearsQuery = useQuery({
    queryKey: ['ledger-years'],
    queryFn: () => ledgerApi.getAvailableYears().then((r) => r.data),
  })
  const latestYear: number | null = yearsQuery.data?.latest ?? null
  const availableYears: number[] = yearsQuery.data?.years || []

  const [viewMode, setViewMode] = useState<ViewMode>('monthly')
  const [year, setYear] = useState<number | null>(null)
  const [month, setMonth] = useState<number>(1)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [direction, setDirection] = useState<Direction>('all')
  const [search, setSearch] = useState('')
  const [editingId, setEditingId] = useState<number | null>(null)

  useEffect(() => {
    if (latestYear && !year) {
      setYear(latestYear)
      setMonth(1)
    }
  }, [latestYear]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (viewMode === 'monthly' && year) {
      const m = String(month).padStart(2, '0')
      const lastDay = new Date(year, month, 0).getDate()
      setFrom(`${year}-${m}-01`)
      setTo(`${year}-${m}-${String(lastDay).padStart(2, '0')}`)
    }
  }, [viewMode, year, month])

  const ready = Boolean(from && to)

  const txQuery = useQuery({
    queryKey: ['vouchers-raw', from, to, direction, search],
    queryFn: () =>
      unifiedApi
        .listTransactions({
          from_date: from,
          to_date: to,
          direction:
            direction !== 'all' ? (direction === 'debit' ? 'inbound' : 'outbound') : undefined,
          search: search || undefined,
          size: 1000,
        })
        .then((r) => r.data),
    enabled: ready,
  })

  const items: any[] = txQuery.data?.items || []
  const summary = txQuery.data?.summary

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-end justify-between flex-wrap gap-2">
        <div>
          <h1 className="flex items-center gap-2">
            <DocumentTextIcon className="h-4 w-4 text-ink-500" />
            전표 관리
          </h1>
          <p className="text-2xs text-ink-500 mt-0.5">
            업로드된 전표 조회 · 인라인 수정 · 차변/대변 토글
          </p>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <button className="btn-secondary">
            <ArrowDownTrayIcon className="h-3 w-3 mr-1" />
            엑셀
          </button>
          <button
            onClick={() => qc.invalidateQueries({ queryKey: ['vouchers-raw'] })}
            className="btn-secondary"
          >
            <ArrowPathIcon className="h-3 w-3" />
          </button>
          <button className="btn-primary">
            <PlusIcon className="h-3 w-3 mr-1" />
            신규 전표
          </button>
        </div>
      </div>

      {/* Filter bar */}
      <div className="panel p-2 flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-0.5 p-0.5 rounded-md bg-canvas-50 border border-ink-200">
          <button
            onClick={() => setViewMode('monthly')}
            className={`px-2.5 py-1 rounded text-2xs font-semibold transition ${
              viewMode === 'monthly' ? 'bg-ink-900 text-white' : 'text-ink-600'
            }`}
          >
            월별
          </button>
          <button
            onClick={() => setViewMode('period')}
            className={`px-2.5 py-1 rounded text-2xs font-semibold transition ${
              viewMode === 'period' ? 'bg-ink-900 text-white' : 'text-ink-600'
            }`}
          >
            기간
          </button>
        </div>

        {viewMode === 'monthly' ? (
          <>
            <select
              value={year || ''}
              onChange={(e) => setYear(Number(e.target.value))}
              className="input w-24"
            >
              {availableYears.map((y) => (
                <option key={y} value={y}>
                  {y}년
                </option>
              ))}
            </select>
            <div className="flex items-center gap-0.5 p-0.5 rounded-md bg-canvas-50 border border-ink-200">
              {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                <button
                  key={m}
                  onClick={() => setMonth(m)}
                  className={`w-7 py-1 rounded text-2xs font-semibold transition ${
                    month === m ? 'bg-ink-900 text-white' : 'text-ink-600 hover:bg-white'
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>
          </>
        ) : (
          <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-canvas-50 border border-ink-200">
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
        )}

        <div className="flex items-center gap-0.5 p-0.5 rounded-md bg-canvas-50 border border-ink-200 ml-auto">
          {(['all', 'debit', 'credit'] as Direction[]).map((d) => (
            <button
              key={d}
              onClick={() => setDirection(d)}
              className={`px-2 py-1 rounded text-2xs font-semibold transition ${
                direction === d ? 'bg-ink-900 text-white' : 'text-ink-600'
              }`}
            >
              {d === 'all' ? '전체' : d === 'debit' ? '차변' : '대변'}
            </button>
          ))}
        </div>

        <div className="relative">
          <MagnifyingGlassIcon className="h-3 w-3 absolute left-2 top-1/2 -translate-y-1/2 text-ink-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="적요·거래처 검색"
            className="pl-7 input w-44 text-2xs"
          />
        </div>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <SummaryChip
          label="총 거래"
          value={`${(txQuery.data?.total ?? 0).toLocaleString('ko-KR')}건`}
        />
        <SummaryChip
          label="입금(차변)"
          value={formatCompactWon(summary?.inbound_total)}
          unit="원"
          tone="success"
        />
        <SummaryChip
          label="출금(대변)"
          value={formatCompactWon(summary?.outbound_total)}
          unit="원"
          tone="danger"
        />
        <SummaryChip
          label="순잔액"
          value={formatCompactWon(summary?.total_balance)}
          unit="원"
          tone={Number(summary?.total_balance ?? 0) >= 0 ? 'mint' : 'warning'}
        />
      </div>

      {/* Table */}
      <div className="panel overflow-hidden">
        <div className="overflow-x-auto max-h-[calc(100vh-22rem)] overflow-y-auto">
          <table className="min-w-full">
            <thead className="bg-canvas-50 sticky top-0 z-10 border-b border-ink-200">
              <tr>
                <th className="px-2.5 py-1.5 text-left text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                  날짜
                </th>
                <th className="px-2.5 py-1.5 text-left text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                  구분
                </th>
                <th className="px-2.5 py-1.5 text-left text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                  코드
                </th>
                <th className="px-2.5 py-1.5 text-left text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                  계정과목
                </th>
                <th className="px-2.5 py-1.5 text-left text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                  거래처
                </th>
                <th className="px-2.5 py-1.5 text-right text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                  차변
                </th>
                <th className="px-2.5 py-1.5 text-right text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                  대변
                </th>
                <th className="px-2.5 py-1.5 text-left text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                  적요
                </th>
                <th className="px-2.5 py-1.5"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {txQuery.isLoading && (
                <tr>
                  <td colSpan={9} className="text-center text-2xs text-ink-400 py-6">
                    불러오는 중…
                  </td>
                </tr>
              )}
              {!txQuery.isLoading &&
                items.map((it: any) => {
                  const id = Number(String(it.id).replace('raw-', ''))
                  const isEditing = editingId === id
                  const isDebit = it.direction === 'inbound'
                  return (
                    <VoucherRow
                      key={id}
                      id={id}
                      raw={it}
                      isDebit={isDebit}
                      isEditing={isEditing}
                      userId={userId}
                      onEdit={() => setEditingId(id)}
                      onClose={() => setEditingId(null)}
                    />
                  )
                })}
              {!txQuery.isLoading && items.length === 0 && (
                <tr>
                  <td colSpan={9} className="text-center text-2xs text-ink-400 py-6">
                    이 기간에 전표가 없습니다.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="text-2xs text-ink-400 px-1">
        ※ 행 클릭으로 인라인 수정 · 계정 코드/과목 변경은 계정별 원장 페이지에서 가능 · 더 정밀한 편집은 거래 클릭 후 디테일 패널에서.
      </div>
    </div>
  )
}

function SummaryChip({
  label,
  value,
  unit,
  tone = 'neutral',
}: {
  label: string
  value: string
  unit?: string
  tone?: 'neutral' | 'success' | 'danger' | 'mint' | 'warning'
}) {
  const toneClass: Record<string, string> = {
    neutral: 'text-ink-900',
    success: 'text-emerald-700',
    danger: 'text-rose-700',
    mint: 'text-primary-700',
    warning: 'text-amber-700',
  }
  return (
    <div className="panel px-3 py-2">
      <div className="text-2xs font-medium text-ink-500 uppercase tracking-wider">{label}</div>
      <div className={`mt-0.5 font-mono tabular-nums font-bold text-base ${toneClass[tone]}`}>
        {value}
        {unit && <span className="text-2xs text-ink-400 ml-1 font-medium">{unit}</span>}
      </div>
    </div>
  )
}

interface VoucherRowProps {
  id: number
  raw: any
  isDebit: boolean
  isEditing: boolean
  userId: number
  onEdit: () => void
  onClose: () => void
}

function VoucherRow({ id, raw, isDebit, isEditing, userId, onEdit, onClose }: VoucherRowProps) {
  const qc = useQueryClient()
  const [direction, setDirection] = useState<'debit' | 'credit'>(isDebit ? 'debit' : 'credit')
  const [amount, setAmount] = useState(String(raw.amount || 0))
  const [counterparty, setCounterparty] = useState(raw.counterparty || '')
  const [description, setDescription] = useState(raw.description || '')

  useEffect(() => {
    if (isEditing) {
      setDirection(isDebit ? 'debit' : 'credit')
      setAmount(String(raw.amount || 0))
      setCounterparty(raw.counterparty || '')
      setDescription(raw.description || '')
    }
  }, [isEditing])

  const saveMut = useMutation({
    mutationFn: () =>
      ledgerApi.updateEntry(
        id,
        {
          direction,
          amount: Number(amount),
          counterparty: counterparty || undefined,
          description: description || undefined,
        },
        userId
      ),
    onSuccess: () => {
      toast.success('수정되었습니다.')
      qc.invalidateQueries({ queryKey: ['vouchers-raw'] })
      qc.invalidateQueries({ queryKey: ['ledger-entries'] })
      qc.invalidateQueries({ queryKey: ['ledger-accounts'] })
      onClose()
    },
    onError: (e: any) => toast.error(e.response?.data?.detail || '저장 실패'),
  })

  const dateStr = String(raw.transaction_date)

  if (!isEditing) {
    const sourceCode = raw.source_label?.match(/\((\d+)\)/)?.[1] || ''
    const sourceName = raw.source_label?.replace(/\s*\(\d+\)/, '') || ''
    return (
      <tr className="hover:bg-canvas-50 cursor-pointer group" onClick={onEdit}>
        <td className="px-2.5 py-1.5 text-2xs text-ink-700 font-mono whitespace-nowrap">
          {dateStr}
        </td>
        <td className="px-2.5 py-1.5 whitespace-nowrap">
          <span
            className={`badge ${
              isDebit
                ? 'bg-primary-50 text-primary-700 border-primary-200'
                : 'bg-rose-50 text-rose-700 border-rose-200'
            }`}
          >
            {isDebit ? '차변' : '대변'}
          </span>
        </td>
        <td className="px-2.5 py-1.5 text-2xs font-mono text-ink-500">{sourceCode || '-'}</td>
        <td className="px-2.5 py-1.5 text-xs text-ink-700 font-medium">{sourceName || '-'}</td>
        <td className="px-2.5 py-1.5 text-xs text-ink-900">{raw.counterparty || '-'}</td>
        <td className="px-2.5 py-1.5 text-right font-mono tabular-nums text-xs whitespace-nowrap">
          {isDebit ? (
            <span className="text-primary-700 font-semibold">
              {formatCurrency(raw.amount, false)}
            </span>
          ) : (
            <span className="text-ink-200">-</span>
          )}
        </td>
        <td className="px-2.5 py-1.5 text-right font-mono tabular-nums text-xs whitespace-nowrap">
          {!isDebit ? (
            <span className="text-rose-700 font-semibold">
              {formatCurrency(raw.amount, false)}
            </span>
          ) : (
            <span className="text-ink-200">-</span>
          )}
        </td>
        <td className="px-2.5 py-1.5 text-xs text-ink-700 max-w-md truncate">
          {raw.description}
        </td>
        <td className="px-2.5 py-1.5">
          <PencilSquareIcon className="h-3 w-3 text-ink-300 group-hover:text-ink-700" />
        </td>
      </tr>
    )
  }

  return (
    <tr className="bg-amber-50/40">
      <td className="px-2.5 py-1.5 text-2xs text-ink-700 font-mono whitespace-nowrap">
        {dateStr}
      </td>
      <td className="px-2.5 py-1.5">
        <div className="flex bg-white border border-ink-200 rounded overflow-hidden">
          <button
            onClick={() => setDirection('debit')}
            className={`px-1.5 py-0.5 text-2xs font-semibold ${
              direction === 'debit' ? 'bg-primary-600 text-white' : 'text-ink-600'
            }`}
          >
            차
          </button>
          <button
            onClick={() => setDirection('credit')}
            className={`px-1.5 py-0.5 text-2xs font-semibold ${
              direction === 'credit' ? 'bg-rose-600 text-white' : 'text-ink-600'
            }`}
          >
            대
          </button>
        </div>
      </td>
      <td colSpan={2} className="px-2.5 py-1.5 text-xs text-ink-500">
        {raw.source_label}
      </td>
      <td className="px-2.5 py-1.5">
        <input
          value={counterparty}
          onChange={(e) => setCounterparty(e.target.value)}
          className="input text-2xs"
        />
      </td>
      <td colSpan={2} className="px-2.5 py-1.5">
        <input
          type="number"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className="input text-right font-mono"
        />
      </td>
      <td className="px-2.5 py-1.5">
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="input text-xs"
        />
      </td>
      <td className="px-2.5 py-1.5 whitespace-nowrap">
        <div className="flex gap-1">
          <button
            onClick={() => saveMut.mutate()}
            disabled={saveMut.isPending}
            className="btn-primary"
            title="저장"
          >
            <CheckIcon className="h-3 w-3" />
          </button>
          <button onClick={onClose} className="btn-secondary" title="취소">
            <XMarkIcon className="h-3 w-3" />
          </button>
        </div>
      </td>
    </tr>
  )
}
