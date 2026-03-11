import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { forecastApi, approvalsApi, treasuryApi, budgetApi } from '@/services/api'
import { useAuthStore } from '@/store/authStore'
import {
  BanknotesIcon,
  ArrowTrendingUpIcon,
  ClipboardDocumentCheckIcon,
  ExclamationTriangleIcon,
} from '@heroicons/react/24/outline'
import {
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  BarChart,
  Bar,
  Legend,
} from 'recharts'

function formatCurrency(value: number) {
  return new Intl.NumberFormat('ko-KR', {
    style: 'currency',
    currency: 'KRW',
    maximumFractionDigits: 0,
  }).format(value)
}

function StatCard({
  title,
  value,
  change,
  changeType,
  icon: Icon,
  isLoading,
}: {
  title: string
  value: string
  change?: string
  changeType?: 'positive' | 'negative' | 'neutral'
  icon: React.ComponentType<{ className?: string }>
  isLoading?: boolean
}) {
  return (
    <div className="card">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-gray-500">{title}</p>
          {isLoading ? (
            <div className="mt-1 h-8 w-32 bg-gray-200 rounded animate-pulse" />
          ) : (
            <p className="mt-1 text-2xl font-semibold text-gray-900">{value}</p>
          )}
          {change && (
            <p
              className={`mt-1 text-sm ${
                changeType === 'positive'
                  ? 'text-green-600'
                  : changeType === 'negative'
                  ? 'text-red-600'
                  : 'text-gray-500'
              }`}
            >
              {change}
            </p>
          )}
        </div>
        <div className="p-3 bg-primary-50 rounded-lg">
          <Icon className="h-6 w-6 text-primary-600" />
        </div>
      </div>
    </div>
  )
}

