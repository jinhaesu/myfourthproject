import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import {
  XMarkIcon,
  CheckIcon,
  ArrowsRightLeftIcon,
  ArrowDownLeftIcon,
  ArrowUpRightIcon,
} from '@heroicons/react/24/outline'
import { ledgerApi } from '@/services/api'
import { useAuthStore } from '@/store/authStore'
import { formatCurrency } from '@/utils/format'

type Direction = 'debit' | 'credit'

interface Entry {
  id: number
  transaction_date: string
  transaction_number?: string
  counterparty?: string
  description: string
  debit: number | string
  credit: number | string
  running_balance: number | string
  counterparty_account_code?: string
  counterparty_account_name?: string
  memo?: string
}

interface AccountSummary {
  account_code: string
  account_name: string
  category: string
}

interface LedgerEntryDetailPanelProps {
  entry: Entry
  source: AccountSummary
  onClose: () => void
}

export default function LedgerEntryDetailPanel({
  entry,
  source,
  onClose,
}: LedgerEntryDetailPanelProps) {
  const qc = useQueryClient()
  const userId = useAuthStore((s) => s.user?.id ?? 1)

  const initialDirection: Direction = Number(entry.debit) > 0 ? 'debit' : 'credit'
  const initialAmount = Number(entry.debit) > 0 ? Number(entry.debit) : Number(entry.credit)

  const [direction, setDirection] = useState<Direction>(initialDirection)
  const [amount, setAmount] = useState<string>(String(initialAmount))
  const [sourceCode, setSourceCode] = useState(source.account_code)
  const [sourceName, setSourceName] = useState(source.account_name)
  const [counterCode, setCounterCode] = useState(entry.counterparty_account_code || '')
  const [counterName, setCounterName] = useState(entry.counterparty_account_name || '')
  const [counterparty, setCounterparty] = useState(entry.counterparty || '')
  const [counterpartyCode, setCounterpartyCode] = useState('')
  const [description, setDescription] = useState(entry.description || '')

  // entry가 바뀌면 입력값 동기화
  useEffect(() => {
    const dir: Direction = Number(entry.debit) > 0 ? 'debit' : 'credit'
    setDirection(dir)
    setAmount(String(Number(entry.debit) > 0 ? entry.debit : entry.credit))
    setCounterCode(entry.counterparty_account_code || '')
    setCounterName(entry.counterparty_account_name || '')
    setCounterparty(entry.counterparty || '')
    setDescription(entry.description || '')
  }, [entry.id])

  useEffect(() => {
    setSourceCode(source.account_code)
    setSourceName(source.account_name)
  }, [source.account_code])

  const isDirty = useMemo(() => {
    return (
      direction !== initialDirection ||
      Number(amount) !== initialAmount ||
      sourceCode !== source.account_code ||
      sourceName !== source.account_name ||
      counterCode !== (entry.counterparty_account_code || '') ||
      counterName !== (entry.counterparty_account_name || '') ||
      counterparty !== (entry.counterparty || '') ||
      description !== (entry.description || '')
    )
  }, [direction, amount, sourceCode, sourceName, counterCode, counterName, counterparty, description, source, entry, initialDirection, initialAmount])

  const saveMut = useMutation({
    mutationFn: () =>
      ledgerApi.updateEntry(
        entry.id,
        {
          direction,
          amount: Number(amount),
          source_account_code: sourceCode || undefined,
          source_account_name: sourceName || undefined,
          account_code: counterCode || undefined,
          account_name: counterName || undefined,
          counterparty: counterparty || undefined,
          counterparty_code: counterpartyCode || undefined,
          description: description || undefined,
        },
        userId
      ),
    onSuccess: () => {
      toast.success('거래가 수정되었습니다.')
      qc.invalidateQueries({ queryKey: ['ledger-entries'] })
      qc.invalidateQueries({ queryKey: ['ledger-accounts'] })
    },
    onError: (e: any) => {
      toast.error(e.response?.data?.detail || '저장에 실패했습니다.')
    },
  })

  // ⌘S 단축키로 저장
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        if (isDirty && !saveMut.isPending) saveMut.mutate()
      }
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isDirty, saveMut.isPending])

  return (
    <div className="border-t border-ink-200 bg-canvas-50 flex flex-col">
      {/* Header strip */}
      <div className="px-4 py-2 border-b border-ink-200 bg-white flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-2xs font-mono text-ink-400">#{entry.id}</span>
          <span className="text-2xs text-ink-400">·</span>
          <span className="text-xs text-ink-700">{entry.transaction_date}</span>
          <span className="text-2xs text-ink-400">·</span>
          <span className="text-xs font-medium text-ink-900 truncate max-w-xs">
            {description || entry.description || '거래 상세'}
          </span>
          {isDirty && (
            <span className="badge bg-amber-50 text-amber-700 border-amber-200 ml-1">
              수정 중
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <kbd className="hidden sm:inline-flex items-center px-1.5 py-0.5 rounded border border-ink-200 bg-canvas-50 text-2xs font-mono text-ink-500">
            ⌘S
          </kbd>
          <button
            onClick={() => saveMut.mutate()}
            disabled={!isDirty || saveMut.isPending}
            className={`btn-primary ${isDirty ? '' : 'opacity-50 cursor-not-allowed'}`}
          >
            <CheckIcon className="h-3 w-3 mr-1" />
            {saveMut.isPending ? '저장 중...' : '저장'}
          </button>
          <button onClick={onClose} className="btn-secondary" title="닫기 (Esc)">
            <XMarkIcon className="h-3 w-3" />
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="px-4 py-3 grid grid-cols-12 gap-3">
        {/* 차변/대변 + 금액 */}
        <div className="col-span-12 md:col-span-4">
          <label className="label">구분 / 금액</label>
          <div className="flex gap-1.5">
            <div className="flex bg-white border border-ink-200 rounded-md overflow-hidden">
              <button
                onClick={() => setDirection('debit')}
                className={`px-2.5 py-1.5 text-xs font-semibold flex items-center gap-1 transition ${
                  direction === 'debit'
                    ? 'bg-primary-600 text-white'
                    : 'text-ink-600 hover:bg-ink-50'
                }`}
              >
                <ArrowDownLeftIcon className="h-3 w-3" />
                차변
              </button>
              <button
                onClick={() => setDirection('credit')}
                className={`px-2.5 py-1.5 text-xs font-semibold flex items-center gap-1 transition ${
                  direction === 'credit'
                    ? 'bg-rose-600 text-white'
                    : 'text-ink-600 hover:bg-ink-50'
                }`}
              >
                <ArrowUpRightIcon className="h-3 w-3" />
                대변
              </button>
            </div>
            <input
              type="number"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="input text-right font-mono tabular-nums flex-1"
              placeholder="0"
            />
          </div>
          {Number(amount) > 0 && (
            <div className="text-2xs text-ink-400 mt-1 font-mono">
              {formatCurrency(Number(amount), false)} 원
            </div>
          )}
        </div>

        {/* 원장 계정 (이 거래가 속한 계정) */}
        <div className="col-span-12 md:col-span-4">
          <label className="label">
            원장 계정
            <span className="ml-1 text-2xs text-ink-400 font-normal">변경 시 다른 원장으로 이동</span>
          </label>
          <div className="flex gap-1.5">
            <input
              value={sourceCode}
              onChange={(e) => setSourceCode(e.target.value)}
              placeholder="103"
              className="input w-20 font-mono text-xs"
            />
            <input
              value={sourceName}
              onChange={(e) => setSourceName(e.target.value)}
              placeholder="보통예금"
              className="input flex-1"
            />
          </div>
        </div>

        {/* 상대 계정 */}
        <div className="col-span-12 md:col-span-4">
          <label className="label">
            <ArrowsRightLeftIcon className="h-3 w-3 inline mr-0.5" />
            상대 계정
          </label>
          <div className="flex gap-1.5">
            <input
              value={counterCode}
              onChange={(e) => setCounterCode(e.target.value)}
              placeholder="411"
              className="input w-20 font-mono text-xs"
            />
            <input
              value={counterName}
              onChange={(e) => setCounterName(e.target.value)}
              placeholder="제품매출"
              className="input flex-1"
            />
          </div>
        </div>

        {/* 거래처 */}
        <div className="col-span-12 md:col-span-4">
          <label className="label">거래처</label>
          <div className="flex gap-1.5">
            <input
              value={counterpartyCode}
              onChange={(e) => setCounterpartyCode(e.target.value)}
              placeholder="코드"
              className="input w-20 font-mono text-xs"
              title="거래처 코드 (선택)"
            />
            <input
              value={counterparty}
              onChange={(e) => setCounterparty(e.target.value)}
              placeholder="(주)이마트"
              className="input flex-1"
            />
          </div>
        </div>

        {/* 적요 */}
        <div className="col-span-12 md:col-span-8">
          <label className="label">적요</label>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="거래 적요"
            className="input"
          />
        </div>

        {/* T-account 시각화 */}
        <div className="col-span-12 mt-1">
          <div className="rounded-md border border-ink-200 bg-white overflow-hidden">
            <div className="grid grid-cols-2 divide-x divide-ink-200 text-2xs">
              <div className="px-3 py-2 bg-canvas-50 font-semibold text-ink-500 uppercase tracking-wider text-center">
                차변 (Debit)
              </div>
              <div className="px-3 py-2 bg-canvas-50 font-semibold text-ink-500 uppercase tracking-wider text-center">
                대변 (Credit)
              </div>
            </div>
            <div className="grid grid-cols-2 divide-x divide-ink-200">
              <div className="px-3 py-2.5">
                {direction === 'debit' ? (
                  <div className="flex items-center justify-between">
                    <span className="text-xs">
                      <span className="font-mono text-ink-400 mr-1.5">{sourceCode}</span>
                      <span className="font-medium text-ink-900">{sourceName}</span>
                    </span>
                    <span className="font-mono tabular-nums font-semibold text-primary-700">
                      {formatCurrency(Number(amount) || 0, false)}
                    </span>
                  </div>
                ) : counterCode ? (
                  <div className="flex items-center justify-between">
                    <span className="text-xs">
                      <span className="font-mono text-ink-400 mr-1.5">{counterCode}</span>
                      <span className="font-medium text-ink-900">{counterName}</span>
                    </span>
                    <span className="font-mono tabular-nums font-semibold text-primary-700">
                      {formatCurrency(Number(amount) || 0, false)}
                    </span>
                  </div>
                ) : (
                  <span className="text-2xs text-ink-300">-</span>
                )}
              </div>
              <div className="px-3 py-2.5">
                {direction === 'credit' ? (
                  <div className="flex items-center justify-between">
                    <span className="text-xs">
                      <span className="font-mono text-ink-400 mr-1.5">{sourceCode}</span>
                      <span className="font-medium text-ink-900">{sourceName}</span>
                    </span>
                    <span className="font-mono tabular-nums font-semibold text-rose-700">
                      {formatCurrency(Number(amount) || 0, false)}
                    </span>
                  </div>
                ) : counterCode ? (
                  <div className="flex items-center justify-between">
                    <span className="text-xs">
                      <span className="font-mono text-ink-400 mr-1.5">{counterCode}</span>
                      <span className="font-medium text-ink-900">{counterName}</span>
                    </span>
                    <span className="font-mono tabular-nums font-semibold text-rose-700">
                      {formatCurrency(Number(amount) || 0, false)}
                    </span>
                  </div>
                ) : (
                  <span className="text-2xs text-ink-300">-</span>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
