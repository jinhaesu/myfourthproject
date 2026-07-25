import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  CreditCardIcon, CalendarDaysIcon, CheckCircleIcon,
  ExclamationCircleIcon, PencilSquareIcon,
} from '@heroicons/react/24/outline'
import { cardsApi, CardInfo, CardTransaction } from '@/services/api'
import { formatCurrency, isoLocal } from '@/utils/format'
import toast from 'react-hot-toast'

// 직원 카드 사용 용도 분류 프리셋
const CATEGORY_PRESETS = [
  '식대', '소모품', '교통비', '주유비', '접대비',
  '구독/SW', '광고/마케팅', '배송/물류', '교육/도서', '기타',
]

function todayISO() { return isoLocal(new Date()) }
function daysAgoISO(n: number) {
  const d = new Date(); d.setDate(d.getDate() - n); return isoLocal(d)
}

export default function MyCardsPage() {
  const qc = useQueryClient()
  const [from, setFrom] = useState(daysAgoISO(30))
  const [to, setTo] = useState(todayISO())
  const [selectedCard, setSelectedCard] = useState<string | null>(null)
  const [editingTicket, setEditingTicket] = useState<string | null>(null)
  const [clsForm, setClsForm] = useState<{ category: string; memo: string }>({ category: '', memo: '' })

  const listQuery = useQuery({
    queryKey: ['my-cards', from, to],
    // mine_only=true — 관리자여도 본인에게 배정된 카드만 (직원용 화면)
    queryFn: () => cardsApi.list(from, to, true).then((r) => r.data.cards),
  })

  const txQuery = useQuery({
    queryKey: ['my-card-tx', selectedCard, from, to],
    queryFn: () => cardsApi.transactions(selectedCard!, from, to).then((r) => r.data.transactions),
    enabled: !!selectedCard,
  })

  const classifyMut = useMutation({
    mutationFn: (tx: CardTransaction & { category: string; memo: string }) =>
      cardsApi.classify({
        ticket_id: tx.ticket_id!,
        card_key: selectedCard!,
        category: tx.category,
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

  const cards: CardInfo[] = listQuery.data || []
  const txs: CardTransaction[] = txQuery.data || []
  const unclassified = txs.filter((t) => !t.classification).length

  function startClassify(tx: CardTransaction) {
    setEditingTicket(tx.ticket_id)
    setClsForm({
      category: tx.classification?.category || '',
      memo: tx.classification?.memo || '',
    })
  }

  function saveClassify(tx: CardTransaction) {
    if (!clsForm.category) {
      toast.error('분류를 선택해주세요')
      return
    }
    classifyMut.mutate({ ...tx, category: clsForm.category, memo: clsForm.memo })
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
            나에게 배정된 법인카드의 사용 내역을 확인하고, 건별 사용 용도를 분류해주세요
          </p>
        </div>
        <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-white border border-ink-200">
          <CalendarDaysIcon className="h-3.5 w-3.5 text-ink-400" />
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
            className="bg-transparent text-xs font-medium text-ink-700 focus:outline-none w-28" />
          <span className="text-ink-300">→</span>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
            className="bg-transparent text-xs font-medium text-ink-700 focus:outline-none w-28" />
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
            return (
              <button
                key={card.card_key}
                onClick={() => setSelectedCard(card.card_key)}
                className={`panel p-3 text-left transition ${
                  isSelected ? 'ring-2 ring-blue-400' : 'hover:bg-canvas-50'
                }`}
              >
                <div className="flex items-center gap-2">
                  <div className="w-1 self-stretch rounded-full" style={{ background: accent }} />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold text-ink-900 truncate">
                      {card.nickname || card.issuer || card.card_key}
                      {card.last4 && <span className="text-2xs font-mono text-ink-500 ml-1">····{card.last4}</span>}
                    </div>
                    <div className="text-2xs text-ink-500 mt-0.5">
                      기간 사용 {formatCurrency(card.total_amount, false)} · {card.transaction_count.toLocaleString()}건
                    </div>
                    {card.memo && <div className="text-2xs text-blue-700 mt-0.5">{card.memo}</div>}
                  </div>
                </div>
              </button>
            )
          })}
        </div>
      )}

      {/* 사용 내역 + 분류 */}
      {selectedCard && (
        <div className="panel overflow-hidden">
          <div className="px-3 py-2 border-b border-ink-200 flex items-center justify-between">
            <span className="text-2xs font-semibold text-ink-500 uppercase">
              사용 내역 · {cards.find((c) => c.card_key === selectedCard)?.nickname || selectedCard}
            </span>
            {txs.length > 0 && (
              <span className={`text-2xs font-medium ${unclassified > 0 ? 'text-amber-600' : 'text-emerald-600'}`}>
                {unclassified > 0 ? `미분류 ${unclassified}건 / 전체 ${txs.length}건` : `전체 ${txs.length}건 분류 완료`}
              </span>
            )}
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
            <div className="p-8 text-center text-2xs text-ink-400">기간 내 사용 내역 없음</div>
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
                              {tx.classification.category}
                              {tx.classification.memo && ` · ${tx.classification.memo}`}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <span className="text-sm font-bold font-mono text-ink-900">
                          {formatCurrency(tx.amount, false)}
                        </span>
                        {tx.ticket_id && !isEditing && (
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
                        <div className="flex flex-wrap gap-1">
                          {CATEGORY_PRESETS.map((cat) => (
                            <button
                              key={cat}
                              onClick={() => setClsForm({ ...clsForm, category: cat })}
                              className={`px-2 py-0.5 text-2xs rounded-full border transition ${
                                clsForm.category === cat
                                  ? 'bg-blue-500 text-white border-blue-500'
                                  : 'bg-white text-ink-600 border-ink-200 hover:border-blue-300'
                              }`}
                            >
                              {cat}
                            </button>
                          ))}
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
