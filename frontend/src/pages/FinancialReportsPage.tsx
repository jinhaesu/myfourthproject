import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { financialApi } from '@/services/api'
import { MagnifyingGlassIcon, XMarkIcon } from '@heroicons/react/24/outline'
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Legend,
} from 'recharts'

function fmt(v: number) {
  return new Intl.NumberFormat('ko-KR', { style: 'currency', currency: 'KRW', maximumFractionDigits: 0 }).format(v)
}
function fmtNum(v: number) {
  return new Intl.NumberFormat('ko-KR').format(v)
}

type TabType = 'statements' | 'trend' | 'trial'
const MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]

export default function FinancialReportsPage() {
  const [activeTab, setActiveTab] = useState<TabType>('statements')
  const [selectedUploadId, setSelectedUploadId] = useState<number | null>(null)

  const { data: uploads, isLoading: uploadsLoading } = useQuery({
    queryKey: ['financialUploadHistory'],
    queryFn: () => financialApi.getUploadHistory().then((r) => r.data),
  })

  const uploadList = useMemo(() => {
    if (!uploads) return []
    return Array.isArray(uploads) ? uploads : []
  }, [uploads])

  const tabs: { id: TabType; label: string }[] = [
    { id: 'statements', label: '손익계산서 / 재무상태표' },
    { id: 'trend', label: '월별 추이' },
    { id: 'trial', label: '시산표' },
  ]

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">재무보고서</h1>
        <p className="text-gray-500 mt-1">계정별 원장 데이터 기반 재무제표</p>
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
          <p className="text-sm mt-1">AI 분류에서 업로드한 계정별 원장 파일을 선택해주세요.</p>
        </div>
      ) : (
        <>
          {activeTab === 'statements' && <StatementsTab uploadId={selectedUploadId} />}
          {activeTab === 'trend' && <TrendTab uploadId={selectedUploadId} />}
          {activeTab === 'trial' && <TrialBalanceTab uploadId={selectedUploadId} />}
        </>
      )}
    </div>
  )
}

