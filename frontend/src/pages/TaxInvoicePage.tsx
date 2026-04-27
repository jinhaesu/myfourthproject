import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import {
  DocumentTextIcon,
  PlusIcon,
  PaperAirplaneIcon,
  ArrowDownTrayIcon,
  XCircleIcon,
  XMarkIcon,
  TrashIcon,
} from '@heroicons/react/24/outline'
import { taxInvoiceApi } from '@/services/api'
import { useAuthStore } from '@/store/authStore'
import StatCard from '@/components/common/StatCard'
import { formatCurrency, formatCompactWon, formatDate, maskBusinessNumber, todayISO } from '@/utils/format'

type Direction = 'sales' | 'purchase'

const STATUS_LABEL: Record<string, { label: string; class: string }> = {
  draft: { label: '임시저장', class: 'badge bg-gray-100 text-gray-700' },
  issued: { label: '발행완료', class: 'badge bg-emerald-100 text-emerald-700' },
  sent: { label: '발송완료', class: 'badge bg-blue-100 text-blue-700' },
  approved: { label: '승인', class: 'badge bg-emerald-100 text-emerald-700' },
  cancelled: { label: '취소', class: 'badge bg-rose-100 text-rose-700' },
  rejected: { label: '거부', class: 'badge bg-rose-100 text-rose-700' },
}

