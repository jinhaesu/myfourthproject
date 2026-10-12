import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { insuranceApi } from '@/services/api'

const won = (n: number) => Math.round(n || 0).toLocaleString('ko-KR')
const PENSION_OPTS = ['mandatory', 'excluded', 'reciprocity', 'optional']
const HEALTH_OPTS = ['mandatory', 'excluded']
const EMP_OPTS = ['mandatory', 'e9h2', 'optional', 'excluded']
const STATUS_KO: Record<string, string> = { mandatory: '당연', excluded: '제외', reciprocity: '상호주의', optional: '임의', e9h2: 'E9/H2' }

export default function InsurancePolicyPage() {
  const qc = useQueryClient()
  const policyQ = useQuery({ queryKey: ['insurance-policy'], queryFn: () => insuranceApi.policy().then((r: any) => r.data) })
  const [rates, setRates] = useState<any>(null)
  useEffect(() => { if (policyQ.data?.rates) setRates(policyQ.data.rates) }, [policyQ.data])

  const saveRates = useMutation({
    mutationFn: () => insuranceApi.putRates({ year: policyQ.data?.year, ...rates }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['insurance-policy'] }),
  })
  const saveVisa = useMutation({
    mutationFn: (rule: any) => insuranceApi.putVisaRule(rule),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['insurance-policy'] }),
  })

  const p = policyQ.data
  const visaRules: any[] = p?.visa_rules || []

  // 미리보기
  const [pv, setPv] = useState({ nationality: 'FOREIGN', visa: 'E-9', gross: 2500000, ltc_applied: false, ui_opt_in: false, country_excluded: false })
  const previewQ = useQuery({
    queryKey: ['insurance-preview', pv],
    queryFn: () => insuranceApi.preview(pv).then((r: any) => r.data),
    enabled: pv.gross > 0,
  })
  const pr = previewQ.data

  const rateFields: [string, string][] = [
    ['pension_emp', '국민연금(근로자)'], ['health_emp', '건강보험(근로자)'], ['ltc_on_health', '장기요양(건강료 대비)'],
    ['employment_ui_emp', '고용보험 실업급여(근로자)'], ['pension_base_min', '연금 기준소득 하한'], ['pension_base_max', '연금 기준소득 상한'],
  ]

  return (
    <div className="p-4 space-y-4">
      <div>
        <h1 className="text-lg font-bold">4대보험 기준 {p && <span className="text-2xs text-ink-400 font-normal">({p.year}년 · 회계팀 편집 가능)</span>}</h1>
        <p className="text-2xs text-ink-500 mt-1">대상=정규직(사무·현장). 알바(사업소득 3.3%)·파견(파견업체 부담)은 대상 아님. 요율·비자규칙을 바꾸면 급여 산정이 이 기준을 읽어 계산합니다.</p>
      </div>

      {/* 요율 */}
      <section className="border border-ink-100 dark:border-ink-800 rounded p-3">
        <div className="flex items-center justify-between mb-2"><h2 className="font-semibold text-sm">요율 (설정값 · 공단 확정 대상)</h2>
          <button onClick={() => saveRates.mutate()} disabled={!rates || saveRates.isPending} className="btn-primary text-2xs">요율 저장</button></div>
        {rates && (
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
            {rateFields.map(([k, lbl]) => (
              <label key={k} className="text-2xs flex flex-col gap-0.5">
                <span className="text-ink-500">{lbl}</span>
                <input type="number" step="any" value={rates[k]} onChange={(e) => setRates((s: any) => ({ ...s, [k]: Number(e.target.value) }))}
                  className="border border-ink-200 dark:border-ink-800 rounded px-2 py-1 bg-transparent font-mono" />
              </label>
            ))}
          </div>
        )}
      </section>

      {/* 비자 매트릭스 */}
      <section className="border border-ink-100 dark:border-ink-800 rounded">
        <h2 className="font-semibold text-sm px-3 py-2 border-b border-ink-100 dark:border-ink-800">체류자격(비자) 가입 매트릭스</h2>
        <div className="overflow-x-auto">
          <table className="min-w-full text-2xs">
            <thead className="text-ink-500"><tr>
              <th className="text-left px-2 py-1">체류자격</th><th className="text-left px-2 py-1">설명</th>
              <th className="text-left px-2 py-1">국민연금</th><th className="text-left px-2 py-1">건강</th>
              <th className="text-left px-2 py-1">고용</th><th className="text-left px-2 py-1">장기요양 제외신청가능</th><th></th>
            </tr></thead>
            <tbody>
              {visaRules.map((r) => <VisaRow key={r.visa_type} rule={r} onSave={(rule) => saveVisa.mutate(rule)} saving={saveVisa.isPending} />)}
            </tbody>
          </table>
        </div>
      </section>

      {/* 미리보기 */}
      <section className="border border-ink-100 dark:border-ink-800 rounded p-3">
        <h2 className="font-semibold text-sm mb-2">산정 미리보기 (근거 확인)</h2>
        <div className="flex items-center gap-2 flex-wrap text-2xs mb-2">
          <select value={pv.nationality} onChange={(e) => setPv((s) => ({ ...s, nationality: e.target.value }))} className="border border-ink-200 dark:border-ink-800 rounded px-1 py-1 bg-transparent">
            <option value="KR">내국인</option><option value="FOREIGN">외국인</option>
          </select>
          <input value={pv.visa} onChange={(e) => setPv((s) => ({ ...s, visa: e.target.value }))} placeholder="비자(E-9 등)" className="border border-ink-200 dark:border-ink-800 rounded px-2 py-1 bg-transparent w-24" />
          <input type="number" value={pv.gross} onChange={(e) => setPv((s) => ({ ...s, gross: Number(e.target.value) }))} className="border border-ink-200 dark:border-ink-800 rounded px-2 py-1 bg-transparent w-32 font-mono" />
          <label className="flex items-center gap-1"><input type="checkbox" checked={pv.ltc_applied} onChange={(e) => setPv((s) => ({ ...s, ltc_applied: e.target.checked }))} />장기요양 제외신청</label>
          <label className="flex items-center gap-1"><input type="checkbox" checked={pv.ui_opt_in} onChange={(e) => setPv((s) => ({ ...s, ui_opt_in: e.target.checked }))} />실업급여 임의가입</label>
          <label className="flex items-center gap-1"><input type="checkbox" checked={pv.country_excluded} onChange={(e) => setPv((s) => ({ ...s, country_excluded: e.target.checked }))} />국적 상호주의 제외국</label>
        </div>
        {pr && (
          <div className="space-y-1">
            <table className="text-2xs w-full max-w-2xl">
              <thead className="text-ink-500"><tr><th className="text-left px-2 py-1">보험</th><th className="text-left px-2 py-1">상태</th><th className="text-right px-2 py-1">근로자공제</th><th className="text-left px-2 py-1">근거</th></tr></thead>
              <tbody>
                {([['national_pension', '국민연금'], ['health_insurance', '건강보험'], ['long_term_care', '장기요양'], ['employment_insurance', '고용보험'], ['industrial_accident', '산재']] as [string, string][]).map(([k, lbl]) => (
                  <tr key={k} className="border-t border-ink-50 dark:border-ink-900">
                    <td className="px-2 py-1 font-medium">{lbl}</td>
                    <td className="px-2 py-1">{pr[k]?.status}</td>
                    <td className="px-2 py-1 text-right font-mono">{won(pr[k]?.employee_amount || 0)}</td>
                    <td className="px-2 py-1 text-ink-500">{pr[k]?.basis}</td>
                  </tr>
                ))}
                <tr className="border-t-2 border-ink-300 dark:border-ink-700 font-bold"><td className="px-2 py-1">근로자 공제 합계</td><td></td><td className="px-2 py-1 text-right font-mono">{won(pr.employee_total || 0)}</td><td></td></tr>
              </tbody>
            </table>
            {pr.flags?.length > 0 && <div className="text-2xs text-amber-600 dark:text-amber-400">⚠ {pr.flags.join(' · ')}</div>}
          </div>
        )}
      </section>

      {p?.sources && <p className="text-3xs text-ink-400">근거: {p.sources.join(' · ')}</p>}
    </div>
  )
}

