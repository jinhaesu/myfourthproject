import { useState, Fragment } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  BanknotesIcon, BuildingOffice2Icon, Cog6ToothIcon,
  PencilSquareIcon, ArrowPathIcon, CheckIcon,
} from '@heroicons/react/24/outline'
import { payrollImportApi, PayrollImportRecord } from '@/services/api'
import { formatCurrency } from '@/utils/format'
import toast from 'react-hot-toast'

const COST_BADGE: Record<string, { label: string; cls: string }> = {
  COGS: { label: '원가(노무비)', cls: 'bg-orange-50 text-orange-700 border-orange-200' },
  SGA: { label: '판관비(급여)', cls: 'bg-blue-50 text-blue-700 border-blue-200' },
}

export default function PayrollImportPage() {
  const qc = useQueryClient()
  const [month, setMonth] = useState<string>('')
  const [showSettings, setShowSettings] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [ovrForm, setOvrForm] = useState<{ income_tax: string; local_tax: string; insurance: string; memo: string }>(
    { income_tax: '', local_tax: '', insurance: '', memo: '' })

  const summaryQuery = useQuery({
    queryKey: ['payroll-import', month],
    queryFn: () => payrollImportApi.summary(month || undefined).then((r) => r.data),
  })

  const overrideMut = useMutation({
    mutationFn: (rec: PayrollImportRecord) =>
      payrollImportApi.setOverride({
        month: data!.month,
        worker_name: rec.name,
        income_tax: ovrForm.income_tax !== '' ? Number(ovrForm.income_tax) : undefined,
        local_tax: ovrForm.local_tax !== '' ? Number(ovrForm.local_tax) : undefined,
        insurance: ovrForm.insurance !== '' ? Number(ovrForm.insurance) : undefined,
        memo: ovrForm.memo || undefined,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['payroll-import'] })
      setEditing(null)
      toast.success('세금 확정값이 반영되었습니다')
    },
    onError: (e: any) => toast.error(e.response?.data?.detail || '저장 실패'),
  })

  const data = summaryQuery.data
  const records = data?.records || []
  const cogsTotal = data?.by_cost_type.find((c) => c.cost_type === 'COGS')?.gross || 0
  const sgaTotal = data?.by_cost_type.find((c) => c.cost_type === 'SGA')?.gross || 0

  function startEdit(rec: PayrollImportRecord) {
    setEditing(rec.name)
    setOvrForm({
      income_tax: String(rec.income_tax || ''),
      local_tax: String(rec.local_tax || ''),
      insurance: String(rec.insurance || ''),
      memo: '',
    })
  }

  return (
    <div className="space-y-3">
      <div className="flex items-end justify-between flex-wrap gap-2">
        <div>
          <h1 className="flex items-center gap-2">
            <BanknotesIcon className="h-5 w-5 text-blue-500" />
            급여·노무비 통합
          </h1>
          <p className="text-xs text-ink-500 mt-1">
            매달 10일 급여일 기준 확정 급여를 HR(정규직·판관비)·노무시스템(사업소득/파견·원가)에서 자동 집계
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <input type="month" value={month} onChange={(e) => setMonth(e.target.value)}
            placeholder={data?.month}
            className="px-2 py-1.5 text-xs rounded-md border border-ink-200 focus:border-blue-400 focus:outline-none" />
          <button onClick={() => summaryQuery.refetch()}
            className="px-2 py-1.5 text-xs rounded-md border border-ink-200 text-ink-600 hover:bg-ink-50 flex items-center gap-1">
            <ArrowPathIcon className="h-3.5 w-3.5" />새로고침
          </button>
          <button onClick={() => setShowSettings(!showSettings)}
            className="px-2 py-1.5 text-xs rounded-md border border-ink-200 text-ink-600 hover:bg-ink-50 flex items-center gap-1">
            <Cog6ToothIcon className="h-3.5 w-3.5" />세율 설정
          </button>
        </div>
      </div>

      {showSettings && <TaxSettingsPanel onClose={() => setShowSettings(false)} />}

      {summaryQuery.isLoading ? (
        <div className="panel p-10 text-center text-2xs text-ink-400">확정 급여 집계 중… (외부 시스템 조회, 수십 초 걸릴 수 있어요)</div>
      ) : summaryQuery.isError ? (
        <div className="panel p-10 text-center text-2xs text-red-500">
          조회 실패: {(summaryQuery.error as any)?.response?.data?.detail || '네트워크 오류'}
        </div>
      ) : !data ? null : (
        <>
          <div className="text-2xs text-ink-500">
            <b className="text-ink-800">{data.month}</b> 확정 급여 · {data.payday} ·
            정규직(HR) {data.sources.hr_regular}명, 정규직노무 {data.sources.aisystem_regular}명,
            사업소득 {data.sources.aisystem_freelance}명, 파견 {data.sources.aisystem_dispatch}명
            {records.length === 0 && (
              <span className="text-amber-600"> — 데이터 없음(외부 시스템 미마감이거나 연동키 미설정일 수 있어요)</span>
            )}
          </div>

          {/* KPI */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
            <div className="panel p-3">
              <div className="text-2xs text-ink-500">총 지급액(세전)</div>
              <div className="text-lg font-bold text-ink-900">{formatCurrency(data.totals.gross, false)}</div>
            </div>
            <div className="panel p-3">
              <div className="text-2xs text-orange-600">원가(노무비)</div>
              <div className="text-lg font-bold text-orange-700">{formatCurrency(cogsTotal, false)}</div>
            </div>
            <div className="panel p-3">
              <div className="text-2xs text-blue-600">판관비(급여)</div>
              <div className="text-lg font-bold text-blue-700">{formatCurrency(sgaTotal, false)}</div>
            </div>
            <div className="panel p-3">
              <div className="text-2xs text-ink-500">공제 합계(세금+보험)</div>
              <div className="text-lg font-bold text-ink-900">{formatCurrency(data.totals.tax + data.totals.insurance, false)}</div>
            </div>
          </div>

          {/* 부서별 */}
          <div className="panel overflow-hidden">
            <div className="px-3 py-2 border-b border-ink-200 text-2xs font-semibold text-ink-500 uppercase flex items-center gap-1">
              <BuildingOffice2Icon className="h-3 w-3" />부서별 급여액
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-2xs text-ink-500 border-b border-ink-100">
                    <th className="text-left px-3 py-1.5">부서</th>
                    <th className="text-right px-3 py-1.5">인원</th>
                    <th className="text-right px-3 py-1.5">원가(노무비)</th>
                    <th className="text-right px-3 py-1.5">판관비(급여)</th>
                    <th className="text-right px-3 py-1.5">세전 합계</th>
                    <th className="text-right px-3 py-1.5">실지급</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-50">
                  {(data.by_department || []).map((d) => (
                    <tr key={d.department} className="hover:bg-canvas-50">
                      <td className="px-3 py-1.5 font-medium text-ink-900">{d.department}</td>
                      <td className="px-3 py-1.5 text-right text-ink-500">{d.count}</td>
                      <td className="px-3 py-1.5 text-right font-mono text-orange-700">{d.cogs > 0 ? formatCurrency(d.cogs, false) : '-'}</td>
                      <td className="px-3 py-1.5 text-right font-mono text-blue-700">{d.sga > 0 ? formatCurrency(d.sga, false) : '-'}</td>
                      <td className="px-3 py-1.5 text-right font-mono font-semibold text-ink-900">{formatCurrency(d.gross, false)}</td>
                      <td className="px-3 py-1.5 text-right font-mono text-ink-600">{formatCurrency(d.net, false)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* 전체 리스트 */}
          <div className="panel overflow-hidden">
            <div className="px-3 py-2 border-b border-ink-200 text-2xs font-semibold text-ink-500 uppercase">
              전체 급여 리스트 ({records.length}명) — 세금 확정값 입력 가능
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-2xs text-ink-500 border-b border-ink-100">
                    <th className="text-left px-3 py-1.5">이름</th>
                    <th className="text-left px-2 py-1.5">구분</th>
                    <th className="text-left px-2 py-1.5">부서</th>
                    <th className="text-right px-2 py-1.5">세전</th>
                    <th className="text-right px-2 py-1.5">소득세</th>
                    <th className="text-right px-2 py-1.5">지방세</th>
                    <th className="text-right px-2 py-1.5">보험</th>
                    <th className="text-right px-2 py-1.5">실지급</th>
                    <th className="px-2 py-1.5"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-50">
                  {records.map((r) => {
                    const badge = COST_BADGE[r.cost_type]
                    const isEditing = editing === r.name
                    return (
                      <Fragment key={r.name}>
                        <tr className="hover:bg-canvas-50">
                          <td className="px-3 py-1.5 font-medium text-ink-900">{r.name}</td>
                          <td className="px-2 py-1.5">
                            <span className={`text-2xs px-1.5 py-0.5 rounded-full border ${badge.cls}`}>{r.worker_type}</span>
                          </td>
                          <td className="px-2 py-1.5 text-ink-600">{r.department}</td>
                          <td className="px-2 py-1.5 text-right font-mono text-ink-900">{formatCurrency(r.gross_pay, false)}</td>
                          <td className="px-2 py-1.5 text-right font-mono text-ink-600">
                            {formatCurrency(r.income_tax, false)}
                            {r.tax_source === 'override' && <span className="text-emerald-600 ml-0.5" title="외부 확정값">✓</span>}
                          </td>
                          <td className="px-2 py-1.5 text-right font-mono text-ink-600">{formatCurrency(r.local_tax, false)}</td>
                          <td className="px-2 py-1.5 text-right font-mono text-ink-600">{r.insurance > 0 ? formatCurrency(r.insurance, false) : '-'}</td>
                          <td className="px-2 py-1.5 text-right font-mono font-semibold text-ink-900">{formatCurrency(r.net_pay, false)}</td>
                          <td className="px-2 py-1.5 text-right">
                            <button onClick={() => startEdit(r)} className="text-ink-400 hover:text-blue-600" title="세금 확정값 입력">
                              <PencilSquareIcon className="h-3.5 w-3.5" />
                            </button>
                          </td>
                        </tr>
                        {isEditing && (
                          <tr className="bg-canvas-50">
                            <td colSpan={9} className="px-3 py-2">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="text-2xs text-ink-500">외부 확정값 입력:</span>
                                {(['income_tax', 'local_tax', 'insurance'] as const).map((f) => (
                                  <label key={f} className="text-2xs text-ink-600 flex items-center gap-1">
                                    {f === 'income_tax' ? '소득세' : f === 'local_tax' ? '지방세' : '보험'}
                                    <input type="number" value={ovrForm[f]}
                                      onChange={(e) => setOvrForm({ ...ovrForm, [f]: e.target.value })}
                                      className="w-24 px-1.5 py-0.5 text-2xs rounded border border-ink-300 font-mono" />
                                  </label>
                                ))}
                                <input type="text" value={ovrForm.memo} placeholder="메모"
                                  onChange={(e) => setOvrForm({ ...ovrForm, memo: e.target.value })}
                                  className="flex-1 min-w-[120px] px-1.5 py-0.5 text-2xs rounded border border-ink-300" />
                                <button onClick={() => overrideMut.mutate(r)} disabled={overrideMut.isPending}
                                  className="px-2 py-1 text-2xs rounded bg-emerald-500 text-white font-semibold hover:bg-emerald-600">
                                  <CheckIcon className="h-3 w-3 inline" /> 저장
                                </button>
                                <button onClick={() => setEditing(null)}
                                  className="px-2 py-1 text-2xs rounded border border-ink-200 text-ink-600">취소</button>
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function TaxSettingsPanel({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const [form, setForm] = useState<Record<string, string> | null>(null)

  const q = useQuery({
    queryKey: ['payroll-tax-settings'],
    queryFn: () => payrollImportApi.getTaxSettings().then((r) => {
      const d = r.data as Record<string, number>
      setForm(Object.fromEntries(Object.entries(d).map(([k, v]) => [k, String(v)])))
      return d
    }),
  })

  const saveMut = useMutation({
    mutationFn: () => payrollImportApi.updateTaxSettings(
      Object.fromEntries(Object.entries(form!).map(([k, v]) => [k, Number(v)]))
    ),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['payroll-tax-settings'] }); toast.success('세율이 저장되었습니다'); onClose() },
  })

  const FIELDS: [string, string][] = [
    ['national_pension_rate', '국민연금 (%)'],
    ['health_insurance_rate', '건강보험 (%)'],
    ['long_term_care_rate', '장기요양 (건보의 %)'],
    ['employment_insurance_rate', '고용보험 (%)'],
    ['freelance_withholding_rate', '사업소득 원천징수 (%)'],
    ['local_tax_rate', '지방소득세 (소득세의 %)'],
  ]

  return (
    <div className="panel p-3">
      <div className="text-2xs font-semibold text-ink-600 mb-2">세금·보험 요율 설정 (근로자 부담 기준)</div>
      {q.isLoading || !form ? (
        <div className="text-2xs text-ink-400">불러오는 중…</div>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-2">
            {FIELDS.map(([k, label]) => (
              <label key={k} className="text-2xs text-ink-600">
                {label}
                <input type="number" step="0.001" value={form[k] ?? ''}
                  onChange={(e) => setForm({ ...form, [k]: e.target.value })}
                  className="w-full mt-0.5 px-2 py-1 text-xs rounded border border-ink-300 font-mono" />
              </label>
            ))}
          </div>
          <div className="flex items-center gap-1 mt-2">
            <button onClick={() => saveMut.mutate()} disabled={saveMut.isPending}
              className="px-2.5 py-1 text-2xs rounded bg-blue-600 text-white font-semibold hover:bg-blue-700">저장</button>
            <button onClick={onClose} className="px-2.5 py-1 text-2xs rounded border border-ink-200 text-ink-600">닫기</button>
            <span className="text-2xs text-ink-400 ml-2">
              참고: 정규직은 소스에서 이미 계산된 값을 사용하고, 이 요율은 신규 계산·검증 참고용입니다. 개별 확정값은 리스트에서 직접 입력하세요.
            </span>
          </div>
        </>
      )}
    </div>
  )
}