export default function TaxInvoicePage() {
  const userId = useAuthStore((s) => s.user?.id ?? 1)
  const [direction, setDirection] = useState<Direction>('sales')
  const [showIssueModal, setShowIssueModal] = useState(false)

  const listQuery = useQuery({
    queryKey: ['tax-invoices', direction],
    queryFn: () => taxInvoiceApi.list({ direction, size: 100 }).then((r) => r.data),
  })

  const data = listQuery.data
  const items: any[] = data?.items || []

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">세금계산서</h1>
          <p className="text-gray-500 mt-1">
            홈택스 공동인증서 없이 바로 발행. 여러 명이 동시에 사용 가능.
          </p>
        </div>
        <button onClick={() => setShowIssueModal(true)} className="btn-primary">
          <PlusIcon className="h-5 w-5 mr-1" />
          신규 발행
        </button>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="공급가액 합계"
          value={formatCompactWon(data?.total_supply_amount)}
          unit="원"
          tone="primary"
          icon={<DocumentTextIcon className="h-5 w-5" />}
        />
        <StatCard
          label="세액 합계"
          value={formatCompactWon(data?.total_tax_amount)}
          unit="원"
          tone="mint"
        />
        <StatCard
          label="발행 건수"
          value={data?.total ?? 0}
          unit="건"
          tone="neutral"
        />
        <StatCard
          label="이번 달 평균"
          value={
            data?.total
              ? formatCompactWon(Number(data.total_supply_amount) / data.total)
              : '0'
          }
          unit="원/건"
          tone="primary"
        />
      </div>

      {/* Direction tabs */}
      <div className="card">
        <div className="flex gap-1 bg-gray-100 rounded-lg p-1 w-fit mb-4">
          <button
            onClick={() => setDirection('sales')}
            className={`px-4 py-1.5 rounded-md text-sm font-medium ${
              direction === 'sales' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'
            }`}
          >
            매출(발행)
          </button>
          <button
            onClick={() => setDirection('purchase')}
            className={`px-4 py-1.5 rounded-md text-sm font-medium ${
              direction === 'purchase' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'
            }`}
          >
            매입(수취)
          </button>
        </div>

        <div className="table-container">
          <table className="table">
            <thead className="table-header">
              <tr>
                <th>발행일</th>
                <th>승인번호</th>
                <th>거래처</th>
                <th>품목</th>
                <th className="text-right">공급가액</th>
                <th className="text-right">세액</th>
                <th>상태</th>
                <th></th>
              </tr>
            </thead>
            <tbody className="table-body">
              {items.map((it) => {
                const counterparty = direction === 'sales' ? it.receiver : it.supplier
                const itemSummary =
                  it.items?.[0]?.name +
                  (it.items?.length > 1 ? ` 외 ${it.items.length - 1}건` : '')
                const status = STATUS_LABEL[it.status] || STATUS_LABEL.draft
                return (
                  <tr key={it.id}>
                    <td className="text-sm text-gray-700">{formatDate(it.issue_date)}</td>
                    <td className="text-xs font-mono text-gray-500">{it.nts_confirmation_number || '-'}</td>
                    <td>
                      <div className="text-sm font-medium text-gray-900">{counterparty?.company_name}</div>
                      <div className="text-xs text-gray-500 font-mono">
                        {maskBusinessNumber(counterparty?.business_number)}
                      </div>
                    </td>
                    <td className="text-sm text-gray-700 max-w-xs truncate">{itemSummary}</td>
                    <td className="text-right font-mono tabular-nums">
                      {formatCurrency(it.total_supply_amount, false)}
                    </td>
                    <td className="text-right font-mono tabular-nums text-gray-500">
                      {formatCurrency(it.total_tax_amount, false)}
                    </td>
                    <td>
                      <span className={status.class}>{status.label}</span>
                    </td>
                    <td>
                      <div className="flex items-center gap-2 text-xs">
                        <button className="text-primary-600 hover:underline" title="PDF 다운로드">
                          <ArrowDownTrayIcon className="h-4 w-4" />
                        </button>
                        <button className="text-gray-500 hover:text-gray-700" title="재발송">
                          <PaperAirplaneIcon className="h-4 w-4" />
                        </button>
                        {it.status !== 'cancelled' && (
                          <button className="text-gray-500 hover:text-rose-600" title="취소발행">
                            <XCircleIcon className="h-4 w-4" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
              {items.length === 0 && !listQuery.isLoading && (
                <tr>
                  <td colSpan={8} className="text-center text-gray-400 py-8">
                    발행된 세금계산서가 없습니다.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {showIssueModal && <IssueModal userId={userId} onClose={() => setShowIssueModal(false)} />}
    </div>
  )
}

function IssueModal({ userId, onClose }: { userId: number; onClose: () => void }) {
  const qc = useQueryClient()
  const [issueDate, setIssueDate] = useState(todayISO())
  const [supplyDate, setSupplyDate] = useState(todayISO())
  const [receiverBiz, setReceiverBiz] = useState('')
  const [receiverName, setReceiverName] = useState('')
  const [receiverRep, setReceiverRep] = useState('')
  const [receiverEmail, setReceiverEmail] = useState('')
  const [items, setItems] = useState<Array<{ name: string; supply: string; tax: string }>>([
    { name: '', supply: '', tax: '' },
  ])
  const [autoSend, setAutoSend] = useState(true)

  const addItem = () => setItems([...items, { name: '', supply: '', tax: '' }])
  const removeItem = (idx: number) => setItems(items.filter((_, i) => i !== idx))
  const updateItem = (idx: number, field: 'name' | 'supply' | 'tax', value: string) => {
    const next = [...items]
    next[idx] = { ...next[idx], [field]: value }
    if (field === 'supply') {
      const s = Number(value)
      if (!Number.isNaN(s)) next[idx].tax = String(Math.round(s * 0.1))
    }
    setItems(next)
  }

  const totalSupply = items.reduce((sum, it) => sum + (Number(it.supply) || 0), 0)
  const totalTax = items.reduce((sum, it) => sum + (Number(it.tax) || 0), 0)

  const issueMut = useMutation({
    mutationFn: () => {
      const payload = {
        direction: 'sales',
        invoice_type: 'tax',
        issue_date: issueDate,
        supply_date: supplyDate,
        supplier: {
          business_number: '111-22-33333',
          company_name: '우리회사',
          representative_name: '대표자',
        },
        receiver: {
          business_number: receiverBiz,
          company_name: receiverName,
          representative_name: receiverRep,
          contact_email: receiverEmail || undefined,
        },
        items: items.map((it, idx) => ({
          line_no: idx + 1,
          name: it.name,
          supply_amount: Number(it.supply) || 0,
          tax_amount: Number(it.tax) || 0,
        })),
        cash_amount: 0,
        check_amount: 0,
        note_amount: 0,
        credit_amount: totalSupply + totalTax,
        auto_send_to_receiver: autoSend,
      }
      return taxInvoiceApi.issue(payload, userId)
    },
    onSuccess: () => {
      toast.success('세금계산서가 발행되었습니다.')
      qc.invalidateQueries({ queryKey: ['tax-invoices'] })
      onClose()
    },
    onError: (e: any) => toast.error(e.response?.data?.detail || '발행에 실패했습니다.'),
  })

  const canSubmit =
    receiverBiz.length >= 10 &&
    receiverName &&
    items.every((it) => it.name && Number(it.supply) > 0)

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-3xl max-h-[90vh] overflow-y-auto">
        <div className="sticky top-0 bg-white border-b border-gray-200 p-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-gray-900">세금계산서 발행</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <XMarkIcon className="h-5 w-5" />
          </button>
        </div>

        <div className="p-6 space-y-6">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">작성일자</label>
              <input
                type="date"
                value={issueDate}
                onChange={(e) => setIssueDate(e.target.value)}
                className="input"
              />
            </div>
            <div>
              <label className="label">공급일자</label>
              <input
                type="date"
                value={supplyDate}
                onChange={(e) => setSupplyDate(e.target.value)}
                className="input"
              />
            </div>
          </div>

          <div>
            <h4 className="font-semibold text-gray-900 mb-3">공급받는자</h4>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">사업자등록번호</label>
                <input
                  value={receiverBiz}
                  onChange={(e) => setReceiverBiz(e.target.value)}
                  placeholder="123-45-67890"
                  className="input"
                />
              </div>
              <div>
                <label className="label">상호</label>
                <input
                  value={receiverName}
                  onChange={(e) => setReceiverName(e.target.value)}
                  placeholder="(주)이마트"
                  className="input"
                />
              </div>
              <div>
                <label className="label">대표자명</label>
                <input
                  value={receiverRep}
                  onChange={(e) => setReceiverRep(e.target.value)}
                  className="input"
                />
              </div>
              <div>
                <label className="label">이메일 (선택)</label>
                <input
                  value={receiverEmail}
                  onChange={(e) => setReceiverEmail(e.target.value)}
                  placeholder="contact@example.com"
                  className="input"
                />
              </div>
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-3">
              <h4 className="font-semibold text-gray-900">품목</h4>
              <button onClick={addItem} className="btn-secondary text-sm">
                <PlusIcon className="h-4 w-4 mr-1" />
                품목 추가
              </button>
            </div>
            <div className="border border-gray-200 rounded">
              <table className="table">
                <thead className="table-header">
                  <tr>
                    <th>품명</th>
                    <th className="text-right">공급가액</th>
                    <th className="text-right">세액</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody className="table-body">
                  {items.map((it, idx) => (
                    <tr key={idx}>
                      <td>
                        <input
                          value={it.name}
                          onChange={(e) => updateItem(idx, 'name', e.target.value)}
                          placeholder="식자재 A"
                          className="input"
                        />
                      </td>
                      <td>
                        <input
                          type="number"
                          value={it.supply}
                          onChange={(e) => updateItem(idx, 'supply', e.target.value)}
                          placeholder="0"
                          className="input text-right"
                        />
                      </td>
                      <td>
                        <input
                          type="number"
                          value={it.tax}
                          onChange={(e) => updateItem(idx, 'tax', e.target.value)}
                          placeholder="0"
                          className="input text-right"
                        />
                      </td>
                      <td>
                        {items.length > 1 && (
                          <button
                            onClick={() => removeItem(idx)}
                            className="text-gray-400 hover:text-rose-500"
                          >
                            <TrashIcon className="h-4 w-4" />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-gray-50">
                    <td className="px-6 py-3 font-semibold text-gray-900">합계</td>
                    <td className="px-6 py-3 text-right font-mono font-semibold tabular-nums">
                      {formatCurrency(totalSupply, false)}
                    </td>
                    <td className="px-6 py-3 text-right font-mono font-semibold tabular-nums">
                      {formatCurrency(totalTax, false)}
                    </td>
                    <td></td>
                  </tr>
                </tfoot>
              </table>
            </div>
            <div className="mt-2 flex items-center justify-between text-sm">
              <label className="flex items-center gap-2 text-gray-700">
                <input
                  type="checkbox"
                  checked={autoSend}
                  onChange={(e) => setAutoSend(e.target.checked)}
                  className="rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                />
                발행 후 거래처 이메일로 자동 발송
              </label>
              <div className="text-gray-700">
                총 합계{' '}
                <span className="font-semibold text-gray-900 ml-1 tabular-nums">
                  {formatCurrency(totalSupply + totalTax, false)} 원
                </span>
              </div>
            </div>
          </div>
        </div>

        <div className="sticky bottom-0 bg-white border-t border-gray-200 p-4 flex justify-end gap-2">
          <button onClick={onClose} className="btn-secondary">
            취소
          </button>
          <button
            disabled={!canSubmit || issueMut.isPending}
            onClick={() => issueMut.mutate()}
            className="btn-primary"
          >
            {issueMut.isPending ? '발행 중...' : '발행하기'}
          </button>
        </div>
      </div>
    </div>
  )
}
