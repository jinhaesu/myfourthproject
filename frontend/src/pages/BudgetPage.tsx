import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { budgetApi, usersApi, vouchersApi } from '@/services/api'
import { useAuthStore } from '@/store/authStore'
import FiscalYearTabs from '@/components/common/FiscalYearTabs'
import {
  CalculatorIcon,
  ChartBarIcon,
  ExclamationTriangleIcon,
  PlusIcon,
} from '@heroicons/react/24/outline'
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

function formatPercent(value: number) {
  return `${value.toFixed(1)}%`
}

export default function BudgetPage() {
  const user = useAuthStore((state) => state.user)
  const queryClient = useQueryClient()
  const currentYear = new Date().getFullYear()
  const [fiscalYear, setFiscalYear] = useState(currentYear)
  const [selectedDepartmentId, setSelectedDepartmentId] = useState<number | undefined>(
    undefined
  )
  const [showCreateForm, setShowCreateForm] = useState(false)

  // Fetch budgets
  const { data: budgets, isLoading: budgetsLoading } = useQuery({
    queryKey: ['budgets', fiscalYear, selectedDepartmentId],
    queryFn: () =>
      budgetApi
        .list(fiscalYear, selectedDepartmentId)
        .then((res) => res.data),
  })

  // Fetch budget vs actual
  const { data: vsActualData } = useQuery({
    queryKey: ['budgetVsActual', fiscalYear, selectedDepartmentId],
    queryFn: () =>
      budgetApi
        .getVsActual(fiscalYear, selectedDepartmentId)
        .then((res) => res.data),
  })

  // Fetch departments for filter
  const { data: departments } = useQuery({
    queryKey: ['departments'],
    queryFn: () => usersApi.getDepartments().then((res) => res.data),
  })

  // Fetch budget summary for a department
  const { data: budgetSummary } = useQuery({
    queryKey: ['budgetSummary', user?.departmentId, fiscalYear],
    queryFn: () =>
      budgetApi
        .getSummary(user?.departmentId || 0, fiscalYear)
        .then((res) => res.data),
    enabled: !!user?.departmentId,
  })

  // Create budget mutation
  const createBudgetMutation = useMutation({
    mutationFn: (data: any) => budgetApi.create(data, user?.id || 0),
    onSuccess: () => {
      toast.success('예산이 생성되었습니다.')
      queryClient.invalidateQueries({ queryKey: ['budgets'] })
      setShowCreateForm(false)
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.detail || '예산 생성에 실패했습니다.')
    },
  })

  // Chart data from vs actual
  const chartData = vsActualData?.items?.map((item: any) => ({
    account: item.account_name,
    budget: Number(item.budget_amount),
    actual: Number(item.actual_amount),
    usage: Number(item.usage_rate),
  })) || []

  // Summary stats
  const totalBudget = budgetSummary?.total_budget || 0
  const totalUsed = budgetSummary?.total_used || 0
  const totalRemaining = budgetSummary?.total_remaining || 0
  const usageRate = totalBudget > 0 ? (totalUsed / totalBudget) * 100 : 0

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">예산 관리</h1>
          <p className="text-gray-500 mt-1">
            부서별 예산을 설정하고 사용 현황을 관리합니다.
          </p>
        </div>
        <button
          onClick={() => setShowCreateForm(true)}
          className="btn-primary"
        >
          <PlusIcon className="h-5 w-5 mr-2" />
          예산 생성
        </button>
      </div>

      {/* Filters */}
      <div className="card">
        <div className="flex items-center gap-4 flex-wrap">
          <FiscalYearTabs
            year={fiscalYear}
            onChange={setFiscalYear}
          />
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium text-gray-700">회계연도</label>
            <select
              value={fiscalYear}
              onChange={(e) => setFiscalYear(Number(e.target.value))}
              className="input w-32"
            >
              {[currentYear - 1, currentYear, currentYear + 1].map((year) => (
                <option key={year} value={year}>
                  {year}년
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium text-gray-700">부서</label>
            <select
              value={selectedDepartmentId || ''}
              onChange={(e) =>
                setSelectedDepartmentId(
                  e.target.value ? Number(e.target.value) : undefined
                )
              }
              className="input w-40"
            >
              <option value="">전체 부서</option>
              {departments?.map((dept: any) => (
                <option key={dept.id} value={dept.id}>
                  {dept.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="card">
          <div className="flex items-center gap-4">
            <div className="p-3 bg-blue-100 rounded-lg">
              <CalculatorIcon className="h-6 w-6 text-blue-600" />
            </div>
            <div>
              <p className="text-sm text-gray-500">총 예산</p>
              <p className="text-xl font-bold">{formatCurrency(totalBudget)}</p>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="flex items-center gap-4">
            <div className="p-3 bg-green-100 rounded-lg">
              <ChartBarIcon className="h-6 w-6 text-green-600" />
            </div>
            <div>
              <p className="text-sm text-gray-500">사용액</p>
              <p className="text-xl font-bold text-green-600">
                {formatCurrency(totalUsed)}
              </p>
            </div>
          </div>
        </div>

        <div className="card">
          <div>
            <p className="text-sm text-gray-500">잔여 예산</p>
            <p
              className={`text-xl font-bold ${
                totalRemaining >= 0 ? 'text-blue-600' : 'text-red-600'
              }`}
            >
              {formatCurrency(totalRemaining)}
            </p>
          </div>
        </div>

        <div className="card">
          <div>
            <p className="text-sm text-gray-500">사용률</p>
            <div className="flex items-center gap-2 mt-1">
              <div className="flex-1 bg-gray-200 rounded-full h-3">
                <div
                  className={`h-3 rounded-full ${
                    usageRate >= 90
                      ? 'bg-red-500'
                      : usageRate >= 70
                      ? 'bg-yellow-500'
                      : 'bg-green-500'
                  }`}
                  style={{ width: `${Math.min(usageRate, 100)}%` }}
                />
              </div>
              <span className="text-lg font-bold">{formatPercent(usageRate)}</span>
            </div>
            {usageRate >= 90 && (
              <div className="flex items-center gap-1 mt-1 text-red-600 text-xs">
                <ExclamationTriangleIcon className="h-4 w-4" />
                예산 초과 주의
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Budget vs Actual Chart */}
      {chartData.length > 0 && (
        <div className="card">
          <h3 className="card-header">예산 vs 실적</h3>
          <div className="h-80">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData.slice(0, 10)}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis
                  dataKey="account"
                  stroke="#6b7280"
                  fontSize={12}
                  angle={-45}
                  textAnchor="end"
                  height={80}
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
                <Bar
                  dataKey="budget"
                  name="예산"
                  fill="#3b82f6"
                  radius={[4, 4, 0, 0]}
                />
                <Bar
                  dataKey="actual"
                  name="실적"
                  fill="#10b981"
                  radius={[4, 4, 0, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Budget List */}
      <div className="card">
        <h3 className="card-header">예산 목록</h3>

        {budgetsLoading ? (
          <div className="text-center py-8">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto"></div>
            <p className="text-gray-500 mt-2">로딩 중...</p>
          </div>
        ) : budgets?.length > 0 ? (
          <div className="table-container">
            <table className="table">
              <thead className="table-header">
                <tr>
                  <th>예산명</th>
                  <th>회계연도</th>
                  <th>부서</th>
                  <th>기간유형</th>
                  <th className="text-right">총 예산</th>
                  <th>상태</th>
                  <th className="text-right">사용률</th>
                </tr>
              </thead>
              <tbody className="table-body">
                {budgets.map((budget: any) => (
                  <tr key={budget.id}>
                    <td className="font-medium">{budget.budget_name}</td>
                    <td>{budget.fiscal_year}</td>
                    <td>{budget.department_name || '-'}</td>
                    <td>
                      <span className="badge-gray">
                        {budget.period_type === 'annual'
                          ? '연간'
                          : budget.period_type === 'monthly'
                          ? '월간'
                          : budget.period_type === 'quarterly'
                          ? '분기'
                          : budget.period_type}
                      </span>
                    </td>
                    <td className="amount">
                      {formatCurrency(budget.total_amount || 0)}
                    </td>
                    <td>
                      <span
                        className={
                          budget.status === 'approved'
                            ? 'badge-success'
                            : budget.status === 'draft'
                            ? 'badge-gray'
                            : 'badge-warning'
                        }
                      >
                        {budget.status === 'approved'
                          ? '승인'
                          : budget.status === 'draft'
                          ? '임시'
                          : budget.status === 'pending'
                          ? '대기'
                          : budget.status}
                      </span>
                    </td>
                    <td className="amount">
                      {budget.usage_rate != null
                        ? formatPercent(budget.usage_rate)
                        : '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="text-center py-8 text-gray-500">
            등록된 예산이 없습니다.
          </div>
        )}
      </div>

      {/* Create Budget Modal */}
      {showCreateForm && (
        <CreateBudgetModal
          onClose={() => setShowCreateForm(false)}
          onSubmit={(data) => createBudgetMutation.mutate(data)}
          isLoading={createBudgetMutation.isPending}
          departments={departments || []}
          fiscalYear={fiscalYear}
        />
      )}
    </div>
  )
}

function CreateBudgetModal({
  onClose,
  onSubmit,
  isLoading,
  departments,
  fiscalYear,
}: {
  onClose: () => void
  onSubmit: (data: any) => void
  isLoading: boolean
  departments: any[]
  fiscalYear: number
}) {
  const [formData, setFormData] = useState({
    budget_name: '',
    fiscal_year: fiscalYear,
    department_id: '',
    period_type: 'annual',
    description: '',
  })

  const [lines, setLines] = useState<Array<{
    account_id: string
    account_name: string
    annual_amount: number
  }>>([])

  // Fetch expense accounts for budget lines
  const { data: accounts } = useQuery({
    queryKey: ['budgetAccounts'],
    queryFn: () => vouchersApi.getAccounts(5).then((res) => res.data), // category 5 = expense
  })

  const addLine = () => {
    setLines((prev) => [...prev, { account_id: '', account_name: '', annual_amount: 0 }])
  }

  const removeLine = (idx: number) => {
    setLines((prev) => prev.filter((_, i) => i !== idx))
  }

  const updateLine = (idx: number, field: string, value: any) => {
    setLines((prev) =>
      prev.map((l, i) => {
        if (i !== idx) return l
        if (field === 'account_id') {
          const acc = accounts?.find((a: any) => a.id === Number(value))
          return { ...l, account_id: value, account_name: acc?.name || '' }
        }
        return { ...l, [field]: value }
      })
    )
  }

  const totalBudget = lines.reduce((s, l) => s + (Number(l.annual_amount) || 0), 0)

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!formData.budget_name.trim()) {
      toast.error('예산명을 입력하세요.')
      return
    }
    if (!formData.department_id) {
      toast.error('부서를 선택하세요.')
      return
    }

    const budgetLines = lines
      .filter((l) => l.account_id && l.annual_amount > 0)
      .map((l) => ({
        account_id: Number(l.account_id),
        annual_amount: l.annual_amount,
      }))

    onSubmit({
      ...formData,
      department_id: Number(formData.department_id),
      total_amount: totalBudget,
      lines: budgetLines,
    })
  }

  const inputClass = "w-full mt-1 px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <h3 className="text-lg font-bold text-gray-900 mb-4">예산 생성</h3>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="label">
              예산명 <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={formData.budget_name}
              onChange={(e) => setFormData({ ...formData, budget_name: e.target.value })}
              className={inputClass}
              placeholder="예: 2024년 개발팀 연간 예산"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">회계연도</label>
              <select
                value={formData.fiscal_year}
                onChange={(e) => setFormData({ ...formData, fiscal_year: Number(e.target.value) })}
                className={inputClass}
              >
                {[fiscalYear - 1, fiscalYear, fiscalYear + 1].map((year) => (
                  <option key={year} value={year}>{year}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">
                부서 <span className="text-red-500">*</span>
              </label>
              <select
                value={formData.department_id}
                onChange={(e) => setFormData({ ...formData, department_id: e.target.value })}
                className={inputClass}
              >
                <option value="">선택</option>
                {departments.map((dept: any) => (
                  <option key={dept.id} value={dept.id}>{dept.name}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="label">기간유형</label>
            <select
              value={formData.period_type}
              onChange={(e) => setFormData({ ...formData, period_type: e.target.value })}
              className={inputClass}
            >
              <option value="annual">연간</option>
              <option value="quarterly">분기</option>
              <option value="monthly">월간</option>
            </select>
          </div>

          {/* Budget Lines */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="label">계정별 예산 배정</label>
              <button type="button" onClick={addLine} className="text-sm text-blue-600 hover:text-blue-800 font-medium">
                + 계정 추가
              </button>
            </div>

            {lines.length > 0 ? (
              <div className="space-y-2">
                {lines.map((line, idx) => (
                  <div key={idx} className="flex items-center gap-2">
                    <select
                      value={line.account_id}
                      onChange={(e) => updateLine(idx, 'account_id', e.target.value)}
                      className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-1 focus:ring-blue-500"
                    >
                      <option value="">계정 선택</option>
                      {accounts?.map((acc: any) => (
                        <option key={acc.id} value={acc.id}>
                          {acc.code} - {acc.name}
                        </option>
                      ))}
                    </select>
                    <input
                      type="number"
                      value={line.annual_amount || ''}
                      onChange={(e) => updateLine(idx, 'annual_amount', Number(e.target.value) || 0)}
                      className="w-40 px-3 py-2 border border-gray-300 rounded-lg text-sm text-right focus:ring-1 focus:ring-blue-500"
                      placeholder="금액"
                      min="0"
                    />
                    <button
                      type="button"
                      onClick={() => removeLine(idx)}
                      className="p-2 text-gray-400 hover:text-red-500"
                    >
                      ×
                    </button>
                  </div>
                ))}
                <div className="flex justify-end text-sm font-medium text-gray-700 pt-2 border-t">
                  합계: {formatCurrency(totalBudget)}
                </div>
              </div>
            ) : (
              <div className="text-center py-4 text-gray-400 text-sm border border-dashed border-gray-300 rounded-lg">
                '계정 추가' 버튼을 눌러 예산 항목을 추가하세요.
              </div>
            )}
          </div>

          <div>
            <label className="label">설명</label>
            <textarea
              value={formData.description}
              onChange={(e) => setFormData({ ...formData, description: e.target.value })}
              className={inputClass}
              rows={2}
              placeholder="예산 설명 (선택)"
            />
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200">
              취소
            </button>
            <button
              type="submit"
              disabled={isLoading}
              className="px-4 py-2 text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50"
            >
              {isLoading ? '생성 중...' : '생성'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
