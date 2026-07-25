import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  ArrowsRightLeftIcon, CalendarDaysIcon, BuildingLibraryIcon,
  ArrowRightIcon,
} from '@heroicons/react/24/outline'
import { treasuryApi } from '@/services/api'
import { formatCurrency, isoLocal } from '@/utils/format'

function todayISO() { return isoLocal(new Date()) }
function daysAgoISO(n: number) {
  const d = new Date(); d.setDate(d.getDate() - n); return isoLocal(d)
}

export default function InternalTransfersPage() {
  const [from, setFrom] = useState(daysAgoISO(30))
  const [to, setTo] = useState(todayISO())

  const query = useQuery({
    queryKey: ['internal-transfers', from, to],
    queryFn: () => treasuryApi.internalTransfers(from, to).then((r) => r.data),
  })

  const data = query.data
  const accounts = data?.accounts || []
  const transfers = data?.transfers || []

  return (
    <div className="space-y-3">
      <div className="flex items-end justify-between flex-wrap gap-2">
        <div>
          <h1 className="flex items-center gap-2">
            <ArrowsRightLeftIcon className="h-5 w-5 text-blue-500" />
            은행간 내부거래
          </h1>
          <p className="text-xs text-ink-500 mt-1">
            회사 계좌끼리의 이체만 모아 기간 누적 대차(계좌별 보냄/받음/순액)를 보여줍니다 — 매출·비용과 섞이지 않게 분리 관리
          </p>
        </div>
        <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-white border border-ink-200">
          <CalendarDaysIcon className="h-3.5 w-3.5 text-ink-400" />
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
            className="bg-transparent text-xs font-medium text-ink-700 focus:outline-none w-28" />
          <span className="text-ink-300">→</span>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
            className="bg-transparent text-xs font-medium text-ink-700 focus:outline-none w-28" />
        </div>
      </div>

      {query.isLoading ? (
        <div className="panel p-10 text-center text-2xs text-ink-400">
          그랜터 통장거래에서 내부이체를 찾는 중… (기간이 길면 수십 초 걸릴 수 있어요)
        </div>
      ) : query.isError ? (
        <div className="panel p-10 text-center text-2xs text-red-500">
          조회 실패: {(query.error as any)?.response?.data?.detail || '네트워크 오류'}
        </div>
      ) : (
        <>
          {/* KPI */}
          <div className="grid grid-cols-3 gap-2">
            <div className="panel p-3">
              <div className="text-2xs text-ink-500">내부이체 건수</div>
              <div className="text-lg font-bold text-ink-900">{data?.transfer_count?.toLocaleString()}건</div>
            </div>
            <div className="panel p-3">
              <div className="text-2xs text-ink-500">총 이동 금액</div>
              <div className="text-lg font-bold text-ink-900">{formatCurrency(data?.total_amount || 0, false)}</div>
            </div>
            <div className="panel p-3">
              <div className="text-2xs text-ink-500">관련 계좌</div>
              <div className="text-lg font-bold text-ink-900">{accounts.length}개</div>
            </div>
          </div>

          {/* 계좌별 누적 대차 */}
          <div className="panel overflow-hidden">
            <div className="px-3 py-2 border-b border-ink-200 text-2xs font-semibold text-ink-500 uppercase flex items-center gap-1">
              <BuildingLibraryIcon className="h-3 w-3" />
              계좌별 누적 대차 (받음 − 보냄 = 순액)
            </div>
            {accounts.length === 0 ? (
              <div className="p-8 text-center text-2xs text-ink-400">기간 내 내부이체 없음</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-2xs text-ink-500 border-b border-ink-100">
                      <th className="text-left px-3 py-1.5">계좌</th>
                      <th className="text-right px-3 py-1.5">보낸 금액</th>
                      <th className="text-right px-3 py-1.5">받은 금액</th>
                      <th className="text-right px-3 py-1.5">순액</th>
                      <th className="text-right px-3 py-1.5">건수</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-50">
                    {accounts.map((a: any) => (
                      <tr key={a.account} className="hover:bg-canvas-50">
                        <td className="px-3 py-1.5 font-medium text-ink-900">{a.account}</td>
                        <td className="px-3 py-1.5 text-right font-mono text-rose-600">
                          {a.sent > 0 ? `-${formatCurrency(a.sent, false)}` : '-'}
                        </td>
                        <td className="px-3 py-1.5 text-right font-mono text-emerald-600">
                          {a.received > 0 ? `+${formatCurrency(a.received, false)}` : '-'}
                        </td>
                        <td className={`px-3 py-1.5 text-right font-mono font-bold ${a.net >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
                          {a.net >= 0 ? '+' : ''}{formatCurrency(a.net, false)}
                        </td>
                        <td className="px-3 py-1.5 text-right text-ink-500">{a.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* 이체 내역 */}
          <div className="panel overflow-hidden">
            <div className="px-3 py-2 border-b border-ink-200 text-2xs font-semibold text-ink-500 uppercase flex items-center justify-between">
              <span>내부이체 내역 · 최신순 ({transfers.length}건)</span>
              {data.unresolved_count > 0 && (
                <span className="text-2xs text-ink-400 normal-case font-normal">
                  상대 계좌 미확정 {data.unresolved_count}건 (상대 은행 미연동)
                </span>
              )}
            </div>
            {transfers.length === 0 ? (
              <div className="p-8 text-center text-2xs text-ink-400">기간 내 내부이체 없음</div>
            ) : (
              <div className="divide-y divide-ink-50 max-h-[560px] overflow-y-auto">
                {transfers.map((t: any, i: number) => (
                  <div key={i} className="px-3 py-2 flex items-center gap-2 hover:bg-canvas-50">
                    <span className="text-2xs text-ink-500 w-24 flex-shrink-0">{t.date} {t.time}</span>
                    <div className="flex items-center gap-1.5 flex-1 min-w-0">
                      <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${t.from_label === '계좌 미상' ? 'bg-ink-50 text-ink-400' : 'bg-rose-50 text-rose-700'}`}>
                        {t.from_label}
                      </span>
                      <ArrowRightIcon className="h-3.5 w-3.5 text-blue-500 flex-shrink-0" />
                      <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${t.to_label === '계좌 미상' ? 'bg-ink-50 text-ink-400' : 'bg-emerald-50 text-emerald-700'}`}>
                        {t.to_label}
                      </span>
                      {t.memo && <span className="text-2xs text-ink-400 truncate hidden sm:inline">· {t.memo}</span>}
                    </div>
                    <span className="text-sm font-bold font-mono text-ink-900 flex-shrink-0">
                      {formatCurrency(t.amount, false)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 연결된 계좌 안내 */}
          {(data.known_accounts || []).length > 0 && (
            <div className="text-2xs text-ink-400">
              연결된 회사 계좌: {data.known_accounts.map((a: any) => a.label).join(' · ')}
              {data.unresolved_count > 0 && (
                <span className="block mt-0.5">
                  ※ '계좌 미상'은 상대 계좌가 그랜터에 연동되지 않아 이름을 특정하지 못한 건입니다(금액·방향은 정확). 상대 계좌를 그랜터에 연결하면 자동으로 이름이 채워집니다.
                </span>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
