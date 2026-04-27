import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import {
  ArchiveBoxArrowDownIcon,
  ArrowDownTrayIcon,
  CheckCircleIcon,
  PlayIcon,
  ClockIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline'
import { connectApi } from '@/services/api'
import { useAuthStore } from '@/store/authStore'
import StatCard from '@/components/common/StatCard'
import { formatPct, formatDate, formatRelativeTime, todayISO } from '@/utils/format'

const STATUS_META: Record<string, { label: string; class: string }> = {
  not_started: { label: '대기', class: 'badge bg-gray-100 text-gray-700' },
  in_progress: { label: '진행중', class: 'badge bg-blue-100 text-blue-700' },
  review: { label: '검토중', class: 'badge bg-amber-100 text-amber-700' },
  completed: { label: '완료', class: 'badge bg-emerald-100 text-emerald-700' },
}

export default function ConnectClosingPage() {
  const userId = useAuthStore((s) => s.user?.id ?? 1)
  const qc = useQueryClient()
  const [selectedClientId, setSelectedClientId] = useState<number | null>(null)
  const [showStartModal, setShowStartModal] = useState(false)

  const clientsQuery = useQuery({
    queryKey: ['connect-clients-light'],
    queryFn: () => connectApi.listClients({ size: 100 }).then((r) => r.data),
  })

  const closingsQuery = useQuery({
    queryKey: ['connect-closings', selectedClientId],
    queryFn: () => connectApi.listClosingPeriods(selectedClientId!).then((r) => r.data),
    enabled: !!selectedClientId,
  })

  // 자동으로 첫 번째 클라이언트 선택
  if (clientsQuery.data?.items?.length && !selectedClientId) {
    setSelectedClientId(clientsQuery.data.items[0].id)
  }

  const exportMut = useMutation({
    mutationFn: ({ closingId, clientId }: { closingId: number; clientId: number }) =>
      connectApi.exportToWehago(closingId, {
        client_id: clientId,
        closing_period_id: closingId,
        file_format: 'wehago_xlsx',
      }),
    onSuccess: (res) => {
      toast.success('위하고 업로드 파일 생성 완료')
      const url = res.data?.file_url
      if (url) window.open(url, '_blank')
    },
  })

  const completeMut = useMutation({
    mutationFn: (closingId: number) => connectApi.completeClosing(closingId, undefined, userId),
    onSuccess: () => {
      toast.success('결산이 완료 처리되었습니다.')
      qc.invalidateQueries({ queryKey: ['connect-closings', selectedClientId] })
    },
  })

  const closings: any[] = closingsQuery.data || []
  const stats = {
    total: closings.length,
    completed: closings.filter((c) => c.status === 'completed').length,
    inProgress: closings.filter((c) => c.status === 'in_progress' || c.status === 'review').length,
    avgRate: closings.length
      ? closings.reduce((s, c) => s + (c.classification_rate || 0), 0) / closings.length
      : 0,
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">결산 자동화</h1>
          <p className="text-gray-500 mt-1">
            전표 분류율 90%+. 위하고 업로드용 파일을 한 번에.
          </p>
        </div>
        <button onClick={() => setShowStartModal(true)} className="btn-primary">
          <PlayIcon className="h-5 w-5 mr-1" />
          결산 시작
        </button>
      </div>

      {/* Client picker */}
      <div className="card">
        <div className="text-sm text-gray-700 mb-2">수임고객 선택</div>
        <div className="flex flex-wrap gap-2">
          {clientsQuery.data?.items?.map((c: any) => (
            <button
              key={c.id}
              onClick={() => setSelectedClientId(c.id)}
              className={`px-3 py-1.5 rounded-md text-sm font-medium transition ${
                selectedClientId === c.id
                  ? 'bg-primary-600 text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              {c.company_name}
            </button>
          ))}
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="결산 기간" value={stats.total} unit="건" tone="primary" />
        <StatCard
          label="완료"
          value={stats.completed}
          unit="건"
          tone="success"
          icon={<CheckCircleIcon className="h-5 w-5" />}
        />
        <StatCard
          label="진행 중"
          value={stats.inProgress}
          unit="건"
          tone="warning"
          icon={<ClockIcon className="h-5 w-5" />}
        />
        <StatCard
          label="평균 분류율"
          value={formatPct(stats.avgRate * 100)}
          tone="mint"
        />
      </div>

      {/* Closing list */}
      <div className="card p-0 overflow-hidden">
        <div className="p-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900">결산 기간</h2>
        </div>
        <div className="table-container border-0">
          <table className="table">
            <thead className="table-header">
              <tr>
                <th>회계연도</th>
                <th>기간</th>
                <th>구분</th>
                <th>전표</th>
                <th>분류율</th>
                <th>위하고</th>
                <th>상태</th>
                <th></th>
              </tr>
            </thead>
            <tbody className="table-body">
              {closings.map((c) => {
                const status = STATUS_META[c.status] || STATUS_META.not_started
                const rate = c.classification_rate || 0
                return (
                  <tr key={c.id}>
                    <td className="text-sm text-gray-700">{c.fiscal_year}</td>
                    <td className="text-sm text-gray-700">
                      {formatDate(c.period_start)} ~ {formatDate(c.period_end)}
                    </td>
                    <td>
                      <span className="badge bg-gray-100 text-gray-700">
                        {c.period_type === 'monthly' ? '월간' : c.period_type === 'quarterly' ? '분기' : '연간'}
                      </span>
                    </td>
                    <td className="text-sm font-mono">
                      <span className="font-medium text-gray-900">{c.voucher_classified_count}</span>
                      <span className="text-gray-400"> / {c.voucher_total_count}</span>
                    </td>
                    <td>
                      <div className="flex items-center gap-2">
                        <div className="w-20 bg-gray-200 rounded-full h-1.5 overflow-hidden">
                          <div
                            className={`h-full ${
                              rate >= 0.9 ? 'bg-emerald-500' : rate >= 0.7 ? 'bg-amber-500' : 'bg-rose-500'
                            }`}
                            style={{ width: `${rate * 100}%` }}
                          />
                        </div>
                        <span className="text-sm font-mono font-semibold text-gray-900">
                          {formatPct(rate * 100, 0)}
                        </span>
                      </div>
                    </td>
                    <td className="text-xs text-gray-500">
                      {c.wehago_uploaded_at ? (
                        <span className="text-emerald-600">
                          ✓ {formatRelativeTime(c.wehago_uploaded_at)}
                        </span>
                      ) : (
                        '-'
                      )}
                    </td>
                    <td>
                      <span className={status.class}>{status.label}</span>
                    </td>
                    <td>
                      <div className="flex items-center gap-2 text-xs">
                        <button
                          onClick={() =>
                            exportMut.mutate({ closingId: c.id, clientId: c.client_id })
                          }
                          className="text-primary-600 hover:underline font-medium"
                        >
                          <ArrowDownTrayIcon className="h-4 w-4 inline mr-0.5" />
                          위하고 파일
                        </button>
                        {c.status !== 'completed' && (
                          <button
                            onClick={() => completeMut.mutate(c.id)}
                            className="text-emerald-600 hover:underline font-medium"
                          >
                            완료처리
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
              {closings.length === 0 && !closingsQuery.isLoading && (
                <tr>
                  <td colSpan={8} className="text-center text-gray-400 py-8">
                    결산 기간이 없습니다. 새 결산을 시작하세요.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Wehago info card */}
      <div className="rounded-lg border border-teal-200 bg-teal-50 p-5">
        <div className="flex gap-3">
          <ArchiveBoxArrowDownIcon className="h-6 w-6 text-teal-600 flex-shrink-0" />
          <div>
            <h3 className="font-semibold text-teal-900">위하고(Wehago) 양식 자동 변환</h3>
            <p className="text-sm text-teal-800 mt-1">
              결산이 완료된 전표를 위하고에서 그대로 import할 수 있는 형식으로 변환합니다.
              <br />
              지원 양식: <code className="font-mono text-xs bg-white px-1 rounded">.xlsx</code>{' '}
              <code className="font-mono text-xs bg-white px-1 rounded">.csv</code>{' '}
              <code className="font-mono text-xs bg-white px-1 rounded">.xml</code>
            </p>
          </div>
        </div>
      </div>

      {showStartModal && selectedClientId && (
        <StartClosingModal
          clientId={selectedClientId}
          userId={userId}
          onClose={() => setShowStartModal(false)}
        />
      )}
    </div>
  )
}

function StartClosingModal({
  clientId,
  userId,
  onClose,
}: {
  clientId: number
  userId: number
  onClose: () => void
}) {
  const qc = useQueryClient()
  const today = new Date()
  const [year, setYear] = useState(today.getFullYear())
  const [periodType, setPeriodType] = useState<'monthly' | 'quarterly' | 'yearly'>('monthly')
  const [start, setStart] = useState(() => {
    const d = new Date(today.getFullYear(), today.getMonth(), 1)
    return d.toISOString().slice(0, 10)
  })
  const [end, setEnd] = useState(todayISO())

  const startMut = useMutation({
    mutationFn: () =>
      connectApi.startClosing(
        {
          client_id: clientId,
          fiscal_year: year,
          period_type: periodType,
          period_start: start,
          period_end: end,
        },
        userId
      ),
    onSuccess: () => {
      toast.success('결산이 시작되었습니다.')
      qc.invalidateQueries({ queryKey: ['connect-closings', clientId] })
      onClose()
    },
    onError: (e: any) => toast.error(e.response?.data?.detail || '시작 실패'),
  })

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-gray-900">결산 시작</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <XMarkIcon className="h-5 w-5" />
          </button>
        </div>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">회계연도</label>
              <input
                type="number"
                value={year}
                onChange={(e) => setYear(Number(e.target.value))}
                className="input"
              />
            </div>
            <div>
              <label className="label">결산 단위</label>
              <select
                value={periodType}
                onChange={(e) => setPeriodType(e.target.value as any)}
                className="input"
              >
                <option value="monthly">월간</option>
                <option value="quarterly">분기</option>
                <option value="yearly">연간</option>
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">시작일</label>
              <input type="date" value={start} onChange={(e) => setStart(e.target.value)} className="input" />
            </div>
            <div>
              <label className="label">종료일</label>
              <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} className="input" />
            </div>
          </div>
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <button onClick={onClose} className="btn-secondary">
            취소
          </button>
          <button
            disabled={startMut.isPending}
            onClick={() => startMut.mutate()}
            className="btn-primary"
          >
            {startMut.isPending ? '시작 중...' : '결산 시작'}
          </button>
        </div>
      </div>
    </div>
  )
}
