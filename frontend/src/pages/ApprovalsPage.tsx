import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { approvalsApi } from '@/services/api'
import { useAuthStore } from '@/store/authStore'
import { CheckIcon, XMarkIcon, ArrowPathIcon } from '@heroicons/react/24/outline'

export default function ApprovalsPage() {
  const user = useAuthStore((state) => state.user)
  const queryClient = useQueryClient()
  const [selectedApproval, setSelectedApproval] = useState<any>(null)
  const [actionComment, setActionComment] = useState('')

  const { data: pendingData, isLoading } = useQuery({
    queryKey: ['pendingApprovals', user?.id],
    queryFn: () => approvalsApi.getPending(user?.id || 0).then((res) => res.data),
    enabled: !!user?.id,
  })

  const actionMutation = useMutation({
    mutationFn: ({ id, actionType }: { id: number; actionType: string }) =>
      approvalsApi.action(
        id,
        { action_type: actionType, comment: actionComment },
        user?.id || 0
      ),
    onSuccess: (_, variables) => {
      toast.success(
        variables.actionType === 'approve'
          ? '승인되었습니다.'
          : variables.actionType === 'reject'
          ? '반려되었습니다.'
          : '처리되었습니다.'
      )
      queryClient.invalidateQueries({ queryKey: ['pendingApprovals'] })
      setSelectedApproval(null)
      setActionComment('')
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.detail || '처리에 실패했습니다.')
    },
  })

  const handleAction = (actionType: string) => {
    if (!selectedApproval) return
    actionMutation.mutate({ id: selectedApproval.id, actionType })
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">결재함</h1>
        <p className="text-gray-500 mt-1">결재 요청을 검토하고 처리합니다.</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* List */}
        <div className="lg:col-span-2">
          <div className="card">
            <h3 className="card-header">
              결재 대기 ({pendingData?.count || 0}건)
            </h3>

            {isLoading ? (
              <div className="text-center py-8">로딩 중...</div>
            ) : pendingData?.pending_approvals?.length > 0 ? (
              <div className="divide-y">
                {pendingData.pending_approvals.map((approval: any) => (
                  <div
                    key={approval.id}
                    onClick={() => setSelectedApproval(approval)}
                    className={`p-4 cursor-pointer hover:bg-gray-50 ${
                      selectedApproval?.id === approval.id ? 'bg-primary-50' : ''
                    }`}
                  >
                    <div className="flex items-start justify-between">
                      <div>
                        <div className="flex items-center gap-2">
                          <p className="font-medium text-gray-900">{approval.title}</p>
                          {approval.is_urgent && (
                            <span className="badge-danger">긴급</span>
                          )}
                        </div>
                        <p className="text-sm text-gray-500 mt-1">
                          {approval.requester_name} · {approval.department_name}
                        </p>
                        <p className="text-xs text-gray-400 mt-1">
                          {new Date(approval.created_at).toLocaleString('ko-KR')}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="text-sm text-gray-500">
                          {approval.current_step}/{approval.total_steps} 단계
                        </p>
                        {!approval.budget_available && (
                          <span className="badge-warning mt-1">예산초과</span>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-8 text-gray-500">
                결재 대기 중인 건이 없습니다.
              </div>
            )}
          </div>
        </div>

        {/* Detail & Actions */}
        <div>
          {selectedApproval ? (
            <div className="card sticky top-20">
              <h3 className="card-header">결재 처리</h3>

              <div className="space-y-4">
                <div>
                  <p className="text-sm text-gray-500">기안번호</p>
                  <p className="font-medium">{selectedApproval.request_number}</p>
                </div>

                <div>
                  <p className="text-sm text-gray-500">제목</p>
                  <p className="font-medium">{selectedApproval.title}</p>
                </div>

                {selectedApproval.description && (
                  <div>
                    <p className="text-sm text-gray-500">설명</p>
                    <p className="text-sm">{selectedApproval.description}</p>
                  </div>
                )}

                <div>
                  <p className="text-sm text-gray-500">예산 상태</p>
                  <p
                    className={`font-medium ${
                      selectedApproval.budget_available
                        ? 'text-green-600'
                        : 'text-red-600'
                    }`}
                  >
                    {selectedApproval.budget_message || '확인됨'}
                  </p>
                </div>

                <div>
                  <label className="label">의견</label>
                  <textarea
                    value={actionComment}
                    onChange={(e) => setActionComment(e.target.value)}
                    className="input mt-1"
                    rows={3}
                    placeholder="결재 의견을 입력하세요..."
                  />
                </div>

                <div className="flex gap-2">
                  <button
                    onClick={() => handleAction('approve')}
                    disabled={actionMutation.isPending}
                    className="flex-1 btn-success"
                  >
                    <CheckIcon className="h-5 w-5 mr-1" />
                    승인
                  </button>
                  <button
                    onClick={() => handleAction('reject')}
                    disabled={actionMutation.isPending}
                    className="flex-1 btn-danger"
                  >
                    <XMarkIcon className="h-5 w-5 mr-1" />
                    반려
                  </button>
                </div>

                <button
                  onClick={() => handleAction('return')}
                  disabled={actionMutation.isPending}
                  className="w-full btn-secondary"
                >
                  <ArrowPathIcon className="h-5 w-5 mr-1" />
                  재상신 요청
                </button>
              </div>
            </div>
          ) : (
            <div className="card">
              <div className="text-center py-8 text-gray-500">
                결재할 건을 선택하세요.
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
