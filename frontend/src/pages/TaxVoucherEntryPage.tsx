import { useEffect, useRef, useState, useMemo } from 'react'
import { useMutation } from '@tanstack/react-query'
import {
  PencilSquareIcon, CheckCircleIcon, ArrowPathIcon,
  CalendarDaysIcon, DocumentTextIcon, CreditCardIcon, ReceiptPercentIcon,
  BanknotesIcon, BoltIcon,
} from '@heroicons/react/24/outline'
import { autoVoucherApi, AutoVoucherLine } from '@/services/api'
import { formatCurrency, isoLocal } from '@/utils/format'

// 매입매출 전표 유형 (더존식)
type VoucherKind =
  | 'sales_tax_invoice'       // 매출 세금계산서
  | 'purchase_tax_invoice'    // 매입 세금계산서
  | 'sales_invoice'           // 매출 계산서 (영세/면세)
  | 'purchase_invoice'        // 매입 계산서 (영세/면세)
  | 'card'                    // 카드 매입
  | 'cash_receipt'            // 현금영수증

const KIND_TABS: Array<{ key: VoucherKind; label: string; tone: string; icon: any }> = [
  { key: 'sales_tax_invoice', label: '매출 세금계산서', tone: 'border-emerald-500 text-emerald-700 bg-emerald-50', icon: ReceiptPercentIcon },
  { key: 'purchase_tax_invoice', label: '매입 세금계산서', tone: 'border-rose-500 text-rose-700 bg-rose-50', icon: ReceiptPercentIcon },
  { key: 'sales_invoice', label: '매출 계산서(영세)', tone: 'border-emerald-400 text-emerald-600 bg-emerald-50', icon: DocumentTextIcon },
  { key: 'purchase_invoice', label: '매입 계산서(영세)', tone: 'border-rose-400 text-rose-600 bg-rose-50', icon: DocumentTextIcon },
  { key: 'card', label: '카드 매입', tone: 'border-blue-500 text-blue-700 bg-blue-50', icon: CreditCardIcon },
  { key: 'cash_receipt', label: '현금영수증', tone: 'border-amber-500 text-amber-700 bg-amber-50', icon: BanknotesIcon },
]

// 자주 쓰는 비용 계정 (매입·카드·현금영수증의 차변 계정 후보)
const COMMON_EXPENSE_ACCOUNTS = [
  { code: '153', name: '원재료' },
  { code: '146', name: '상품' },
  { code: '530', name: '소모품비(제)' },
  { code: '830', name: '소모품비(판)' },
  { code: '811', name: '복리후생비(판)' },
  { code: '511', name: '복리후생비(제)' },
  { code: '812', name: '여비교통비(판)' },
  { code: '813', name: '접대비(판)' },
  { code: '814', name: '통신비(판)' },
  { code: '815', name: '수도광열비(판)' },
  { code: '817', name: '세금과공과(판)' },
  { code: '820', name: '수선비(판)' },
  { code: '821', name: '보험료(판)' },
  { code: '822', name: '차량유지비(판)' },
  { code: '824', name: '운반비(판)' },
  { code: '825', name: '교육훈련비(판)' },
  { code: '826', name: '도서인쇄비(판)' },
  { code: '827', name: '회의비(판)' },
  { code: '830', name: '소모품비(판)' },
  { code: '831', name: '지급수수료(판)' },
  { code: '833', name: '광고선전비(판)' },
  { code: '839', name: '판매수수료' },
  { code: '212', name: '비품' },
]

function todayISO() { return isoLocal(new Date()) }

interface FormState {
  kind: VoucherKind
  transaction_date: string
  counterparty: string
  description: string
  supply: string         // 공급가
  vat: string            // 부가세 (자동 계산되지만 수정 가능)
  vatRate: number        // 10% default
  expenseAccountCode: string
  expenseAccountName: string
  cardCompany: string    // 카드사 (매입 전용)
}

