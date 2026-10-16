import { useRef, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import * as XLSX from 'xlsx'
import { transferApprovalApi as api, type PayableItem, type TransferBatch, type TransferBatchItem } from '@/services/api'

const won = (n: number) => Math.round(n || 0).toLocaleString('ko-KR')
const XUN_LABEL: Record<number, string> = { 10: '10일', 20: '20일', 30: '30일' }
const DISPO: Record<string, string> = { pay: '이체할 곳', defer: '미룬 곳', scheduled: '이체 예정' }
const DISPO_COLOR: Record<string, string> = { pay: 'text-emerald-600', defer: 'text-rose-600', scheduled: 'text-amber-600' }
const PRIO: Record<number, string> = { 1: '높음', 2: '보통', 3: '낮음' }
const now = new Date()

export default function TransferApprovalPage() {
  const [mode, setMode] = useState<'compose' | 'approve' | 'history'>('approve')
  const [year, setYear] = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth() + 1)

  return (
    <div className="p-4 space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <h1 className="text-lg font-bold">이체 승인</h1>
        <div className="flex rounded overflow-hidden border border-ink-200 dark:border-ink-800 text-2xs">
          <button onClick={() => setMode('approve')} className={`px-3 py-1 ${mode === 'approve' ? 'bg-brand-600 text-white' : 'bg-transparent'}`}>대표 결재</button>
          <button onClick={() => setMode('compose')} className={`px-3 py-1 border-l border-ink-200 dark:border-ink-800 ${mode === 'compose' ? 'bg-brand-600 text-white' : 'bg-transparent'}`}>회계팀 작성</button>
          <button onClick={() => setMode('history')} className={`px-3 py-1 border-l border-ink-200 dark:border-ink-800 ${mode === 'history' ? 'bg-brand-600 text-white' : 'bg-transparent'}`}>이체·내역</button>
        </div>
        <select value={year} onChange={(e) => setYear(Number(e.target.value))} className="border border-ink-200 dark:border-ink-800 rounded px-2 py-1 text-sm bg-transparent">
          {[now.getFullYear() + 1, now.getFullYear(), now.getFullYear() - 1].map((y) => <option key={y} value={y}>{y}년</option>)}
        </select>
        <select value={month} onChange={(e) => setMonth(Number(e.target.value))} className="border border-ink-200 dark:border-ink-800 rounded px-2 py-1 text-sm bg-transparent">
          {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => <option key={m} value={m}>{m}월</option>)}
        </select>
      </div>
      {mode === 'compose' ? <ComposeMode year={year} month={month} />
        : mode === 'history' ? <HistoryMode year={year} month={month} />
          : <ApproveMode year={year} month={month} />}
    </div>
  )
}

