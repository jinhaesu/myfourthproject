import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { vouchersApi, approvalsApi } from '@/services/api'
import { useAuthStore } from '@/store/authStore'
import { ArrowLeftIcon, PaperAirplaneIcon, CheckIcon } from '@heroicons/react/24/outline'

export default function VoucherDetailPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const user = useAuthStore((state) => state.user)

  const { data: voucher, isLoading } = useQuery({
    queryKey: ['voucher', id],
    queryFn: () => vouchersApi.get(Number(id)).then((res) => res.data),
    enabled: !!id,
  })

  const submitApprovalMutation = useMutation({
    mutationFn: (data: any) => approvalsApi.create(data, user?.id || 0),
    onSuccess: () => {
      toast.success('결재 요청이 제출되었습니다.')
      queryClient.invalidateQueries({ queryKey: ['voucher', id] })
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.detail || '결재 요청에 실패했습니다.')
    },
  })

  const confirmMutation = useMutation({
    mutationFn: () => vouchersApi.confirm(Number(id), user?.id || 0),
    onSuccess: () => {
      toast.success('전표가 확정되었습니다.')
      queryClient.invalidateQueries({ queryKey: ['voucher', id] })
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.detail || '전표 확정에 실패했습니다.')
    },
  })

  const handleSubmitApproval = () => {
    submitApprovalMutation.mutate({
      voucher_id: Number(id),
      title: `전표 결재 요청: ${voucher?.voucher_number}`,
      description: voucher?.description,
      is_urgent: false,
    })
  }

  if (isLoading) {
    return <div className="text-center py-12">로딩 중...</div>
  }

  if (!voucher) {
    return <div className="text-center py-12">전표를 찾을 수 없습니다.</div>
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <button
          onClick={() => navigate(-1)}
          className="p-2 hover:bg-gray-100 rounded-lg"
        >
          <ArrowLeftIcon className="h-5 w-5" />
        </button>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{voucher.voucher_number}</h1>
          <p className="text-gray-500">{voucher.description}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Main Info */}
        <div className="lg:col-span-2 space-y-6">
          <div className="card">
            <h3 className="card-header">기본 정보</h3>
            <dl className="grid grid-cols-2 gap-4">
              <div>
                <dt className="text-sm text-gray-500">전표일자</dt>
                <dd className="font-medium">{voucher.voucher_date}</dd>
              </div>
              <div>
                <dt className="text-sm text-gray-500">거래일자</dt>
                <dd className="font-medium">{voucher.transaction_date}</dd>
              </div>
              <div>
                <dt className="text-sm text-gray-500">거래유형</dt>
                <dd className="font-medium">{voucher.transaction_type}</dd>
              </div>
              <div>
                <dt className="text-sm text-gray-500">부서</dt>
                <dd className="font-medium">{voucher.department_name}</dd>
              </div>
              {voucher.merchant_name && (
                <div>
                  <dt className="text-sm text-gray-500">가맹점</dt>
                  <dd className="font-medium">{voucher.merchant_name}</dd>
                </div>
              )}
            </dl>
          </div>

          {/* Lines */}
          <div className="card">
            <h3 className="card-header">전표 명세</h3>
            <div className="table-container">
              <table className="table">
                <thead className="table-header">
                  <tr>
                    <th>계정과목</th>
                    <th className="text-right">차변</th>
                    <th className="text-right">대변</th>
                    <th>적요</th>
                    <th>거래처</th>
                  </tr>
                </thead>
                <tbody className="table-body">
                  {voucher.lines?.map((line: any) => (
                    <tr key={line.id}>
                      <td>
                        <span className="font-mono text-sm text-gray-500">
                          {line.account_code}
                        </span>{' '}
                        {line.account_name}
                      </td>
                      <td className="amount">
                        {line.debit_amount > 0 &&
                          new Intl.NumberFormat('ko-KR').format(line.debit_amount)}
                      </td>
                      <td className="amount">
                        {line.credit_amount > 0 &&
                          new Intl.NumberFormat('ko-KR').format(line.credit_amount)}
                      </td>
                      <td>{line.description}</td>
                      <td>{line.counterparty_name}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-gray-50 font-medium">
                    <td>합계</td>
                    <td className="amount">
                      {new Intl.NumberFormat('ko-KR').format(voucher.total_debit)}
                    </td>
                    <td className="amount">
                      {new Intl.NumberFormat('ko-KR').format(voucher.total_credit)}
                    </td>
                    <td colSpan={2}></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        </div>

        {/* Sidebar */}
        <div className="space-y-6">
          {/* Status & Actions */}
          <div className="card">
            <h3 className="card-header">상태</h3>
            <div className="space-y-4">
              <div>
                <span
                  className={`badge ${
                    voucher.status === 'confirmed'
                      ? 'badge-success'
                      : voucher.status === 'approved'
                      ? 'badge-info'
                      : voucher.status === 'rejected'
                      ? 'badge-danger'
                      : 'badge-warning'
                  }`}
                >
                  {voucher.status === 'draft'
                    ? '임시저장'
                    : voucher.status === 'pending_approval'
                    ? '결재대기'
                    : voucher.status === 'approved'
                    ? '결재완료'
                    : voucher.status === 'confirmed'
                    ? '확정'
                    : voucher.status === 'rejected'
                    ? '반려'
                    : voucher.status}
                </span>
              </div>

              {voucher.status === 'draft' && (
                <button
                  onClick={handleSubmitApproval}
                  disabled={submitApprovalMutation.isPending}
                  className="w-full btn-primary"
                >
                  <PaperAirplaneIcon className="h-5 w-5 mr-2" />
                  결재 상신
                </button>
              )}

              {voucher.status === 'approved' && (
                <button
                  onClick={() => confirmMutation.mutate()}
                  disabled={confirmMutation.isPending}
                  className="w-full btn-success"
                >
                  <CheckIcon className="h-5 w-5 mr-2" />
                  전표 확정
                </button>
              )}
            </div>
          </div>

          {/* AI Classification */}
          {voucher.ai_confidence_score && (
            <div className="card">
              <h3 className="card-header">AI 분류 정보</h3>
              <div className="space-y-3">
                <div>
                  <p className="text-sm text-gray-500">신뢰도</p>
                  <div className="flex items-center gap-2 mt-1">
                    <div className="flex-1 bg-gray-200 rounded-full h-2">
                      <div
                        className={`h-2 rounded-full ${
                          voucher.ai_confidence_score >= 0.85
                            ? 'bg-green-500'
                            : voucher.ai_confidence_score >= 0.6
                            ? 'bg-yellow-500'
                            : 'bg-red-500'
                        }`}
                        style={{ width: `${voucher.ai_confidence_score * 100}%` }}
                      />
                    </div>
                    <span className="text-sm font-medium">
                      {(voucher.ai_confidence_score * 100).toFixed(0)}%
                    </span>
                  </div>
                </div>
                {voucher.ai_suggested_account_name && (
                  <div>
                    <p className="text-sm text-gray-500">추천 계정</p>
                    <p className="font-medium">{voucher.ai_suggested_account_name}</p>
                  </div>
                )}
                <div>
                  <p className="text-sm text-gray-500">분류 상태</p>
                  <p className="font-medium">
                    {voucher.ai_classification_status === 'auto_confirmed'
                      ? '자동 확정'
                      : voucher.ai_classification_status === 'needs_review'
                      ? '검토 필요'
                      : voucher.ai_classification_status === 'user_confirmed'
                      ? '사용자 확인'
                      : voucher.ai_classification_status === 'user_corrected'
                      ? '사용자 수정'
                      : '-'}
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Metadata */}
          <div className="card">
            <h3 className="card-header">이력</h3>
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-gray-500">작성자</dt>
                <dd>{voucher.creator_name}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-gray-500">작성일시</dt>
                <dd>{new Date(voucher.created_at).toLocaleString('ko-KR')}</dd>
              </div>
              {voucher.confirmed_at && (
                <div className="flex justify-between">
                  <dt className="text-gray-500">확정일시</dt>
                  <dd>{new Date(voucher.confirmed_at).toLocaleString('ko-KR')}</dd>
                </div>
              )}
            </dl>
          </div>
        </div>
      </div>
    </div>
  )
}
