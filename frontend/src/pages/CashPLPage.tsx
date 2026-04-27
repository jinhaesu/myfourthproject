import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend,
} from 'recharts'
import { ScaleIcon } from '@heroicons/react/24/outline'
import { cashPLApi } from '@/services/api'
import StatCard from '@/components/common/StatCard'
import { formatCurrency, formatCompactWon, formatPct, todayISO } from '@/utils/format'

type Basis = 'cash' | 'accrual'
type Period = 'monthly' | 'weekly' | 'quarterly' | 'yearly' | 'daily'

const PERIOD_LABEL: Record<Period, string> = {
  daily: '일별',
  weekly: '주별',
  monthly: '월별',
  quarterly: '분기별',
  yearly: '연도별',
}

export default function CashPLPage() {
  const [basis, setBasis] = useState<Basis>('cash')
  const [periodType, setPeriodType] = useState<Period>('monthly')
  const [fromDate, setFromDate] = useState(() => {
    const d = new Date()
    d.setMonth(d.getMonth() - 5)
    d.setDate(1)
    return d.toISOString().slice(0, 10)
  })
  const [toDate, setToDate] = useState(todayISO())

  const plQuery = useQuery({
    queryKey: ['cash-pl', basis, periodType, fromDate, toDate],
    queryFn: () =>
      cashPLApi
        .getCashPL({ from_date: fromDate, to_date: toDate, basis, period_type: periodType })
        .then((r) => r.data),
  })

  const compareQuery = useQuery({
    queryKey: ['cash-pl-compare', fromDate, toDate],
    queryFn: () => cashPLApi.getComparison(fromDate, toDate).then((r) => r.data),
  })

  const data = plQuery.data
  const compare = compareQuery.data

  const chartData =
    data?.summaries?.map((s: any) => ({
      label: s.period_label,
      매출: Math.round(Number(s.revenue) / 10000),
      영업이익: Math.round(Number(s.operating_profit) / 10000),
      순이익: Math.round(Number(s.net_profit) / 10000),
      마진율: Number(s.operating_margin_pct),
    })) || []

  const total = data?.summaries?.reduce(
    (acc: any, s: any) => ({
      revenue: acc.revenue + Number(s.revenue),
      cogs: acc.cogs + Number(s.cogs),
      gross_profit: acc.gross_profit + Number(s.gross_profit),
      opex: acc.opex + Number(s.opex),
      operating_profit: acc.operating_profit + Number(s.operating_profit),
      net_profit: acc.net_profit + Number(s.net_profit),
    }),
    { revenue: 0, cogs: 0, gross_profit: 0, opex: 0, operating_profit: 0, net_profit: 0 }
  )

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">현금주의 손익 분석</h1>
          <p className="text-gray-500 mt-1">
            현금이 실제 들어온/나간 시점 기준 손익. 발생주의와의 차이까지 한 화면에서.
          </p>
        </div>
      </div>

      {/* Filters */}
      <div className="card">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex gap-1 bg-gray-100 rounded-lg p-1">
            <button
              onClick={() => setBasis('cash')}
              className={`px-3 py-1.5 rounded-md text-sm font-medium ${
                basis === 'cash' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'
              }`}
            >
              현금주의
            </button>
            <button
              onClick={() => setBasis('accrual')}
              className={`px-3 py-1.5 rounded-md text-sm font-medium ${
                basis === 'accrual' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'
              }`}
            >
              발생주의
            </button>
          </div>

          <select
            value={periodType}
            onChange={(e) => setPeriodType(e.target.value as Period)}
            className="input w-32"
          >
            {(Object.keys(PERIOD_LABEL) as Period[]).map((p) => (
              <option key={p} value={p}>
                {PERIOD_LABEL[p]}
              </option>
            ))}
          </select>

          <input
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            className="input w-40"
          />
          <span className="text-gray-400">~</span>
          <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="input w-40" />
        </div>
      </div>

      {/* KPI cards */}
      {total && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard
            label="매출"
            value={formatCompactWon(total.revenue)}
            unit="원"
            tone="primary"
            icon={<ScaleIcon className="h-5 w-5" />}
          />
          <StatCard
            label="매출원가"
            value={formatCompactWon(total.cogs)}
            unit="원"
            hint={`매출 대비 ${formatPct((total.cogs / total.revenue) * 100)}`}
            tone="neutral"
          />
          <StatCard
            label="영업이익"
            value={formatCompactWon(total.operating_profit)}
            unit="원"
            hint={`영업이익률 ${formatPct((total.operating_profit / total.revenue) * 100)}`}
            tone={total.operating_profit >= 0 ? 'success' : 'danger'}
          />
          <StatCard
            label="당기순이익"
            value={formatCompactWon(total.net_profit)}
            unit="원"
            hint={`순이익률 ${formatPct((total.net_profit / total.revenue) * 100)}`}
            tone={total.net_profit >= 0 ? 'mint' : 'danger'}
          />
        </div>
      )}

      {/* Trend chart */}
      <div className="card">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">기간별 추이 (단위: 만원)</h2>
        <div className="h-80">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis dataKey="label" tick={{ fontSize: 12 }} />
              <YAxis tick={{ fontSize: 12 }} />
              <Tooltip
                formatter={(v: number) => `${v.toLocaleString()} 만원`}
                contentStyle={{ borderRadius: 8, border: '1px solid #e5e7eb' }}
              />
              <Legend />
              <Bar dataKey="매출" fill="#3b82f6" radius={[4, 4, 0, 0]} />
              <Bar dataKey="영업이익" fill="#10b981" radius={[4, 4, 0, 0]} />
              <Bar dataKey="순이익" fill="#14b8a6" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Margin trend */}
      <div className="card">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">영업이익률 추이</h2>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis dataKey="label" tick={{ fontSize: 12 }} />
              <YAxis tick={{ fontSize: 12 }} unit="%" />
              <Tooltip formatter={(v: number) => `${v.toFixed(1)}%`} />
              <Line type="monotone" dataKey="마진율" stroke="#0d9488" strokeWidth={2} dot={{ r: 3 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Comparison cash vs accrual */}
      {compare && (
        <div className="card">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">
            현금주의 vs 발생주의 비교 ({compare.period_label})
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {[
              { key: 'revenue', label: '매출' },
              { key: 'operating_profit', label: '영업이익' },
              { key: 'net_profit', label: '순이익' },
            ].map((row) => {
              const c = Number(compare.cash_basis[row.key])
              const a = Number(compare.accrual_basis[row.key])
              const diff = c - a
              return (
                <div key={row.key} className="border border-gray-200 rounded-lg p-4">
                  <div className="text-sm text-gray-500">{row.label}</div>
                  <div className="mt-2 space-y-1">
                    <div className="flex justify-between text-sm">
                      <span className="text-gray-600">현금주의</span>
                      <span className="font-mono font-medium">{formatCurrency(c, false)}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-gray-600">발생주의</span>
                      <span className="font-mono font-medium">{formatCurrency(a, false)}</span>
                    </div>
                    <div className="flex justify-between text-sm border-t border-gray-100 pt-1 mt-1">
                      <span className="text-gray-600">차이</span>
                      <span className={`font-mono font-semibold ${diff >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                        {diff >= 0 ? '+' : ''}{formatCurrency(diff, false)}
                      </span>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Line items */}
      <div className="card">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">계정과목별 합계 (전 기간)</h2>
        <div className="table-container">
          <table className="table">
            <thead className="table-header">
              <tr>
                <th>분류</th>
                <th>코드</th>
                <th>계정과목</th>
                <th className="text-right">금액</th>
                <th className="text-right">매출 대비</th>
              </tr>
            </thead>
            <tbody className="table-body">
              {data?.line_items?.map((it: any) => (
                <tr key={it.account_code}>
                  <td>
                    <span
                      className={
                        it.category === 'revenue'
                          ? 'badge bg-blue-100 text-blue-700'
                          : it.category === 'cogs'
                          ? 'badge bg-amber-100 text-amber-700'
                          : it.category === 'opex'
                          ? 'badge bg-purple-100 text-purple-700'
                          : 'badge bg-gray-100 text-gray-700'
                      }
                    >
                      {it.category === 'revenue'
                        ? '매출'
                        : it.category === 'cogs'
                        ? '원가'
                        : it.category === 'opex'
                        ? '판관비'
                        : it.category === 'non_operating'
                        ? '영업외'
                        : '세금'}
                    </span>
                  </td>
                  <td className="text-sm font-mono text-gray-600">{it.account_code}</td>
                  <td className="text-sm font-medium text-gray-900">{it.account_name}</td>
                  <td className="text-right font-mono tabular-nums">{formatCurrency(it.amount, false)}</td>
                  <td className="text-right text-sm text-gray-500 tabular-nums">
                    {formatPct(it.pct_of_revenue)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
