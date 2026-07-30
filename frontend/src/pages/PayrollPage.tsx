import { useState, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import {
  BanknotesIcon,
  PlusIcon,
  ChevronRightIcon,
  ChevronLeftIcon,
  TrashIcon,
  ArrowPathIcon,
  DocumentCheckIcon,
  ArrowUpTrayIcon,
  ExclamationTriangleIcon,
  CheckCircleIcon,
  XCircleIcon,
} from '@heroicons/react/24/outline'
import { payrollApi } from '@/services/api'
import { useAuthStore } from '@/store/authStore'
import { formatCurrency } from '@/utils/format'

// ─── 타입 정의 ────────────────────────────────────────────────────────────────

type BatchStatus = 'DRAFT' | 'CONFIRMED' | 'POSTED'

interface PayrollBatch {
  id: number
  period: string
  pay_date: string
  title: string | null
  status: BatchStatus
  total_gross: number
  total_deduction: number
  total_net: number
  voucher_id: number | null
  memo?: string | null
}

interface PayrollRecord {
  id: number
  employee_code: string
  employee_name: string
  department: string
  position: string
  cost_type: 'COGS' | 'SGA'
  base_pay: number
  meal_allowance: number
  overtime_pay: number
  bonus: number
  other_allowance: number
  gross_pay: number
  income_tax: number
  local_tax: number
  national_pension: number
  health_insurance: number
  employment_insurance: number
  longterm_care: number
  other_deduction: number
  total_deduction: number
  net_pay: number
}

interface JournalLine {
  account_code: string
  account_name: string
  amount: number
  memo: string
}

interface JournalPreview {
  period: string
  balanced: boolean
  debit_lines: JournalLine[]
  credit_lines: JournalLine[]
  total_debit: number
  total_credit: number
  summary: {
    sga_salary: number
    cogs_salary: number
    withholding: number
    net_pay: number
    headcount: number
  }
}

interface NewRecordForm {
  employee_code: string
  employee_name: string
  department: string
  position: string
  cost_type: 'COGS' | 'SGA'
  base_pay: string
  meal_allowance: string
  overtime_pay: string
  bonus: string
  other_allowance: string
  income_tax: string
  local_tax: string
  national_pension: string
  health_insurance: string
  employment_insurance: string
  longterm_care: string
  other_deduction: string
}

// ─── 헬퍼 ─────────────────────────────────────────────────────────────────────

const EMPTY_RECORD_FORM: NewRecordForm = {
  employee_code: '',
  employee_name: '',
  department: '',
  position: '',
  cost_type: 'SGA',
  base_pay: '',
  meal_allowance: '',
  overtime_pay: '',
  bonus: '',
  other_allowance: '',
  income_tax: '',
  local_tax: '',
  national_pension: '',
  health_insurance: '',
  employment_insurance: '',
  longterm_care: '',
  other_deduction: '',
}

function parseMoney(s: string): number {
  const n = Number(s.replace(/,/g, ''))
  return isNaN(n) ? 0 : n
}

function statusBadge(status: BatchStatus) {
  if (status === 'POSTED') return <span className="badge-success">반영완료</span>
  if (status === 'CONFIRMED') return <span className="badge-info">확정</span>
  return <span className="badge-gray">초안</span>
}

function sum(records: PayrollRecord[], key: keyof PayrollRecord): number {
  return records.reduce((acc, r) => acc + (Number(r[key]) || 0), 0)
}

// ─── 서브 컴포넌트: 배치 생성 모달 ──────────────────────────────────────────

interface CreateBatchModalProps {
  onClose: () => void
  onCreate: (data: { period: string; pay_date: string; title?: string; memo?: string }) => void
  isPending: boolean
}

function CreateBatchModal({ onClose, onCreate, isPending }: CreateBatchModalProps) {
  const today = new Date()
  const defaultPeriod = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`
  const [period, setPeriod] = useState(defaultPeriod)
  const [payDate, setPayDate] = useState('')
  const [title, setTitle] = useState('')
  const [memo, setMemo] = useState('')

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!period || !payDate) {
      toast.error('귀속월과 지급일을 입력해 주세요.')
      return
    }
    onCreate({ period, pay_date: payDate, title: title || undefined, memo: memo || undefined })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900 dark:bg-ink-50/40">
      <div className="bg-white dark:bg-ink-900 rounded-lg shadow-xl w-full max-w-sm p-5 space-y-4">
        <h2 className="text-base font-semibold text-ink-900 dark:text-ink-50">신규 급여 배치 생성</h2>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="label">귀속월 *</label>
            <input
              type="month"
              className="input"
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
              required
            />
          </div>
          <div>
            <label className="label">지급일 *</label>
            <input
              type="date"
              className="input"
              value={payDate}
              onChange={(e) => setPayDate(e.target.value)}
              required
            />
          </div>
          <div>
            <label className="label">배치명 (선택)</label>
            <input
              type="text"
              className="input"
              placeholder="예: 2026-05 정기급여"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div>
            <label className="label">메모 (선택)</label>
            <input
              type="text"
              className="input"
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
            />
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" className="btn-secondary" onClick={onClose}>
              취소
            </button>
            <button type="submit" className="btn-primary" disabled={isPending}>
              {isPending ? '생성 중...' : '생성'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ─── 서브 컴포넌트: 사원 추가 폼 ────────────────────────────────────────────

interface AddRecordFormProps {
  onAdd: (record: NewRecordForm) => void
  isPending: boolean
}

function AddRecordForm({ onAdd, isPending }: AddRecordFormProps) {
  const [form, setForm] = useState<NewRecordForm>(EMPTY_RECORD_FORM)
  const [open, setOpen] = useState(false)

  function set(field: keyof NewRecordForm, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }))
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.employee_name) {
      toast.error('성명을 입력해 주세요.')
      return
    }
    onAdd(form)
    setForm(EMPTY_RECORD_FORM)
    setOpen(false)
  }

  if (!open) {
    return (
      <button className="btn-secondary gap-1" onClick={() => setOpen(true)}>
        <PlusIcon className="h-3.5 w-3.5" />
        사원 추가
      </button>
    )
  }

  const numField = (label: string, field: keyof NewRecordForm) => (
    <div>
      <label className="label">{label}</label>
      <input
        type="number"
        className="input text-right"
        placeholder="0"
        value={form[field]}
        onChange={(e) => set(field, e.target.value)}
        min={0}
      />
    </div>
  )

  return (
    <div className="card border border-ink-200 dark:border-ink-800 mt-3">
      <p className="text-xs font-semibold text-ink-700 dark:text-ink-300 mb-3">사원 급여 입력</p>
      <form onSubmit={handleSubmit}>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2 mb-3">
          <div>
            <label className="label">사원코드</label>
            <input className="input" value={form.employee_code} onChange={(e) => set('employee_code', e.target.value)} />
          </div>
          <div>
            <label className="label">성명 *</label>
            <input className="input" value={form.employee_name} onChange={(e) => set('employee_name', e.target.value)} required />
          </div>
          <div>
            <label className="label">부서</label>
            <input className="input" value={form.department} onChange={(e) => set('department', e.target.value)} />
          </div>
          <div>
            <label className="label">직급</label>
            <input className="input" value={form.position} onChange={(e) => set('position', e.target.value)} />
          </div>
          <div>
            <label className="label">원가구분</label>
            <select className="input" value={form.cost_type} onChange={(e) => set('cost_type', e.target.value as 'COGS' | 'SGA')}>
              <option value="SGA">판관비(SGA)</option>
              <option value="COGS">매출원가(COGS)</option>
            </select>
          </div>
          {numField('기본급', 'base_pay')}
          {numField('식대', 'meal_allowance')}
          {numField('연장수당', 'overtime_pay')}
          {numField('상여', 'bonus')}
          {numField('기타지급', 'other_allowance')}
          {numField('근로소득세', 'income_tax')}
          {numField('지방소득세', 'local_tax')}
          {numField('국민연금', 'national_pension')}
          {numField('건강보험', 'health_insurance')}
          {numField('고용보험', 'employment_insurance')}
          {numField('장기요양', 'longterm_care')}
          {numField('기타공제', 'other_deduction')}
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={() => setOpen(false)}>취소</button>
          <button type="submit" className="btn-primary" disabled={isPending}>
            {isPending ? '저장 중...' : '추가'}
          </button>
        </div>
      </form>
    </div>
  )
}

// ─── 서브 컴포넌트: 분개 미리보기 패널 ──────────────────────────────────────

interface JournalPanelProps {
  batchId: number
  status: BatchStatus
  userId: number
  onStatusChange: () => void
}

function JournalPanel({ batchId, status, userId, onStatusChange }: JournalPanelProps) {
  const [preview, setPreview] = useState<JournalPreview | null>(null)
  const [loadingPreview, setLoadingPreview] = useState(false)

  const postMut = useMutation({
    mutationFn: () => payrollApi.post(batchId, userId),
    onSuccess: () => {
      toast.success('전표가 반영되었습니다.')
      onStatusChange()
      setPreview(null)
    },
    onError: () => toast.error('전표 반영에 실패했습니다.'),
  })

  const unpostMut = useMutation({
    mutationFn: () => payrollApi.unpost(batchId),
    onSuccess: () => {
      toast.success('분개가 취소되었습니다.')
      onStatusChange()
      setPreview(null)
    },
    onError: () => toast.error('분개 취소에 실패했습니다.'),
  })

  async function loadPreview() {
    setLoadingPreview(true)
    try {
      const res = await payrollApi.journalPreview(batchId)
      setPreview(res.data)
    } catch {
      toast.error('분개 미리보기를 불러오지 못했습니다.')
    } finally {
      setLoadingPreview(false)
    }
  }

  return (
    <div className="card space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-ink-900 dark:text-ink-50">계정 분류 · 분개</h3>
        <div className="flex items-center gap-2">
          <button
            className="btn-secondary gap-1"
            onClick={loadPreview}
            disabled={loadingPreview}
          >
            {loadingPreview ? (
              <ArrowPathIcon className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <DocumentCheckIcon className="h-3.5 w-3.5" />
            )}
            분개 미리보기
          </button>
          {status !== 'POSTED' && (
            <button
              className="btn-primary gap-1"
              onClick={() => postMut.mutate()}
              disabled={postMut.isPending}
            >
              {postMut.isPending ? '반영 중...' : '전표 반영'}
            </button>
          )}
          {status === 'POSTED' && (
            <button
              className="btn-danger gap-1"
              onClick={() => unpostMut.mutate()}
              disabled={unpostMut.isPending}
            >
              {unpostMut.isPending ? '취소 중...' : '분개 취소'}
            </button>
          )}
        </div>
      </div>

      {preview && (
        <div className="space-y-3">
          {/* 균형 여부 */}
          <div className={`flex items-center gap-1.5 text-xs font-medium ${preview.balanced ? 'text-emerald-700 dark:text-emerald-300' : 'text-rose-600 dark:text-rose-400'}`}>
            {preview.balanced ? (
              <CheckCircleIcon className="h-4 w-4" />
            ) : (
              <XCircleIcon className="h-4 w-4" />
            )}
            {preview.balanced ? '차대변 균형' : '차대변 불균형 — 금액을 확인해 주세요'}
          </div>

          {/* 요약 */}
          <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
            {[
              { label: '판관비 급여', value: preview.summary.sga_salary },
              { label: '원가 급여', value: preview.summary.cogs_salary },
              { label: '원천징수', value: preview.summary.withholding },
              { label: '실지급 합계', value: preview.summary.net_pay },
              { label: '인원', value: preview.summary.headcount, isCnt: true },
            ].map((s) => (
              <div key={s.label} className="card-tight text-center">
                <p className="text-2xs text-ink-500 dark:text-ink-400">{s.label}</p>
                <p className="text-xs font-semibold text-ink-900 dark:text-ink-50 tabular-nums">
                  {s.isCnt ? `${s.value}명` : formatCurrency(s.value, false)}
                </p>
              </div>
            ))}
          </div>

          {/* 차변 / 대변 */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {/* 차변 */}
            <div>
              <p className="text-2xs font-semibold text-ink-500 dark:text-ink-400 uppercase tracking-wider mb-1">차변 (Debit)</p>
              <div className="table-container">
                <table className="table">
                  <thead className="table-header">
                    <tr>
                      <th>계정코드</th>
                      <th>계정명</th>
                      <th className="text-right">금액</th>
                      <th>메모</th>
                    </tr>
                  </thead>
                  <tbody className="table-body">
                    {preview.debit_lines.map((line, i) => (
                      <tr key={i}>
                        <td className="font-mono text-2xs">{line.account_code}</td>
                        <td>{line.account_name}</td>
                        <td className="amount">{formatCurrency(line.amount, false)}</td>
                        <td className="text-ink-500 dark:text-ink-400 text-2xs">{line.memo}</td>
                      </tr>
                    ))}
                    <tr className="bg-canvas-50 dark:bg-ink-950 font-semibold">
                      <td colSpan={2} className="text-right text-2xs text-ink-600 dark:text-ink-400">합계</td>
                      <td className="amount">{formatCurrency(preview.total_debit, false)}</td>
                      <td />
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            {/* 대변 */}
            <div>
              <p className="text-2xs font-semibold text-ink-500 dark:text-ink-400 uppercase tracking-wider mb-1">대변 (Credit)</p>
              <div className="table-container">
                <table className="table">
                  <thead className="table-header">
                    <tr>
                      <th>계정코드</th>
                      <th>계정명</th>
                      <th className="text-right">금액</th>
                      <th>메모</th>
                    </tr>
                  </thead>
                  <tbody className="table-body">
                    {preview.credit_lines.map((line, i) => (
                      <tr key={i}>
                        <td className="font-mono text-2xs">{line.account_code}</td>
                        <td>{line.account_name}</td>
                        <td className="amount">{formatCurrency(line.amount, false)}</td>
                        <td className="text-ink-500 dark:text-ink-400 text-2xs">{line.memo}</td>
                      </tr>
                    ))}
                    <tr className="bg-canvas-50 dark:bg-ink-950 font-semibold">
                      <td colSpan={2} className="text-right text-2xs text-ink-600 dark:text-ink-400">합계</td>
                      <td className="amount">{formatCurrency(preview.total_credit, false)}</td>
                      <td />
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      )}

      {!preview && (
        <p className="text-xs text-ink-400 text-center py-4">
          "분개 미리보기" 버튼을 누르면 차변·대변 분개를 미리 확인할 수 있습니다.
        </p>
      )}
    </div>
  )
}

// ─── 메인 페이지 ─────────────────────────────────────────────────────────────

export default function PayrollPage() {
  const userId = useAuthStore((s) => s.user?.id ?? 1)
  const qc = useQueryClient()

  // 연도 필터
  const currentYear = new Date().getFullYear()
  const [filterYear, setFilterYear] = useState(currentYear)

  // 선택된 배치
  const [selectedBatchId, setSelectedBatchId] = useState<number | null>(null)

  // 모달
  const [showCreateModal, setShowCreateModal] = useState(false)

  // 엑셀 업로드 ref
  const xlsxInputRef = useRef<HTMLInputElement>(null)

  // ── 쿼리: 배치 목록 ────────────────────────────────────────────────────────
  const batchesQuery = useQuery({
    queryKey: ['payroll-batches', filterYear],
    queryFn: () => payrollApi.listBatches(filterYear).then((r) => r.data as PayrollBatch[]),
  })
  const batches: PayrollBatch[] = batchesQuery.data ?? []

  // ── 쿼리: 선택 배치 상세 ───────────────────────────────────────────────────
  const batchDetailQuery = useQuery({
    queryKey: ['payroll-batch-detail', selectedBatchId],
    queryFn: () => payrollApi.getBatch(selectedBatchId!).then((r) => r.data),
    enabled: selectedBatchId !== null,
  })
  const batchDetail = batchDetailQuery.data as (PayrollBatch & { records: PayrollRecord[] }) | undefined
  const records: PayrollRecord[] = batchDetail?.records ?? []
  const isPosted = batchDetail?.status === 'POSTED'

  // ── 뮤테이션: 배치 생성 ───────────────────────────────────────────────────
  const createBatchMut = useMutation({
    mutationFn: (data: { period: string; pay_date: string; title?: string; memo?: string }) =>
      payrollApi.createBatch(data),
    onSuccess: (res) => {
      toast.success('급여 배치가 생성되었습니다.')
      qc.invalidateQueries({ queryKey: ['payroll-batches'] })
      setShowCreateModal(false)
      setSelectedBatchId(res.data.id)
    },
    onError: () => toast.error('배치 생성에 실패했습니다.'),
  })

  // ── 뮤테이션: 배치 삭제 ───────────────────────────────────────────────────
  const deleteBatchMut = useMutation({
    mutationFn: (id: number) => payrollApi.deleteBatch(id),
    onSuccess: () => {
      toast.success('배치가 삭제되었습니다.')
      qc.invalidateQueries({ queryKey: ['payroll-batches'] })
      setSelectedBatchId(null)
    },
    onError: () => toast.error('삭제에 실패했습니다.'),
  })

  // ── 뮤테이션: 사원 추가 ───────────────────────────────────────────────────
  const addRecordMut = useMutation({
    mutationFn: (form: NewRecordForm) => {
      const gross =
        parseMoney(form.base_pay) +
        parseMoney(form.meal_allowance) +
        parseMoney(form.overtime_pay) +
        parseMoney(form.bonus) +
        parseMoney(form.other_allowance)
      const totalDed =
        parseMoney(form.income_tax) +
        parseMoney(form.local_tax) +
        parseMoney(form.national_pension) +
        parseMoney(form.health_insurance) +
        parseMoney(form.employment_insurance) +
        parseMoney(form.longterm_care) +
        parseMoney(form.other_deduction)
      const record = {
        employee_code: form.employee_code,
        employee_name: form.employee_name,
        department: form.department,
        position: form.position,
        cost_type: form.cost_type,
        base_pay: parseMoney(form.base_pay),
        meal_allowance: parseMoney(form.meal_allowance),
        overtime_pay: parseMoney(form.overtime_pay),
        bonus: parseMoney(form.bonus),
        other_allowance: parseMoney(form.other_allowance),
        gross_pay: gross,
        income_tax: parseMoney(form.income_tax),
        local_tax: parseMoney(form.local_tax),
        national_pension: parseMoney(form.national_pension),
        health_insurance: parseMoney(form.health_insurance),
        employment_insurance: parseMoney(form.employment_insurance),
        longterm_care: parseMoney(form.longterm_care),
        other_deduction: parseMoney(form.other_deduction),
        total_deduction: totalDed,
        net_pay: gross - totalDed,
      }
      return payrollApi.saveRecords(selectedBatchId!, [record], false)
    },
    onSuccess: () => {
      toast.success('사원이 추가되었습니다.')
      qc.invalidateQueries({ queryKey: ['payroll-batch-detail', selectedBatchId] })
      qc.invalidateQueries({ queryKey: ['payroll-batches'] })
    },
    onError: () => toast.error('사원 추가에 실패했습니다.'),
  })

  // ── 뮤테이션: 레코드 삭제 ─────────────────────────────────────────────────
  const deleteRecordMut = useMutation({
    mutationFn: (id: number) => payrollApi.deleteRecord(id),
    onSuccess: () => {
      toast.success('삭제되었습니다.')
      qc.invalidateQueries({ queryKey: ['payroll-batch-detail', selectedBatchId] })
      qc.invalidateQueries({ queryKey: ['payroll-batches'] })
    },
    onError: () => toast.error('삭제에 실패했습니다.'),
  })

  function invalidateBatch() {
    qc.invalidateQueries({ queryKey: ['payroll-batch-detail', selectedBatchId] })
    qc.invalidateQueries({ queryKey: ['payroll-batches'] })
  }

  // ── 엑셀 업로드 안내 ──────────────────────────────────────────────────────
  function handleXlsxClick() {
    toast('급여대장 업로드 기능은 추후 제공 예정입니다.', { icon: '📋' })
  }

  // ── 합계 행 계산 ──────────────────────────────────────────────────────────
  const totalGross = sum(records, 'gross_pay')
  const totalDeduction = sum(records, 'total_deduction')
  const totalNet = sum(records, 'net_pay')

  // ─── 렌더 ─────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-4">
      {/* 페이지 헤더 */}
      <div className="flex items-end justify-between flex-wrap gap-2">
        <div>
          <h1 className="flex items-center gap-2">
            <BanknotesIcon className="h-5 w-5 text-ink-500 dark:text-ink-400" />
            급여 관리
          </h1>
          <p className="text-xs text-ink-500 dark:text-ink-400 mt-0.5">인건비 배치 생성 · 사원 급여 입력 · 분개 전표 반영</p>
        </div>
        <div className="flex items-center gap-2">
          {/* 연도 필터 */}
          <select
            className="input w-auto"
            value={filterYear}
            onChange={(e) => {
              setFilterYear(Number(e.target.value))
              setSelectedBatchId(null)
            }}
          >
            {[currentYear - 1, currentYear, currentYear + 1].map((y) => (
              <option key={y} value={y}>{y}년</option>
            ))}
          </select>
          <button
            className="btn-primary gap-1"
            onClick={() => setShowCreateModal(true)}
          >
            <PlusIcon className="h-3.5 w-3.5" />
            신규 급여 배치
          </button>
        </div>
      </div>

      {/* (A) 배치 목록 */}
      <div className="card p-0 overflow-hidden">
        <div className="px-3.5 py-2.5 border-b border-ink-100 dark:border-ink-800 flex items-center justify-between">
          <span className="text-xs font-semibold text-ink-700 dark:text-ink-300">{filterYear}년 급여 배치</span>
          {batchesQuery.isFetching && (
            <ArrowPathIcon className="h-3.5 w-3.5 animate-spin text-ink-400" />
          )}
        </div>

        {batchesQuery.isLoading ? (
          <div className="py-12 text-center text-xs text-ink-400">불러오는 중...</div>
        ) : batches.length === 0 ? (
          <div className="py-12 text-center text-xs text-ink-400">
            {filterYear}년 급여 배치가 없습니다. 신규 배치를 생성해 주세요.
          </div>
        ) : (
          <div className="table-container border-0 rounded-none">
            <table className="table">
              <thead className="table-header">
                <tr>
                  <th>귀속월</th>
                  <th>지급일</th>
                  <th>배치명</th>
                  <th className="text-right">총지급액</th>
                  <th className="text-right">공제계</th>
                  <th className="text-right">실지급액</th>
                  <th>상태</th>
                  <th className="text-right">작업</th>
                </tr>
              </thead>
              <tbody className="table-body">
                {batches.map((batch) => (
                  <tr
                    key={batch.id}
                    className={`cursor-pointer transition-colors ${
                      selectedBatchId === batch.id ? 'bg-ink-50 dark:bg-ink-900 ring-1 ring-inset ring-ink-300 dark:ring-ink-600' : ''
                    }`}
                    onClick={() => setSelectedBatchId(batch.id)}
                  >
                    <td className="font-medium">{batch.period}</td>
                    <td>{batch.pay_date}</td>
                    <td className="text-ink-600 dark:text-ink-400">{batch.title || '-'}</td>
                    <td className="amount">{formatCurrency(batch.total_gross, false)}</td>
                    <td className="amount text-rose-600 dark:text-rose-400">{formatCurrency(batch.total_deduction, false)}</td>
                    <td className="amount text-emerald-700 dark:text-emerald-300 font-semibold">{formatCurrency(batch.total_net, false)}</td>
                    <td>{statusBadge(batch.status)}</td>
                    <td className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          className="btn-ghost p-1"
                          title="상세 보기"
                          onClick={(e) => {
                            e.stopPropagation()
                            setSelectedBatchId(batch.id)
                          }}
                        >
                          <ChevronRightIcon className="h-3.5 w-3.5" />
                        </button>
                        {batch.status !== 'POSTED' && (
                          <button
                            className="btn-ghost p-1 text-rose-500 hover:text-rose-700"
                            title="배치 삭제"
                            onClick={(e) => {
                              e.stopPropagation()
                              if (confirm(`'${batch.period}' 배치를 삭제하시겠습니까?`)) {
                                deleteBatchMut.mutate(batch.id)
                              }
                            }}
                          >
                            <TrashIcon className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* (B) + (C): 배치 상세 */}
      {selectedBatchId !== null && (
        <div className="space-y-4">
          {/* 상단: 배치 정보 바 */}
          <div className="flex items-center gap-2 flex-wrap">
            <button
              className="btn-ghost gap-1 text-ink-500 dark:text-ink-400"
              onClick={() => setSelectedBatchId(null)}
            >
              <ChevronLeftIcon className="h-3.5 w-3.5" />
              목록
            </button>
            {batchDetail && (
              <>
                <span className="text-xs text-ink-400">/</span>
                <span className="text-xs font-semibold text-ink-900 dark:text-ink-50">
                  {batchDetail.period} — {batchDetail.title || '급여배치'}
                </span>
                <span className="text-xs text-ink-500 dark:text-ink-400">지급일 {batchDetail.pay_date}</span>
                {statusBadge(batchDetail.status)}
              </>
            )}
            {batchDetailQuery.isFetching && (
              <ArrowPathIcon className="h-3.5 w-3.5 animate-spin text-ink-400" />
            )}
          </div>

          {/* (B) 사원 급여 테이블 */}
          <div className="card p-0 overflow-hidden">
            <div className="px-3.5 py-2.5 border-b border-ink-100 dark:border-ink-800 flex items-center justify-between gap-2 flex-wrap">
              <span className="text-xs font-semibold text-ink-700 dark:text-ink-300">사원별 급여 명세</span>
              <div className="flex items-center gap-2">
                {/* 엑셀 업로드 — UI만, 실제 파싱은 추후 */}
                <input
                  ref={xlsxInputRef}
                  type="file"
                  accept=".xlsx,.xls,.csv"
                  className="hidden"
                  onChange={handleXlsxClick}
                />
                <button
                  className="btn-secondary gap-1 opacity-60 cursor-not-allowed"
                  title="급여대장 업로드 (양식 준비중)"
                  onClick={handleXlsxClick}
                >
                  <ArrowUpTrayIcon className="h-3.5 w-3.5" />
                  급여대장 업로드
                </button>
              </div>
            </div>

            {isPosted && (
              <div className="flex items-center gap-1.5 px-3.5 py-2 bg-amber-50 dark:bg-amber-950 border-b border-amber-200 dark:border-amber-800 text-xs text-amber-700 dark:text-amber-300">
                <ExclamationTriangleIcon className="h-3.5 w-3.5 flex-shrink-0" />
                전표 반영 완료 상태입니다. 수정·삭제하려면 먼저 분개를 취소해 주세요.
              </div>
            )}

            {batchDetailQuery.isLoading ? (
              <div className="py-10 text-center text-xs text-ink-400">불러오는 중...</div>
            ) : records.length === 0 ? (
              <div className="py-10 text-center text-xs text-ink-400">
                아직 급여 데이터가 없습니다. 사원을 추가해 주세요.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="table min-w-[1100px]">
                  <thead className="table-header">
                    <tr>
                      <th>사원코드</th>
                      <th>성명</th>
                      <th>부서</th>
                      <th>직급</th>
                      <th>구분</th>
                      <th className="text-right">기본급</th>
                      <th className="text-right">식대</th>
                      <th className="text-right">연장</th>
                      <th className="text-right">상여</th>
                      <th className="text-right">기타</th>
                      <th className="text-right">총지급</th>
                      <th className="text-right">공제계</th>
                      <th className="text-right">실지급</th>
                      {!isPosted && <th className="text-right">작업</th>}
                    </tr>
                  </thead>
                  <tbody className="table-body">
                    {records.map((r) => (
                      <tr key={r.id}>
                        <td className="font-mono text-2xs">{r.employee_code || '-'}</td>
                        <td className="font-medium">{r.employee_name}</td>
                        <td className="text-ink-600 dark:text-ink-400">{r.department || '-'}</td>
                        <td className="text-ink-600 dark:text-ink-400">{r.position || '-'}</td>
                        <td>
                          {r.cost_type === 'COGS' ? (
                            <span className="badge-info">COGS</span>
                          ) : (
                            <span className="badge-gray">SGA</span>
                          )}
                        </td>
                        <td className="amount">{formatCurrency(r.base_pay, false)}</td>
                        <td className="amount">{formatCurrency(r.meal_allowance, false)}</td>
                        <td className="amount">{formatCurrency(r.overtime_pay, false)}</td>
                        <td className="amount">{formatCurrency(r.bonus, false)}</td>
                        <td className="amount">{formatCurrency(r.other_allowance, false)}</td>
                        <td className="amount font-semibold">{formatCurrency(r.gross_pay, false)}</td>
                        <td className="amount text-rose-600 dark:text-rose-400">{formatCurrency(r.total_deduction, false)}</td>
                        <td className="amount text-emerald-700 dark:text-emerald-300 font-semibold">{formatCurrency(r.net_pay, false)}</td>
                        {!isPosted && (
                          <td className="text-right">
                            <button
                              className="btn-ghost p-1 text-rose-500 hover:text-rose-700"
                              onClick={() => {
                                if (confirm(`${r.employee_name} 급여를 삭제하시겠습니까?`)) {
                                  deleteRecordMut.mutate(r.id)
                                }
                              }}
                            >
                              <TrashIcon className="h-3.5 w-3.5" />
                            </button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                  {/* 합계 행 */}
                  <tfoot>
                    <tr className="bg-canvas-50 dark:bg-ink-950 border-t border-ink-200 dark:border-ink-800">
                      <td colSpan={5} className="px-2.5 py-1.5 text-right text-2xs font-semibold text-ink-600 dark:text-ink-400">
                        합계 ({records.length}명)
                      </td>
                      <td className="amount font-semibold text-ink-900 dark:text-ink-50 px-2.5 py-1.5 whitespace-nowrap">{formatCurrency(sum(records, 'base_pay'), false)}</td>
                      <td className="amount font-semibold text-ink-900 dark:text-ink-50 px-2.5 py-1.5 whitespace-nowrap">{formatCurrency(sum(records, 'meal_allowance'), false)}</td>
                      <td className="amount font-semibold text-ink-900 dark:text-ink-50 px-2.5 py-1.5 whitespace-nowrap">{formatCurrency(sum(records, 'overtime_pay'), false)}</td>
                      <td className="amount font-semibold text-ink-900 dark:text-ink-50 px-2.5 py-1.5 whitespace-nowrap">{formatCurrency(sum(records, 'bonus'), false)}</td>
                      <td className="amount font-semibold text-ink-900 dark:text-ink-50 px-2.5 py-1.5 whitespace-nowrap">{formatCurrency(sum(records, 'other_allowance'), false)}</td>
                      <td className="amount font-bold text-ink-900 dark:text-ink-50 px-2.5 py-1.5 whitespace-nowrap">{formatCurrency(totalGross, false)}</td>
                      <td className="amount font-bold text-rose-600 dark:text-rose-400 px-2.5 py-1.5 whitespace-nowrap">{formatCurrency(totalDeduction, false)}</td>
                      <td className="amount font-bold text-emerald-700 dark:text-emerald-300 px-2.5 py-1.5 whitespace-nowrap">{formatCurrency(totalNet, false)}</td>
                      {!isPosted && <td />}
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}

            {/* 사원 추가 폼 */}
            {!isPosted && (
              <div className="px-3.5 py-3 border-t border-ink-100 dark:border-ink-800">
                <AddRecordForm
                  onAdd={(form) => addRecordMut.mutate(form)}
                  isPending={addRecordMut.isPending}
                />
              </div>
            )}
          </div>

          {/* (C) 분개 패널 */}
          {batchDetail && (
            <JournalPanel
              batchId={batchDetail.id}
              status={batchDetail.status}
              userId={userId}
              onStatusChange={invalidateBatch}
            />
          )}
        </div>
      )}

      {/* 배치 생성 모달 */}
      {showCreateModal && (
        <CreateBatchModal
          onClose={() => setShowCreateModal(false)}
          onCreate={(data) => createBatchMut.mutate(data)}
          isPending={createBatchMut.isPending}
        />
      )}
    </div>
  )
}
