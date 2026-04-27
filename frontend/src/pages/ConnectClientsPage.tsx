import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import {
  UserGroupIcon,
  ExclamationCircleIcon,
  PlusIcon,
  XMarkIcon,
  ArrowPathIcon,
  ChevronRightIcon,
  ChevronDownIcon,
  ClipboardDocumentCheckIcon,
} from '@heroicons/react/24/outline'
import { connectApi } from '@/services/api'
import { useAuthStore } from '@/store/authStore'
import StatCard from '@/components/common/StatCard'
import { formatCompactWon, formatPct, formatRelativeTime, maskBusinessNumber } from '@/utils/format'

const COLLECTION_LABEL: Record<string, { label: string; class: string }> = {
  healthy: { label: '정상', class: 'badge bg-emerald-100 text-emerald-700' },
  stale: { label: '지연', class: 'badge bg-amber-100 text-amber-700' },
  error: { label: '오류', class: 'badge bg-rose-100 text-rose-700' },
  not_connected: { label: '미연결', class: 'badge bg-gray-100 text-gray-700' },
}

const CLIENT_STATUS_LABEL: Record<string, { label: string; class: string }> = {
  active: { label: '운영 중', class: 'badge bg-emerald-100 text-emerald-700' },
  paused: { label: '일시중단', class: 'badge bg-amber-100 text-amber-700' },
  terminated: { label: '해지', class: 'badge bg-gray-100 text-gray-700' },
  onboarding: { label: '온보딩', class: 'badge bg-blue-100 text-blue-700' },
}