function VisaRow({ rule, onSave, saving }: { rule: any; onSave: (r: any) => void; saving: boolean }) {
  const [r, setR] = useState(rule)
  useEffect(() => setR(rule), [rule])
  const dirty = JSON.stringify(r) !== JSON.stringify(rule)
  const sel = (field: string, opts: string[]) => (
    <select value={r[field]} onChange={(e) => setR((s: any) => ({ ...s, [field]: e.target.value }))}
      className="border border-ink-200 dark:border-ink-800 rounded px-1 py-0.5 bg-transparent">
      {opts.map((o) => <option key={o} value={o}>{STATUS_KO[o] || o}</option>)}
    </select>
  )
  return (
    <tr className="border-t border-ink-50 dark:border-ink-900">
      <td className="px-2 py-1 font-mono">{r.visa_type}</td>
      <td className="px-2 py-1 text-ink-500">{r.label}</td>
      <td className="px-2 py-1">{sel('pension', PENSION_OPTS)}</td>
      <td className="px-2 py-1">{sel('health', HEALTH_OPTS)}</td>
      <td className="px-2 py-1">{sel('employment', EMP_OPTS)}</td>
      <td className="px-2 py-1 text-center"><input type="checkbox" checked={!!r.ltc_exclusion_eligible} onChange={(e) => setR((s: any) => ({ ...s, ltc_exclusion_eligible: e.target.checked }))} /></td>
      <td className="px-2 py-1">{dirty && <button onClick={() => onSave(r)} disabled={saving} className="btn-secondary text-3xs">저장</button>}</td>
    </tr>
  )
}
