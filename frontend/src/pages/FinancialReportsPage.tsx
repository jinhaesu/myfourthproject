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
function fmtAmount(v: number) {
  return new Intl.NumberFormat('ko-KR').format(Math.abs(v))
}

type TabType = 'statements' | 'trend' | 'trial'
const MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]

export default function FinancialReportsPage() {
  const [activeTab, setActiveTab] = useState<TabType>('statements')
  const [selectedYear, setSelectedYear] = useState<number | null>(null)

  const { data: yearsData, isLoading: yearsLoading } = useQuery({
    queryKey: ['financialYears'],
    queryFn: () => financialApi.getAvailableYears().then((r) => r.data),
  })

  const years: number[] = yearsData?.years || []
  const uploads: any[] = yearsData?.uploads || []
  const totalRows = yearsData?.total_raw_rows || 0

  // 연도 자동 선택 (최신 연도)
  const activeYear = selectedYear ?? (years.length > 0 ? years[0] : null)

  const tabs: { id: TabType; label: string }[] = [
    { id: 'statements', label: '손익계산서 / 재무상태표' },
    { id: 'trend', label: '월별 추이' },
    { id: 'trial', label: '시산표' },
  ]

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">재무보고서</h1>
        <p className="text-gray-500 mt-1">업로드된 전체 데이터 기반 재무제표</p>
      </div>

      {/* 기간 선택 + 데이터 현황 */}
      <div className="card">
        <div className="flex items-center gap-4 flex-wrap">
          <label className="text-sm font-medium text-gray-700">연도 선택</label>
          {yearsLoading ? (
            <span className="text-sm text-gray-400">로딩 중...</span>
          ) : years.length === 0 ? (
            <span className="text-sm text-gray-400">데이터 없음 - AI 분류에서 먼저 데이터를 업로드하세요</span>
          ) : (
            <div className="flex gap-2">
              {years.map((y) => (
                <button
                  key={y}
                  onClick={() => setSelectedYear(y)}
                  className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                    activeYear === y
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                  }`}
                >
                  {y}년
                </button>
              ))}
            </div>
          )}
          {totalRows > 0 && (
            <span className="text-xs text-gray-400 ml-auto">
              총 {fmtNum(totalRows)}건 | {uploads.length}개 파일 반영
            </span>
          )}
        </div>
        {uploads.length > 0 && (
          <div className="mt-3 text-xs text-gray-400">
            반영된 파일: {uploads.slice(0, 5).map((u: any) => u.filename).join(', ')}
            {uploads.length > 5 && ` 외 ${uploads.length - 5}개`}
          </div>
        )}
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

      {!activeYear ? (
        <div className="card text-center py-12 text-gray-500">
          <p className="text-lg">데이터를 업로드하세요</p>
          <p className="text-sm mt-1">AI 분류 페이지에서 계정별 원장 파일을 업로드하면 여기에 자동 반영됩니다.</p>
        </div>
      ) : (
        <>
          {activeTab === 'statements' && <StatementsTab year={activeYear} />}
          {activeTab === 'trend' && <TrendTab year={activeYear} />}
          {activeTab === 'trial' && <TrialBalanceTab year={activeYear} />}
        </>
      )}
    </div>
  )
}

// ============================================================================
// Tab 1: 손익계산서 + 재무상태표
// ============================================================================
function StatementsTab({ year }: { year: number }) {
  const [month, setMonth] = useState<number | null>(null)

  const { data: incomeData, isLoading: incLoading } = useQuery({
    queryKey: ['financialIncome', year, month],
    queryFn: () => financialApi.getIncomeStatement(year, month ?? undefined).then((r) => r.data),
  })

  const { data: balanceData, isLoading: balLoading } = useQuery({
    queryKey: ['financialBalance', year],
    queryFn: () => financialApi.getBalanceSheet(year).then((r) => r.data),
  })

  if (incLoading || balLoading) return <Loading />

  const sections: any[] = incomeData?.sections || []
  const bsSections: any[] = balanceData?.sections || []

  return (
    <div className="space-y-8">
      <div className="card">
        <div className="flex items-center gap-3 flex-wrap">
          <label className="text-sm font-medium text-gray-700">월 필터</label>
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

      {/* 손익계산서 */}
      <div className="card">
        <div className="text-center border-b-2 border-gray-800 pb-3 mb-4">
          <h2 className="text-xl font-bold text-gray-900 tracking-widest">손 익 계 산 서</h2>
          <p className="text-sm text-gray-500 mt-1">
            {year}년 {month ? `${month}월 1일 ~ ${month}월 말일` : '1월 1일 ~ 12월 31일'}
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b-2 border-gray-800">
                <th className="text-left py-2 px-3 w-16">구분</th>
                <th className="text-left py-2 px-3">과  목</th>
                <th className="text-right py-2 px-3 w-40">금  액</th>
                <th className="text-right py-2 px-3 w-20">비율(%)</th>
              </tr>
            </thead>
            <tbody>
              {sections.map((section: any) => {
                const isSubtotal = section.is_subtotal
                const items: any[] = section.items || []
                return (
                  <SectionGroup key={section.id}>
                    {items.map((item: any, idx: number) => (
                      <tr key={`${section.id}-${idx}`} className="border-b border-gray-100 hover:bg-gray-50">
                        <td className="py-1.5 px-3"></td>
                        <td className="py-1.5 px-3 pl-12 text-gray-700">{item.name}</td>
                        <td className="py-1.5 px-3 text-right font-mono text-gray-700">
                          {item.amount < 0 ? `(${fmtAmount(item.amount)})` : fmtAmount(item.amount)}
                        </td>
                        <td className="py-1.5 px-3"></td>
                      </tr>
                    ))}
                    <tr className={`border-b ${isSubtotal ? 'border-gray-400 bg-gray-50' : 'border-gray-200'}`}>
                      <td className={`py-2 px-3 font-bold ${isSubtotal ? 'text-gray-900' : 'text-gray-700'}`}>{section.id}.</td>
                      <td className={`py-2 px-3 font-bold ${isSubtotal ? 'text-gray-900' : 'text-gray-700'}`}>{section.name}</td>
                      <td className={`py-2 px-3 text-right font-mono font-bold ${isSubtotal ? (section.total >= 0 ? 'text-gray-900' : 'text-red-600') : 'text-gray-800'}`}>
                        {section.total < 0 ? `(${fmtAmount(section.total)})` : fmtAmount(section.total)}
                      </td>
                      <td className="py-2 px-3 text-right font-mono text-gray-500">
                        {section.pct !== undefined ? section.pct.toFixed(2) : ''}
                      </td>
                    </tr>
                  </SectionGroup>
                )
              })}
            </tbody>
          </table>
        </div>
        {sections.length === 0 && <div className="text-center py-8 text-gray-400">해당 기간의 데이터가 없습니다.</div>}
      </div>

      <hr className="border-gray-300" />

      {/* 재무상태표 */}
      <div className="card">
        <div className="text-center border-b-2 border-gray-800 pb-3 mb-4">
          <h2 className="text-xl font-bold text-gray-900 tracking-widest">재 무 상 태 표</h2>
          <p className="text-sm text-gray-500 mt-1">{year}년 기준</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b-2 border-gray-800">
                <th className="text-left py-2 px-3">과  목</th>
                <th className="text-right py-2 px-3 w-44">금  액</th>
              </tr>
            </thead>
            <tbody>
              {bsSections.map((section: any) => (
                <SectionGroup key={section.id}>
                  <tr className="bg-gray-100 border-b border-gray-300">
                    <td colSpan={2} className="py-2 px-3 font-bold text-gray-900 text-base">{section.name}</td>
                  </tr>
                  {(section.subsections || []).map((sub: any, si: number) => (
                    <SectionGroup key={si}>
                      <tr className="border-b border-gray-200">
                        <td className="py-1.5 px-3 pl-6 font-semibold text-gray-800">{sub.name}</td>
                        <td className="py-1.5 px-3 text-right font-mono font-semibold text-gray-800">{fmtAmount(sub.total)}</td>
                      </tr>
                      {(sub.items || []).map((item: any, idx: number) => (
                        <tr key={idx} className="border-b border-gray-100 hover:bg-gray-50">
                          <td className="py-1 px-3 pl-12 text-gray-600">{item.name}</td>
                          <td className="py-1 px-3 text-right font-mono text-gray-600">
                            {item.amount < 0 ? `(${fmtAmount(item.amount)})` : fmtAmount(item.amount)}
                          </td>
                        </tr>
                      ))}
                    </SectionGroup>
                  ))}
                  <tr className="border-b-2 border-gray-400 bg-gray-50">
                    <td className="py-2 px-3 font-bold text-gray-900">{section.name} 총계</td>
                    <td className="py-2 px-3 text-right font-mono font-bold text-gray-900">{fmtAmount(section.total)}</td>
                  </tr>
                </SectionGroup>
              ))}
              {bsSections.length > 0 && (
                <tr className="border-t-2 border-gray-800 bg-blue-50">
                  <td className="py-2 px-3 font-bold text-blue-800">부채 및 자본 총계</td>
                  <td className="py-2 px-3 text-right font-mono font-bold text-blue-800">
                    {fmtAmount((balanceData?.total_liabilities ?? 0) + (balanceData?.total_equity ?? 0))}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {bsSections.length === 0 && <div className="text-center py-8 text-gray-400">데이터가 없습니다.</div>}
      </div>
    </div>
  )
}

function SectionGroup({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}

// ============================================================================
// Tab 2: 월별 추이
// ============================================================================
function TrendTab({ year }: { year: number }) {
  const { data: trend, isLoading } = useQuery({
    queryKey: ['financialTrend', year],
    queryFn: () => financialApi.getMonthlyTrend(year).then((r) => r.data),
  })

  if (isLoading) return <Loading />

  const trendData = (trend?.data || []).map((m: any) => ({
    month: m.month?.replace(/^\d{4}-0?/, '') + '월',
    차변: m.debit_total,
    대변: m.credit_total,
    순액: m.net,
    건수: m.tx_count,
  }))

  const totalDebit = trendData.reduce((s: number, m: any) => s + m.차변, 0)
  const totalCredit = trendData.reduce((s: number, m: any) => s + m.대변, 0)

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="card">
          <p className="text-sm text-gray-500">연간 총 차변</p>
          <p className="text-xl font-bold text-blue-600">{fmt(totalDebit)}</p>
        </div>
        <div className="card">
          <p className="text-sm text-gray-500">연간 총 대변</p>
          <p className="text-xl font-bold text-red-600">{fmt(totalCredit)}</p>
        </div>
        <div className="card">
          <p className="text-sm text-gray-500">연간 순액</p>
          <p className={`text-xl font-bold ${totalDebit - totalCredit >= 0 ? 'text-green-600' : 'text-red-600'}`}>
            {fmt(totalDebit - totalCredit)}
          </p>
        </div>
      </div>

      <div className="card">
        <h3 className="text-sm font-semibold text-gray-700 mb-4">월별 차변 / 대변</h3>
        <div className="h-80">
          {trendData.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={trendData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="month" fontSize={12} />
                <YAxis fontSize={11} tickFormatter={(v: number) => `${(v / 10000).toFixed(0)}만`} />
                <Tooltip formatter={(v: number) => fmt(v)} />
                <Legend />
                <Bar dataKey="차변" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                <Bar dataKey="대변" fill="#ef4444" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : <Empty />}
        </div>
      </div>

      <div className="card">
        <h3 className="text-sm font-semibold text-gray-700 mb-4">월별 순액 추이</h3>
        <div className="h-64">
          {trendData.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={trendData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="month" fontSize={12} />
                <YAxis fontSize={11} tickFormatter={(v: number) => `${(v / 10000).toFixed(0)}만`} />
                <Tooltip formatter={(v: number) => fmt(v)} />
                <Line type="monotone" dataKey="순액" stroke="#10b981" strokeWidth={2} dot={{ r: 4 }} />
              </LineChart>
            </ResponsiveContainer>
          ) : <Empty />}
        </div>
      </div>

      <div className="card">
        <h3 className="text-sm font-semibold text-gray-700 mb-3">월별 상세</h3>
        {trendData.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="table w-full text-sm">
              <thead className="table-header">
                <tr><th>월</th><th className="text-right">차변</th><th className="text-right">대변</th><th className="text-right">순액</th><th className="text-right">건수</th></tr>
              </thead>
              <tbody className="table-body">
                {trendData.map((m: any, i: number) => (
                  <tr key={i}>
                    <td className="font-medium">{m.month}</td>
                    <td className="amount text-blue-600">{fmt(m.차변)}</td>
                    <td className="amount text-red-600">{fmt(m.대변)}</td>
                    <td className={`amount font-bold ${m.순액 >= 0 ? 'text-green-600' : 'text-red-600'}`}>{fmt(m.순액)}</td>
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
function TrialBalanceTab({ year }: { year: number }) {
  const [search, setSearch] = useState('')
  const [selectedAccount, setSelectedAccount] = useState<string | null>(null)
  const [detailPage, setDetailPage] = useState(1)

  const { data: trialData, isLoading } = useQuery({
    queryKey: ['financialTrialBalance', year],
    queryFn: () => financialApi.getTrialBalance(year).then((r) => r.data),
  })

  const { data: detailData, isLoading: detailLoading } = useQuery({
    queryKey: ['financialAccountDetail', year, selectedAccount, detailPage],
    queryFn: () => financialApi.getAccountDetail(selectedAccount!, year, detailPage, 30).then((r) => r.data),
    enabled: !!selectedAccount,
  })

  const items: any[] = trialData?.items || []

  const filtered = useMemo(() => {
    if (!search.trim()) return items
    const kw = search.toLowerCase()
    return items.filter((a: any) =>
      a.account_code.toLowerCase().includes(kw) ||
      a.account_name.toLowerCase().includes(kw) ||
      (a.category_name || '').toLowerCase().includes(kw)
    )
  }, [items, search])

  const CATEGORY_COLORS: Record<string, string> = {
    '자산': 'bg-green-50 text-green-700',
    '부채': 'bg-orange-50 text-orange-700',
    '자본': 'bg-purple-50 text-purple-700',
    '수익': 'bg-blue-50 text-blue-700',
    '매출원가': 'bg-red-50 text-red-700',
    '판관비': 'bg-red-50 text-red-700',
    '비용': 'bg-red-50 text-red-700',
    '영업외': 'bg-yellow-50 text-yellow-700',
  }

  const grouped = useMemo(() => {
    const groups: Record<string, { name: string; items: any[] }> = {}
    for (const item of filtered) {
      const catName = item.category_name || '미분류'
      if (!groups[catName]) groups[catName] = { name: catName, items: [] }
      groups[catName].items.push(item)
    }
    const order = ['자산', '부채', '자본', '수익', '매출원가', '판관비', '비용', '영업외', '미분류']
    return Object.entries(groups).sort(([a], [b]) => {
      const ai = order.indexOf(a) === -1 ? 99 : order.indexOf(a)
      const bi = order.indexOf(b) === -1 ? 99 : order.indexOf(b)
      return ai - bi
    })
  }, [filtered])

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
          <input type="text" placeholder="계정코드, 계정명, 카테고리 검색..." value={search}
            onChange={(e) => setSearch(e.target.value)} className="input flex-1" />
        </div>
      </div>

      <div className="card">
        <h3 className="text-sm font-semibold text-gray-700 mb-3">시산표 ({fmtNum(filtered.length)}개 계정)</h3>
        {grouped.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="table w-full text-sm">
              <thead className="table-header">
                <tr>
                  <th>계정코드</th><th>계정명</th><th>카테고리</th>
                  <th className="text-right">차변합계</th><th className="text-right">대변합계</th>
                  <th className="text-right">잔액</th><th className="text-right">건수</th>
                </tr>
              </thead>
              <tbody className="table-body">
                {grouped.map(([catName, group]) => (
                  <SectionGroup key={catName}>
                    <tr className={CATEGORY_COLORS[catName] || 'bg-gray-50 text-gray-700'}>
                      <td colSpan={7} className="font-bold text-xs py-1">{group.name} ({group.items.length}개)</td>
                    </tr>
                    {group.items.map((a: any) => (
                      <tr key={a.account_code} className="cursor-pointer hover:bg-blue-50"
                        onClick={() => { setSelectedAccount(selectedAccount === a.account_code ? null : a.account_code); setDetailPage(1) }}>
                        <td className="text-gray-500 font-mono text-xs pl-6">{a.account_code}</td>
                        <td className="font-medium">{a.account_name}</td>
                        <td className="text-xs text-gray-400">{a.category_name || '미분류'}</td>
                        <td className="amount">{fmt(a.debit_total)}</td>
                        <td className="amount">{fmt(a.credit_total)}</td>
                        <td className={`amount font-bold ${a.balance >= 0 ? 'text-blue-600' : 'text-red-600'}`}>{fmt(a.balance)}</td>
                        <td className="text-right text-gray-500">{fmtNum(a.tx_count)}</td>
                      </tr>
                    ))}
                  </SectionGroup>
                ))}
                <tr className="bg-gray-100 font-bold border-t-2 border-gray-300">
                  <td colSpan={3} className="text-right">합계</td>
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
