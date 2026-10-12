import { useRef, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import * as XLSX from 'xlsx'
import { transferApprovalApi, type PayableItem } from '@/services/api'

const won = (n: number) => Math.round(n || 0).toLocaleString('ko-KR')
const XUN_LABEL: Record<number, string> = { 10: '10일(1~10)', 20: '20일(11~20)', 30: '30일(21~말일)' }

export default function TransferApprovalPage() {
  const qc = useQueryClient()
  const now = new Date()
  const [year, setYear] = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth() + 1)
  const fileRef = useRef<HTMLInputElement>(null)
  const [msg, setMsg] = useState<string>('')

  const key = ['transfer-list', year, month] as const
  const listQ = useQuery({ queryKey: key, queryFn: () => transferApprovalApi.transferList(year, month).then((r) => r.data) })

  const refresh = () => qc.invalidateQueries({ queryKey: key })
  const syncMut = useMutation({
    mutationFn: () => transferApprovalApi.syncScm().then((r) => r.data),
    onSuccess: (d) => { setMsg(d.ok ? `SCM 동기화: 신규 ${d.new} · 갱신 ${d.updated}${d.warnings?.length ? ' · ' + d.warnings.join(', ') : ''}` : `SCM 실패: ${d.error}`); refresh() },
  })
  const importMut = useMutation({
    mutationFn: (rows: any[]) => transferApprovalApi.importRows(rows).then((r) => r.data),
    onSuccess: (d) => { setMsg(`엑셀 임포트: 신규 ${d.new} · 갱신 ${d.updated} · 중복제외 ${d.skipped}`); refresh() },
  })
  const approveMut = useMutation({
    mutationFn: (xun: number) => transferApprovalApi.approve(year, month, xun),
    onSuccess: () => { setMsg('승인 완료'); refresh() },
  })
  const paidMut = useMutation({
    mutationFn: (id: number) => transferApprovalApi.markPaid(id).then((r) => r.data),
    onSuccess: (d) => { setMsg(d.scm_notified ? '지급완료 · SCM 통보됨' : `지급완료(로컬) · ${d.note || 'SCM 통보 대기'}`); refresh() },
  })

  const onFile = async (f: File) => {
    const buf = await f.arrayBuffer()
    const wb = XLSX.read(buf)
    const ws = wb.Sheets[wb.SheetNames[0]]
    const raw = XLSX.utils.sheet_to_json<any>(ws, { defval: '' })
    // 헤더 유연 매핑(거래처명/채무금액/이체예정일/계좌은행/계정과목/담당자)
    const pick = (o: any, keys: string[]) => { for (const k of Object.keys(o)) if (keys.some((x) => k.replace(/\s/g, '').includes(x))) return o[k]; return '' }
    const rows = raw.map((o) => ({
      vendor: String(pick(o, ['거래처', 'vendor']) || '').trim(),
      amount: Number(String(pick(o, ['채무금액', '금액', 'amount'])).replace(/[^0-9.-]/g, '')) || 0,
      debt_date: String(pick(o, ['채무기준일', '채무일', 'debt']) || '').slice(0, 10) || undefined,
      due_date: String(pick(o, ['이체예정일', '이체일', 'due']) || '').slice(0, 10) || undefined,
      bank_name: String(pick(o, ['계좌은행', '은행', 'bank']) || '').trim() || undefined,
      account_name: String(pick(o, ['계정과목', '계정', 'account']) || '').trim() || undefined,
      manager: String(pick(o, ['담당자', 'manager']) || '').trim() || undefined,
    })).filter((r) => r.vendor && r.amount)
    if (!rows.length) { setMsg('엑셀에서 유효한 행(거래처+금액)을 못 찾았습니다'); return }
    importMut.mutate(rows)
  }

  const data = listQ.data
  const groups = data?.groups || []

  return (
    <div className="p-4 space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <h1 className="text-lg font-bold">이체 승인 (10·20·30일)</h1>
        <select value={year} onChange={(e) => setYear(Number(e.target.value))} className="border border-ink-200 dark:border-ink-800 rounded px-2 py-1 text-sm bg-transparent">
          {[now.getFullYear() + 1, now.getFullYear(), now.getFullYear() - 1].map((y) => <option key={y} value={y}>{y}년</option>)}
        </select>
        <select value={month} onChange={(e) => setMonth(Number(e.target.value))} className="border border-ink-200 dark:border-ink-800 rounded px-2 py-1 text-sm bg-transparent">
          {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => <option key={m} value={m}>{m}월</option>)}
        </select>
        <button onClick={() => syncMut.mutate()} disabled={syncMut.isPending} className="btn-secondary">{syncMut.isPending ? '가져오는 중…' : 'SCM 매입채무 가져오기'}</button>
        <input ref={fileRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.currentTarget.value = '' }} />
        <button onClick={() => fileRef.current?.click()} disabled={importMut.isPending} className="btn-secondary">엑셀 임포트</button>
        {data && <span className="text-2xs text-ink-500">{month}월 이체대상 {data.count}건 · 합계 <b className="font-mono">{won(data.total)}</b></span>}
      </div>
      {msg && <div className="text-2xs text-brand-600 bg-brand-50 dark:bg-brand-950/30 rounded px-2 py-1">{msg}</div>}

      {listQ.isLoading && <div className="text-sm text-ink-500">불러오는 중…</div>}
      {data && groups.length === 0 && <div className="text-sm text-ink-400">이체 대상(잔여채무 있는 건)이 없습니다. SCM 가져오기나 엑셀 임포트로 채워주세요.</div>}

      {groups.map((g) => (
        <div key={g.xun} className="border border-ink-100 dark:border-ink-800 rounded">
          <div className="flex items-center justify-between px-3 py-2 bg-canvas-50 dark:bg-ink-950 border-b border-ink-100 dark:border-ink-800">
            <div className="font-semibold text-sm">{XUN_LABEL[g.xun] || `${g.xun}일`} · {g.count}건 · <span className="font-mono">{won(g.subtotal)}</span></div>
            <div className="flex items-center gap-2">
              {g.approval === 'approved'
                ? <span className="text-2xs px-2 py-0.5 rounded bg-emerald-100 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400">✓ 대표 승인됨</span>
                : <button onClick={() => { if (confirm(`${month}월 ${XUN_LABEL[g.xun]} 이체 ${g.count}건(${won(g.subtotal)})을 승인할까요?`)) approveMut.mutate(g.xun) }}
                    disabled={approveMut.isPending} className="btn-primary text-2xs">대표 승인</button>}
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-2xs">
              <thead className="text-ink-500">
                <tr>
                  <th className="text-left px-2 py-1">이체예정일</th>
                  <th className="text-left px-2 py-1">거래처</th>
                  <th className="text-left px-2 py-1">계좌은행</th>
                  <th className="text-left px-2 py-1">계정과목</th>
                  <th className="text-right px-2 py-1">채무금액</th>
                  <th className="text-right px-2 py-1">잔여</th>
                  <th className="text-left px-2 py-1">담당</th>
                  <th className="text-left px-2 py-1">출처</th>
                  <th className="px-2 py-1"></th>
                </tr>
              </thead>
              <tbody>
                {g.items.map((it: PayableItem) => (
                  <tr key={it.id} className="border-t border-ink-50 dark:border-ink-900">
                    <td className="px-2 py-1 whitespace-nowrap">{it.due_date || '-'}</td>
                    <td className="px-2 py-1 max-w-[180px] truncate" title={it.vendor}>{it.vendor}</td>
                    <td className="px-2 py-1">{it.bank_name || <span className="text-rose-400">미입력</span>}</td>
                    <td className="px-2 py-1">{it.account_name || it.account_code || '-'}</td>
                    <td className="px-2 py-1 text-right font-mono">{won(it.amount)}</td>
                    <td className="px-2 py-1 text-right font-mono font-semibold">{won(it.remaining)}</td>
                    <td className="px-2 py-1">{it.manager || '-'}</td>
                    <td className="px-2 py-1"><span className={`px-1 rounded text-3xs ${it.source === 'scm' ? 'bg-sky-100 dark:bg-sky-950/40 text-sky-700' : 'bg-amber-100 dark:bg-amber-950/40 text-amber-700'}`}>{it.source.toUpperCase()}</span></td>
                    <td className="px-2 py-1 text-right">
                      {it.status === 'paid'
                        ? <span className="text-emerald-600">완료</span>
                        : <button onClick={() => { if (confirm(`${it.vendor} ${won(it.remaining)} 이체 완료 처리할까요? (은행 이체는 직접 실행)`)) paidMut.mutate(it.id) }}
                            disabled={g.approval !== 'approved' || paidMut.isPending}
                            title={g.approval !== 'approved' ? '대표 승인 후 처리 가능' : ''}
                            className="btn-secondary text-3xs disabled:opacity-40">지급완료</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
      <p className="text-2xs text-ink-400">※ 흐름: SCM/엑셀로 매입채무 적재(중복제거) → 旬별 리스트 → 대표 승인 → 직원이 은행웹에서 이체 → 지급완료 처리 → (SCM 키 설정 시) SCM에 이체완료 통보. 계좌은행·계정과목은 SCM에 없어 엑셀로 보완됩니다.</p>
    </div>
  )
}
