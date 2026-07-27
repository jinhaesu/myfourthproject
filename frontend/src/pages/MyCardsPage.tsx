import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  CreditCardIcon, CalendarDaysIcon, CheckCircleIcon,
  ExclamationCircleIcon, PencilSquareIcon, LockClosedIcon,
} from '@heroicons/react/24/outline'
import { cardsApi, CardInfo, CardTransaction, CardClosing } from '@/services/api'
import { formatCurrency } from '@/utils/format'
import toast from 'react-hot-toast'

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

export default function MyCardsPage() {
  const qc = useQueryClient()
  // 매 진입 시 이번 달 기준 (고정값 캐시 없음)
  const [month, setMonth] = useState(currentMonth())
  const [selectedCard, setSelectedCard] = useState<string | null>(null)
  const [editingTicket, setEditingTicket] = useState<string | null>(null)
  const [clsForm, setClsForm] = useState<{ account_code: string; account_name: string; memo: string }>({ account_code: '', account_name: '', memo: '' })
  const [acctSearch, setAcctSearch] = useState('')  // 계정 검색어

  const { from, to } = monthRange(month)

  // 원장 계정과목 목록 (분류 선택용)
  const accountsQuery = useQuery({
    queryKey: ['card-accounts'],
    queryFn: () => cardsApi.accounts().then((r) => r.data.accounts),
    staleTime: 10 * 60_000,
  })
  const accounts = accountsQuery.data || []

  const listQuery = useQuery({
    queryKey: ['my-cards', month],
    // mine_only=true — 관리자여도 본인에게 배정된 카드만 (직원용 화면)
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

  const classifyMut = useMutation({
    mutationFn: (tx: CardTransaction & { account_code: string; account_name: string; memo: string }) =>
      cardsApi.classify({
        ticket_id: tx.ticket_id!,
        card_key: selectedCard!,
        category: tx.account_name,          // 표시용 = 계정명
        account_code: tx.account_code,
        account_name: tx.account_name,
        memo: tx.memo || undefined,
        transact_at: tx.transact_at,
        store_name: tx.store_name || undefined,
        amount: tx.amount,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['my-card-tx'] })
      setEditingTicket(null)
      toast.success('분류가 저장되었습니다')
    },
    onError: (e: any) => {
      toast.error(e.response?.data?.detail || '분류 저장에 실패했습니다')
    },
  })

  const closeMut = useMutation({
    mutationFn: () => cardsApi.closeMonth(selectedCard!, month),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['my-card-closings'] })
      toast.success(`${month}월 마감이 완료되었습니다. 관리자에게 전달됩니다.`)
    },
    onError: (e: any) => toast.error(e.response?.data?.detail || '마감 실패'),
  })

  const cards: CardInfo[] = listQuery.data || []
  const txs: CardTransaction[] = txQuery.data || []
  const closings: CardClosing[] = closingsQuery.data || []
  const selectedClosing = closings.find((c) => c.card_key === selectedCard && c.month === month)
  const isClosed = !!selectedClosing
  const classifiable = txs.filter((t) => t.ticket_id)
  const unclassified = classifiable.filter((t) => !t.classification).length
  const progress = classifiable.length ? Math.round(((classifiable.length - unclassified) / classifiable.length) * 100) : 0

  function startClassify(tx: CardTransaction) {
    if (isClosed) {
      toast(`${month}월은 마감되어 수정할 수 없습니다`, { icon: '🔒' })
      return
    }
    setEditingTicket(tx.ticket_id)
    setAcctSearch('')
    setClsForm({
      account_code: tx.classification?.account_code || '',
      account_name: tx.classification?.account_name || tx.classification?.category || '',
      memo: tx.classification?.memo || '',
    })
  }

  function saveClassify(tx: CardTransaction) {
    if (!clsForm.account_code) {
      toast.error('계정과목을 선택해주세요')
      return
    }
    classifyMut.mutate({ ...tx, account_code: clsForm.account_code, account_name: clsForm.account_name, memo: clsForm.memo })
  }

  return (
    <div className="space-y-3">
      <div className="flex items-end justify-between flex-wrap gap-2">
        <div>
          <h1 className="flex items-center gap-2">
            <CreditCardIcon className="h-5 w-5 text-blue-500" />
            내 카드 관리
          </h1>
          <p className="text-xs text-ink-500 mt-1">
            배정된 카드의 월 사용내역을 건별로 분류하고, 전건 분류 후 월 마감을 제출해주세요
          </p>
        </div>
        <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-white border border-ink-200">
          <CalendarDaysIcon className="h-3.5 w-3.5 text-ink-400" />
          <input type="month" value={month} onChange={(e) => { setMonth(e.target.value); setEditingTicket(null) }}
            className="bg-transparent text-xs font-medium text-ink-700 focus:outline-none" />
        </div>
      </div>

      {/* 배정된 카드 */}
      {listQuery.isLoading ? (
        <div className="panel p-8 text-center text-2xs text-ink-400">불러오는 중…</div>
      ) : cards.length === 0 ? (
        <div className="panel p-10 text-center">
          <CreditCardIcon className="h-8 w-8 text-ink-300 mx-auto mb-2" />
          <div className="text-xs text-ink-600 font-medium">배정된 카드가 없습니다</div>
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
                onClick={() => { setSelectedCard(card.card_key); setEditingTicket(null) }}
                className={`panel p-3 text-left transition ${
                  isSelected ? 'ring-2 ring-blue-400' : 'hover:bg-canvas-50'
                }`}
              >
                <div className="flex items-center gap-2">
                  <div className="w-1 self-stretch rounded-full" style={{ background: accent }} />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold text-ink-900 truncate flex items-center gap-1">
                      {card.nickname || card.issuer || card.card_key}
                      {card.last4 && <span className="text-2xs font-mono text-ink-500">····{card.last4}</span>}
                      {cardClosing && (
                        <span className="inline-flex items-center gap-0.5 text-2xs px-1.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
                          <LockClosedIcon className="h-2.5 w-2.5" />마감
                        </span>
                      )}
                    </div>
                    <div className="text-2xs text-ink-500 mt-0.5">
                      {month} 사용 {formatCurrency(card.total_amount, false)} · {card.transaction_count.toLocaleString()}건
                    </div>
                    {card.memo && <div className="text-2xs text-blue-700 mt-0.5">{card.memo}</div>}
                  </div>
                </div>
              </button>
            )
          })}
        </div>
      )}

      {/* 사용 내역 + 분류 + 마감 */}
      {selectedCard && (
        <div className="panel overflow-hidden">
          <div className="px-3 py-2 border-b border-ink-200 flex items-center justify-between flex-wrap gap-2">
            <span className="text-2xs font-semibold text-ink-500 uppercase">
              {month} 사용 내역 · {cards.find((c) => c.card_key === selectedCard)?.nickname || selectedCard}
            </span>
            <div className="flex items-center gap-2">
              {classifiable.length > 0 && !isClosed && (
                <>
                  <div className="flex items-center gap-1.5">
                    <div className="w-24 h-1.5 bg-ink-100 rounded-full overflow-hidden">
                      <div className={`h-full ${progress === 100 ? 'bg-emerald-500' : 'bg-amber-400'}`} style={{ width: `${progress}%` }} />
                    </div>
                    <span className={`text-2xs font-medium ${unclassified > 0 ? 'text-amber-600' : 'text-emerald-600'}`}>
                      {classifiable.length - unclassified}/{classifiable.length} 분류
                    </span>
                  </div>
                  <button
                    onClick={() => closeMut.mutate()}
                    disabled={unclassified > 0 || closeMut.isPending}
                    title={unclassified > 0 ? `미분류 ${unclassified}건 — 전건 분류 후 마감 가능` : ''}
                    className="px-2.5 py-1 text-2xs rounded bg-blue-600 text-white font-semibold hover:bg-blue-700 disabled:opacity-40 flex items-center gap-1"
                  >
                    <LockClosedIcon className="h-3 w-3" />
                    {month} 마감 제출
                  </button>
                </>
              )}
              {isClosed && (
                <span className="text-2xs text-emerald-700 flex items-center gap-1">
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
              <button onClick={() => txQuery.refetch()} className="block mx-auto mt-2 px-2 py-1 rounded border border-ink-200 text-ink-600">
                다시 시도
              </button>
            </div>
          ) : txs.length === 0 ? (
            <div className="p-8 text-center text-2xs text-ink-400">{month} 사용 내역 없음</div>
          ) : (
            <div className="divide-y divide-ink-100">
              {txs.map((tx) => {
                const isEditing = editingTicket === tx.ticket_id
                return (
                  <div key={tx.ticket_id || tx.transact_at} className="p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          {tx.classification ? (
                            <CheckCircleIcon className="h-3.5 w-3.5 text-emerald-500 flex-shrink-0" />
                          ) : (
                            <ExclamationCircleIcon className="h-3.5 w-3.5 text-amber-500 flex-shrink-0" />
                          )}
                          <span className="text-xs font-medium text-ink-900 truncate">
                            {tx.store_name || '(가맹점 미확인)'}
                          </span>
                          {tx.granter_category && (
                            <span className="text-2xs text-ink-400">· {tx.granter_category}</span>
                          )}
                        </div>
                        <div className="text-2xs text-ink-500 mt-0.5">
                          {tx.transact_at?.replace('T', ' ')}
                          {tx.classification && (
                            <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200">
                              {tx.classification.account_code ? `${tx.classification.account_code} ` : ''}{tx.classification.account_name || tx.classification.category}
                              {tx.classification.memo && ` · ${tx.classification.memo}`}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <span className="text-sm font-bold font-mono text-ink-900">
                          {formatCurrency(tx.amount, false)}
                        </span>
                        {tx.ticket_id && !isEditing && !isClosed && (
                          <button
                            onClick={() => startClassify(tx)}
                            className="px-2 py-1 text-2xs rounded border border-ink-200 text-ink-600 hover:bg-ink-50 flex items-center gap-0.5"
                          >
                            <PencilSquareIcon className="h-3 w-3" />
                            {tx.classification ? '수정' : '분류'}
                          </button>
                        )}
                      </div>
                    </div>

                    {isEditing && (
                      <div className="mt-2 p-2 rounded-md bg-canvas-50 border border-ink-200 space-y-1.5">
                        <div>
                          <div className="text-2xs text-ink-500 mb-0.5">계정과목 (원장) — 검색해서 선택</div>
                          {clsForm.account_code && !acctSearch && (
                            <div className="flex items-center gap-1.5 mb-1">
                              <span className="text-xs font-medium px-2 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200">
                                {clsForm.account_code} · {clsForm.account_name}
                              </span>
                              <button onClick={() => setClsForm({ ...clsForm, account_code: '', account_name: '' })}
                                className="text-2xs text-ink-400 hover:text-red-500">변경</button>
                            </div>
                          )}
                          {(!clsForm.account_code || acctSearch) && (
                            <div className="relative">
                              <input
                                type="text"
                                value={acctSearch}
                                onChange={(e) => setAcctSearch(e.target.value)}
                                placeholder="계정 코드/명 검색 (예: 소모품, 여비, 830)"
                                autoFocus
                                className="w-full px-2 py-1 text-xs rounded border border-ink-300 focus:border-blue-400 focus:outline-none"
                              />
                              {acctSearch.trim() && (
                                <div className="absolute z-20 mt-0.5 w-full max-h-48 overflow-y-auto bg-white border border-ink-200 rounded-md shadow-lg divide-y divide-ink-50">
                                  {accounts
                                    .filter((a) => a.code.includes(acctSearch.trim()) || a.name.includes(acctSearch.trim()))
                                    .slice(0, 40)
                                    .map((a) => (
                                      <button key={a.code}
                                        onClick={() => { setClsForm({ ...clsForm, account_code: a.code, account_name: a.name }); setAcctSearch('') }}
                                        className="w-full text-left px-2 py-1 text-xs hover:bg-blue-50 flex items-center gap-1.5">
                                        <span className="font-mono text-ink-500 w-10 flex-shrink-0">{a.code}</span>
                                        <span className="text-ink-800">{a.name}</span>
                                      </button>
                                    ))}
                                  {accounts.filter((a) => a.code.includes(acctSearch.trim()) || a.name.includes(acctSearch.trim())).length === 0 && (
                                    <div className="px-2 py-1.5 text-2xs text-ink-400">검색 결과 없음</div>
                                  )}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                        <input
                          type="text"
                          value={clsForm.memo}
                          onChange={(e) => setClsForm({ ...clsForm, memo: e.target.value })}
                          placeholder="메모 (예: 팀 점심, 프린터 토너 구매)"
                          className="w-full px-2 py-1 text-xs rounded border border-ink-300 focus:border-blue-400 focus:outline-none"
                        />
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => saveClassify(tx)}
                            disabled={classifyMut.isPending}
                            className="px-2.5 py-1 text-2xs rounded bg-emerald-500 text-white font-semibold hover:bg-emerald-600 disabled:opacity-50"
                          >
                            저장
                          </button>
                          <button
                            onClick={() => setEditingTicket(null)}
                            className="px-2.5 py-1 text-2xs rounded border border-ink-200 text-ink-600"
                          >
                            취소
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
