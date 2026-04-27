import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import {
  ArrowsRightLeftIcon,
  CreditCardIcon,
  BuildingLibraryIcon,
  DocumentTextIcon,
  ArrowPathIcon,
  PlusIcon,
  XCircleIcon,
  CheckCircleIcon,
  ExclamationTriangleIcon,
  MagnifyingGlassIcon,
} from '@heroicons/react/24/outline'
import { unifiedApi } from '@/services/api'
import StatCard from '@/components/common/StatCard'
import { formatCurrency, formatCompactWon, formatRelativeTime } from '@/utils/format'

type SourceType = 'bank' | 'card' | 'tax_invoice'
type DirectionType = 'inbound' | 'outbound'

const SOURCE_META: Record<SourceType, { label: string; icon: any; chip: string }> = {
  bank: { label: '계좌', icon: BuildingLibraryIcon, chip: 'bg-blue-50 text-blue-700' },
  card: { label: '카드', icon: CreditCardIcon, chip: 'bg-purple-50 text-purple-700' },
  tax_invoice: { label: '세금계산서', icon: DocumentTextIcon, chip: 'bg-emerald-50 text-emerald-700' },
}

export default function UnifiedViewPage() {
  const qc = useQueryClient()
  const [activeSources, setActiveSources] = useState<Set<SourceType>>(new Set(['bank', 'card', 'tax_invoice']))
  const [direction, setDirection] = useState<DirectionType | undefined>(undefined)
  const [search, setSearch] = useState('')
  const [onlyUnclassified, setOnlyUnclassified] = useState(false)

  const summaryQuery = useQuery({
    queryKey: ['unified-summary'],
    queryFn: () => unifiedApi.getSummary().then((r) => r.data),
  })

  const sourcesQuery = useQuery({
    queryKey: ['unified-sources'],
    queryFn: () => unifiedApi.listSources().then((r) => r.data),
  })

  const txQuery = useQuery({
    queryKey: ['unified-tx', Array.from(activeSources), direction, search, onlyUnclassified],
    queryFn: () =>
      unifiedApi
        .listTransactions({
          sources: Array.from(activeSources),
          direction,
          search: search || undefined,
          only_unclassified: onlyUnclassified || undefined,
          size: 100,
        })
        .then((r) => r.data),
  })

  const syncMutation = useMutation({
    mutationFn: (sourceId: number) => unifiedApi.triggerSync(sourceId),
    onSuccess: () => {
      toast.success('동기화 요청을 큐에 등록했습니다.')
      qc.invalidateQueries({ queryKey: ['unified-sources'] })
    },
  })

  const summary = summaryQuery.data
  const sources = sourcesQuery.data || []
  const tx = txQuery.data

  const toggleSource = (s: SourceType) => {
    const next = new Set(activeSources)
    if (next.has(s)) next.delete(s)
    else next.add(s)
    setActiveSources(next)
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">통합 데이터 실시간 조회</h1>
          <p className="text-gray-500 mt-1">
            모든 계좌·법인카드·세금계산서를 한 화면에서. 전 지점 잔액을 10초 안에 확인하세요.
          </p>
        </div>
        <button className="btn-primary">
          <PlusIcon className="h-5 w-5 mr-1" />
          데이터 소스 연결
        </button>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="전체 잔액"
          value={formatCurrency(summary?.total_balance || 0, false)}
          unit="원"
          hint={summary ? `최근 동기화 ${formatRelativeTime(summary.last_sync_at)}` : ''}
          tone="primary"
          icon={<BuildingLibraryIcon className="h-5 w-5" />}
        />
        <StatCard
          label="기간 내 입금"
          value={formatCompactWon(summary?.inbound_total || 0)}
          unit="원"
          tone="success"
          icon={<ArrowsRightLeftIcon className="h-5 w-5" />}
        />
        <StatCard
          label="기간 내 출금"
          value={formatCompactWon(summary?.outbound_total || 0)}
          unit="원"
          tone="danger"
          icon={<ArrowsRightLeftIcon className="h-5 w-5" />}
        />
        <StatCard
          label="미분류 거래"
          value={summary?.unclassified_count ?? 0}
          unit="건"
          hint={summary?.unclassified_count ? 'AI 분류 검토 필요' : '모두 분류됨'}
          tone={summary?.unclassified_count ? 'warning' : 'success'}
          icon={<ExclamationTriangleIcon className="h-5 w-5" />}
        />
      </div>

      {/* Connected sources */}
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-900">연동된 데이터 소스</h2>
          <span className="text-sm text-gray-500">{sources.length}개 연결</span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
          {sources.map((src: any) => {
            const meta = SOURCE_META[src.type as SourceType]
            const Icon = meta.icon
            const ok = src.sync_status === 'ok'
            return (
              <div
                key={src.id}
                className="rounded-lg border border-gray-200 p-4 flex items-start justify-between"
              >
                <div className="flex items-start gap-3">
                  <div className={`p-2 rounded ${meta.chip}`}>
                    <Icon className="h-5 w-5" />
                  </div>
                  <div>
                    <div className="font-medium text-gray-900">{src.name}</div>
                    <div className="text-xs text-gray-500 mt-0.5">{src.institution}</div>
                    <div className="mt-1.5 flex items-center gap-1.5 text-xs">
                      {ok ? (
                        <CheckCircleIcon className="h-4 w-4 text-emerald-500" />
                      ) : (
                        <XCircleIcon className="h-4 w-4 text-rose-500" />
                      )}
                      <span className={ok ? 'text-emerald-600' : 'text-rose-600'}>
                        {ok ? '정상' : '오류'}
                      </span>
                      <span className="text-gray-400">· {formatRelativeTime(src.last_sync_at)}</span>
                    </div>
                  </div>
                </div>
                <button
                  className="text-gray-400 hover:text-primary-600"
                  onClick={() => syncMutation.mutate(src.id)}
                  title="즉시 동기화"
                >
                  <ArrowPathIcon className="h-4 w-4" />
                </button>
              </div>
            )
          })}
        </div>
      </div>

      {/* Filters + Transactions */}
      <div className="card">
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <div className="flex gap-1 bg-gray-100 rounded-lg p-1">
            {(['bank', 'card', 'tax_invoice'] as SourceType[]).map((s) => {
              const isOn = activeSources.has(s)
              const meta = SOURCE_META[s]
              const Icon = meta.icon
              return (
                <button
                  key={s}
                  onClick={() => toggleSource(s)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition ${
                    isOn ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                  }`}
                >
                  <Icon className="h-4 w-4" />
                  {meta.label}
                </button>
              )
            })}
          </div>

          <div className="flex gap-1 bg-gray-100 rounded-lg p-1">
            {[
              { key: undefined, label: '전체' },
              { key: 'inbound' as const, label: '입금' },
              { key: 'outbound' as const, label: '출금' },
            ].map((d) => (
              <button
                key={d.label}
                onClick={() => setDirection(d.key)}
                className={`px-3 py-1.5 rounded-md text-sm font-medium transition ${
                  direction === d.key ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'
                }`}
              >
                {d.label}
              </button>
            ))}
          </div>

          <label className="flex items-center gap-2 text-sm text-gray-700 ml-auto">
            <input
              type="checkbox"
              checked={onlyUnclassified}
              onChange={(e) => setOnlyUnclassified(e.target.checked)}
              className="rounded border-gray-300 text-primary-600 focus:ring-primary-500"
            />
            미분류만
          </label>

          <div className="relative">
            <MagnifyingGlassIcon className="h-4 w-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="거래처/적요 검색"
              className="pl-8 input w-60"
            />
          </div>
        </div>

        <div className="table-container">
          <table className="table">
            <thead className="table-header">
              <tr>
                <th>일시</th>
                <th>출처</th>
                <th>거래처</th>
                <th>적요</th>
                <th>분류</th>
                <th className="text-right">금액</th>
              </tr>
            </thead>
            <tbody className="table-body">
              {txQuery.isLoading && (
                <tr>
                  <td colSpan={6} className="text-center text-gray-400 py-8">
                    불러오는 중...
                  </td>
                </tr>
              )}
              {tx?.items?.map((it: any) => {
                const meta = SOURCE_META[it.source as SourceType]
                return (
                  <tr key={it.id}>
                    <td className="whitespace-nowrap text-sm text-gray-700">
                      <div>{it.transaction_date}</div>
                      {it.transaction_time && (
                        <div className="text-xs text-gray-400">{it.transaction_time}</div>
                      )}
                    </td>
                    <td>
                      <span className={`badge ${meta.chip}`}>{meta.label}</span>
                      <div className="text-xs text-gray-500 mt-0.5">{it.source_label}</div>
                    </td>
                    <td className="text-sm text-gray-900 font-medium">{it.counterparty || '-'}</td>
                    <td className="text-sm text-gray-700 max-w-xs truncate">{it.description}</td>
                    <td>
                      {it.is_classified && it.category ? (
                        <span className="badge bg-gray-100 text-gray-700">{it.category}</span>
                      ) : (
                        <span className="badge bg-amber-100 text-amber-700">미분류</span>
                      )}
                    </td>
                    <td className="text-right">
                      <span
                        className={`font-mono tabular-nums font-medium ${
                          it.direction === 'inbound' ? 'text-emerald-700' : 'text-rose-700'
                        }`}
                      >
                        {it.direction === 'inbound' ? '+' : '-'}
                        {formatCurrency(it.amount, false)}
                      </span>
                    </td>
                  </tr>
                )
              })}
              {!txQuery.isLoading && (!tx?.items || tx.items.length === 0) && (
                <tr>
                  <td colSpan={6} className="text-center text-gray-400 py-8">
                    조건에 맞는 거래가 없습니다.
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
