import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { financialApi } from '@/services/api'
import { MagnifyingGlassIcon, XMarkIcon } from '@heroicons/react/24/outline'
import {
  BarChart, Bar, LineChart, Line, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts'

function fmt(value: number) {
  return new Intl.NumberFormat('ko-KR', { style: 'currency', currency: 'KRW', maximumFractionDigits: 0 }).format(value)
}
function fmtNum(value: number) {
  return new Intl.NumberFormat('ko-KR').format(value)
}

type TabType = 'summary' | 'income' | 'balance' | 'trial'
const COLORS = ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316']
const MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]

export default function FinancialReportsPage() {
  const [activeTab, setActiveTab] = useState<TabType>('summary')
  const [selectedUploadId, setSelectedUploadId] = useState<number | null>(null)

  const { data: uploads, isLoading: uploadsLoading } = useQuery({
    queryKey: ['financialUploadHistory'],
    queryFn: () => financialApi.getUploadHistory().then((r) => r.data),
  })

  const uploadList = useMemo(() => {
    if (!uploads) return []
    if (Array.isArray(uploads)) return uploads
    return []
  }, [uploads])

  const tabs: { id: TabType; label: string }[] = [
    { id: 'summary', label: '재무 요약' },
    { id: 'income', label: '입출금 분석' },
    { id: 'balance', label: '잔액 현황' },
    { id: 'trial', label: '시산표' },
  ]

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">재무보고서</h1>
        <p className="text-gray-500 mt-1">계정별 원장 데이터 기반 재무 분석</p>
      </div>

      <div className="card">
        <div className="flex items-center gap-4 flex-wrap">
          <label className="text-sm font-medium text-gray-700">데이터 선택</label>
          <select
            value={selectedUploadId ?? ''}
            onChange={(e) => setSelectedUploadId(e.target.value ? Number(e.target.value) : null)}
            className="input w-96"
            disabled={uploadsLoading}
          >
            <option value="">-- 업로드 파일을 선택하세요 --</option>
            {uploadList.map((u: any) => (
              <option key={u.id} value={u.id}>
                {u.filename} ({fmtNum(u.saved_count || u.row_count || 0)}건, {u.created_at ? new Date(u.created_at).toLocaleDateString('ko-KR') : ''})
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="border-b border-gray-200">
        <nav className="flex gap-4">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`pb-3 px-1 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab.id ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {!selectedUploadId ? (
        <div className="card text-center py-12 text-gray-500">
          <p className="text-lg">데이터를 선택하세요</p>
          <p className="text-sm mt-1">AI 분류에서 업로드한 파일을 선택해주세요.</p>
        </div>
      ) : (
        <>
          {activeTab === 'summary' && <SummaryTab uploadId={selectedUploadId} />}
          {activeTab === 'income' && <IncomeTab uploadId={selectedUploadId} />}
          {activeTab === 'balance' && <BalanceTab uploadId={selectedUploadId} />}
          {activeTab === 'trial' && <TrialBalanceTab uploadId={selectedUploadId} />}
        </>
      )}
    </div>
  )
}

// ============ 재무 요약 ============
function SummaryTab({ uploadId }: { uploadId: number }) {
  const { data: summary, isLoading: sumLoading } = useQuery({
    queryKey: ['financialSummary', uploadId],
    queryFn: () => financialApi.getBalanceSheet(uploadId).then((r) => r.data),
  })

  const { data: trend } = useQuery({
    queryKey: ['financialTrend', uploadId],
    queryFn: () => financialApi.getMonthlyTrend(uploadId).then((r) => r.data),
  })

  if (sumLoading) return <Loading />

  const totalIn = summary?.total_debit ?? 0
  const totalOut = summary?.total_credit ?? 0
  const netBal = summary?.net_balance ?? 0
  const trendData = (trend?.data || []).map((m: any) => ({
    month: m.month?.replace(/^\d{4}-/, '') + '월',
    입금: m.debit_total,
    출금: m.credit_total,
  }))

  const topCounterparts = (summary?.counterparts || []).slice(0, 6).map((c: any) => ({
    name: c.account_name || c.account_code,
    value: Math.abs(c.debit_total + c.credit_total),
  }))

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="card">
          <p className="text-sm text-gray-500">총 입금 (차변)</p>
          <p className="text-xl font-bold text-blue-600">{fmt(totalIn)}</p>
        </div>
        <div className="card">
          <p className="text-sm text-gray-500">총 출금 (대변)</p>
          <p className="text-xl font-bold text-red-600">{fmt(totalOut)}</p>
        </div>
        <div className="card">
          <p className="text-sm text-gray-500">순잔액</p>
          <p className={`text-xl font-bold ${netBal >= 0 ? 'text-green-600' : 'text-red-600'}`}>{fmt(netBal)}</p>
        </div>
        <div className="card">
          <p className="text-sm text-gray-500">거래 건수</p>
          <p className="text-xl font-bold text-gray-900">{fmtNum(summary?.counterparts?.reduce((s: number, c: any) => s + (c.tx_count || 0), 0) || 0)}건</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="card">
          <h3 className="text-sm font-semibold text-gray-700 mb-4">월별 입출금 추이</h3>
          <div className="h-72">
            {trendData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={trendData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                  <XAxis dataKey="month" fontSize={12} />
                  <YAxis fontSize={11} tickFormatter={(v: number) => `${(v / 10000).toFixed(0)}만`} />
                  <Tooltip formatter={(v: number) => fmt(v)} />
                  <Legend />
                  <Bar dataKey="입금" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="출금" fill="#ef4444" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : <Empty />}
          </div>
        </div>

        <div className="card">
          <h3 className="text-sm font-semibold text-gray-700 mb-4">상대 계정 비중</h3>
          <div className="h-72">
            {topCounterparts.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={topCounterparts} cx="50%" cy="50%" innerRadius={50} outerRadius={90} paddingAngle={2} dataKey="value"
                    label={({ name, percent }: any) => `${name.substring(0, 8)} ${(percent * 100).toFixed(0)}%`}>
                    {topCounterparts.map((_: any, i: number) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                  </Pie>
                  <Tooltip formatter={(v: number) => fmt(v)} />
                </PieChart>
              </ResponsiveContainer>
            ) : <Empty />}
          </div>
        </div>
      </div>
    </div>
  )
}

// ============ 입출금 분석 (손익) ============
function IncomeTab({ uploadId }: { uploadId: number }) {
  const currentYear = new Date().getFullYear()
  const [year, setYear] = useState(currentYear)
  const [month, setMonth] = useState<number | null>(null)

  const { data, isLoading } = useQuery({
    queryKey: ['financialIncome', uploadId, year, month],
    queryFn: () => financialApi.getIncomeStatement(uploadId, year, month ?? undefined).then((r) => r.data),
  })

  if (isLoading) return <Loading />

  const inflows: any[] = data?.inflows || []
  const outflows: any[] = data?.outflows || []
  const totalIn = data?.total_inflow ?? 0
  const totalOut = data?.total_outflow ?? 0
  const netFlow = data?.net_flow ?? 0

  return (
    <div className="space-y-6">
      {/* 기간 선택 */}
      <div className="card">
        <div className="flex items-center gap-3 flex-wrap">
          <label className="text-sm font-medium text-gray-700">연도</label>
          <select value={year} onChange={(e) => setYear(Number(e.target.value))} className="input w-28">
            {[currentYear - 2, currentYear - 1, currentYear, currentYear + 1].map((y) => (
              <option key={y} value={y}>{y}년</option>
            ))}
          </select>
          <label className="text-sm font-medium text-gray-700 ml-4">월</label>
          <div className="flex gap-1 flex-wrap">
            <button onClick={() => setMonth(null)}
              className={`px-3 py-1.5 text-xs rounded-lg font-medium ${!month ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
              전체
            </button>
            {MONTHS.map((m) => (
              <button key={m} onClick={() => setMonth(m)}
                className={`px-3 py-1.5 text-xs rounded-lg font-medium ${month === m ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
                {m}월
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* 요약 */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="card bg-blue-50 border-blue-200">
          <p className="text-sm text-blue-700">총 입금</p>
          <p className="text-xl font-bold text-blue-700">{fmt(totalIn)}</p>
        </div>
        <div className="card bg-red-50 border-red-200">
          <p className="text-sm text-red-700">총 출금</p>
          <p className="text-xl font-bold text-red-700">{fmt(totalOut)}</p>
        </div>
        <div className={`card ${netFlow >= 0 ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'}`}>
          <p className="text-sm text-gray-700">순이동</p>
          <p className={`text-xl font-bold ${netFlow >= 0 ? 'text-green-700' : 'text-red-700'}`}>{fmt(netFlow)}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* 입금 */}
        <div className="card">
          <h3 className="text-sm font-semibold text-blue-700 mb-3">입금 내역 (차변)</h3>
          {inflows.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="table w-full">
                <thead className="table-header"><tr><th>코드</th><th>계정명</th><th className="text-right">금액</th><th className="text-right">건수</th></tr></thead>
                <tbody className="table-body">
                  {inflows.map((item: any) => (
                    <tr key={item.account_code}>
                      <td className="text-gray-500 font-mono text-xs">{item.account_code}</td>
                      <td className="font-medium text-sm">{item.account_name}</td>
                      <td className="amount text-blue-600">{fmt(item.amount)}</td>
                      <td className="text-right text-gray-500 text-sm">{fmtNum(item.tx_count)}</td>
                    </tr>
                  ))}
                  <tr className="bg-blue-50 font-bold"><td colSpan={2} className="text-right">합계</td><td className="amount text-blue-700">{fmt(totalIn)}</td><td></td></tr>
                </tbody>
              </table>
            </div>
          ) : <div className="text-center py-4 text-gray-400 text-sm">입금 데이터 없음</div>}
        </div>

        {/* 출금 */}
        <div className="card">
          <h3 className="text-sm font-semibold text-red-700 mb-3">출금 내역 (대변)</h3>
          {outflows.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="table w-full">
                <thead className="table-header"><tr><th>코드</th><th>계정명</th><th className="text-right">금액</th><th className="text-right">건수</th></tr></thead>
                <tbody className="table-body">
                  {outflows.map((item: any) => (
                    <tr key={item.account_code}>
                      <td className="text-gray-500 font-mono text-xs">{item.account_code}</td>
                      <td className="font-medium text-sm">{item.account_name}</td>
                      <td className="amount text-red-600">{fmt(item.amount)}</td>
                      <td className="text-right text-gray-500 text-sm">{fmtNum(item.tx_count)}</td>
                    </tr>
                  ))}
                  <tr className="bg-red-50 font-bold"><td colSpan={2} className="text-right">합계</td><td className="amount text-red-700">{fmt(totalOut)}</td><td></td></tr>
                </tbody>
              </table>
            </div>
          ) : <div className="text-center py-4 text-gray-400 text-sm">출금 데이터 없음</div>}
        </div>
      </div>
    </div>
  )
}

// ============ 잔액 현황 (재무상태표) ============
function BalanceTab({ uploadId }: { uploadId: number }) {
  const { data, isLoading } = useQuery({
    queryKey: ['financialBalance', uploadId],
    queryFn: () => financialApi.getBalanceSheet(uploadId).then((r) => r.data),
  })

  const { data: trend } = useQuery({
    queryKey: ['financialTrendBalance', uploadId],
    queryFn: () => financialApi.getMonthlyTrend(uploadId).then((r) => r.data),
  })

  if (isLoading) return <Loading />

  const accounts: any[] = data?.accounts || []
  const counterparts: any[] = data?.counterparts || []
  const trendData = (trend?.data || []).map((m: any) => ({
    month: m.month?.replace(/^\d{4}-/, '') + '월',
    잔액: m.net,
  }))

  return (
    <div className="space-y-6">
      {/* 원장 계정 잔액 */}
      <div className="card">
        <h3 className="text-sm font-semibold text-gray-700 mb-3">원장 계정 잔액</h3>
        {accounts.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="table w-full">
              <thead className="table-header"><tr><th>코드</th><th>계정명</th><th className="text-right">차변합계</th><th className="text-right">대변합계</th><th className="text-right">잔액</th></tr></thead>
              <tbody className="table-body">
                {accounts.map((a: any) => (
                  <tr key={a.account_code}>
                    <td className="text-gray-500 font-mono">{a.account_code}</td>
                    <td className="font-medium">{a.account_name}</td>
                    <td className="amount">{fmt(a.debit_total)}</td>
                    <td className="amount">{fmt(a.credit_total)}</td>
                    <td className={`amount font-bold ${a.balance >= 0 ? 'text-blue-600' : 'text-red-600'}`}>{fmt(a.balance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <div className="text-center py-4 text-gray-400 text-sm">데이터 없음</div>}

        <div className="mt-4 p-4 bg-blue-50 rounded-lg flex justify-between items-center">
          <span className="font-bold text-blue-700">총 잔액</span>
          <span className={`text-xl font-bold ${(data?.net_balance ?? 0) >= 0 ? 'text-blue-700' : 'text-red-700'}`}>
            {fmt(data?.net_balance ?? 0)}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* 월별 잔액 추이 */}
        <div className="card">
          <h3 className="text-sm font-semibold text-gray-700 mb-4">월별 순잔액 추이</h3>
          <div className="h-64">
            {trendData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={trendData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                  <XAxis dataKey="month" fontSize={12} />
                  <YAxis fontSize={11} tickFormatter={(v: number) => `${(v / 10000).toFixed(0)}만`} />
                  <Tooltip formatter={(v: number) => fmt(v)} />
                  <Line type="monotone" dataKey="잔액" stroke="#3b82f6" strokeWidth={2} dot={{ r: 4 }} />
                </LineChart>
              </ResponsiveContainer>
            ) : <Empty />}
          </div>
        </div>

        {/* 상대 계정 Top */}
        <div className="card">
          <h3 className="text-sm font-semibold text-gray-700 mb-3">주요 상대 계정</h3>
          {counterparts.length > 0 ? (
            <div className="overflow-x-auto max-h-72 overflow-y-auto">
              <table className="table w-full">
                <thead className="table-header sticky top-0"><tr><th>코드</th><th>계정명</th><th className="text-right">차변</th><th className="text-right">대변</th><th className="text-right">건수</th></tr></thead>
                <tbody className="table-body">
                  {counterparts.map((c: any) => (
                    <tr key={c.account_code}>
                      <td className="text-gray-500 font-mono text-xs">{c.account_code}</td>
                      <td className="font-medium text-sm">{c.account_name}</td>
                      <td className="amount text-sm">{fmt(c.debit_total)}</td>
                      <td className="amount text-sm">{fmt(c.credit_total)}</td>
                      <td className="text-right text-gray-500 text-sm">{fmtNum(c.tx_count)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <Empty />}
        </div>
      </div>
    </div>
  )
}

// ============ 시산표 ============
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
    queryFn: () => financialApi.getAccountDetail(uploadId, selectedAccount!, detailPage, 30).then((r) => r.data),
    enabled: !!selectedAccount,
  })

  const items: any[] = trialData?.items || []

  const filtered = useMemo(() => {
    if (!search.trim()) return items
    const kw = search.toLowerCase()
    return items.filter((a: any) =>
      a.account_code.toLowerCase().includes(kw) || a.account_name.toLowerCase().includes(kw)
    )
  }, [items, search])

  const totals = useMemo(() =>
    filtered.reduce((acc: any, a: any) => ({
      debit: acc.debit + (a.debit_total || 0),
      credit: acc.credit + (a.credit_total || 0),
    }), { debit: 0, credit: 0 }),
  [filtered])

  if (isLoading) return <Loading />

  return (
    <div className="space-y-6">
      <div className="card">
        <div className="flex items-center gap-2">
          <MagnifyingGlassIcon className="h-5 w-5 text-gray-400" />
          <input type="text" placeholder="계정코드 또는 계정명 검색..." value={search}
            onChange={(e) => setSearch(e.target.value)} className="input flex-1" />
        </div>
      </div>

      <div className="card">
        <h3 className="text-sm font-semibold text-gray-700 mb-3">시산표 ({fmtNum(filtered.length)}개 계정)</h3>
        {filtered.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="table w-full">
              <thead className="table-header">
                <tr><th>계정코드</th><th>계정명</th><th className="text-right">차변합계</th><th className="text-right">대변합계</th><th className="text-right">잔액</th><th className="text-right">건수</th></tr>
              </thead>
              <tbody className="table-body">
                {filtered.map((a: any) => (
                  <tr key={a.account_code} className="cursor-pointer hover:bg-blue-50"
                    onClick={() => { setSelectedAccount(selectedAccount === a.account_code ? null : a.account_code); setDetailPage(1) }}>
                    <td className="text-gray-500 font-mono">{a.account_code}</td>
                    <td className="font-medium">{a.account_name}</td>
                    <td className="amount">{fmt(a.debit_total)}</td>
                    <td className="amount">{fmt(a.credit_total)}</td>
                    <td className={`amount font-bold ${a.balance >= 0 ? 'text-blue-600' : 'text-red-600'}`}>{fmt(a.balance)}</td>
                    <td className="text-right text-gray-500">{fmtNum(a.tx_count)}</td>
                  </tr>
                ))}
                <tr className="bg-gray-100 font-bold border-t-2 border-gray-300">
                  <td colSpan={2} className="text-right">합계</td>
                  <td className="amount">{fmt(totals.debit)}</td>
                  <td className="amount">{fmt(totals.credit)}</td>
                  <td className={`amount ${totals.debit - totals.credit >= 0 ? 'text-blue-600' : 'text-red-600'}`}>{fmt(totals.debit - totals.credit)}</td>
                  <td></td>
                </tr>
              </tbody>
            </table>
          </div>
        ) : <div className="text-center py-8 text-gray-400">데이터가 없습니다.</div>}
      </div>

      {selectedAccount && (
        <DetailModal
          accountCode={selectedAccount}
          accountName={items.find((a: any) => a.account_code === selectedAccount)?.account_name || ''}
          data={detailData}
          isLoading={detailLoading}
          page={detailPage}
          onPageChange={setDetailPage}
          onClose={() => setSelectedAccount(null)}
        />
      )}
    </div>
  )
}

// ============ Detail Modal ============
function DetailModal({ accountCode, accountName, data, isLoading, page, onPageChange, onClose }: {
  accountCode: string; accountName: string; data: any; isLoading: boolean
  page: number; onPageChange: (p: number) => void; onClose: () => void
}) {
  const items: any[] = data?.items || []
  const totalPages = data?.total_pages || 1
  const summary = data?.summary || {}

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl w-full max-w-5xl max-h-[80vh] flex flex-col mx-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between p-5 border-b">
          <div>
            <h3 className="text-lg font-bold">{accountCode} - {accountName}</h3>
            <p className="text-sm text-gray-500">
              차변: {fmt(summary.debit_total || 0)} | 대변: {fmt(summary.credit_total || 0)} | 잔액: {fmt(summary.balance || 0)}
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><XMarkIcon className="h-6 w-6" /></button>
        </div>
        <div className="flex-1 overflow-auto p-5">
          {isLoading ? <Loading /> : items.length > 0 ? (
            <table className="table w-full">
              <thead className="table-header"><tr><th>날짜</th><th>적요</th><th>거래처</th><th className="text-right">차변</th><th className="text-right">대변</th></tr></thead>
              <tbody className="table-body">
                {items.map((item: any, i: number) => (
                  <tr key={i}>
                    <td className="text-gray-500 text-sm">{item.transaction_date || '-'}</td>
                    <td className="font-medium text-sm">{item.description}</td>
                    <td className="text-gray-500 text-sm">{item.merchant_name || '-'}</td>
                    <td className="amount text-sm">{item.debit_amount ? fmt(item.debit_amount) : '-'}</td>
                    <td className="amount text-sm">{item.credit_amount ? fmt(item.credit_amount) : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <div className="text-center py-8 text-gray-400">거래 내역이 없습니다.</div>}
        </div>
        {totalPages > 1 && (
          <div className="flex items-center justify-center gap-3 p-4 border-t">
            <button onClick={() => onPageChange(page - 1)} disabled={page <= 1} className="btn-secondary text-sm disabled:opacity-50">이전</button>
            <span className="text-sm text-gray-600">{page} / {totalPages}</span>
            <button onClick={() => onPageChange(page + 1)} disabled={page >= totalPages} className="btn-secondary text-sm disabled:opacity-50">다음</button>
          </div>
        )}
      </div>
    </div>
  )
}

function Loading() {
  return (
    <div className="text-center py-8">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto" />
      <p className="text-gray-500 mt-2">로딩 중...</p>
    </div>
  )
}

function Empty() {
  return <div className="flex items-center justify-center h-full text-gray-400 text-sm">데이터가 없습니다.</div>
}
