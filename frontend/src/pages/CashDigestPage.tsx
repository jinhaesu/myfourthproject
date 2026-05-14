import { useEffect, useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  SparklesIcon, CreditCardIcon, BanknotesIcon, ChartBarIcon,
  ArrowDownLeftIcon, ArrowUpRightIcon, ChevronUpIcon, ChevronDownIcon,
  CheckIcon,
} from '@heroicons/react/24/outline'
import { cashDigestApi, CashDigestConfig, CashDigestSection } from '@/services/api'
import { formatCurrency } from '@/utils/format'

const SECTION_ICON: Record<string, any> = {
  ai_cashflow: SparklesIcon,
  card_spending: CreditCardIcon,
  cash_status: BanknotesIcon,
  card_usage: ChartBarIcon,
}

const SECTION_ACCENT: Record<string, string> = {
  ai_cashflow: 'from-emerald-50 to-teal-50 border-emerald-200',
  card_spending: 'from-amber-50 to-orange-50 border-amber-200',
  cash_status: 'from-blue-50 to-sky-50 border-blue-200',
  card_usage: 'from-purple-50 to-fuchsia-50 border-purple-200',
}

function todayDateLabel(d?: string): string {
  const date = d ? new Date(d + 'T00:00:00') : new Date()
  date.setDate(date.getDate() + 1)  // 보고서 발송일 = 기준일 + 1일
  const days = ['일', '월', '화', '수', '목', '금', '토']
  return `${date.getMonth() + 1}월 ${date.getDate()}일 (${days[date.getDay()]})`
}

function refDateLabel(d?: string): string {
  if (!d) return ''
  const date = new Date(d + 'T00:00:00')
  const days = ['일', '월', '화', '수', '목', '금', '토']
  return `${date.getMonth() + 1}월 ${date.getDate()}일 (${days[date.getDay()]}) 어제 기준`
}

