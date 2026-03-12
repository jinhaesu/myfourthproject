import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { financialApi } from '@/services/api'
import { MagnifyingGlassIcon, XMarkIcon } from '@heroicons/react/24/outline'
import {
  LineChart,
  Line,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts'

// ============================================================================
// Helpers
// ============================================================================
function formatCurrency(value: number) {
  return new Intl.NumberFormat('ko-KR', {
    style: 'currency',
    currency: 'KRW',
    maximumFractionDigits: 0,
  }).format(value)
}

function formatNumber(value: number) {
  return new Intl.NumberFormat('ko-KR').format(value)
}

type TabType = 'summary' | 'income' | 'balance' | 'trial'

const PIE_COLORS = ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899']

// ============================================================================
// Main Page Component
// ============================================================================
export default function FinancialReportsPage() {
  const [activeTab, setActiveTab] = useState<TabType>('summary')
  const [selectedUploadId, setSelectedUploadId] = useState<number | null>(null)

  const { data: uploads, isLoading: uploadsLoading } = useQuery({
    queryKey: ['financialUploadHistory'],
    queryFn: () => financialApi.getUploadHistory().then((r) => r.data),
  })

  const uploadList: Array<{ id: number; filename: string; created_at: string }> = useMemo(() => {
    if (!uploads) return []
    if (Array.isArray(uploads)) return uploads
    if (uploads.uploads && Array.isArray(uploads.uploads)) return uploads.uploads
    return []
  }, [uploads])

  const tabs: { id: TabType; label: string }[] = [
    { id: 'summary', label: '재무 요약' },
    { id: 'income', label: '손익계산서' },
    { id: 'balance', label: '재무상태표' },
    { id: 'trial', label: '시산표' },
  ]

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">재무보고서</h1>
        <p className="text-gray-500 mt-1">계정별 원장 데이터 기반 재무 분석 보고서입니다.</p>
      </div>

      {/* Upload Selector */}
      <div className="card">
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium text-gray-700">데이터 선택</label>
            <select
              value={selectedUploadId ?? ''}
              onChange={(e) => setSelectedUploadId(e.target.value ? Number(e.target.value) : null)}
              className="input w-80"
              disabled={uploadsLoading}
            >
              <option value="">-- 업로드 파일을 선택하세요 --</option>
              {uploadList.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.filename} ({new Date(u.created_at).toLocaleDateString('ko-KR')})
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="border-b border-gray-200">
        <nav className="flex gap-4">
          {tabs.map((tab) => (
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

      {/* Content */}
      {!selectedUploadId ? (
        <div className="card">
          <div className="text-center py-12 text-gray-500">
            <p className="text-lg">데이터를 선택하세요</p>
            <p className="text-sm mt-1">상단의 드롭다운에서 업로드된 파일을 선택해주세요.</p>
          </div>
        </div>
      ) : (
        <>
          {activeTab === 'summary' && <FinancialSummaryTab uploadId={selectedUploadId} />}
          {activeTab === 'income' && <IncomeStatementTab uploadId={selectedUploadId} />}
          {activeTab === 'balance' && <BalanceSheetTab uploadId={selectedUploadId} />}
          {activeTab === 'trial' && <TrialBalanceTab uploadId={selectedUploadId} />}
        </>
      )}
    </div>
  )
}

// ============================================================================
// Tab 1: Financial Summary (재무 요약)
// ============================================================================
function FinancialSummaryTab({ uploadId }: { uploadId: number }) {
  const { data: balanceSheet, isLoading: bsLoading } = useQuery({
    queryKey: ['financialBalanceSheet', uploadId],
    queryFn: () => financialApi.getBalanceSheet(uploadId).then((r) => r.data),
  })

  const { data: incomeStatement, isLoading: isLoading } = useQuery({
    queryKey: ['financialIncomeStatement', uploadId],
    queryFn: () => financialApi.getIncomeStatement(uploadId).then((r) => r.data),
  })

  const { data: monthlyTrend, isLoading: trendLoading } = useQuery({
    queryKey: ['financialMonthlyTrend', uploadId],
    queryFn: () => financialApi.getMonthlyTrend(uploadId).then((r) => r.data),
  })

  const loading = bsLoading || isLoading || trendLoading

  const totalAssets = balanceSheet?.total_assets ?? 0
  const totalLiabilities = balanceSheet?.total_liabilities ?? 0
  const totalEquity = balanceSheet?.total_equity ?? 0
  const netIncome = incomeStatement?.net_income ?? 0

  // Composition chart data
  const compositionData = useMemo(() => {
    const items = []
    if (totalAssets > 0) items.push({ name: '자산', value: Math.abs(totalAssets) })
    if (totalLiabilities > 0) items.push({ name: '부채', value: Math.abs(totalLiabilities) })
    if (totalEquity > 0) items.push({ name: '자본', value: Math.abs(totalEquity) })
    return items
  }, [totalAssets, totalLiabilities, totalEquity])

  // Monthly trend chart data
  const trendChartData = useMemo(() => {
    if (!monthlyTrend) return []
    const months = monthlyTrend.data || monthlyTrend.months || monthlyTrend
    if (!Array.isArray(months)) return []
    return months.map((m: { month: string; debit_total: number; credit_total: number; net: number }) => ({
      month: m.month,
      차변: m.debit_total ?? 0,
      대변: m.credit_total ?? 0,
    }))
  }, [monthlyTrend])

  if (loading) {
    return (
      <div className="text-center py-8">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto" />
        <p className="text-gray-500 mt-2">로딩 중...</p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="card">
          <p className="text-sm text-gray-500">총자산</p>
          <p className="text-xl font-bold text-gray-900">{formatCurrency(totalAssets)}</p>
        </div>
        <div className="card">
          <p className="text-sm text-gray-500">총부채</p>
          <p className="text-xl font-bold text-red-600">{formatCurrency(totalLiabilities)}</p>
        </div>
        <div className="card">
          <p className="text-sm text-gray-500">자본</p>
          <p className="text-xl font-bold text-blue-600">{formatCurrency(totalEquity)}</p>
        </div>
        <div className="card">
          <p className="text-sm text-gray-500">당기순이익</p>
          <p className={`text-xl font-bold ${netIncome >= 0 ? 'text-green-600' : 'text-red-600'}`}>
            {formatCurrency(netIncome)}
          </p>
        </div>
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Composition Pie Chart */}
        <div className="card">
          <h3 className="card-header">자산/부채/자본 구성</h3>
          <div className="h-72">
            {compositionData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={compositionData}
                    cx="50%"
                    cy="50%"
                    innerRadius={60}
                    outerRadius={100}
                    paddingAngle={3}
                    dataKey="value"
                    label={({ name, percent }: { name: string; percent: number }) =>
                      `${name} ${(percent * 100).toFixed(0)}%`
                    }
                  >
                    {compositionData.map((_entry, index) => (
                      <Cell key={`cell-${index}`} fill={PIE_COLORS[index % PIE_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={{ backgroundColor: 'white', border: '1px solid #e5e7eb', borderRadius: '8px' }}
                    formatter={(value: number) => formatCurrency(value)}
                  />
                  <Legend />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-full text-gray-400 text-sm">
                데이터가 없습니다.
              </div>
            )}
          </div>
        </div>

        {/* Monthly Revenue/Expense Trend */}
        <div className="card">
          <h3 className="card-header">월별 차변/대변 추이</h3>
          <div className="h-72">
            {trendChartData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={trendChartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                  <XAxis dataKey="month" stroke="#6b7280" fontSize={12} />
                  <YAxis stroke="#6b7280" fontSize={12} tickFormatter={(v: number) => `${(v / 10000).toFixed(0)}만`} />
                  <Tooltip
                    contentStyle={{ backgroundColor: 'white', border: '1px solid #e5e7eb', borderRadius: '8px' }}
                    formatter={(value: number) => formatCurrency(value)}
                  />
                  <Legend />
                  <Line type="monotone" dataKey="차변" stroke="#3b82f6" strokeWidth={2} dot={{ r: 4 }} />
                  <Line type="monotone" dataKey="대변" stroke="#ef4444" strokeWidth={2} dot={{ r: 4 }} />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-full text-gray-400 text-sm">
                데이터가 없습니다.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ============================================================================
// Tab 2: Income Statement (손익계산서)
// ============================================================================
function IncomeStatementTab({ uploadId }: { uploadId: number }) {
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')

  const { data: incomeData, isLoading } = useQuery({
    queryKey: ['financialIncomeStatement', uploadId, fromDate, toDate],
    queryFn: () =>
      financialApi
        .getIncomeStatement(uploadId, fromDate || undefined, toDate || undefined)
        .then((r) => r.data),
  })

  const revenues: Array<{ account_code: string; account_name: string; amount: number }> =
    incomeData?.revenues ?? incomeData?.revenue_accounts ?? []
  const expenses: Array<{ account_code: string; account_name: string; amount: number }> =
    incomeData?.expenses ?? incomeData?.expense_accounts ?? []
  const totalRevenue = incomeData?.total_revenue ?? revenues.reduce((s: number, a: { amount: number }) => s + a.amount, 0)
  const totalExpense = incomeData?.total_expense ?? expenses.reduce((s: number, a: { amount: number }) => s + a.amount, 0)
  const operatingIncome = incomeData?.operating_income ?? totalRevenue - totalExpense
  const netIncome = incomeData?.net_income ?? operatingIncome

  if (isLoading) {
    return (
      <div className="text-center py-8">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto" />
        <p className="text-gray-500 mt-2">로딩 중...</p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Date Range Filter */}
      <div className="card">
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium text-gray-700">시작일</label>
            <input
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
              className="input w-44"
            />
          </div>
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium text-gray-700">종료일</label>
            <input
              type="date"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
              className="input w-44"
            />
          </div>
        </div>
      </div>

      {/* Revenue Section */}
      <div className="card">
        <h3 className="card-header text-green-700">수익 (Revenue)</h3>
        {revenues.length > 0 ? (
          <div className="table-container">
            <table className="table">
              <thead className="table-header">
                <tr>
                  <th>계정코드</th>
                  <th>계정명</th>
                  <th className="text-right">금액</th>
                </tr>
              </thead>
              <tbody className="table-body">
                {revenues.map((item) => (
                  <tr key={item.account_code}>
                    <td className="text-gray-500">{item.account_code}</td>
                    <td className="font-medium">{item.account_name}</td>
                    <td className="amount text-green-600">{formatCurrency(item.amount)}</td>
                  </tr>
                ))}
                <tr className="bg-green-50 font-bold">
                  <td colSpan={2} className="text-right">수익 합계</td>
                  <td className="amount text-green-700">{formatCurrency(totalRevenue)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        ) : (
          <div className="text-center py-4 text-gray-500">수익 데이터가 없습니다.</div>
        )}
      </div>

      {/* Expense Section */}
      <div className="card">
        <h3 className="card-header text-red-700">비용 (Expenses)</h3>
        {expenses.length > 0 ? (
          <div className="table-container">
            <table className="table">
              <thead className="table-header">
                <tr>
                  <th>계정코드</th>
                  <th>계정명</th>
                  <th className="text-right">금액</th>
                </tr>
              </thead>
              <tbody className="table-body">
                {expenses.map((item) => (
                  <tr key={item.account_code}>
                    <td className="text-gray-500">{item.account_code}</td>
                    <td className="font-medium">{item.account_name}</td>
                    <td className="amount text-red-600">{formatCurrency(item.amount)}</td>
                  </tr>
                ))}
                <tr className="bg-red-50 font-bold">
                  <td colSpan={2} className="text-right">비용 합계</td>
                  <td className="amount text-red-700">{formatCurrency(totalExpense)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        ) : (
          <div className="text-center py-4 text-gray-500">비용 데이터가 없습니다.</div>
        )}
      </div>

      {/* Bottom Summary */}
      <div className="card">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="flex justify-between items-center p-4 bg-blue-50 rounded-lg">
            <span className="text-sm font-medium text-blue-700">영업이익</span>
            <span className={`text-lg font-bold ${operatingIncome >= 0 ? 'text-blue-700' : 'text-red-700'}`}>
              {formatCurrency(operatingIncome)}
            </span>
          </div>
          <div className="flex justify-between items-center p-4 bg-gray-50 rounded-lg">
            <span className="text-sm font-medium text-gray-700">당기순이익</span>
            <span className={`text-lg font-bold ${netIncome >= 0 ? 'text-green-700' : 'text-red-700'}`}>
              {formatCurrency(netIncome)}
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}

// ============================================================================
// Tab 3: Balance Sheet (재무상태표)
// ============================================================================
function BalanceSheetTab({ uploadId }: { uploadId: number }) {
  const { data: balanceData, isLoading } = useQuery({
    queryKey: ['financialBalanceSheet', uploadId],
    queryFn: () => financialApi.getBalanceSheet(uploadId).then((r) => r.data),
  })

  const assets: Array<{ account_code: string; account_name: string; amount: number }> =
    balanceData?.assets ?? balanceData?.asset_accounts ?? []
  const liabilities: Array<{ account_code: string; account_name: string; amount: number }> =
    balanceData?.liabilities ?? balanceData?.liability_accounts ?? []
  const equity: Array<{ account_code: string; account_name: string; amount: number }> =
    balanceData?.equity ?? balanceData?.equity_accounts ?? []

  const totalAssets = balanceData?.total_assets ?? assets.reduce((s: number, a: { amount: number }) => s + a.amount, 0)
  const totalLiabilities =
    balanceData?.total_liabilities ?? liabilities.reduce((s: number, a: { amount: number }) => s + a.amount, 0)
  const totalEquity = balanceData?.total_equity ?? equity.reduce((s: number, a: { amount: number }) => s + a.amount, 0)
  const liabilitiesPlusEquity = totalLiabilities + totalEquity
  const isBalanced = Math.abs(totalAssets - liabilitiesPlusEquity) < 1

  if (isLoading) {
    return (
      <div className="text-center py-8">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto" />
        <p className="text-gray-500 mt-2">로딩 중...</p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Assets (Left Column) */}
        <div className="card">
          <h3 className="card-header text-blue-700">자산 (Assets)</h3>
          {assets.length > 0 ? (
            <div className="table-container">
              <table className="table">
                <thead className="table-header">
                  <tr>
                    <th>계정코드</th>
                    <th>계정명</th>
                    <th className="text-right">금액</th>
                  </tr>
                </thead>
                <tbody className="table-body">
                  {assets.map((item) => (
                    <tr key={item.account_code}>
                      <td className="text-gray-500">{item.account_code}</td>
                      <td className="font-medium">{item.account_name}</td>
                      <td className="amount">{formatCurrency(item.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="text-center py-4 text-gray-500">자산 데이터가 없습니다.</div>
          )}
          <div className="mt-4 flex justify-between items-center p-4 bg-blue-50 rounded-lg">
            <span className="text-sm font-bold text-blue-700">자산총계</span>
            <span className="text-lg font-bold text-blue-700">{formatCurrency(totalAssets)}</span>
          </div>
        </div>

        {/* Liabilities + Equity (Right Column) */}
        <div className="space-y-6">
          {/* Liabilities */}
          <div className="card">
            <h3 className="card-header text-red-700">부채 (Liabilities)</h3>
            {liabilities.length > 0 ? (
              <div className="table-container">
                <table className="table">
                  <thead className="table-header">
                    <tr>
                      <th>계정코드</th>
                      <th>계정명</th>
                      <th className="text-right">금액</th>
                    </tr>
                  </thead>
                  <tbody className="table-body">
                    {liabilities.map((item) => (
                      <tr key={item.account_code}>
                        <td className="text-gray-500">{item.account_code}</td>
                        <td className="font-medium">{item.account_name}</td>
                        <td className="amount">{formatCurrency(item.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="text-center py-4 text-gray-500">부채 데이터가 없습니다.</div>
            )}
            <div className="mt-4 flex justify-between items-center p-3 bg-red-50 rounded-lg">
              <span className="text-sm font-bold text-red-700">부채 소계</span>
              <span className="text-base font-bold text-red-700">{formatCurrency(totalLiabilities)}</span>
            </div>
          </div>

          {/* Equity */}
          <div className="card">
            <h3 className="card-header text-green-700">자본 (Equity)</h3>
            {equity.length > 0 ? (
              <div className="table-container">
                <table className="table">
                  <thead className="table-header">
                    <tr>
                      <th>계정코드</th>
                      <th>계정명</th>
                      <th className="text-right">금액</th>
                    </tr>
                  </thead>
                  <tbody className="table-body">
                    {equity.map((item) => (
                      <tr key={item.account_code}>
                        <td className="text-gray-500">{item.account_code}</td>
                        <td className="font-medium">{item.account_name}</td>
                        <td className="amount">{formatCurrency(item.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="text-center py-4 text-gray-500">자본 데이터가 없습니다.</div>
            )}
            <div className="mt-4 flex justify-between items-center p-3 bg-green-50 rounded-lg">
              <span className="text-sm font-bold text-green-700">자본 소계</span>
              <span className="text-base font-bold text-green-700">{formatCurrency(totalEquity)}</span>
            </div>
          </div>

          {/* Liabilities + Equity Total */}
          <div className="flex justify-between items-center p-4 bg-purple-50 rounded-lg border border-purple-200">
            <span className="text-sm font-bold text-purple-700">부채 + 자본 총계</span>
            <span className="text-lg font-bold text-purple-700">{formatCurrency(liabilitiesPlusEquity)}</span>
          </div>
        </div>
      </div>

      {/* Balance Verification */}
      <div
        className={`card border-2 ${isBalanced ? 'border-green-300 bg-green-50' : 'border-red-300 bg-red-50'}`}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className={`text-2xl ${isBalanced ? 'text-green-600' : 'text-red-600'}`}>
              {isBalanced ? '\u2713' : '\u2717'}
            </span>
            <div>
              <p className={`font-bold ${isBalanced ? 'text-green-700' : 'text-red-700'}`}>
                {isBalanced ? '대차 균형이 일치합니다' : '대차 균형이 불일치합니다'}
              </p>
              <p className="text-sm text-gray-600">
                자산총계: {formatCurrency(totalAssets)} | 부채+자본 총계: {formatCurrency(liabilitiesPlusEquity)}
                {!isBalanced && ` | 차이: ${formatCurrency(totalAssets - liabilitiesPlusEquity)}`}
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ============================================================================
// Tab 4: Trial Balance (시산표)
// ============================================================================
function TrialBalanceTab({ uploadId }: { uploadId: number }) {
  const [search, setSearch] = useState('')
  const [selectedAccount, setSelectedAccount] = useState<string | null>(null)
  const [detailPage, setDetailPage] = useState(1)

  const { data: trialData, isLoading } = useQuery({
    queryKey: ['financialTrialBalance', uploadId],
    queryFn: () => financialApi.getTrialBalance(uploadId).then((r) => r.data),
  })

  const { data: detailData, isLoading: detailLoading } = useQuery({
    queryKey: ['financialAccountDetail', uploadId, selectedAccount, detailPage],
    queryFn: () =>
      financialApi.getAccountDetail(uploadId, selectedAccount!, detailPage, 20).then((r) => r.data),
    enabled: !!selectedAccount,
  })

  const accounts: Array<{
    account_code: string
    account_name: string
    debit_total: number
    credit_total: number
    balance: number
  }> = useMemo(() => {
    if (!trialData) return []
    const list = trialData.items ?? trialData.accounts ?? trialData
    if (!Array.isArray(list)) return []
    return list
  }, [trialData])

  const filteredAccounts = useMemo(() => {
    if (!search.trim()) return accounts
    const keyword = search.toLowerCase()
    return accounts.filter(
      (a) =>
        a.account_code.toLowerCase().includes(keyword) ||
        a.account_name.toLowerCase().includes(keyword)
    )
  }, [accounts, search])

  const totals = useMemo(() => {
    return filteredAccounts.reduce(
      (acc, a) => ({
        debit: acc.debit + (a.debit_total ?? 0),
        credit: acc.credit + (a.credit_total ?? 0),
        balance: acc.balance + (a.balance ?? 0),
      }),
      { debit: 0, credit: 0, balance: 0 }
    )
  }, [filteredAccounts])

  const detailItems = useMemo(() => {
    const raw = detailData?.items ?? detailData?.transactions ?? []
    let runningBalance = 0
    return raw.map((item: any) => {
      const debit = item.debit_amount ?? item.debit ?? 0
      const credit = item.credit_amount ?? item.credit ?? 0
      runningBalance += debit - credit
      return {
        date: item.transaction_date ?? item.date ?? '',
        description: item.description ?? '',
        debit,
        credit,
        balance: runningBalance,
      }
    })
  }, [detailData])
  const detailTotalPages = detailData?.total_pages ?? 1

  if (isLoading) {
    return (
      <div className="text-center py-8">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto" />
        <p className="text-gray-500 mt-2">로딩 중...</p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Search / Filter */}
      <div className="card">
        <div className="flex items-center gap-2">
          <MagnifyingGlassIcon className="h-5 w-5 text-gray-400" />
          <input
            type="text"
            placeholder="계정코드 또는 계정명으로 검색..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="input flex-1"
          />
        </div>
      </div>

      {/* Trial Balance Table */}
      <div className="card">
        <h3 className="card-header">시산표</h3>
        {filteredAccounts.length > 0 ? (
          <div className="table-container">
            <table className="table">
              <thead className="table-header">
                <tr>
                  <th>계정코드</th>
                  <th>계정명</th>
                  <th className="text-right">차변합계</th>
                  <th className="text-right">대변합계</th>
                  <th className="text-right">잔액</th>
                </tr>
              </thead>
              <tbody className="table-body">
                {filteredAccounts.map((account) => (
                  <tr
                    key={account.account_code}
                    onClick={() => {
                      setSelectedAccount(
                        selectedAccount === account.account_code ? null : account.account_code
                      )
                      setDetailPage(1)
                    }}
                    className="cursor-pointer"
                  >
                    <td className="text-gray-500 font-mono">{account.account_code}</td>
                    <td className="font-medium">{account.account_name}</td>
                    <td className="amount">{formatCurrency(account.debit_total)}</td>
                    <td className="amount">{formatCurrency(account.credit_total)}</td>
                    <td
                      className={`amount font-bold ${
                        account.balance >= 0 ? 'text-blue-600' : 'text-red-600'
                      }`}
                    >
                      {formatCurrency(account.balance)}
                    </td>
                  </tr>
                ))}
                {/* Totals Row */}
                <tr className="bg-gray-100 font-bold border-t-2 border-gray-300">
                  <td colSpan={2} className="text-right">
                    합계 ({formatNumber(filteredAccounts.length)}건)
                  </td>
                  <td className="amount">{formatCurrency(totals.debit)}</td>
                  <td className="amount">{formatCurrency(totals.credit)}</td>
                  <td
                    className={`amount ${totals.balance >= 0 ? 'text-blue-600' : 'text-red-600'}`}
                  >
                    {formatCurrency(totals.balance)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        ) : (
          <div className="text-center py-8 text-gray-500">시산표 데이터가 없습니다.</div>
        )}
      </div>

      {/* Account Detail Modal */}
      {selectedAccount && (
        <AccountDetailModal
          accountCode={selectedAccount}
          accountName={accounts.find((a) => a.account_code === selectedAccount)?.account_name ?? ''}
          items={detailItems}
          isLoading={detailLoading}
          page={detailPage}
          totalPages={detailTotalPages}
          onPageChange={setDetailPage}
          onClose={() => setSelectedAccount(null)}
        />
      )}
    </div>
  )
}

// ============================================================================
// Account Detail Modal
// ============================================================================
function AccountDetailModal({
  accountCode,
  accountName,
  items,
  isLoading,
  page,
  totalPages,
  onPageChange,
  onClose,
}: {
  accountCode: string
  accountName: string
  items: Array<{ date: string; description: string; debit: number; credit: number; balance: number }>
  isLoading: boolean
  page: number
  totalPages: number
  onPageChange: (page: number) => void
  onClose: () => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50" onClick={onClose}>
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-4xl max-h-[80vh] flex flex-col mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div className="flex items-center justify-between p-6 border-b">
          <div>
            <h3 className="text-lg font-bold text-gray-900">계정 상세</h3>
            <p className="text-sm text-gray-500">
              {accountCode} - {accountName}
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600"
          >
            <XMarkIcon className="h-6 w-6" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="flex-1 overflow-auto p-6">
          {isLoading ? (
            <div className="text-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto" />
              <p className="text-gray-500 mt-2">로딩 중...</p>
            </div>
          ) : items.length > 0 ? (
            <div className="table-container">
              <table className="table">
                <thead className="table-header">
                  <tr>
                    <th>날짜</th>
                    <th>적요</th>
                    <th className="text-right">차변</th>
                    <th className="text-right">대변</th>
                    <th className="text-right">잔액</th>
                  </tr>
                </thead>
                <tbody className="table-body">
                  {items.map((item, idx) => (
                    <tr key={idx}>
                      <td className="text-gray-500">{item.date}</td>
                      <td className="font-medium">{item.description}</td>
                      <td className="amount">{item.debit ? formatCurrency(item.debit) : '-'}</td>
                      <td className="amount">{item.credit ? formatCurrency(item.credit) : '-'}</td>
                      <td className={`amount font-bold ${item.balance >= 0 ? 'text-blue-600' : 'text-red-600'}`}>
                        {formatCurrency(item.balance)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="text-center py-8 text-gray-500">거래 내역이 없습니다.</div>
          )}
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-center gap-2 p-4 border-t">
            <button
              onClick={() => onPageChange(page - 1)}
              disabled={page <= 1}
              className="btn-secondary text-sm disabled:opacity-50"
            >
              이전
            </button>
            <span className="text-sm text-gray-600">
              {page} / {totalPages}
            </span>
            <button
              onClick={() => onPageChange(page + 1)}
              disabled={page >= totalPages}
              className="btn-secondary text-sm disabled:opacity-50"
            >
              다음
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
