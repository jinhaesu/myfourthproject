import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  CreditCardIcon, PencilIcon, CheckIcon, XMarkIcon,
  ChartBarIcon, MapPinIcon, CalendarDaysIcon,
} from '@heroicons/react/24/outline'
import { cardsApi, CardInfo } from '@/services/api'
import { formatCurrency, isoLocal } from '@/utils/format'

const COLOR_PRESETS = [
  '#3B82F6', '#10B981', '#F59E0B', '#EF4444',
  '#8B5CF6', '#EC4899', '#06B6D4', '#84CC16',
]

function todayISO() { return isoLocal(new Date()) }
function daysAgoISO(n: number) {
  const d = new Date(); d.setDate(d.getDate() - n); return isoLocal(d)
}

export default function CardManagementPage() {
  const qc = useQueryClient()
  const [from, setFrom] = useState(daysAgoISO(30))
  const [to, setTo] = useState(todayISO())
  const [selectedCard, setSelectedCard] = useState<string | null>(null)
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [editForm, setEditForm] = useState<{ nickname: string; color: string; memo: string }>({
    nickname: '', color: '#3B82F6', memo: '',
  })

  const listQuery = useQuery({
    queryKey: ['cards-list', from, to],
    queryFn: () => cardsApi.list(from, to).then((r) => r.data.cards),
  })

  const monthlyQuery = useQuery({
    queryKey: ['cards-monthly', selectedCard],
    queryFn: () => cardsApi.monthly(selectedCard || undefined, 6).then((r) => r.data.months),
  })

  const analysisQuery = useQuery({
    queryKey: ['cards-analysis', selectedCard, from, to],
    queryFn: () => cardsApi.analysis(selectedCard!, from, to).then((r) => r.data),
    enabled: !!selectedCard,
  })

  const saveAliasMut = useMutation({
    mutationFn: (vars: { card_key: string; patch: any }) =>
      cardsApi.updateAlias(vars.card_key, vars.patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['cards-list'] })
      setEditingKey(null)
    },
  })

  const cards: CardInfo[] = listQuery.data || []
  const totalAll = cards.reduce((s, c) => s + (c.total_amount || 0), 0)

  function startEdit(card: CardInfo) {
    setEditingKey(card.card_key)
    setEditForm({
      nickname: card.nickname || card.card_key,
      color: card.color || COLOR_PRESETS[0],
      memo: card.memo || '',
    })
  }

  function saveEdit() {
    if (!editingKey) return
    saveAliasMut.mutate({
      card_key: editingKey,
      patch: editForm,
    })
  }

  return (
    <div className="space-y-3">
      <div className="flex items-end justify-between flex-wrap gap-2">
        <div>
          <h1 className="flex items-center gap-2">
            <CreditCardIcon className="h-5 w-5 text-blue-500" />
            카드 관리
          </h1>
          <p className="text-xs text-ink-500 mt-1">
            카드별 별명 지정, 사용 가맹점/카테고리 분석, 일별·월별 추이
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

      {/* KPI */}
      <div className="grid grid-cols-3 gap-2">
        <div className="panel p-3">
          <div className="text-2xs text-ink-500">카드 수</div>
          <div className="text-lg font-bold text-ink-900">{cards.length}장</div>
        </div>
        <div className="panel p-3">
          <div className="text-2xs text-ink-500">기간 총 사용액</div>
          <div className="text-lg font-bold text-ink-900">{formatCurrency(totalAll, false)}</div>
        </div>
        <div className="panel p-3">
          <div className="text-2xs text-ink-500">총 거래 건수</div>
          <div className="text-lg font-bold text-ink-900">
            {cards.reduce((s, c) => s + (c.transaction_count || 0), 0).toLocaleString()}건
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_400px] gap-3">
        {/* 카드 목록 */}
        <div className="panel overflow-hidden">
          <div className="px-3 py-2 border-b border-ink-200 text-2xs font-semibold text-ink-500 uppercase">
            카드 목록 · 총 사용액 큰 순
          </div>
          {listQuery.isLoading ? (
            <div className="p-8 text-center text-2xs text-ink-400">불러오는 중…</div>
          ) : cards.length === 0 ? (
            <div className="p-8 text-center text-2xs text-ink-400">기간 내 카드 사용 내역 없음</div>
          ) : (
            <div className="divide-y divide-ink-100">
              {cards.map((card) => {
                const isEditing = editingKey === card.card_key
                const isSelected = selectedCard === card.card_key
                const accent = card.color || '#94A3B8'
                return (
                  <div key={card.card_key}
                    className={`p-3 hover:bg-canvas-50 cursor-pointer ${isSelected ? 'bg-blue-50/40' : ''}`}
                    onClick={() => !isEditing && setSelectedCard(card.card_key)}
                  >
                    <div className="flex items-start gap-2">
                      <div className="w-1 self-stretch rounded-full" style={{ background: accent }} />
                      <div className="flex-1 min-w-0">
                        {isEditing ? (
                          <div className="space-y-1.5" onClick={(e) => e.stopPropagation()}>
                            <input
                              type="text"
                              value={editForm.nickname}
                              onChange={(e) => setEditForm({ ...editForm, nickname: e.target.value })}
                              placeholder="별명 (예: 마케팅 법인카드)"
                              className="w-full px-2 py-1 text-xs rounded border border-ink-300 focus:border-blue-400 focus:outline-none"
                            />
                            <input
                              type="text"
                              value={editForm.memo}
                              onChange={(e) => setEditForm({ ...editForm, memo: e.target.value })}
                              placeholder="메모 (예: 직원 식대용)"
                              className="w-full px-2 py-1 text-xs rounded border border-ink-300 focus:border-blue-400 focus:outline-none"
                            />
                            <div className="flex items-center gap-1">
                              <span className="text-2xs text-ink-500 mr-1">색상</span>
                              {COLOR_PRESETS.map((c) => (
                                <button key={c}
                                  onClick={() => setEditForm({ ...editForm, color: c })}
                                  className={`w-4 h-4 rounded-full ${editForm.color === c ? 'ring-2 ring-offset-1 ring-ink-700' : ''}`}
                                  style={{ background: c }}
                                />
                              ))}
                            </div>
                            <div className="flex items-center gap-1 pt-1">
                              <button onClick={saveEdit} disabled={saveAliasMut.isPending}
                                className="px-2 py-1 text-2xs rounded bg-emerald-500 text-white font-semibold hover:bg-emerald-600 disabled:opacity-50">
                                <CheckIcon className="h-3 w-3 inline mr-0.5" />
                                저장
                              </button>
                              <button onClick={() => setEditingKey(null)}
                                className="px-2 py-1 text-2xs rounded border border-ink-200 text-ink-600">
                                <XMarkIcon className="h-3 w-3 inline mr-0.5" />
                                취소
                              </button>
                            </div>
                          </div>
                        ) : (
                          <>
                            <div className="flex items-center justify-between gap-2">
                              <div className="flex items-center gap-1.5 min-w-0">
                                <span className="text-sm font-semibold text-ink-900 truncate">
                                  {card.nickname || card.issuer || card.card_key}
                                </span>
                                {card.last4 && (
                                  <span className="text-2xs font-mono text-ink-500">····{card.last4}</span>
                                )}
                                <button onClick={(e) => { e.stopPropagation(); startEdit(card) }}
                                  className="text-ink-400 hover:text-ink-700">
                                  <PencilIcon className="h-3 w-3" />
                                </button>
                              </div>
                              <span className="text-sm font-bold text-ink-900 font-mono">
                                {formatCurrency(card.total_amount, false)}
                              </span>
                            </div>
                            <div className="text-2xs text-ink-500 flex items-center gap-2 flex-wrap mt-0.5">
                              <span>{card.card_key}</span>
                              <span>· {card.transaction_count.toLocaleString()}건</span>
                              {card.last_used && <span>· 최근 {card.last_used}</span>}
                              {card.memo && <span className="text-blue-700">· {card.memo}</span>}
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* 상세 분석 패널 */}
        <div className="panel p-3 self-start sticky top-3 space-y-3">
          {!selectedCard ? (
            <div className="text-center text-2xs text-ink-400 py-12">
              <CreditCardIcon className="h-8 w-8 text-ink-300 mx-auto mb-2" />
              왼쪽에서 카드를 선택하면<br />상세 분석이 보입니다
            </div>
          ) : !analysisQuery.data ? (
            <div className="text-center text-2xs text-ink-400 py-8">분석 중…</div>
          ) : (
            <>
              <div>
                <h3 className="text-sm font-bold text-ink-900">
                  {cards.find((c) => c.card_key === selectedCard)?.nickname || selectedCard}
                </h3>
                <div className="text-2xs text-ink-500">{selectedCard}</div>
              </div>

              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="bg-canvas-50 rounded p-2">
                  <div className="text-2xs text-ink-500">총 사용</div>
                  <div className="text-xs font-bold text-ink-900">{formatCurrency(analysisQuery.data.total_amount, false)}</div>
                </div>
                <div className="bg-canvas-50 rounded p-2">
                  <div className="text-2xs text-ink-500">건수</div>
                  <div className="text-xs font-bold text-ink-900">{analysisQuery.data.transaction_count.toLocaleString()}</div>
                </div>
                <div className="bg-canvas-50 rounded p-2">
                  <div className="text-2xs text-ink-500">평균</div>
                  <div className="text-xs font-bold text-ink-900">{formatCurrency(analysisQuery.data.avg_per_transaction, false)}</div>
                </div>
              </div>

              {/* 일별 timeline 막대 그래프 */}
              <DailyChart timeline={analysisQuery.data.timeline || []} />

              {/* 카테고리 */}
              {(analysisQuery.data.top_categories || []).length > 0 && (
                <div>
                  <div className="text-2xs font-semibold text-ink-600 mb-1.5 flex items-center gap-1">
                    <ChartBarIcon className="h-3 w-3" />카테고리별
                  </div>
                  <CategoryBars categories={analysisQuery.data.top_categories} total={analysisQuery.data.total_amount} />
                </div>
              )}

              {/* 가맹점 top */}
              {(analysisQuery.data.top_stores || []).length > 0 && (
                <div>
                  <div className="text-2xs font-semibold text-ink-600 mb-1.5 flex items-center gap-1">
                    <MapPinIcon className="h-3 w-3" />주요 가맹점 (Top 10)
                  </div>
                  <div className="space-y-0.5 text-2xs max-h-60 overflow-y-auto">
                    {(analysisQuery.data.top_stores || []).slice(0, 10).map((s: any, i: number) => (
                      <div key={i} className="flex items-center justify-between px-2 py-1 hover:bg-ink-50 rounded">
                        <div className="flex-1 min-w-0">
                          <div className="text-ink-800 truncate">{s.store}</div>
                          <div className="text-2xs text-ink-500">{s.category} · {s.count}건</div>
                        </div>
                        <span className="font-mono font-semibold text-ink-900 ml-2">
                          {formatCurrency(s.total, false)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* 월별 추이 */}
      <div className="panel p-3">
        <div className="text-2xs font-semibold text-ink-600 mb-2 flex items-center gap-1">
          <ChartBarIcon className="h-3 w-3" />
          월별 사용액 추이 {selectedCard ? `(${cards.find((c) => c.card_key === selectedCard)?.nickname || selectedCard})` : '(전체 카드)'}
        </div>
        {monthlyQuery.isLoading ? (
          <div className="text-2xs text-ink-400 py-4 text-center">불러오는 중…</div>
        ) : (
          <MonthlyChart months={monthlyQuery.data || []} />
        )}
      </div>
    </div>
  )
}

function DailyChart({ timeline }: { timeline: { date: string; amount: number }[] }) {
  const max = useMemo(() => Math.max(1, ...timeline.map((t) => t.amount)), [timeline])
  if (!timeline.length) return null
  return (
    <div>
      <div className="text-2xs font-semibold text-ink-600 mb-1.5 flex items-center gap-1">
        <CalendarDaysIcon className="h-3 w-3" />일별 사용액
      </div>
      <div className="flex items-end gap-px h-16 bg-canvas-50 rounded p-1">
        {timeline.map((t) => {
          const h = (t.amount / max) * 100
          return (
            <div key={t.date} className="flex-1 flex flex-col justify-end" title={`${t.date}: ${t.amount.toLocaleString()}원`}>
              <div className="bg-blue-500 rounded-t" style={{ height: `${h}%`, minHeight: t.amount > 0 ? '1px' : '0' }} />
            </div>
          )
        })}
      </div>
      <div className="flex items-center justify-between text-2xs text-ink-400 mt-1">
        <span>{timeline[0]?.date}</span>
        <span>{timeline[timeline.length - 1]?.date}</span>
      </div>
    </div>
  )
}

function CategoryBars({ categories, total }: { categories: { category: string; total: number }[]; total: number }) {
  return (
    <div className="space-y-1">
      {categories.slice(0, 6).map((c, i) => {
        const pct = total > 0 ? (c.total / total) * 100 : 0
        return (
          <div key={i} className="text-2xs">
            <div className="flex items-center justify-between">
              <span className="text-ink-700">{c.category}</span>
              <span className="font-mono text-ink-600">{formatCurrency(c.total, false)} ({pct.toFixed(0)}%)</span>
            </div>
            <div className="h-1.5 bg-ink-100 rounded-full overflow-hidden">
              <div className="h-full bg-blue-500" style={{ width: `${pct}%` }} />
            </div>
          </div>
        )
      })}
    </div>
  )
}

function MonthlyChart({ months }: { months: { month: string; total: number; count: number }[] }) {
  const max = useMemo(() => Math.max(1, ...months.map((m) => m.total)), [months])
  if (!months.length) return <div className="text-2xs text-ink-400 py-4 text-center">데이터 없음</div>
  return (
    <div>
      <div className="flex items-end gap-2 h-32 bg-canvas-50 rounded p-2">
        {months.map((m) => {
          const h = (m.total / max) * 100
          return (
            <div key={m.month} className="flex-1 flex flex-col items-center justify-end gap-1">
              <span className="text-2xs font-mono text-ink-700">{formatCurrency(m.total, false)}</span>
              <div className="w-full bg-blue-500 rounded-t" style={{ height: `${h}%`, minHeight: m.total > 0 ? '2px' : '0' }} />
            </div>
          )
        })}
      </div>
      <div className="flex items-end gap-2 mt-1">
        {months.map((m) => (
          <div key={m.month} className="flex-1 text-center text-2xs text-ink-500">
            {m.month}<br />
            <span className="text-ink-400">{m.count.toLocaleString()}건</span>
          </div>
        ))}
      </div>
    </div>
  )
}