// ============================================================================
// Tab 1: 손익계산서 + 재무상태표
// ============================================================================
function StatementsTab({ uploadId }: { uploadId: number }) {
  const currentYear = new Date().getFullYear()
  const [year, setYear] = useState(currentYear)
  const [month, setMonth] = useState<number | null>(null)

  // 손익 데이터
  const { data: incomeData, isLoading: incLoading } = useQuery({
    queryKey: ['financialIncome', uploadId, year, month],
    queryFn: () => financialApi.getIncomeStatement(uploadId, year, month ?? undefined).then((r) => r.data),
  })

  // 재무상태표 데이터 (전체 기간)
  const { data: balanceData, isLoading: balLoading } = useQuery({
    queryKey: ['financialBalance', uploadId],
    queryFn: () => financialApi.getBalanceSheet(uploadId).then((r) => r.data),
  })

  if (incLoading || balLoading) return <Loading />

  const inflows: any[] = incomeData?.inflows || []
  const outflows: any[] = incomeData?.outflows || []
  const totalIn = incomeData?.total_inflow ?? 0
  const totalOut = incomeData?.total_outflow ?? 0
  const netFlow = incomeData?.net_flow ?? 0

  const ledgerAccounts: any[] = balanceData?.accounts || []
  const counterparts: any[] = balanceData?.counterparts || []
  const netBalance = balanceData?.net_balance ?? 0

  return (
    <div className="space-y-8">
      {/* 기간 선택 */}
      <div className="card">
        <div className="flex items-center gap-3 flex-wrap">
          <label className="text-sm font-medium text-gray-700">연도</label>
          <select value={year} onChange={(e) => setYear(Number(e.target.value))} className="input w-28">
            {[currentYear - 2, currentYear - 1, currentYear, currentYear + 1].map((y) => (
              <option key={y} value={y}>{y}년</option>
            ))}
          </select>
          <label className="text-sm font-medium text-gray-700 ml-2">월</label>
          <div className="flex gap-1 flex-wrap">
            <button onClick={() => setMonth(null)}
              className={`px-3 py-1.5 text-xs rounded-lg font-medium transition-colors ${
                !month ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}>전체</button>
            {MONTHS.map((m) => (
              <button key={m} onClick={() => setMonth(m)}
                className={`px-3 py-1.5 text-xs rounded-lg font-medium transition-colors ${
                  month === m ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}>{m}월</button>
            ))}
          </div>
        </div>
      </div>

      {/* ==================== 손익계산서 ==================== */}
      <div>
        <h2 className="text-lg font-bold text-gray-900 mb-4">
          손익계산서
          <span className="text-sm font-normal text-gray-500 ml-2">
            {year}년 {month ? `${month}월` : '전체'}
          </span>
        </h2>

        {/* 손익 요약 카드 */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
          <div className="card bg-blue-50 border border-blue-200">
            <p className="text-sm text-blue-600 font-medium">수입 (입금)</p>
            <p className="text-2xl font-bold text-blue-700">{fmt(totalIn)}</p>
          </div>
          <div className="card bg-red-50 border border-red-200">
            <p className="text-sm text-red-600 font-medium">지출 (출금)</p>
            <p className="text-2xl font-bold text-red-700">{fmt(totalOut)}</p>
          </div>
          <div className={`card border ${netFlow >= 0 ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'}`}>
            <p className="text-sm font-medium text-gray-600">당기순이익</p>
            <p className={`text-2xl font-bold ${netFlow >= 0 ? 'text-green-700' : 'text-red-700'}`}>{fmt(netFlow)}</p>
          </div>
        </div>

        {/* 수입/지출 상세 테이블 */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* 수입 */}
          <div className="card">
            <h3 className="text-sm font-semibold text-blue-700 mb-3">수입 항목 (차변)</h3>
            {inflows.length > 0 ? (
              <div className="overflow-x-auto max-h-80 overflow-y-auto">
                <table className="table w-full text-sm">
                  <thead className="table-header sticky top-0">
                    <tr><th>계정</th><th>계정명</th><th className="text-right">금액</th></tr>
                  </thead>
                  <tbody className="table-body">
                    {inflows.map((i: any) => (
                      <tr key={i.account_code}>
                        <td className="text-gray-500 font-mono text-xs">{i.account_code}</td>
                        <td>{i.account_name}</td>
                        <td className="amount text-blue-600">{fmt(i.amount)}</td>
                      </tr>
                    ))}
                    <tr className="bg-blue-50 font-bold border-t-2">
                      <td colSpan={2} className="text-right">합계</td>
                      <td className="amount text-blue-700">{fmt(totalIn)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            ) : <div className="text-center py-4 text-gray-400 text-sm">데이터 없음</div>}
          </div>

          {/* 지출 */}
          <div className="card">
            <h3 className="text-sm font-semibold text-red-700 mb-3">지출 항목 (대변)</h3>
            {outflows.length > 0 ? (
              <div className="overflow-x-auto max-h-80 overflow-y-auto">
                <table className="table w-full text-sm">
                  <thead className="table-header sticky top-0">
                    <tr><th>계정</th><th>계정명</th><th className="text-right">금액</th></tr>
                  </thead>
                  <tbody className="table-body">
                    {outflows.map((o: any) => (
                      <tr key={o.account_code}>
                        <td className="text-gray-500 font-mono text-xs">{o.account_code}</td>
                        <td>{o.account_name}</td>
                        <td className="amount text-red-600">{fmt(o.amount)}</td>
                      </tr>
                    ))}
                    <tr className="bg-red-50 font-bold border-t-2">
                      <td colSpan={2} className="text-right">합계</td>
                      <td className="amount text-red-700">{fmt(totalOut)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            ) : <div className="text-center py-4 text-gray-400 text-sm">데이터 없음</div>}
          </div>
        </div>
      </div>

      <hr className="border-gray-200" />

      {/* ==================== 재무상태표 ==================== */}
      <div>
        <h2 className="text-lg font-bold text-gray-900 mb-4">재무상태표</h2>

        {/* 원장 계정 잔액 */}
        {ledgerAccounts.length > 0 && (
          <div className="card mb-4">
            <h3 className="text-sm font-semibold text-gray-700 mb-3">원장 계정 현황</h3>
            <div className="overflow-x-auto">
              <table className="table w-full text-sm">
                <thead className="table-header">
                  <tr><th>계정코드</th><th>계정명</th><th className="text-right">차변합계</th><th className="text-right">대변합계</th><th className="text-right">잔액</th><th className="text-right">건수</th></tr>
                </thead>
                <tbody className="table-body">
                  {ledgerAccounts.map((a: any) => (
                    <tr key={a.account_code}>
                      <td className="text-gray-500 font-mono">{a.account_code}</td>
                      <td className="font-medium">{a.account_name}</td>
                      <td className="amount">{fmt(a.debit_total)}</td>
                      <td className="amount">{fmt(a.credit_total)}</td>
                      <td className={`amount font-bold ${a.balance >= 0 ? 'text-blue-600' : 'text-red-600'}`}>{fmt(a.balance)}</td>
                      <td className="text-right text-gray-500">{fmtNum(a.tx_count)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-3 p-3 bg-blue-50 rounded-lg flex justify-between items-center">
              <span className="text-sm font-bold text-blue-700">총 잔액</span>
              <span className={`text-lg font-bold ${netBalance >= 0 ? 'text-blue-700' : 'text-red-700'}`}>{fmt(netBalance)}</span>
            </div>
          </div>
        )}

        {/* 상대 계정별 잔액 */}
        {counterparts.length > 0 && (
          <div className="card">
            <h3 className="text-sm font-semibold text-gray-700 mb-3">주요 상대 계정 현황</h3>
            <div className="overflow-x-auto max-h-80 overflow-y-auto">
              <table className="table w-full text-sm">
                <thead className="table-header sticky top-0">
                  <tr><th>코드</th><th>계정명</th><th className="text-right">차변</th><th className="text-right">대변</th><th className="text-right">잔액</th><th className="text-right">건수</th></tr>
                </thead>
                <tbody className="table-body">
                  {counterparts.map((c: any) => (
                    <tr key={c.account_code}>
                      <td className="text-gray-500 font-mono text-xs">{c.account_code}</td>
                      <td>{c.account_name}</td>
                      <td className="amount">{fmt(c.debit_total)}</td>
                      <td className="amount">{fmt(c.credit_total)}</td>
                      <td className={`amount font-bold ${c.balance >= 0 ? 'text-blue-600' : 'text-red-600'}`}>{fmt(c.balance)}</td>
                      <td className="text-right text-gray-500">{fmtNum(c.tx_count)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ============================================================================
// Tab 2: 월별 추이
// ============================================================================
function TrendTab({ uploadId }: { uploadId: number }) {
  const { data: trend, isLoading } = useQuery({
    queryKey: ['financialTrend', uploadId],
    queryFn: () => financialApi.getMonthlyTrend(uploadId).then((r) => r.data),
  })

  if (isLoading) return <Loading />

  const trendData = (trend?.data || []).map((m: any) => ({
    month: m.month?.replace(/^\d{4}-0?/, '') + '월',
    입금: m.debit_total,
    출금: m.credit_total,
    순이동: m.net,
    건수: m.tx_count,
  }))

  const totalDebit = trendData.reduce((s: number, m: any) => s + m.입금, 0)
  const totalCredit = trendData.reduce((s: number, m: any) => s + m.출금, 0)

  return (
    <div className="space-y-6">
      {/* 요약 카드 */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="card">
          <p className="text-sm text-gray-500">연간 총 입금</p>
          <p className="text-xl font-bold text-blue-600">{fmt(totalDebit)}</p>
        </div>
        <div className="card">
          <p className="text-sm text-gray-500">연간 총 출금</p>
          <p className="text-xl font-bold text-red-600">{fmt(totalCredit)}</p>
        </div>
        <div className="card">
          <p className="text-sm text-gray-500">연간 순이동</p>
          <p className={`text-xl font-bold ${totalDebit - totalCredit >= 0 ? 'text-green-600' : 'text-red-600'}`}>
            {fmt(totalDebit - totalCredit)}
          </p>
        </div>
      </div>

      {/* 막대 차트 */}
      <div className="card">
        <h3 className="text-sm font-semibold text-gray-700 mb-4">월별 입금 / 출금</h3>
        <div className="h-80">
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

      {/* 순이동 추이 라인 */}
      <div className="card">
        <h3 className="text-sm font-semibold text-gray-700 mb-4">월별 순이동 추이</h3>
        <div className="h-64">
          {trendData.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={trendData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="month" fontSize={12} />
                <YAxis fontSize={11} tickFormatter={(v: number) => `${(v / 10000).toFixed(0)}만`} />
                <Tooltip formatter={(v: number) => fmt(v)} />
                <Line type="monotone" dataKey="순이동" stroke="#10b981" strokeWidth={2} dot={{ r: 4 }} />
              </LineChart>
            </ResponsiveContainer>
          ) : <Empty />}
        </div>
      </div>

      {/* 월별 테이블 */}
      <div className="card">
        <h3 className="text-sm font-semibold text-gray-700 mb-3">월별 상세</h3>
        {trendData.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="table w-full text-sm">
              <thead className="table-header">
                <tr><th>월</th><th className="text-right">입금</th><th className="text-right">출금</th><th className="text-right">순이동</th><th className="text-right">건수</th></tr>
              </thead>
              <tbody className="table-body">
                {trendData.map((m: any, i: number) => (
                  <tr key={i}>
                    <td className="font-medium">{m.month}</td>
                    <td className="amount text-blue-600">{fmt(m.입금)}</td>
                    <td className="amount text-red-600">{fmt(m.출금)}</td>
                    <td className={`amount font-bold ${m.순이동 >= 0 ? 'text-green-600' : 'text-red-600'}`}>{fmt(m.순이동)}</td>
                    <td className="text-right text-gray-500">{fmtNum(m.건수)}</td>
                  </tr>
                ))}
                <tr className="bg-gray-100 font-bold border-t-2">
                  <td>합계</td>
                  <td className="amount text-blue-700">{fmt(totalDebit)}</td>
                  <td className="amount text-red-700">{fmt(totalCredit)}</td>
                  <td className={`amount ${totalDebit - totalCredit >= 0 ? 'text-green-700' : 'text-red-700'}`}>{fmt(totalDebit - totalCredit)}</td>
                  <td className="text-right text-gray-500">{fmtNum(trendData.reduce((s: number, m: any) => s + m.건수, 0))}</td>
                </tr>
              </tbody>
            </table>
          </div>
        ) : <Empty />}
      </div>
    </div>
  )
}

// ============================================================================
// Tab 3: 시산표
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
            <table className="table w-full text-sm">
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

// ============================================================================
// Detail Modal
// ============================================================================
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
            <table className="table w-full text-sm">
              <thead className="table-header"><tr><th>날짜</th><th>적요</th><th>거래처</th><th className="text-right">차변</th><th className="text-right">대변</th></tr></thead>
              <tbody className="table-body">
                {items.map((item: any, i: number) => (
                  <tr key={i}>
                    <td className="text-gray-500">{item.transaction_date || '-'}</td>
                    <td className="font-medium">{item.description}</td>
                    <td className="text-gray-500">{item.merchant_name || '-'}</td>
                    <td className="amount">{item.debit_amount ? fmt(item.debit_amount) : '-'}</td>
                    <td className="amount">{item.credit_amount ? fmt(item.credit_amount) : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <div className="text-center py-8 text-gray-400">거래 내역 없음</div>}
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
  return <div className="text-center py-8"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto" /><p className="text-gray-500 mt-2">로딩 중...</p></div>
}
function Empty() {
  return <div className="flex items-center justify-center h-full text-gray-400 text-sm">데이터가 없습니다.</div>
}
