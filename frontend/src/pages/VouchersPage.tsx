import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { vouchersApi } from '@/services/api'
import { PlusIcon, FunnelIcon, ArrowDownTrayIcon } from '@heroicons/react/24/outline'

const statusLabels: Record<string, { label: string; className: string }> = {
  draft: { label: '임시저장', className: 'status-draft' },
  pending_approval: { label: '결재대기', className: 'status-pending' },
  in_approval: { label: '결재진행', className: 'status-pending' },
  approved: { label: '결재완료', className: 'status-approved' },
  rejected: { label: '반려', className: 'status-rejected' },
  confirmed: { label: '확정', className: 'status-confirmed' },
  cancelled: { label: '취소', className: 'status-draft' },
}

function formatCurrency(value: number) {
  return new Intl.NumberFormat('ko-KR').format(value)
}

export default function VouchersPage() {
  const [page, setPage] = useState(1)
  const [filters, setFilters] = useState({
    status: '',
    search: '',
    fromDate: '',
    toDate: '',
  })

  const { data, isLoading } = useQuery({
    queryKey: ['vouchers', page, filters],
    queryFn: () =>
      vouchersApi
        .list({
          page,
          size: 20,
          status: filters.status || undefined,
          search: filters.search || undefined,
          fromDate: filters.fromDate || undefined,
          toDate: filters.toDate || undefined,
        })
        .then((res) => res.data),
  })

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">전표 관리</h1>
          <p className="text-gray-500 mt-1">전표를 생성하고 관리합니다.</p>
        </div>
        <div className="flex gap-3">
          <button className="btn-secondary">
            <ArrowDownTrayIcon className="h-5 w-5 mr-2" />
            엑셀 다운로드
          </button>
          <Link to="/vouchers/new" className="btn-primary">
            <PlusIcon className="h-5 w-5 mr-2" />
            새 전표
          </Link>
        </div>
      </div>

      {/* Filters */}
      <div className="card">
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <FunnelIcon className="h-5 w-5 text-gray-400" />
            <span className="text-sm font-medium text-gray-700">필터</span>
          </div>
          <select
            value={filters.status}
            onChange={(e) => setFilters({ ...filters, status: e.target.value })}
            className="input w-40"
          >
            <option value="">전체 상태</option>
            <option value="draft">임시저장</option>
            <option value="pending_approval">결재대기</option>
            <option value="approved">결재완료</option>
            <option value="confirmed">확정</option>
            <option value="rejected">반려</option>
          </select>
          <input
            type="date"
            value={filters.fromDate}
            onChange={(e) => setFilters({ ...filters, fromDate: e.target.value })}
            className="input w-40"
          />
          <span className="text-gray-400">~</span>
          <input
            type="date"
            value={filters.toDate}
            onChange={(e) => setFilters({ ...filters, toDate: e.target.value })}
            className="input w-40"
          />
          <input
            type="text"
            placeholder="검색..."
            value={filters.search}
            onChange={(e) => setFilters({ ...filters, search: e.target.value })}
            className="input w-60"
          />
        </div>
      </div>

      {/* Table */}
      <div className="table-container">
        <table className="table">
          <thead className="table-header">
            <tr>
              <th>전표번호</th>
              <th>전표일자</th>
              <th>적요</th>
              <th>거래유형</th>
              <th className="text-right">금액</th>
              <th>상태</th>
              <th>AI 신뢰도</th>
              <th>부서</th>
            </tr>
          </thead>
          <tbody className="table-body">
            {isLoading ? (
              <tr>
                <td colSpan={8} className="text-center py-8">
                  로딩 중...
                </td>
              </tr>
            ) : data?.items?.length > 0 ? (
              data.items.map((voucher: any) => (
                <tr key={voucher.id}>
                  <td>
                    <Link
                      to={`/vouchers/${voucher.id}`}
                      className="text-primary-600 hover:text-primary-800 font-medium"
                    >
                      {voucher.voucher_number}
                    </Link>
                  </td>
                  <td>{voucher.voucher_date}</td>
                  <td className="max-w-xs truncate">{voucher.description}</td>
                  <td>
                    <span className="badge-gray">{voucher.transaction_type}</span>
                  </td>
                  <td className="amount">{formatCurrency(voucher.total_debit)}</td>
                  <td>
                    <span className={statusLabels[voucher.status]?.className}>
                      {statusLabels[voucher.status]?.label || voucher.status}
                    </span>
                  </td>
                  <td>
                    {voucher.ai_confidence_score && (
                      <span
                        className={`text-sm font-medium ${
                          voucher.ai_confidence_score >= 0.85
                            ? 'confidence-high'
                            : voucher.ai_confidence_score >= 0.6
                            ? 'confidence-medium'
                            : 'confidence-low'
                        }`}
                      >
                        {(voucher.ai_confidence_score * 100).toFixed(0)}%
                      </span>
                    )}
                  </td>
                  <td>{voucher.department_name}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={8} className="text-center py-8 text-gray-500">
                  전표가 없습니다.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {data && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-gray-500">
            총 {data.total}건 중 {(page - 1) * 20 + 1} - {Math.min(page * 20, data.total)}건
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
              className="btn-secondary"
            >
              이전
            </button>
            <button
              onClick={() => setPage((p) => Math.min(data.pages, p + 1))}
              disabled={page >= data.pages}
              className="btn-secondary"
            >
              다음
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
