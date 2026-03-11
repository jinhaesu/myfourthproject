import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { vouchersApi, approvalsApi } from '@/services/api'
import { useAuthStore } from '@/store/authStore'
import {
  ArrowLeftIcon,
  PaperAirplaneIcon,
  CheckIcon,
  PlusIcon,
  TrashIcon,
  PencilIcon,
  MagnifyingGlassIcon,
} from '@heroicons/react/24/outline'

interface VoucherLine {
  account_id: number
  account_code: string
  account_name: string
  debit_amount: number
  credit_amount: number
  description: string
  counterparty_name?: string
}

function AccountSearchSelect({
  value,
  onChange,
}: {
  value: { id: number; code: string; name: string }
  onChange: (account: { id: number; code: string; name: string }) => void
}) {
  const [search, setSearch] = useState('')
  const [isOpen, setIsOpen] = useState(false)

  const { data: accounts } = useQuery({
    queryKey: ['accounts', search],
    queryFn: () => vouchersApi.getAccounts(undefined, search || undefined).then((res) => res.data),
    enabled: isOpen,
  })

  const handleSelect = (account: any) => {
    onChange({ id: account.id, code: account.code, name: account.name })
    setIsOpen(false)
    setSearch('')
  }

  return (
    <div className="relative">
      <div
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-1 px-2 py-1 border border-gray-300 rounded cursor-pointer hover:border-blue-400 min-w-[180px] text-sm"
      >
        {value.id ? (
          <span>
            <span className="font-mono text-gray-500">{value.code}</span>{' '}
            {value.name}
          </span>
        ) : (
          <span className="text-gray-400">계정 선택</span>
        )}
        <MagnifyingGlassIcon className="h-4 w-4 text-gray-400 ml-auto flex-shrink-0" />
      </div>

      {isOpen && (
        <div className="absolute z-50 mt-1 w-72 bg-white border border-gray-200 rounded-lg shadow-lg">
          <div className="p-2 border-b">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="코드 또는 이름으로 검색..."
              className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
              autoFocus
            />
          </div>
          <div className="max-h-48 overflow-y-auto">
            {accounts?.slice(0, 20).map((acc: any) => (
              <div
                key={acc.id}
                onClick={() => handleSelect(acc)}
                className="px-3 py-2 text-sm hover:bg-blue-50 cursor-pointer flex items-center gap-2"
              >
                <span className="font-mono text-gray-500 text-xs">{acc.code}</span>
                <span>{acc.name}</span>
              </div>
            ))}
            {accounts?.length === 0 && (
              <div className="px-3 py-4 text-sm text-gray-400 text-center">
                검색 결과가 없습니다.
              </div>
            )}
          </div>
        </div>
      )}

      {isOpen && (
        <div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)} />
      )}
    </div>
  )
}

function formatNumber(n: number) {
  return new Intl.NumberFormat('ko-KR').format(n)
}

