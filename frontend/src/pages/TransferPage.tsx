import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import {
  PaperAirplaneIcon,
  StarIcon,
  XMarkIcon,
  PlusIcon,
  ShieldCheckIcon,
  XCircleIcon,
} from '@heroicons/react/24/outline'
import { transferApi, treasuryApi } from '@/services/api'
import { useAuthStore } from '@/store/authStore'
import StatCard from '@/components/common/StatCard'
import { formatCurrency, formatCompactWon, formatDate, formatDateTime } from '@/utils/format'

const STATUS_META: Record<string, { label: string; class: string }> = {
  draft: { label: '임시', class: 'badge bg-gray-100 text-gray-700' },
  pending_approval: { label: '결재대기', class: 'badge bg-amber-100 text-amber-700' },
  approved: { label: '결재완료', class: 'badge bg-blue-100 text-blue-700' },
  scheduled: { label: '예약', class: 'badge bg-indigo-100 text-indigo-700' },
  executing: { label: '실행중', class: 'badge bg-blue-100 text-blue-700' },
  completed: { label: '완료', class: 'badge bg-emerald-100 text-emerald-700' },
  failed: { label: '실패', class: 'badge bg-rose-100 text-rose-700' },
  cancelled: { label: '취소', class: 'badge bg-gray-100 text-gray-700' },
}

