import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  ShoppingBagIcon, LinkIcon, PlusIcon, TrashIcon,
  CheckIcon, XMarkIcon, ArrowPathIcon, CreditCardIcon,
  ClipboardDocumentListIcon, SparklesIcon,
} from '@heroicons/react/24/outline'
import { purchaseApi, CatalogItem, PurchaseRequestInfo } from '@/services/api'
import { useAuthStore } from '@/store/authStore'
import { formatCurrency } from '@/utils/format'
import toast from 'react-hot-toast'

type CartLine = { catalog_item_id: number | null; title: string; unit_price: number; quantity: number }

const STATUS_LABEL: Record<string, { label: string; cls: string }> = {
  PENDING: { label: '승인 대기', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
  APPROVED: { label: '승인됨 · 결제 대기', cls: 'bg-blue-50 text-blue-700 border-blue-200' },
  REJECTED: { label: '반려', cls: 'bg-red-50 text-red-700 border-red-200' },
  PURCHASED: { label: '결제 완료 · 대사 대기', cls: 'bg-violet-50 text-violet-700 border-violet-200' },
  MATCHED: { label: '전표 대사 완료', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  CANCELED: { label: '취소됨', cls: 'bg-ink-50 text-ink-500 border-ink-200' },
}

export default function PurchasePage() {
  const { user } = useAuthStore()
  const isAdmin = !!user?.isAdmin
  const [tab, setTab] = useState<'catalog' | 'requests'>('catalog')

  return (
    <div className="space-y-3">
      <div className="flex items-end justify-between flex-wrap gap-2">
        <div>
          <h1 className="flex items-center gap-2">
            <ShoppingBagIcon className="h-5 w-5 text-blue-500" />
            구매 요청
          </h1>
          <p className="text-xs text-ink-500 mt-1">
            상품 링크를 붙여넣어 카탈로그에 등록하고, 구매요청 → 승인 → 결제 후 카드전표와 자동 대사합니다
          </p>
        </div>
        <div className="flex rounded-md border border-ink-200 bg-white p-0.5">
          <button
            onClick={() => setTab('catalog')}
            className={`px-3 py-1 text-xs font-medium rounded transition ${
              tab === 'catalog' ? 'bg-ink-900 text-white' : 'text-ink-600 hover:text-ink-900'
            }`}
          >
            카탈로그
          </button>
          <button
            onClick={() => setTab('requests')}
            className={`px-3 py-1 text-xs font-medium rounded transition ${
              tab === 'requests' ? 'bg-ink-900 text-white' : 'text-ink-600 hover:text-ink-900'
            }`}
          >
            구매요청 {isAdmin && '(승인 관리)'}
          </button>
        </div>
      </div>

      {tab === 'catalog' ? <CatalogTab /> : <RequestsTab isAdmin={isAdmin} />}
    </div>
  )
}

// ==================== 카탈로그 탭 ====================

function CatalogTab() {
  const qc = useQueryClient()
  const [url, setUrl] = useState('')
  const [parsing, setParsing] = useState(false)
  const [preview, setPreview] = useState<any | null>(null)
  const [cart, setCart] = useState<CartLine[]>([])
  const [reqTitle, setReqTitle] = useState('')
  const [reqReason, setReqReason] = useState('')
  const [search, setSearch] = useState('')

  const catalogQuery = useQuery({
    queryKey: ['purchase-catalog', search],
    queryFn: () => purchaseApi.listCatalog(search || undefined).then((r) => r.data.items),
  })

  const saveMut = useMutation({
    mutationFn: () =>
      purchaseApi.createCatalogItem({
        url: preview.url,
        title: preview.title,
        price: preview.price,
        seller: preview.seller,
        image_url: preview.image_url,
        platform: preview.platform,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['purchase-catalog'] })
      setPreview(null)
      setUrl('')
      toast.success('카탈로그에 등록되었습니다')
    },
    onError: (e: any) => toast.error(e.response?.data?.detail || '등록 실패'),
  })

  const refreshMut = useMutation({
    mutationFn: (id: number) => purchaseApi.refreshPrice(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['purchase-catalog'] })
      toast.success('가격을 재조회했습니다')
    },
  })

  const createReqMut = useMutation({
    mutationFn: () =>
      purchaseApi.createRequest({
        title: reqTitle || cart.map((c) => c.title).join(', ').slice(0, 200),
        reason: reqReason || undefined,
        items: cart,
      }),
    onSuccess: () => {
      setCart([]); setReqTitle(''); setReqReason('')
      qc.invalidateQueries({ queryKey: ['purchase-requests'] })
      toast.success('구매요청이 제출되었습니다 (승인 대기)')
    },
    onError: (e: any) => toast.error(e.response?.data?.detail || '요청 실패'),
  })

  async function handleParse() {
    if (!url.trim()) return
    setParsing(true)
    setPreview(null)
    try {
      const r = await purchaseApi.parseLink(url.trim())
      setPreview({ ...r.data, url: url.trim() })
      if (r.data.error) toast(r.data.error, { icon: 'ℹ️' })
    } catch (e: any) {
      toast.error(e.response?.data?.detail || '링크 인식에 실패했습니다')
      setPreview({ url: url.trim(), title: '', price: null, seller: '', image_url: null, platform: null })
    } finally {
      setParsing(false)
    }
  }

  function addToCart(item: CatalogItem) {
    setCart((prev) => {
      const existing = prev.find((c) => c.catalog_item_id === item.id)
      if (existing) {
        return prev.map((c) =>
          c.catalog_item_id === item.id ? { ...c, quantity: c.quantity + 1 } : c
        )
      }
      return [...prev, { catalog_item_id: item.id, title: item.title, unit_price: item.price || 0, quantity: 1 }]
    })
  }

  const cartTotal = cart.reduce((s, c) => s + c.unit_price * c.quantity, 0)
  const items: CatalogItem[] = catalogQuery.data || []

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_340px] gap-3">
      <div className="space-y-3">
        {/* 링크 붙여넣기 */}
        <div className="panel p-3 space-y-2">
          <div className="text-2xs font-semibold text-ink-600 flex items-center gap-1">
            <LinkIcon className="h-3 w-3" />
            상품 링크 붙여넣기 — 상품명·가격·판매자 자동 인식
          </div>
          <div className="flex gap-1.5">
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleParse()}
              placeholder="https://smartstore.naver.com/... 또는 https://www.coupang.com/..."
              className="flex-1 px-2.5 py-1.5 text-xs rounded-md border border-ink-300 focus:border-blue-400 focus:outline-none"
            />
            <button
              onClick={handleParse}
              disabled={parsing || !url.trim()}
              className="px-3 py-1.5 text-xs rounded-md bg-blue-600 text-white font-semibold hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1"
            >
              <SparklesIcon className="h-3.5 w-3.5" />
              {parsing ? '인식 중…' : '인식'}
            </button>
          </div>

          {preview && (
            <div className="p-2.5 rounded-md bg-canvas-50 border border-ink-200 space-y-1.5">
              <div className="flex gap-2.5">
                {preview.image_url && (
                  <img src={preview.image_url} alt="" className="w-16 h-16 rounded object-cover border border-ink-200" />
                )}
                <div className="flex-1 space-y-1">
                  <input
                    type="text"
                    value={preview.title || ''}
                    onChange={(e) => setPreview({ ...preview, title: e.target.value })}
                    placeholder="상품명 (직접 입력 가능)"
                    className="w-full px-2 py-1 text-xs rounded border border-ink-300 focus:border-blue-400 focus:outline-none font-medium"
                  />
                  <div className="flex gap-1.5">
                    <input
                      type="number"
                      value={preview.price ?? ''}
                      onChange={(e) => setPreview({ ...preview, price: e.target.value ? Number(e.target.value) : null })}
                      placeholder="가격(원)"
                      className="w-28 px-2 py-1 text-xs rounded border border-ink-300 focus:border-blue-400 focus:outline-none font-mono"
                    />
                    <input
                      type="text"
                      value={preview.seller || ''}
                      onChange={(e) => setPreview({ ...preview, seller: e.target.value })}
                      placeholder="판매자"
                      className="flex-1 px-2 py-1 text-xs rounded border border-ink-300 focus:border-blue-400 focus:outline-none"
                    />
                  </div>
                  {preview.platform && (
                    <div className="text-2xs text-ink-500">플랫폼: {preview.platform}</div>
                  )}
                </div>
              </div>
              <div className="flex gap-1">
                <button
                  onClick={() => saveMut.mutate()}
                  disabled={!preview.title || saveMut.isPending}
                  className="px-2.5 py-1 text-2xs rounded bg-emerald-500 text-white font-semibold hover:bg-emerald-600 disabled:opacity-50"
                >
                  <CheckIcon className="h-3 w-3 inline mr-0.5" />
                  카탈로그 등록
                </button>
                <button
                  onClick={() => setPreview(null)}
                  className="px-2.5 py-1 text-2xs rounded border border-ink-200 text-ink-600"
                >
                  <XMarkIcon className="h-3 w-3 inline mr-0.5" />
                  취소
                </button>
              </div>
            </div>
          )}
        </div>

        {/* 카탈로그 목록 */}
        <div className="panel overflow-hidden">
          <div className="px-3 py-2 border-b border-ink-200 flex items-center justify-between gap-2">
            <span className="text-2xs font-semibold text-ink-500 uppercase">회사 카탈로그</span>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="상품명/판매자 검색"
              className="px-2 py-1 text-2xs rounded border border-ink-200 focus:border-blue-400 focus:outline-none w-44"
            />
          </div>
          {catalogQuery.isLoading ? (
            <div className="p-8 text-center text-2xs text-ink-400">불러오는 중…</div>
          ) : items.length === 0 ? (
            <div className="p-8 text-center text-2xs text-ink-400">
              등록된 상품이 없습니다. 위에 링크를 붙여넣어 등록해주세요.
            </div>
          ) : (
            <div className="divide-y divide-ink-100">
              {items.map((item) => (
                <div key={item.id} className="p-2.5 flex items-center gap-2.5 hover:bg-canvas-50">
                  {item.image_url ? (
                    <img src={item.image_url} alt="" className="w-10 h-10 rounded object-cover border border-ink-200 flex-shrink-0" />
                  ) : (
                    <div className="w-10 h-10 rounded bg-ink-100 flex items-center justify-center flex-shrink-0">
                      <ShoppingBagIcon className="h-4 w-4 text-ink-400" />
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <a href={item.url} target="_blank" rel="noreferrer"
                      className="text-xs font-medium text-ink-900 truncate block hover:text-blue-600 hover:underline">
                      {item.title}
                    </a>
                    <div className="text-2xs text-ink-500">
                      {item.platform && <span>{item.platform} · </span>}
                      {item.seller && <span>{item.seller} · </span>}
                      등록 {item.created_by.split('@')[0]}
                    </div>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <div className="text-xs font-bold font-mono text-ink-900">
                      {item.price != null ? formatCurrency(item.price, false) : '-'}
                    </div>
                    <button
                      onClick={() => refreshMut.mutate(item.id)}
                      disabled={refreshMut.isPending}
                      className="text-2xs text-ink-400 hover:text-blue-600 flex items-center gap-0.5 ml-auto"
                      title="가격 재조회"
                    >
                      <ArrowPathIcon className="h-2.5 w-2.5" />
                      갱신
                    </button>
                  </div>
                  <button
                    onClick={() => addToCart(item)}
                    className="px-2 py-1 text-2xs rounded bg-blue-600 text-white font-semibold hover:bg-blue-700 flex-shrink-0 flex items-center gap-0.5"
                  >
                    <PlusIcon className="h-3 w-3" />
                    담기
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 구매요청 장바구니 */}
      <div className="panel p-3 self-start sticky top-3 space-y-2">
        <div className="text-2xs font-semibold text-ink-600 flex items-center gap-1">
          <ClipboardDocumentListIcon className="h-3 w-3" />
          구매요청 작성 ({cart.length}개 품목)
        </div>
        {cart.length === 0 ? (
          <div className="text-center text-2xs text-ink-400 py-8">
            카탈로그에서 상품을 담으면<br />구매요청을 만들 수 있습니다
          </div>
        ) : (
          <>
            <div className="space-y-1">
              {cart.map((line, i) => (
                <div key={i} className="flex items-center gap-1.5 text-2xs bg-canvas-50 rounded p-1.5">
                  <span className="flex-1 truncate text-ink-800">{line.title}</span>
                  <input
                    type="number"
                    min={1}
                    value={line.quantity}
                    onChange={(e) =>
                      setCart(cart.map((c, j) => (j === i ? { ...c, quantity: Math.max(1, Number(e.target.value)) } : c)))
                    }
                    className="w-12 px-1 py-0.5 text-2xs rounded border border-ink-200 text-center"
                  />
                  <span className="font-mono text-ink-700 w-20 text-right">
                    {formatCurrency(line.unit_price * line.quantity, false)}
                  </span>
                  <button onClick={() => setCart(cart.filter((_, j) => j !== i))}
                    className="text-ink-400 hover:text-red-500">
                    <TrashIcon className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
            <div className="flex items-center justify-between text-xs font-bold border-t border-ink-200 pt-2">
              <span>합계</span>
              <span className="font-mono">{formatCurrency(cartTotal, false)}</span>
            </div>
            <input
              type="text"
              value={reqTitle}
              onChange={(e) => setReqTitle(e.target.value)}
              placeholder="요청 제목 (예: 3월 사무용품 구매)"
              className="w-full px-2 py-1 text-xs rounded border border-ink-300 focus:border-blue-400 focus:outline-none"
            />
            <textarea
              value={reqReason}
              onChange={(e) => setReqReason(e.target.value)}
              placeholder="구매 사유"
              rows={2}
              className="w-full px-2 py-1 text-xs rounded border border-ink-300 focus:border-blue-400 focus:outline-none resize-none"
            />
            <button
              onClick={() => createReqMut.mutate()}
              disabled={createReqMut.isPending}
              className="w-full py-1.5 text-xs rounded-md bg-blue-600 text-white font-semibold hover:bg-blue-700 disabled:opacity-50"
            >
              구매요청 제출 (승인 요청)
            </button>
          </>
        )}
      </div>
    </div>
  )
}

// ==================== 구매요청 탭 ====================

function RequestsTab({ isAdmin }: { isAdmin: boolean }) {
  const qc = useQueryClient()
  const [statusFilter, setStatusFilter] = useState('')
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [completeForm, setCompleteForm] = useState<{ order_no: string; final_amount: string }>({ order_no: '', final_amount: '' })
  const [candidates, setCandidates] = useState<Record<number, any[]>>({})

  const reqQuery = useQuery({
    queryKey: ['purchase-requests', statusFilter],
    queryFn: () => purchaseApi.listRequests(statusFilter || undefined).then((r) => r.data.requests),
  })

  const invalidate = () => qc.invalidateQueries({ queryKey: ['purchase-requests'] })

  const approveMut = useMutation({
    mutationFn: (id: number) => purchaseApi.approve(id),
    onSuccess: () => { invalidate(); toast.success('승인했습니다') },
    onError: (e: any) => toast.error(e.response?.data?.detail || '승인 실패'),
  })
  const rejectMut = useMutation({
    mutationFn: (vars: { id: number; reason: string }) => purchaseApi.reject(vars.id, vars.reason),
    onSuccess: () => { invalidate(); toast.success('반려했습니다') },
    onError: (e: any) => toast.error(e.response?.data?.detail || '반려 실패'),
  })
  const cancelMut = useMutation({
    mutationFn: (id: number) => purchaseApi.cancel(id),
    onSuccess: () => { invalidate(); toast.success('취소했습니다') },
  })
  const completeMut = useMutation({
    mutationFn: (vars: { id: number; final_amount: number; order_no?: string }) =>
      purchaseApi.complete(vars.id, { final_amount: vars.final_amount, order_no: vars.order_no }),
    onSuccess: () => { invalidate(); toast.success('결제 완료로 등록했습니다. 카드전표 대사를 진행해주세요.') },
    onError: (e: any) => toast.error(e.response?.data?.detail || '등록 실패'),
  })
  const matchMut = useMutation({
    mutationFn: (vars: { id: number; ticket_id: string }) => purchaseApi.confirmMatch(vars.id, vars.ticket_id),
    onSuccess: () => { invalidate(); toast.success('카드전표와 대사 완료!') },
    onError: (e: any) => toast.error(e.response?.data?.detail || '대사 실패'),
  })

  async function loadCandidates(id: number) {
    try {
      const r = await purchaseApi.matchCandidates(id)
      setCandidates((prev) => ({ ...prev, [id]: r.data.candidates }))
      if (!r.data.candidates.length) toast('일치하는 카드전표 후보가 아직 없습니다. 전표 반영까지 1~2일 걸릴 수 있어요.', { icon: 'ℹ️' })
    } catch (e: any) {
      toast.error(e.response?.data?.detail || '후보 조회 실패')
    }
  }

  function handleReject(id: number) {
    const reason = window.prompt('반려 사유를 입력해주세요')
    if (reason) rejectMut.mutate({ id, reason })
  }

  const requests: PurchaseRequestInfo[] = reqQuery.data || []

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1">
        {['', 'PENDING', 'APPROVED', 'PURCHASED', 'MATCHED', 'REJECTED'].map((s) => (
          <button
            key={s || 'all'}
            onClick={() => setStatusFilter(s)}
            className={`px-2 py-1 text-2xs rounded-full border transition ${
              statusFilter === s
                ? 'bg-ink-900 text-white border-ink-900'
                : 'bg-white text-ink-600 border-ink-200 hover:border-ink-400'
            }`}
          >
            {s ? STATUS_LABEL[s].label : '전체'}
          </button>
        ))}
      </div>

      {reqQuery.isLoading ? (
        <div className="panel p-8 text-center text-2xs text-ink-400">불러오는 중…</div>
      ) : requests.length === 0 ? (
        <div className="panel p-10 text-center text-2xs text-ink-400">구매요청이 없습니다</div>
      ) : (
        requests.map((req) => {
          const st = STATUS_LABEL[req.status] || STATUS_LABEL.PENDING
          const isExpanded = expandedId === req.id
          return (
            <div key={req.id} className="panel overflow-hidden">
              <button
                onClick={() => {
                  setExpandedId(isExpanded ? null : req.id)
                  setCompleteForm({ order_no: '', final_amount: String(req.total_amount) })
                }}
                className="w-full p-3 text-left hover:bg-canvas-50 flex items-center gap-2"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-xs font-semibold text-ink-900">#{req.id} {req.title}</span>
                    <span className={`text-2xs px-1.5 py-0.5 rounded-full border ${st.cls}`}>{st.label}</span>
                  </div>
                  <div className="text-2xs text-ink-500 mt-0.5">
                    {req.requester_email.split('@')[0]} · {req.created_at?.slice(0, 10)} · {req.items.length}개 품목
                    {req.matched_ticket_id && <span className="text-emerald-600"> · 전표 #{req.matched_ticket_id}</span>}
                  </div>
                </div>
                <span className="text-sm font-bold font-mono text-ink-900 flex-shrink-0">
                  {formatCurrency(req.final_amount ?? req.total_amount, false)}
                </span>
              </button>

              {isExpanded && (
                <div className="border-t border-ink-100 p-3 space-y-2 bg-canvas-50/50">
                  {/* 품목 */}
                  <div className="space-y-0.5">
                    {req.items.map((it) => (
                      <div key={it.id} className="flex items-center justify-between text-2xs">
                        <span className="text-ink-700">{it.title} × {it.quantity}</span>
                        <span className="font-mono text-ink-900">{formatCurrency(it.line_total, false)}</span>
                      </div>
                    ))}
                  </div>
                  {req.reason && <div className="text-2xs text-ink-600">사유: {req.reason}</div>}
                  {req.reject_reason && <div className="text-2xs text-red-600">반려 사유: {req.reject_reason}</div>}
                  {req.approved_by && (
                    <div className="text-2xs text-ink-500">
                      {req.status === 'REJECTED' ? '반려' : '승인'}: {req.approved_by.split('@')[0]} · {req.approved_at?.slice(0, 16).replace('T', ' ')}
                    </div>
                  )}

                  {/* 액션 */}
                  <div className="flex items-center gap-1.5 flex-wrap pt-1">
                    {isAdmin && req.status === 'PENDING' && (
                      <>
                        <button onClick={() => approveMut.mutate(req.id)} disabled={approveMut.isPending}
                          className="px-2.5 py-1 text-2xs rounded bg-emerald-500 text-white font-semibold hover:bg-emerald-600">
                          <CheckIcon className="h-3 w-3 inline mr-0.5" />승인
                        </button>
                        <button onClick={() => handleReject(req.id)}
                          className="px-2.5 py-1 text-2xs rounded bg-red-500 text-white font-semibold hover:bg-red-600">
                          <XMarkIcon className="h-3 w-3 inline mr-0.5" />반려
                        </button>
                      </>
                    )}
                    {!isAdmin && req.status === 'PENDING' && (
                      <button onClick={() => cancelMut.mutate(req.id)}
                        className="px-2.5 py-1 text-2xs rounded border border-ink-300 text-ink-600 hover:bg-ink-50">
                        요청 취소
                      </button>
                    )}
                  </div>

                  {/* 결제 완료 등록 (승인됨) */}
                  {req.status === 'APPROVED' && (
                    <div className="p-2 rounded-md bg-white border border-blue-200 space-y-1.5">
                      <div className="text-2xs font-semibold text-blue-700">
                        결제 완료 후 등록 — 담당자가 법인카드로 결제한 뒤 최종금액을 입력해주세요
                      </div>
                      <div className="flex gap-1.5">
                        <input type="text" value={completeForm.order_no}
                          onChange={(e) => setCompleteForm({ ...completeForm, order_no: e.target.value })}
                          placeholder="주문번호 (선택)"
                          className="flex-1 px-2 py-1 text-xs rounded border border-ink-300 focus:border-blue-400 focus:outline-none" />
                        <input type="number" value={completeForm.final_amount}
                          onChange={(e) => setCompleteForm({ ...completeForm, final_amount: e.target.value })}
                          placeholder="최종 결제금액(원)"
                          className="w-32 px-2 py-1 text-xs rounded border border-ink-300 focus:border-blue-400 focus:outline-none font-mono" />
                        <button
                          onClick={() => completeMut.mutate({
                            id: req.id,
                            final_amount: Number(completeForm.final_amount),
                            order_no: completeForm.order_no || undefined,
                          })}
                          disabled={!completeForm.final_amount || completeMut.isPending}
                          className="px-2.5 py-1 text-2xs rounded bg-blue-600 text-white font-semibold hover:bg-blue-700 disabled:opacity-50">
                          등록
                        </button>
                      </div>
                    </div>
                  )}

                  {/* 카드전표 대사 (결제 완료) */}
                  {req.status === 'PURCHASED' && (
                    <div className="p-2 rounded-md bg-white border border-violet-200 space-y-1.5">
                      <div className="flex items-center justify-between">
                        <span className="text-2xs font-semibold text-violet-700 flex items-center gap-1">
                          <CreditCardIcon className="h-3 w-3" />
                          그랜터 카드전표 대사 — 금액·시각으로 자동 후보 검색
                        </span>
                        <button onClick={() => loadCandidates(req.id)}
                          className="px-2 py-0.5 text-2xs rounded border border-violet-300 text-violet-700 hover:bg-violet-50">
                          후보 검색
                        </button>
                      </div>
                      {(candidates[req.id] || []).map((c) => (
                        <div key={c.ticket_id}
                          className="flex items-center justify-between gap-2 text-2xs bg-canvas-50 rounded p-1.5">
                          <div className="flex-1 min-w-0">
                            <span className={`font-medium ${c.exact ? 'text-emerald-700' : 'text-ink-700'}`}>
                              {c.store_name || '(가맹점 미확인)'}
                            </span>
                            <span className="text-ink-500 ml-1">
                              {c.transact_at?.replace('T', ' ')} · {c.card_key}
                            </span>
                          </div>
                          <span className="font-mono font-semibold">{formatCurrency(c.amount, false)}</span>
                          {c.exact && <span className="text-emerald-600 font-semibold">금액 일치</span>}
                          <button onClick={() => matchMut.mutate({ id: req.id, ticket_id: c.ticket_id })}
                            className="px-2 py-0.5 rounded bg-violet-600 text-white font-semibold hover:bg-violet-700">
                            대사 확정
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })
      )}
    </div>
  )
}
