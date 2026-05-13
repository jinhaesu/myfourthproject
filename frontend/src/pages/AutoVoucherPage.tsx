import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  CheckCircleIcon, XCircleIcon, ArrowPathIcon, BoltIcon,
  CalendarDaysIcon, MagnifyingGlassIcon, ExclamationTriangleIcon,
  ChevronDownIcon, ChevronRightIcon, DocumentTextIcon,
} from '@heroicons/react/24/outline'
import { autoVoucherApi, AutoVoucherCandidate } from '@/services/api'
import { formatCurrency, isoLocal } from '@/utils/format'

type ConfBand = 'all' | 'auto' | 'review' | 'suspect'

const SOURCE_LABEL: Record<string, string> = {
  sales_tax_invoice: '매출 세금계산서',
  purchase_tax_invoice: '매입 세금계산서',
  sales_invoice: '매출 계산서(영세/면세)',
  purchase_invoice: '매입 계산서(영세/면세)',
  card: '카드 매입',
  bank: '통장 거래',
  cash_receipt: '현금영수증',
}

const SOURCE_TONE: Record<string, string> = {
  sales_tax_invoice: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  purchase_tax_invoice: 'bg-rose-50 text-rose-700 border-rose-200',
  sales_invoice: 'bg-emerald-50 text-emerald-600 border-emerald-200',
  purchase_invoice: 'bg-rose-50 text-rose-600 border-rose-200',
  card: 'bg-blue-50 text-blue-700 border-blue-200',
  bank: 'bg-purple-50 text-purple-700 border-purple-200',
  cash_receipt: 'bg-amber-50 text-amber-700 border-amber-200',
}

function todayISO() { return isoLocal(new Date()) }
function monthAgoISO() {
  const d = new Date(); d.setDate(d.getDate() - 30); return isoLocal(d)
}

function confidenceTone(c: number): { bg: string; label: string; band: ConfBand } {
  if (c >= 0.85) return { bg: 'bg-emerald-100 text-emerald-800', label: '자동확정 가능', band: 'auto' }
  if (c >= 0.6) return { bg: 'bg-amber-100 text-amber-800', label: '일반검수', band: 'review' }
  return { bg: 'bg-rose-100 text-rose-800', label: '의심', band: 'suspect' }
}

