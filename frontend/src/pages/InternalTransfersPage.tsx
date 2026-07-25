import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  ArrowsRightLeftIcon, CalendarDaysIcon, BuildingLibraryIcon,
  ArrowRightIcon, Cog6ToothIcon, BanknotesIcon,
} from '@heroicons/react/24/outline'
import { treasuryApi } from '@/services/api'
import { formatCurrency, isoLocal } from '@/utils/format'
import DateRangePresets from '@/components/common/DateRangePresets'
import toast from 'react-hot-toast'

const FLOW_LABEL: Record<string, { label: string; cls: string }> = {
  topup: { label: '매출풀→운영 메꿈', cls: 'text-amber-700' },
  sweep: { label: '운영→매출풀 회수', cls: 'text-emerald-700' },
  savings: { label: '적립 이동(잔액유지)', cls: 'text-violet-600' },
  other: { label: '기타 이동', cls: 'text-ink-400' },
}

function todayISO() { return isoLocal(new Date()) }
function daysAgoISO(n: number) {
  const d = new Date(); d.setDate(d.getDate() - n); return isoLocal(d)
}

export default function InternalTransfersPage() {
  const qc = useQueryClient()
  const [from, setFrom] = useState(daysAgoISO(30))
  const [to, setTo] = useState(todayISO())
  const [showRoles, setShowRoles] = useState(false)

  const query = useQuery({
    queryKey: ['internal-transfers', from, to],
    queryFn: () => treasuryApi.internalTransfers(from, to).then((r) => r.data),
  })

  const roleMut = useMutation({
    mutationFn: (v: { account_label: string; role: string }) => treasuryApi.setAccountRole(v),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['internal-transfers'] }); toast.success('계좌 역할이 반영되었습니다') },
  })

  const data = query.data
  const accounts = data?.accounts || []
  const transfers = data?.transfers || []
  const cf = data?.cash_flow

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
        <div className="flex items-center gap-1.5">
          <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-white border border-ink-200">
            <CalendarDaysIcon className="h-3.5 w-3.5 text-ink-400" />
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
              className="bg-transparent text-xs font-medium text-ink-700 focus:outline-none w-28" />
            <span className="text-ink-300">→</span>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
              className="bg-transparent text-xs font-medium text-ink-700 focus:outline-none w-28" />
          </div>
          <button onClick={() => setShowRoles(!showRoles)}
            className="px-2 py-1.5 text-xs rounded-md border border-ink-200 text-ink-600 hover:bg-ink-50 flex items-center gap-1">
            <Cog6ToothIcon className="h-3.5 w-3.5" />계좌 역할
          </button>
        </div>
      </div>

      <DateRangePresets from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t) }} />

      {/* 계좌 역할 설정 */}
      {showRoles && data?.account_roles && (
        <div className="panel p-3">
          <div className="text-2xs font-semibold text-ink-600 mb-2">
            계좌 역할 지정 — 매출 보관(신한 등)·운영지출(기업 등)·적립(퇴직연금)
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
            {data.account_roles.map((a: any) => (
              <div key={a.label} className="flex items-center gap-2 text-xs">
                <span className="flex-1 truncate text-ink-800">{a.label}
                  {a.name && <span className="text-2xs text-ink-400 ml-1">{a.name}</span>}
                </span>
                <select value={a.role}
                  onChange={(e) => roleMut.mutate({ account_label: a.label, role: e.target.value })}
                  className="px-1.5 py-0.5 text-2xs rounded border border-ink-200 focus:outline-none">
                  {(data.role_options || []).map((o: any) => (
                    <option key={o.key} value={o.key}>{o.label}</option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        </div>
      )}

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

          {/* 은행 잔액 기반 현금흐름 (핵심 지표) */}
          {data.period_balance && (
            <div className="panel p-3 bg-gradient-to-br from-blue-50/40 to-white">
              <div className="text-2xs font-semibold text-ink-600 mb-2 flex items-center gap-1">
                <BanknotesIcon className="h-3 w-3" />은행 잔액 기반 현금흐름 (기간 시작 vs 마감)
              </div>
              <div className="flex items-center gap-3 flex-wrap">
                <div className="flex items-center gap-2">
                  <div className="text-center">
                    <div className="text-2xs text-ink-500">시작 잔액</div>
                    <div className="text-sm font-bold font-mono text-ink-700">{formatCurrency(data.period_balance.start_balance, false)}</div>
                  </div>
                  <ArrowRightIcon className="h-4 w-4 text-ink-300" />
                  <div className="text-center">
                    <div className="text-2xs text-ink-500">마감 잔액</div>
                    <div className="text-sm font-bold font-mono text-ink-900">{formatCurrency(data.period_balance.end_balance, false)}</div>
                  </div>
                </div>
                <div className={`ml-auto px-3 py-1.5 rounded-md ${data.period_balance.net_change >= 0 ? 'bg-emerald-50 border border-emerald-200' : 'bg-rose-50 border border-rose-200'}`}>
                  <div className="text-2xs text-ink-500">기간 순현금흐름</div>
                  <div className={`text-lg font-bold font-mono ${data.period_balance.net_change >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
                    {data.period_balance.net_change >= 0 ? '+' : ''}{formatCurrency(data.period_balance.net_change, false)}
                  </div>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2 mt-2">
                <div className="text-2xs text-ink-500">기간 총 유입 <b className="text-emerald-700 font-mono">{formatCurrency(data.period_balance.inflow, false)}</b></div>
                <div className="text-2xs text-ink-500">기간 총 유출 <b className="text-rose-700 font-mono">{formatCurrency(data.period_balance.outflow, false)}</b></div>
              </div>
              <div className="text-2xs text-ink-400 mt-1.5 leading-relaxed">
                전 계좌 합산 잔액의 시작→마감 변동입니다. 플러스면 기간 중 현금이 늘었고, 마이너스면 카드·이자 등으로 순유출된 것입니다.
              </div>
            </div>
          )}

          {/* 계좌간 자금 이동(참고) — 매출풀↔운영 메꿈 흐름 */}
          {cf && (cf.reservoir_to_operating > 0 || cf.savings_move > 0) && (
            <div className="panel p-3">
              <div className="text-2xs font-semibold text-ink-600 mb-2">계좌간 자금 이동 내역 (참고 — 회사 전체 잔액엔 영향 없음)</div>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
                <div className="bg-canvas-50 rounded-md p-2">
                  <div className="text-2xs text-amber-700">매출풀→운영 메꿈</div>
                  <div className="text-sm font-bold text-ink-900 mt-0.5">{formatCurrency(cf.reservoir_to_operating, false)}</div>
                  <div className="text-2xs text-ink-400">카드·이자 결제용 이체</div>
                </div>
                <div className="bg-canvas-50 rounded-md p-2">
                  <div className="text-2xs text-emerald-700">운영→매출풀 회수</div>
                  <div className="text-sm font-bold text-ink-900 mt-0.5">{formatCurrency(cf.operating_to_reservoir, false)}</div>
                </div>
                <div className="bg-canvas-50 rounded-md p-2">
                  <div className="text-2xs text-violet-600">적립 이동(퇴직연금)</div>
                  <div className="text-sm font-bold text-ink-900 mt-0.5">{formatCurrency(cf.savings_move, false)}</div>
                </div>
                <div className="bg-canvas-50 rounded-md p-2">
                  <div className="text-2xs text-ink-500">기타 이동</div>
                  <div className="text-sm font-bold text-ink-900 mt-0.5">{formatCurrency(cf.other_move, false)}</div>
                </div>
              </div>
            </div>
          )}

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
                  {data.account_totals && (
                    <tfoot>
                      <tr className="border-t-2 border-ink-200 bg-canvas-50 font-bold">
                        <td className="px-3 py-1.5 text-ink-900">누적 합계</td>
                        <td className="px-3 py-1.5 text-right font-mono text-rose-700">-{formatCurrency(data.account_totals.total_sent, false)}</td>
                        <td className="px-3 py-1.5 text-right font-mono text-emerald-700">+{formatCurrency(data.account_totals.total_received, false)}</td>
                        <td className="px-3 py-1.5 text-right font-mono text-ink-900">
                          {formatCurrency(data.account_totals.net_sum, false)}
                          <span className="text-2xs font-normal text-ink-400 ml-1">
                            {Math.abs(data.account_totals.net_sum) < 1 ? '(상계 0)' : '(미상 잔차)'}
                          </span>
                        </td>
                        <td className="px-3 py-1.5"></td>
                      </tr>
                    </tfoot>
                  )}
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
                      {t.flow_type && FLOW_LABEL[t.flow_type] && (
                        <span className={`text-2xs ${FLOW_LABEL[t.flow_type].cls} hidden sm:inline`}>
                          · {FLOW_LABEL[t.flow_type].label}
                        </span>
                      )}
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
