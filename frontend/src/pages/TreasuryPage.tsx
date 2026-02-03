import { useQuery } from '@tanstack/react-query'
import { treasuryApi } from '@/services/api'
import { BanknotesIcon, ArrowUpIcon, ArrowDownIcon } from '@heroicons/react/24/outline'

function formatCurrency(value: number) {
  return new Intl.NumberFormat('ko-KR', {
    style: 'currency',
    currency: 'KRW',
    maximumFractionDigits: 0,
  }).format(value)
}

export default function TreasuryPage() {
  const { data: cashPosition } = useQuery({
    queryKey: ['cashPosition'],
    queryFn: () => treasuryApi.getCashPosition().then((res) => res.data),
  })

  const { data: receivables } = useQuery({
    queryKey: ['receivables'],
    queryFn: () => treasuryApi.getReceivables().then((res) => res.data),
  })

  const { data: payables } = useQuery({
    queryKey: ['payables'],
    queryFn: () => treasuryApi.getPayables().then((res) => res.data),
  })

  const { data: upcomingPayments } = useQuery({
    queryKey: ['upcomingPayments'],
    queryFn: () => treasuryApi.getUpcomingPayments(30).then((res) => res.data),
  })

  const totalReceivable = receivables?.reduce(
    (sum: number, r: any) => sum + Number(r.outstanding_amount),
    0
  ) || 0

  const totalPayable = payables?.reduce(
    (sum: number, p: any) => sum + Number(p.outstanding_amount),
    0
  ) || 0

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">자금 관리</h1>
        <p className="text-gray-500 mt-1">현금, 채권, 채무를 관리합니다.</p>
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

      {/* AR/AP Lists */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="card">
          <h3 className="card-header">매출채권 (미수금)</h3>
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
        </div>

        <div className="card">
          <h3 className="card-header">매입채무 (미지급금)</h3>
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
        </div>
      </div>
    </div>
  )
}
