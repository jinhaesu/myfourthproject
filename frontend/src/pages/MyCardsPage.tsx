import { useState, useEffect, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  CreditCardIcon, CalendarDaysIcon, CheckCircleIcon,
  ExclamationCircleIcon, LockClosedIcon, DocumentDuplicateIcon,
  ChevronUpIcon, ChevronDownIcon, ClipboardIcon,
} from '@heroicons/react/24/outline'
import { cardsApi, CardInfo, CardTransaction, CardClosing } from '@/services/api'
import { formatCurrency } from '@/utils/format'
import toast from 'react-hot-toast'

type RowDraft = { account_code: string; account_name: string; memo: string }
type SortKey = 'date' | 'store' | 'amount' | 'status'

function currentMonth() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function monthRange(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number)
  const from = `${month}-01`
  const last = new Date(y, m, 0).getDate()
  const today = new Date()
  const end = new Date(y, m - 1, last) > today ? today : new Date(y, m - 1, last)
  const to = `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, '0')}-${String(end.getDate()).padStart(2, '0')}`
  return { from, to }
}

const EMPTY_DRAFT: RowDraft = { account_code: '', account_name: '', memo: '' }

export default function MyCardsPage() {
  const qc = useQueryClient()
  const [month, setMonth] = useState(currentMonth())
  const [selectedCard, setSelectedCard] = useState<string | null>(null)

  // ── 그리드 편집 상태 ──
  const [draft, setDraft] = useState<Record<string, RowDraft>>({})
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [sortKey, setSortKey] = useState<SortKey>('date')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [clip, setClip] = useState<RowDraft | null>(null)
  const [activeRow, setActiveRow] = useState<string | null>(null)
  const [acctOpen, setAcctOpen] = useState<string | null>(null)  // 행별 계정검색 열림
  const [acctSearch, setAcctSearch] = useState('')
  // 일괄적용 툴바
  const [bulkAcct, setBulkAcct] = useState<{ code: string; name: string } | null>(null)
  const [bulkAcctOpen, setBulkAcctOpen] = useState(false)
  const [bulkAcctSearch, setBulkAcctSearch] = useState('')
  const [bulkMemo, setBulkMemo] = useState('')

  const { from, to } = monthRange(month)

  const accountsQuery = useQuery({
    queryKey: ['card-accounts'],
    queryFn: () => cardsApi.accounts().then((r) => r.data.accounts),
    staleTime: 10 * 60_000,
  })
  const accounts = accountsQuery.data || []

  const listQuery = useQuery({
    queryKey: ['my-cards', month],
    queryFn: () => cardsApi.list(from, to, true).then((r) => r.data.cards),
  })
  const closingsQuery = useQuery({
    queryKey: ['my-card-closings', month],
    queryFn: () => cardsApi.listClosings(month).then((r) => r.data.closings),
  })
  const txQuery = useQuery({
    queryKey: ['my-card-tx', selectedCard, month],
    queryFn: () => cardsApi.transactions(selectedCard!, from, to).then((r) => r.data.transactions),
    enabled: !!selectedCard,
  })

  const cards: CardInfo[] = listQuery.data || []
  const txs: CardTransaction[] = useMemo(() => txQuery.data || [], [txQuery.data])
  const closings: CardClosing[] = closingsQuery.data || []
  const selectedClosing = closings.find((c) => c.card_key === selectedCard && c.month === month)
  const isClosed = !!selectedClosing

  // 저장된 분류 기준 진행률
  const classifiable = txs.filter((t) => t.ticket_id)
  const unclassified = classifiable.filter((t) => !t.classification).length
  const progress = classifiable.length ? Math.round(((classifiable.length - unclassified) / classifiable.length) * 100) : 0

  // 카드/월 변경 시 그리드 리셋
  useEffect(() => {
    setDraft({}); setSelected(new Set()); setActiveRow(null); setAcctOpen(null)
  }, [selectedCard, month])

  // 사용내역 로드 시 draft 시드 (기존 저장 분류값). 이미 편집한 행은 보존.
  useEffect(() => {
    setDraft((prev) => {
      const next = { ...prev }
      for (const t of txs) {
        if (!t.ticket_id) continue
        if (!(t.ticket_id in next)) {
          next[t.ticket_id] = {
            account_code: t.classification?.account_code || '',
            account_name: t.classification?.account_name || t.classification?.category || '',
            memo: t.classification?.memo || '',
          }
        }
      }
      return next
    })
  }, [txs])

  const setRow = (tid: string, patch: Partial<RowDraft>) =>
    setDraft((p) => ({ ...p, [tid]: { ...EMPTY_DRAFT, ...(p[tid] || {}), ...patch } }))

  const orig = (t: CardTransaction): RowDraft => ({
    account_code: t.classification?.account_code || '',
    account_name: t.classification?.account_name || t.classification?.category || '',
    memo: t.classification?.memo || '',
  })
  const rowInfo = (t: CardTransaction) => {
    const d = draft[t.ticket_id!] || EMPTY_DRAFT
    const hasAcct = !!d.account_code
    const hasMemo = !!d.memo.trim()
    const filled = hasAcct && hasMemo
    const empty = !hasAcct && !hasMemo
    const partial = !empty && !filled
    const o = orig(t)
    const changed = d.account_code !== o.account_code || d.memo !== o.memo || d.account_name !== o.account_name
    return { d, filled, empty, partial, changed }
  }

  const sortedTxs = useMemo(() => {
    const arr = [...txs]
    const dir = sortDir === 'asc' ? 1 : -1
    arr.sort((a, b) => {
      if (sortKey === 'amount') return (a.amount - b.amount) * dir
      if (sortKey === 'store') return (a.store_name || '').localeCompare(b.store_name || '', 'ko') * dir
      if (sortKey === 'status') return (((a.classification ? 1 : 0) - (b.classification ? 1 : 0))) * dir
      return (a.transact_at || '').localeCompare(b.transact_at || '') * dir
    })
    return arr
  }, [txs, sortKey, sortDir])

  const rowIds = sortedTxs.filter((t) => t.ticket_id).map((t) => t.ticket_id!)
  const allSelected = rowIds.length > 0 && rowIds.every((id) => selected.has(id))
  const partialCount = sortedTxs.filter((t) => t.ticket_id && rowInfo(t).partial).length
  const pendingSave = sortedTxs.filter((t) => t.ticket_id && rowInfo(t).changed && rowInfo(t).filled)

  const toggleSort = (k: SortKey) => {
    if (sortKey === k) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortKey(k); setSortDir('asc') }
  }
  const toggleSel = (tid: string) => setSelected((s) => { const n = new Set(s); n.has(tid) ? n.delete(tid) : n.add(tid); return n })
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(rowIds))

  const filterAccts = (q: string) =>
    accounts.filter((a) => a.code.includes(q.trim()) || a.name.includes(q.trim())).slice(0, 40)

  const applyBulk = () => {
    if (!selected.size) { toast('먼저 왼쪽 체크박스로 행을 선택하세요'); return }
    if (!bulkAcct && !bulkMemo.trim()) { toast('적용할 계정 또는 메모를 입력하세요'); return }
    setDraft((p) => {
      const n = { ...p }
      for (const tid of selected) {
        const cur = n[tid] || EMPTY_DRAFT
        n[tid] = {
          account_code: bulkAcct ? bulkAcct.code : cur.account_code,
          account_name: bulkAcct ? bulkAcct.name : cur.account_name,
          memo: bulkMemo.trim() ? bulkMemo : cur.memo,
        }
      }
      return n
    })
    toast.success(`${selected.size}건에 일괄 적용`)
  }

  const copyRow = (tid: string) => {
    const d = draft[tid]
    if (!d || (!d.account_code && !d.memo.trim())) { toast('복사할 분류가 없습니다'); return }
    setClip({ ...d })
    toast.success('복사됨 — 선택 행에 붙여넣기(Ctrl+V)')
  }
  const pasteToSelected = () => {
    if (!clip) { toast('먼저 행을 복사(Ctrl+C)하세요'); return }
    const targets = selected.size ? Array.from(selected) : (activeRow ? [activeRow] : [])
    if (!targets.length) { toast('붙여넣을 행을 체크하세요'); return }
    setDraft((p) => { const n = { ...p }; for (const tid of targets) n[tid] = { ...clip }; return n })
    toast.success(`${targets.length}건 붙여넣기`)
  }

  // Ctrl+C / Ctrl+V — 입력창 포커스가 아닐 때만 그리드 복붙(텍스트 편집 방해 안 함)
  useEffect(() => {
    if (!selectedCard || isClosed) return
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.ctrlKey && (e.key === 'c' || e.key === 'C')) {
        if (activeRow) { copyRow(activeRow); e.preventDefault() }
      } else if (e.ctrlKey && (e.key === 'v' || e.key === 'V')) {
        if (clip) { pasteToSelected(); e.preventDefault() }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCard, isClosed, activeRow, clip, selected, draft])

  const saveMut = useMutation({
    mutationFn: (items: {
      ticket_id: string; account_code: string; account_name: string; memo: string
      transact_at?: string; store_name?: string; amount?: number
    }[]) => cardsApi.classifyBulk(selectedCard!, items),
    onSuccess: (_r, items) => {
      qc.invalidateQueries({ queryKey: ['my-card-tx'] })
      qc.invalidateQueries({ queryKey: ['my-card-closings'] })
      qc.invalidateQueries({ queryKey: ['my-cards'] })
      setSelected(new Set())
      toast.success(`${items.length}건 저장 완료`)
    },
    onError: (e: any) => toast.error(e.response?.data?.detail || '일괄 저장에 실패했습니다'),
  })

  const onSave = () => {
    if (isClosed) { toast(`${month}은 마감되어 수정할 수 없습니다`, { icon: '🔒' }); return }
    if (partialCount > 0) { toast.error(`${partialCount}건 미완성 — 계정과목·메모를 모두 입력하세요`); return }
    if (!pendingSave.length) { toast('저장할 변경사항이 없습니다'); return }
    const items = pendingSave.map((t) => {
      const d = draft[t.ticket_id!]
      return {
        ticket_id: t.ticket_id!,
        account_code: d.account_code,
        account_name: d.account_name,
        memo: d.memo,
        transact_at: t.transact_at,
        store_name: t.store_name || undefined,
        amount: t.amount,
      }
    })
    saveMut.mutate(items)
  }

  const closeMut = useMutation({
    mutationFn: () => cardsApi.closeMonth(selectedCard!, month),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['my-card-closings'] })
      toast.success(`${month} 마감이 완료되었습니다. 관리자에게 전달됩니다.`)
    },
    onError: (e: any) => toast.error(e.response?.data?.detail || '마감 실패'),
  })

  const sortIcon = (k: SortKey) =>
    sortKey === k ? (sortDir === 'asc' ? <ChevronUpIcon className="h-3 w-3" /> : <ChevronDownIcon className="h-3 w-3" />) : null

  return (
    <div className="space-y-3">
      <div className="flex items-end justify-between flex-wrap gap-2">
        <div>
          <h1 className="flex items-center gap-2">
            <CreditCardIcon className="h-5 w-5 text-blue-500" />
            내 카드 관리
          </h1>
          <p className="text-xs text-ink-500 dark:text-ink-400 mt-1">
            엑셀처럼 사용내역을 정렬·체크박스 일괄분류·복붙(Ctrl+C/V)하고, 계정·메모 입력 후 한 번에 저장하세요
          </p>
        </div>
        <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-white dark:bg-ink-900 border border-ink-200 dark:border-ink-800">
          <CalendarDaysIcon className="h-3.5 w-3.5 text-ink-400" />
          <input type="month" value={month} onChange={(e) => setMonth(e.target.value)}
            className="bg-transparent text-xs font-medium text-ink-700 dark:text-ink-300 focus:outline-none" />
        </div>
      </div>

      {/* 배정된 카드 */}
      {listQuery.isLoading ? (
        <div className="panel p-8 text-center text-2xs text-ink-400">불러오는 중…</div>
      ) : cards.length === 0 ? (
        <div className="panel p-10 text-center">
          <CreditCardIcon className="h-8 w-8 text-ink-300 dark:text-ink-600 mx-auto mb-2" />
          <div className="text-xs text-ink-600 dark:text-ink-400 font-medium">배정된 카드가 없습니다</div>
          <div className="text-2xs text-ink-400 mt-1">
            법인카드가 필요하면 회계 담당자에게 배정을 요청해주세요.<br />
            (관리자는 회계 관리자용 → 카드 관리에서 본인 이메일로 배정하면 여기에 표시됩니다)
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {cards.map((card) => {
            const isSelected = selectedCard === card.card_key
            const accent = card.color || '#3B82F6'
            const cardClosing = closings.find((c) => c.card_key === card.card_key && c.month === month)
            return (
              <button
                key={card.card_key}
                onClick={() => setSelectedCard(card.card_key)}
                className={`panel p-3 text-left transition ${
                  isSelected ? 'ring-2 ring-blue-400 dark:ring-blue-600' : 'hover:bg-canvas-50 dark:hover:bg-ink-800'
                }`}
              >
                <div className="flex items-center gap-2">
                  <div className="w-1 self-stretch rounded-full" style={{ background: accent }} />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold text-ink-900 dark:text-ink-50 truncate flex items-center gap-1">
                      {card.nickname || card.issuer || card.card_key}
                      {cardClosing && (
                        <span className="inline-flex items-center gap-0.5 text-2xs px-1.5 py-0.5 rounded-full bg-emerald-50 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800">
                          <LockClosedIcon className="h-2.5 w-2.5" />마감
                        </span>
                      )}
                      {card.connected && card.transaction_count === 0 && (
                        <span className="inline-flex items-center text-2xs px-1.5 py-0.5 rounded-full bg-sky-50 dark:bg-sky-950 text-sky-700 dark:text-sky-300 border border-sky-200 dark:border-sky-800">
                          연동됨
                        </span>
                      )}
                    </div>
                    <div className="text-2xs text-ink-500 dark:text-ink-400 mt-0.5 flex items-center gap-1.5 flex-wrap">
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-canvas-100 dark:bg-ink-900 text-ink-700 dark:text-ink-300 font-medium">
                        {card.issuer || '카드사 미상'}{card.last4 ? ` ····${card.last4}` : ''}
                      </span>
                      <span>{month} 사용 {formatCurrency(card.total_amount, false)} · {card.transaction_count.toLocaleString()}건</span>
                    </div>
                    {card.memo && <div className="text-2xs text-blue-700 dark:text-blue-300 mt-0.5">{card.memo}</div>}
                  </div>
                </div>
              </button>
            )
          })}
        </div>
      )}

      {/* 사용 내역 그리드 */}
      {selectedCard && (
        <div className="panel overflow-hidden">
          <div className="px-3 py-2 border-b border-ink-200 dark:border-ink-800 flex items-center justify-between flex-wrap gap-2">
            <span className="text-2xs font-semibold text-ink-500 dark:text-ink-400 uppercase">
              {month} 사용 내역 · {cards.find((c) => c.card_key === selectedCard)?.nickname || cards.find((c) => c.card_key === selectedCard)?.issuer || selectedCard}
            </span>
            <div className="flex items-center gap-2">
              {classifiable.length > 0 && !isClosed && (
                <>
                  <div className="flex items-center gap-1.5">
                    <div className="w-24 h-1.5 bg-ink-100 dark:bg-ink-800 rounded-full overflow-hidden">
                      <div className={`h-full ${progress === 100 ? 'bg-emerald-500' : 'bg-amber-400 dark:bg-amber-600'}`} style={{ width: `${progress}%` }} />
                    </div>
                    <span className={`text-2xs font-medium ${unclassified > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
                      {classifiable.length - unclassified}/{classifiable.length} 분류
                    </span>
                  </div>
                  <button
                    onClick={() => closeMut.mutate()}
                    disabled={unclassified > 0 || closeMut.isPending}
                    title={unclassified > 0 ? `미분류 ${unclassified}건 — 전건 저장 후 마감 가능` : ''}
                    className="px-2.5 py-1 text-2xs rounded bg-blue-600 dark:bg-blue-500 text-white font-semibold hover:bg-blue-700 disabled:opacity-40 flex items-center gap-1"
                  >
                    <LockClosedIcon className="h-3 w-3" />
                    {month} 마감 제출
                  </button>
                </>
              )}
              {isClosed && (
                <span className="text-2xs text-emerald-700 dark:text-emerald-300 flex items-center gap-1">
                  <CheckCircleIcon className="h-3.5 w-3.5" />
                  {selectedClosing?.closed_at?.slice(0, 10)} 마감 완료 — 수정하려면 관리자에게 해제 요청
                </span>
              )}
            </div>
          </div>

          {txQuery.isLoading ? (
            <div className="p-8 text-center text-2xs text-ink-400">불러오는 중…</div>
          ) : txQuery.isError ? (
            <div className="p-8 text-center text-2xs text-red-500">
              사용 내역을 불러오지 못했습니다: {(txQuery.error as any)?.response?.data?.detail || '네트워크 오류'}
              <button onClick={() => txQuery.refetch()} className="block mx-auto mt-2 px-2 py-1 rounded border border-ink-200 dark:border-ink-800 text-ink-600 dark:text-ink-400">
                다시 시도
              </button>
            </div>
          ) : txs.length === 0 ? (
            <div className="p-8 text-center text-2xs text-ink-400">{month} 사용 내역 없음</div>
          ) : (
            <>
              {/* 일괄 툴바 */}
              {!isClosed && (
                <div className="px-3 py-2 border-b border-ink-200 dark:border-ink-800 bg-canvas-50 dark:bg-ink-950 flex flex-wrap items-center gap-2">
                  <span className="text-2xs font-medium text-ink-600 dark:text-ink-300">선택 {selected.size}건</span>
                  {/* 일괄 계정 선택 */}
                  <div className="relative">
                    <button onClick={() => setBulkAcctOpen((o) => !o)}
                      className={`px-2 py-1 text-2xs rounded border ${bulkAcct ? 'bg-blue-50 dark:bg-blue-950 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-800' : 'border-ink-300 dark:border-ink-700 text-ink-600 dark:text-ink-400'}`}>
                      {bulkAcct ? `${bulkAcct.code} ${bulkAcct.name}` : '계정 선택'}
                    </button>
                    {bulkAcctOpen && (
                      <div className="absolute z-30 mt-0.5 w-60 bg-white dark:bg-ink-900 border border-ink-200 dark:border-ink-800 rounded-md shadow-lg">
                        <input autoFocus value={bulkAcctSearch} onChange={(e) => setBulkAcctSearch(e.target.value)}
                          placeholder="계정 코드/명 검색"
                          className="w-full px-2 py-1 text-xs border-b border-ink-100 dark:border-ink-800 bg-transparent focus:outline-none" />
                        <div className="max-h-44 overflow-y-auto divide-y divide-ink-50 dark:divide-ink-800">
                          {filterAccts(bulkAcctSearch).map((a) => (
                            <button key={a.code} onClick={() => { setBulkAcct({ code: a.code, name: a.name }); setBulkAcctOpen(false); setBulkAcctSearch('') }}
                              className="w-full text-left px-2 py-1 text-xs hover:bg-blue-50 dark:hover:bg-blue-950/40 flex items-center gap-1.5">
                              <span className="font-mono text-ink-500 dark:text-ink-400 w-10 flex-shrink-0">{a.code}</span>
                              <span className="text-ink-800 dark:text-ink-100 truncate">{a.name}</span>
                            </button>
                          ))}
                          {filterAccts(bulkAcctSearch).length === 0 && <div className="px-2 py-1.5 text-2xs text-ink-400">검색 결과 없음</div>}
                        </div>
                        {bulkAcct && (
                          <button onClick={() => setBulkAcct(null)} className="w-full py-1 text-2xs text-ink-400 hover:text-red-500 border-t border-ink-100 dark:border-ink-800">선택 해제</button>
                        )}
                      </div>
                    )}
                  </div>
                  <input value={bulkMemo} onChange={(e) => setBulkMemo(e.target.value)} placeholder="메모(선택 행 일괄)"
                    className="px-2 py-1 text-2xs rounded border border-ink-300 dark:border-ink-700 bg-transparent focus:border-blue-400 focus:outline-none w-44" />
                  <button onClick={applyBulk}
                    className="px-2 py-1 text-2xs rounded bg-ink-800 dark:bg-ink-200 text-white dark:text-ink-900 font-medium hover:opacity-90">
                    선택행에 적용
                  </button>
                  <button onClick={pasteToSelected} disabled={!clip}
                    title="복사(Ctrl+C)한 분류를 선택 행에 붙여넣기"
                    className="px-2 py-1 text-2xs rounded border border-ink-300 dark:border-ink-700 text-ink-600 dark:text-ink-400 hover:bg-ink-50 dark:hover:bg-ink-800 disabled:opacity-40 flex items-center gap-1">
                    <ClipboardIcon className="h-3 w-3" />붙여넣기
                  </button>

                  <div className="ml-auto flex items-center gap-2">
                    {partialCount > 0 && (
                      <span className="text-2xs text-amber-600 dark:text-amber-400 flex items-center gap-0.5">
                        <ExclamationCircleIcon className="h-3.5 w-3.5" />미완성 {partialCount}건
                      </span>
                    )}
                    <span className="text-2xs text-ink-400">변경 {pendingSave.length}건</span>
                    <button onClick={onSave}
                      disabled={saveMut.isPending || pendingSave.length === 0 || partialCount > 0}
                      className="px-3 py-1 text-2xs rounded bg-emerald-500 text-white font-semibold hover:bg-emerald-600 disabled:opacity-40">
                      {saveMut.isPending ? '저장 중…' : '일괄 저장'}
                    </button>
                  </div>
                </div>
              )}

              {/* 그리드 */}
              <div className="overflow-x-auto">
                <table className="w-full text-xs border-collapse">
                  <thead className="bg-canvas-50 dark:bg-ink-900 text-2xs text-ink-500 dark:text-ink-400 uppercase sticky top-0">
                    <tr>
                      <th className="px-2 py-1.5 w-8 text-center">
                        <input type="checkbox" checked={allSelected} onChange={toggleAll} disabled={isClosed} className="align-middle" />
                      </th>
                      <th className="px-1 py-1.5 w-8 text-center">상태</th>
                      <th className="px-2 py-1.5 text-left cursor-pointer select-none" onClick={() => toggleSort('date')}>
                        <span className="inline-flex items-center gap-0.5">날짜 {sortIcon('date')}</span>
                      </th>
                      <th className="px-2 py-1.5 text-left cursor-pointer select-none" onClick={() => toggleSort('store')}>
                        <span className="inline-flex items-center gap-0.5">가맹점 {sortIcon('store')}</span>
                      </th>
                      <th className="px-2 py-1.5 text-right cursor-pointer select-none" onClick={() => toggleSort('amount')}>
                        <span className="inline-flex items-center gap-0.5">금액 {sortIcon('amount')}</span>
                      </th>
                      <th className="px-2 py-1.5 text-left cursor-pointer select-none" onClick={() => toggleSort('status')}>
                        계정과목 <span className="text-red-400">*</span>
                      </th>
                      <th className="px-2 py-1.5 text-left">메모 <span className="text-red-400">*</span></th>
                      <th className="px-1 py-1.5 w-8"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-100 dark:divide-ink-800">
                    {sortedTxs.map((t) => {
                      const tid = t.ticket_id
                      const { d, filled, partial } = rowInfo(t)
                      const isActive = !!tid && activeRow === tid
                      return (
                        <tr key={tid || t.transact_at}
                          onClick={() => tid && setActiveRow(tid)}
                          className={`${isActive ? 'bg-blue-50/60 dark:bg-blue-950/30' : partial ? 'bg-amber-50/50 dark:bg-amber-950/20' : 'hover:bg-canvas-50 dark:hover:bg-ink-800/50'}`}>
                          <td className="px-2 py-1 text-center">
                            <input type="checkbox" checked={!!tid && selected.has(tid)} disabled={isClosed || !tid}
                              onClick={(e) => e.stopPropagation()} onChange={() => tid && toggleSel(tid)} className="align-middle" />
                          </td>
                          <td className="px-1 py-1 text-center">
                            {filled ? <CheckCircleIcon className="h-4 w-4 text-emerald-500 inline" />
                              : partial ? <ExclamationCircleIcon className="h-4 w-4 text-amber-500 inline" />
                              : <span className="inline-block w-1.5 h-1.5 rounded-full bg-ink-300 dark:bg-ink-600" />}
                          </td>
                          <td className="px-2 py-1 whitespace-nowrap text-ink-700 dark:text-ink-300">
                            {t.transact_at?.slice(0, 10)}
                            <span className="text-ink-400 ml-1">{t.transact_at?.slice(11, 16)}</span>
                          </td>
                          <td className="px-2 py-1 max-w-[200px]">
                            <div className="truncate text-ink-900 dark:text-ink-50 font-medium">{t.store_name || '(가맹점 미확인)'}</div>
                            {t.granter_category && <div className="text-2xs text-ink-400 truncate">{t.granter_category}</div>}
                          </td>
                          <td className="px-2 py-1 text-right font-mono font-semibold text-ink-900 dark:text-ink-50 whitespace-nowrap">
                            {formatCurrency(t.amount, false)}
                          </td>
                          {/* 계정과목 */}
                          <td className="px-2 py-1">
                            {isClosed || !tid ? (
                              <span className="text-ink-700 dark:text-ink-300">{d.account_code ? `${d.account_code} ${d.account_name}` : '-'}</span>
                            ) : acctOpen === tid ? (
                              <div className="relative">
                                <input autoFocus value={acctSearch}
                                  onClick={(e) => e.stopPropagation()}
                                  onChange={(e) => setAcctSearch(e.target.value)}
                                  onKeyDown={(e) => { if (e.key === 'Escape') { setAcctOpen(null); setAcctSearch('') } }}
                                  onBlur={() => setTimeout(() => setAcctOpen((cur) => (cur === tid ? null : cur)), 150)}
                                  placeholder="계정 코드/명 검색"
                                  className="w-40 px-1.5 py-0.5 text-xs rounded border border-blue-300 dark:border-blue-700 bg-white dark:bg-ink-900 focus:outline-none" />
                                {acctSearch.trim() && (
                                  <div className="absolute z-30 mt-0.5 w-56 max-h-52 overflow-y-auto bg-white dark:bg-ink-900 border border-ink-200 dark:border-ink-800 rounded-md shadow-lg divide-y divide-ink-50 dark:divide-ink-800">
                                    {filterAccts(acctSearch).map((a) => (
                                      <button key={a.code}
                                        onMouseDown={() => { setRow(tid, { account_code: a.code, account_name: a.name }); setAcctOpen(null); setAcctSearch('') }}
                                        className="w-full text-left px-2 py-1 text-xs hover:bg-blue-50 dark:hover:bg-blue-950/40 flex items-center gap-1.5">
                                        <span className="font-mono text-ink-500 dark:text-ink-400 w-10 flex-shrink-0">{a.code}</span>
                                        <span className="text-ink-800 dark:text-ink-100 truncate">{a.name}</span>
                                      </button>
                                    ))}
                                    {filterAccts(acctSearch).length === 0 && <div className="px-2 py-1.5 text-2xs text-ink-400">검색 결과 없음</div>}
                                  </div>
                                )}
                              </div>
                            ) : (
                              <button onClick={(e) => { e.stopPropagation(); setActiveRow(tid); setAcctOpen(tid); setAcctSearch('') }}
                                className={`px-1.5 py-0.5 rounded text-left text-2xs whitespace-nowrap ${d.account_code ? 'bg-blue-50 dark:bg-blue-950 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800' : 'text-ink-400 border border-dashed border-ink-300 dark:border-ink-700'}`}>
                                {d.account_code ? `${d.account_code} ${d.account_name}` : '＋ 계정'}
                              </button>
                            )}
                          </td>
                          {/* 메모 */}
                          <td className="px-2 py-1">
                            {isClosed || !tid ? (
                              <span className="text-ink-700 dark:text-ink-300">{d.memo || '-'}</span>
                            ) : (
                              <input value={d.memo}
                                onClick={(e) => e.stopPropagation()}
                                onFocus={() => setActiveRow(tid)}
                                onChange={(e) => setRow(tid, { memo: e.target.value })}
                                placeholder="메모 필수"
                                className={`w-full min-w-[120px] px-1.5 py-0.5 text-xs rounded border bg-transparent focus:border-blue-400 focus:outline-none ${d.account_code && !d.memo.trim() ? 'border-amber-300 dark:border-amber-700' : 'border-ink-200 dark:border-ink-800'}`} />
                            )}
                          </td>
                          {/* 복사 */}
                          <td className="px-1 py-1 text-center">
                            {!isClosed && tid && (
                              <button onClick={(e) => { e.stopPropagation(); copyRow(tid) }} title="이 행 분류 복사(Ctrl+C)"
                                className="p-1 rounded hover:bg-ink-100 dark:hover:bg-ink-800 text-ink-400 hover:text-ink-700 dark:hover:text-ink-200">
                                <DocumentDuplicateIcon className="h-3.5 w-3.5" />
                              </button>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              {!isClosed && (
                <div className="px-3 py-1.5 border-t border-ink-100 dark:border-ink-800 text-2xs text-ink-400">
                  팁: 행 클릭 후 <b>Ctrl+C</b>로 그 행의 분류 복사 → 체크한 행들에 <b>Ctrl+V</b>로 붙여넣기 · 계정·메모는 필수 · 저장은 변경된 완성 행만 반영됩니다
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
