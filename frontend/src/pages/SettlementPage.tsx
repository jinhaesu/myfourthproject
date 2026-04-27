import { useState } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import {
  PaperAirplaneIcon,
  MagnifyingGlassIcon,
  ExclamationTriangleIcon,
  ArrowsRightLeftIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline'
import { settlementApi } from '@/services/api'
import StatCard from '@/components/common/StatCard'
import { formatCurrency, formatCompactWon, formatDate, maskBusinessNumber } from '@/utils/format'

export default function SettlementPage() {
  const [counterpartyType, setCounterpartyType] = useState<string | undefined>(undefined)
  const [search, setSearch] = useState('')
  const [onlyOverdue, setOnlyOverdue] = useState(false)
  const [selectedId, setSelectedId] = useState<number | null>(null)

  const listQuery = useQuery({
    queryKey: ['settlements', counterpartyType, search, onlyOverdue],
    queryFn: () =>
      settlementApi
        .list({
          counterparty_type: counterpartyType as any,
          search: search || undefined,
          only_overdue: onlyOverdue || undefined,
          size: 100,
        })
        .then((r) => r.data),
  })

  const detailQuery = useQuery({
    queryKey: ['settlement-detail', selectedId],
    queryFn: () => settlementApi.getDetail(selectedId!).then((r) => r.data),
    enabled: !!selectedId,
  })

  const sendStatementMutation = useMutation({
    mutationFn: (id: number) => settlementApi.sendStatement(id, 'email'),
    onSuccess: () => toast.success('정산서 발송이 큐에 등록되었습니다.'),
  })

  const list = listQuery.data
  const items: any[] = list?.items || []

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">매출·매입·거래처 정산</h1>
          <p className="text-gray-500 mt-1">
            거래처별 받을 돈/줄 돈을 한 화면에서. 채권·채무 상계도 한 번에.
          </p>
        </div>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="받을 돈 합계"
          value={formatCompactWon(list?.total_receivable)}
          unit="원"
          tone="success"
        />
        <StatCard
          label="줄 돈 합계"
          value={formatCompactWon(list?.total_payable)}
          unit="원"
          tone="danger"
        />
        <StatCard
          label="순잔액"
          value={formatCompactWon(list?.total_net)}
          unit="원"
          tone={Number(list?.total_net ?? 0) >= 0 ? 'mint' : 'warning'}
        />
        <StatCard
          label="거래처 수"
          value={list?.total_count ?? 0}
          unit="곳"
          tone="primary"
        />
      </div>

      {/* Filters */}
      <div className="card">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex gap-1 bg-gray-100 rounded-lg p-1">
            {[
              { key: undefined, label: '전체' },
              { key: 'customer', label: '매출처' },
              { key: 'vendor', label: '매입처' },
              { key: 'both', label: '양방향' },
            ].map((t) => (
              <button
                key={t.label}
                onClick={() => setCounterpartyType(t.key)}
                className={`px-3 py-1.5 rounded-md text-sm font-medium ${
                  counterpartyType === t.key ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={onlyOverdue}
              onChange={(e) => setOnlyOverdue(e.target.checked)}
              className="rounded border-gray-300 text-primary-600 focus:ring-primary-500"
            />
            연체만
          </label>

          <div className="relative ml-auto">
            <MagnifyingGlassIcon className="h-4 w-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="거래처명/사업자번호 검색"
              className="pl-8 input w-64"
            />
          </div>
        </div>
      </div>

      {/* Counterparty list */}
      <div className="card p-0 overflow-hidden">
        <div className="table-container border-0">
          <table className="table">
            <thead className="table-header">
              <tr>
                <th>거래처</th>
                <th>구분</th>
                <th className="text-right">받을 돈</th>
                <th className="text-right">줄 돈</th>
                <th className="text-right">순잔액</th>
                <th className="text-right">연체</th>
                <th>최근 거래</th>
                <th></th>
              </tr>
            </thead>
            <tbody className="table-body">
              {items.map((it) => (
                <tr key={it.counterparty_id} className="cursor-pointer" onClick={() => setSelectedId(it.counterparty_id)}>
                  <td>
                    <div className="font-medium text-gray-900">{it.counterparty_name}</div>
                    <div className="text-xs text-gray-500 font-mono">
                      {maskBusinessNumber(it.business_number)}
                    </div>
                  </td>
                  <td>
                    <span
                      className={
                        it.counterparty_type === 'customer'
                          ? 'badge bg-blue-100 text-blue-700'
                          : it.counterparty_type === 'vendor'
                          ? 'badge bg-amber-100 text-amber-700'
                          : 'badge bg-purple-100 text-purple-700'
                      }
                    >
                      {it.counterparty_type === 'customer'
                        ? '매출처'
                        : it.counterparty_type === 'vendor'
                        ? '매입처'
                        : '양방향'}
                    </span>
                  </td>
                  <td className="text-right font-mono tabular-nums text-emerald-700">
                    {formatCurrency(it.receivable_total, false)}
                  </td>
                  <td className="text-right font-mono tabular-nums text-rose-700">
                    {formatCurrency(it.payable_total, false)}
                  </td>
                  <td className={`text-right font-mono tabular-nums font-semibold ${
                    Number(it.net_balance) >= 0 ? 'text-emerald-700' : 'text-rose-700'
                  }`}>
                    {formatCurrency(it.net_balance, false)}
                  </td>
                  <td className="text-right">
                    {Number(it.overdue_amount) > 0 ? (
                      <span className="inline-flex items-center text-rose-600 font-medium font-mono tabular-nums">
                        <ExclamationTriangleIcon className="h-4 w-4 mr-1" />
                        {formatCurrency(it.overdue_amount, false)}
                      </span>
                    ) : (
                      <span className="text-gray-300">-</span>
                    )}
                  </td>
                  <td className="text-sm text-gray-500">{formatDate(it.last_transaction_date)}</td>
                  <td>
                    <button
                      className="text-xs text-primary-600 hover:underline"
                      onClick={(e) => {
                        e.stopPropagation()
                        sendStatementMutation.mutate(it.counterparty_id)
                      }}
                    >
                      <PaperAirplaneIcon className="h-3.5 w-3.5 inline mr-0.5" />
                      정산서
                    </button>
                  </td>
                </tr>
              ))}
              {items.length === 0 && !listQuery.isLoading && (
                <tr>
                  <td colSpan={8} className="text-center text-gray-400 py-8">
                    거래처가 없습니다.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {selectedId && (
        <DetailDrawer
          counterpartyId={selectedId}
          detail={detailQuery.data}
          loading={detailQuery.isLoading}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  )
}

function DetailDrawer({
  counterpartyId,
  detail,
  loading,
  onClose,
}: {
  counterpartyId: number
  detail: any
  loading: boolean
  onClose: () => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-black/40" onClick={onClose} />
      <div className="w-full max-w-2xl bg-white shadow-2xl overflow-y-auto">
        <div className="sticky top-0 bg-white border-b border-gray-200 p-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-gray-900">
            {detail?.counterparty?.counterparty_name || '거래처 #' + counterpartyId}
          </h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <XMarkIcon className="h-5 w-5" />
          </button>
        </div>

        {loading ? (
          <div className="p-6 text-gray-400">불러오는 중...</div>
        ) : (
          <div className="p-6 space-y-6">
            {detail && (
              <>
                <div className="grid grid-cols-3 gap-3">
                  <div className="rounded border border-gray-200 p-3 text-center">
                    <div className="text-xs text-gray-500">받을 돈</div>
                    <div className="mt-1 font-mono font-semibold text-emerald-700">
                      {formatCurrency(detail.counterparty.receivable_total, false)}
                    </div>
                  </div>
                  <div className="rounded border border-gray-200 p-3 text-center">
                    <div className="text-xs text-gray-500">줄 돈</div>
                    <div className="mt-1 font-mono font-semibold text-rose-700">
                      {formatCurrency(detail.counterparty.payable_total, false)}
                    </div>
                  </div>
                  <div className="rounded border border-gray-200 p-3 text-center">
                    <div className="text-xs text-gray-500">순잔액</div>
                    <div
                      className={`mt-1 font-mono font-semibold ${
                        Number(detail.counterparty.net_balance) >= 0
                          ? 'text-emerald-700'
                          : 'text-rose-700'
                      }`}
                    >
                      {formatCurrency(detail.counterparty.net_balance, false)}
                    </div>
                  </div>
                </div>

                <div>
                  <div className="flex items-center justify-between mb-3">
                    <h4 className="font-semibold text-gray-900">거래 내역</h4>
                    <button className="btn-secondary text-sm">
                      <ArrowsRightLeftIcon className="h-4 w-4 mr-1" />
                      상계 처리
                    </button>
                  </div>
                  <div className="space-y-2">
                    {detail.items?.map((it: any) => (
                      <div
                        key={it.id}
                        className="border border-gray-200 rounded p-3 flex items-center justify-between"
                      >
                        <div>
                          <div className="text-xs text-gray-500">
                            {formatDate(it.transaction_date)} ·{' '}
                            {it.document_type === 'tax_invoice'
                              ? '세금계산서'
                              : it.document_type === 'payment'
                              ? '입출금'
                              : it.document_type === 'receivable'
                              ? '매출'
                              : '매입'}
                            {it.document_number && ` · ${it.document_number}`}
                          </div>
                          <div className="font-medium text-gray-900">{it.description}</div>
                          {it.due_date && (
                            <div className="text-xs text-gray-500">
                              만기 {formatDate(it.due_date)}
                            </div>
                          )}
                        </div>
                        <div className="text-right">
                          <div
                            className={`font-mono font-semibold ${
                              it.direction === 'receivable' ? 'text-emerald-700' : 'text-rose-700'
                            }`}
                          >
                            {formatCurrency(it.outstanding, false)}
                          </div>
                          <div className="text-xs text-gray-400">
                            전체 {formatCurrency(it.amount, false)}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