export default function TransferPage() {
  const userId = useAuthStore((s) => s.user?.id ?? 1)
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [otpFor, setOtpFor] = useState<number | null>(null)

  const listQuery = useQuery({
    queryKey: ['transfers'],
    queryFn: () => transferApi.list({ size: 100 }).then((r) => r.data),
  })

  const bookmarksQuery = useQuery({
    queryKey: ['transfer-bookmarks'],
    queryFn: () => transferApi.listBookmarks().then((r) => r.data),
  })

  const data = listQuery.data
  const items: any[] = data?.items || []

  const totalAmount = data?.total_amount || 0
  const pendingCount = items.filter((it) => it.status === 'pending_approval').length
  const completedToday = items.filter((it) => it.status === 'completed').length

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">계좌 이체</h1>
          <p className="text-gray-500 mt-1">
            단건/대량 이체, 예약 이체, 즐겨찾기. OTP 인증으로 안전하게.
          </p>
        </div>
        <button onClick={() => setShowCreateModal(true)} className="btn-primary">
          <PaperAirplaneIcon className="h-5 w-5 mr-1" />
          이체 신청
        </button>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatCard label="이체 합계" value={formatCompactWon(totalAmount)} unit="원" tone="primary" />
        <StatCard label="결재 대기" value={pendingCount} unit="건" tone="warning" />
        <StatCard label="완료" value={completedToday} unit="건" tone="success" />
      </div>

      {/* Bookmarks */}
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-900">자주 쓰는 계좌</h2>
          <button className="btn-secondary text-sm">
            <PlusIcon className="h-4 w-4 mr-1" />
            등록
          </button>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {bookmarksQuery.data?.map((b: any) => (
            <button
              key={b.id}
              onClick={() => setShowCreateModal(true)}
              className="text-left rounded-lg border border-gray-200 p-3 hover:border-primary-400 hover:shadow-sm transition"
            >
              <div className="flex items-start gap-2">
                <StarIcon className="h-4 w-4 text-amber-400 flex-shrink-0 mt-1" />
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-gray-900 truncate">{b.nickname}</div>
                  <div className="text-xs text-gray-500">
                    {b.bank_name} {b.account_number_masked}
                  </div>
                  <div className="text-xs text-gray-400 mt-1">
                    {b.usage_count}회 사용
                  </div>
                </div>
              </div>
            </button>
          ))}
          {bookmarksQuery.data?.length === 0 && (
            <div className="col-span-full text-center text-sm text-gray-400 py-4">
              등록된 즐겨찾기가 없습니다.
            </div>
          )}
        </div>
      </div>

      {/* History */}
      <div className="card p-0 overflow-hidden">
        <div className="p-4 border-b border-gray-200 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900">이체 내역</h2>
          <span className="text-sm text-gray-500">{data?.total ?? 0}건</span>
        </div>
        <div className="table-container border-0">
          <table className="table">
            <thead className="table-header">
              <tr>
                <th>일시</th>
                <th>출금 계좌</th>
                <th>입금 계좌</th>
                <th>적요</th>
                <th className="text-right">금액</th>
                <th>상태</th>
                <th></th>
              </tr>
            </thead>
            <tbody className="table-body">
              {items.map((it) => {
                const status = STATUS_META[it.status] || STATUS_META.draft
                return (
                  <tr key={it.id}>
                    <td className="text-sm">
                      {it.scheduled_date && it.status === 'scheduled' ? (
                        <span className="text-indigo-600">예약 {formatDate(it.scheduled_date)}</span>
                      ) : (
                        formatDateTime(it.completed_at || it.created_at)
                      )}
                    </td>
                    <td>
                      <div className="text-sm font-medium text-gray-900">{it.from_account_alias}</div>
                      <div className="text-xs text-gray-500">{it.from_bank_name}</div>
                    </td>
                    <td>
                      <div className="text-sm font-medium text-gray-900">{it.to_account_holder}</div>
                      <div className="text-xs text-gray-500 font-mono">
                        {it.to_bank_name} {it.to_account_number_masked}
                      </div>
                    </td>
                    <td className="text-sm text-gray-700 max-w-xs truncate">{it.description}</td>
                    <td className="text-right font-mono tabular-nums font-semibold">
                      {formatCurrency(it.amount, false)}
                    </td>
                    <td>
                      <span className={status.class}>{status.label}</span>
                    </td>
                    <td>
                      <div className="flex items-center gap-2 text-xs">
                        {it.status === 'approved' && (
                          <button
                            onClick={() => setOtpFor(it.id)}
                            className="text-primary-600 hover:underline font-medium"
                          >
                            <ShieldCheckIcon className="h-4 w-4 inline mr-0.5" />
                            실행
                          </button>
                        )}
                        {['pending_approval', 'approved', 'scheduled'].includes(it.status) && (
                          <button className="text-gray-500 hover:text-rose-600" title="취소">
                            <XCircleIcon className="h-4 w-4" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
              {items.length === 0 && !listQuery.isLoading && (
                <tr>
                  <td colSpan={7} className="text-center text-gray-400 py-8">
                    이체 이력이 없습니다.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {showCreateModal && <CreateTransferModal userId={userId} onClose={() => setShowCreateModal(false)} />}
      {otpFor && <OTPModal transferId={otpFor} userId={userId} onClose={() => setOtpFor(null)} />}
    </div>
  )
}

function CreateTransferModal({ userId, onClose }: { userId: number; onClose: () => void }) {
  const qc = useQueryClient()
  const [fromAccountId, setFromAccountId] = useState<number | ''>('')
  const [bankCode, setBankCode] = useState('')
  const [accountNumber, setAccountNumber] = useState('')
  const [holder, setHolder] = useState('')
  const [amount, setAmount] = useState('')
  const [memoOut, setMemoOut] = useState('')
  const [memoIn, setMemoIn] = useState('')
  const [scheduledDate, setScheduledDate] = useState('')
  const [description, setDescription] = useState('')

  const accountsQuery = useQuery({
    queryKey: ['bank-accounts'],
    queryFn: () => treasuryApi.getBankAccounts().then((r) => r.data),
  })

  const createMut = useMutation({
    mutationFn: () =>
      transferApi.create(
        {
          from_bank_account_id: Number(fromAccountId),
          to_bank_code: bankCode,
          to_account_number: accountNumber,
          to_account_holder: holder,
          amount: Number(amount),
          memo_outgoing: memoOut || undefined,
          memo_incoming: memoIn || undefined,
          scheduled_date: scheduledDate || undefined,
          description: description || undefined,
          require_approval: true,
        },
        userId
      ),
    onSuccess: () => {
      toast.success('이체 신청이 결재로 올라갔습니다.')
      qc.invalidateQueries({ queryKey: ['transfers'] })
      onClose()
    },
    onError: (e: any) => toast.error(e.response?.data?.detail || '신청에 실패했습니다.'),
  })

  const canSubmit = fromAccountId && bankCode && accountNumber && holder && Number(amount) > 0

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="sticky top-0 bg-white border-b border-gray-200 p-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-gray-900">이체 신청</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <XMarkIcon className="h-5 w-5" />
          </button>
        </div>

        <div className="p-6 space-y-4">
          <div>
            <label className="label">출금 계좌</label>
            <select
              value={fromAccountId}
              onChange={(e) => setFromAccountId(Number(e.target.value))}
              className="input"
            >
              <option value="">계좌 선택</option>
              {accountsQuery.data?.map((a: any) => (
                <option key={a.id} value={a.id}>
                  {a.bank_name} {a.account_alias} ({a.account_number_masked}) · 잔액{' '}
                  {formatCurrency(a.current_balance, false)}원
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">받는 은행 코드</label>
              <input value={bankCode} onChange={(e) => setBankCode(e.target.value)} placeholder="088" className="input" />
            </div>
            <div>
              <label className="label">계좌번호</label>
              <input value={accountNumber} onChange={(e) => setAccountNumber(e.target.value)} className="input" />
            </div>
          </div>

          <div>
            <label className="label">예금주</label>
            <input value={holder} onChange={(e) => setHolder(e.target.value)} className="input" />
          </div>

          <div>
            <label className="label">이체 금액 (원)</label>
            <input
              type="number"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0"
              className="input text-right font-mono"
            />
            {Number(amount) > 0 && (
              <div className="text-xs text-gray-500 mt-1">
                {formatCompactWon(Number(amount))}원
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">보낸이 표시</label>
              <input value={memoOut} onChange={(e) => setMemoOut(e.target.value)} className="input" maxLength={7} />
            </div>
            <div>
              <label className="label">받는이 표시</label>
              <input value={memoIn} onChange={(e) => setMemoIn(e.target.value)} className="input" maxLength={7} />
            </div>
          </div>

          <div>
            <label className="label">예약 이체 날짜 (선택)</label>
            <input
              type="date"
              value={scheduledDate}
              onChange={(e) => setScheduledDate(e.target.value)}
              className="input w-44"
            />
          </div>

          <div>
            <label className="label">적요/메모</label>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="예: 4월 임대료"
              className="input"
            />
          </div>

          <div className="rounded bg-amber-50 border border-amber-200 p-3 text-xs text-amber-800">
            결재 완료 후 OTP 인증을 거쳐야 실제 이체가 실행됩니다.
          </div>
        </div>

        <div className="sticky bottom-0 bg-white border-t border-gray-200 p-4 flex justify-end gap-2">
          <button onClick={onClose} className="btn-secondary">
            취소
          </button>
          <button
            disabled={!canSubmit || createMut.isPending}
            onClick={() => createMut.mutate()}
            className="btn-primary"
          >
            {createMut.isPending ? '신청 중...' : '결재로 올리기'}
          </button>
        </div>
      </div>
    </div>
  )
}

function OTPModal({ transferId, userId, onClose }: { transferId: number; userId: number; onClose: () => void }) {
  const qc = useQueryClient()
  const [otp, setOtp] = useState('')

  const requestOtpMut = useMutation({
    mutationFn: () => transferApi.requestOtp(transferId),
    onSuccess: () => toast.success('OTP가 발송되었습니다. (3분 유효)'),
  })

  const executeMut = useMutation({
    mutationFn: () => transferApi.execute(transferId, otp, userId),
    onSuccess: () => {
      toast.success('이체가 실행되었습니다.')
      qc.invalidateQueries({ queryKey: ['transfers'] })
      onClose()
    },
    onError: (e: any) => toast.error(e.response?.data?.detail || '이체 실행 실패'),
  })

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-sm p-6">
        <div className="flex items-center gap-2 mb-4">
          <ShieldCheckIcon className="h-6 w-6 text-primary-600" />
          <h3 className="text-lg font-semibold text-gray-900">OTP 인증</h3>
        </div>
        <p className="text-sm text-gray-600 mb-4">
          등록된 휴대폰으로 발송된 6자리 OTP를 입력하세요.
        </p>
        <input
          type="text"
          inputMode="numeric"
          maxLength={6}
          value={otp}
          onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))}
          placeholder="000000"
          className="input text-center text-2xl font-mono tabular-nums tracking-widest"
        />
        <button
          onClick={() => requestOtpMut.mutate()}
          disabled={requestOtpMut.isPending}
          className="text-xs text-primary-600 hover:underline mt-2"
        >
          OTP 발송 / 재발송
        </button>
        <div className="mt-6 flex justify-end gap-2">
          <button onClick={onClose} className="btn-secondary">
            취소
          </button>
          <button
            disabled={otp.length !== 6 || executeMut.isPending}
            onClick={() => executeMut.mutate()}
            className="btn-primary"
          >
            {executeMut.isPending ? '실행 중...' : '이체 실행'}
          </button>
        </div>
      </div>
    </div>
  )
}