export default function CashDigestPage() {
  const qc = useQueryClient()
  const [dirty, setDirty] = useState(false)
  const [localCfg, setLocalCfg] = useState<CashDigestConfig | null>(null)

  const sectionsQuery = useQuery({
    queryKey: ['cash-digest-sections'],
    queryFn: () => cashDigestApi.listSections().then((r) => r.data),
  })
  const configQuery = useQuery({
    queryKey: ['cash-digest-config'],
    queryFn: () => cashDigestApi.getConfig().then((r) => r.data),
  })
  const previewQuery = useQuery({
    queryKey: ['cash-digest-preview'],
    queryFn: () => cashDigestApi.preview().then((r) => r.data),
  })

  useEffect(() => {
    if (configQuery.data && !localCfg) setLocalCfg(configQuery.data)
  }, [configQuery.data, localCfg])

  const saveMut = useMutation({
    mutationFn: (cfg: CashDigestConfig) =>
      cashDigestApi.updateConfig({
        enabled: cfg.enabled,
        sections: cfg.sections,
        disabled_sections: cfg.disabled_sections,
        delivery_time: cfg.delivery_time,
        delivery_channels: cfg.delivery_channels,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['cash-digest-config'] })
      qc.invalidateQueries({ queryKey: ['cash-digest-preview'] })
      setDirty(false)
    },
  })

  const sendNowMut = useMutation({
    mutationFn: () => cashDigestApi.sendNow(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cash-digest-preview'] }),
  })

  const sections: CashDigestSection[] = sectionsQuery.data || []
  const preview = previewQuery.data

  // 섹션 순서 — localCfg.sections 우선
  const orderedKeys = useMemo(() => {
    if (!localCfg) return sections.map((s) => s.key)
    return localCfg.sections
  }, [localCfg, sections])

  const disabled = new Set(localCfg?.disabled_sections || [])

  function toggleSection(key: string) {
    if (!localCfg) return
    const req = sections.find((s) => s.key === key)?.required
    if (req) return
    const next = new Set(disabled)
    if (next.has(key)) next.delete(key); else next.add(key)
    setLocalCfg({ ...localCfg, disabled_sections: Array.from(next) })
    setDirty(true)
  }

  function move(key: string, dir: -1 | 1) {
    if (!localCfg) return
    const arr = [...localCfg.sections]
    const idx = arr.indexOf(key)
    if (idx < 0) return
    const ni = idx + dir
    if (ni < 0 || ni >= arr.length) return
    ;[arr[idx], arr[ni]] = [arr[ni], arr[idx]]
    setLocalCfg({ ...localCfg, sections: arr })
    setDirty(true)
  }

  return (
    <div className="space-y-3">
      <div>
        <h1 className="flex items-center gap-2">
          <SparklesIcon className="h-5 w-5 text-emerald-500" />
          AI 자금 다이제스트
        </h1>
        <p className="text-xs text-ink-500 mt-1">
          매일 아침, 우리 회사 자금 상황을 한눈에 — 항목과 순서를 자유롭게 커스텀하세요.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-3">
        {/* 좌측: 미리보기 */}
        <div className="panel overflow-hidden">
          <div className="bg-canvas-50 border-b border-ink-200 px-4 py-2 text-2xs font-semibold text-ink-500 text-center">
            미리보기
          </div>
          <div className="p-6 max-w-2xl mx-auto">
            {/* 헤더 */}
            <div className="text-center mb-5">
              <div className="text-lg font-bold text-ink-900">Smart Finance Core</div>
            </div>

            <div className="mb-5">
              <div className="text-2xl font-extrabold text-ink-900">
                {todayDateLabel(preview?.target_date)}
              </div>
              <div className="text-2xs text-ink-500 mt-0.5">
                {refDateLabel(preview?.target_date)}
              </div>
            </div>

            {previewQuery.isLoading ? (
              <div className="text-center text-2xs text-ink-400 py-8">미리보기 생성 중…</div>
            ) : !preview ? (
              <div className="text-center text-2xs text-ink-400 py-8">미리보기 데이터 없음</div>
            ) : (
              <div className="space-y-4">
                {(preview.sections_order || []).map((key: string) => {
                  if ((preview.disabled_sections || []).includes(key) && !sections.find((s) => s.key === key)?.required) return null
                  const sec = preview.content?.[key]
                  if (!sec) return null
                  return <PreviewSection key={key} sectionKey={key} data={sec} />
                })}
              </div>
            )}
          </div>
        </div>

        {/* 우측: 설정 */}
        <div className="panel p-4 self-start sticky top-3">
          <div className="text-base font-bold text-ink-900 mb-1">매일 아침, 자금 현황을 보내드려요</div>
          <p className="text-2xs text-ink-500 mb-3 leading-relaxed">
            알림톡에서 '자세히 보기'를 클릭하시면<br />
            별도 로그인 없이 자금일보를 조회하실 수 있어요.
          </p>

          <div className="text-2xs font-semibold text-ink-700 mb-2">
            항목과 순서를 원하는 대로 설정할 수 있어요
          </div>

          {!localCfg ? (
            <div className="text-2xs text-ink-400 py-4">불러오는 중…</div>
          ) : (
            <div className="space-y-1.5">
              {orderedKeys.map((key, i) => {
                const meta = sections.find((s) => s.key === key)
                if (!meta) return null
                const Icon = SECTION_ICON[key] || SparklesIcon
                const enabled = !disabled.has(key) || meta.required
                return (
                  <div
                    key={key}
                    className={`flex items-center gap-2 px-2 py-2 border rounded-md ${enabled ? 'bg-white border-ink-200' : 'bg-ink-50 border-ink-100'}`}
                  >
                    {/* 위/아래 화살표 (드래그 대신) */}
                    <div className="flex flex-col gap-0.5 -mr-0.5">
                      <button onClick={() => move(key, -1)} disabled={i === 0}
                        className="text-ink-300 hover:text-ink-700 disabled:opacity-30">
                        <ChevronUpIcon className="h-3 w-3" />
                      </button>
                      <button onClick={() => move(key, 1)} disabled={i === orderedKeys.length - 1}
                        className="text-ink-300 hover:text-ink-700 disabled:opacity-30">
                        <ChevronDownIcon className="h-3 w-3" />
                      </button>
                    </div>
                    <Icon className="h-4 w-4 text-ink-500" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs font-semibold text-ink-800">{meta.label}</span>
                        {meta.required && (
                          <span className="text-2xs text-ink-400">필수</span>
                        )}
                      </div>
                      <div className="text-2xs text-ink-500 leading-tight">{meta.description}</div>
                    </div>
                    {/* 토글 */}
                    {meta.required ? (
                      <div className="w-9 h-5 rounded-full bg-emerald-100 flex items-center justify-end px-0.5">
                        <CheckIcon className="h-3 w-3 text-emerald-700" />
                      </div>
                    ) : (
                      <button
                        onClick={() => toggleSection(key)}
                        className={`relative w-9 h-5 rounded-full transition ${enabled ? 'bg-emerald-500' : 'bg-ink-200'}`}
                      >
                        <span className={`absolute top-0.5 ${enabled ? 'right-0.5' : 'left-0.5'} w-4 h-4 rounded-full bg-white shadow transition-all`} />
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          <p className="text-2xs text-ink-400 mt-3">
            자금일보 수신 설정은 계정 설정에서 하실 수 있어요.
          </p>

          <button
            disabled={!dirty || saveMut.isPending}
            onClick={() => localCfg && saveMut.mutate(localCfg)}
            className="mt-4 w-full py-2.5 rounded-md bg-emerald-500 hover:bg-emerald-600 text-white text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saveMut.isPending ? '저장 중…' : dirty ? '저장하기' : '저장됨'}
          </button>
          {saveMut.isSuccess && !dirty && (
            <div className="mt-2 text-2xs text-emerald-700 text-center">
              ✓ 다음 아침부터 새 설정으로 발송됩니다
            </div>
          )}
          <button
            disabled={sendNowMut.isPending}
            onClick={() => sendNowMut.mutate()}
            className="mt-2 w-full py-2 rounded-md border border-emerald-300 text-emerald-700 hover:bg-emerald-50 text-xs font-semibold disabled:opacity-50"
          >
            {sendNowMut.isPending ? '발송 중…' : '지금 한 번 발송'}
          </button>
          {sendNowMut.isSuccess && (
            <div className="mt-1 text-2xs text-emerald-600 text-center">✓ 발송 완료</div>
          )}
        </div>
      </div>
    </div>
  )
}

function PreviewSection({ sectionKey, data }: { sectionKey: string; data: any }) {
  const Icon = SECTION_ICON[sectionKey] || SparklesIcon
  const accent = SECTION_ACCENT[sectionKey] || 'from-ink-50 to-white border-ink-200'

  if (sectionKey === 'ai_cashflow') {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-1.5">
          <Icon className="h-4 w-4 text-emerald-600" />
          <h3 className="text-sm font-bold text-ink-900">{data.title}</h3>
        </div>
        <div className={`rounded-lg border bg-gradient-to-br ${accent} p-4`}>
          <div className="text-xs font-semibold text-ink-700 mb-2">{data.balance_trend?.title}</div>
          <div className="text-2xs text-ink-700 leading-relaxed">{data.balance_trend?.summary}</div>
        </div>
        {(data.top_movements?.outflows?.length > 0 || data.top_movements?.inflows?.length > 0) && (
          <div className="rounded-lg border border-ink-200 bg-white p-4">
            <div className="text-xs font-semibold text-ink-700 mb-2">{data.top_movements.title}</div>
            <div className="space-y-1">
              {(data.top_movements.outflows || []).map((m: any, i: number) => (
                <div key={`o${i}`} className="flex items-start gap-1.5 text-2xs">
                  <ArrowUpRightIcon className="h-3 w-3 text-rose-500 mt-0.5 flex-shrink-0" />
                  <span className="text-ink-700">
                    어제 주요 출금 내역으로는 <strong>{m.counterparty}</strong>{m.description ? ` (${m.description})` : ''}로 <strong>{formatCurrency(m.amount, false)}</strong> 등이 있어요.
                  </span>
                </div>
              ))}
              {(data.top_movements.inflows || []).map((m: any, i: number) => (
                <div key={`i${i}`} className="flex items-start gap-1.5 text-2xs">
                  <ArrowDownLeftIcon className="h-3 w-3 text-emerald-500 mt-0.5 flex-shrink-0" />
                  <span className="text-ink-700">
                    어제 주요 입금 내역으로는 <strong>{m.counterparty}</strong>{m.description ? ` (${m.description})` : ''}로 <strong>{formatCurrency(m.amount, false)}</strong> 등이 있어요.
                  </span>
                </div>
              ))}
            </div>
            <button className="mt-2 text-2xs px-2 py-1 rounded bg-emerald-500 text-white font-semibold">
              거래내역 자세히 보기 →
            </button>
          </div>
        )}
      </div>
    )
  }

  if (sectionKey === 'card_spending') {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-1.5">
          <Icon className="h-4 w-4 text-amber-600" />
          <h3 className="text-sm font-bold text-ink-900">{data.title}</h3>
        </div>
        <div className={`rounded-lg border bg-gradient-to-br ${accent} p-4`}>
          <div className="text-xs font-semibold text-ink-700 mb-2">{data.trend?.title}</div>
          <div className="text-2xs text-ink-700 leading-relaxed">{data.trend?.summary}</div>
        </div>
        {(data.top_payments?.length || 0) > 0 && (
          <div className="rounded-lg border border-ink-200 bg-white p-4">
            <div className="text-xs font-semibold text-ink-700 mb-2">어제 주요 결제 내역</div>
            <div className="space-y-1 text-2xs">
              {data.top_payments.map((p: any, i: number) => (
                <div key={i} className="flex items-center justify-between">
                  <span className="text-ink-700 truncate">
                    {p.counterparty}{p.description ? ` (${p.description})` : ''}
                  </span>
                  <span className="font-mono font-semibold text-ink-900 ml-2">
                    {formatCurrency(p.amount, false)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    )
  }

  if (sectionKey === 'cash_status') {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-1.5">
          <Icon className="h-4 w-4 text-blue-600" />
          <h3 className="text-sm font-bold text-ink-900">{data.title}</h3>
        </div>
        <div className={`rounded-lg border bg-gradient-to-br ${accent} p-4 space-y-2`}>
          <div className="text-2xs text-ink-700 leading-relaxed">{data.summary}</div>
          <div className="grid grid-cols-3 gap-2 text-center mt-2">
            <div className="bg-white/60 rounded p-2">
              <div className="text-2xs text-ink-500">입금</div>
              <div className="text-xs font-bold text-emerald-700 mt-0.5">{formatCurrency(data.inflow, false)}</div>
            </div>
            <div className="bg-white/60 rounded p-2">
              <div className="text-2xs text-ink-500">출금</div>
              <div className="text-xs font-bold text-rose-700 mt-0.5">{formatCurrency(data.outflow, false)}</div>
            </div>
            <div className="bg-white/60 rounded p-2">
              <div className="text-2xs text-ink-500">잔액</div>
              <div className="text-xs font-bold text-ink-900 mt-0.5">{formatCurrency(data.balance, false)}</div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  if (sectionKey === 'card_usage') {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-1.5">
          <Icon className="h-4 w-4 text-purple-600" />
          <h3 className="text-sm font-bold text-ink-900">{data.title}</h3>
        </div>
        <div className={`rounded-lg border bg-gradient-to-br ${accent} p-4`}>
          <div className="text-2xs text-ink-700">{data.summary}</div>
          {(data.items?.length || 0) > 0 && (
            <div className="mt-2 space-y-0.5 text-2xs">
              {data.items.slice(0, 5).map((p: any, i: number) => (
                <div key={i} className="flex items-center justify-between bg-white/60 rounded px-2 py-1">
                  <span className="text-ink-700 truncate">
                    {p.counterparty}{p.description ? ` (${p.description})` : ''}
                  </span>
                  <span className="font-mono font-semibold text-ink-900 ml-2">{formatCurrency(p.amount, false)}</span>
                </div>
              ))}
              {data.items.length > 5 && (
                <div className="text-2xs text-ink-500 text-center pt-1">외 {data.items.length - 5}건</div>
              )}
            </div>
          )}
        </div>
      </div>
    )
  }

  return null
}