export default function ConnectClientsPage() {
  const userId = useAuthStore((s) => s.user?.id ?? 1)
  const [showAddModal, setShowAddModal] = useState(false)
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [statusFilter, setStatusFilter] = useState<string | undefined>(undefined)
  const [search, setSearch] = useState('')

  const listQuery = useQuery({
    queryKey: ['connect-clients', statusFilter, search],
    queryFn: () =>
      connectApi
        .listClients({
          client_status: statusFilter,
          search: search || undefined,
          size: 100,
        })
        .then((r) => r.data),
  })

  const data = listQuery.data
  const items: any[] = data?.items || []
  const summary = data?.summary || {}

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">수임고객 관리</h1>
          <p className="text-gray-500 mt-1">
            수임고객 거래 자동 수집부터 검토 대기 전표 처리까지 한 화면에서.
          </p>
        </div>
        <button onClick={() => setShowAddModal(true)} className="btn-primary">
          <PlusIcon className="h-5 w-5 mr-1" />
          수임고객 등록
        </button>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="운영 중"
          value={summary.active ?? 0}
          unit="곳"
          tone="success"
          icon={<UserGroupIcon className="h-5 w-5" />}
        />
        <StatCard label="온보딩 중" value={summary.onboarding ?? 0} unit="곳" tone="primary" />
        <StatCard
          label="수집 오류"
          value={summary.errors ?? 0}
          unit="곳"
          tone={summary.errors > 0 ? 'danger' : 'neutral'}
          icon={<ExclamationCircleIcon className="h-5 w-5" />}
        />
        <StatCard
          label="검토 대기 전표"
          value={summary.total_pending_vouchers ?? 0}
          unit="건"
          tone={summary.total_pending_vouchers > 0 ? 'warning' : 'success'}
          icon={<ClipboardDocumentCheckIcon className="h-5 w-5" />}
        />
      </div>

      {/* Filters */}
      <div className="card">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex gap-1 bg-gray-100 rounded-lg p-1">
            {[
              { key: undefined, label: '전체' },
              { key: 'active', label: '운영중' },
              { key: 'onboarding', label: '온보딩' },
              { key: 'paused', label: '일시중단' },
            ].map((t) => (
              <button
                key={t.label}
                onClick={() => setStatusFilter(t.key)}
                className={`px-3 py-1.5 rounded-md text-sm font-medium ${
                  statusFilter === t.key ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="회사명/사업자번호 검색"
            className="input w-64 ml-auto"
          />
        </div>
      </div>

      {/* Clients */}
      <div className="space-y-3">
        {items.map((c) => (
          <ClientRow
            key={c.id}
            client={c}
            expanded={expandedId === c.id}
            onToggle={() => setExpandedId(expandedId === c.id ? null : c.id)}
            userId={userId}
          />
        ))}
        {items.length === 0 && !listQuery.isLoading && (
          <div className="card text-center text-gray-400 py-8">
            등록된 수임고객이 없습니다.
          </div>
        )}
      </div>

      {showAddModal && <AddClientModal onClose={() => setShowAddModal(false)} />}
    </div>
  )
}

function ClientRow({
  client,
  expanded,
  onToggle,
  userId,
}: {
  client: any
  expanded: boolean
  onToggle: () => void
  userId: number
}) {
  const status = CLIENT_STATUS_LABEL[client.client_status] || CLIENT_STATUS_LABEL.active
  const collect = COLLECTION_LABEL[client.auto_collection_status] || COLLECTION_LABEL.not_connected

  return (
    <div className="card p-0 overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full p-5 flex items-center gap-4 hover:bg-gray-50 transition text-left"
      >
        {expanded ? (
          <ChevronDownIcon className="h-4 w-4 text-gray-400 flex-shrink-0" />
        ) : (
          <ChevronRightIcon className="h-4 w-4 text-gray-400 flex-shrink-0" />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-gray-900 truncate">{client.company_name}</span>
            <span className={status.class}>{status.label}</span>
            {client.is_clobe_ai_connected && (
              <span className="badge bg-teal-50 text-teal-700">SmartFinance 연결됨</span>
            )}
          </div>
          <div className="text-xs text-gray-500 mt-0.5 font-mono">
            {maskBusinessNumber(client.business_number)} · {client.industry || '미분류'}
          </div>
        </div>

        <div className="hidden md:flex items-center gap-6 text-sm">
          <div className="text-center">
            <div className="text-gray-500 text-xs">자동 수집</div>
            <div className="mt-0.5">
              <span className={collect.class}>{collect.label}</span>
            </div>
          </div>
          <div className="text-center">
            <div className="text-gray-500 text-xs">분류율</div>
            <div className="mt-0.5 font-mono font-semibold text-gray-900">
              {client.classification_rate
                ? formatPct(client.classification_rate * 100)
                : '-'}
            </div>
          </div>
          <div className="text-center">
            <div className="text-gray-500 text-xs">검토 대기</div>
            <div
              className={`mt-0.5 font-mono font-semibold ${
                client.pending_voucher_count > 0 ? 'text-amber-600' : 'text-gray-400'
              }`}
            >
              {client.pending_voucher_count}건
            </div>
          </div>
          <div className="text-center">
            <div className="text-gray-500 text-xs">월 수임료</div>
            <div className="mt-0.5 font-mono text-gray-900">
              {client.monthly_fee ? `${formatCompactWon(client.monthly_fee)}원` : '-'}
            </div>
          </div>
        </div>
      </button>

      {expanded && <ClientDetail clientId={client.id} userId={userId} />}
    </div>
  )
}

function ClientDetail({ clientId, userId }: { clientId: number; userId: number }) {
  const qc = useQueryClient()

  const collectionQuery = useQuery({
    queryKey: ['connect-collection', clientId],
    queryFn: () => connectApi.getCollectionStatus(clientId).then((r) => r.data),
  })

  const pendingQuery = useQuery({
    queryKey: ['connect-pending', clientId],
    queryFn: () => connectApi.listPendingVouchers(clientId, { size: 50 }).then((r) => r.data),
  })

  const triggerMut = useMutation({
    mutationFn: () => connectApi.triggerCollection(clientId),
    onSuccess: () => {
      toast.success('수집 요청이 큐에 등록되었습니다.')
      qc.invalidateQueries({ queryKey: ['connect-collection', clientId] })
    },
  })

  const approveMut = useMutation({
    mutationFn: (voucherId: number) => connectApi.approveVoucher(voucherId, userId),
    onSuccess: () => {
      toast.success('승인되었습니다.')
      qc.invalidateQueries({ queryKey: ['connect-pending', clientId] })
    },
  })

  return (
    <div className="border-t border-gray-200 bg-gray-50 p-5 space-y-5">
      {/* Collection sources */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h4 className="font-semibold text-gray-900">자동 수집 소스</h4>
          <button
            onClick={() => triggerMut.mutate()}
            disabled={triggerMut.isPending}
            className="btn-secondary text-xs"
          >
            <ArrowPathIcon className="h-3.5 w-3.5 mr-1" />
            {triggerMut.isPending ? '큐잉 중...' : '전체 즉시 수집'}
          </button>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
          {collectionQuery.data?.sources?.map((s: any) => {
            const meta = COLLECTION_LABEL[s.sync_status] || COLLECTION_LABEL.not_connected
            return (
              <div key={s.id} className="bg-white border border-gray-200 rounded p-3">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-medium text-gray-900">{s.label}</div>
                  <span className={meta.class}>{meta.label}</span>
                </div>
                <div className="text-xs text-gray-500 mt-1">{s.institution_name}</div>
                <div className="text-xs text-gray-400 mt-1">
                  {formatRelativeTime(s.last_synced_at)}
                </div>
                {s.error_message && (
                  <div className="text-xs text-rose-600 mt-1">{s.error_message}</div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* Pending vouchers */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h4 className="font-semibold text-gray-900">
            검토 대기 전표
            {pendingQuery.data && (
              <span className="ml-2 text-xs text-gray-500">
                낮은 신뢰도 {pendingQuery.data.low_confidence_count}건 / 전체 {pendingQuery.data.total}건
              </span>
            )}
          </h4>
        </div>
        <div className="bg-white border border-gray-200 rounded">
          <table className="table">
            <thead className="table-header">
              <tr>
                <th>날짜</th>
                <th>거래처</th>
                <th>적요</th>
                <th>제안 계정</th>
                <th>신뢰도</th>
                <th className="text-right">금액</th>
                <th></th>
              </tr>
            </thead>
            <tbody className="table-body">
              {pendingQuery.data?.items?.map((v: any) => {
                const isLow = v.confidence < 0.8
                return (
                  <tr key={v.voucher_id}>
                    <td className="text-sm text-gray-700">{v.transaction_date}</td>
                    <td className="text-sm text-gray-900">{v.counterparty || '-'}</td>
                    <td className="text-sm text-gray-700 max-w-xs truncate">{v.description}</td>
                    <td className="text-sm">
                      <div className="font-medium text-gray-900">{v.suggested_account_name}</div>
                      <div className="text-xs text-gray-500 font-mono">{v.suggested_account_code}</div>
                    </td>
                    <td>
                      <span
                        className={`text-sm font-mono font-semibold ${
                          isLow ? 'text-rose-600' : 'text-emerald-600'
                        }`}
                      >
                        {formatPct(v.confidence * 100, 0)}
                      </span>
                    </td>
                    <td className="text-right font-mono tabular-nums">
                      {formatCompactWon(v.amount)}원
                    </td>
                    <td>
                      <div className="flex gap-1">
                        <button
                          onClick={() => approveMut.mutate(v.voucher_id)}
                          className="text-xs text-emerald-600 hover:underline"
                        >
                          승인
                        </button>
                        <button className="text-xs text-gray-500 hover:underline">수정</button>
                      </div>
                    </td>
                  </tr>
                )
              })}
              {pendingQuery.data?.items?.length === 0 && (
                <tr>
                  <td colSpan={7} className="text-center text-gray-400 py-6 text-sm">
                    검토 대기 전표가 없습니다.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

function AddClientModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [biz, setBiz] = useState('')
  const [rep, setRep] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [industry, setIndustry] = useState('')
  const [fee, setFee] = useState('')

  const createMut = useMutation({
    mutationFn: () =>
      connectApi.createClient({
        company_name: name,
        business_number: biz,
        representative_name: rep || undefined,
        contact_email: email || undefined,
        contact_phone: phone || undefined,
        industry: industry || undefined,
        monthly_fee: fee ? Number(fee) : undefined,
      }),
    onSuccess: () => {
      toast.success('수임고객이 등록되었습니다.')
      qc.invalidateQueries({ queryKey: ['connect-clients'] })
      onClose()
    },
    onError: (e: any) => toast.error(e.response?.data?.detail || '등록에 실패했습니다.'),
  })

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-gray-900">수임고객 등록</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <XMarkIcon className="h-5 w-5" />
          </button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="label">회사명</label>
            <input value={name} onChange={(e) => setName(e.target.value)} className="input" />
          </div>
          <div>
            <label className="label">사업자등록번호</label>
            <input
              value={biz}
              onChange={(e) => setBiz(e.target.value)}
              placeholder="123-45-67890"
              className="input"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">대표자명</label>
              <input value={rep} onChange={(e) => setRep(e.target.value)} className="input" />
            </div>
            <div>
              <label className="label">업종</label>
              <input value={industry} onChange={(e) => setIndustry(e.target.value)} className="input" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">이메일</label>
              <input value={email} onChange={(e) => setEmail(e.target.value)} className="input" />
            </div>
            <div>
              <label className="label">전화</label>
              <input value={phone} onChange={(e) => setPhone(e.target.value)} className="input" />
            </div>
          </div>
          <div>
            <label className="label">월 수임료 (원)</label>
            <input
              type="number"
              value={fee}
              onChange={(e) => setFee(e.target.value)}
              placeholder="250000"
              className="input"
            />
          </div>
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <button onClick={onClose} className="btn-secondary">
            취소
          </button>
          <button
            disabled={!name || !biz || createMut.isPending}
            onClick={() => createMut.mutate()}
            className="btn-primary"
          >
            {createMut.isPending ? '등록 중...' : '등록'}
          </button>
        </div>
      </div>
    </div>
  )
}
