import { useState } from 'react'
import type { CardVatInfo } from '@/services/api'

const DEDUCT_STYLE: Record<string, string> = {
  '공제': 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800',
  '불공제': 'bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 border-red-200 dark:border-red-800',
  '확인필요': 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800',
  '부가세 대상 아님': 'bg-ink-100 dark:bg-ink-800 text-ink-500 dark:text-ink-400 border-ink-200 dark:border-ink-700',
}
const NONVAT = '부가세 대상 아님'

/** 사업자등록번호 10자리 체크섬 */
export function validBizNo(v: string): boolean {
  const d = v.replace(/\D/g, '')
  if (d.length !== 10) return false
  const w = [1, 3, 7, 1, 3, 7, 1, 3, 5]
  let s = 0
  for (let i = 0; i < 9; i++) s += Number(d[i]) * w[i]
  s += Math.floor((Number(d[8]) * 5) / 10)
  return (10 - (s % 10)) % 10 === Number(d[9])
}

interface Props {
  bizNo?: string | null
  src?: string | null
  vat?: CardVatInfo
  /** 번호 입력 가능 여부(배정 카드 직원 / 관리자). 저장은 서버가 권한을 다시 검증 */
  editable?: boolean
  isAdmin?: boolean
  onSave?: (bizNo: string) => Promise<void>
  onClear?: () => Promise<void>
}

/** 가맹점 사업자번호 + 과세유형/공제 배지 (부가세 공제 참고 - 자동판정). 번호 없으면 입력칸(또는 확인필요). */
export default function CardBizInfo({ bizNo, src, vat, editable, isAdmin, onSave, onClear }: Props) {
  const [editing, setEditing] = useState(false)
  const [val, setVal] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const nonvat = vat?.deduct === NONVAT
  const tip = vat ? `부가세 공제 참고(자동판정): ${vat.deduct}\n${vat.reason}${vat.tax_kind_src ? `\n과세유형 출처: ${vat.tax_kind_src}` : ''}${vat.status ? `\n사업 상태: ${vat.status}` : ''}` : ''
  const canEdit = !!editable && !!onSave && !nonvat
  const showInput = canEdit && (editing || !bizNo)

  const save = async () => {
    if (!validBizNo(val)) { setErr('사업자번호 형식/체크섬 오류'); return }
    setBusy(true); setErr('')
    try { await onSave!(val.replace(/\D/g, '')); setEditing(false); setVal('') }
    catch (e: any) { setErr(e?.response?.data?.detail || '저장 실패') }
    finally { setBusy(false) }
  }

  return (
    <div className="mt-0.5" onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center gap-1 flex-wrap" title={tip}>
        {bizNo
          ? <span className="font-mono text-2xs text-ink-500 dark:text-ink-400">{bizNo}
              {src === 'inferred' && <span className="ml-0.5 text-amber-600 dark:text-amber-400" title="동일 가맹점명 기준 추정값">?</span>}
              {src === 'manual' && <span className="ml-0.5 text-blue-600 dark:text-blue-400" title="수동 입력값">✎</span>}
            </span>
          : nonvat
            ? <span className="text-2xs text-ink-400">—</span>
            : <span className="text-2xs font-medium text-amber-600 dark:text-amber-400">확인필요</span>}
        {vat && vat.tax_kind && vat.tax_kind !== '미확인' && vat.tax_kind !== '해당없음' && (
          <span className="px-1 rounded border border-ink-200 dark:border-ink-700 text-2xs text-ink-500 dark:text-ink-400">{vat.tax_kind.replace('과세자', '').replace('사업자', '')}</span>
        )}
        {vat && (
          <span className={`px-1 rounded border text-2xs font-medium cursor-help ${DEDUCT_STYLE[vat.deduct] || ''}`}>{vat.deduct}</span>
        )}
        {canEdit && bizNo && !editing && src === 'manual' && isAdmin && (
          <>
            <button className="text-2xs text-ink-400 hover:text-blue-600" onClick={() => { setEditing(true); setVal(bizNo) }}>수정</button>
            {onClear && <button className="text-2xs text-ink-400 hover:text-red-600"
              onClick={async () => { if (window.confirm('같은 가맹점명의 수동 입력을 모두 해제할까요?')) await onClear() }}>해제</button>}
          </>
        )}
      </div>
      {showInput && (
        <div className="flex items-center gap-1 mt-0.5">
          <input value={val} onChange={(e) => { setVal(e.target.value); setErr('') }}
            onKeyDown={(e) => { if (e.key === 'Enter') save() }}
            placeholder="000-00-00000" inputMode="numeric" maxLength={12}
            className="w-28 px-1 py-0.5 text-2xs font-mono rounded border border-ink-300 dark:border-ink-700 bg-white dark:bg-ink-900 text-ink-900 dark:text-ink-50 focus:outline-none focus:border-blue-400" />
          <button onClick={save} disabled={busy || !val.trim()}
            className="px-1.5 py-0.5 text-2xs rounded bg-blue-500 text-white font-medium hover:bg-blue-600 disabled:opacity-40">{busy ? '…' : '저장'}</button>
          {editing && <button className="text-2xs text-ink-400" onClick={() => { setEditing(false); setErr('') }}>취소</button>}
          {err && <span className="text-2xs text-red-500">{err}</span>}
        </div>
      )}
    </div>
  )
}
