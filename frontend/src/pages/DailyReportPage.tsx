import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import {
  PaperAirplaneIcon,
  EnvelopeIcon,
  ChatBubbleLeftRightIcon,
  ChevronUpIcon,
  ChevronDownIcon,
  PlusIcon,
  TrashIcon,
} from '@heroicons/react/24/outline'
import { dailyReportApi } from '@/services/api'
import { useAuthStore } from '@/store/authStore'
import StatCard from '@/components/common/StatCard'
import { formatCurrency, formatCompactWon, formatPct, formatDate, formatRelativeTime, todayISO } from '@/utils/format'

export default function DailyReportPage() {
  const qc = useQueryClient()
  const userId = useAuthStore((s) => s.user?.id ?? 1)
  const [reportDate, setReportDate] = useState<string>(todayISO())
  const [showSubModal, setShowSubModal] = useState(false)

  const reportQuery = useQuery({
    queryKey: ['daily-report', reportDate],
    queryFn: () =>
      reportDate === todayISO()
        ? dailyReportApi.getToday().then((r) => r.data)
        : dailyReportApi.getByDate(reportDate).then((r) => r.data),
  })

  const subQuery = useQuery({
    queryKey: ['daily-report-subs'],
    queryFn: () => dailyReportApi.listSubscriptions().then((r) => r.data),
  })

  const historyQuery = useQuery({
    queryKey: ['daily-report-history'],
    queryFn: () => dailyReportApi.getHistory(7).then((r) => r.data),
  })

  const sendNowMutation = useMutation({
    mutationFn: () => dailyReportApi.sendNow(reportDate),
    onSuccess: () => {
      toast.success('자금일보 발송이 큐에 등록되었습니다.')
      qc.invalidateQueries({ queryKey: ['daily-report-history'] })
    },
  })

  const r = reportQuery.data
  const subs = subQuery.data || []

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">실시간 자금일보</h1>
          <p className="text-gray-500 mt-1">매일 아침, 어제까지의 자금 현황을 한 장으로.</p>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="date"
            value={reportDate}
            onChange={(e) => setReportDate(e.target.value)}
            className="input w-40"
          />
          <button
            onClick={() => sendNowMutation.mutate()}
            disabled={sendNowMutation.isPending}
            className="btn-primary"
          >
            <PaperAirplaneIcon className="h-5 w-5 mr-1" />
            지금 발송
          </button>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="전체 잔액"
          value={formatCurrency(r?.summary?.total_balance, false)}
          unit="원"
          delta={
            r?.summary
              ? {
                  value: `${formatCompactWon(r.summary.change_amount)} (${formatPct(r.summary.change_pct)})`,
                  positive: Number(r.summary.change_amount) >= 0,
                }
              : undefined
          }
          hint={r?.summary ? `전일 ${formatCompactWon(r.summary.yesterday_balance)}원` : ''}
          tone="primary"
        />
        <StatCard
          label="입금"
          value={formatCompactWon(r?.summary?.inbound_total)}
          unit="원"
          tone="success"
        />
        <StatCard
          label="출금"
          value={formatCompactWon(r?.summary?.outbound_total)}
          unit="원"
          tone="danger"
        />
        <StatCard
          label="순현금흐름"
          value={formatCompactWon(r?.summary?.net_cashflow)}
          unit="원"
          tone={Number(r?.summary?.net_cashflow ?? 0) >= 0 ? 'mint' : 'warning'}
        />
      </div>

      {/* Risk strip */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
          <div className="text-sm text-amber-700">7일 내 예정 지급</div>
          <div className="mt-1 text-2xl font-bold text-amber-900">
            {formatCurrency(r?.upcoming_payments_amount, false)}
            <span className="text-sm font-medium ml-1">원</span>
          </div>
        </div>
        <div className="rounded-lg border border-rose-200 bg-rose-50 p-4">
          <div className="text-sm text-rose-700">연체 매출채권</div>
          <div className="mt-1 text-2xl font-bold text-rose-900">
            {formatCurrency(r?.overdue_receivables_amount, false)}
            <span className="text-sm font-medium ml-1">원</span>
          </div>
        </div>
      </div>

      {/* Account snapshots */}
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-900">계좌별 잔액</h2>
          <span className="text-xs text-gray-500">
            기준 {formatDate(r?.summary?.report_date)}
          </span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {r?.accounts?.map((a: any) => {
            const isUp = Number(a.change) >= 0
            return (
              <div key={a.bank_account_id} className="rounded-lg border border-gray-200 p-4">
                <div className="flex items-start justify-between">
                  <div>
                    <div className="text-xs text-gray-500">{a.bank_name}</div>
                    <div className="font-medium text-gray-900">{a.account_alias}</div>
                    <div className="text-xs text-gray-400 font-mono">{a.account_number_masked}</div>
                  </div>
                  <div
                    className={`flex items-center text-sm font-medium ${
                      isUp ? 'text-emerald-600' : 'text-rose-600'
                    }`}
                  >
                    {isUp ? <ChevronUpIcon className="h-4 w-4" /> : <ChevronDownIcon className="h-4 w-4" />}
                    {formatCompactWon(Math.abs(Number(a.change)))}
                  </div>
                </div>
                <div className="mt-3">
                  <div className="text-xl font-bold text-gray-900 tabular-nums">
                    {formatCurrency(a.closing_balance, false)}
                    <span className="text-sm font-medium text-gray-500 ml-1">원</span>
                  </div>
                  <div className="mt-1 flex gap-3 text-xs">
                    <span className="text-emerald-600">+{formatCompactWon(a.inbound_total)}</span>
                    <span className="text-rose-600">-{formatCompactWon(a.outbound_total)}</span>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Top movements */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="card">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">큰 입금 TOP {r?.top_inbound?.length ?? 0}</h2>
          <div className="space-y-2">
            {r?.top_inbound?.map((it: any) => (
              <div key={it.transaction_id} className="flex items-center justify-between border-b border-gray-100 pb-2 last:border-b-0">
                <div>
                  <div className="font-medium text-gray-900">{it.counterparty}</div>
                  <div className="text-xs text-gray-500">
                    {it.transaction_time} · {it.description}
                  </div>
                </div>
                <div className="font-mono tabular-nums font-semibold text-emerald-700">
                  +{formatCurrency(it.amount, false)}
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="card">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">큰 출금 TOP {r?.top_outbound?.length ?? 0}</h2>
          <div className="space-y-2">
            {r?.top_outbound?.map((it: any) => (
              <div key={it.transaction_id} className="flex items-center justify-between border-b border-gray-100 pb-2 last:border-b-0">
                <div>
                  <div className="font-medium text-gray-900">{it.counterparty}</div>
                  <div className="text-xs text-gray-500">
                    {it.transaction_time} · {it.description}
                  </div>
                </div>
                <div className="font-mono tabular-nums font-semibold text-rose-700">
                  -{formatCurrency(it.amount, false)}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Subscriptions + history */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-gray-900">정기 발송 구독</h2>
            <button onClick={() => setShowSubModal(true)} className="btn-secondary text-sm">
              <PlusIcon className="h-4 w-4 mr-1" />
              구독 추가
            </button>
          </div>
          <div className="space-y-2">
            {subs.length === 0 && (
              <div className="text-sm text-gray-500 py-4 text-center">
                정기 발송 설정이 없습니다.
              </div>
            )}
            {subs.map((s: any) => (
              <div key={s.id} className="flex items-center justify-between border border-gray-200 rounded p-3">
                <div className="flex items-center gap-3">
                  {s.delivery_method === 'email' ? (
                    <EnvelopeIcon className="h-5 w-5 text-gray-400" />
                  ) : (
                    <ChatBubbleLeftRightIcon className="h-5 w-5 text-gray-400" />
                  )}
                  <div>
                    <div className="font-medium text-gray-900">{s.delivery_target}</div>
                    <div className="text-xs text-gray-500">
                      매일 {s.schedule_time} · {s.delivery_method.toUpperCase()}
                    </div>
                  </div>
                </div>
                <button className="text-gray-400 hover:text-rose-500">
                  <TrashIcon className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        </div>

        <div className="card">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">최근 발송 이력</h2>
          <div className="space-y-2">
            {historyQuery.data?.map((h: any) => (
              <div key={h.id} className="flex items-center justify-between text-sm border-b border-gray-100 pb-2 last:border-b-0">
                <div>
                  <div className="text-gray-900 font-medium">{formatDate(h.report_date)}</div>
                  <div className="text-xs text-gray-500">{h.delivery_target}</div>
                </div>
                <div className="text-right">
                  <span
                    className={
                      h.status === 'sent'
                        ? 'badge bg-emerald-100 text-emerald-700'
                        : h.status === 'failed'
                        ? 'badge bg-rose-100 text-rose-700'
                        : 'badge bg-gray-100 text-gray-700'
                    }
                  >
                    {h.status === 'sent' ? '발송완료' : h.status === 'failed' ? '실패' : '대기'}
                  </span>
                  <div className="text-xs text-gray-400 mt-0.5">{formatRelativeTime(h.sent_at)}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {showSubModal && <SubscribeModal userId={userId} onClose={() => setShowSubModal(false)} />}
    </div>
  )
}

function SubscribeModal({ userId, onClose }: { userId: number; onClose: () => void }) {
  const qc = useQueryClient()
  const [method, setMethod] = useState<'email' | 'kakao' | 'slack'>('email')
  const [target, setTarget] = useState('')
  const [time, setTime] = useState('09:00')

  const createMut = useMutation({
    mutationFn: () =>
      dailyReportApi.createSubscription(
        { delivery_method: method, delivery_target: target, schedule_time: time, include_attachments: true },
        userId
      ),
    onSuccess: () => {
      toast.success('구독이 추가되었습니다.')
      qc.invalidateQueries({ queryKey: ['daily-report-subs'] })
      onClose()
    },
    onError: (e: any) => toast.error(e.response?.data?.detail || '추가에 실패했습니다.'),
  })

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">정기 발송 구독 추가</h3>
        <div className="space-y-3">
          <div>
            <label className="label">발송 채널</label>
            <select value={method} onChange={(e) => setMethod(e.target.value as any)} className="input">
              <option value="email">이메일</option>
              <option value="kakao">카카오톡</option>
              <option value="slack">Slack 웹훅</option>
            </select>
          </div>
          <div>
            <label className="label">수신 대상</label>
            <input
              type="text"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder={method === 'email' ? 'ceo@example.com' : method === 'kakao' ? '010-1234-5678' : 'https://hooks.slack.com/...'}
              className="input"
            />
          </div>
          <div>
            <label className="label">발송 시간</label>
            <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className="input w-32" />
          </div>
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <button onClick={onClose} className="btn-secondary">
            취소
          </button>
          <button
            disabled={!target || createMut.isPending}
            onClick={() => createMut.mutate()}
            className="btn-primary"
          >
            {createMut.isPending ? '저장 중...' : '추가'}
          </button>
        </div>
      </div>
    </div>
  )
}