export default function DashboardPage() {
  const user = useAuthStore((state) => state.user)
  const navigate = useNavigate()
  const currentYear = new Date().getFullYear()

  const { data: dashboardData, isLoading: dashLoading } = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => forecastApi.getDashboard().then((res) => res.data),
  })

  const { data: pendingApprovals } = useQuery({
    queryKey: ['pendingApprovals', user?.id],
    queryFn: () =>
      approvalsApi.getPending(user?.id || 0).then((res) => res.data),
    enabled: !!user?.id,
  })

  const { data: cashPosition, isLoading: cashLoading } = useQuery({
    queryKey: ['cashPosition'],
    queryFn: () => treasuryApi.getCashPosition().then((res) => res.data),
  })

  // Real budget vs actual data for chart
  const { data: vsActualData } = useQuery({
    queryKey: ['budgetVsActual', currentYear],
    queryFn: () => budgetApi.getVsActual(currentYear).then((res) => res.data),
  })

  // Real cash flow forecast for chart
  const { data: cashFlowForecast } = useQuery({
    queryKey: ['cashFlowChart'],
    queryFn: () => forecastApi.getCashFlow(28).then((res) => res.data),
  })

  // Transform budget vs actual data for chart
  const revenueChartData = vsActualData?.items?.slice(0, 8).map((item: any) => ({
    name: item.account_name?.length > 6 ? item.account_name.slice(0, 6) + '…' : item.account_name,
    budget: Math.round(Number(item.budget_amount) / 10000),
    actual: Math.round(Number(item.actual_amount) / 10000),
  })) || []

  // Transform cash flow forecast to weekly summary
  const cashFlowChartData = (() => {
    const daily = cashFlowForecast?.daily_forecast || []
    if (daily.length === 0) return []
    const weeks: { date: string; inflow: number; outflow: number }[] = []
    for (let i = 0; i < daily.length; i += 7) {
      const chunk = daily.slice(i, i + 7)
      const weekNum = Math.floor(i / 7) + 1
      weeks.push({
        date: `${weekNum}주차`,
        inflow: Math.round(chunk.reduce((s: number, d: any) => s + (Number(d.inflows) || 0), 0) / 10000),
        outflow: Math.round(chunk.reduce((s: number, d: any) => s + (Number(d.outflows) || 0), 0) / 10000),
      })
    }
    return weeks
  })()

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">대시보드</h1>
        <p className="text-gray-500 mt-1">
          안녕하세요, {user?.fullName}님. 오늘의 재무 현황입니다.
        </p>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          title="당월 매출"
          value={formatCurrency(dashboardData?.mtd_revenue || 0)}
          isLoading={dashLoading}
          icon={ArrowTrendingUpIcon}
        />
        <StatCard
          title="당월 영업이익"
          value={formatCurrency(dashboardData?.mtd_operating_income || 0)}
          isLoading={dashLoading}
          icon={ArrowTrendingUpIcon}
        />
        <StatCard
          title="현재 현금잔액"
          value={formatCurrency(cashPosition?.total_balance || 0)}
          isLoading={cashLoading}
          icon={BanknotesIcon}
        />
        <StatCard
          title="결재 대기"
          value={`${pendingApprovals?.count || 0}건`}
          icon={ClipboardDocumentCheckIcon}
        />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="card">
          <h3 className="card-header">예산 vs 실적 (만원)</h3>
          <div className="h-72">
            {revenueChartData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={revenueChartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                  <XAxis dataKey="name" stroke="#6b7280" fontSize={11} angle={-30} textAnchor="end" height={60} />
                  <YAxis stroke="#6b7280" fontSize={12} />
                  <Tooltip
                    contentStyle={{ backgroundColor: 'white', border: '1px solid #e5e7eb', borderRadius: '8px' }}
                    formatter={(value: number) => `${value.toLocaleString()}만원`}
                  />
                  <Legend />
                  <Bar dataKey="budget" name="예산" fill="#93c5fd" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="actual" name="실적" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-full text-gray-400">
                예산 데이터가 없습니다.
              </div>
            )}
          </div>
        </div>

        <div className="card">
          <h3 className="card-header">주간 현금흐름 예측 (만원)</h3>
          <div className="h-72">
            {cashFlowChartData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={cashFlowChartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                  <XAxis dataKey="date" stroke="#6b7280" fontSize={12} />
                  <YAxis stroke="#6b7280" fontSize={12} />
                  <Tooltip
                    contentStyle={{ backgroundColor: 'white', border: '1px solid #e5e7eb', borderRadius: '8px' }}
                    formatter={(value: number) => `${value.toLocaleString()}만원`}
                  />
                  <Legend />
                  <Bar dataKey="inflow" name="입금" fill="#10b981" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="outflow" name="출금" fill="#ef4444" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-full text-gray-400">
                현금흐름 데이터가 없습니다.
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Alerts & Pending Items */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="card">
          <h3 className="card-header">알림</h3>
          <div className="space-y-3">
            {dashboardData?.cash_alerts && dashboardData.cash_alerts.length > 0 ? (
              dashboardData.cash_alerts.map((alert: any, index: number) => (
                <div
                  key={index}
                  className="flex items-start p-3 bg-yellow-50 rounded-lg"
                >
                  <ExclamationTriangleIcon className="h-5 w-5 text-yellow-600 mt-0.5" />
                  <div className="ml-3">
                    <p className="text-sm font-medium text-yellow-800">{alert.message}</p>
                    <p className="text-xs text-yellow-600">{alert.date}</p>
                  </div>
                </div>
              ))
            ) : (
              <p className="text-gray-500 text-sm">현재 알림이 없습니다.</p>
            )}
          </div>
        </div>

        <div className="card">
          <h3 className="card-header">결재 대기함</h3>
          <div className="space-y-3">
            {pendingApprovals?.pending_approvals?.slice(0, 5).map((approval: any) => (
              <div
                key={approval.id}
                onClick={() => navigate('/approvals')}
                className="flex items-center justify-between p-3 bg-gray-50 rounded-lg cursor-pointer hover:bg-gray-100 transition-colors"
              >
                <div>
                  <p className="text-sm font-medium text-gray-900">{approval.title}</p>
                  <p className="text-xs text-gray-500">
                    {approval.requester_name} · {approval.department_name}
                  </p>
                </div>
                {approval.is_urgent && (
                  <span className="badge-danger">긴급</span>
                )}
              </div>
            ))}
            {(!pendingApprovals?.pending_approvals ||
              pendingApprovals.pending_approvals.length === 0) && (
              <p className="text-gray-500 text-sm">결재 대기 중인 건이 없습니다.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