const initialForm = (): FormState => ({
  kind: 'purchase_tax_invoice',
  transaction_date: todayISO(),
  counterparty: '',
  description: '',
  supply: '',
  vat: '',
  vatRate: 10,
  expenseAccountCode: '153',
  expenseAccountName: '원재료',
  cardCompany: '',
})

export default function TaxVoucherEntryPage() {
  const [form, setForm] = useState<FormState>(initialForm())
  const [lastVoucherNo, setLastVoucherNo] = useState<string | null>(null)
  const [continueMode, setContinueMode] = useState(true)  // 연속 입력 모드
  const counterpartyRef = useRef<HTMLInputElement>(null)
  const supplyRef = useRef<HTMLInputElement>(null)

  const supplyNum = Number(form.supply.replace(/,/g, '')) || 0
  const vatNum = Number(form.vat.replace(/,/g, '')) || 0
  const total = supplyNum + vatNum
  const isTaxable = form.kind === 'sales_tax_invoice' || form.kind === 'purchase_tax_invoice' ||
                    form.kind === 'card' || form.kind === 'cash_receipt'
  const isSales = form.kind === 'sales_tax_invoice' || form.kind === 'sales_invoice'

  // 공급가 변경 시 부가세 자동 계산
  function setSupplyAndAutoVat(s: string) {
    const supply = Number(s.replace(/,/g, '')) || 0
    setForm((f) => ({
      ...f,
      supply: s,
      vat: isTaxable ? Math.round(supply * f.vatRate / 100).toString() : '0',
    }))
  }

  // 총액 입력 → 공급가/부가세 역산
  function setTotalAndSplit(t: string) {
    const totalNum = Number(t.replace(/,/g, '')) || 0
    if (isTaxable && form.vatRate > 0) {
      const supply = Math.round(totalNum * 100 / (100 + form.vatRate))
      const vat = totalNum - supply
      setForm((f) => ({ ...f, supply: supply.toString(), vat: vat.toString() }))
    } else {
      setForm((f) => ({ ...f, supply: totalNum.toString(), vat: '0' }))
    }
  }

  // 자동 생성된 분개 라인 (미리보기)
  const previewLines = useMemo(() => {
    const supply = supplyNum
    const vat = vatNum
    const tot = supply + vat
    const debits: AutoVoucherLine[] = []
    const credits: AutoVoucherLine[] = []

    if (tot === 0) return { debits, credits }

    if (form.kind === 'sales_tax_invoice' || form.kind === 'sales_invoice') {
      // 매출
      debits.push({ side: 'debit', account_code: '108', account_name: '외상매출금', amount: tot })
      credits.push({ side: 'credit', account_code: '404', account_name: '제품매출', amount: supply })
      if (vat > 0) {
        credits.push({ side: 'credit', account_code: '255', account_name: '부가세예수금', amount: vat })
      }
    } else if (form.kind === 'purchase_tax_invoice' || form.kind === 'purchase_invoice') {
      // 매입
      debits.push({ side: 'debit', account_code: form.expenseAccountCode, account_name: form.expenseAccountName, amount: supply })
      if (vat > 0) {
        debits.push({ side: 'debit', account_code: '135', account_name: '부가세대급금', amount: vat })
      }
      credits.push({ side: 'credit', account_code: '251', account_name: '외상매입금', amount: tot })
    } else if (form.kind === 'card') {
      // 카드 매입
      debits.push({ side: 'debit', account_code: form.expenseAccountCode, account_name: form.expenseAccountName, amount: supply })
      if (vat > 0) {
        debits.push({ side: 'debit', account_code: '135', account_name: '부가세대급금', amount: vat })
      }
      credits.push({ side: 'credit', account_code: '253', account_name: '미지급금', amount: tot, memo: form.cardCompany })
    } else if (form.kind === 'cash_receipt') {
      // 현금영수증 매입
      debits.push({ side: 'debit', account_code: form.expenseAccountCode, account_name: form.expenseAccountName, amount: supply })
      if (vat > 0) {
        debits.push({ side: 'debit', account_code: '135', account_name: '부가세대급금', amount: vat })
      }
      credits.push({ side: 'credit', account_code: '101', account_name: '현금', amount: tot })
    }
    return { debits, credits }
  }, [form, supplyNum, vatNum])

  const submitMut = useMutation({
    mutationFn: () => autoVoucherApi.directVoucher({
      transaction_date: form.transaction_date,
      source_type: form.kind,
      counterparty: form.counterparty,
      description: form.description,
      supply_amount: supplyNum,
      vat_amount: vatNum,
      debit_lines: previewLines.debits,
      credit_lines: previewLines.credits,
    }),
    onSuccess: (res) => {
      setLastVoucherNo(res.data?.voucher_number || null)
      if (continueMode) {
        // 연속 입력: 거래처/공급가 등 reset, 일자는 유지
        setForm((f) => ({
          ...f,
          counterparty: '',
          description: '',
          supply: '',
          vat: '',
        }))
        setTimeout(() => counterpartyRef.current?.focus(), 50)
      }
    },
  })

  function canSubmit(): boolean {
    return supplyNum > 0 && (previewLines.debits.length > 0 && previewLines.credits.length > 0)
  }

  // 단축키
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        if (canSubmit() && !submitMut.isPending) submitMut.mutate()
      }
      if (e.key === 'F2') {
        e.preventDefault()
        counterpartyRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [submitMut, canSubmit])

  const showExpenseAccount = !isSales  // 매입성은 차변 비용계정 선택 필요
  const showCardCompany = form.kind === 'card'

  return (
    <div className="space-y-3 max-w-7xl">
      {/* Header */}
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="flex items-center gap-2">
            <PencilSquareIcon className="h-5 w-5 text-ink-500" />
            매입매출 전표 입력
          </h1>
          <p className="text-xs text-ink-500 mt-1">
            공급가 입력 시 부가세 자동 계산 + 분개 자동 생성.
            <span className="ml-2 text-ink-400">단축키: Ctrl+S 저장 · F2 거래처</span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-2xs text-ink-600 cursor-pointer">
            <input type="checkbox" checked={continueMode}
              onChange={(e) => setContinueMode(e.target.checked)}
              className="rounded border-ink-300 text-ink-900 focus:ring-ink-300 w-3 h-3" />
            연속 입력 모드
          </label>
          {lastVoucherNo && (
            <span className="text-2xs text-emerald-700 font-semibold inline-flex items-center gap-1">
              <CheckCircleIcon className="h-3.5 w-3.5" />
              직전 #{lastVoucherNo} 저장됨
            </span>
          )}
        </div>
      </div>

      {/* Kind tabs */}
      <div className="flex gap-1 border-b border-ink-200 overflow-x-auto">
        {KIND_TABS.map((t) => {
          const active = form.kind === t.key
          const Icon = t.icon
          return (
            <button key={t.key}
              onClick={() => setForm((f) => ({ ...f, kind: t.key }))}
              className={`px-3 py-1.5 text-xs font-semibold border-b-2 -mb-px whitespace-nowrap transition ${
                active ? t.tone : 'border-transparent text-ink-500 hover:text-ink-900'
              }`}
            >
              <Icon className="h-3.5 w-3.5 inline mr-1" />
              {t.label}
            </button>
          )
        })}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {/* 입력 폼 */}
        <div className="panel p-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-2xs font-semibold text-ink-500 uppercase tracking-wider">거래일자</label>
              <div className="mt-0.5 flex items-center gap-1 px-2 py-1.5 rounded-md border border-ink-200">
                <CalendarDaysIcon className="h-3.5 w-3.5 text-ink-400" />
                <input type="date" value={form.transaction_date}
                  onChange={(e) => setForm((f) => ({ ...f, transaction_date: e.target.value }))}
                  className="bg-transparent text-xs font-medium text-ink-700 focus:outline-none w-full" />
              </div>
            </div>
            <div>
              <label className="text-2xs font-semibold text-ink-500 uppercase tracking-wider">거래처</label>
              <input
                ref={counterpartyRef}
                value={form.counterparty}
                onChange={(e) => setForm((f) => ({ ...f, counterparty: e.target.value }))}
                onKeyDown={(e) => { if (e.key === 'Enter') supplyRef.current?.focus() }}
                placeholder="거래처명"
                className="mt-0.5 w-full px-2 py-1.5 text-xs rounded-md border border-ink-200 focus:border-ink-400 focus:outline-none"
              />
            </div>
          </div>

          <div>
            <label className="text-2xs font-semibold text-ink-500 uppercase tracking-wider">적요</label>
            <input
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              placeholder="(선택) 거래 내용"
              className="mt-0.5 w-full px-2 py-1.5 text-xs rounded-md border border-ink-200 focus:border-ink-400 focus:outline-none"
            />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="text-2xs font-semibold text-ink-500 uppercase tracking-wider">공급가액</label>
              <input
                ref={supplyRef}
                inputMode="numeric"
                value={form.supply ? Number(form.supply.replace(/,/g, '')).toLocaleString('ko-KR') : ''}
                onChange={(e) => setSupplyAndAutoVat(e.target.value)}
                placeholder="0"
                className="mt-0.5 w-full px-2 py-1.5 text-sm font-mono text-right rounded-md border border-ink-200 focus:border-ink-400 focus:outline-none"
              />
            </div>
            <div>
              <label className="text-2xs font-semibold text-ink-500 uppercase tracking-wider">부가세</label>
              <input
                inputMode="numeric"
                value={form.vat ? Number(form.vat.replace(/,/g, '')).toLocaleString('ko-KR') : ''}
                onChange={(e) => setForm((f) => ({ ...f, vat: e.target.value }))}
                disabled={!isTaxable}
                placeholder="0"
                className={`mt-0.5 w-full px-2 py-1.5 text-sm font-mono text-right rounded-md border focus:outline-none ${
                  isTaxable ? 'border-ink-200 focus:border-ink-400' : 'border-ink-100 bg-ink-50 text-ink-400'
                }`}
              />
            </div>
            <div>
              <label className="text-2xs font-semibold text-ink-500 uppercase tracking-wider">합계 (총액)</label>
              <input
                inputMode="numeric"
                value={total ? total.toLocaleString('ko-KR') : ''}
                onChange={(e) => setTotalAndSplit(e.target.value)}
                placeholder="0"
                className="mt-0.5 w-full px-2 py-1.5 text-sm font-mono text-right rounded-md border border-emerald-300 bg-emerald-50 focus:border-emerald-500 focus:outline-none font-semibold"
              />
            </div>
          </div>

          {showExpenseAccount && (
            <div>
              <label className="text-2xs font-semibold text-ink-500 uppercase tracking-wider">차변 계정 (비용/자산)</label>
              <select
                value={form.expenseAccountCode}
                onChange={(e) => {
                  const acc = COMMON_EXPENSE_ACCOUNTS.find((a) => a.code === e.target.value)
                  setForm((f) => ({
                    ...f,
                    expenseAccountCode: e.target.value,
                    expenseAccountName: acc?.name || '',
                  }))
                }}
                className="mt-0.5 w-full px-2 py-1.5 text-xs rounded-md border border-ink-200 focus:border-ink-400 focus:outline-none"
              >
                {COMMON_EXPENSE_ACCOUNTS.map((a) => (
                  <option key={a.code} value={a.code}>
                    {a.code} · {a.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {showCardCompany && (
            <div>
              <label className="text-2xs font-semibold text-ink-500 uppercase tracking-wider">카드사</label>
              <input
                value={form.cardCompany}
                onChange={(e) => setForm((f) => ({ ...f, cardCompany: e.target.value }))}
                placeholder="예: 비씨카드(3917)"
                className="mt-0.5 w-full px-2 py-1.5 text-xs rounded-md border border-ink-200 focus:border-ink-400 focus:outline-none"
              />
            </div>
          )}

          <div className="flex items-center gap-2 pt-3 border-t border-ink-200">
            <button
              onClick={() => submitMut.mutate()}
              disabled={!canSubmit() || submitMut.isPending}
              className="btn-primary"
            >
              <CheckCircleIcon className="h-3.5 w-3.5 mr-1" />
              {submitMut.isPending ? '저장 중…' : '전표 저장 (Ctrl+S)'}
            </button>
            <button
              onClick={() => setForm(initialForm())}
              className="btn-secondary"
            >
              <ArrowPathIcon className="h-3.5 w-3.5 mr-1" />
              초기화
            </button>
            {submitMut.isError && (
              <span className="text-2xs text-rose-600">
                {((submitMut.error as any)?.response?.data?.detail) || '저장 실패'}
              </span>
            )}
          </div>
        </div>

        {/* 분개 미리보기 */}
        <div className="panel p-4">
          <div className="flex items-center gap-2 mb-2">
            <BoltIcon className="h-3.5 w-3.5 text-ink-500" />
            <h2 className="text-xs font-semibold text-ink-700 uppercase tracking-wider">자동 분개 미리보기</h2>
          </div>

          {!supplyNum ? (
            <div className="py-8 text-center text-2xs text-ink-400">
              공급가를 입력하면 분개가 자동 생성됩니다.
            </div>
          ) : (
            <div className="space-y-3">
              <div>
                <div className="text-2xs font-semibold text-ink-600 mb-1 flex items-center justify-between">
                  <span>차변</span>
                  <span className="font-mono text-ink-500">
                    합계 {formatCurrency(
                      previewLines.debits.reduce((a, b) => a + Number(b.amount), 0),
                      false
                    )}
                  </span>
                </div>
                <div className="border border-ink-200 rounded-md overflow-hidden">
                  {previewLines.debits.map((l, i) => (
                    <div key={i} className={`flex items-center justify-between text-xs px-3 py-1.5 ${i > 0 ? 'border-t border-ink-100' : ''}`}>
                      <div>
                        <span className="font-mono text-ink-400 text-2xs">{l.account_code}</span>
                        <span className="ml-2 text-ink-800">{l.account_name}</span>
                      </div>
                      <span className="font-mono font-semibold text-ink-900">
                        {formatCurrency(Number(l.amount), false)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <div className="text-2xs font-semibold text-ink-600 mb-1 flex items-center justify-between">
                  <span>대변</span>
                  <span className="font-mono text-ink-500">
                    합계 {formatCurrency(
                      previewLines.credits.reduce((a, b) => a + Number(b.amount), 0),
                      false
                    )}
                  </span>
                </div>
                <div className="border border-ink-200 rounded-md overflow-hidden">
                  {previewLines.credits.map((l, i) => (
                    <div key={i} className={`flex items-center justify-between text-xs px-3 py-1.5 ${i > 0 ? 'border-t border-ink-100' : ''}`}>
                      <div>
                        <span className="font-mono text-ink-400 text-2xs">{l.account_code}</span>
                        <span className="ml-2 text-ink-800">{l.account_name}</span>
                        {l.memo && <span className="ml-2 text-2xs text-ink-500">({l.memo})</span>}
                      </div>
                      <span className="font-mono font-semibold text-ink-900">
                        {formatCurrency(Number(l.amount), false)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="text-2xs text-ink-500 px-1">
                <span className="font-semibold">차변 합 = 대변 합 검증:</span>{' '}
                {previewLines.debits.reduce((a, b) => a + Number(b.amount), 0) ===
                 previewLines.credits.reduce((a, b) => a + Number(b.amount), 0) ? (
                  <span className="text-emerald-600 font-semibold">✓ 일치</span>
                ) : (
                  <span className="text-rose-600 font-semibold">✗ 불일치</span>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
