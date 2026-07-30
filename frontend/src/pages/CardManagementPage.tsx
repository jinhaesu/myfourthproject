import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  CreditCardIcon, PencilIcon, CheckIcon, XMarkIcon,
  ChartBarIcon, MapPinIcon, CalendarDaysIcon, UserIcon,
  LockClosedIcon, LockOpenIcon, ChevronDownIcon, ChevronRightIcon,
} from '@heroicons/react/24/outline'
import { cardsApi, CardInfo, CardClosing } from '@/services/api'
import { formatCurrency, isoLocal } from '@/utils/format'
import DateRangePresets from '@/components/common/DateRangePresets'

const COLOR_PRESETS = [
  '#3B82F6', '#10B981', '#F59E0B', '#EF4444',
  '#8B5CF6', '#EC4899', '#06B6D4', '#84CC16',
]

function todayISO() { return isoLocal(new Date()) }
function daysAgoISO(n: number) {
  const d = new Date(); d.setDate(d.getDate() - n); return isoLocal(d)
}

// 카드 표시 라벨 — 별칭 > 카드사+뒷4자리 > 키. card_key가 이제 그랜터 id라 그대로 노출 금지.
function cardLabel(c?: CardInfo | null, fallback = ''): string {
  if (!c) return fallback
  if (c.nickname) return c.nickname
  const base = `${c.issuer || ''}${c.last4 ? ` ····${c.last4}` : ''}`.trim()
  return base || c.card_key || fallback
}

