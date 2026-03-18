import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { surveyApi } from '@/services/api'
import {
  PlusIcon,
  ArrowDownTrayIcon,
  PencilIcon,
  TrashIcon,
  CheckCircleIcon,
  XCircleIcon,
  MagnifyingGlassIcon,
  ClockIcon,
} from '@heroicons/react/24/outline'

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────
type TabType = 'surveys' | 'responses' | 'commute' | 'attendance'

interface Survey {
  id: number
  title: string
  description?: string
  category: string
  status: 'draft' | 'published' | 'closed'
  response_count?: number
  start_date?: string
  end_date?: string
  questions?: Question[]
  created_at: string
}

interface Question {
  id?: number
  order: number
  text: string
  type: 'text' | 'choice' | 'scale' | 'boolean' | 'number'
  required: boolean
  options?: string[]
}

interface SurveyResponse {
  id: number
  survey_id: number
  survey_title?: string
  respondent_name?: string
  department?: string
  submitted_at: string
  answers?: { question_id: number; question_text?: string; value: any }[]
}

interface CommuteRecord {
  id: number
  employee_name?: string
  date: string
  check_in?: string
  check_out?: string
  transport_method?: string
  note?: string
  duration_minutes?: number
}

interface AttendanceSummary {
  employee_id?: number
  employee_name: string
  department?: string
  work_days: number
  late_count: number
  early_leave_count: number
  absent_count: number
  avg_commute_minutes?: number
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
const CATEGORY_OPTIONS = [
  { value: 'daily_checkin', label: '출퇴근 일일설문' },
  { value: 'satisfaction', label: '만족도 설문' },
  { value: 'hr', label: '인사관리' },
  { value: 'general', label: '일반' },
]

const QUESTION_TYPES = [
  { value: 'text', label: '단답형' },
  { value: 'choice', label: '선택형' },
  { value: 'scale', label: '척도형 (1-5)' },
  { value: 'boolean', label: '예/아니오' },
  { value: 'number', label: '숫자' },
]

const TRANSPORT_OPTIONS = ['도보', '대중교통', '자가용', '자전거', '기타']

function statusBadge(status: string) {
  const map: Record<string, { cls: string; label: string }> = {
    draft: { cls: 'bg-gray-100 text-gray-700', label: '초안' },
    published: { cls: 'bg-green-100 text-green-700', label: '배포중' },
    closed: { cls: 'bg-red-100 text-red-700', label: '마감' },
  }
  const item = map[status] ?? { cls: 'bg-gray-100 text-gray-600', label: status }
  return <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${item.cls}`}>{item.label}</span>
}

function categoryLabel(category: string) {
  return CATEGORY_OPTIONS.find((c) => c.value === category)?.label ?? category
}

function fmtDate(iso?: string) {
  if (!iso) return '-'
  return iso.slice(0, 10)
}

function fmtTime(iso?: string) {
  if (!iso) return '-'
  const d = new Date(iso)
  return d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
}

function minutesToHM(min?: number) {
  if (min == null) return '-'
  const h = Math.floor(min / 60)
  const m = min % 60
  return h > 0 ? `${h}시간 ${m}분` : `${m}분`
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Page
// ─────────────────────────────────────────────────────────────────────────────
export default function SurveyCommutePage() {
  const [activeTab, setActiveTab] = useState<TabType>('surveys')

  const tabs: { id: TabType; label: string }[] = [
    { id: 'surveys', label: '설문 관리' },
    { id: 'responses', label: '응답 조회' },
    { id: 'commute', label: '출퇴근 기록' },
    { id: 'attendance', label: '출석 현황' },
  ]

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">설문 / 출퇴근 관리</h1>
        <p className="text-gray-500 mt-1">설문을 만들고 출퇴근 현황을 관리합니다.</p>
      </div>

      {/* Tabs */}
      <div className="border-b border-gray-200">
        <nav className="flex gap-4">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`pb-3 px-1 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab.id
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {activeTab === 'surveys' && <SurveyManagementTab />}
      {activeTab === 'responses' && <ResponseViewTab />}
      {activeTab === 'commute' && <CommuteRecordTab />}
      {activeTab === 'attendance' && <AttendanceSummaryTab />}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Tab 1: Survey Management
// ─────────────────────────────────────────────────────────────────────────────
function SurveyManagementTab() {
  const queryClient = useQueryClient()
  const [filterCategory, setFilterCategory] = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  const [showModal, setShowModal] = useState(false)
  const [editingSurvey, setEditingSurvey] = useState<Survey | null>(null)

  const { data: surveys = [], isLoading } = useQuery<Survey[]>({
    queryKey: ['surveys', filterCategory, filterStatus],
    queryFn: () =>
      surveyApi
        .list({ category: filterCategory || undefined, status: filterStatus || undefined })
        .then((r) => r.data),
  })

  const createMutation = useMutation({
    mutationFn: (data: any) => surveyApi.create(data),
    onSuccess: () => {
      toast.success('설문이 생성되었습니다.')
      queryClient.invalidateQueries({ queryKey: ['surveys'] })
      setShowModal(false)
    },
    onError: (e: any) => toast.error(e.response?.data?.detail || '생성에 실패했습니다.'),
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: any }) => surveyApi.update(id, data),
    onSuccess: () => {
      toast.success('설문이 수정되었습니다.')
      queryClient.invalidateQueries({ queryKey: ['surveys'] })
      setShowModal(false)
      setEditingSurvey(null)
    },
    onError: (e: any) => toast.error(e.response?.data?.detail || '수정에 실패했습니다.'),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: number) => surveyApi.delete(id),
    onSuccess: () => {
      toast.success('설문이 삭제되었습니다.')
      queryClient.invalidateQueries({ queryKey: ['surveys'] })
    },
    onError: (e: any) => toast.error(e.response?.data?.detail || '삭제에 실패했습니다.'),
  })

  const publishMutation = useMutation({
    mutationFn: (id: number) => surveyApi.publish(id),
    onSuccess: () => {
      toast.success('설문이 배포되었습니다.')
      queryClient.invalidateQueries({ queryKey: ['surveys'] })
    },
    onError: (e: any) => toast.error(e.response?.data?.detail || '배포에 실패했습니다.'),
  })

  const closeMutation = useMutation({
    mutationFn: (id: number) => surveyApi.close(id),
    onSuccess: () => {
      toast.success('설문이 마감되었습니다.')
      queryClient.invalidateQueries({ queryKey: ['surveys'] })
    },
    onError: (e: any) => toast.error(e.response?.data?.detail || '마감에 실패했습니다.'),
  })

  const handleCreateFromTemplate = async (templateType: string) => {
    try {
      await surveyApi.createFromTemplate(templateType)
      toast.success('템플릿으로 설문이 생성되었습니다.')
      queryClient.invalidateQueries({ queryKey: ['surveys'] })
    } catch (e: any) {
      toast.error(e.response?.data?.detail || '템플릿 생성에 실패했습니다.')
    }
  }

  const handleDelete = (id: number) => {
    if (window.confirm('이 설문을 삭제하시겠습니까?')) {
      deleteMutation.mutate(id)
    }
  }

  const openCreate = () => {
    setEditingSurvey(null)
    setShowModal(true)
  }

  const openEdit = (survey: Survey) => {
    setEditingSurvey(survey)
    setShowModal(true)
  }

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3">
        <select
          value={filterCategory}
          onChange={(e) => setFilterCategory(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="">전체 카테고리</option>
          {CATEGORY_OPTIONS.map((c) => (
            <option key={c.value} value={c.value}>{c.label}</option>
          ))}
        </select>
        <select
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="">전체 상태</option>
          <option value="draft">초안</option>
          <option value="published">배포중</option>
          <option value="closed">마감</option>
        </select>
        <div className="flex-1" />
        {/* Template Quick-Create */}
        <button
          onClick={() => handleCreateFromTemplate('daily_checkin')}
          className="inline-flex items-center gap-1 px-3 py-2 rounded-lg border border-blue-300 text-blue-700 text-sm hover:bg-blue-50 transition-colors"
        >
          <PlusIcon className="h-4 w-4" />
          출퇴근 일일설문
        </button>
        <button
          onClick={() => handleCreateFromTemplate('satisfaction')}
          className="inline-flex items-center gap-1 px-3 py-2 rounded-lg border border-purple-300 text-purple-700 text-sm hover:bg-purple-50 transition-colors"
        >
          <PlusIcon className="h-4 w-4" />
          만족도 설문
        </button>
        <button
          onClick={openCreate}
          className="inline-flex items-center gap-1 px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 transition-colors"
        >
          <PlusIcon className="h-4 w-4" />
          새 설문 만들기
        </button>
      </div>

      {/* Survey Cards */}
      {isLoading ? (
        <div className="text-center py-12 text-gray-500">불러오는 중...</div>
      ) : surveys.length === 0 ? (
        <div className="text-center py-12 text-gray-400">
          <p className="text-lg font-medium">설문이 없습니다.</p>
          <p className="text-sm mt-1">새 설문을 만들거나 템플릿을 사용해보세요.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {surveys.map((survey) => (
            <div key={survey.id} className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm hover:shadow-md transition-shadow">
              <div className="flex items-start justify-between mb-3">
                <div className="flex-1 min-w-0">
                  <h3 className="font-semibold text-gray-900 truncate">{survey.title}</h3>
                  {survey.description && (
                    <p className="text-sm text-gray-500 mt-0.5 line-clamp-2">{survey.description}</p>
                  )}
                </div>
                <div className="ml-2 flex-shrink-0">{statusBadge(survey.status)}</div>
              </div>

              <div className="flex flex-wrap gap-2 mb-3">
                <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-50 text-blue-700">
                  {categoryLabel(survey.category)}
                </span>
                {survey.response_count != null && (
                  <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-600">
                    응답 {survey.response_count}건
                  </span>
                )}
              </div>

              {(survey.start_date || survey.end_date) && (
                <p className="text-xs text-gray-400 mb-3">
                  {fmtDate(survey.start_date)} ~ {fmtDate(survey.end_date)}
                </p>
              )}

              <div className="flex items-center gap-2 pt-3 border-t border-gray-100">
                {survey.status === 'draft' && (
                  <button
                    onClick={() => publishMutation.mutate(survey.id)}
                    disabled={publishMutation.isPending}
                    className="flex-1 py-1.5 text-xs font-medium rounded-lg bg-green-50 text-green-700 hover:bg-green-100 transition-colors disabled:opacity-50"
                  >
                    배포
                  </button>
                )}
                {survey.status === 'published' && (
                  <button
                    onClick={() => closeMutation.mutate(survey.id)}
                    disabled={closeMutation.isPending}
                    className="flex-1 py-1.5 text-xs font-medium rounded-lg bg-yellow-50 text-yellow-700 hover:bg-yellow-100 transition-colors disabled:opacity-50"
                  >
                    마감
                  </button>
                )}
                <button
                  onClick={() => openEdit(survey)}
                  className="flex-1 py-1.5 text-xs font-medium rounded-lg bg-gray-50 text-gray-700 hover:bg-gray-100 transition-colors"
                >
                  수정
                </button>
                <button
                  onClick={() => handleDelete(survey.id)}
                  disabled={deleteMutation.isPending}
                  className="flex-1 py-1.5 text-xs font-medium rounded-lg bg-red-50 text-red-700 hover:bg-red-100 transition-colors disabled:opacity-50"
                >
                  삭제
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Survey Create/Edit Modal */}
      {showModal && (
        <SurveyFormModal
          survey={editingSurvey}
          onClose={() => { setShowModal(false); setEditingSurvey(null) }}
          onSubmit={(data) => {
            if (editingSurvey) {
              updateMutation.mutate({ id: editingSurvey.id, data })
            } else {
              createMutation.mutate(data)
            }
          }}
          isPending={createMutation.isPending || updateMutation.isPending}
        />
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Survey Form Modal
// ─────────────────────────────────────────────────────────────────────────────
interface SurveyFormModalProps {
  survey: Survey | null
  onClose: () => void
  onSubmit: (data: any) => void
  isPending: boolean
}

function SurveyFormModal({ survey, onClose, onSubmit, isPending }: SurveyFormModalProps) {
  const [title, setTitle] = useState(survey?.title ?? '')
  const [description, setDescription] = useState(survey?.description ?? '')
  const [category, setCategory] = useState(survey?.category ?? 'general')
  const [startDate, setStartDate] = useState(survey?.start_date?.slice(0, 10) ?? '')
  const [endDate, setEndDate] = useState(survey?.end_date?.slice(0, 10) ?? '')
  const [questions, setQuestions] = useState<Question[]>(
    survey?.questions ?? [{ order: 1, text: '', type: 'text', required: true }]
  )

  const addQuestion = () => {
    setQuestions((prev) => [
      ...prev,
      { order: prev.length + 1, text: '', type: 'text', required: false },
    ])
  }

  const removeQuestion = (index: number) => {
    setQuestions((prev) => prev.filter((_, i) => i !== index).map((q, i) => ({ ...q, order: i + 1 })))
  }

  const updateQuestion = (index: number, field: keyof Question, value: any) => {
    setQuestions((prev) => prev.map((q, i) => (i === index ? { ...q, [field]: value } : q)))
  }

  const handleSubmit = (e: React.FormEvent | React.MouseEvent) => {
    e.preventDefault()
    if (!title.trim()) { toast.error('설문 제목을 입력하세요.'); return }
    if (questions.some((q) => !q.text.trim())) { toast.error('모든 질문 내용을 입력하세요.'); return }
    onSubmit({ title, description, category, start_date: startDate || null, end_date: endDate || null, questions })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <h2 className="text-lg font-bold text-gray-900">{survey ? '설문 수정' : '새 설문 만들기'}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <XCircleIcon className="h-6 w-6" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="overflow-y-auto flex-1 p-6 space-y-5">
          {/* Basic info */}
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">설문 제목 <span className="text-red-500">*</span></label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="설문 제목을 입력하세요"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">설명</label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="설문 설명 (선택)"
              />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">카테고리</label>
                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {CATEGORY_OPTIONS.map((c) => (
                    <option key={c.value} value={c.value}>{c.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">시작일</label>
                <input
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">종료일</label>
                <input
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>
          </div>

          {/* Questions builder */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-gray-800">질문 목록</h3>
              <button
                type="button"
                onClick={addQuestion}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-blue-50 text-blue-700 text-xs font-medium hover:bg-blue-100 transition-colors"
              >
                <PlusIcon className="h-3.5 w-3.5" />
                질문 추가
              </button>
            </div>
            <div className="space-y-3">
              {questions.map((q, idx) => (
                <div key={idx} className="border border-gray-200 rounded-lg p-4 bg-gray-50">
                  <div className="flex items-center gap-2 mb-3">
                    <span className="w-6 h-6 rounded-full bg-blue-600 text-white text-xs font-bold flex items-center justify-center flex-shrink-0">
                      {idx + 1}
                    </span>
                    <input
                      type="text"
                      value={q.text}
                      onChange={(e) => updateQuestion(idx, 'text', e.target.value)}
                      className="flex-1 border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                      placeholder="질문 내용을 입력하세요"
                    />
                    <button
                      type="button"
                      onClick={() => removeQuestion(idx)}
                      className="text-red-400 hover:text-red-600 flex-shrink-0"
                      disabled={questions.length <= 1}
                    >
                      <TrashIcon className="h-4 w-4" />
                    </button>
                  </div>
                  <div className="flex items-center gap-3">
                    <select
                      value={q.type}
                      onChange={(e) => updateQuestion(idx, 'type', e.target.value)}
                      className="border border-gray-300 rounded-lg px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                    >
                      {QUESTION_TYPES.map((t) => (
                        <option key={t.value} value={t.value}>{t.label}</option>
                      ))}
                    </select>
                    <label className="flex items-center gap-1.5 text-xs text-gray-600">
                      <input
                        type="checkbox"
                        checked={q.required}
                        onChange={(e) => updateQuestion(idx, 'required', e.target.checked)}
                        className="rounded"
                      />
                      필수 응답
                    </label>
                    {q.type === 'choice' && (
                      <input
                        type="text"
                        value={(q.options ?? []).join(',')}
                        onChange={(e) => updateQuestion(idx, 'options', e.target.value.split(',').map((s) => s.trim()))}
                        className="flex-1 border border-gray-300 rounded-lg px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                        placeholder="선택지 입력 (쉼표로 구분)"
                      />
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </form>

        <div className="flex justify-end gap-3 px-6 py-4 border-t">
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors">
            취소
          </button>
          <button
            onClick={handleSubmit}
            disabled={isPending}
            className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50"
          >
            {isPending ? '저장 중...' : survey ? '수정 저장' : '설문 생성'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Tab 2: Response View (CRITICAL TAB)
// ─────────────────────────────────────────────────────────────────────────────
function ResponseViewTab() {
  const queryClient = useQueryClient()
  const [surveyId, setSurveyId] = useState<string>('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [employeeName, setEmployeeName] = useState('')
  const [page, setPage] = useState(1)
  const pageSize = 20
  const [editingResponse, setEditingResponse] = useState<SurveyResponse | null>(null)

  // Survey list for dropdown
  const { data: surveys = [] } = useQuery<Survey[]>({
    queryKey: ['surveys'],
    queryFn: () => surveyApi.list().then((r) => r.data),
  })

  // Response list
  const { data: responsesData, isLoading } = useQuery({
    queryKey: ['surveyResponses', surveyId, dateFrom, dateTo, employeeName, page],
    queryFn: () =>
      surveyApi
        .getResponses({
          survey_id: surveyId || undefined,
          date_from: dateFrom || undefined,
          date_to: dateTo || undefined,
          employee_name: employeeName || undefined,
          page,
          size: pageSize,
        })
        .then((r) => r.data),
    placeholderData: (prev) => prev,
  })

  const responses: SurveyResponse[] = responsesData?.items ?? responsesData ?? []
  const totalCount: number = responsesData?.total ?? responses.length
  const totalPages = Math.ceil(totalCount / pageSize)

  const deleteMutation = useMutation({
    mutationFn: (id: number) => surveyApi.deleteResponse(id),
    onSuccess: () => {
      toast.success('응답이 삭제되었습니다.')
      queryClient.invalidateQueries({ queryKey: ['surveyResponses'] })
    },
    onError: (e: any) => toast.error(e.response?.data?.detail || '삭제에 실패했습니다.'),
  })

  const handleDelete = (id: number) => {
    if (window.confirm('이 응답을 삭제하시겠습니까?')) {
      deleteMutation.mutate(id)
    }
  }

  const handleExportExcel = async () => {
    try {
      const res = await surveyApi.exportResponses({
        survey_id: surveyId || undefined,
        date_from: dateFrom || undefined,
        date_to: dateTo || undefined,
        employee_name: employeeName || undefined,
      })
      const url = window.URL.createObjectURL(new Blob([res.data]))
      const link = document.createElement('a')
      link.href = url
      link.setAttribute('download', `설문응답_${new Date().toISOString().slice(0, 10)}.xlsx`)
      document.body.appendChild(link)
      link.click()
      link.remove()
      window.URL.revokeObjectURL(url)
      toast.success('엑셀 파일이 다운로드되었습니다.')
    } catch {
      toast.error('엑셀 다운로드에 실패했습니다.')
    }
  }

  const handleSearch = () => {
    setPage(1)
    queryClient.invalidateQueries({ queryKey: ['surveyResponses'] })
  }

  return (
    <div className="space-y-4">
      {/* Filter Bar */}
      <div className="bg-white border border-gray-200 rounded-xl p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-gray-600">설문 선택</label>
            <select
              value={surveyId}
              onChange={(e) => setSurveyId(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">전체 설문</option>
              {surveys.map((s) => (
                <option key={s.id} value={s.id}>{s.title}</option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-gray-600">시작일</label>
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-gray-600">종료일</label>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-gray-600">직원 검색</label>
            <div className="relative">
              <MagnifyingGlassIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
              <input
                type="text"
                value={employeeName}
                onChange={(e) => setEmployeeName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                className="border border-gray-300 rounded-lg pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="직원명 검색"
              />
            </div>
          </div>
          <button
            onClick={handleSearch}
            className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors"
          >
            검색
          </button>
          <div className="flex-1" />
          <button
            onClick={handleExportExcel}
            className="inline-flex items-center gap-1.5 px-4 py-2 border border-gray-300 text-sm font-medium text-gray-700 rounded-lg hover:bg-gray-50 transition-colors"
          >
            <ArrowDownTrayIcon className="h-4 w-4" />
            엑셀 다운로드
          </button>
        </div>
      </div>

      {/* Response Table */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        {isLoading ? (
          <div className="text-center py-12 text-gray-500">불러오는 중...</div>
        ) : responses.length === 0 ? (
          <div className="text-center py-12 text-gray-400">
            <p className="font-medium">응답 데이터가 없습니다.</p>
            <p className="text-sm mt-1">필터 조건을 변경해보세요.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  {['No', '응답자', '부서', '설문명', '응답일', '제출시간', '액션'].map((h) => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {responses.map((resp, idx) => (
                  <tr key={resp.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3 text-sm text-gray-500">{(page - 1) * pageSize + idx + 1}</td>
                    <td className="px-4 py-3 text-sm font-medium text-gray-900">{resp.respondent_name ?? '-'}</td>
                    <td className="px-4 py-3 text-sm text-gray-600">{resp.department ?? '-'}</td>
                    <td className="px-4 py-3 text-sm text-gray-800 max-w-[200px] truncate">{resp.survey_title ?? '-'}</td>
                    <td className="px-4 py-3 text-sm text-gray-600">{fmtDate(resp.submitted_at)}</td>
                    <td className="px-4 py-3 text-sm text-gray-600">{fmtTime(resp.submitted_at)}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => setEditingResponse(resp)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 transition-colors"
                        >
                          <PencilIcon className="h-3 w-3" />
                          수정
                        </button>
                        <button
                          onClick={() => handleDelete(resp.id)}
                          disabled={deleteMutation.isPending}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium text-red-700 bg-red-50 hover:bg-red-100 transition-colors disabled:opacity-50"
                        >
                          <TrashIcon className="h-3 w-3" />
                          삭제
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-gray-500">총 {totalCount}건</p>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
              className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-40 transition-colors"
            >
              이전
            </button>
            {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
              const pageNum = Math.max(1, page - 2) + i
              if (pageNum > totalPages) return null
              return (
                <button
                  key={pageNum}
                  onClick={() => setPage(pageNum)}
                  className={`px-3 py-1.5 text-sm border rounded-lg transition-colors ${
                    pageNum === page
                      ? 'bg-blue-600 text-white border-blue-600'
                      : 'border-gray-300 hover:bg-gray-50'
                  }`}
                >
                  {pageNum}
                </button>
              )
            })}
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page === totalPages}
              className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-40 transition-colors"
            >
              다음
            </button>
          </div>
        </div>
      )}

      {/* Edit Response Modal */}
      {editingResponse && (
        <ResponseEditModal
          response={editingResponse}
          onClose={() => setEditingResponse(null)}
          onSaved={() => {
            setEditingResponse(null)
            queryClient.invalidateQueries({ queryKey: ['surveyResponses'] })
          }}
        />
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Response Edit Modal
// ─────────────────────────────────────────────────────────────────────────────
interface ResponseEditModalProps {
  response: SurveyResponse
  onClose: () => void
  onSaved: () => void
}

function ResponseEditModal({ response, onClose, onSaved }: ResponseEditModalProps) {
  const [answers, setAnswers] = useState<{ question_id: number; question_text?: string; value: any }[]>(
    response.answers ?? []
  )

  // Fetch full response with answers
  const { data: fullResponse, isLoading } = useQuery({
    queryKey: ['surveyResponse', response.id],
    queryFn: () => surveyApi.getResponse(response.id).then((r) => r.data),
  })

  useEffect(() => {
    if (fullResponse?.answers) {
      setAnswers(fullResponse.answers)
    }
  }, [fullResponse])

  const updateMutation = useMutation({
    mutationFn: (data: any) => surveyApi.updateResponse(response.id, data),
    onSuccess: () => {
      toast.success('응답이 수정되었습니다.')
      onSaved()
    },
    onError: (e: any) => toast.error(e.response?.data?.detail || '수정에 실패했습니다.'),
  })

  const updateAnswer = (idx: number, value: any) => {
    setAnswers((prev) => prev.map((a, i) => (i === idx ? { ...a, value } : a)))
  }

  const handleSave = () => {
    updateMutation.mutate({ answers })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <div>
            <h2 className="text-lg font-bold text-gray-900">응답 수정</h2>
            <p className="text-sm text-gray-500">{response.respondent_name} · {fmtDate(response.submitted_at)}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <XCircleIcon className="h-6 w-6" />
          </button>
        </div>

        <div className="overflow-y-auto flex-1 p-6">
          {isLoading ? (
            <div className="text-center py-8 text-gray-500">불러오는 중...</div>
          ) : answers.length === 0 ? (
            <div className="text-center py-8 text-gray-400">응답 데이터가 없습니다.</div>
          ) : (
            <div className="space-y-4">
              {answers.map((answer, idx) => (
                <div key={idx} className="border border-gray-200 rounded-lg p-4">
                  <p className="text-sm font-medium text-gray-800 mb-2">
                    Q{idx + 1}. {answer.question_text ?? `질문 ${answer.question_id}`}
                  </p>
                  <input
                    type="text"
                    value={answer.value ?? ''}
                    onChange={(e) => updateAnswer(idx, e.target.value)}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-3 px-6 py-4 border-t">
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors">
            취소
          </button>
          <button
            onClick={handleSave}
            disabled={updateMutation.isPending || isLoading}
            className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50"
          >
            {updateMutation.isPending ? '저장 중...' : '저장'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Tab 3: Commute Record
// ─────────────────────────────────────────────────────────────────────────────
function CommuteRecordTab() {
  const queryClient = useQueryClient()
  const now = new Date()
  const [year, setYear] = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth() + 1)
  const [showForm, setShowForm] = useState(false)
  const [editingRecord, setEditingRecord] = useState<CommuteRecord | null>(null)

  const { data: records = [], isLoading } = useQuery<CommuteRecord[]>({
    queryKey: ['commuteRecords', year, month],
    queryFn: () =>
      surveyApi.getCommuteRecords({ year, month }).then((r) => r.data?.items ?? r.data ?? []),
  })

  const checkInMutation = useMutation({
    mutationFn: () => surveyApi.checkIn(),
    onSuccess: () => {
      toast.success('출근이 기록되었습니다.')
      queryClient.invalidateQueries({ queryKey: ['commuteRecords'] })
    },
    onError: (e: any) => toast.error(e.response?.data?.detail || '출근 기록에 실패했습니다.'),
  })

  const checkOutMutation = useMutation({
    mutationFn: () => surveyApi.checkOut(),
    onSuccess: () => {
      toast.success('퇴근이 기록되었습니다.')
      queryClient.invalidateQueries({ queryKey: ['commuteRecords'] })
    },
    onError: (e: any) => toast.error(e.response?.data?.detail || '퇴근 기록에 실패했습니다.'),
  })

  const createMutation = useMutation({
    mutationFn: (data: any) => surveyApi.createCommute(data),
    onSuccess: () => {
      toast.success('출퇴근 기록이 추가되었습니다.')
      queryClient.invalidateQueries({ queryKey: ['commuteRecords'] })
      setShowForm(false)
    },
    onError: (e: any) => toast.error(e.response?.data?.detail || '추가에 실패했습니다.'),
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: any }) => surveyApi.updateCommute(id, data),
    onSuccess: () => {
      toast.success('출퇴근 기록이 수정되었습니다.')
      queryClient.invalidateQueries({ queryKey: ['commuteRecords'] })
      setEditingRecord(null)
      setShowForm(false)
    },
    onError: (e: any) => toast.error(e.response?.data?.detail || '수정에 실패했습니다.'),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: number) => surveyApi.deleteCommute(id),
    onSuccess: () => {
      toast.success('기록이 삭제되었습니다.')
      queryClient.invalidateQueries({ queryKey: ['commuteRecords'] })
    },
    onError: (e: any) => toast.error(e.response?.data?.detail || '삭제에 실패했습니다.'),
  })

  const handleDelete = (id: number) => {
    if (window.confirm('이 기록을 삭제하시겠습니까?')) {
      deleteMutation.mutate(id)
    }
  }

  const openEdit = (record: CommuteRecord) => {
    setEditingRecord(record)
    setShowForm(true)
  }

  const openCreate = () => {
    setEditingRecord(null)
    setShowForm(true)
  }

  // Build calendar grid for the month
  const daysInMonth = new Date(year, month, 0).getDate()
  const recordMap: Record<string, CommuteRecord> = {}
  records.forEach((r) => { recordMap[r.date] = r })

  return (
    <div className="space-y-5">
      {/* Check-in / Check-out buttons */}
      <div className="bg-white border border-gray-200 rounded-xl p-5">
        <h3 className="text-base font-semibold text-gray-800 mb-4 flex items-center gap-2">
          <ClockIcon className="h-5 w-5 text-blue-600" />
          오늘 출퇴근
        </h3>
        <div className="flex gap-4">
          <button
            onClick={() => checkInMutation.mutate()}
            disabled={checkInMutation.isPending}
            className="flex-1 py-4 rounded-xl bg-green-500 hover:bg-green-600 text-white text-lg font-bold transition-colors disabled:opacity-50 shadow-sm"
          >
            {checkInMutation.isPending ? '처리 중...' : '출근'}
          </button>
          <button
            onClick={() => checkOutMutation.mutate()}
            disabled={checkOutMutation.isPending}
            className="flex-1 py-4 rounded-xl bg-orange-500 hover:bg-orange-600 text-white text-lg font-bold transition-colors disabled:opacity-50 shadow-sm"
          >
            {checkOutMutation.isPending ? '처리 중...' : '퇴근'}
          </button>
        </div>
      </div>

      {/* Month selector + Add button */}
      <div className="flex items-center gap-3">
        <select
          value={year}
          onChange={(e) => setYear(Number(e.target.value))}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          {[now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1].map((y) => (
            <option key={y} value={y}>{y}년</option>
          ))}
        </select>
        <select
          value={month}
          onChange={(e) => setMonth(Number(e.target.value))}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
            <option key={m} value={m}>{m}월</option>
          ))}
        </select>
        <div className="flex-1" />
        <button
          onClick={openCreate}
          className="inline-flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors"
        >
          <PlusIcon className="h-4 w-4" />
          수동 입력
        </button>
      </div>

      {/* Monthly Table */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        {isLoading ? (
          <div className="text-center py-12 text-gray-500">불러오는 중...</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  {['날짜', '요일', '출근', '퇴근', '근무시간', '이동수단', '비고', '액션'].map((h) => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {Array.from({ length: daysInMonth }, (_, i) => {
                  const day = i + 1
                  const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
                  const record = recordMap[dateStr]
                  const dow = new Date(dateStr).getDay()
                  const isWeekend = dow === 0 || dow === 6
                  const dowLabel = ['일', '월', '화', '수', '목', '금', '토'][dow]

                  return (
                    <tr key={dateStr} className={`${isWeekend ? 'bg-gray-50' : 'hover:bg-blue-50/30'} transition-colors`}>
                      <td className={`px-4 py-2.5 text-sm font-medium ${isWeekend ? 'text-gray-400' : 'text-gray-900'}`}>
                        {dateStr}
                      </td>
                      <td className={`px-4 py-2.5 text-sm font-medium ${dow === 0 ? 'text-red-500' : dow === 6 ? 'text-blue-500' : 'text-gray-500'}`}>
                        {dowLabel}
                      </td>
                      <td className="px-4 py-2.5 text-sm text-gray-600">
                        {record?.check_in ? (
                          <span className="text-green-700 font-medium">{record.check_in.slice(0, 5)}</span>
                        ) : '-'}
                      </td>
                      <td className="px-4 py-2.5 text-sm text-gray-600">
                        {record?.check_out ? (
                          <span className="text-orange-700 font-medium">{record.check_out.slice(0, 5)}</span>
                        ) : '-'}
                      </td>
                      <td className="px-4 py-2.5 text-sm text-gray-600">
                        {minutesToHM(record?.duration_minutes)}
                      </td>
                      <td className="px-4 py-2.5 text-sm text-gray-600">{record?.transport_method ?? '-'}</td>
                      <td className="px-4 py-2.5 text-sm text-gray-500 max-w-[120px] truncate">{record?.note ?? '-'}</td>
                      <td className="px-4 py-2.5">
                        {record && (
                          <div className="flex items-center gap-1.5">
                            <button
                              onClick={() => openEdit(record)}
                              className="p-1 text-blue-600 hover:bg-blue-50 rounded transition-colors"
                              title="수정"
                            >
                              <PencilIcon className="h-3.5 w-3.5" />
                            </button>
                            <button
                              onClick={() => handleDelete(record.id)}
                              disabled={deleteMutation.isPending}
                              className="p-1 text-red-500 hover:bg-red-50 rounded transition-colors disabled:opacity-50"
                              title="삭제"
                            >
                              <TrashIcon className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Commute Manual Entry Modal */}
      {showForm && (
        <CommuteFormModal
          record={editingRecord}
          defaultDate={`${year}-${String(month).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`}
          onClose={() => { setShowForm(false); setEditingRecord(null) }}
          onSubmit={(data) => {
            if (editingRecord) {
              updateMutation.mutate({ id: editingRecord.id, data })
            } else {
              createMutation.mutate(data)
            }
          }}
          isPending={createMutation.isPending || updateMutation.isPending}
        />
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Commute Form Modal
// ─────────────────────────────────────────────────────────────────────────────
interface CommuteFormModalProps {
  record: CommuteRecord | null
  defaultDate: string
  onClose: () => void
  onSubmit: (data: any) => void
  isPending: boolean
}

function CommuteFormModal({ record, defaultDate, onClose, onSubmit, isPending }: CommuteFormModalProps) {
  const [date, setDate] = useState(record?.date ?? defaultDate)
  const [checkIn, setCheckIn] = useState(record?.check_in ?? '')
  const [checkOut, setCheckOut] = useState(record?.check_out ?? '')
  const [transport, setTransport] = useState(record?.transport_method ?? '')
  const [note, setNote] = useState(record?.note ?? '')

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!date) { toast.error('날짜를 선택하세요.'); return }
    onSubmit({ date, check_in: checkIn || null, check_out: checkOut || null, transport_method: transport || null, note: note || null })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md">
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <h2 className="text-lg font-bold text-gray-900">{record ? '출퇴근 기록 수정' : '출퇴근 수동 입력'}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <XCircleIcon className="h-6 w-6" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">날짜 <span className="text-red-500">*</span></label>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">출근 시간</label>
              <input
                type="time"
                value={checkIn}
                onChange={(e) => setCheckIn(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">퇴근 시간</label>
              <input
                type="time"
                value={checkOut}
                onChange={(e) => setCheckOut(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">이동수단</label>
            <select
              value={transport}
              onChange={(e) => setTransport(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">선택</option>
              {TRANSPORT_OPTIONS.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">비고</label>
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="메모 (선택)"
            />
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors">
              취소
            </button>
            <button
              type="submit"
              disabled={isPending}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50"
            >
              {isPending ? '저장 중...' : record ? '수정 저장' : '저장'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Tab 4: Attendance Summary
// ─────────────────────────────────────────────────────────────────────────────
function AttendanceSummaryTab() {
  const now = new Date()
  const [year, setYear] = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth() + 1)
  const [department, setDepartment] = useState('')

  const { data: summaryData, isLoading } = useQuery({
    queryKey: ['commuteSummary', year, month, department],
    queryFn: () =>
      surveyApi
        .getCommuteSummary({ year, month, department: department || undefined })
        .then((r) => r.data),
  })

  const summaries: AttendanceSummary[] = summaryData?.items ?? summaryData ?? []

  const handleExportExcel = async () => {
    try {
      const res = await surveyApi.exportCommute({ year, month, department: department || undefined })
      const url = window.URL.createObjectURL(new Blob([res.data]))
      const link = document.createElement('a')
      link.href = url
      link.setAttribute('download', `출석현황_${year}${String(month).padStart(2, '0')}.xlsx`)
      document.body.appendChild(link)
      link.click()
      link.remove()
      window.URL.revokeObjectURL(url)
      toast.success('엑셀 파일이 다운로드되었습니다.')
    } catch {
      toast.error('엑셀 다운로드에 실패했습니다.')
    }
  }

  const getAttendanceColor = (record: AttendanceSummary) => {
    if (record.absent_count > 3) return 'bg-red-50'
    if (record.late_count === 0 && record.absent_count === 0 && record.early_leave_count === 0) return 'bg-green-50/60'
    return ''
  }

  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3">
        <select
          value={year}
          onChange={(e) => setYear(Number(e.target.value))}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          {[now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1].map((y) => (
            <option key={y} value={y}>{y}년</option>
          ))}
        </select>
        <select
          value={month}
          onChange={(e) => setMonth(Number(e.target.value))}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
            <option key={m} value={m}>{m}월</option>
          ))}
        </select>
        <input
          type="text"
          value={department}
          onChange={(e) => setDepartment(e.target.value)}
          placeholder="부서 필터"
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <div className="flex-1" />
        <button
          onClick={handleExportExcel}
          className="inline-flex items-center gap-1.5 px-4 py-2 border border-gray-300 text-sm font-medium text-gray-700 rounded-lg hover:bg-gray-50 transition-colors"
        >
          <ArrowDownTrayIcon className="h-4 w-4" />
          엑셀 다운로드
        </button>
      </div>

      {/* Legend */}
      <div className="flex items-center gap-4 text-xs text-gray-500">
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-3 h-3 rounded bg-green-100 border border-green-300" />
          개근
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-3 h-3 rounded bg-red-100 border border-red-300" />
          결근 3일 초과
        </span>
      </div>

      {/* Summary Table */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        {isLoading ? (
          <div className="text-center py-12 text-gray-500">불러오는 중...</div>
        ) : summaries.length === 0 ? (
          <div className="text-center py-12 text-gray-400">
            <p className="font-medium">출석 데이터가 없습니다.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  {['직원명', '사번', '부서', '출근일수', '지각', '조퇴', '결근', '평균 통근시간'].map((h) => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {summaries.map((s, idx) => (
                  <tr key={idx} className={`${getAttendanceColor(s)} transition-colors`}>
                    <td className="px-4 py-3 text-sm font-semibold text-gray-900">{s.employee_name}</td>
                    <td className="px-4 py-3 text-sm text-gray-600">{s.employee_id ?? '-'}</td>
                    <td className="px-4 py-3 text-sm text-gray-600">{s.department ?? '-'}</td>
                    <td className="px-4 py-3 text-sm">
                      <span className="font-medium text-blue-700">{s.work_days}일</span>
                    </td>
                    <td className="px-4 py-3 text-sm">
                      <span className={s.late_count > 0 ? 'text-yellow-700 font-medium' : 'text-gray-400'}>
                        {s.late_count > 0 ? (
                          <span className="inline-flex items-center gap-1">
                            <XCircleIcon className="h-3.5 w-3.5" />
                            {s.late_count}회
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1">
                            <CheckCircleIcon className="h-3.5 w-3.5 text-green-500" />
                            0
                          </span>
                        )}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm">
                      <span className={s.early_leave_count > 0 ? 'text-orange-700 font-medium' : 'text-gray-400'}>
                        {s.early_leave_count > 0 ? `${s.early_leave_count}회` : '0'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm">
                      <span className={s.absent_count > 0 ? 'text-red-700 font-bold' : 'text-gray-400'}>
                        {s.absent_count > 0 ? (
                          <span className="inline-flex items-center gap-1 bg-red-100 text-red-700 px-2 py-0.5 rounded-full text-xs">
                            {s.absent_count}일
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1">
                            <CheckCircleIcon className="h-3.5 w-3.5 text-green-500" />
                            0
                          </span>
                        )}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600">{minutesToHM(s.avg_commute_minutes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