export default function AutoVoucherPage() {
  const qc = useQueryClient()
  const [from, setFrom] = useState(monthAgoISO())
  const [to, setTo] = useState(todayISO())
  const [status, setStatus] = useState<string>('pending')
  const [sourceType, setSourceType] = useState<string>('')
  const [confBand, setConfBand] = useState<ConfBand>('all')
  const [counterparty, setCounterparty] = useState('')
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set())
  const [page, setPage] = useState(1)
  const SIZE = 100

  const confidenceLt = confBand === 'review' ? 0.85 : confBand === 'suspect' ? 0.6 : undefined
  const confidenceGte = confBand === 'auto' ? 0.85 : confBand === 'review' ? 0.6 : undefined

  const listQuery = useQuery({
    queryKey: ['auto-voucher-list', status, sourceType, from, to, confBand, counterparty, page],
    queryFn: () =>
      autoVoucherApi.list({
        status: status || undefined,
        source_type: sourceType || undefined,
        start_date: from || undefined,
        end_date: to || undefined,
        confidence_lt: confidenceLt,
        confidence_gte: confidenceGte,
        counterparty: counterparty || undefined,
        sort: 'date_desc',
        page,
        size: SIZE,
      }).then((r) => r.data),
    enabled: !!from && !!to,
  })

  const items: AutoVoucherCandidate[] = listQuery.data?.items || []
  const total: number = listQuery.data?.total || 0
  const summary: Record<string, Record<string, number>> = listQuery.data?.summary || {}

  const generateMut = useMutation({
    mutationFn: () =>
      autoVoucherApi.generateCandidates({
        start_date: from, end_date: to, auto_match_duplicates: true,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['auto-voucher-list'] }),
  })

  const confirmMut = useMutation({
    mutationFn: (id: number) => autoVoucherApi.confirm(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['auto-voucher-list'] }),
  })

  const confirmBatchMut = useMutation({
    mutationFn: (ids: number[]) => autoVoucherApi.confirmBatch(ids),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['auto-voucher-list'] })
      setSelectedIds(new Set())
    },
  })

  const rejectMut = useMutation({
    mutationFn: ({ id, reason }: { id: number; reason?: string }) =>
      autoVoucherApi.reject(id, reason),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['auto-voucher-list'] }),
  })

  function toggleSelect(id: number) {
    const next = new Set(selectedIds)
    if (next.has(id)) next.delete(id); else next.add(id)
    setSelectedIds(next)
  }

  function toggleExpand(id: number) {
    const next = new Set(expandedIds)
    if (next.has(id)) next.delete(id); else next.add(id)
    setExpandedIds(next)
  }

  function selectAllVisible() {
    setSelectedIds(new Set(items.filter((i) => i.status === 'pending').map((i) => i.id)))
  }

  function selectAutoConfirmable() {
    setSelectedIds(new Set(items.filter((i) => i.status === 'pending' && i.confidence >= 0.85).map((i) => i.id)))
  }

  const pendingCount = summary['pending']
    ? Object.values(summary['pending']).reduce((a: number, b: number) => a + b, 0)
    : 0
  const duplicateCount = summary['duplicate']
    ? Object.values(summary['duplicate']).reduce((a: number, b: number) => a + b, 0)
    : 0

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="flex items-center gap-2">
            <DocumentTextIcon className="h-5 w-5 text-ink-500" />
            자동 전표 검수 큐
          </h1>
          <p className="text-xs text-ink-500 mt-1">
            그랜터 수집 거래 → AI 분개 → 검수 → 확정. 의심 거래만 골라 빠르게 처리.
          </p>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-white border border-ink-200">
            <CalendarDaysIcon className="h-3.5 w-3.5 text-ink-400" />
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
              className="bg-transparent text-xs font-medium text-ink-700 focus:outline-none w-28" />
            <span className="text-ink-300">→</span>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
              className="bg-transparent text-xs font-medium text-ink-700 focus:outline-none w-28" />
          </div>
          <button
            onClick={() => generateMut.mutate()}
            disabled={generateMut.isPending}
            className="btn-primary"
            title="이 기간의 그랜터 거래를 분개 후보로 일괄 생성"
          >
            <BoltIcon className="h-3.5 w-3.5 mr-1" />
            {generateMut.isPending ? '생성 중…' : '후보 생성'}
          </button>
          <button
            onClick={() => qc.invalidateQueries({ queryKey: ['auto-voucher-list'] })}
            className="btn-secondary" title="새로고침"
          >
            <ArrowPathIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Generate result */}
      {generateMut.data && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-2xs text-emerald-800">
          <strong>{generateMut.data.data?.total_created || 0}건</strong> 후보 생성
          (매출 {generateMut.data.data?.sales_tax_invoice || 0} / 매입 {generateMut.data.data?.purchase_tax_invoice || 0}
          {' '}/ 카드 {generateMut.data.data?.card || 0} / 통장 {generateMut.data.data?.bank || 0}
          {' '}/ 현금 {generateMut.data.data?.cash_receipt || 0})
          {generateMut.data.data?.skipped > 0 && <span className="ml-2">· {generateMut.data.data?.skipped}건 중복 skip</span>}
          {generateMut.data.data?.duplicate_matching?.matched_pairs > 0 && (
            <span className="ml-2">· 카드↔통장 매칭 {generateMut.data.data?.duplicate_matching?.matched_pairs}쌍</span>
          )}
        </div>
      )}

      {/* Filters toolbar */}
      <div className="panel p-3 space-y-2">
        <div className="flex items-center gap-3 flex-wrap">
          {/* 상태 */}
          <div className="flex items-center gap-1">
            <span className="text-2xs font-semibold text-ink-500 uppercase">상태</span>
            {[
              { v: 'pending', label: `대기 ${pendingCount || ''}`, tone: 'bg-amber-100 text-amber-800 border-amber-200' },
              { v: 'confirmed', label: '확정', tone: 'bg-emerald-100 text-emerald-800 border-emerald-200' },
              { v: 'rejected', label: '거절', tone: 'bg-ink-100 text-ink-700 border-ink-200' },
              { v: 'duplicate', label: `중복 ${duplicateCount || ''}`, tone: 'bg-purple-100 text-purple-800 border-purple-200' },
            ].map((s) => (
              <button key={s.v}
                onClick={() => { setStatus(status === s.v ? '' : s.v); setPage(1) }}
                className={`px-2 py-0.5 rounded text-2xs font-semibold border ${status === s.v ? s.tone : 'bg-white text-ink-500 border-ink-200 hover:border-ink-300'}`}
              >
                {s.label}
              </button>
            ))}
          </div>

          {/* 유형 */}
          <div className="flex items-center gap-1">
            <span className="text-2xs font-semibold text-ink-500 uppercase">유형</span>
            {Object.entries(SOURCE_LABEL).map(([k, v]) => (
              <button key={k}
                onClick={() => { setSourceType(sourceType === k ? '' : k); setPage(1) }}
                className={`px-2 py-0.5 rounded text-2xs font-semibold border ${sourceType === k ? SOURCE_TONE[k] : 'bg-white text-ink-500 border-ink-200 hover:border-ink-300'}`}
              >
                {v}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          {/* 신뢰도 */}
          <div className="flex items-center gap-1">
            <span className="text-2xs font-semibold text-ink-500 uppercase">신뢰도</span>
            {[
              { v: 'all' as ConfBand, label: '전체', tone: 'bg-ink-900 text-white' },
              { v: 'auto' as ConfBand, label: '자동확정 ≥85%', tone: 'bg-emerald-100 text-emerald-800' },
              { v: 'review' as ConfBand, label: '일반 60~85%', tone: 'bg-amber-100 text-amber-800' },
              { v: 'suspect' as ConfBand, label: '의심 <60%', tone: 'bg-rose-100 text-rose-800' },
            ].map((s) => (
              <button key={s.v}
                onClick={() => { setConfBand(s.v); setPage(1) }}
                className={`px-2 py-0.5 rounded text-2xs font-semibold border ${confBand === s.v ? s.tone : 'bg-white text-ink-500 border-ink-200 hover:border-ink-300'}`}
              >
                {s.label}
              </button>
            ))}
          </div>

          {/* 거래처 검색 */}
          <div className="relative ml-auto">
            <MagnifyingGlassIcon className="h-3.5 w-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-ink-400" />
            <input
              value={counterparty}
              onChange={(e) => { setCounterparty(e.target.value); setPage(1) }}
              placeholder="거래처 검색"
              className="pl-7 pr-2 py-1 text-xs rounded-md border border-ink-200 w-44 focus:border-ink-400 focus:outline-none"
            />
          </div>
        </div>

        {/* Bulk actions */}
        {status === 'pending' && (
          <div className="flex items-center gap-2 pt-2 border-t border-ink-100">
            <span className="text-2xs text-ink-500">
              {selectedIds.size > 0 ? `${selectedIds.size}건 선택` : `${total}건 대기 중`}
            </span>
            <button onClick={selectAutoConfirmable}
              className="text-2xs font-semibold text-emerald-700 hover:underline">
              자동확정 가능 ≥85% 선택
            </button>
            <button onClick={selectAllVisible}
              className="text-2xs font-semibold text-ink-600 hover:underline">
              현재 페이지 전체 선택
            </button>
            {selectedIds.size > 0 && (
              <>
                <button onClick={() => setSelectedIds(new Set())}
                  className="text-2xs text-ink-500 hover:underline">선택 해제</button>
                <div className="flex-1" />
                <button
                  onClick={() => confirmBatchMut.mutate(Array.from(selectedIds))}
                  disabled={confirmBatchMut.isPending}
                  className="btn-primary text-2xs"
                >
                  <CheckCircleIcon className="h-3 w-3 mr-1" />
                  {confirmBatchMut.isPending ? '확정 중…' : `${selectedIds.size}건 일괄 확정`}
                </button>
              </>
            )}
          </div>
        )}
        {confirmBatchMut.data && (
          <div className="text-2xs text-ink-700 pt-1">
            확정 {confirmBatchMut.data.data?.success_count}건 / 실패 {confirmBatchMut.data.data?.failure_count}건
            {confirmBatchMut.data.data?.failure_count > 0 && (
              <span className="text-rose-600 ml-2">
                ({(confirmBatchMut.data.data?.failures || []).slice(0, 2).map((f: any) => f.reason).join(', ')})
              </span>
            )}
          </div>
        )}
      </div>

      {/* Table */}
      <div className="panel overflow-hidden">
        {listQuery.isLoading ? (
          <div className="p-8 text-center text-2xs text-ink-400">불러오는 중…</div>
        ) : items.length === 0 ? (
          <div className="p-8 text-center text-2xs text-ink-400">
            <ExclamationTriangleIcon className="h-5 w-5 text-ink-300 mx-auto mb-2" />
            <div>이 조건에 해당하는 후보가 없습니다.</div>
            <div className="mt-1 text-ink-400">"후보 생성" 버튼으로 기간 내 거래를 일괄 가져올 수 있습니다.</div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-2xs">
              <thead className="bg-canvas-50 border-b border-ink-200">
                <tr>
                  <th className="px-2 py-2 w-8"></th>
                  <th className="px-2 py-2 text-left font-semibold text-ink-500 uppercase tracking-wider w-20">날짜</th>
                  <th className="px-2 py-2 text-left font-semibold text-ink-500 uppercase tracking-wider">유형</th>
                  <th className="px-2 py-2 text-left font-semibold text-ink-500 uppercase tracking-wider min-w-[160px]">거래처</th>
                  <th className="px-2 py-2 text-left font-semibold text-ink-500 uppercase tracking-wider min-w-[200px]">적요</th>
                  <th className="px-2 py-2 text-right font-semibold text-ink-500 uppercase tracking-wider">공급가</th>
                  <th className="px-2 py-2 text-right font-semibold text-ink-500 uppercase tracking-wider">부가세</th>
                  <th className="px-2 py-2 text-right font-semibold text-ink-500 uppercase tracking-wider">합계</th>
                  <th className="px-2 py-2 text-center font-semibold text-ink-500 uppercase tracking-wider">신뢰도</th>
                  <th className="px-2 py-2 text-center font-semibold text-ink-500 uppercase tracking-wider min-w-[140px]">액션</th>
                </tr>
              </thead>
              <tbody>
                {items.map((c) => {
                  const conf = confidenceTone(c.confidence)
                  const isExpanded = expandedIds.has(c.id)
                  const isSelected = selectedIds.has(c.id)
                  const isPending = c.status === 'pending'
                  const isDup = c.status === 'duplicate'
                  return (
                    <>
                      <tr key={c.id}
                        className={`border-b border-ink-100 hover:bg-ink-50/30 ${isSelected ? 'bg-blue-50/40' : ''} ${isDup ? 'opacity-50' : ''}`}
                      >
                        <td className="px-2 py-1">
                          {isPending && (
                            <input type="checkbox" checked={isSelected}
                              onChange={() => toggleSelect(c.id)}
                              className="rounded border-ink-300 w-3 h-3" />
                          )}
                        </td>
                        <td className="px-2 py-1 font-mono text-ink-700">{c.transaction_date}</td>
                        <td className="px-2 py-1">
                          <span className={`inline-block px-1.5 py-0.5 rounded border text-2xs ${SOURCE_TONE[c.source_type] || 'bg-ink-50 text-ink-600 border-ink-200'}`}>
                            {SOURCE_LABEL[c.source_type] || c.source_type}
                          </span>
                        </td>
                        <td className="px-2 py-1 truncate max-w-[200px] text-ink-800">{c.counterparty || '-'}</td>
                        <td className="px-2 py-1 truncate max-w-[260px] text-ink-700">
                          <button onClick={() => toggleExpand(c.id)}
                            className="inline-flex items-center gap-1 hover:text-ink-900">
                            {isExpanded ? <ChevronDownIcon className="h-3 w-3" /> : <ChevronRightIcon className="h-3 w-3" />}
                            {c.description || c.suggested_account_name || '-'}
                          </button>
                        </td>
                        <td className="px-2 py-1 text-right font-mono">{formatCurrency(Number(c.supply_amount), false)}</td>
                        <td className="px-2 py-1 text-right font-mono text-ink-500">
                          {Number(c.vat_amount) > 0 ? formatCurrency(Number(c.vat_amount), false) : '-'}
                        </td>
                        <td className="px-2 py-1 text-right font-mono font-semibold">{formatCurrency(Number(c.total_amount), false)}</td>
                        <td className="px-2 py-1 text-center">
                          <span className={`inline-block px-1.5 py-0.5 rounded text-2xs font-semibold ${conf.bg}`}>
                            {Math.round(c.confidence * 100)}%
                          </span>
                        </td>
                        <td className="px-2 py-1 text-center">
                          {isPending ? (
                            <div className="inline-flex items-center gap-1">
                              <button onClick={() => confirmMut.mutate(c.id)}
                                disabled={confirmMut.isPending}
                                className="px-1.5 py-0.5 rounded bg-emerald-600 text-white text-2xs hover:bg-emerald-700">
                                <CheckCircleIcon className="h-3 w-3 inline mr-0.5" />
                                확정
                              </button>
                              <button onClick={() => rejectMut.mutate({ id: c.id })}
                                disabled={rejectMut.isPending}
                                className="px-1.5 py-0.5 rounded bg-white text-rose-600 border border-rose-200 text-2xs hover:bg-rose-50">
                                <XCircleIcon className="h-3 w-3 inline mr-0.5" />
                                거절
                              </button>
                            </div>
                          ) : c.status === 'confirmed' ? (
                            <span className="text-2xs text-emerald-700 font-semibold">확정됨 #{c.confirmed_voucher_id}</span>
                          ) : c.status === 'duplicate' ? (
                            <span className="text-2xs text-purple-700">중복 (전표 #{c.duplicate_of_id})</span>
                          ) : (
                            <span className="text-2xs text-ink-500">거절됨</span>
                          )}
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr className="bg-canvas-50 border-b border-ink-100">
                          <td colSpan={10} className="px-4 py-2">
                            <div className="text-2xs text-ink-500 mb-1.5">분개 라인</div>
                            <div className="grid grid-cols-2 gap-4">
                              <div>
                                <div className="text-2xs font-semibold text-ink-600 mb-1">차변</div>
                                {c.debit_lines.map((l, i) => (
                                  <div key={i} className="flex items-center justify-between text-2xs py-0.5">
                                    <span className="text-ink-700">
                                      <span className="font-mono text-ink-400 mr-1">{l.account_code}</span>
                                      {l.account_name}
                                    </span>
                                    <span className="font-mono font-semibold text-ink-900">{formatCurrency(Number(l.amount), false)}</span>
                                  </div>
                                ))}
                              </div>
                              <div>
                                <div className="text-2xs font-semibold text-ink-600 mb-1">대변</div>
                                {c.credit_lines.map((l, i) => (
                                  <div key={i} className="flex items-center justify-between text-2xs py-0.5">
                                    <span className="text-ink-700">
                                      <span className="font-mono text-ink-400 mr-1">{l.account_code}</span>
                                      {l.account_name}
                                    </span>
                                    <span className="font-mono font-semibold text-ink-900">{formatCurrency(Number(l.amount), false)}</span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Pagination */}
      {total > SIZE && (
        <div className="flex items-center justify-center gap-2 text-2xs">
          <button onClick={() => setPage(Math.max(1, page - 1))} disabled={page === 1}
            className="px-2 py-1 rounded border border-ink-200 disabled:opacity-50">이전</button>
          <span>{page} / {Math.ceil(total / SIZE)}</span>
          <button onClick={() => setPage(page + 1)} disabled={page * SIZE >= total}
            className="px-2 py-1 rounded border border-ink-200 disabled:opacity-50">다음</button>
        </div>
      )}
    </div>
  )
}