export default function CardManagementPage() {
  const qc = useQueryClient()
  const [from, setFrom] = useState(daysAgoISO(30))
  const [to, setTo] = useState(todayISO())
  const [selectedCard, setSelectedCard] = useState<string | null>(null)
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [editForm, setEditForm] = useState<{ nickname: string; color: string; memo: string; assignedEmail: string }>({
    nickname: '', color: '#3B82F6', memo: '', assignedEmail: '',
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
    mutationFn: async (vars: { card_key: string; patch: any; assignedEmail: string }) => {
      await cardsApi.updateAlias(vars.card_key, vars.patch)
      // 배정 이메일 반영 (빈 값이면 배정 해제)
      await cardsApi.assign(vars.card_key, vars.assignedEmail.trim() || null)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['cards-list'] })
      setEditingKey(null)
    },
  })

  const cards: CardInfo[] = listQuery.data || []
  const totalAll = cards.reduce((s, c) => s + (c.total_amount || 0), 0)

  function startEdit(card: CardInfo) {
    setEditingKey(card.card_key)
    // nickname이 card_key와 같으면 비워두기 — 새 별칭 입력 유도
    const nick = card.nickname && card.nickname !== card.card_key ? card.nickname : ''
    setEditForm({
      nickname: nick,
      color: card.color || COLOR_PRESETS[0],
      memo: card.memo || '',
      assignedEmail: card.assigned_email || '',
    })
  }

  function saveEdit() {
    if (!editingKey) return
    const { assignedEmail, ...patch } = editForm
    saveAliasMut.mutate({
      card_key: editingKey,
      patch,
      assignedEmail,
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
          <p className="text-xs text-ink-500 dark:text-ink-400 mt-1">
            카드별 별명 지정, 사용 가맹점/카테고리 분석, 일별·월별 추이
          </p>
        </div>
        <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-white dark:bg-ink-900 border border-ink-200 dark:border-ink-800">
          <CalendarDaysIcon className="h-3.5 w-3.5 text-ink-400" />
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
            className="bg-transparent text-xs font-medium text-ink-700 dark:text-ink-300 focus:outline-none w-28" />
          <span className="text-ink-300 dark:text-ink-600">→</span>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
            className="bg-transparent text-xs font-medium text-ink-700 dark:text-ink-300 focus:outline-none w-28" />
        </div>
      </div>

      <DateRangePresets from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t) }} />

      {/* KPI */}
      <div className="grid grid-cols-3 gap-2">
        <div className="panel p-3">
          <div className="text-2xs text-ink-500 dark:text-ink-400">카드 수</div>
          <div className="text-lg font-bold text-ink-900 dark:text-ink-50">{cards.length}장</div>
        </div>
        <div className="panel p-3">
          <div className="text-2xs text-ink-500 dark:text-ink-400">기간 총 사용액</div>
          <div className="text-lg font-bold text-ink-900 dark:text-ink-50">{formatCurrency(totalAll, false)}</div>
        </div>
        <div className="panel p-3">
          <div className="text-2xs text-ink-500 dark:text-ink-400">총 거래 건수</div>
          <div className="text-lg font-bold text-ink-900 dark:text-ink-50">
            {cards.reduce((s, c) => s + (c.transaction_count || 0), 0).toLocaleString()}건
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_400px] gap-3">
        {/* 카드 목록 */}
        <div className="panel overflow-hidden">
          <div className="px-3 py-2 border-b border-ink-200 dark:border-ink-800 text-2xs font-semibold text-ink-500 dark:text-ink-400 uppercase">
            카드 목록 · 총 사용액 큰 순
          </div>
          {listQuery.isLoading ? (
            <div className="p-8 text-center text-2xs text-ink-400">불러오는 중…</div>
          ) : cards.length === 0 ? (
            <div className="p-8 text-center text-2xs text-ink-400">기간 내 카드 사용 내역 없음</div>
          ) : (
            <div className="divide-y divide-ink-100 dark:divide-ink-800">
              {cards.map((card) => {
                const isEditing = editingKey === card.card_key
                const isSelected = selectedCard === card.card_key
                const accent = card.color || '#94A3B8'
                return (
                  <div key={card.card_key}
                    className={`p-3 hover:bg-canvas-50 dark:hover:bg-ink-800 cursor-pointer ${isSelected ? 'bg-blue-50/40' : ''}`}
                    onClick={() => !isEditing && setSelectedCard(card.card_key)}
                  >
                    <div className="flex items-start gap-2">
                      <div className="w-1 self-stretch rounded-full" style={{ background: accent }} />
                      <div className="flex-1 min-w-0">
                        {isEditing ? (
                          <div className="space-y-1.5" onClick={(e) => e.stopPropagation()}>
                            <div className="text-2xs text-ink-500 dark:text-ink-400 mb-0.5">
                              {card.issuer || '카드'}{card.last4 ? ` ····${card.last4}` : ''} <span className="text-ink-400">에 별명 지정</span>
                            </div>
                            <input
                              type="text"
                              value={editForm.nickname}
                              onChange={(e) => setEditForm({ ...editForm, nickname: e.target.value })}
                              placeholder="별명 (예: 마케팅 법인카드, 대표이사 개인카드)"
                              className="w-full px-2 py-1 text-xs rounded border border-ink-300 dark:border-ink-700 focus:border-blue-400 focus:outline-none"
                              autoFocus
                            />
                            <input
                              type="text"
                              value={editForm.memo}
                              onChange={(e) => setEditForm({ ...editForm, memo: e.target.value })}
                              placeholder="메모 (예: 직원 식대용)"
                              className="w-full px-2 py-1 text-xs rounded border border-ink-300 dark:border-ink-700 focus:border-blue-400 focus:outline-none"
                            />
                            <input
                              type="email"
                              value={editForm.assignedEmail}
                              onChange={(e) => setEditForm({ ...editForm, assignedEmail: e.target.value })}
                              placeholder="배정 이메일 (예: hong@joinandjoin.com) — 비우면 배정 해제"
                              className="w-full px-2 py-1 text-xs rounded border border-ink-300 dark:border-ink-700 focus:border-blue-400 focus:outline-none"
                            />
                            <div className="flex items-center gap-1">
                              <span className="text-2xs text-ink-500 dark:text-ink-400 mr-1">색상</span>
                              {COLOR_PRESETS.map((c) => (
                                <button key={c}
                                  onClick={() => setEditForm({ ...editForm, color: c })}
                                  className={`w-4 h-4 rounded-full ${editForm.color === c ? 'ring-2 ring-offset-1 ring-ink-700 dark:ring-ink-100' : ''}`}
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
                                className="px-2 py-1 text-2xs rounded border border-ink-200 dark:border-ink-800 text-ink-600 dark:text-ink-400">
                                <XMarkIcon className="h-3 w-3 inline mr-0.5" />
                                취소
                              </button>
                            </div>
                          </div>
                        ) : (
                          <>
                            <div className="flex items-center justify-between gap-2">
                              <div className="flex items-center gap-1.5 min-w-0">
                                <span className="text-sm font-semibold text-ink-900 dark:text-ink-50 truncate">
                                  {card.nickname || card.issuer || card.card_key}
                                </span>
                                <button onClick={(e) => { e.stopPropagation(); startEdit(card) }}
                                  className="text-ink-400 hover:text-ink-700 dark:hover:text-ink-200">
                                  <PencilIcon className="h-3 w-3" />
                                </button>
                              </div>
                              <span className="text-sm font-bold text-ink-900 dark:text-ink-50 font-mono">
                                {formatCurrency(card.total_amount, false)}
                              </span>
                            </div>
                            <div className="text-2xs text-ink-500 dark:text-ink-400 flex items-center gap-2 flex-wrap mt-0.5">
                              <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-canvas-100 dark:bg-ink-800 text-ink-700 dark:text-ink-200 font-medium">
                                {card.issuer || '카드사 미상'}{card.last4 ? ` ····${card.last4}` : ''}
                              </span>
                              <span>· {card.transaction_count.toLocaleString()}건</span>
                              {card.last_used && <span>· 최근 {card.last_used}</span>}
                              {card.memo && <span className="text-blue-700">· {card.memo}</span>}
                              {card.assigned_email ? (
                                <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
                                  <UserIcon className="h-2.5 w-2.5" />
                                  {card.assigned_email}
                                </span>
                              ) : (
                                <span className="inline-flex items-center px-1.5 py-0.5 rounded-full bg-ink-50 dark:bg-ink-900 text-ink-400 border border-ink-200 dark:border-ink-800">
                                  미배정
                                </span>
                              )}
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
              <CreditCardIcon className="h-8 w-8 text-ink-300 dark:text-ink-600 mx-auto mb-2" />
              왼쪽에서 카드를 선택하면<br />상세 분석이 보입니다
            </div>
          ) : !analysisQuery.data ? (
            <div className="text-center text-2xs text-ink-400 py-8">분석 중…</div>
          ) : (
            <>
              <div>
                <h3 className="text-sm font-bold text-ink-900 dark:text-ink-50">
                  {cardLabel(cards.find((c) => c.card_key === selectedCard), selectedCard || '')}
                </h3>
                <div className="text-2xs text-ink-500 dark:text-ink-400">{selectedCard}</div>
              </div>

              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="bg-canvas-50 dark:bg-ink-950 rounded p-2">
                  <div className="text-2xs text-ink-500 dark:text-ink-400">총 사용</div>
                  <div className="text-xs font-bold text-ink-900 dark:text-ink-50">{formatCurrency(analysisQuery.data.total_amount, false)}</div>
                </div>
                <div className="bg-canvas-50 dark:bg-ink-950 rounded p-2">
                  <div className="text-2xs text-ink-500 dark:text-ink-400">건수</div>
                  <div className="text-xs font-bold text-ink-900 dark:text-ink-50">{analysisQuery.data.transaction_count.toLocaleString()}</div>
                </div>
                <div className="bg-canvas-50 dark:bg-ink-950 rounded p-2">
                  <div className="text-2xs text-ink-500 dark:text-ink-400">평균</div>
                  <div className="text-xs font-bold text-ink-900 dark:text-ink-50">{formatCurrency(analysisQuery.data.avg_per_transaction, false)}</div>
                </div>
              </div>

              {/* 일별 timeline 막대 그래프 */}
              <DailyChart timeline={analysisQuery.data.timeline || []} />

              {/* 카테고리 */}
              {(analysisQuery.data.top_categories || []).length > 0 && (
                <div>
                  <div className="text-2xs font-semibold text-ink-600 dark:text-ink-400 mb-1.5 flex items-center gap-1">
                    <ChartBarIcon className="h-3 w-3" />카테고리별
                  </div>
                  <CategoryBars categories={analysisQuery.data.top_categories} total={analysisQuery.data.total_amount} />
                </div>
              )}

              {/* 가맹점 top */}
              {(analysisQuery.data.top_stores || []).length > 0 && (
                <div>
                  <div className="text-2xs font-semibold text-ink-600 dark:text-ink-400 mb-1.5 flex items-center gap-1">
                    <MapPinIcon className="h-3 w-3" />주요 가맹점 (Top 10)
                  </div>
                  <div className="space-y-0.5 text-2xs max-h-60 overflow-y-auto">
                    {(analysisQuery.data.top_stores || []).slice(0, 10).map((s: any, i: number) => (
                      <div key={i} className="flex items-center justify-between px-2 py-1 hover:bg-ink-50 dark:hover:bg-ink-800 rounded">
                        <div className="flex-1 min-w-0">
                          <div className="text-ink-800 dark:text-ink-100 truncate">{s.store}</div>
                          <div className="text-2xs text-ink-500 dark:text-ink-400">{s.category} · {s.count}건</div>
                        </div>
                        <span className="font-mono font-semibold text-ink-900 dark:text-ink-50 ml-2">
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

      {/* 월별 분류 마감 현황 (직원 제출분) */}
      <MonthlyClosingsPanel cards={cards} />

      {/* 월별 추이 */}
      <div className="panel p-3">
        <div className="text-2xs font-semibold text-ink-600 dark:text-ink-400 mb-2 flex items-center gap-1">
          <ChartBarIcon className="h-3 w-3" />
          월별 사용액 추이 {selectedCard ? `(${cardLabel(cards.find((c) => c.card_key === selectedCard), selectedCard)})` : '(전체 카드)'}
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

function currentMonthStr() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function MonthlyClosingsPanel({ cards }: { cards: CardInfo[] }) {
  const qc = useQueryClient()
  const [month, setMonth] = useState(currentMonthStr())
  const [expandedId, setExpandedId] = useState<number | null>(null)

  const closingsQuery = useQuery({
    queryKey: ['card-closings', month],
    queryFn: () => cardsApi.listClosings(month).then((r) => r.data.closings),
  })

  const detailQuery = useQuery({
    queryKey: ['card-closing-detail', expandedId, month],
    queryFn: () => {
      const c = (closingsQuery.data || []).find((x) => x.id === expandedId)!
      return cardsApi.closingDetail(c.card_key, c.month).then((r) => r.data)
    },
    enabled: expandedId != null && !!closingsQuery.data,
  })

  const reopenMut = useMutation({
    mutationFn: (id: number) => cardsApi.reopenClosing(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['card-closings'] })
      setExpandedId(null)
    },
  })

  const closings: CardClosing[] = closingsQuery.data || []
  const cardName = (key: string) => cardLabel(cards.find((x) => x.card_key === key), key)
  const cardAssignee = (key: string) => cards.find((x) => x.card_key === key)?.assigned_email

  return (
    <div className="panel overflow-hidden">
      <div className="px-3 py-2 border-b border-ink-200 dark:border-ink-800 flex items-center justify-between">
        <span className="text-2xs font-semibold text-ink-500 dark:text-ink-400 uppercase flex items-center gap-1">
          <LockClosedIcon className="h-3 w-3" />
          월별 분류 마감 현황 (직원 제출분)
        </span>
        <input type="month" value={month} onChange={(e) => { setMonth(e.target.value); setExpandedId(null) }}
          className="px-2 py-0.5 text-2xs rounded border border-ink-200 dark:border-ink-800 focus:border-blue-400 focus:outline-none" />
      </div>
      {closingsQuery.isLoading ? (
        <div className="p-6 text-center text-2xs text-ink-400">불러오는 중…</div>
      ) : closings.length === 0 ? (
        <div className="p-6 text-center text-2xs text-ink-400">
          {month} 마감 제출된 카드가 없습니다 — 직원이 내 카드 관리에서 전건 분류 후 마감을 제출하면 여기 표시됩니다
        </div>
      ) : (
        <div className="divide-y divide-ink-100 dark:divide-ink-800">
          {closings.map((c) => {
            const isExpanded = expandedId === c.id
            return (
              <div key={c.id}>
                <button
                  onClick={() => setExpandedId(isExpanded ? null : c.id)}
                  className="w-full px-3 py-2 flex items-center gap-2 text-left hover:bg-canvas-50 dark:hover:bg-ink-800"
                >
                  {isExpanded ? <ChevronDownIcon className="h-3 w-3 text-ink-400" /> : <ChevronRightIcon className="h-3 w-3 text-ink-400" />}
                  <div className="flex-1 min-w-0">
                    <span className="text-xs font-semibold text-ink-900 dark:text-ink-50">{cardName(c.card_key)}</span>
                    <span className="text-2xs text-ink-500 dark:text-ink-400 ml-2">
                      {cardAssignee(c.card_key) || c.closed_by} · {c.transaction_count}건 ·
                      마감 {c.closed_at?.slice(0, 10)} ({c.closed_by.split('@')[0]})
                    </span>
                  </div>
                  <div className="flex items-center gap-1 flex-wrap justify-end max-w-[50%]">
                    {Object.entries(c.category_summary || {}).slice(0, 4).map(([cat, amt]) => (
                      <span key={cat} className="text-2xs px-1.5 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200">
                        {cat} {formatShortWon(amt)}
                      </span>
                    ))}
                  </div>
                  <span className="text-sm font-bold font-mono text-ink-900 dark:text-ink-50 flex-shrink-0">
                    {formatCurrency(c.total_amount, false)}
                  </span>
                </button>
                {isExpanded && (
                  <div className="px-3 pb-3 bg-canvas-50/50 dark:bg-ink-950/50 border-t border-ink-100 dark:border-ink-800">
                    <div className="flex items-center justify-between py-2">
                      <div className="flex items-center gap-1 flex-wrap">
                        {Object.entries(c.category_summary || {}).map(([cat, amt]) => (
                          <span key={cat} className="text-2xs px-1.5 py-0.5 rounded-full bg-white dark:bg-ink-900 text-ink-700 dark:text-ink-300 border border-ink-200 dark:border-ink-800">
                            {cat}: <b className="font-mono">{formatCurrency(amt, false)}</b>
                          </span>
                        ))}
                      </div>
                      <button
                        onClick={() => { if (window.confirm(`${c.month} 마감을 해제할까요? 직원이 분류를 다시 수정할 수 있게 됩니다.`)) reopenMut.mutate(c.id) }}
                        disabled={reopenMut.isPending}
                        className="px-2 py-1 text-2xs rounded border border-amber-300 text-amber-700 hover:bg-amber-50 flex items-center gap-0.5 flex-shrink-0"
                      >
                        <LockOpenIcon className="h-3 w-3" />
                        마감 해제
                      </button>
                    </div>
                    {detailQuery.isLoading ? (
                      <div className="text-2xs text-ink-400 py-2 text-center">내역 불러오는 중…</div>
                    ) : (
                      <div className="max-h-72 overflow-y-auto space-y-0.5">
                        {(detailQuery.data?.transactions || []).map((t: any) => (
                          <div key={t.ticket_id || t.transact_at} className="flex items-center gap-2 text-2xs bg-white dark:bg-ink-900 rounded px-2 py-1">
                            <span className="text-ink-500 dark:text-ink-400 w-24 flex-shrink-0">{t.transact_at?.slice(5, 16).replace('T', ' ')}</span>
                            <span className="flex-1 text-ink-800 dark:text-ink-100 truncate">{t.store_name || '(가맹점 미확인)'}</span>
                            {t.classification && (
                              <span className="px-1.5 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200 flex-shrink-0">
                                {t.classification.category}{t.classification.memo ? ` · ${t.classification.memo}` : ''}
                              </span>
                            )}
                            <span className="font-mono font-semibold text-ink-900 dark:text-ink-50 w-24 text-right flex-shrink-0">
                              {formatCurrency(t.amount, false)}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function formatShortWon(n: number): string {
  if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(1)}억`
  if (n >= 10_000) return `${(n / 10_000).toFixed(0)}만`
  if (n >= 1000) return `${(n / 1000).toFixed(0)}천`
  return n.toLocaleString()
}

function DailyChart({ timeline }: { timeline: { date: string; amount: number }[] }) {
  const max = useMemo(() => Math.max(1, ...timeline.map((t) => t.amount)), [timeline])
  if (!timeline.length) return null
  // Y축 ticks: max, max/2, 0
  const ticks = [max, max * 0.75, max * 0.5, max * 0.25, 0]
  return (
    <div>
      <div className="text-2xs font-semibold text-ink-600 dark:text-ink-400 mb-1.5 flex items-center gap-1">
        <CalendarDaysIcon className="h-3 w-3" />일별 사용액
      </div>
      <div className="flex gap-1">
        {/* Y축 라벨 */}
        <div className="flex flex-col justify-between h-28 text-2xs text-ink-400 text-right pr-1 font-mono">
          {ticks.map((v, i) => (
            <span key={i}>{formatShortWon(v)}</span>
          ))}
        </div>
        {/* 차트 본체 */}
        <div className="flex-1 relative h-28">
          {/* 가로 grid line */}
          {ticks.map((_, i) => (
            <div key={i} className="absolute left-0 right-0 border-t border-ink-100 dark:border-ink-800"
              style={{ top: `${(i / (ticks.length - 1)) * 100}%` }} />
          ))}
          <div className="absolute inset-0 flex items-end gap-0.5 p-0.5">
            {timeline.map((t) => {
              const h = max > 0 ? (t.amount / max) * 100 : 0
              return (
                <div key={t.date}
                  className="flex-1 h-full flex flex-col justify-end group relative"
                  title={`${t.date}: ${t.amount.toLocaleString()}원`}
                >
                  <div className={`w-full rounded-t transition ${t.amount > 0 ? 'bg-blue-500 group-hover:bg-blue-700' : ''}`}
                    style={{ height: `${h}%`, minHeight: t.amount > 0 ? '3px' : '0' }} />
                </div>
              )
            })}
          </div>
        </div>
      </div>
      <div className="flex items-center justify-between text-2xs text-ink-400 mt-1 pl-12">
        <span>{timeline[0]?.date}</span>
        <span>{timeline[Math.floor(timeline.length / 2)]?.date}</span>
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
              <span className="text-ink-700 dark:text-ink-300">{c.category}</span>
              <span className="font-mono text-ink-600 dark:text-ink-400">{formatCurrency(c.total, false)} ({pct.toFixed(0)}%)</span>
            </div>
            <div className="h-1.5 bg-ink-100 dark:bg-ink-800 rounded-full overflow-hidden">
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
  const ticks = [max, max * 0.75, max * 0.5, max * 0.25, 0]
  return (
    <div>
      <div className="flex gap-2">
        {/* Y축 */}
        <div className="flex flex-col justify-between h-40 text-2xs text-ink-400 text-right pr-1 font-mono">
          {ticks.map((v, i) => (
            <span key={i}>{formatShortWon(v)}</span>
          ))}
        </div>
        {/* 차트 */}
        <div className="flex-1 relative h-40">
          {ticks.map((_, i) => (
            <div key={i} className="absolute left-0 right-0 border-t border-ink-100 dark:border-ink-800"
              style={{ top: `${(i / (ticks.length - 1)) * 100}%` }} />
          ))}
          <div className="absolute inset-0 flex items-end gap-3 p-1">
            {months.map((m) => {
              const h = max > 0 ? (m.total / max) * 100 : 0
              return (
                <div key={m.month} className="flex-1 h-full flex flex-col items-center justify-end group relative">
                  {m.total > 0 && (
                    <span className="text-2xs font-mono text-ink-700 dark:text-ink-300 opacity-0 group-hover:opacity-100 absolute -top-4 whitespace-nowrap z-10">
                      {formatCurrency(m.total, false)}
                    </span>
                  )}
                  <div className="w-full bg-blue-500 rounded-t group-hover:bg-blue-700 transition"
                    style={{ height: `${h}%`, minHeight: m.total > 0 ? '3px' : '0' }} />
                </div>
              )
            })}
          </div>
        </div>
      </div>
      <div className="flex items-end gap-3 mt-2 pl-12">
        {months.map((m) => (
          <div key={m.month} className="flex-1 text-center text-2xs">
            <div className="font-semibold text-ink-700 dark:text-ink-300">{m.month}</div>
            <div className="font-mono text-ink-900 dark:text-ink-50">{formatShortWon(m.total)}원</div>
            <div className="text-ink-400">{m.count.toLocaleString()}건</div>
          </div>
        ))}
      </div>
    </div>
  )
}
