import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { approvalsApi, vouchersApi } from '@/services/api'
import { useAuthStore } from '@/store/authStore'
import {
  CheckIcon,
  XMarkIcon,
  ArrowPathIcon,
  DocumentTextIcon,
  ClockIcon,
} from '@heroicons/react/24/outline'

type TabType = 'pending' | 'my_requests'

export default function ApprovalsPage() {
  const user = useAuthStore((state) => state.user)
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [activeTab, setActiveTab] = useState<TabType>('pending')
  const [selectedApproval, setSelectedApproval] = useState<any>(null)
  const [actionComment, setActionComment] = useState('')

  const { data: pendingData, isLoading } = useQuery({
    queryKey: ['pendingApprovals', user?.id],
    queryFn: () => approvalsApi.getPending(user?.id || 0).then((res) => res.data),
    enabled: !!user?.id,
  })

  // Fetch approval history when an item is selected
  const { data: approvalHistory } = useQuery({
    queryKey: ['approvalHistory', selectedApproval?.id],
    queryFn: () => approvalsApi.getHistory(selectedApproval?.id).then((res) => res.data),
    enabled: !!selectedApproval?.id,
  })

  // Fetch my submitted requests (using voucher list with pending_approval status)
  const { data: myRequests } = useQuery({
    queryKey: ['myVouchers', user?.id],
    queryFn: () =>
      vouchersApi.list({ status: 'pending_approval', size: 50 }).then((res) => res.data),
    enabled: activeTab === 'my_requests',
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
        variables.actionType === 'approve' ? '승인되었습니다.'
        : variables.actionType === 'reject' ? '반려되었습니다.'
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

  const tabs = [
    { id: 'pending' as TabType, label: `결재 대기 (${pendingData?.count || 0})` },
    { id: 'my_requests' as TabType, label: '내가 기안한 건' },
  ]

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">결재함</h1>
        <p className="text-gray-500 mt-1">결재 요청을 검토하고 처리합니다.</p>
      </div>

      {/* Tabs */}
      <div className="border-b border-gray-200">
        <nav className="flex gap-4">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => { setActiveTab(tab.id); setSelectedApproval(null); }}
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

      {activeTab === 'pending' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Pending List */}
          <div className="lg:col-span-2">
            <div className="card">
              {isLoading ? (
                <div className="text-center py-8">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto" />
                </div>
              ) : pendingData?.pending_approvals && pendingData.pending_approvals.length > 0 ? (
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
                            {approval.is_urgent && <span className="badge-danger">긴급</span>}
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
              <div className="card sticky top-20 space-y-4">
                <h3 className="card-header">결재 처리</h3>

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

                {/* Voucher link */}
                {selectedApproval.voucher_id && (
                  <button
                    onClick={() => navigate(`/vouchers/${selectedApproval.voucher_id}`)}
                    className="w-full flex items-center gap-2 p-2 text-sm text-blue-600 bg-blue-50 rounded-lg hover:bg-blue-100 transition-colors"
                  >
                    <DocumentTextIcon className="h-5 w-5" />
                    전표 상세 보기
                  </button>
                )}

                <div>
                  <p className="text-sm text-gray-500">예산 상태</p>
                  <p className={`font-medium ${selectedApproval.budget_available ? 'text-green-600' : 'text-red-600'}`}>
                    {selectedApproval.budget_message || '확인됨'}
                  </p>
                </div>

                {/* Approval Timeline */}
                {approvalHistory && approvalHistory.length > 0 && (
                  <div>
                    <p className="text-sm text-gray-500 mb-2">결재 이력</p>
                    <div className="space-y-2">
                      {approvalHistory.map((h: any, idx: number) => (
                        <div key={idx} className="flex items-start gap-2">
                          <div className={`mt-1 w-2 h-2 rounded-full flex-shrink-0 ${
                            h.action === 'approve' ? 'bg-green-500'
                            : h.action === 'reject' ? 'bg-red-500'
                            : h.action === 'submit' ? 'bg-blue-500'
                            : 'bg-gray-400'
                          }`} />
                          <div className="text-xs">
                            <p className="font-medium">
                              {h.action === 'approve' ? '승인' : h.action === 'reject' ? '반려' : h.action === 'submit' ? '기안' : h.action}
                              {' · '}{h.user_name}
                            </p>
                            {h.comment && <p className="text-gray-500 mt-0.5">{h.comment}</p>}
                            <p className="text-gray-400">{new Date(h.created_at).toLocaleString('ko-KR')}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

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
            ) : (
              <div className="card">
                <div className="text-center py-8 text-gray-500">
                  결재할 건을 선택하세요.
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {activeTab === 'my_requests' && (
        <div className="card">
          <h3 className="card-header">내가 기안한 결재 건</h3>
          {myRequests?.items && myRequests.items.length > 0 ? (
            <div className="divide-y">
              {myRequests.items.map((v: any) => (
                <div
                  key={v.id}
                  onClick={() => navigate(`/vouchers/${v.id}`)}
                  className="p-4 cursor-pointer hover:bg-gray-50 flex items-center justify-between"
                >
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="font-medium text-gray-900">{v.voucher_number}</p>
                      <span className={`badge ${
                        v.status === 'approved' ? 'badge-success'
                        : v.status === 'rejected' ? 'badge-danger'
                        : 'badge-warning'
                      }`}>
                        {v.status === 'pending_approval' ? '결재대기'
                          : v.status === 'in_approval' ? '결재진행'
                          : v.status === 'approved' ? '승인'
                          : v.status === 'rejected' ? '반려'
                          : v.status}
                      </span>
                    </div>
                    <p className="text-sm text-gray-500 mt-1">{v.description}</p>
                  </div>
                  <div className="text-right">
                    <p className="font-mono text-sm">
                      {new Intl.NumberFormat('ko-KR').format(v.total_debit)}원
                    </p>
                    <p className="text-xs text-gray-400 flex items-center gap-1 justify-end mt-1">
                      <ClockIcon className="h-3 w-3" />
                      {new Date(v.created_at).toLocaleDateString('ko-KR')}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-8 text-gray-500">기안한 건이 없습니다.</div>
          )}
        </div>
      )}
    </div>
  )
}
