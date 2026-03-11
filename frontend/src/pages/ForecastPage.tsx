import { useState } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { forecastApi } from '@/services/api'
import {
  ArrowTrendingUpIcon,
  ArrowTrendingDownIcon,
  PlayIcon,
} from '@heroicons/react/24/outline'
import {
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  Area,
  AreaChart,
} from 'recharts'

function formatCurrency(value: number) {
  return new Intl.NumberFormat('ko-KR', {
    style: 'currency',
    currency: 'KRW',
    maximumFractionDigits: 0,
  }).format(value)
}

type TabType = 'dashboard' | 'pl' | 'cashflow' | 'scenario'

export default function ForecastPage() {
  const [activeTab, setActiveTab] = useState<TabType>('dashboard')
  const currentDate = new Date()
  const firstDayOfMonth = new Date(currentDate.getFullYear(), currentDate.getMonth(), 1)
    .toISOString()
    .split('T')[0]
  const lastDayOfMonth = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 0)
    .toISOString()
    .split('T')[0]

  const [plPeriod, setPlPeriod] = useState({
    start: firstDayOfMonth,
    end: lastDayOfMonth,
  })
  const [cashFlowDays, setCashFlowDays] = useState(30)

  // Scenario state
  const [scenarioParams, setScenarioParams] = useState({
    revenue_change_percent: 0,
    cost_change_percent: 0,
    description: '',
  })

  // Dashboard KPIs
  const { data: dashboardData, isLoading: dashboardLoading } = useQuery({
    queryKey: ['forecastDashboard'],
    queryFn: () => forecastApi.getDashboard().then((res) => res.data),
  })

  // P&L forecast
  const { data: plData, isLoading: plLoading } = useQuery({
    queryKey: ['plForecast', plPeriod],
    queryFn: () =>
      forecastApi.getPL(plPeriod.start, plPeriod.end).then((res) => res.data),
    enabled: activeTab === 'pl',
  })

  // Cash flow forecast
  const { data: cashFlowData, isLoading: cashFlowLoading } = useQuery({
    queryKey: ['cashFlowForecast', cashFlowDays],
    queryFn: () =>
      forecastApi.getCashFlow(cashFlowDays).then((res) => res.data),
    enabled: activeTab === 'cashflow',
  })

  // Scenario simulation
  const scenarioMutation = useMutation({
    mutationFn: (data: any) => forecastApi.runScenario(data),
    onSuccess: () => {
      toast.success('시나리오 시뮬레이션이 완료되었습니다.')
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.detail || '시뮬레이션 실행에 실패했습니다.')
    },
  })

  const handleRunScenario = () => {
    if (!scenarioParams.description.trim()) {
      toast.error('시나리오 설명을 입력하세요.')
      return
    }
    scenarioMutation.mutate(scenarioParams)
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">예측 / 시뮬레이션</h1>
        <p className="text-gray-500 mt-1">
          손익 예측 및 시나리오 시뮬레이션을 수행합니다.
        </p>
      </div>

      {/* Tabs */}
      <div className="border-b border-gray-200">
        <nav className="flex space-x-8">
          {[
            { id: 'dashboard' as TabType, label: '대시보드' },
            { id: 'pl' as TabType, label: '추정 손익' },
            { id: 'cashflow' as TabType, label: '자금 예측' },
            { id: 'scenario' as TabType, label: '시나리오' },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`py-3 px-1 border-b-2 font-medium text-sm ${
                activeTab === tab.id
                  ? 'border-blue-500 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {/* Dashboard Tab */}
      {activeTab === 'dashboard' && (
        <div className="space-y-6">
          {dashboardLoading ? (
            <div className="text-center py-12">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto"></div>
              <p className="text-gray-500 mt-2">로딩 중...</p>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="card">
                  <div className="flex items-center gap-3">
                    <div className="p-3 bg-green-100 rounded-lg">
                      <ArrowTrendingUpIcon className="h-6 w-6 text-green-600" />
                    </div>
                    <div>
                      <p className="text-sm text-gray-500">당월 매출</p>
                      <p className="text-xl font-bold">
                        {formatCurrency(dashboardData?.mtd_revenue || 0)}
                      </p>
                    </div>
                  </div>
                </div>

                <div className="card">
                  <div className="flex items-center gap-3">
                    <div className="p-3 bg-blue-100 rounded-lg">
                      <ArrowTrendingUpIcon className="h-6 w-6 text-blue-600" />
                    </div>
                    <div>
                      <p className="text-sm text-gray-500">영업이익</p>
                      <p className="text-xl font-bold">
                        {formatCurrency(dashboardData?.mtd_operating_income || 0)}
                      </p>
                    </div>
                  </div>
                </div>

                <div className="card">
                  <div>
                    <p className="text-sm text-gray-500">영업이익률</p>
                    <p className="text-xl font-bold">
                      {dashboardData?.operating_margin
                        ? `${dashboardData.operating_margin.toFixed(1)}%`
                        : '-'}
                    </p>
                  </div>
                </div>

                <div className="card">
                  <div className="flex items-center gap-3">
                    <div className="p-3 bg-yellow-100 rounded-lg">
                      <ArrowTrendingDownIcon className="h-6 w-6 text-yellow-600" />
                    </div>
                    <div>
                      <p className="text-sm text-gray-500">당월 비용</p>
                      <p className="text-xl font-bold text-red-600">
                        {formatCurrency(dashboardData?.mtd_expenses || 0)}
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Cash alerts */}
              {dashboardData?.cash_alerts && dashboardData.cash_alerts.length > 0 && (
                <div className="card">
                  <h3 className="card-header">자금 알림</h3>
                  <div className="space-y-2">
                    {dashboardData.cash_alerts.map((alert: any, index: number) => (
                      <div
                        key={index}
                        className="flex items-center gap-3 p-3 bg-yellow-50 rounded-lg"
                      >
                        <ArrowTrendingDownIcon className="h-5 w-5 text-yellow-600 flex-shrink-0" />
                        <div>
                          <p className="text-sm font-medium text-yellow-800">
                            {alert.message}
                          </p>
                          {alert.date && (
                            <p className="text-xs text-yellow-600">{alert.date}</p>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* P&L Tab */}
      {activeTab === 'pl' && (
        <div className="space-y-6">
          <div className="card">
            <div className="flex items-center gap-4 mb-4">
              <div className="flex items-center gap-2">
                <label className="text-sm font-medium text-gray-700">기간</label>
                <input
                  type="date"
                  value={plPeriod.start}
                  onChange={(e) =>
                    setPlPeriod({ ...plPeriod, start: e.target.value })
                  }
                  className="input w-40"
                />
                <span className="text-gray-400">~</span>
                <input
                  type="date"
                  value={plPeriod.end}
                  onChange={(e) =>
                    setPlPeriod({ ...plPeriod, end: e.target.value })
                  }
                  className="input w-40"
                />
              </div>
            </div>

            {plLoading ? (
              <div className="text-center py-8">로딩 중...</div>
            ) : plData ? (
              <div className="space-y-4">
                {/* P&L Summary */}
                <div className="grid grid-cols-3 gap-4 text-center">
                  <div className="p-4 bg-green-50 rounded-lg">
                    <p className="text-sm text-gray-500">총 수익</p>
                    <p className="text-2xl font-bold text-green-600">
                      {formatCurrency(plData.total_revenue || 0)}
                    </p>
                  </div>
                  <div className="p-4 bg-red-50 rounded-lg">
                    <p className="text-sm text-gray-500">총 비용</p>
                    <p className="text-2xl font-bold text-red-600">
                      {formatCurrency(plData.total_expenses || 0)}
                    </p>
                  </div>
                  <div
                    className={`p-4 rounded-lg ${
                      (plData.net_income || 0) >= 0 ? 'bg-blue-50' : 'bg-red-50'
                    }`}
                  >
                    <p className="text-sm text-gray-500">순이익</p>
                    <p
                      className={`text-2xl font-bold ${
                        (plData.net_income || 0) >= 0
                          ? 'text-blue-600'
                          : 'text-red-600'
                      }`}
                    >
                      {formatCurrency(plData.net_income || 0)}
                    </p>
                  </div>
                </div>

                {/* P&L Line Items */}
                {plData.items && plData.items.length > 0 && (
                  <div className="table-container">
                    <table className="table">
                      <thead className="table-header">
                        <tr>
                          <th>항목</th>
                          <th className="text-right">확정</th>
                          <th className="text-right">진행중</th>
                          <th className="text-right">예측</th>
                          <th className="text-right">합계</th>
                        </tr>
                      </thead>
                      <tbody className="table-body">
                        {plData.items.map((item: any, index: number) => (
                          <tr key={index}>
                            <td className="font-medium">{item.category_name}</td>
                            <td className="amount">
                              {formatCurrency(item.confirmed_amount || 0)}
                            </td>
                            <td className="amount">
                              {formatCurrency(item.pending_amount || 0)}
                            </td>
                            <td className="amount">
                              {formatCurrency(item.forecasted_amount || 0)}
                            </td>
                            <td className="amount font-bold">
                              {formatCurrency(item.total_amount || 0)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            ) : (
              <div className="text-center py-8 text-gray-500">
                데이터가 없습니다.
              </div>
            )}
          </div>
        </div>
      )}

      {/* Cash Flow Tab */}
      {activeTab === 'cashflow' && (
        <div className="space-y-6">
          <div className="card">
            <div className="flex items-center justify-between mb-4">
              <h3 className="card-header mb-0">자금 수지 예측</h3>
              <div className="flex items-center gap-2">
                <label className="text-sm text-gray-600">예측 기간:</label>
                <select
                  value={cashFlowDays}
                  onChange={(e) => setCashFlowDays(Number(e.target.value))}
                  className="input w-32"
                >
                  <option value={7}>7일</option>
                  <option value={14}>14일</option>
                  <option value={30}>30일</option>
                  <option value={60}>60일</option>
                  <option value={90}>90일</option>
                </select>
              </div>
            </div>

            {cashFlowLoading ? (
              <div className="text-center py-8">로딩 중...</div>
            ) : cashFlowData ? (
              <div className="space-y-4">
                {/* Summary */}
                <div className="grid grid-cols-3 gap-4 text-center">
                  <div className="p-4 bg-blue-50 rounded-lg">
                    <p className="text-sm text-gray-500">현재 잔액</p>
                    <p className="text-2xl font-bold text-blue-600">
                      {formatCurrency(cashFlowData.current_balance || 0)}
                    </p>
                  </div>
                  <div className="p-4 bg-green-50 rounded-lg">
                    <p className="text-sm text-gray-500">예상 입금</p>
                    <p className="text-2xl font-bold text-green-600">
                      {formatCurrency(cashFlowData.total_inflow || 0)}
                    </p>
                  </div>
                  <div className="p-4 bg-red-50 rounded-lg">
                    <p className="text-sm text-gray-500">예상 출금</p>
                    <p className="text-2xl font-bold text-red-600">
                      {formatCurrency(cashFlowData.total_outflow || 0)}
                    </p>
                  </div>
                </div>

                {/* Cash Flow Chart */}
                {cashFlowData.daily_forecast && cashFlowData.daily_forecast.length > 0 && (
                  <div className="h-72">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={cashFlowData.daily_forecast}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                        <XAxis
                          dataKey="date"
                          stroke="#6b7280"
                          fontSize={12}
                        />
                        <YAxis stroke="#6b7280" fontSize={12} />
                        <Tooltip
                          contentStyle={{
                            backgroundColor: 'white',
                            border: '1px solid #e5e7eb',
                            borderRadius: '8px',
                          }}
                          formatter={(value: number) => formatCurrency(value)}
                        />
                        <Legend />
                        <Area
                          type="monotone"
                          dataKey="balance"
                          name="예상 잔액"
                          stroke="#3b82f6"
                          fill="#93c5fd"
                          fillOpacity={0.3}
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </div>
            ) : (
              <div className="text-center py-8 text-gray-500">
                데이터가 없습니다.
              </div>
            )}
          </div>
        </div>
      )}

      {/* Scenario Tab */}
      {activeTab === 'scenario' && (
        <div className="space-y-6">
          <div className="card">
            <h3 className="card-header">시나리오 시뮬레이션</h3>
            <p className="text-sm text-gray-600 mb-6">
              가상의 매출/비용 변동을 적용하여 손익에 미치는 영향을 분석합니다.
            </p>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <label className="label">매출 변동률 (%)</label>
                <input
                  type="number"
                  value={scenarioParams.revenue_change_percent}
                  onChange={(e) =>
                    setScenarioParams({
                      ...scenarioParams,
                      revenue_change_percent: Number(e.target.value),
                    })
                  }
                  className="w-full mt-1 px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  placeholder="예: 10 (10% 증가)"
                />
                <p className="text-xs text-gray-400 mt-1">
                  양수: 증가, 음수: 감소
                </p>
              </div>

              <div>
                <label className="label">비용 변동률 (%)</label>
                <input
                  type="number"
                  value={scenarioParams.cost_change_percent}
                  onChange={(e) =>
                    setScenarioParams({
                      ...scenarioParams,
                      cost_change_percent: Number(e.target.value),
                    })
                  }
                  className="w-full mt-1 px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  placeholder="예: -5 (5% 감소)"
                />
                <p className="text-xs text-gray-400 mt-1">
                  양수: 증가, 음수: 감소
                </p>
              </div>
            </div>

            <div className="mt-4">
              <label className="label">시나리오 설명</label>
              <textarea
                value={scenarioParams.description}
                onChange={(e) =>
                  setScenarioParams({
                    ...scenarioParams,
                    description: e.target.value,
                  })
                }
                className="w-full mt-1 px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                rows={3}
                placeholder="이 시나리오에 대한 설명을 입력하세요..."
              />
            </div>

            <div className="mt-4">
              <button
                onClick={handleRunScenario}
                disabled={scenarioMutation.isPending}
                className="btn-primary"
              >
                <PlayIcon className="h-5 w-5 mr-2" />
                {scenarioMutation.isPending ? '시뮬레이션 중...' : '시뮬레이션 실행'}
              </button>
            </div>
          </div>

          {/* Scenario Results */}
          {scenarioMutation.data && (
            <div className="card">
              <h3 className="card-header">시뮬레이션 결과</h3>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-center">
                <div className="p-4 bg-gray-50 rounded-lg">
                  <p className="text-sm text-gray-500">기존 매출</p>
                  <p className="text-lg font-bold">
                    {formatCurrency(scenarioMutation.data.data?.base_revenue || 0)}
                  </p>
                </div>
                <div className="p-4 bg-green-50 rounded-lg">
                  <p className="text-sm text-gray-500">시나리오 매출</p>
                  <p className="text-lg font-bold text-green-600">
                    {formatCurrency(scenarioMutation.data.data?.scenario_revenue || 0)}
                  </p>
                </div>
                <div className="p-4 bg-gray-50 rounded-lg">
                  <p className="text-sm text-gray-500">기존 이익</p>
                  <p className="text-lg font-bold">
                    {formatCurrency(scenarioMutation.data.data?.base_profit || 0)}
                  </p>
                </div>
                <div
                  className={`p-4 rounded-lg ${
                    (scenarioMutation.data.data?.scenario_profit || 0) >= 0
                      ? 'bg-blue-50'
                      : 'bg-red-50'
                  }`}
                >
                  <p className="text-sm text-gray-500">시나리오 이익</p>
                  <p
                    className={`text-lg font-bold ${
                      (scenarioMutation.data.data?.scenario_profit || 0) >= 0
                        ? 'text-blue-600'
                        : 'text-red-600'
                    }`}
                  >
                    {formatCurrency(scenarioMutation.data.data?.scenario_profit || 0)}
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
