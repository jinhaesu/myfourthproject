import { useState } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { treasuryApi } from '@/services/api'
import { BanknotesIcon, ArrowUpIcon, ArrowDownIcon, ArrowPathIcon } from '@heroicons/react/24/outline'
import FiscalYearTabs from '@/components/common/FiscalYearTabs'
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts'

function formatCurrency(value: number) {
  return new Intl.NumberFormat('ko-KR', {
    style: 'currency',
    currency: 'KRW',
    maximumFractionDigits: 0,
  }).format(value)
}

type TabType = 'overview' | 'aging'

export default function TreasuryPage() {
  const currentYear = new Date().getFullYear()
  const [fiscalYear, setFiscalYear] = useState(currentYear)
  const [activeTab, setActiveTab] = useState<TabType>('overview')
  const [arStatusFilter, setArStatusFilter] = useState<string | undefined>(undefined)
  const [apStatusFilter, setApStatusFilter] = useState<string | undefined>(undefined)

  const { data: cashPosition } = useQuery({
    queryKey: ['cashPosition'],
    queryFn: () => treasuryApi.getCashPosition().then((res) => res.data),
  })

  const { data: receivables, isLoading: arLoading } = useQuery({
    queryKey: ['receivables', arStatusFilter],
    queryFn: () => treasuryApi.getReceivables(arStatusFilter).then((res) => res.data),
  })

  const { data: payables, isLoading: apLoading } = useQuery({
    queryKey: ['payables', apStatusFilter],
    queryFn: () => treasuryApi.getPayables(apStatusFilter).then((res) => res.data),
  })

  const { data: upcomingPayments } = useQuery({
    queryKey: ['upcomingPayments'],
    queryFn: () => treasuryApi.getUpcomingPayments(30).then((res) => res.data),
  })

  const reconcileMutation = useMutation({
    mutationFn: () => treasuryApi.autoReconcile(),
    onSuccess: (res) => {
      toast.success(`자동 매칭이 완료되었습니다. (${res.data?.matched_count || 0}건 매칭)`)
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.detail || '자동 매칭에 실패했습니다.')
    },
  })

  const totalReceivable = receivables?.reduce(
    (sum: number, r: any) => sum + Number(r.outstanding_amount),
    0
  ) || 0

  const totalPayable = payables?.reduce(
    (sum: number, p: any) => sum + Number(p.outstanding_amount),
    0
  ) || 0

  // Aging data
  const { data: arAging } = useQuery({
    queryKey: ['arAging'],
    queryFn: () => treasuryApi.getArAging().then((res) => res.data),
    enabled: activeTab === 'aging',
  })

  const { data: apAging } = useQuery({
    queryKey: ['apAging'],
    queryFn: () => treasuryApi.getApAging().then((res) => res.data),
    enabled: activeTab === 'aging',
  })

  const agingChartData = (() => {
    const periods = ['current', '1_30', '31_60', '61_90', 'over_90']
    const labels = ['정상', '1-30일', '31-60일', '61-90일', '90일+']
    return periods.map((p, i) => ({
      period: labels[i],
      receivable: Math.round((arAging?.summary?.[p] || 0) / 10000),
      payable: Math.round((apAging?.summary?.[p] || 0) / 10000),
    }))
  })()

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">자금 관리</h1>
          <p className="text-gray-500 mt-1">현금, 채권, 채무를 관리합니다.</p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <FiscalYearTabs
            year={fiscalYear}
            onChange={setFiscalYear}
          />
          <button
            onClick={() => reconcileMutation.mutate()}
            disabled={reconcileMutation.isPending}
            className="btn-secondary"
          >
            <ArrowPathIcon className="h-5 w-5 mr-2" />
            {reconcileMutation.isPending ? '매칭 중...' : '자동 매칭'}
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="border-b border-gray-200">
        <nav className="flex gap-4">
          {[
            { id: 'overview' as TabType, label: '현황' },
            { id: 'aging' as TabType, label: 'Aging 분석' },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`pb-3 px-1 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab.id
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="card">
          <div className="flex items-center gap-4">
            <div className="p-3 bg-blue-100 rounded-lg">
              <BanknotesIcon className="h-6 w-6 text-blue-600" />
            </div>
            <div>
              <p className="text-sm text-gray-500">현금 잔액</p>
              <p className="text-xl font-bold">
                {formatCurrency(cashPosition?.total_balance || 0)}
              </p>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="flex items-center gap-4">
            <div className="p-3 bg-green-100 rounded-lg">
              <ArrowDownIcon className="h-6 w-6 text-green-600" />
            </div>
            <div>
              <p className="text-sm text-gray-500">매출채권</p>
              <p className="text-xl font-bold text-green-600">
                {formatCurrency(totalReceivable)}
              </p>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="flex items-center gap-4">
            <div className="p-3 bg-red-100 rounded-lg">
              <ArrowUpIcon className="h-6 w-6 text-red-600" />
            </div>
            <div>
              <p className="text-sm text-gray-500">매입채무</p>
              <p className="text-xl font-bold text-red-600">
                {formatCurrency(totalPayable)}
              </p>
            </div>
          </div>
        </div>

        <div className="card">
          <div>
            <p className="text-sm text-gray-500">순 자금</p>
            <p
              className={`text-xl font-bold ${
                (cashPosition?.total_balance || 0) + totalReceivable - totalPayable >= 0
                  ? 'text-green-600'
                  : 'text-red-600'
              }`}
            >
              {formatCurrency(
                (cashPosition?.total_balance || 0) + totalReceivable - totalPayable
              )}
            </p>
          </div>
        </div>
      </div>

      {activeTab === 'overview' && (
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Bank Accounts */}
        <div className="card">
          <h3 className="card-header">계좌 현황</h3>
          <div className="space-y-3">
            {cashPosition?.accounts?.map((account: any) => (
              <div
                key={account.id}
                className="flex items-center justify-between p-3 bg-gray-50 rounded-lg"
              >
                <div>
                  <p className="font-medium">{account.alias}</p>
                  <p className="text-sm text-gray-500">{account.bank}</p>
                </div>
                <p className="font-mono font-medium">
                  {formatCurrency(account.current_balance)}
                </p>
              </div>
            ))}
          </div>
        </div>

        {/* Upcoming Payments */}
        <div className="card">
          <h3 className="card-header">예정 지급</h3>
          <div className="space-y-3">
            {upcomingPayments?.slice(0, 5).map((payment: any) => (
              <div
                key={payment.id}
                className="flex items-center justify-between p-3 bg-gray-50 rounded-lg"
              >
                <div>
                  <p className="font-medium">{payment.vendor_name || `지급 #${payment.id}`}</p>
                  <p className="text-sm text-gray-500">{payment.scheduled_date}</p>
                </div>
                <p className="font-mono font-medium text-red-600">
                  {formatCurrency(payment.scheduled_amount)}
                </p>
              </div>
            ))}
            {(!upcomingPayments || upcomingPayments.length === 0) && (
              <p className="text-gray-500 text-sm text-center py-4">
                예정된 지급이 없습니다.
              </p>
            )}
          </div>
        </div>
      </div>
      )}

      {/* Aging Tab */}
      {activeTab === 'aging' && (
        <div className="space-y-6">
          <div className="card">
            <h3 className="card-header">채권/채무 연령 분석 (만원)</h3>
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={agingChartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                  <XAxis dataKey="period" stroke="#6b7280" fontSize={12} />
                  <YAxis stroke="#6b7280" fontSize={12} />
                  <Tooltip
                    contentStyle={{ backgroundColor: 'white', border: '1px solid #e5e7eb', borderRadius: '8px' }}
                    formatter={(value: number) => `${value.toLocaleString()}만원`}
                  />
                  <Legend />
                  <Bar dataKey="receivable" name="매출채권" fill="#10b981" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="payable" name="매입채무" fill="#ef4444" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {arAging?.details && arAging.details.length > 0 && (
            <div className="card">
              <h3 className="card-header">매출채권 Aging 상세</h3>
              <div className="table-container">
                <table className="table">
                  <thead className="table-header">
                    <tr>
                      <th>거래처</th>
                      <th className="text-right">원금</th>
                      <th className="text-right">잔액</th>
                      <th className="text-right">연체일수</th>
                      <th>상태</th>
                    </tr>
                  </thead>
                  <tbody className="table-body">
                    {arAging.details.slice(0, 15).map((item: any, idx: number) => (
                      <tr key={idx}>
                        <td className="font-medium">{item.customer_name || item.name}</td>
                        <td className="amount">{formatCurrency(item.original_amount || 0)}</td>
                        <td className="amount">{formatCurrency(item.outstanding_amount || 0)}</td>
                        <td className="text-right">{item.days_overdue || 0}일</td>
                        <td>
                          <span className={item.days_overdue > 60 ? 'badge-danger' : item.days_overdue > 30 ? 'badge-warning' : 'badge-info'}>
                            {item.days_overdue > 90 ? '장기연체' : item.days_overdue > 60 ? '연체' : item.days_overdue > 30 ? '주의' : '정상'}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* AR/AP Lists */}
      {activeTab === 'overview' && (
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-gray-900">매출채권 (미수금)</h3>
            <select
              value={arStatusFilter || ''}
              onChange={(e) => setArStatusFilter(e.target.value || undefined)}
              className="input w-32"
            >
              <option value="">전체</option>
              <option value="pending">대기</option>
              <option value="overdue">연체</option>
            </select>
          </div>
          {arLoading ? (
            <div className="text-center py-4 text-gray-500">로딩 중...</div>
          ) : !receivables || receivables.length === 0 ? (
            <div className="text-center py-4 text-gray-500">매출채권이 없습니다.</div>
          ) : (
          <div className="table-container">
            <table className="table">
              <thead className="table-header">
                <tr>
                  <th>거래처</th>
                  <th>만기일</th>
                  <th className="text-right">잔액</th>
                  <th>상태</th>
                </tr>
              </thead>
              <tbody className="table-body">
                {receivables?.slice(0, 10).map((r: any) => (
                  <tr key={r.id}>
                    <td>{r.customer_name}</td>
                    <td>{r.due_date}</td>
                    <td className="amount-positive">
                      {formatCurrency(r.outstanding_amount)}
                    </td>
                    <td>
                      <span
                        className={
                          r.status === 'overdue' ? 'badge-danger' : 'badge-info'
                        }
                      >
                        {r.status === 'pending'
                          ? '대기'
                          : r.status === 'overdue'
                          ? '연체'
                          : r.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          )}
        </div>

        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-gray-900">매입채무 (미지급금)</h3>
            <select
              value={apStatusFilter || ''}
              onChange={(e) => setApStatusFilter(e.target.value || undefined)}
              className="input w-32"
            >
              <option value="">전체</option>
              <option value="pending">대기</option>
              <option value="scheduled">예정</option>
              <option value="overdue">연체</option>
            </select>
          </div>
          {apLoading ? (
            <div className="text-center py-4 text-gray-500">로딩 중...</div>
          ) : !payables || payables.length === 0 ? (
            <div className="text-center py-4 text-gray-500">매입채무가 없습니다.</div>
          ) : (
          <div className="table-container">
            <table className="table">
              <thead className="table-header">
                <tr>
                  <th>거래처</th>
                  <th>만기일</th>
                  <th className="text-right">잔액</th>
                  <th>상태</th>
                </tr>
              </thead>
              <tbody className="table-body">
                {payables?.slice(0, 10).map((p: any) => (
                  <tr key={p.id}>
                    <td>{p.vendor_name}</td>
                    <td>{p.due_date}</td>
                    <td className="amount-negative">
                      {formatCurrency(p.outstanding_amount)}
                    </td>
                    <td>
                      <span
                        className={
                          p.status === 'overdue' ? 'badge-danger' : 'badge-warning'
                        }
                      >
                        {p.status === 'pending'
                          ? '대기'
                          : p.status === 'scheduled'
                          ? '예정'
                          : p.status === 'overdue'
                          ? '연체'
                          : p.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          )}
        </div>
      </div>
      )}
    </div>
  )
}
