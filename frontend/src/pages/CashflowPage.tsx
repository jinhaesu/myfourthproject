import { useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { cashflowApi, cardsApi, type CashflowTx } from '@/services/api'

const won = (n: number) => {
  const v = Math.round(n || 0)
  return v.toLocaleString('ko-KR')
}
const MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
const XUNS = [10, 20, 30]
const XUN_LABEL: Record<number, string> = { 10: '초순', 20: '중순', 30: '하순' }

export default function CashflowPage() {
  const qc = useQueryClient()
  const thisYear = new Date().getFullYear()
  const [year, setYear] = useState(thisYear)
  const [showXun, setShowXun] = useState(false)
  const [drill, setDrill] = useState<{ month: number; xun?: number } | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const pivotQ = useQuery({
    queryKey: ['cashflow-pivot', year],
    queryFn: () => cashflowApi.pivot(year).then((r) => r.data),
  })
  const linesQ = useQuery({ queryKey: ['cashflow-lines'], queryFn: () => cashflowApi.lines().then((r) => r.data.lines) })

  const pivot = pivotQ.data
  const lineDefs = (pivot?.lines || []).filter((l) => l.key !== 'exclude')

  // 셀 집계 헬퍼
  const cellNet = (lineKey: string, m: number, x?: number) => {
    const c = pivot?.cells[lineKey]
    if (!c) return 0
    if (x) { const v = c[`${m}-${x}`]; return v ? v.in - v.out : 0 }
    return XUNS.reduce((s, xx) => { const v = c[`${m}-${xx}`]; return s + (v ? v.in - v.out : 0) }, 0)
  }
  const subCellNet = (lineKey: string, sub: string, m: number, x?: number) => {
    const sc = pivot?.subcells?.[lineKey]?.[sub]
    if (!sc) return 0
    if (x) { const v = sc[`${m}-${x}`]; return v ? v.in - v.out : 0 }
    return XUNS.reduce((s, xx) => { const v = sc[`${m}-${xx}`]; return s + (v ? v.in - v.out : 0) }, 0)
  }
  const subsOf = (lineKey: string) => Object.keys(pivot?.subcells?.[lineKey] || {})
  const netCell = (m: number, x?: number) =>
    x ? (pivot?.net[`${m}-${x}`] || 0) : XUNS.reduce((s, xx) => s + (pivot?.net[`${m}-${xx}`] || 0), 0)
  const closingCell = (m: number, x?: number) => pivot?.closing[`${m}-${x || 30}`] ?? 0

  const yearNet = useMemo(
    () => (pivot ? MONTHS.reduce((s, m) => s + netCell(m), 0) : 0),
    [pivot],
  )

  const cols: { m: number; x?: number; label: string }[] = []
  for (const m of MONTHS) {
    if (showXun) for (const x of XUNS) cols.push({ m, x, label: `${m}월 ${XUN_LABEL[x]}` })
    cols.push({ m, label: `${m}월 계` })
  }

  return (
    <div className="p-4 space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <h1 className="text-lg font-bold">현금흐름 (旬×월)</h1>
        <select value={year} onChange={(e) => setYear(Number(e.target.value))}
          className="border border-ink-200 dark:border-ink-800 rounded px-2 py-1 text-sm bg-transparent">
          {[thisYear + 1, thisYear, thisYear - 1, thisYear - 2].map((y) => <option key={y} value={y}>{y}년</option>)}
        </select>
        <label className="flex items-center gap-1 text-2xs cursor-pointer">
          <input type="checkbox" checked={showXun} onChange={(e) => setShowXun(e.target.checked)} className="w-3.5 h-3.5" />
          旬(10/20/30일) 상세
        </label>
        {pivot && (
          <span className="text-2xs text-ink-500 dark:text-ink-400">
            집계 {pivot.tx_used.toLocaleString()}건 · 내부이체/제외 {pivot.internal_excluded.toLocaleString()}건
            {pivot.opening_estimated && ' · 기초잔액 역산(추정)'}
          </span>
        )}
      </div>

      {pivot && (
        <div className="flex items-center gap-4 text-sm flex-wrap bg-canvas-50 dark:bg-ink-950 rounded px-3 py-2">
          <span>기초잔액 <b className="font-mono">{won(pivot.opening)}</b></span>
          <span>연간 순현금증감 <b className={`font-mono ${yearNet >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>{won(yearNet)}</b></span>
          <span>기말잔액 <b className="font-mono">{won(pivot.opening + yearNet)}</b></span>
          <span className="text-2xs text-ink-400">※ 셀을 클릭하면 거래를 열어 분류를 바꿀 수 있어요. 잘못 섞인 내부이체는 "내부이체/제외"로 바꾸면 집계에서 빠집니다.</span>
        </div>
      )}

      {pivotQ.isLoading && <div className="text-sm text-ink-500">불러오는 중…</div>}
      {pivot && (
        <div className="overflow-x-auto border border-ink-100 dark:border-ink-800 rounded">
          <table className="text-2xs border-collapse">
            <thead className="bg-canvas-50 dark:bg-ink-950 sticky top-0">
              <tr>
                <th className="px-2 py-1 text-left font-semibold sticky left-0 bg-canvas-50 dark:bg-ink-950 z-10 min-w-[120px]">구분</th>
                {cols.map((c, i) => (
                  <th key={i} className={`px-2 py-1 text-right font-semibold whitespace-nowrap ${!c.x ? 'bg-ink-100/60 dark:bg-ink-900' : ''}`}>{c.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {lineDefs.flatMap((l) => {
                const subs = subsOf(l.key)
                const isOpen = expanded.has(l.key)
                const rows = [
                  <tr key={l.key} className="border-t border-ink-100 dark:border-ink-900 hover:bg-canvas-50/50 dark:hover:bg-ink-950/40">
                    <td className="px-2 py-1 sticky left-0 bg-white dark:bg-ink-950 font-medium">
                      {subs.length > 0 && (
                        <button onClick={() => setExpanded((p) => { const n = new Set(p); n.has(l.key) ? n.delete(l.key) : n.add(l.key); return n })}
                          className="mr-1 text-ink-400">{isOpen ? '▾' : '▸'}</button>
                      )}
                      {l.label}
                    </td>
                    {cols.map((c, i) => {
                      const v = cellNet(l.key, c.m, c.x)
                      return (
                        <td key={i} onClick={() => setDrill({ month: c.m, xun: c.x })}
                          className={`px-2 py-1 text-right font-mono cursor-pointer hover:underline ${!c.x ? 'bg-ink-50/60 dark:bg-ink-900/50 font-semibold' : ''} ${v < 0 ? 'text-rose-600' : v > 0 ? 'text-ink-800 dark:text-ink-200' : 'text-ink-300'}`}>
                          {v ? won(v) : '-'}
                        </td>
                      )
                    })}
                  </tr>,
                ]
                if (isOpen) {
                  for (const sub of subs) {
                    rows.push(
                      <tr key={`${l.key}::${sub}`} className="border-t border-ink-50 dark:border-ink-900/50 bg-canvas-50/40 dark:bg-ink-950/30">
                        <td className="px-2 py-0.5 pl-7 sticky left-0 bg-canvas-50 dark:bg-ink-950 text-ink-500 dark:text-ink-400 truncate max-w-[120px]" title={sub}>{sub}</td>
                        {cols.map((c, i) => {
                          const v = subCellNet(l.key, sub, c.m, c.x)
                          return (
                            <td key={i} onClick={() => setDrill({ month: c.m, xun: c.x })}
                              className={`px-2 py-0.5 text-right font-mono text-ink-500 cursor-pointer hover:underline ${!c.x ? 'bg-ink-50/40 dark:bg-ink-900/30' : ''}`}>
                              {v ? won(v) : ''}
                            </td>
                          )
                        })}
                      </tr>,
                    )
                  }
                }
                return rows
              })}
              <tr className="border-t-2 border-ink-300 dark:border-ink-700 bg-canvas-50 dark:bg-ink-950 font-bold">
                <td className="px-2 py-1 sticky left-0 bg-canvas-50 dark:bg-ink-950">순현금증감</td>
                {cols.map((c, i) => {
                  const v = netCell(c.m, c.x)
                  return <td key={i} className={`px-2 py-1 text-right font-mono ${!c.x ? 'bg-ink-100/60 dark:bg-ink-900' : ''} ${v < 0 ? 'text-rose-600' : 'text-emerald-600'}`}>{v ? won(v) : '-'}</td>
                })}
              </tr>
              <tr className="border-t border-ink-200 dark:border-ink-800 font-semibold">
                <td className="px-2 py-1 sticky left-0 bg-white dark:bg-ink-950">기말잔액</td>
                {cols.map((c, i) => (
                  <td key={i} className={`px-2 py-1 text-right font-mono ${!c.x ? 'bg-ink-50/60 dark:bg-ink-900/50' : ''}`}>{won(closingCell(c.m, c.x))}</td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {drill && pivot && (
        <DrillPanel year={year} month={drill.month} xun={drill.xun}
          lineDefs={pivot.lines}
          onClose={() => setDrill(null)}
          onChanged={() => { qc.invalidateQueries({ queryKey: ['cashflow-pivot', year] }) }}
        />
      )}
      {linesQ.isError && null}
    </div>
  )
}

function DrillPanel({ year, month, xun, lineDefs, onClose, onChanged }: {
  year: number; month: number; xun?: number
  lineDefs: { key: string; label: string }[]
  onClose: () => void; onChanged: () => void
}) {
  const qc = useQueryClient()
  const key = ['cashflow-tx', year, month, xun ?? 'all'] as const
  const txQ = useQuery({ queryKey: key, queryFn: () => cashflowApi.transactions(year, month, xun).then((r) => r.data.items) })
  const acctQ = useQuery({ queryKey: ['cf-accounts'], queryFn: () => cardsApi.accounts().then((r: any) => r.data.accounts as { code: string; name: string }[]) })
  const accounts = acctQ.data || []
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [bulkLine, setBulkLine] = useState('op_sga')

  const classifyMut = useMutation({
    mutationFn: (v: { hash: string; line: string; sub?: string }) => cashflowApi.classify(v.hash, v.line, v.sub),
    onSuccess: () => { qc.invalidateQueries({ queryKey: key }); onChanged() },
  })
  const bulkMut = useMutation({
    mutationFn: () => cashflowApi.classifyBulk(Array.from(sel), bulkLine),
    onSuccess: () => { setSel(new Set()); qc.invalidateQueries({ queryKey: key }); onChanged() },
  })

  const items = txQ.data || []
  const title = `${month}월 ${xun ? XUN_LABEL[xun] : '전체'} 거래 (${items.length}건)`

  return (
    <div className="fixed inset-0 bg-black/30 z-50 flex justify-end" onClick={onClose}>
      <div className="bg-white dark:bg-ink-950 w-full max-w-2xl h-full overflow-y-auto p-4 space-y-2" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="font-bold">{title}</h2>
          <button onClick={onClose} className="text-ink-400 text-lg">×</button>
        </div>
        <div className="flex items-center gap-2 text-2xs border-b border-ink-100 dark:border-ink-800 pb-2">
          <span>선택 {sel.size}건 →</span>
          <select value={bulkLine} onChange={(e) => setBulkLine(e.target.value)} className="border border-ink-200 dark:border-ink-800 rounded px-1 py-0.5 bg-transparent">
            {lineDefs.map((l) => <option key={l.key} value={l.key}>{l.label}</option>)}
          </select>
          <button disabled={sel.size === 0 || bulkMut.isPending} onClick={() => bulkMut.mutate()} className="btn-secondary">일괄 분류</button>
        </div>
        {txQ.isLoading && <div className="text-sm text-ink-500">불러오는 중…</div>}
        <table className="w-full text-2xs">
          <thead className="text-ink-500">
            <tr>
              <th className="w-5"></th>
              <th className="text-left px-1 py-1">일자</th>
              <th className="text-left px-1 py-1">적요/거래처</th>
              <th className="text-right px-1 py-1">입금</th>
              <th className="text-right px-1 py-1">출금</th>
              <th className="text-left px-1 py-1">분류</th>
              <th className="text-left px-1 py-1">계정과목</th>
            </tr>
          </thead>
          <tbody>
            {items.map((t: CashflowTx) => (
              <tr key={t.tx_hash} className="border-t border-ink-50 dark:border-ink-900">
                <td className="px-1"><input type="checkbox" checked={sel.has(t.tx_hash)} onChange={() => setSel((p) => { const n = new Set(p); n.has(t.tx_hash) ? n.delete(t.tx_hash) : n.add(t.tx_hash); return n })} /></td>
                <td className="px-1 py-1 whitespace-nowrap text-ink-500">{t.date.slice(5)}</td>
                <td className="px-1 py-1 max-w-[220px] truncate" title={t.name}>{t.name}<span className="text-ink-300 ml-1">··{t.acct_last4}</span></td>
                <td className="px-1 py-1 text-right font-mono text-emerald-600">{t.in_amt ? won(t.in_amt) : ''}</td>
                <td className="px-1 py-1 text-right font-mono text-rose-600">{t.out_amt ? won(t.out_amt) : ''}</td>
                <td className="px-1 py-1">
                  <select value={t.cf_line} onChange={(e) => classifyMut.mutate({ hash: t.tx_hash, line: e.target.value, sub: t.cf_sub || undefined })}
                    className={`border rounded px-1 py-0.5 bg-transparent ${t.source === 'manual' ? 'border-brand-500 text-brand-600' : 'border-ink-200 dark:border-ink-800'}`}>
                    {lineDefs.map((l) => <option key={l.key} value={l.key}>{l.label}</option>)}
                  </select>
                </td>
                <td className="px-1 py-1">
                  <select value={t.cf_sub || ''} onChange={(e) => classifyMut.mutate({ hash: t.tx_hash, line: t.cf_line, sub: e.target.value || undefined })}
                    className="border border-ink-200 dark:border-ink-800 rounded px-1 py-0.5 bg-transparent max-w-[140px]">
                    <option value="">(미지정)</option>
                    {accounts.map((a) => <option key={a.code} value={a.name}>{a.name}</option>)}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
