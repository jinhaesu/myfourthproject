import { useEffect, useMemo, useState } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import {
  ArrowPathIcon,
  ReceiptPercentIcon,
  ArrowDownLeftIcon,
  ArrowUpRightIcon,
  MagnifyingGlassIcon,
  ExclamationTriangleIcon,
  CheckCircleIcon,
  ClockIcon,
  PlusIcon,
  TrashIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline'
import { granterApi } from '@/services/api'
import { formatCurrency, isoLocal } from '@/utils/format'
import { isSelfCompany } from '@/utils/internalTransfer'
import PeriodPicker, { periodForPreset, type PeriodPreset } from '@/components/common/PeriodPicker'

type Direction = 'all' | 'sales' | 'purchase'

// ────────────────────────────────────────────────────────────────────────────
// 조인앤조인 공급자 기본 정보 (사업자등록증 기준)
// ────────────────────────────────────────────────────────────────────────────
const SUPPLIER_DEFAULT = {
  businessNumber: '503-87-01038',
  corporateNumber: '131411-0405152',
  companyName: '주식회사 조인앤조인',
  representativeName: '진해수',
  address: '전북특별자치도 전주시 덕진구 기린대로 458, 2층',
  businessType: '제조업',
  businessItem: '식품 및 기타 식품제조업',
  email: '',
}

// ────────────────────────────────────────────────────────────────────────────
// 거래처 자동완성용 타입 및 추출 함수
// ────────────────────────────────────────────────────────────────────────────
interface ContractorSuggestion {
  businessNumber: string
  companyName: string
  representativeName: string
  address: string
  email: string
  phone?: string
  businessType?: string
  businessItem?: string
  count: number
}

function extractContractors(taxTickets: any[]): ContractorSuggestion[] {
  const map = new Map<string, ContractorSuggestion>()
  for (const t of taxTickets) {
    const ti = t?.taxInvoice
    if (!ti) continue
    // 매출(IN): contractor=공급받는자, 매입(OUT): supplier=상대방 — 둘 다 거래처 풀로 수집
    const candidates = [ti.contractor, ti.supplier].filter(Boolean)
    for (const c of candidates) {
      // 그랜터 가이드 기준 필드: registrationNumber/companyName/ceoName/businessPlace/businessTypes/businessItems
      const bn = String(c?.registrationNumber || c?.businessNumber || '').trim()
      const name = String(c?.companyName || '').trim()
      if (!bn && !name) continue
      // 본인 회사 제외 — 사업자번호 단위 정확 매칭 + 회사명 변형 (isSelfCompany 사용)
      if (isSelfCompany({ businessNumber: bn, companyName: name })) continue
      const key = bn || name
      const cur = map.get(key) || {
        businessNumber: bn,
        companyName: name,
        representativeName: String(c?.ceoName || c?.representativeName || '').trim(),
        address: String(c?.businessPlace || c?.address || '').trim(),
        email: String(c?.email || '').trim(),
        phone: String(c?.phone || c?.tel || '').trim(),
        businessType: String(c?.businessTypes || c?.businessType || '').trim(),
        businessItem: String(c?.businessItems || c?.businessItem || '').trim(),
        count: 0,
      }
      cur.count += 1
      if (!cur.representativeName) cur.representativeName = String(c?.ceoName || c?.representativeName || '').trim()
      if (!cur.address) cur.address = String(c?.businessPlace || c?.address || '').trim()
      if (!cur.email) cur.email = String(c?.email || '').trim()
      if (!cur.phone) cur.phone = String(c?.phone || c?.tel || '').trim()
      if (!cur.businessType) cur.businessType = String(c?.businessTypes || c?.businessType || '').trim()
      if (!cur.businessItem) cur.businessItem = String(c?.businessItems || c?.businessItem || '').trim()
      map.set(key, cur)
    }
  }
  return Array.from(map.values()).sort((a, b) => b.count - a.count)
}

function daysBetween(a: string, b: string) {
  return Math.floor((new Date(b).getTime() - new Date(a).getTime()) / 86400000) + 1
}

function num(obj: any, ...keys: string[]): number {
  for (const k of keys) {
    const v = obj?.[k]
    if (v !== undefined && v !== null && v !== '') return Number(v) || 0
  }
  return 0
}
function str(obj: any, ...keys: string[]): string {
  for (const k of keys) {
    const v = obj?.[k]
    if (v !== undefined && v !== null && v !== '') return String(v)
  }
  return ''
}

// ────────────────────────────────────────────────────────────────────────────
// 거래처 조회 모달
// ────────────────────────────────────────────────────────────────────────────

function ContractorPickerModal({
  open,
  onClose,
  onSelect,
  contractors,
}: {
  open: boolean
  onClose: () => void
  onSelect: (c: ContractorSuggestion) => void
  contractors: ContractorSuggestion[]
}) {
  const [search, setSearch] = useState('')
  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase()
    if (!s) return contractors
    return contractors.filter(
      (c) =>
        c.companyName.toLowerCase().includes(s) ||
        c.businessNumber.includes(s) ||
        c.representativeName.toLowerCase().includes(s)
    )
  }, [contractors, search])

  if (!open) return null
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 헤더 */}
        <div className="px-4 py-3 border-b border-ink-200 flex items-center justify-between">
          <h3 className="text-sm font-semibold">거래처 조회</h3>
          <button onClick={onClose} className="text-ink-400 hover:text-ink-700">
            <XMarkIcon className="h-4 w-4" />
          </button>
        </div>
        {/* 검색 */}
        <div className="px-4 py-2 border-b border-ink-100">
          <input
            type="text"
            className="input w-full text-xs"
            placeholder="회사명 / 사업자번호 / 대표자명으로 검색"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoFocus
          />
          <p className="text-2xs text-ink-400 mt-1">
            과거 세금계산서에서 추출된 {contractors.length.toLocaleString('ko-KR')}곳 · 거래 빈도순 정렬
          </p>
        </div>
        {/* 목록 */}
        <div className="flex-1 overflow-y-auto">
          {filtered.length === 0 ? (
            <div className="p-6 text-center text-2xs text-ink-400">검색 결과 없음</div>
          ) : (
            <table className="min-w-full">
              <thead className="bg-canvas-50 sticky top-0 z-10 border-b border-ink-200">
                <tr>
                  <th className="px-3 py-1.5 text-left text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                    회사명
                  </th>
                  <th className="px-3 py-1.5 text-left text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                    사업자번호
                  </th>
                  <th className="px-3 py-1.5 text-left text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                    대표자
                  </th>
                  <th className="px-3 py-1.5 text-right text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                    거래 빈도
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {filtered.map((c) => (
                  <tr
                    key={c.businessNumber || c.companyName}
                    onClick={() => {
                      onSelect(c)
                      onClose()
                    }}
                    className="cursor-pointer hover:bg-canvas-50"
                  >
                    <td className="px-3 py-1.5 text-xs text-ink-900 font-medium">
                      {c.companyName || '-'}
                    </td>
                    <td className="px-3 py-1.5 text-2xs text-ink-700 font-mono">
                      {c.businessNumber || '-'}
                    </td>
                    <td className="px-3 py-1.5 text-2xs text-ink-700">
                      {c.representativeName || '-'}
                    </td>
                    <td className="px-3 py-1.5 text-right text-2xs text-ink-500 tabular-nums">
                      {c.count}회
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// 세금계산서 발행 모달
// ────────────────────────────────────────────────────────────────────────────

interface InvoiceItem {
  itemName: string
  quantity: number
  unitPrice: number
  supplyAmount: number
  taxAmount: number
}

interface IssueTaxInvoiceModalProps {
  open: boolean
  onClose: () => void
  onSuccess: () => void
  contractors: ContractorSuggestion[]
  /** 거래처 정산 페이지에서 prefill 전달 시 사용 */
  initialContractor?: Partial<ContractorSuggestion>
}

function todayStr() {
  return isoLocal(new Date())
}

const emptyItem = (): InvoiceItem => ({
  itemName: '',
  quantity: 1,
  unitPrice: 0,
  supplyAmount: 0,
  taxAmount: 0,
})

function IssueTaxInvoiceModal({ open, onClose, onSuccess, contractors, initialContractor }: IssueTaxInvoiceModalProps) {
  // 거래일자
  const [writeDate, setWriteDate] = useState(todayStr())

  // 공급자 (본인 회사) 정보 — SUPPLIER_DEFAULT로 초기값 설정
  const [supplierBizNo, setSupplierBizNo] = useState(SUPPLIER_DEFAULT.businessNumber)
  const [supplierCorpNo, setSupplierCorpNo] = useState(SUPPLIER_DEFAULT.corporateNumber)
  const [supplierName, setSupplierName] = useState(SUPPLIER_DEFAULT.companyName)
  const [supplierRep, setSupplierRep] = useState(SUPPLIER_DEFAULT.representativeName)
  const [supplierAddr, setSupplierAddr] = useState(SUPPLIER_DEFAULT.address)
  const [supplierBizType, setSupplierBizType] = useState(SUPPLIER_DEFAULT.businessType)
  const [supplierBizItem, setSupplierBizItem] = useState(SUPPLIER_DEFAULT.businessItem)

  // 공급받는자 (거래처) 정보
  const [contractorBizNo, setContractorBizNo] = useState(initialContractor?.businessNumber || '')
  const [contractorName, setContractorName] = useState(initialContractor?.companyName || '')
  const [contractorRep, setContractorRep] = useState(initialContractor?.representativeName || '')
  const [contractorEmail, setContractorEmail] = useState(initialContractor?.email || '')

  // initialContractor가 바뀌면 거래처 필드 동기화 (모달이 열릴 때 prefill 적용)
  useEffect(() => {
    if (open && initialContractor) {
      if (initialContractor.businessNumber !== undefined) setContractorBizNo(initialContractor.businessNumber)
      if (initialContractor.companyName !== undefined) setContractorName(initialContractor.companyName)
      if (initialContractor.representativeName !== undefined) setContractorRep(initialContractor.representativeName)
      if (initialContractor.email !== undefined) setContractorEmail(initialContractor.email)
    }
  }, [open, initialContractor])

  // 거래처 조회 모달 열림 상태
  const [contractorPickerOpen, setContractorPickerOpen] = useState(false)

  // 품목
  const [items, setItems] = useState<InvoiceItem[]>([emptyItem()])

  // 비고 / 발행유형
  const [remark, setRemark] = useState('')
  const [issueImmediately, setIssueImmediately] = useState(true)

  // 디버그: 그랜터 응답 raw
  const [debugRaw, setDebugRaw] = useState<string | null>(null)

  // 품목 수량/단가 변경 시 자동 계산
  const updateItem = (idx: number, patch: Partial<InvoiceItem>) => {
    setItems((prev) => {
      const next = [...prev]
      const cur = { ...next[idx], ...patch }
      // quantity 또는 unitPrice 변경 시 재계산
      if ('quantity' in patch || 'unitPrice' in patch) {
        cur.supplyAmount = cur.quantity * cur.unitPrice
        cur.taxAmount = Math.round(cur.supplyAmount * 0.1)
      }
      next[idx] = cur
      return next
    })
  }

  const addItem = () => setItems((prev) => [...prev, emptyItem()])
  const removeItem = (idx: number) => setItems((prev) => prev.filter((_, i) => i !== idx))

  // 합계 자동 계산
  const totalSupplyAmount = items.reduce((s, it) => s + (it.supplyAmount || 0), 0)
  const totalTaxAmount = items.reduce((s, it) => s + (it.taxAmount || 0), 0)
  const totalAmount = totalSupplyAmount + totalTaxAmount

  const issueMut = useMutation({
    mutationFn: () => {
      const idempotencyKey = crypto.randomUUID()
      const payload = {
        type: 'REGULAR',
        writeDate,
        supplier: {
          businessNumber: supplierBizNo,
          corporateNumber: supplierCorpNo,
          companyName: supplierName,
          representativeName: supplierRep,
          address: supplierAddr,
          businessType: supplierBizType,
          businessItem: supplierBizItem,
        },
        contractor: {
          businessNumber: contractorBizNo,
          companyName: contractorName,
          representativeName: contractorRep,
          email: contractorEmail,
        },
        items: items.map((it) => ({
          itemName: it.itemName,
          quantity: it.quantity,
          unitPrice: it.unitPrice,
          supplyAmount: it.supplyAmount,
          taxAmount: it.taxAmount,
        })),
        totalSupplyAmount,
        totalTaxAmount,
        totalAmount,
        remark,
        issueImmediately,
      }
      return granterApi.issueTaxInvoice(payload, idempotencyKey)
    },
    onSuccess: (_res) => {
      toast.success('세금계산서가 발행되었습니다.')
      setDebugRaw(null)
      onSuccess()
      onClose()
    },
    onError: (err: any) => {
      const detail =
        err?.response?.data?.detail ||
        err?.response?.data?.message ||
        err?.message ||
        '발행 실패'
      toast.error(String(detail))
      // 디버깅용 raw 응답 표시
      const raw = err?.response?.data
        ? JSON.stringify(err.response.data, null, 2)
        : String(err)
      setDebugRaw(raw)
    },
  })

  if (!open) return null

  return (
    /* fixed overlay */
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col">
        {/* 모달 헤더 */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-ink-200">
          <h2 className="font-bold text-sm text-ink-900 flex items-center gap-2">
            <ReceiptPercentIcon className="h-4 w-4 text-ink-500" />
            세금계산서 발행
          </h2>
          <button onClick={onClose} className="text-ink-400 hover:text-ink-700">
            <XMarkIcon className="h-4 w-4" />
          </button>
        </div>

        {/* 스크롤 영역 */}
        <div className="overflow-y-auto flex-1 px-5 py-4 space-y-4 text-xs">
          {/* 거래일자 */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">거래일자 *</label>
              <input
                type="date"
                value={writeDate}
                onChange={(e) => setWriteDate(e.target.value)}
                className="input w-full"
              />
            </div>
            <div>
              <label className="label">발행 유형</label>
              <div className="flex items-center gap-3 mt-1">
                <label className="flex items-center gap-1 cursor-pointer">
                  <input
                    type="radio"
                    checked={issueImmediately}
                    onChange={() => setIssueImmediately(true)}
                  />
                  즉시발행
                </label>
                <label className="flex items-center gap-1 cursor-pointer">
                  <input
                    type="radio"
                    checked={!issueImmediately}
                    onChange={() => setIssueImmediately(false)}
                  />
                  예약발행
                </label>
              </div>
            </div>
          </div>

          {/* 공급자 */}
          <fieldset className="border border-ink-200 rounded-lg p-3 space-y-2">
            <legend className="px-1 text-2xs font-semibold text-ink-500 uppercase tracking-wider">
              공급자 (본인)
            </legend>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="label">사업자번호 *</label>
                <input
                  value={supplierBizNo}
                  onChange={(e) => setSupplierBizNo(e.target.value)}
                  placeholder="000-00-00000"
                  className="input w-full"
                />
              </div>
              <div>
                <label className="label">법인등록번호</label>
                <input
                  value={supplierCorpNo}
                  onChange={(e) => setSupplierCorpNo(e.target.value)}
                  placeholder="000000-0000000"
                  className="input w-full"
                />
              </div>
              <div>
                <label className="label">회사명 *</label>
                <input
                  value={supplierName}
                  onChange={(e) => setSupplierName(e.target.value)}
                  className="input w-full"
                />
              </div>
              <div>
                <label className="label">대표자 *</label>
                <input
                  value={supplierRep}
                  onChange={(e) => setSupplierRep(e.target.value)}
                  className="input w-full"
                />
              </div>
              <div className="col-span-2">
                <label className="label">주소</label>
                <input
                  value={supplierAddr}
                  onChange={(e) => setSupplierAddr(e.target.value)}
                  className="input w-full"
                />
              </div>
              <div>
                <label className="label">업태</label>
                <input
                  value={supplierBizType}
                  onChange={(e) => setSupplierBizType(e.target.value)}
                  placeholder="예) 서비스"
                  className="input w-full"
                />
              </div>
              <div>
                <label className="label">종목</label>
                <input
                  value={supplierBizItem}
                  onChange={(e) => setSupplierBizItem(e.target.value)}
                  placeholder="예) 기타 모유 식품 등"
                  className="input w-full"
                />
              </div>
            </div>
          </fieldset>

          {/* 공급받는자 */}
          <fieldset className="border border-ink-200 rounded-lg p-3 space-y-2">
            <legend className="px-1 text-2xs font-semibold text-ink-500 uppercase tracking-wider flex items-center gap-2">
              공급받는자 (거래처)
              <button
                type="button"
                className="btn-secondary text-2xs"
                onClick={() => setContractorPickerOpen(true)}
              >
                <MagnifyingGlassIcon className="h-3 w-3 mr-1" />
                거래처 조회 ({contractors.length}곳)
              </button>
            </legend>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="label">사업자번호 *</label>
                <input
                  value={contractorBizNo}
                  onChange={(e) => setContractorBizNo(e.target.value)}
                  placeholder="000-00-00000"
                  className="input w-full"
                />
              </div>
              <div>
                <label className="label">회사명 *</label>
                <input
                  value={contractorName}
                  onChange={(e) => setContractorName(e.target.value)}
                  placeholder="회사명 직접 입력 또는 거래처 조회"
                  className="input w-full"
                />
              </div>
              <div>
                <label className="label">대표자</label>
                <input
                  value={contractorRep}
                  onChange={(e) => setContractorRep(e.target.value)}
                  className="input w-full"
                />
              </div>
              <div>
                <label className="label">이메일 *</label>
                <input
                  type="email"
                  value={contractorEmail}
                  onChange={(e) => setContractorEmail(e.target.value)}
                  placeholder="invoice@company.com"
                  className="input w-full"
                />
              </div>
            </div>
          </fieldset>

          {/* 품목 */}
          <fieldset className="border border-ink-200 rounded-lg p-3 space-y-2">
            <legend className="px-1 text-2xs font-semibold text-ink-500 uppercase tracking-wider">
              품목
            </legend>
            <table className="w-full text-2xs">
              <thead>
                <tr className="text-ink-500">
                  <th className="text-left pb-1 font-semibold w-32">품명</th>
                  <th className="text-right pb-1 font-semibold w-14">수량</th>
                  <th className="text-right pb-1 font-semibold w-24">단가</th>
                  <th className="text-right pb-1 font-semibold w-24">공급가액</th>
                  <th className="text-right pb-1 font-semibold w-20">세액</th>
                  <th className="w-6"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {items.map((it, idx) => (
                  <tr key={idx}>
                    <td className="py-1 pr-1">
                      <input
                        value={it.itemName}
                        onChange={(e) => updateItem(idx, { itemName: e.target.value })}
                        placeholder="품명"
                        className="input w-full"
                      />
                    </td>
                    <td className="py-1 px-1">
                      <input
                        type="number"
                        min={1}
                        value={it.quantity}
                        onChange={(e) => updateItem(idx, { quantity: Number(e.target.value) })}
                        className="input w-full text-right"
                      />
                    </td>
                    <td className="py-1 px-1">
                      <input
                        type="number"
                        min={0}
                        value={it.unitPrice}
                        onChange={(e) => updateItem(idx, { unitPrice: Number(e.target.value) })}
                        className="input w-full text-right font-mono"
                      />
                    </td>
                    <td className="py-1 px-1 text-right font-mono text-ink-700">
                      {it.supplyAmount.toLocaleString()}
                    </td>
                    <td className="py-1 px-1 text-right font-mono text-ink-500">
                      {it.taxAmount.toLocaleString()}
                    </td>
                    <td className="py-1 pl-1">
                      {items.length > 1 && (
                        <button
                          onClick={() => removeItem(idx)}
                          className="text-rose-400 hover:text-rose-600"
                        >
                          <TrashIcon className="h-3 w-3" />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button
              onClick={addItem}
              className="flex items-center gap-1 text-2xs text-primary-700 hover:underline mt-1"
            >
              <PlusIcon className="h-3 w-3" />
              품목 추가
            </button>
          </fieldset>

          {/* 합계 */}
          <div className="bg-canvas-50 rounded-lg p-3 flex gap-6 text-2xs justify-end">
            <div>
              <span className="text-ink-500">공급가액</span>
              <span className="ml-2 font-mono font-bold text-ink-900">
                {totalSupplyAmount.toLocaleString()}
              </span>
            </div>
            <div>
              <span className="text-ink-500">세액</span>
              <span className="ml-2 font-mono font-bold text-ink-900">
                {totalTaxAmount.toLocaleString()}
              </span>
            </div>
            <div>
              <span className="text-ink-500">합계</span>
              <span className="ml-2 font-mono font-bold text-primary-700 text-sm">
                {totalAmount.toLocaleString()}
              </span>
            </div>
          </div>

          {/* 비고 */}
          <div>
            <label className="label">비고</label>
            <textarea
              value={remark}
              onChange={(e) => setRemark(e.target.value)}
              rows={2}
              className="input w-full resize-none"
              placeholder="선택 사항"
            />
          </div>

          {/* 디버깅: 그랜터 응답 raw */}
          {debugRaw && (
            <div className="rounded-lg border border-rose-200 bg-rose-50 p-3">
              <div className="text-2xs font-semibold text-rose-700 mb-1">
                그랜터 응답 (디버그) — 필드 오류 확인 후 수정하세요
              </div>
              <pre className="text-2xs text-rose-800 overflow-x-auto whitespace-pre-wrap break-all">
                {debugRaw}
              </pre>
            </div>
          )}
        </div>

        {/* 모달 푸터 */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-ink-200">
          <button onClick={onClose} className="btn-secondary">
            취소
          </button>
          <button
            onClick={() => issueMut.mutate()}
            disabled={issueMut.isPending}
            className="btn-primary flex items-center gap-1.5"
          >
            {issueMut.isPending && (
              <ArrowPathIcon className="h-3 w-3 animate-spin" />
            )}
            {issueMut.isPending ? '발행 중...' : '발행'}
          </button>
        </div>
      </div>

      {/* 거래처 조회 팝오버 모달 */}
      {contractorPickerOpen && (
        <ContractorPickerModal
          open={contractorPickerOpen}
          onClose={() => setContractorPickerOpen(false)}
          contractors={contractors}
          onSelect={(c) => {
            setContractorBizNo(c.businessNumber)
            setContractorName(c.companyName)
            setContractorRep(c.representativeName)
            setContractorEmail(c.email)
          }}
        />
      )}
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// 메인 페이지
// ────────────────────────────────────────────────────────────────────────────

export default function TaxInvoicePage() {
  const initial = periodForPreset('this_month')
  const [preset, setPreset] = useState<PeriodPreset>('this_month')
  const [from, setFrom] = useState(initial.start)
  const [to, setTo] = useState(initial.end)
  const [direction, setDirection] = useState<Direction>('all')
  const [search, setSearch] = useState('')
  const [issueModalOpen, setIssueModalOpen] = useState(false)
  const [prefillContractor, setPrefillContractor] = useState<Partial<ContractorSuggestion> | undefined>(undefined)

  // 거래처 정산 페이지에서 navigate + sessionStorage prefill 처리
  useEffect(() => {
    const raw = sessionStorage.getItem('taxInvoicePrefill')
    if (raw) {
      try {
        const data = JSON.parse(raw) as Partial<ContractorSuggestion>
        setPrefillContractor(data)
        setIssueModalOpen(true)
      } catch {
        // 파싱 실패 시 무시
      } finally {
        sessionStorage.removeItem('taxInvoicePrefill')
      }
    }
  }, [])

  const ready = Boolean(from && to)
  const exceeds31 = ready && daysBetween(from, to) > 31

  const healthQuery = useQuery({
    queryKey: ['granter-health'],
    queryFn: () => granterApi.health().then((r) => r.data),
    retry: false,
  })
  const isConfigured = healthQuery.data?.configured

  const ticketsQuery = useQuery({
    queryKey: ['granter-tax-invoices', from, to],
    queryFn: () => {
      let actualStart = from
      if (exceeds31) {
        const d = new Date(to)
        d.setDate(d.getDate() - 30)
        actualStart = isoLocal(d)
      }
      return granterApi
        .listTickets({
          ticketType: 'TAX_INVOICE_TICKET',
          startDate: actualStart,
          endDate: to,
        })
        .then((r) => r.data)
    },
    enabled: !!isConfigured && ready,
    retry: false,
  })

  const allTickets: any[] = useMemo(() => {
    const d = ticketsQuery.data
    if (Array.isArray(d)) return d
    return d?.data || []
  }, [ticketsQuery.data])

  // 거래처 풀: 발행 모달 열릴 때만 호출 (페이지 진입 시 자동 호출 금지 — 그랜터 rate limit 회피)
  // 12개월치 31일씩 분할 병렬 호출이라 자동으로 돌리면 다른 페이지의 그랜터 호출까지 영향
  const contractorsPoolQuery = useQuery({
    queryKey: ['granter-contractors-pool', 12],
    queryFn: () => granterApi.contractorsPool(12).then((r) => r.data),
    enabled: !!isConfigured && issueModalOpen,
    retry: 1,
  })

  // 백엔드 풀 데이터 우선, 없으면 현재 페이지 티켓에서 추출(보강)
  const contractors = useMemo<ContractorSuggestion[]>(() => {
    const pool = contractorsPoolQuery.data?.contractors as ContractorSuggestion[] | undefined
    if (pool && pool.length > 0) return pool
    return extractContractors(allTickets)
  }, [contractorsPoolQuery.data, allTickets])

  // 최근 세금계산서 자동 탐색
  const findRecentMut = useMutation({
    mutationFn: async () => {
      const today = new Date()
      for (let offset = 0; offset < 24; offset++) {
        const end = new Date(today)
        end.setDate(end.getDate() - offset * 31)
        const start = new Date(end)
        start.setDate(start.getDate() - 31)
        const startStr = isoLocal(start)
        const endStr = isoLocal(end)
        try {
          const r = await granterApi.listTickets({
            ticketType: 'TAX_INVOICE_TICKET',
            startDate: startStr,
            endDate: endStr,
          })
          const items = Array.isArray(r.data) ? r.data : r.data?.data || []
          if (items.length > 0) {
            return { start: startStr, end: endStr, count: items.length, monthsBack: offset }
          }
        } catch {
          // 무시
        }
      }
      return { start: null, end: null, count: 0, monthsBack: 0 }
    },
    onSuccess: (res) => {
      if (res.start && res.end) {
        setPreset('custom')
        setFrom(res.start)
        setTo(res.end)
        toast.success(
          `${res.monthsBack === 0 ? '이번달' : `${res.monthsBack}개월 전`} 구간 (${res.count}건)`
        )
      } else {
        toast.error('최근 24개월 내 세금계산서가 없습니다. 그랜터에서 홈택스 데이터 동기화가 진행 중일 수 있습니다.')
      }
    },
  })

  // 매출/매입 분리: transactionType IN=매출, OUT=매입 (그랜터 관행)
  const salesTickets = useMemo(
    () => allTickets.filter((t) => str(t, 'transactionType') === 'IN'),
    [allTickets]
  )
  const purchaseTickets = useMemo(
    () => allTickets.filter((t) => str(t, 'transactionType') === 'OUT'),
    [allTickets]
  )

  const filtered = useMemo(() => {
    let arr =
      direction === 'sales' ? salesTickets : direction === 'purchase' ? purchaseTickets : allTickets
    if (search) {
      const s = search.toLowerCase()
      arr = arr.filter((t) => {
        const text =
          (str(t, 'content') + str(t, 'description') + str(t, 'contact') + str(t, 'merchantName')).toLowerCase()
        return text.includes(s)
      })
    }
    return arr
  }, [direction, salesTickets, purchaseTickets, allTickets, search])

  const salesTotal = useMemo(() => salesTickets.reduce((s, t) => s + num(t, 'amount'), 0), [salesTickets])
  const purchaseTotal = useMemo(
    () => purchaseTickets.reduce((s, t) => s + num(t, 'amount'), 0),
    [purchaseTickets]
  )

  return (
    <div className="space-y-3">
      {/* 세금계산서 발행 모달 */}
      <IssueTaxInvoiceModal
        open={issueModalOpen}
        onClose={() => { setIssueModalOpen(false); setPrefillContractor(undefined) }}
        onSuccess={() => ticketsQuery.refetch()}
        contractors={contractors}
        initialContractor={prefillContractor}
      />

      {/* Header */}
      <div className="flex items-end justify-between flex-wrap gap-2">
        <div>
          <h1 className="flex items-center gap-2">
            <ReceiptPercentIcon className="h-4 w-4 text-ink-500" />
            세금계산서
          </h1>
          <p className="text-2xs text-ink-500 mt-0.5">
            그랜터 TAX_INVOICE_TICKET — 매출(IN) / 매입(OUT) 자동 분리
          </p>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <PeriodPicker
            preset={preset}
            from={from}
            to={to}
            onChange={(p, f, t) => {
              setPreset(p)
              setFrom(f)
              setTo(t)
            }}
            groups={[
              { label: '일/주', presets: ['today', 'yesterday', 'this_week', 'last_week'] },
              { label: '월', presets: ['this_month', 'last_month'] },
              { label: '범위', presets: ['last_7d', 'last_30d'] },
            ]}
          />
          <button
            onClick={() => findRecentMut.mutate()}
            disabled={findRecentMut.isPending}
            className="btn-secondary"
            title="최근 세금계산서가 있는 31일 구간 자동 탐색"
          >
            <ClockIcon className="h-3 w-3 mr-1" />
            {findRecentMut.isPending ? '탐색 중...' : '최근 거래 한 달'}
          </button>
          <button onClick={() => ticketsQuery.refetch()} className="btn-secondary">
            <ArrowPathIcon className="h-3 w-3" />
          </button>
          {/* 세금계산서 발행 버튼 */}
          <button
            onClick={() => setIssueModalOpen(true)}
            className="btn-primary flex items-center gap-1"
          >
            <PlusIcon className="h-3 w-3" />
            발행
          </button>
        </div>
      </div>

      {/* 공급자(본인 회사) 정보 패널 */}
      <div className="rounded-md border border-ink-200 bg-canvas-50 px-3 py-2 text-2xs text-ink-700">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
          <span className="font-semibold text-ink-900">{SUPPLIER_DEFAULT.companyName}</span>
          <span className="text-ink-500">·</span>
          <span>{SUPPLIER_DEFAULT.representativeName} (대표)</span>
          <span className="text-ink-400">|</span>
          <span>사업자번호 <span className="font-mono">{SUPPLIER_DEFAULT.businessNumber}</span></span>
          <span className="text-ink-500">·</span>
          <span>법인번호 <span className="font-mono">{SUPPLIER_DEFAULT.corporateNumber}</span></span>
          <span className="text-ink-400">|</span>
          <span className="text-ink-600">{SUPPLIER_DEFAULT.address}</span>
          <span className="text-ink-400">|</span>
          <span>업태 {SUPPLIER_DEFAULT.businessType}</span>
          <span className="text-ink-500">·</span>
          <span>종목 {SUPPLIER_DEFAULT.businessItem}</span>
        </div>
      </div>

      {!isConfigured ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 flex items-center gap-2">
          <ExclamationTriangleIcon className="h-4 w-4 text-amber-600" />
          <div className="text-2xs text-amber-800">그랜터 API 키 미설정</div>
        </div>
      ) : (
        <div className="flex items-center gap-2 flex-wrap">
          <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-1 flex items-center gap-2">
            <CheckCircleIcon className="h-3.5 w-3.5 text-emerald-600" />
            <span className="text-2xs text-emerald-800">그랜터 연결됨</span>
          </div>
          {exceeds31 && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-1 text-2xs text-amber-800">
              31일 초과 — 종료일 기준 최근 31일만 자동 조회
            </div>
          )}
        </div>
      )}

      {/* KPI */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <div className="panel px-3 py-2">
          <div className="text-2xs font-medium text-ink-500 uppercase tracking-wider">총 발행/수취</div>
          <div className="mt-0.5 font-mono tabular-nums font-bold text-base text-ink-900">
            {allTickets.length}건
          </div>
        </div>
        <div className="panel px-3 py-2">
          <div className="text-2xs font-medium text-ink-500 uppercase tracking-wider flex items-center gap-1">
            <ArrowDownLeftIcon className="h-3 w-3 text-emerald-500" />
            매출 (발행)
          </div>
          <div className="mt-0.5 font-mono tabular-nums font-bold text-base text-emerald-700">
            {formatCurrency(salesTotal, false)}
          </div>
          <div className="text-2xs text-ink-400 mt-0.5">{salesTickets.length}건</div>
        </div>
        <div className="panel px-3 py-2">
          <div className="text-2xs font-medium text-ink-500 uppercase tracking-wider flex items-center gap-1">
            <ArrowUpRightIcon className="h-3 w-3 text-rose-500" />
            매입 (수취)
          </div>
          <div className="mt-0.5 font-mono tabular-nums font-bold text-base text-rose-700">
            {formatCurrency(purchaseTotal, false)}
          </div>
          <div className="text-2xs text-ink-400 mt-0.5">{purchaseTickets.length}건</div>
        </div>
        <div className="panel px-3 py-2">
          <div className="text-2xs font-medium text-ink-500 uppercase tracking-wider">매출 − 매입</div>
          <div
            className={`mt-0.5 font-mono tabular-nums font-bold text-base ${
              salesTotal - purchaseTotal >= 0 ? 'text-primary-700' : 'text-rose-700'
            }`}
          >
            {formatCurrency(salesTotal - purchaseTotal, false)}
          </div>
        </div>
      </div>

      {/* Filter */}
      <div className="panel p-2 flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-0.5 p-0.5 rounded-md bg-canvas-50 border border-ink-200">
          {(['all', 'sales', 'purchase'] as Direction[]).map((d) => (
            <button
              key={d}
              onClick={() => setDirection(d)}
              className={`px-2.5 py-1 rounded text-2xs font-semibold ${
                direction === d ? 'bg-ink-900 text-white' : 'text-ink-600 hover:bg-white'
              }`}
            >
              {d === 'all' ? '전체' : d === 'sales' ? '매출' : '매입'}
            </button>
          ))}
        </div>
        <div className="relative ml-auto">
          <MagnifyingGlassIcon className="h-3 w-3 absolute left-2 top-1/2 -translate-y-1/2 text-ink-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="거래처/적요 검색"
            className="pl-7 input w-44 text-2xs"
          />
        </div>
      </div>

      {/* Table */}
      <div className="panel overflow-hidden">
        <div className="overflow-x-auto max-h-[calc(100vh-26rem)] overflow-y-auto">
          <table className="min-w-full">
            <thead className="bg-canvas-50 sticky top-0 z-10 border-b border-ink-200">
              <tr>
                <th className="px-3 py-1.5 text-left text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                  발행일자
                </th>
                <th className="px-3 py-1.5 text-left text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                  구분
                </th>
                <th className="px-3 py-1.5 text-left text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                  거래처
                </th>
                <th className="px-3 py-1.5 text-left text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                  내용
                </th>
                <th className="px-3 py-1.5 text-right text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                  공급가액
                </th>
                <th className="px-3 py-1.5 text-left text-2xs font-semibold text-ink-500 uppercase tracking-wider">
                  계정과목
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {ticketsQuery.isLoading && (
                <tr>
                  <td colSpan={6} className="text-center py-6 text-2xs text-ink-400">
                    불러오는 중…
                  </td>
                </tr>
              )}
              {filtered.map((t, idx) => {
                const isSales = str(t, 'transactionType') === 'IN'
                const cat = t.expenseCategory || {}
                const ti = t?.taxInvoice
                // 매출(IN): contractor(공급받는자) = 거래처 / 매입(OUT): supplier(공급자) = 거래처
                const contact = isSales
                  ? str(ti?.contractor, 'companyName') || str(t, 'contact', 'content')
                  : str(ti?.supplier, 'companyName') || str(t, 'contact', 'content')
                const counterRegNo = isSales
                  ? str(ti?.contractor, 'registrationNumber')
                  : str(ti?.supplier, 'registrationNumber')
                return (
                  <tr key={t.id || idx} className="hover:bg-canvas-50">
                    <td className="px-3 py-1.5 whitespace-nowrap text-2xs text-ink-700 font-mono">
                      {str(t, 'transactAt', 'date').slice(0, 10)}
                    </td>
                    <td className="px-3 py-1.5">
                      <span
                        className={`badge ${
                          isSales
                            ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                            : 'bg-rose-50 text-rose-700 border-rose-200'
                        }`}
                      >
                        {isSales ? '매출' : '매입'}
                      </span>
                    </td>
                    <td className="px-3 py-1.5 text-xs text-ink-900">
                      <div className="font-medium">{contact || '-'}</div>
                      {counterRegNo && (
                        <div className="text-2xs text-ink-500 font-mono">{counterRegNo}</div>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-xs text-ink-700 max-w-md truncate">
                      {str(t, 'content', 'description')}
                    </td>
                    <td
                      className={`px-3 py-1.5 text-right font-mono tabular-nums text-xs font-semibold ${
                        isSales ? 'text-emerald-700' : 'text-rose-700'
                      }`}
                    >
                      {formatCurrency(num(t, 'amount'), false)}
                    </td>
                    <td className="px-3 py-1.5 whitespace-nowrap text-2xs">
                      {str(cat, 'name') ? (
                        <span className="inline-flex items-center gap-1">
                          <span className="font-mono text-ink-400">{str(cat, 'code')}</span>
                          <span className="text-ink-700">{str(cat, 'name')}</span>
                        </span>
                      ) : (
                        <span className="text-ink-300">-</span>
                      )}
                    </td>
                  </tr>
                )
              })}
              {!ticketsQuery.isLoading && filtered.length === 0 && (
                <tr>
                  <td colSpan={6} className="text-center py-6 text-2xs text-ink-400">
                    <div>이 기간에 세금계산서가 없습니다.</div>
                    <div className="mt-2 space-y-1">
                      <button
                        onClick={() => findRecentMut.mutate()}
                        disabled={findRecentMut.isPending}
                        className="text-primary-700 hover:underline font-semibold"
                      >
                        최근 12개월에서 자동 탐색
                      </button>
                      <div className="text-2xs text-ink-400">
                        그랜터 홈택스 자산 연동 상태는 [통합조회 → 설정]에서 확인하세요.
                      </div>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="text-2xs text-ink-400 px-1">
        transactionType = IN 매출, OUT 매입 자동 분리. 세금계산서 발행은 헤더 [발행] 버튼 사용.
      </div>
    </div>
  )
}