/* ───────────── 이체·내역 모드 (회계팀 이체완료 처리 + 완료 내역) ───────────── */
function HistoryMode({ year, month }: { year: number; month: number }) {
  const qc = useQueryClient()
  const [openId, setOpenId] = useState<number | null>(null)
  const histQ = useQuery({ queryKey: ['tb-hist', year, month], queryFn: () => api.history(year, month).then((r) => r.data.items) })
  const compQ = useQuery({ queryKey: ['tb-comp', year, month], queryFn: () => api.completed(year, month).then((r) => r.data.items) })
  const batchQ = useQuery({ queryKey: ['tb-hist-one', openId], queryFn: () => api.getBatch(openId!).then((r) => r.data), enabled: !!openId })
  const bust = () => { qc.invalidateQueries({ queryKey: ['tb-hist-one', openId] }); qc.invalidateQueries({ queryKey: ['tb-hist', year, month] }); qc.invalidateQueries({ queryKey: ['tb-comp', year, month] }) }
  const paidMut = useMutation({ mutationFn: (id: number) => api.markItemPaid(id, true), onSuccess: bust })
  const payAllMut = useMutation({ mutationFn: () => api.payAllBatch(openId!), onSuccess: bust })

  if (openId && batchQ.data) {
    const items = batchQ.data.items.filter((i) => i.ceo_action === 'approved')
    const unpaid = items.filter((i) => !i.paid)
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <button onClick={() => setOpenId(null)} className="btn-secondary text-2xs">← 목록</button>
          <h2 className="font-bold text-sm">{batchQ.data.batch.title} · 승인분 이체 처리</h2>
          {unpaid.length > 0 && <button onClick={() => { if (confirm(`승인된 미이체 ${unpaid.length}건을 일괄 이체완료 처리할까요?`)) payAllMut.mutate() }} className="btn-primary text-2xs ml-auto">승인분 일괄 이체완료</button>}
        </div>
        <div className="border border-ink-100 dark:border-ink-800 rounded overflow-x-auto">
          <table className="min-w-full text-2xs">
            <thead className="text-ink-500"><tr><th className="text-left px-2 py-1">거래처</th><th className="text-right px-2 py-1">금액</th><th className="text-left px-2 py-1">계좌은행</th><th className="text-left px-2 py-1">계정과목</th><th className="px-2 py-1">상태</th></tr></thead>
            <tbody>
              {items.map((it) => (
                <tr key={it.id} className="border-t border-ink-50 dark:border-ink-900">
                  <td className="px-2 py-1 max-w-[180px] truncate" title={it.vendor}>{it.vendor}</td>
                  <td className="px-2 py-1 text-right font-mono">{won(it.amount)}</td>
                  <td className="px-2 py-1">{it.bank_name || '-'}</td>
                  <td className="px-2 py-1">{it.account_name || '-'}</td>
                  <td className="px-2 py-1 text-center">
                    {it.paid
                      ? <span className="text-emerald-600 dark:text-emerald-400">✓ 이체완료{it.paid_at ? ` (${String(it.paid_at).slice(5, 10)})` : ''}</span>
                      : <button onClick={() => paidMut.mutate(it.id)} disabled={paidMut.isPending} className="btn-secondary text-3xs">이체완료 처리</button>}
                  </td>
                </tr>
              ))}
              {items.length === 0 && <tr><td colSpan={5} className="px-2 py-3 text-center text-ink-400">대표 승인된 항목이 없습니다.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div>
        <div className="text-2xs font-semibold text-ink-500 dark:text-ink-400 uppercase mb-1">배치 내역 ({month}월)</div>
        {(histQ.data || []).length === 0 && <div className="text-sm text-ink-400">제출된 배치가 없습니다.</div>}
        <div className="space-y-1">
          {(histQ.data || []).map((b) => (
            <button key={b.id} onClick={() => setOpenId(b.id)} className="w-full text-left border border-ink-100 dark:border-ink-800 rounded px-3 py-2 hover:bg-canvas-50 dark:hover:bg-ink-950 flex items-center justify-between">
              <span className="text-sm font-medium">{b.title} <span className="text-2xs text-ink-400">[{b.status === 'reviewed' ? '검토완료' : '결재대기'}]</span></span>
              <span className="text-2xs text-ink-500">{b.item_count ?? 0}건 · 승인 {b.approved_count} · 이체완료 {b.paid_count} · 반려 {b.rejected_count} · <span className="font-mono">{won(b.total_amount ?? 0)}</span></span>
            </button>
          ))}
        </div>
      </div>
      <div>
        <div className="text-2xs font-semibold text-ink-500 dark:text-ink-400 uppercase mb-1">이체완료 내역 ({month}월 · {(compQ.data || []).length}건)</div>
        <div className="border border-ink-100 dark:border-ink-800 rounded overflow-x-auto">
          <table className="min-w-full text-2xs">
            <thead className="text-ink-500"><tr><th className="text-left px-2 py-1">이체일</th><th className="text-left px-2 py-1">거래처</th><th className="text-right px-2 py-1">금액</th><th className="text-left px-2 py-1">계정과목</th><th className="text-left px-2 py-1">배치</th></tr></thead>
            <tbody>
              {(compQ.data || []).map((c) => (
                <tr key={c.id} className="border-t border-ink-50 dark:border-ink-900">
                  <td className="px-2 py-1 whitespace-nowrap">{c.paid_at ? String(c.paid_at).slice(0, 10) : '-'}</td>
                  <td className="px-2 py-1 max-w-[180px] truncate" title={c.vendor}>{c.vendor}</td>
                  <td className="px-2 py-1 text-right font-mono">{won(c.amount)}</td>
                  <td className="px-2 py-1">{c.account_name || '-'}</td>
                  <td className="px-2 py-1 text-ink-400">{c.batch_title}</td>
                </tr>
              ))}
              {(compQ.data || []).length === 0 && <tr><td colSpan={5} className="px-2 py-3 text-center text-ink-400">이체완료 내역이 없습니다.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

/* ───────────── 회계팀 작성 모드 ───────────── */
function ComposeMode({ year, month }: { year: number; month: number }) {
  const qc = useQueryClient()
  const fileRef = useRef<HTMLInputElement>(null)
  const [xun, setXun] = useState(10)
  const [batchId, setBatchId] = useState<number | null>(null)
  const [sel, setSel] = useState<Set<number>>(new Set())
  const [msg, setMsg] = useState('')

  const batchesQ = useQuery({ queryKey: ['tb', year, month], queryFn: () => api.batches(year, month).then((r) => r.data.items) })
  const poolQ = useQuery({ queryKey: ['tb-pool', year, month], queryFn: () => api.payables(year, month).then((r) => r.data.items) })
  const batchQ = useQuery({ queryKey: ['tb-one', batchId], queryFn: () => api.getBatch(batchId!).then((r) => r.data), enabled: !!batchId })

  const bust = () => { qc.invalidateQueries({ queryKey: ['tb-one', batchId] }); qc.invalidateQueries({ queryKey: ['tb', year, month] }) }
  const createMut = useMutation({ mutationFn: () => api.createBatch(year, month, xun).then((r) => r.data.batch_id), onSuccess: (id) => { setBatchId(id); qc.invalidateQueries({ queryKey: ['tb', year, month] }) } })
  const syncMut = useMutation({ mutationFn: () => api.syncScm().then((r) => r.data), onSuccess: (d) => { setMsg(d.ok ? `SCM: 신규 ${d.new}·갱신 ${d.updated}` : `SCM 실패: ${d.error}`); qc.invalidateQueries({ queryKey: ['tb-pool', year, month] }) } })
  const importMut = useMutation({ mutationFn: (rows: any[]) => api.importRows(rows).then((r) => r.data), onSuccess: (d) => { setMsg(`엑셀: 신규 ${d.new}·갱신 ${d.updated}·중복 ${d.skipped}`); qc.invalidateQueries({ queryKey: ['tb-pool', year, month] }) } })
  const addMut = useMutation({ mutationFn: () => api.addToBatch(batchId!, Array.from(sel)), onSuccess: () => { setSel(new Set()); bust() } })
  const updMut = useMutation({ mutationFn: (v: { id: number; patch: any }) => api.updateItem(v.id, v.patch), onSuccess: bust })
  const delMut = useMutation({ mutationFn: (id: number) => api.deleteItem(id), onSuccess: bust })
  const submitMut = useMutation({ mutationFn: () => api.submitBatch(batchId!), onSuccess: () => { setMsg('대표께 제출되었습니다'); bust() } })
  const [manual, setManual] = useState({ vendor: '', amount: '', due_date: '', bank_name: '', account_name: '' })
  const addItemMut = useMutation({
    mutationFn: () => api.addItems(batchId!, [{ vendor: manual.vendor.trim(), amount: Number(manual.amount) || 0, due_date: manual.due_date || undefined, bank_name: manual.bank_name || undefined, account_name: manual.account_name || undefined }]),
    onSuccess: () => { setManual({ vendor: '', amount: '', due_date: '', bank_name: '', account_name: '' }); bust() },
  })
  const downloadTemplate = () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ['거래처명', '채무기준일', '채무금액', '이체예정일', '계좌은행', '계정과목', '담당자'],
      ['(주)예시거래처', '2026-10-01', 1000000, '2026-10-10', '기업은행', '원재료', '홍길동'],
    ])
    ws['!cols'] = [{ wch: 22 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 10 }]
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, '이체리스트')
    XLSX.writeFile(wb, '이체리스트_업로드양식.xlsx')
  }

  const onFile = async (f: File) => {
    const wb = XLSX.read(await f.arrayBuffer()); const ws = wb.Sheets[wb.SheetNames[0]]
    const raw = XLSX.utils.sheet_to_json<any>(ws, { defval: '' })
    const pick = (o: any, ks: string[]) => { for (const k of Object.keys(o)) if (ks.some((x) => k.replace(/\s/g, '').includes(x))) return o[k]; return '' }
    const rows = raw.map((o) => ({
      vendor: String(pick(o, ['거래처', 'vendor']) || '').trim(),
      amount: Number(String(pick(o, ['채무금액', '금액', 'amount'])).replace(/[^0-9.-]/g, '')) || 0,
      debt_date: String(pick(o, ['채무기준일', '채무일']) || '').slice(0, 10) || undefined,
      due_date: String(pick(o, ['이체예정일', '이체일']) || '').slice(0, 10) || undefined,
      bank_name: String(pick(o, ['계좌은행', '은행']) || '').trim() || undefined,
      account_name: String(pick(o, ['계정과목', '계정']) || '').trim() || undefined,
      manager: String(pick(o, ['담당자']) || '').trim() || undefined,
    })).filter((r) => r.vendor && r.amount)
    if (rows.length) importMut.mutate(rows); else setMsg('유효 행 없음')
  }

  const batch = batchQ.data?.batch
  const items = batchQ.data?.items || []
  const pool = (poolQ.data || []).filter((p) => p.status !== 'paid' && p.remaining > 0)
  const inBatch = new Set(items.map((i) => i.payable_id).filter(Boolean))

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap text-2xs">
        <span>旬</span>
        <select value={xun} onChange={(e) => setXun(Number(e.target.value))} className="border border-ink-200 dark:border-ink-800 rounded px-1 py-1 bg-transparent">{[10, 20, 30].map((x) => <option key={x} value={x}>{XUN_LABEL[x]}</option>)}</select>
        <select value={batchId ?? ''} onChange={(e) => setBatchId(e.target.value ? Number(e.target.value) : null)} className="border border-ink-200 dark:border-ink-800 rounded px-1 py-1 bg-transparent">
          <option value="">배치 선택…</option>
          {(batchesQ.data || []).map((b) => <option key={b.id} value={b.id}>{b.title} [{b.status}] ({b.item_count ?? 0}건)</option>)}
        </select>
        <button onClick={() => createMut.mutate()} className="btn-secondary">+ {month}월 {XUN_LABEL[xun]} 배치 생성</button>
        {msg && <span className="text-brand-600">{msg}</span>}
      </div>

      {!batchId && <div className="text-sm text-ink-400">배치를 선택하거나 생성하세요. 생성 후 아래 풀에서 매입채무를 선택해 담습니다.</div>}

      {batchId && batch && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {/* 매입채무 풀 */}
          <div className="border border-ink-100 dark:border-ink-800 rounded">
            <div className="flex items-center justify-between px-2 py-1.5 border-b border-ink-100 dark:border-ink-800 bg-canvas-50 dark:bg-ink-950">
              <span className="text-2xs font-semibold">매입채무 풀 ({pool.length})</span>
              <div className="flex gap-1">
                <button onClick={() => syncMut.mutate()} disabled={syncMut.isPending} className="btn-secondary text-3xs">SCM 동기화</button>
                <button onClick={downloadTemplate} className="btn-secondary text-3xs" title="엑셀 업로드 양식 다운로드">양식 ↓</button>
                <input ref={fileRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.currentTarget.value = '' }} />
                <button onClick={() => fileRef.current?.click()} className="btn-secondary text-3xs">엑셀 업로드</button>
                <button onClick={() => addMut.mutate()} disabled={sel.size === 0} className="btn-primary text-3xs">선택 {sel.size}건 담기</button>
              </div>
            </div>
            <div className="max-h-[60vh] overflow-y-auto">
              <table className="min-w-full text-2xs">
                <thead className="text-ink-500 sticky top-0 bg-white dark:bg-ink-950">
                  <tr>
                    <th className="w-5"></th>
                    <th className="text-left px-1 py-1">거래처</th>
                    <th className="text-left px-1 py-1">이체예정일</th>
                    <th className="text-right px-1 py-1">잔여채무</th>
                    <th className="text-left px-1 py-1">출처</th>
                  </tr>
                </thead>
                <tbody>
                  {pool.map((p: PayableItem) => (
                    <tr key={p.id} className={`border-t border-ink-50 dark:border-ink-900 ${inBatch.has(p.id) ? 'opacity-40' : ''}`}>
                      <td className="px-1"><input type="checkbox" disabled={inBatch.has(p.id)} checked={sel.has(p.id)} onChange={() => setSel((s) => { const n = new Set(s); n.has(p.id) ? n.delete(p.id) : n.add(p.id); return n })} /></td>
                      <td className="px-1 py-1 max-w-[140px] truncate" title={p.vendor}>{p.vendor}</td>
                      <td className="px-1 py-1">{p.due_date || '-'}</td>
                      <td className="px-1 py-1 text-right font-mono">{won(p.remaining)}</td>
                      <td className="px-1 py-1 text-3xs text-ink-400">{p.source}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* 작성 중 배치 */}
          <div className="border border-ink-100 dark:border-ink-800 rounded">
            <div className="flex items-center justify-between px-2 py-1.5 border-b border-ink-100 dark:border-ink-800 bg-canvas-50 dark:bg-ink-950">
              <span className="text-2xs font-semibold">{batch.title} · {items.length}건 · <span className="font-mono">{won(items.reduce((s, i) => s + i.amount, 0))}</span></span>
              {batch.status === 'draft'
                ? <button onClick={() => { if (confirm('대표께 제출할까요? 제출 후 결재 대기됩니다.')) submitMut.mutate() }} disabled={items.length === 0} className="btn-primary text-3xs">대표께 제출</button>
                : <span className="text-3xs px-2 py-0.5 rounded bg-sky-100 dark:bg-sky-950/40 text-sky-700 dark:text-sky-300">{batch.status === 'submitted' ? '제출됨(결재대기)' : '검토완료'}</span>}
            </div>
            {batch.status === 'draft' && (
              <div className="flex items-center gap-1 px-2 py-1.5 border-b border-ink-100 dark:border-ink-800 flex-wrap text-2xs bg-canvas-50/50 dark:bg-ink-950/50">
                <span className="text-ink-400">직접추가</span>
                <input placeholder="거래처" value={manual.vendor} onChange={(e) => setManual({ ...manual, vendor: e.target.value })} className="border border-ink-200 dark:border-ink-800 rounded px-1 py-0.5 bg-transparent w-24" />
                <input placeholder="금액" inputMode="numeric" value={manual.amount} onChange={(e) => setManual({ ...manual, amount: e.target.value.replace(/[^0-9]/g, '') })} className="border border-ink-200 dark:border-ink-800 rounded px-1 py-0.5 bg-transparent w-20 font-mono" />
                <input type="date" value={manual.due_date} onChange={(e) => setManual({ ...manual, due_date: e.target.value })} className="border border-ink-200 dark:border-ink-800 rounded px-1 py-0.5 bg-transparent" />
                <input placeholder="은행" value={manual.bank_name} onChange={(e) => setManual({ ...manual, bank_name: e.target.value })} className="border border-ink-200 dark:border-ink-800 rounded px-1 py-0.5 bg-transparent w-16" />
                <input placeholder="계정과목" value={manual.account_name} onChange={(e) => setManual({ ...manual, account_name: e.target.value })} className="border border-ink-200 dark:border-ink-800 rounded px-1 py-0.5 bg-transparent w-20" />
                <button onClick={() => { if (manual.vendor && manual.amount) addItemMut.mutate() }} disabled={!manual.vendor || !manual.amount || addItemMut.isPending} className="btn-primary text-3xs">+ 추가</button>
              </div>
            )}
            <div className="max-h-[60vh] overflow-y-auto">
              <table className="min-w-full text-2xs">
                <thead className="text-ink-500 sticky top-0 bg-white dark:bg-ink-950"><tr>
                  <th className="px-1 py-1 text-left">거래처</th><th className="px-1 py-1 text-right">금액</th>
                  <th className="px-1 py-1">분류</th><th className="px-1 py-1">우선</th><th className="px-1 py-1 text-left">부서요청/메모</th><th></th>
                </tr></thead>
                <tbody>
                  {items.map((it) => (
                    <tr key={it.id} className="border-t border-ink-50 dark:border-ink-900">
                      <td className="px-1 py-1 max-w-[120px] truncate" title={it.vendor}>{it.vendor}</td>
                      <td className="px-1 py-1 text-right font-mono">{won(it.amount)}</td>
                      <td className="px-1 py-1">
                        <select defaultValue={it.disposition} onChange={(e) => updMut.mutate({ id: it.id, patch: { disposition: e.target.value } })} className="border border-ink-200 dark:border-ink-800 rounded px-0.5 py-0.5 bg-transparent">
                          {Object.entries(DISPO).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                        </select>
                      </td>
                      <td className="px-1 py-1">
                        <select defaultValue={it.priority} onChange={(e) => updMut.mutate({ id: it.id, patch: { priority: Number(e.target.value) } })} className="border border-ink-200 dark:border-ink-800 rounded px-0.5 py-0.5 bg-transparent">
                          {Object.entries(PRIO).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                        </select>
                      </td>
                      <td className="px-1 py-1">
                        <input defaultValue={it.dept_request || ''} placeholder="부서요청/사유" onBlur={(e) => { if (e.target.value !== (it.dept_request || '')) updMut.mutate({ id: it.id, patch: { dept_request: e.target.value } }) }} className="border border-ink-200 dark:border-ink-800 rounded px-1 py-0.5 bg-transparent w-36" />
                      </td>
                      <td className="px-1 py-1"><button onClick={() => delMut.mutate(it.id)} className="text-rose-500">×</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/* ───────────── 대표 결재 모드 ───────────── */
function ApproveMode({ year, month }: { year: number; month: number }) {
  const qc = useQueryClient()
  const [openId, setOpenId] = useState<number | null>(null)
  const batchesQ = useQuery({ queryKey: ['tb-sub', year, month], queryFn: () => api.batches(year, month).then((r) => r.data.items.filter((b) => b.status !== 'draft')) })
  const reportQ = useQuery({ queryKey: ['tb-report', openId], queryFn: () => api.batchReport(openId!).then((r) => r.data), enabled: !!openId })

  const bust = () => { qc.invalidateQueries({ queryKey: ['tb-report', openId] }); qc.invalidateQueries({ queryKey: ['tb-sub', year, month] }) }
  const actMut = useMutation({ mutationFn: (v: { id: number; action: 'approved' | 'rejected' | 'query'; comment?: string }) => api.itemAction(v.id, v.action, v.comment), onSuccess: bust })
  const reviewMut = useMutation({ mutationFn: () => api.reviewBatch(openId!), onSuccess: bust })

  const batches = batchesQ.data || []
  if (openId && reportQ.data) {
    const { batch, groups, totals } = reportQ.data
    const act = (it: TransferBatchItem, action: 'approved' | 'rejected' | 'query') => {
      let comment: string | undefined
      if (action !== 'approved') { const c = prompt(action === 'rejected' ? '반려 사유:' : '질의 내용:'); if (c === null) return; comment = c }
      actMut.mutate({ id: it.id, action, comment })
    }
    const Group = ({ k }: { k: 'pay' | 'defer' | 'scheduled' }) => (
      <div className="border border-ink-100 dark:border-ink-800 rounded">
        <div className={`px-2 py-1 border-b border-ink-100 dark:border-ink-800 bg-canvas-50 dark:bg-ink-950 font-semibold text-2xs ${DISPO_COLOR[k]}`}>{DISPO[k]} · {groups[k].length}건 · <span className="font-mono">{won(groups[k].reduce((s, i) => s + i.amount, 0))}</span></div>
        <table className="min-w-full text-2xs">
          <tbody>
            {groups[k].map((it) => (
              <tr key={it.id} className="border-t border-ink-50 dark:border-ink-900">
                <td className="px-1 py-1 w-8 text-center">{it.priority === 1 ? '🔴' : it.priority === 3 ? '⚪' : '🟡'}</td>
                <td className="px-1 py-1 max-w-[150px] truncate" title={it.vendor}>{it.vendor}</td>
                <td className="px-1 py-1 text-right font-mono">{won(it.amount)}</td>
                <td className="px-1 py-1 text-ink-500 max-w-[160px] truncate" title={it.dept_request || ''}>{it.dept_request}</td>
                <td className="px-1 py-1">
                  {it.ceo_action === 'pending'
                    ? <div className="flex gap-1">
                        <button onClick={() => act(it, 'approved')} className="text-emerald-600 border border-emerald-300 rounded px-1">승인</button>
                        <button onClick={() => act(it, 'query')} className="text-amber-600 border border-amber-300 rounded px-1">질의</button>
                        <button onClick={() => act(it, 'rejected')} className="text-rose-600 border border-rose-300 rounded px-1">반려</button>
                      </div>
                    : <span className={it.ceo_action === 'approved' ? 'text-emerald-600' : it.ceo_action === 'rejected' ? 'text-rose-600' : 'text-amber-600'} title={it.ceo_comment || ''}>
                        {it.ceo_action === 'approved' ? '✓승인' : it.ceo_action === 'rejected' ? '✗반려' : '?질의'}{it.ceo_comment ? ` · ${it.ceo_comment}` : ''}
                      </span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <button onClick={() => setOpenId(null)} className="btn-secondary text-2xs">← 목록</button>
          <h2 className="font-bold text-sm">{batch.title}</h2>
          <span className="text-2xs text-ink-500">대기 {totals.pending ?? 0} · 승인 {totals.approved ?? 0} · 질의 {totals.query ?? 0} · 반려 {totals.rejected ?? 0}</span>
          {batch.status !== 'reviewed' && <button onClick={() => { if (confirm('검토 완료로 처리할까요?')) reviewMut.mutate() }} className="btn-primary text-2xs ml-auto">검토 완료</button>}
          {batch.status === 'reviewed' && <span className="text-2xs text-emerald-600 ml-auto">✓ 검토완료</span>}
        </div>
        <Group k="pay" /><Group k="defer" /><Group k="scheduled" />
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {batches.length === 0 && <div className="text-sm text-ink-400">제출된 이체 보고서가 없습니다. 회계팀이 '작성' 모드에서 리스트를 만들어 제출하면 여기로 올라옵니다.</div>}
      {batches.map((b: TransferBatch) => (
        <button key={b.id} onClick={() => setOpenId(b.id)} className="w-full text-left border border-ink-100 dark:border-ink-800 rounded px-3 py-2 hover:bg-canvas-50 dark:hover:bg-ink-950 flex items-center justify-between">
          <span className="text-sm font-medium">{b.title}</span>
          <span className="text-2xs text-ink-500">{b.item_count ?? 0}건 · <span className="font-mono">{won(b.total_amount ?? 0)}</span> · <span className={b.status === 'reviewed' ? 'text-emerald-600' : 'text-sky-600'}>{b.status === 'reviewed' ? '검토완료' : '결재대기'}</span></span>
        </button>
      ))}
    </div>
  )
}
