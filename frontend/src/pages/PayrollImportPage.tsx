import { useState, Fragment } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  BanknotesIcon, BuildingOffice2Icon, Cog6ToothIcon,
  PencilSquareIcon, ArrowPathIcon, CheckIcon,
} from '@heroicons/react/24/outline'
import { XMarkIcon } from '@heroicons/react/24/outline'
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

  const [detailRec, setDetailRec] = useState<PayrollImportRecord | null>(null)
  const [deptFilter, setDeptFilter] = useState<string>('')
  const [typeFilter, setTypeFilter] = useState<string>('')
  const data = summaryQuery.data
  const allRecords = data?.records || []
  const cogsTotal = data?.by_cost_type.find((c) => c.cost_type === 'COGS')?.gross || 0
  const sgaTotal = data?.by_cost_type.find((c) => c.cost_type === 'SGA')?.gross || 0

  const deptOptions = Array.from(new Set(allRecords.map((r) => r.department))).sort()
  const typeOptions = Array.from(new Set(allRecords.map((r) => r.worker_type))).sort()
  const records = allRecords.filter((r) =>
    (!deptFilter || r.department === deptFilter) && (!typeFilter || r.worker_type === typeFilter)
  )
  const filteredDepts = (data?.by_department || []).filter((d) => !deptFilter || d.department === deptFilter)

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

          {/* 고용형태별 요약 */}
          {(data.by_worker_type || []).length > 0 && (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
              {data.by_worker_type.map((t) => (
                <div key={t.worker_type} className={`panel p-2.5 border-l-2 ${t.cost_type === 'COGS' ? 'border-l-orange-400' : 'border-l-blue-400'}`}>
                  <div className="text-2xs text-ink-500">{t.worker_type}</div>
                  <div className="text-sm font-bold text-ink-900">{formatCurrency(t.gross, false)}</div>
                  <div className="text-2xs text-ink-400">{t.count}명 · {t.cost_type === 'COGS' ? '원가' : '판관비'}</div>
                </div>
              ))}
            </div>
          )}

          {/* 필터 */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-2xs text-ink-500">필터:</span>
            <select value={deptFilter} onChange={(e) => setDeptFilter(e.target.value)}
              className="px-2 py-1 text-2xs rounded border border-ink-200 focus:border-blue-400 focus:outline-none">
              <option value="">전체 부서</option>
              {deptOptions.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
            <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}
              className="px-2 py-1 text-2xs rounded border border-ink-200 focus:border-blue-400 focus:outline-none">
              <option value="">전체 구분</option>
              {typeOptions.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            {(deptFilter || typeFilter) && (
              <button onClick={() => { setDeptFilter(''); setTypeFilter('') }}
                className="text-2xs text-ink-500 hover:text-ink-800 underline">필터 해제</button>
            )}
            <span className="text-2xs text-ink-400 ml-auto">
              {records.length}명 · 세전 {formatCurrency(records.reduce((s, r) => s + r.gross_pay, 0), false)}
            </span>
          </div>

          {/* 부서별 */}
          <div className="panel overflow-hidden">
            <div className="px-3 py-2 border-b border-ink-200 text-2xs font-semibold text-ink-500 uppercase flex items-center gap-1">
              <BuildingOffice2Icon className="h-3 w-3" />부서별 급여액{deptFilter ? ` · ${deptFilter}` : ''}
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
                  {filteredDepts.map((d) => (
                    <tr key={d.department}
                      onClick={() => setDeptFilter(deptFilter === d.department ? '' : d.department)}
                      className={`hover:bg-canvas-50 cursor-pointer ${deptFilter === d.department ? 'bg-blue-50/40' : ''}`}>
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
                          <td className="px-3 py-1.5 font-medium text-ink-900">
                            <button onClick={() => setDetailRec(r)} className="hover:text-blue-600 hover:underline">
                              {r.name}
                            </button>
                          </td>
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

      {detailRec && <PayrollDetailModal rec={detailRec} onClose={() => setDetailRec(null)} />}
    </div>
  )
}

function PayrollDetailModal({ rec, onClose }: { rec: PayrollImportRecord; onClose: () => void }) {
  const d = rec.detail
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 p-4" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="px-4 py-3 border-b border-ink-200 flex items-center justify-between sticky top-0 bg-white">
          <div>
            <div className="text-sm font-bold text-ink-900">{rec.name} <span className="text-2xs font-normal text-ink-500">{rec.worker_type} · {rec.department}{rec.position ? ` · ${rec.position}` : ''}</span></div>
          </div>
          <button onClick={onClose} className="text-ink-400 hover:text-ink-700"><XMarkIcon className="h-4 w-4" /></button>
        </div>
        <div className="p-4 space-y-3">
          {d?.note && <div className="text-2xs text-ink-500 bg-canvas-50 rounded p-2">{d.note}</div>}

          {d?.hours && d.hours.length > 0 && (
            <div>
              <div className="text-2xs font-semibold text-ink-600 mb-1">근무 시간 구성</div>
              <div className="space-y-0.5">
                {d.hours.map((h, i) => (
                  <div key={i} className="flex justify-between text-2xs">
                    <span className="text-ink-600">{h.label}</span>
                    <span className="font-mono text-ink-800">{h.amount.toLocaleString()}h</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div>
            <div className="text-2xs font-semibold text-emerald-700 mb-1">세전 급여 구성</div>
            <div className="space-y-0.5">
              {(d?.earnings || [{ label: '세전 급여', amount: rec.gross_pay }]).map((e, i) => (
                <div key={i} className="flex justify-between text-xs">
                  <span className="text-ink-600">{e.label}</span>
                  <span className="font-mono text-ink-800">{formatCurrency(e.amount, false)}</span>
                </div>
              ))}
              <div className="flex justify-between text-xs font-bold border-t border-ink-100 pt-1 mt-1">
                <span>세전 합계</span>
                <span className="font-mono">{formatCurrency(rec.gross_pay, false)}</span>
              </div>
              {rec.non_taxable ? (
                <div className="flex justify-between text-2xs text-ink-400">
                  <span>(비과세 포함)</span>
                  <span className="font-mono">{formatCurrency(rec.non_taxable, false)}</span>
                </div>
              ) : null}
            </div>
          </div>

          {(d?.deductions || []).length > 0 && (
            <div>
              <div className="text-2xs font-semibold text-rose-700 mb-1">공제 내역</div>
              <div className="space-y-0.5">
                {d!.deductions.map((e, i) => (
                  <div key={i} className="flex justify-between text-xs">
                    <span className="text-ink-600">{e.label}</span>
                    <span className="font-mono text-ink-800">-{formatCurrency(e.amount, false)}</span>
                  </div>
                ))}
                <div className="flex justify-between text-xs font-bold border-t border-ink-100 pt-1 mt-1">
                  <span>공제 합계</span>
                  <span className="font-mono text-rose-700">-{formatCurrency(rec.total_deduction, false)}</span>
                </div>
              </div>
            </div>
          )}

          <div className="flex justify-between text-sm font-bold bg-blue-50 rounded p-2">
            <span>실지급액</span>
            <span className="font-mono text-blue-700">{formatCurrency(rec.net_pay, false)}</span>
          </div>
        </div>
      </div>
    </div>
  )
}

const TAX_FIELDS: [string, string][] = [
  ['national_pension_rate', '국민연금 (%)'],
  ['health_insurance_rate', '건강보험 (%)'],
  ['long_term_care_rate', '장기요양 (건보의 %)'],
  ['employment_insurance_rate', '고용보험 (%)'],
  ['freelance_withholding_rate', '사업소득 원천징수 (%)'],
  ['local_tax_rate', '지방소득세 (소득세의 %)'],
]

function TaxSettingsPanel({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const [profiles, setProfiles] = useState<any[] | null>(null)

  useQuery({
    queryKey: ['payroll-tax-settings'],
    queryFn: () => payrollImportApi.getTaxSettings().then((r) => {
      setProfiles((r.data as any).profiles)
      return r.data
    }),
  })

  const saveMut = useMutation({
    mutationFn: (p: any) => payrollImportApi.updateTaxSettings({
      profile: p.profile,
      ...Object.fromEntries(TAX_FIELDS.map(([k]) => [k, Number(p[k])])),
    } as any),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['payroll-tax-settings'] }); toast.success('세율이 저장되었습니다') },
  })

  return (
    <div className="panel p-3">
      <div className="text-2xs font-semibold text-ink-600 mb-2">
        세금·보험 요율 설정 — 고용형태·직군별 (근로자 부담 기준)
      </div>
      {!profiles ? (
        <div className="text-2xs text-ink-400">불러오는 중…</div>
      ) : (
        <div className="space-y-2">
          {profiles.map((p, pi) => (
            <div key={p.profile} className="border border-ink-100 rounded-md p-2">
              <div className="text-2xs font-semibold text-ink-800 mb-1">{p.label}</div>
              <div className="grid grid-cols-2 lg:grid-cols-6 gap-1.5">
                {TAX_FIELDS.map(([k, label]) => (
                  <label key={k} className="text-2xs text-ink-500">
                    {label}
                    <input type="number" step="0.001" value={p[k] ?? ''}
                      onChange={(e) => {
                        const next = [...profiles]; next[pi] = { ...p, [k]: e.target.value }; setProfiles(next)
                      }}
                      className="w-full mt-0.5 px-1.5 py-0.5 text-2xs rounded border border-ink-300 font-mono" />
                  </label>
                ))}
              </div>
              <button onClick={() => saveMut.mutate(p)} disabled={saveMut.isPending}
                className="mt-1.5 px-2 py-0.5 text-2xs rounded bg-blue-600 text-white font-semibold hover:bg-blue-700">
                {p.label} 저장
              </button>
            </div>
          ))}
          <div className="flex items-center gap-2">
            <button onClick={onClose} className="px-2.5 py-1 text-2xs rounded border border-ink-200 text-ink-600">닫기</button>
            <span className="text-2xs text-ink-400">
              정규직·현장직 노무비는 소스 계산값을 사용하고, 이 요율은 검증·신규계산 참고용입니다. 파견은 세금 원천징수 없음(거래처 지급), 사업소득은 3.3% 우리가 신고.
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
