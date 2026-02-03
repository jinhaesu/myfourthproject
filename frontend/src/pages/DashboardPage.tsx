import { useQuery } from '@tanstack/react-query'
import { forecastApi, approvalsApi, treasuryApi } from '@/services/api'
import { useAuthStore } from '@/store/authStore'
import {
  BanknotesIcon,
  ArrowTrendingUpIcon,
  ArrowTrendingDownIcon,
  ClipboardDocumentCheckIcon,
  ExclamationTriangleIcon,
} from '@heroicons/react/24/outline'
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  BarChart,
  Bar,
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
}: {
  title: string
  value: string
  change?: string
  changeType?: 'positive' | 'negative' | 'neutral'
  icon: React.ComponentType<{ className?: string }>
}) {
  return (
    <div className="card">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-gray-500">{title}</p>
          <p className="mt-1 text-2xl font-semibold text-gray-900">{value}</p>
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

  const { data: dashboardData } = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => forecastApi.getDashboard().then((res) => res.data),
  })

  const { data: pendingApprovals } = useQuery({
    queryKey: ['pendingApprovals', user?.id],
    queryFn: () =>
      approvalsApi.getPending(user?.id || 0).then((res) => res.data),
    enabled: !!user?.id,
  })

  const { data: cashPosition } = useQuery({
    queryKey: ['cashPosition'],
    queryFn: () => treasuryApi.getCashPosition().then((res) => res.data),
  })

  // Sample chart data
  const revenueData = [
    { month: '1월', actual: 120, budget: 100 },
    { month: '2월', actual: 150, budget: 120 },
    { month: '3월', actual: 130, budget: 130 },
    { month: '4월', actual: 180, budget: 140 },
    { month: '5월', actual: 160, budget: 150 },
    { month: '6월', actual: 200, budget: 160 },
  ]

  const cashFlowData = [
    { date: '1주차', inflow: 50, outflow: 30 },
    { date: '2주차', inflow: 80, outflow: 60 },
    { date: '3주차', inflow: 45, outflow: 70 },
    { date: '4주차', inflow: 90, outflow: 50 },
  ]

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
          value={formatCurrency(dashboardData?.mtd_revenue || 1234567890)}
          change="전월 대비 +12.5%"
          changeType="positive"
          icon={ArrowTrendingUpIcon}
        />
        <StatCard
          title="당월 영업이익"
          value={formatCurrency(dashboardData?.mtd_operating_income || 234567890)}
          change="목표 대비 +5.3%"
          changeType="positive"
          icon={ArrowTrendingUpIcon}
        />
        <StatCard
          title="현재 현금잔액"
          value={formatCurrency(cashPosition?.total_balance || 5678901234)}
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
          <h3 className="card-header">매출 추이 (예산 vs 실적)</h3>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={revenueData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="month" stroke="#6b7280" fontSize={12} />
                <YAxis stroke="#6b7280" fontSize={12} />
                <Tooltip
                  contentStyle={{
                    backgroundColor: 'white',
                    border: '1px solid #e5e7eb',
                    borderRadius: '8px',
                  }}
                />
                <Line
                  type="monotone"
                  dataKey="actual"
                  name="실적"
                  stroke="#3b82f6"
                  strokeWidth={2}
                  dot={{ fill: '#3b82f6' }}
                />
                <Line
                  type="monotone"
                  dataKey="budget"
                  name="예산"
                  stroke="#9ca3af"
                  strokeWidth={2}
                  strokeDasharray="5 5"
                  dot={{ fill: '#9ca3af' }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="card">
          <h3 className="card-header">주간 현금흐름</h3>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={cashFlowData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="date" stroke="#6b7280" fontSize={12} />
                <YAxis stroke="#6b7280" fontSize={12} />
                <Tooltip
                  contentStyle={{
                    backgroundColor: 'white',
                    border: '1px solid #e5e7eb',
                    borderRadius: '8px',
                  }}
                />
                <Bar dataKey="inflow" name="입금" fill="#10b981" radius={[4, 4, 0, 0]} />
                <Bar dataKey="outflow" name="출금" fill="#ef4444" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* Alerts & Pending Items */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="card">
          <h3 className="card-header">알림</h3>
          <div className="space-y-3">
            {dashboardData?.cash_alerts?.length > 0 ? (
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
                className="flex items-center justify-between p-3 bg-gray-50 rounded-lg"
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
