import type { CardVatInfo } from '@/services/api'

const DEDUCT_STYLE: Record<string, string> = {
  '공제': 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800',
  '불공제': 'bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 border-red-200 dark:border-red-800',
  '확인필요': 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800',
}

/** 가맹점 사업자번호 + 과세유형/공제 배지 (부가세 공제 참고 - 자동판정). 번호 없으면 "—". */
export default function CardBizInfo({ bizNo, src, vat }: { bizNo?: string | null; src?: string | null; vat?: CardVatInfo }) {
  const tip = vat ? `부가세 공제 참고(자동판정): ${vat.deduct}\n${vat.reason}${vat.tax_kind_src ? `\n과세유형 출처: ${vat.tax_kind_src}` : ''}${vat.status ? `\n사업 상태: ${vat.status}` : ''}` : ''
  return (
    <div className="flex items-center gap-1 flex-wrap mt-0.5" title={tip}>
      {bizNo
        ? <span className="font-mono text-2xs text-ink-500 dark:text-ink-400">{bizNo}{src === 'inferred' && <span className="ml-0.5 text-amber-600 dark:text-amber-400" title="동일 가맹점명 기준 추정값">?</span>}</span>
        : <span className="text-2xs font-medium text-amber-600 dark:text-amber-400">확인필요</span>}
      {vat && vat.tax_kind && vat.tax_kind !== '미확인' && (
        <span className="px-1 rounded border border-ink-200 dark:border-ink-700 text-2xs text-ink-500 dark:text-ink-400">{vat.tax_kind.replace('과세자', '').replace('사업자', '')}</span>
      )}
      {vat && (
        <span className={`px-1 rounded border text-2xs font-medium cursor-help ${DEDUCT_STYLE[vat.deduct] || ''}`}>{vat.deduct}</span>
      )}
    </div>
  )
}