export default function VoucherDetailPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const user = useAuthStore((state) => state.user)
  const isNew = id === 'new'
  const [isEditing, setIsEditing] = useState(false)

  // Form state
  const [formData, setFormData] = useState({
    voucher_date: new Date().toISOString().split('T')[0],
    transaction_date: new Date().toISOString().split('T')[0],
    description: '',
    transaction_type: 'expense',
    department_id: user?.departmentId || 1,
  })

  const [lines, setLines] = useState<VoucherLine[]>([
    { account_id: 0, account_code: '', account_name: '', debit_amount: 0, credit_amount: 0, description: '' },
  ])

  const { data: voucher, isLoading } = useQuery({
    queryKey: ['voucher', id],
    queryFn: () => vouchersApi.get(Number(id)).then((res) => res.data),
    enabled: !!id && !isNew,
  })

  // Populate form when editing existing voucher
  useEffect(() => {
    if (voucher && isEditing) {
      setFormData({
        voucher_date: voucher.voucher_date,
        transaction_date: voucher.transaction_date,
        description: voucher.description,
        transaction_type: voucher.transaction_type,
        department_id: voucher.department_id,
      })
      setLines(
        voucher.lines?.map((l: any) => ({
          account_id: l.account_id,
          account_code: l.account_code || '',
          account_name: l.account_name || '',
          debit_amount: Number(l.debit_amount) || 0,
          credit_amount: Number(l.credit_amount) || 0,
          description: l.description || '',
          counterparty_name: l.counterparty_name || '',
        })) || []
      )
    }
  }, [voucher, isEditing])

  const addLine = useCallback(() => {
    setLines((prev) => [
      ...prev,
      { account_id: 0, account_code: '', account_name: '', debit_amount: 0, credit_amount: 0, description: '' },
    ])
  }, [])

  const removeLine = useCallback((index: number) => {
    setLines((prev) => prev.length > 1 ? prev.filter((_, i) => i !== index) : prev)
  }, [])

  const updateLine = useCallback((index: number, field: keyof VoucherLine, value: any) => {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, [field]: value } : l)))
  }, [])

  const totalDebit = lines.reduce((s, l) => s + (Number(l.debit_amount) || 0), 0)
  const totalCredit = lines.reduce((s, l) => s + (Number(l.credit_amount) || 0), 0)
  const isBalanced = Math.abs(totalDebit - totalCredit) < 0.01

  const createMutation = useMutation({
    mutationFn: (data: any) => vouchersApi.create(data, user?.id || 0),
    onSuccess: (res) => {
      toast.success('전표가 생성되었습니다.')
      navigate(`/vouchers/${res.data.id}`)
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.detail || '전표 생성에 실패했습니다.')
    },
  })

  const updateMutation = useMutation({
    mutationFn: (data: any) => vouchersApi.update(Number(id), data, user?.id || 0),
    onSuccess: () => {
      toast.success('전표가 수정되었습니다.')
      setIsEditing(false)
      queryClient.invalidateQueries({ queryKey: ['voucher', id] })
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.detail || '전표 수정에 실패했습니다.')
    },
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
    mutationFn: (finalAccountId?: number) =>
      vouchersApi.confirm(Number(id), user?.id || 0, finalAccountId),
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

  const validateAndSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!formData.description.trim()) {
      toast.error('적요를 입력하세요.')
      return
    }
    const validLines = lines.filter((l) => l.account_id > 0 && (l.debit_amount > 0 || l.credit_amount > 0))
    if (validLines.length === 0) {
      toast.error('최소 1개의 전표 라인을 입력하세요.')
      return
    }
    if (!isBalanced) {
      toast.error(`차대변이 일치하지 않습니다. (차변: ${formatNumber(totalDebit)}, 대변: ${formatNumber(totalCredit)})`)
      return
    }
    const payload = { ...formData, lines: validLines }
    if (isNew) {
      createMutation.mutate(payload)
    } else {
      updateMutation.mutate(payload)
    }
  }

  if (!isNew && isLoading) {
    return (
      <div className="text-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto" />
        <p className="text-gray-500 mt-2">로딩 중...</p>
      </div>
    )
  }

  if (!isNew && !voucher) {
    return <div className="text-center py-12">전표를 찾을 수 없습니다.</div>
  }

  // Voucher line editor (shared between create and edit)
  const renderLineEditor = () => (
    <div className="card">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-gray-900">전표 명세 (분개)</h3>
        <button type="button" onClick={addLine} className="btn-secondary text-sm">
          <PlusIcon className="h-4 w-4 mr-1" /> 라인 추가
        </button>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-gray-50">
              <th className="text-left px-2 py-2 w-[200px]">계정과목</th>
              <th className="text-right px-2 py-2 w-[130px]">차변(원)</th>
              <th className="text-right px-2 py-2 w-[130px]">대변(원)</th>
              <th className="text-left px-2 py-2">적요</th>
              <th className="text-left px-2 py-2 w-[120px]">거래처</th>
              <th className="w-[40px]"></th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line, idx) => (
              <tr key={idx} className="border-b">
                <td className="px-1 py-1">
                  <AccountSearchSelect
                    value={{ id: line.account_id, code: line.account_code, name: line.account_name }}
                    onChange={(acc) => {
                      const updated = [...lines]
                      updated[idx] = { ...updated[idx], account_id: acc.id, account_code: acc.code, account_name: acc.name }
                      setLines(updated)
                    }}
                  />
                </td>
                <td className="px-1 py-1">
                  <input
                    type="number"
                    value={line.debit_amount || ''}
                    onChange={(e) => updateLine(idx, 'debit_amount', Number(e.target.value) || 0)}
                    className="w-full text-right px-2 py-1 border border-gray-300 rounded text-sm"
                    placeholder="0"
                    min="0"
                  />
                </td>
                <td className="px-1 py-1">
                  <input
                    type="number"
                    value={line.credit_amount || ''}
                    onChange={(e) => updateLine(idx, 'credit_amount', Number(e.target.value) || 0)}
                    className="w-full text-right px-2 py-1 border border-gray-300 rounded text-sm"
                    placeholder="0"
                    min="0"
                  />
                </td>
                <td className="px-1 py-1">
                  <input
                    type="text"
                    value={line.description}
                    onChange={(e) => updateLine(idx, 'description', e.target.value)}
                    className="w-full px-2 py-1 border border-gray-300 rounded text-sm"
                    placeholder="적요"
                  />
                </td>
                <td className="px-1 py-1">
                  <input
                    type="text"
                    value={line.counterparty_name || ''}
                    onChange={(e) => updateLine(idx, 'counterparty_name', e.target.value)}
                    className="w-full px-2 py-1 border border-gray-300 rounded text-sm"
                    placeholder="거래처"
                  />
                </td>
                <td className="px-1 py-1">
                  <button
                    type="button"
                    onClick={() => removeLine(idx)}
                    className="p-1 text-gray-400 hover:text-red-500"
                    title="삭제"
                  >
                    <TrashIcon className="h-4 w-4" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="bg-gray-50 font-medium">
              <td className="px-2 py-2">합계</td>
              <td className={`text-right px-2 py-2 ${!isBalanced ? 'text-red-600' : ''}`}>
                {formatNumber(totalDebit)}
              </td>
              <td className={`text-right px-2 py-2 ${!isBalanced ? 'text-red-600' : ''}`}>
                {formatNumber(totalCredit)}
              </td>
              <td colSpan={3} className="px-2 py-2">
                {!isBalanced && (
                  <span className="text-red-500 text-xs">
                    차액: {formatNumber(Math.abs(totalDebit - totalCredit))}원
                  </span>
                )}
                {isBalanced && totalDebit > 0 && (
                  <span className="text-green-600 text-xs">차대변 일치</span>
                )}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  )

  // Create / Edit form
  if (isNew || isEditing) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <button
            onClick={() => { if (isEditing) setIsEditing(false); else navigate(-1); }}
            className="p-2 hover:bg-gray-100 rounded-lg"
          >
            <ArrowLeftIcon className="h-5 w-5" />
          </button>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">
              {isNew ? '새 전표' : `전표 수정: ${voucher?.voucher_number}`}
            </h1>
            <p className="text-gray-500">{isNew ? '전표를 작성합니다.' : '전표를 수정합니다.'}</p>
          </div>
        </div>

        <form onSubmit={validateAndSubmit} className="space-y-6">
          <div className="card">
            <h3 className="card-header">기본 정보</h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="label">전표일자</label>
                <input
                  type="date"
                  value={formData.voucher_date}
                  onChange={(e) => setFormData({ ...formData, voucher_date: e.target.value })}
                  className="w-full mt-1 px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>
              <div>
                <label className="label">거래일자</label>
                <input
                  type="date"
                  value={formData.transaction_date}
                  onChange={(e) => setFormData({ ...formData, transaction_date: e.target.value })}
                  className="w-full mt-1 px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>
              <div>
                <label className="label">거래유형</label>
                <select
                  value={formData.transaction_type}
                  onChange={(e) => setFormData({ ...formData, transaction_type: e.target.value })}
                  className="w-full mt-1 px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                >
                  <option value="expense">비용</option>
                  <option value="revenue">수익</option>
                  <option value="transfer">대체</option>
                  <option value="card">카드</option>
                </select>
              </div>
              <div className="col-span-2">
                <label className="label">적요</label>
                <input
                  type="text"
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  className="w-full mt-1 px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  placeholder="거래 내용을 입력하세요"
                />
              </div>
            </div>
          </div>

          {renderLineEditor()}

          <div className="flex justify-end gap-3">
            <button
              type="button"
              onClick={() => { if (isEditing) setIsEditing(false); else navigate(-1); }}
              className="btn-secondary"
            >
              취소
            </button>
            <button
              type="submit"
              disabled={createMutation.isPending || updateMutation.isPending}
              className="btn-primary"
            >
              <PlusIcon className="h-5 w-5 mr-2" />
              {(createMutation.isPending || updateMutation.isPending) ? '저장 중...' : isNew ? '전표 생성' : '수정 완료'}
            </button>
          </div>
        </form>
      </div>
    )
  }

  // Detail view
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <button onClick={() => navigate(-1)} className="p-2 hover:bg-gray-100 rounded-lg">
          <ArrowLeftIcon className="h-5 w-5" />
        </button>
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-gray-900">{voucher.voucher_number}</h1>
          <p className="text-gray-500">{voucher.description}</p>
        </div>
        {(voucher.status === 'draft' || voucher.status === 'rejected') && (
          <button
            onClick={() => setIsEditing(true)}
            className="btn-secondary"
          >
            <PencilIcon className="h-5 w-5 mr-1" /> 수정
          </button>
        )}
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
                        <span className="font-mono text-sm text-gray-500">{line.account_code}</span>{' '}
                        {line.account_name}
                      </td>
                      <td className="amount">
                        {line.debit_amount > 0 && formatNumber(line.debit_amount)}
                      </td>
                      <td className="amount">
                        {line.credit_amount > 0 && formatNumber(line.credit_amount)}
                      </td>
                      <td>{line.description}</td>
                      <td>{line.counterparty_name}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-gray-50 font-medium">
                    <td>합계</td>
                    <td className="amount">{formatNumber(voucher.total_debit)}</td>
                    <td className="amount">{formatNumber(voucher.total_credit)}</td>
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
                    voucher.status === 'confirmed' ? 'badge-success'
                    : voucher.status === 'approved' ? 'badge-info'
                    : voucher.status === 'rejected' ? 'badge-danger'
                    : 'badge-warning'
                  }`}
                >
                  {voucher.status === 'draft' ? '임시저장'
                    : voucher.status === 'pending_approval' ? '결재대기'
                    : voucher.status === 'in_approval' ? '결재진행'
                    : voucher.status === 'approved' ? '결재완료'
                    : voucher.status === 'confirmed' ? '확정'
                    : voucher.status === 'rejected' ? '반려'
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

              {voucher.status === 'rejected' && (
                <button
                  onClick={() => setIsEditing(true)}
                  className="w-full btn-secondary"
                >
                  <PencilIcon className="h-5 w-5 mr-2" />
                  수정 후 재상신
                </button>
              )}

              {voucher.status === 'approved' && (
                <ConfirmWithAccountSelect
                  voucher={voucher}
                  onConfirm={(finalAccountId) => confirmMutation.mutate(finalAccountId)}
                  isPending={confirmMutation.isPending}
                />
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
                          voucher.ai_confidence_score >= 0.85 ? 'bg-green-500'
                          : voucher.ai_confidence_score >= 0.6 ? 'bg-yellow-500'
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
                    {voucher.ai_classification_status === 'auto_confirmed' ? '자동 확정'
                      : voucher.ai_classification_status === 'needs_review' ? '검토 필요'
                      : voucher.ai_classification_status === 'user_confirmed' ? '사용자 확인'
                      : voucher.ai_classification_status === 'user_corrected' ? '사용자 수정'
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

// AI 분류 수정이 가능한 전표 확정 컴포넌트
function ConfirmWithAccountSelect({
  voucher,
  onConfirm,
  isPending,
}: {
  voucher: any
  onConfirm: (finalAccountId?: number) => void
  isPending: boolean
}) {
  const [showAccountSelect, setShowAccountSelect] = useState(false)
  const [selectedAccount, setSelectedAccount] = useState<{ id: number; code: string; name: string }>({
    id: 0, code: '', name: '',
  })

  if (showAccountSelect) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-gray-600">AI 분류를 수정하시겠습니까?</p>
        <AccountSearchSelect
          value={selectedAccount}
          onChange={setSelectedAccount}
        />
        <div className="flex gap-2">
          <button
            onClick={() => onConfirm(selectedAccount.id || undefined)}
            disabled={isPending}
            className="flex-1 btn-success text-sm"
          >
            <CheckIcon className="h-4 w-4 mr-1" />
            {selectedAccount.id ? '수정 확정' : '원본 확정'}
          </button>
          <button
            onClick={() => setShowAccountSelect(false)}
            className="btn-secondary text-sm"
          >
            취소
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <button
        onClick={() => onConfirm()}
        disabled={isPending}
        className="w-full btn-success"
      >
        <CheckIcon className="h-5 w-5 mr-2" />
        전표 확정
      </button>
      {voucher.ai_confidence_score && (
        <button
          onClick={() => setShowAccountSelect(true)}
          className="w-full text-sm text-blue-600 hover:text-blue-800"
        >
          AI 분류 수정 후 확정
        </button>
      )}
    </div>
  )
}
