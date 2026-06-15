import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  CheckCircleIcon, XCircleIcon, ArrowPathIcon, BoltIcon,
  CalendarDaysIcon, MagnifyingGlassIcon, ExclamationTriangleIcon,
  ChevronDownIcon, ChevronRightIcon, DocumentTextIcon,
  ArrowUpOnSquareIcon, InformationCircleIcon, XMarkIcon,
} from '@heroicons/react/24/outline'
import { autoVoucherApi, AutoVoucherCandidate, JournalUploadInfo } from '@/services/api'
import { formatCurrency, isoLocal } from '@/utils/format'

type ConfBand = 'all' | 'auto' | 'review' | 'suspect'
type DupFilter = 'hide' | 'include' | 'only'

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

const VOUCHER_SOURCE_LABEL: Record<string, string> = {
  wehago_import: '위하고 분개장',
  douzone_journal: '더존 분개장',
  granter_auto: '그랜터 자동',
  manual: '수기 입력',
  api: 'API',
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

// ====================== 위하고 분개장 일괄 등록 모달 ======================
function JournalMigrationModal({
  open, onClose, onDone,
}: { open: boolean; onClose: () => void; onDone: () => void }) {
  const qc = useQueryClient()
  const [selectedUploads, setSelectedUploads] = useState<Set<number>>(new Set())
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [taskId, setTaskId] = useState<string | null>(null)
  const [progress, setProgress] = useState<any>(null)

  const uploadsQuery = useQuery({
    queryKey: ['journal-uploads'],
    queryFn: () => autoVoucherApi.listJournalUploads().then((r) => r.data.uploads),
    enabled: open,
  })

  const migrateMut = useMutation({
    mutationFn: () =>
      autoVoucherApi.migrateFromJournal({
        upload_ids: selectedUploads.size > 0 ? Array.from(selectedUploads) : undefined,
        start_date: start || undefined,
        end_date: end || undefined,
      }),
    onSuccess: (res) => {
      const tid = res.data?.task_id
      if (tid) {
        setTaskId(tid)
        setProgress({ status: 'queued', percent: 0, message: '큐 진입 중…' })
      } else {
        // 동기 응답 (background=false)
        qc.invalidateQueries({ queryKey: ['auto-voucher-list'] })
        qc.invalidateQueries({ queryKey: ['journal-uploads'] })
      }
    },
  })

  // 진행률 폴링 (1.5초 간격)
  useEffect(() => {
    if (!taskId) return
    let cancelled = false
    const tick = async () => {
      try {
        const r = await autoVoucherApi.getProgress(taskId)
        if (cancelled) return
        setProgress(r.data)
        if (r.data?.status === 'completed' || r.data?.status === 'failed') {
          qc.invalidateQueries({ queryKey: ['auto-voucher-list'] })
          qc.invalidateQueries({ queryKey: ['journal-uploads'] })
          return
        }
        setTimeout(tick, 1500)
      } catch {
        if (!cancelled) {
          setProgress({ status: 'failed', message: '진행률 조회 실패' })
        }
      }
    }
    tick()
    return () => { cancelled = true }
  }, [taskId, qc])

  function toggleUpload(id: number) {
    const next = new Set(selectedUploads)
    if (next.has(id)) next.delete(id); else next.add(id)
    setSelectedUploads(next)
  }

  if (!open) return null

  // 서버에서 이미 분개장 데이터 보유 업로드만 반환 (upload_type 무관)
  const journalUploads: JournalUploadInfo[] = uploadsQuery.data || []
  // 백그라운드 task 결과는 progress.result에, 동기 모드는 migrateMut.data.data에
  const result = progress?.result || (taskId ? null : migrateMut.data?.data)
  const isRunning = !!taskId && progress?.status !== 'completed' && progress?.status !== 'failed'

  return (
    <div className="fixed inset-0 z-50 bg-ink-900/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-ink-200">
          <h2 className="flex items-center gap-2 text-base font-semibold text-ink-800">
            <ArrowUpOnSquareIcon className="h-5 w-5 text-purple-600" />
            위하고 분개장 → 전표 일괄 등록
          </h2>
          <button onClick={onClose} className="text-ink-400 hover:text-ink-700">
            <XMarkIcon className="h-5 w-5" />
          </button>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto">
          <div className="rounded-md bg-blue-50 border border-blue-200 p-3 text-2xs text-blue-900">
            <div className="flex items-start gap-2">
              <InformationCircleIcon className="h-4 w-4 text-blue-600 mt-0.5 flex-shrink-0" />
              <div>
                <div className="font-semibold mb-0.5">이미 분개된 위하고 데이터를 정식 전표로 격상합니다.</div>
                <ul className="list-disc list-inside space-y-0.5 text-blue-800">
                  <li>변환 후엔 그랜터 자동 후보가 같은 거래일 때 자동으로 <strong>중복</strong>으로 표시됩니다.</li>
                  <li>이미 변환된 그룹은 다시 변환되지 않습니다 (idempotent).</li>
                  <li>출처 라벨: <code className="px-1 bg-white rounded">wehago_import</code></li>
                </ul>
              </div>
            </div>
          </div>

          {/* 기간 필터 */}
          <div>
            <div className="text-2xs font-semibold text-ink-600 mb-1">기간 필터 (선택)</div>
            <div className="flex items-center gap-2">
              <input type="date" value={start} onChange={(e) => setStart(e.target.value)}
                className="px-2 py-1 text-xs rounded border border-ink-200 focus:border-ink-400 focus:outline-none" />
              <span className="text-ink-400 text-xs">~</span>
              <input type="date" value={end} onChange={(e) => setEnd(e.target.value)}
                className="px-2 py-1 text-xs rounded border border-ink-200 focus:border-ink-400 focus:outline-none" />
              <span className="text-2xs text-ink-500">비우면 선택된 업로드 전체</span>
            </div>
          </div>

          {/* 업로드 선택 */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <div className="text-2xs font-semibold text-ink-600">분개장 업로드 선택 (선택 안 하면 전체)</div>
              {journalUploads.length > 0 && (
                <button onClick={() => setSelectedUploads(new Set(journalUploads.map((u) => u.id)))}
                  className="text-2xs text-blue-600 hover:underline">전체 선택</button>
              )}
            </div>
            {uploadsQuery.isLoading ? (
              <div className="text-2xs text-ink-400 py-4 text-center">불러오는 중…</div>
            ) : journalUploads.length === 0 ? (
              <div className="text-2xs text-ink-400 py-4 text-center border border-dashed border-ink-200 rounded">
                분개 정보(차변/대변 + 상대계정)를 보유한 업로드가 없습니다.
                <div className="mt-1 text-2xs text-ink-400">
                  AI 분류 메뉴 → "과거 데이터 업로드"에서 위하고 분개장 엑셀을 업로드하면 자동 감지됩니다.
                </div>
              </div>
            ) : (
              <div className="space-y-1 max-h-72 overflow-y-auto border border-ink-100 rounded">
                {journalUploads.map((u) => {
                  const fullyMigrated = u.migrated_vouchers > 0
                  return (
                    <label key={u.id}
                      className={`flex items-center gap-2 px-2 py-1.5 hover:bg-ink-50 cursor-pointer ${selectedUploads.has(u.id) ? 'bg-blue-50' : ''}`}>
                      <input type="checkbox" checked={selectedUploads.has(u.id)}
                        onChange={() => toggleUpload(u.id)}
                        className="rounded border-ink-300" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-ink-800 truncate">{u.filename}</span>
                          {fullyMigrated && (
                            <span className="px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 text-2xs font-semibold">
                              ✓ {u.migrated_vouchers}건 변환됨
                            </span>
                          )}
                        </div>
                        <div className="text-2xs text-ink-500 flex items-center gap-2 flex-wrap">
                          <span>분개행 <strong className="text-ink-700">{u.journal_rows.toLocaleString()}</strong> / 전체 {u.row_count.toLocaleString()}행</span>
                          {u.min_date && u.max_date && (
                            <span>· 기간 {u.min_date}~{u.max_date}</span>
                          )}
                          <span>· 업로드 {u.created_at?.slice(0, 10)}</span>
                          <span className="text-ink-400">· {u.upload_type}</span>
                        </div>
                      </div>
                    </label>
                  )
                })}
              </div>
            )}
          </div>

          {/* 진행률 바 (백그라운드 task) */}
          {taskId && progress && (
            <div className={`rounded-md border p-3 ${
              progress.status === 'completed' ? 'border-emerald-200 bg-emerald-50' :
              progress.status === 'failed' ? 'border-rose-200 bg-rose-50' :
              'border-blue-200 bg-blue-50'
            }`}>
              <div className="flex items-center justify-between text-xs mb-1.5">
                <span className={`font-semibold ${
                  progress.status === 'completed' ? 'text-emerald-800' :
                  progress.status === 'failed' ? 'text-rose-800' :
                  'text-blue-800'
                }`}>
                  {progress.status === 'completed' ? '✓ 완료' :
                   progress.status === 'failed' ? '✗ 실패' :
                   '⏳ 진행 중'} · {progress.message}
                </span>
                <span className="text-2xs font-mono text-ink-600">{progress.percent || 0}%</span>
              </div>
              <div className="h-2 bg-white rounded-full overflow-hidden border border-ink-100">
                <div
                  className={`h-full transition-all ${
                    progress.status === 'failed' ? 'bg-rose-500' :
                    progress.status === 'completed' ? 'bg-emerald-500' :
                    'bg-blue-500'
                  }`}
                  style={{ width: `${progress.percent || 0}%` }}
                />
              </div>
              {/* 중간 통계 + 최근 에러 */}
              {progress.migrated_count !== undefined && (
                <div className="mt-2 text-2xs text-ink-700">
                  변환 <strong>{progress.migrated_count}건</strong>
                  {progress.skipped_count > 0 && <> · skip {progress.skipped_count}</>}
                  {progress.error_count > 0 && (
                    <span className="text-rose-700"> · 오류 <strong>{progress.error_count}건</strong></span>
                  )}
                </div>
              )}
              {(progress.recent_errors || []).length > 0 && (
                <details className="mt-1.5" open>
                  <summary className="cursor-pointer text-2xs text-rose-700 font-semibold">
                    최근 에러 ({progress.recent_errors.length}개)
                  </summary>
                  <div className="mt-1 space-y-0.5 text-2xs bg-white rounded p-1.5 border border-rose-100 max-h-32 overflow-y-auto font-mono">
                    {progress.recent_errors.map((reason: string, i: number) => (
                      <div key={i} className="text-rose-800 break-all">· {reason}</div>
                    ))}
                  </div>
                </details>
              )}
            </div>
          )}

          {/* 결과 */}
          {result && (
            <div className="rounded-md bg-emerald-50 border border-emerald-200 p-3 text-xs text-emerald-900">
              <div className="font-semibold mb-1">변환 완료</div>
              <div>
                <strong>{result.migrated_count}건</strong> 전표 생성
                {result.skipped_count > 0 && <> · {result.skipped_count}건 skip (이미 변환됨)</>}
                {result.error_count > 0 && <span className="text-rose-700"> · {result.error_count}건 오류</span>}
                {result.total_groups && <span className="text-ink-500"> · 전체 {result.total_groups}그룹</span>}
              </div>
              {(result.errors || []).length > 0 && (
                <details className="mt-1">
                  <summary className="cursor-pointer text-2xs text-rose-700">오류 상세 보기 ({result.errors.length}건)</summary>
                  <div className="mt-1 space-y-0.5 text-2xs max-h-32 overflow-y-auto">
                    {(result.errors || []).map((e: any, i: number) => (
                      <div key={i} className="text-rose-700">· {e.reason}</div>
                    ))}
                  </div>
                </details>
              )}
            </div>
          )}
          {migrateMut.isError && !taskId && (
            <div className="rounded-md bg-rose-50 border border-rose-200 p-3 text-2xs text-rose-700">
              실패: {(migrateMut.error as any)?.response?.data?.detail || (migrateMut.error as any)?.message}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-ink-200 bg-canvas-50">
          <button onClick={onClose} disabled={isRunning}
            className="px-3 py-1.5 text-xs text-ink-600 hover:text-ink-800 disabled:opacity-40">
            닫기
          </button>
          <button
            onClick={() => migrateMut.mutate()}
            disabled={migrateMut.isPending || isRunning || journalUploads.length === 0}
            className="btn-primary text-xs"
          >
            <ArrowUpOnSquareIcon className="h-3.5 w-3.5 mr-1" />
            {isRunning ? '변환 진행 중…' : migrateMut.isPending ? '큐 진입 중…' : '전표로 변환'}
          </button>
          {result && result.migrated_count > 0 && (
            <button onClick={() => { onDone(); onClose() }}
              className="px-3 py-1.5 text-xs bg-emerald-600 text-white rounded hover:bg-emerald-700">
              닫고 새로고침
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ============================== 메인 페이지 ==============================
export default function AutoVoucherPage() {
  const qc = useQueryClient()
  const [from, setFrom] = useState(monthAgoISO())
  const [to, setTo] = useState(todayISO())
  const [status, setStatus] = useState<string>('pending')
  const [sourceType, setSourceType] = useState<string>('')
  const [confBand, setConfBand] = useState<ConfBand>('all')
  const [dupFilter, setDupFilter] = useState<DupFilter>('hide')
  const [counterparty, setCounterparty] = useState('')
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set())
  const [page, setPage] = useState(1)
  const [showMigrateModal, setShowMigrateModal] = useState(false)
  const SIZE = 100

  const confidenceLt = confBand === 'review' ? 0.85 : confBand === 'suspect' ? 0.6 : undefined
  const confidenceGte = confBand === 'auto' ? 0.85 : confBand === 'review' ? 0.6 : undefined

  // dupFilter == 'only' 면 status를 duplicate로 override
  const effectiveStatus = dupFilter === 'only' ? 'duplicate' : (status || undefined)

  const listQuery = useQuery({
    queryKey: ['auto-voucher-list', effectiveStatus, sourceType, from, to, confBand, counterparty, page, dupFilter],
    queryFn: () =>
      autoVoucherApi.list({
        status: effectiveStatus,
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

  const allItems: AutoVoucherCandidate[] = listQuery.data?.items || []
  // dupFilter='hide'이면 클라이언트단에서 DUPLICATE 행 제외 (status='pending' 선택 시에도 보호)
  const items: AutoVoucherCandidate[] = dupFilter === 'hide'
    ? allItems.filter((c) => c.status !== 'duplicate')
    : allItems
  const total: number = listQuery.data?.total || 0
  const summary: Record<string, Record<string, number>> = listQuery.data?.summary || {}

  const [taskId, setTaskId] = useState<string | null>(null)
  const [taskProgress, setTaskProgress] = useState<any>(null)

  const generateMut = useMutation({
    mutationFn: () =>
      autoVoucherApi.generateCandidates({
        start_date: from, end_date: to, auto_match_duplicates: true,
      }, true),
    onSuccess: (res) => {
      const tid = res.data?.task_id
      if (tid) {
        setTaskId(tid)
        setTaskProgress({ status: 'queued', percent: 0, message: '큐 진입 중…' })
      }
    },
  })

  const matchVoucherDupMut = useMutation({
    mutationFn: () => autoVoucherApi.matchVoucherDuplicates(from, to),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['auto-voucher-list'] }),
  })

  useEffect(() => {
    if (!taskId) return
    let cancelled = false
    const tick = async () => {
      try {
        const r = await autoVoucherApi.getProgress(taskId)
        if (cancelled) return
        setTaskProgress(r.data)
        if (r.data?.status === 'completed' || r.data?.status === 'failed') {
          qc.invalidateQueries({ queryKey: ['auto-voucher-list'] })
          setTimeout(() => {
            if (!cancelled) { setTaskId(null); setTaskProgress(null) }
          }, 5000)
          return
        }
        setTimeout(tick, 1000)
      } catch {
        if (!cancelled) {
          setTaskProgress({ status: 'failed', message: '진행률 조회 실패' })
          setTimeout(() => { if (!cancelled) { setTaskId(null); setTaskProgress(null) } }, 3000)
        }
      }
    }
    tick()
    return () => { cancelled = true }
  }, [taskId, qc])

  const confirmMut = useMutation({
    mutationFn: (id: number) => autoVoucherApi.confirm(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['auto-voucher-list'] }),
  })

  // 일괄 확정 task — 200건 초과는 backend가 자동으로 background로 처리
  // localStorage에 task_id 영속화 → 페이지 이동/새로고침해도 진행률 복원
  const [batchTaskId, setBatchTaskIdRaw] = useState<string | null>(() => {
    try { return localStorage.getItem('auto-voucher-batch-task-id') } catch { return null }
  })
  const setBatchTaskId = (v: string | null) => {
    setBatchTaskIdRaw(v)
    try {
      if (v) localStorage.setItem('auto-voucher-batch-task-id', v)
      else localStorage.removeItem('auto-voucher-batch-task-id')
    } catch {}
  }
  const [batchProgress, setBatchProgress] = useState<any>(null)

  const confirmBatchMut = useMutation({
    mutationFn: async (ids: number[]) => {
      const useBackground = ids.length > 200
      const r = await autoVoucherApi.confirmBatch(ids, 1, useBackground)
      return r
    },
    onSuccess: (res) => {
      if (res.data?.task_id) {
        // background task
        setBatchTaskId(res.data.task_id)
        setBatchProgress({ status: 'queued', percent: 0, message: '큐 진입 중…' })
      } else {
        // 즉시 결과
        qc.invalidateQueries({ queryKey: ['auto-voucher-list'] })
        setSelectedIds(new Set())
      }
    },
  })

  // 일괄 확정 진행률 폴링 (2초 간격) — localStorage에 task_id 영속화돼서 페이지 이동/새로고침 무관
  useEffect(() => {
    if (!batchTaskId) return
    let cancelled = false
    let vanish_count = 0
    const tick = async () => {
      try {
        const r = await autoVoucherApi.getProgress(batchTaskId)
        if (cancelled) return
        setBatchProgress(r.data)
        if (r.data?.status === 'completed' || r.data?.status === 'failed') {
          qc.invalidateQueries({ queryKey: ['auto-voucher-list'] })
          setSelectedIds(new Set())
          // 완료 후 5초 뒤 localStorage cleanup
          setTimeout(() => {
            if (!cancelled) setBatchTaskId(null)
          }, 5000)
          return
        }
        setTimeout(tick, 2000)
      } catch (e: any) {
        // 404 (task 사라짐) — Railway 재배포로 in-memory 휘발 가능
        if (e?.response?.status === 404) {
          vanish_count += 1
          if (vanish_count >= 3) {
            if (!cancelled) {
              setBatchProgress(null)
              setBatchTaskId(null)
            }
            return
          }
        }
        if (!cancelled) setTimeout(tick, 5000)
      }
    }
    tick()
    return () => { cancelled = true }
  }, [batchTaskId, qc])

  // 전체 페이지의 모든 pending 후보 ID를 가져옴
  const selectAllPagesMut = useMutation({
    mutationFn: () => autoVoucherApi.list({
      status: 'pending',
      source_type: sourceType || undefined,
      start_date: from || undefined,
      end_date: to || undefined,
      confidence_lt: confidenceLt,
      confidence_gte: confidenceGte,
      counterparty: counterparty || undefined,
      page: 1,
      size: 50000,
    }),
    onSuccess: (res) => {
      const ids = (res.data?.items || []).map((i: any) => i.id)
      setSelectedIds(new Set(ids))
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
            그랜터 수집 거래 → AI 분개 → 검수 → 확정. 위하고 분개장 import는 자동 중복 표시.
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
            onClick={() => setShowMigrateModal(true)}
            className="px-2 py-1.5 text-xs font-semibold text-purple-700 bg-purple-50 border border-purple-200 rounded hover:bg-purple-100"
            title="위하고 분개장(이미 분개된 데이터)을 정식 전표로 일괄 등록"
          >
            <ArrowUpOnSquareIcon className="h-3.5 w-3.5 mr-1 inline" />
            위하고 분개장 일괄 등록
          </button>
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

      {/* Progress */}
      {taskProgress && (
        <div className={`rounded-md border px-3 py-2 ${
          taskProgress.status === 'completed' ? 'border-emerald-200 bg-emerald-50' :
          taskProgress.status === 'failed' ? 'border-rose-200 bg-rose-50' :
          'border-blue-200 bg-blue-50'
        }`}>
          <div className="flex items-center justify-between text-2xs mb-1">
            <span className={`font-semibold ${
              taskProgress.status === 'completed' ? 'text-emerald-800' :
              taskProgress.status === 'failed' ? 'text-rose-800' :
              'text-blue-800'
            }`}>
              {taskProgress.status === 'completed' ? '✓ 완료' :
               taskProgress.status === 'failed' ? '✗ 실패' :
               '⏳ 진행 중'} · {taskProgress.message}
            </span>
            <span className="text-2xs font-mono text-ink-600">{taskProgress.percent || 0}%</span>
          </div>
          <div className="h-1.5 bg-white rounded-full overflow-hidden border border-ink-100">
            <div
              className={`h-full transition-all ${
                taskProgress.status === 'failed' ? 'bg-rose-500' :
                taskProgress.status === 'completed' ? 'bg-emerald-500' :
                'bg-blue-500'
              }`}
              style={{ width: `${taskProgress.percent || 0}%` }}
            />
          </div>
          {taskProgress.result && (
            <div className="mt-1.5 text-2xs text-emerald-800">
              <strong>{taskProgress.result.total_created || 0}건</strong> 생성
              (매출 {taskProgress.result.sales_tax_invoice || 0} /
              {' '}매입 {taskProgress.result.purchase_tax_invoice || 0} /
              {' '}카드 {taskProgress.result.card || 0} /
              {' '}통장 {taskProgress.result.bank || 0} /
              {' '}현금 {taskProgress.result.cash_receipt || 0})
              {taskProgress.result.skipped > 0 && <span className="ml-2">· {taskProgress.result.skipped}건 skip</span>}
              {taskProgress.result.duplicate_matching?.matched_pairs > 0 && (
                <span className="ml-2">· 카드↔통장 매칭 {taskProgress.result.duplicate_matching.matched_pairs}쌍</span>
              )}
              {taskProgress.result.voucher_duplicate_matching?.matched > 0 && (
                <span className="ml-2 text-amber-800 font-semibold">
                  · 기존 전표 중복 <strong>{taskProgress.result.voucher_duplicate_matching.matched}건</strong>
                </span>
              )}
            </div>
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
            ].map((s) => (
              <button key={s.v}
                onClick={() => { setStatus(status === s.v ? '' : s.v); setPage(1) }}
                disabled={dupFilter === 'only'}
                className={`px-2 py-0.5 rounded text-2xs font-semibold border ${status === s.v && dupFilter !== 'only' ? s.tone : 'bg-white text-ink-500 border-ink-200 hover:border-ink-300'} ${dupFilter === 'only' ? 'opacity-40 cursor-not-allowed' : ''}`}
              >
                {s.label}
              </button>
            ))}
          </div>

          {/* 중복 표시 토글 */}
          <div className="flex items-center gap-1">
            <span className="text-2xs font-semibold text-ink-500 uppercase">중복</span>
            {[
              { v: 'hide' as DupFilter, label: '숨김', tone: 'bg-ink-900 text-white border-ink-900' },
              { v: 'include' as DupFilter, label: '포함', tone: 'bg-amber-100 text-amber-800 border-amber-200' },
              { v: 'only' as DupFilter, label: `중복만 ${duplicateCount || ''}`, tone: 'bg-amber-500 text-white border-amber-500' },
            ].map((s) => (
              <button key={s.v}
                onClick={() => { setDupFilter(s.v); setPage(1) }}
                className={`px-2 py-0.5 rounded text-2xs font-semibold border ${dupFilter === s.v ? s.tone : 'bg-white text-ink-500 border-ink-200 hover:border-ink-300'}`}
              >
                {s.label}
              </button>
            ))}
            <button
              onClick={() => matchVoucherDupMut.mutate()}
              disabled={matchVoucherDupMut.isPending}
              className="ml-1 px-2 py-0.5 rounded text-2xs font-semibold bg-white text-purple-700 border border-purple-300 hover:bg-purple-50 disabled:opacity-50"
              title="기존 전표(위하고 import 등)와 비교해 중복 후보를 다시 매칭"
            >
              <ArrowPathIcon className="h-3 w-3 mr-0.5 inline" />
              {matchVoucherDupMut.isPending ? '검사 중…' : '중복 재검사'}
            </button>
            {matchVoucherDupMut.data && (
              <span className="text-2xs text-purple-700 ml-1">
                {matchVoucherDupMut.data.data?.matched || 0}건 매칭됨
              </span>
            )}
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
        {status === 'pending' && dupFilter !== 'only' && (
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
              현재 페이지 전체
            </button>
            <button
              onClick={() => selectAllPagesMut.mutate()}
              disabled={selectAllPagesMut.isPending}
              className="text-2xs font-semibold text-blue-700 hover:underline disabled:opacity-50"
              title="모든 페이지의 pending 후보 전체 선택 (필터 적용)"
            >
              {selectAllPagesMut.isPending ? '불러오는 중…' : `전체 페이지 선택 (총 ${pendingCount}건)`}
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
        {/* 백그라운드 task 진행률 */}
        {batchTaskId && batchProgress && (
          <div className={`rounded-md border px-3 py-2 mt-2 ${
            batchProgress.status === 'completed' ? 'border-emerald-200 bg-emerald-50' :
            batchProgress.status === 'failed' ? 'border-rose-200 bg-rose-50' :
            'border-blue-200 bg-blue-50'
          }`}>
            <div className="flex items-center justify-between text-2xs mb-1">
              <span className={`font-semibold ${
                batchProgress.status === 'completed' ? 'text-emerald-800' :
                batchProgress.status === 'failed' ? 'text-rose-800' : 'text-blue-800'
              }`}>
                {batchProgress.status === 'completed' ? '✓ 완료' :
                 batchProgress.status === 'failed' ? '✗ 실패' : '⏳ 진행 중'} · {batchProgress.message}
              </span>
              <span className="text-2xs font-mono text-ink-600">{batchProgress.percent || 0}%</span>
            </div>
            <div className="h-1.5 bg-white rounded-full overflow-hidden border border-ink-100">
              <div
                className={`h-full transition-all ${
                  batchProgress.status === 'failed' ? 'bg-rose-500' :
                  batchProgress.status === 'completed' ? 'bg-emerald-500' : 'bg-blue-500'
                }`}
                style={{ width: `${batchProgress.percent || 0}%` }}
              />
            </div>
            {batchProgress.success_count !== undefined && (
              <div className="mt-1 text-2xs text-ink-700">
                확정 <strong>{batchProgress.success_count}</strong>건
                {batchProgress.failure_count > 0 && (
                  <> · <span className="text-rose-700">실패 <strong>{batchProgress.failure_count}</strong>건</span></>
                )}
              </div>
            )}
            {(batchProgress.recent_failures || []).length > 0 && (
              <details className="mt-1" open>
                <summary className="cursor-pointer text-2xs text-rose-700 font-semibold">
                  최근 실패 사유
                </summary>
                <div className="mt-1 space-y-0.5 text-2xs bg-white rounded p-1.5 border border-rose-100 max-h-24 overflow-y-auto">
                  {batchProgress.recent_failures.map((r: string, i: number) => (
                    <div key={i} className="text-rose-800 break-all">· {r}</div>
                  ))}
                </div>
              </details>
            )}
            {batchProgress.status === 'completed' && (
              <button onClick={() => { setBatchTaskId(null); setBatchProgress(null) }}
                className="mt-1.5 text-2xs text-ink-500 hover:underline">닫기</button>
            )}
          </div>
        )}
        {/* 일괄 확정 결과/상태 — selectedIds와 무관하게 항상 표시 */}
        {confirmBatchMut.isPending && !batchTaskId && (
          <div className="text-2xs pt-2 text-blue-700 font-semibold flex items-center gap-1.5 border-t border-blue-100 mt-2 pt-2">
            <span className="inline-block w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
            확정 처리 중… (서버 응답 대기)
          </div>
        )}
        {confirmBatchMut.isError && !batchTaskId && (
          <div className="text-2xs pt-2 text-rose-700 border-t border-rose-100 mt-2 pt-2">
            <strong>✗ 일괄 확정 실패:</strong> {(confirmBatchMut.error as any)?.response?.data?.detail
              || (confirmBatchMut.error as any)?.message
              || '알 수 없는 오류'}
          </div>
        )}
        {confirmBatchMut.isSuccess && !batchTaskId && (
          <div className="text-2xs pt-2 space-y-1 border-t border-emerald-100 mt-2 pt-2">
            {(() => {
              const r = confirmBatchMut.data?.data || {}
              const newOk = r.success_count || 0
              const already = r.already_confirmed_count || 0
              const skipped = r.skipped_count || 0
              const failed = r.failure_count || 0
              const totalOk = newOk + already
              return (
                <>
                  <div className="text-ink-700 leading-relaxed">
                    {totalOk > 0 && (
                      <span className="text-emerald-700 font-bold text-xs">
                        ✓ 확정 {totalOk}건
                      </span>
                    )}
                    {totalOk === 0 && failed === 0 && skipped === 0 && (
                      <span className="text-ink-500">처리된 항목 없음</span>
                    )}
                    {newOk > 0 && already > 0 && (
                      <span className="text-ink-500 ml-1.5">
                        (신규 {newOk} + 이미 처리됨 {already})
                      </span>
                    )}
                    {newOk > 0 && already === 0 && (
                      <span className="text-ink-500 ml-1.5">(전부 신규)</span>
                    )}
                    {newOk === 0 && already > 0 && (
                      <span className="text-amber-600 ml-1.5">(전부 다른 작업이 먼저 처리함 — 안전)</span>
                    )}
                    {skipped > 0 && (
                      <span className="text-ink-500 ml-2">· skip {skipped}건 (거절/중복)</span>
                    )}
                    {failed > 0 && (
                      <span className="text-rose-600 ml-2">· 실패 <strong>{failed}건</strong></span>
                    )}
                  </div>
                  {failed > 0 && (r.failures || []).length > 0 && (
                    <details className="text-rose-700" open>
                      <summary className="cursor-pointer font-semibold">실패 사유 ({(r.failures||[]).length}건)</summary>
                      <div className="mt-1 pl-3 max-h-32 overflow-y-auto space-y-0.5">
                        {(r.failures || []).slice(0, 10).map((f: any, i: number) => (
                          <div key={i} className="break-all">· {f.reason}</div>
                        ))}
                      </div>
                    </details>
                  )}
                  <button onClick={() => confirmBatchMut.reset()}
                    className="text-2xs text-ink-400 hover:text-ink-700 underline">결과 닫기</button>
                </>
              )
            })()}
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
                  <th className="px-2 py-2 text-left font-semibold text-ink-500 uppercase tracking-wider min-w-[180px]">거래처</th>
                  <th className="px-2 py-2 text-left font-semibold text-ink-500 uppercase tracking-wider min-w-[200px]">적요</th>
                  <th className="px-2 py-2 text-right font-semibold text-ink-500 uppercase tracking-wider">공급가</th>
                  <th className="px-2 py-2 text-right font-semibold text-ink-500 uppercase tracking-wider">부가세</th>
                  <th className="px-2 py-2 text-right font-semibold text-ink-500 uppercase tracking-wider">합계</th>
                  <th className="px-2 py-2 text-center font-semibold text-ink-500 uppercase tracking-wider">신뢰도</th>
                  <th className="px-2 py-2 text-center font-semibold text-ink-500 uppercase tracking-wider min-w-[160px]">상태/액션</th>
                </tr>
              </thead>
              <tbody>
                {items.map((c) => {
                  const conf = confidenceTone(c.confidence)
                  const isExpanded = expandedIds.has(c.id)
                  const isSelected = selectedIds.has(c.id)
                  const isPending = c.status === 'pending'
                  const isDup = c.status === 'duplicate'
                  const dupVoucher = c.duplicate_voucher
                  const dupSourceLabel = dupVoucher?.source ? (VOUCHER_SOURCE_LABEL[dupVoucher.source] || dupVoucher.source) : null
                  return (
                    <>
                      <tr key={c.id}
                        className={`border-b border-ink-100 hover:bg-ink-50/30 ${
                          isSelected ? 'bg-blue-50/40' :
                          isDup ? 'bg-amber-50/50 border-l-4 border-l-amber-400' : ''
                        }`}
                      >
                        <td className="px-2 py-1">
                          {isPending && (
                            <input type="checkbox" checked={isSelected}
                              onChange={() => toggleSelect(c.id)}
                              className="rounded border-ink-300 w-3 h-3" />
                          )}
                          {isDup && (
                            <ExclamationTriangleIcon className="h-4 w-4 text-amber-500"
                              aria-label="이미 분개됨"
                            />
                          )}
                        </td>
                        <td className="px-2 py-1 font-mono text-ink-700">{c.transaction_date}</td>
                        <td className="px-2 py-1">
                          <span className={`inline-block px-1.5 py-0.5 rounded border text-2xs ${SOURCE_TONE[c.source_type] || 'bg-ink-50 text-ink-600 border-ink-200'} ${isDup ? 'opacity-60' : ''}`}>
                            {SOURCE_LABEL[c.source_type] || c.source_type}
                          </span>
                        </td>
                        <td className={`px-2 py-1 truncate max-w-[220px] ${isDup ? 'text-ink-500' : 'text-ink-800'}`}>
                          {c.counterparty || '-'}
                        </td>
                        <td className={`px-2 py-1 truncate max-w-[260px] ${isDup ? 'text-ink-500' : 'text-ink-700'}`}>
                          <button onClick={() => toggleExpand(c.id)}
                            className="inline-flex items-center gap-1 hover:text-ink-900">
                            {isExpanded ? <ChevronDownIcon className="h-3 w-3" /> : <ChevronRightIcon className="h-3 w-3" />}
                            {c.description || c.suggested_account_name || '-'}
                          </button>
                        </td>
                        <td className={`px-2 py-1 text-right font-mono ${isDup ? 'text-ink-500' : ''}`}>
                          {formatCurrency(Number(c.supply_amount), false)}
                        </td>
                        <td className={`px-2 py-1 text-right font-mono ${isDup ? 'text-ink-400' : 'text-ink-500'}`}>
                          {Number(c.vat_amount) > 0 ? formatCurrency(Number(c.vat_amount), false) : '-'}
                        </td>
                        <td className={`px-2 py-1 text-right font-mono font-semibold ${isDup ? 'text-ink-500' : ''}`}>
                          {formatCurrency(Number(c.total_amount), false)}
                        </td>
                        <td className="px-2 py-1 text-center">
                          <span className={`inline-block px-1.5 py-0.5 rounded text-2xs font-semibold ${isDup ? 'bg-ink-100 text-ink-500' : conf.bg}`}>
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
                          ) : isDup ? (
                            <div className="text-left">
                              {dupVoucher ? (
                                <div className="text-2xs">
                                  <div className="font-semibold text-amber-800">이미 분개됨</div>
                                  <div className="text-ink-600 mt-0.5">
                                    전표 <span className="font-mono">#{dupVoucher.voucher_number}</span>
                                  </div>
                                  {dupSourceLabel && (
                                    <div className="text-ink-500">출처: <span className="text-purple-700 font-semibold">{dupSourceLabel}</span></div>
                                  )}
                                </div>
                              ) : c.duplicate_of_id ? (
                                <span className="text-2xs text-purple-700">카드↔통장 중복 (#{c.duplicate_of_id})</span>
                              ) : (
                                <span className="text-2xs text-amber-700">중복</span>
                              )}
                            </div>
                          ) : (
                            <span className="text-2xs text-ink-500">거절됨</span>
                          )}
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr className="bg-canvas-50 border-b border-ink-100">
                          <td colSpan={10} className="px-4 py-2">
                            {isDup && dupVoucher && (
                              <div className="mb-2 rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-2xs">
                                <div className="flex items-center gap-2 font-semibold text-amber-800">
                                  <ExclamationTriangleIcon className="h-3.5 w-3.5" />
                                  이미 등록된 전표와 동일 거래
                                </div>
                                <div className="mt-1 grid grid-cols-2 gap-x-4 gap-y-0.5 text-ink-700">
                                  <div>전표 번호: <span className="font-mono font-semibold">#{dupVoucher.voucher_number}</span></div>
                                  <div>전표 일자: <span className="font-mono">{dupVoucher.voucher_date}</span></div>
                                  <div>출처: <span className="text-purple-700 font-semibold">{dupSourceLabel}</span></div>
                                  <div>금액: <span className="font-mono">{formatCurrency(Number(dupVoucher.total_debit), false)}</span></div>
                                  {dupVoucher.merchant_name && (
                                    <div className="col-span-2">거래처: {dupVoucher.merchant_name}</div>
                                  )}
                                  {dupVoucher.description && (
                                    <div className="col-span-2">적요: {dupVoucher.description}</div>
                                  )}
                                </div>
                              </div>
                            )}
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

      {/* 위하고 분개장 일괄 등록 모달 */}
      <JournalMigrationModal
        open={showMigrateModal}
        onClose={() => setShowMigrateModal(false)}
        onDone={() => qc.invalidateQueries({ queryKey: ['auto-voucher-list'] })}
      />
    </div>
  )
}
