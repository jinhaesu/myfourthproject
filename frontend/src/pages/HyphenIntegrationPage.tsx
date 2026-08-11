import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import {
  BuildingLibraryIcon,
  TrashIcon,
  ClockIcon,
  CheckCircleIcon,
  ExclamationTriangleIcon,
  DocumentTextIcon,
  CreditCardIcon,
} from '@heroicons/react/24/outline'
import { hyphenApi, type HyphenCredential } from '@/services/api'
import { formatCurrency } from '@/utils/format'

// 하이픈 은행코드 (개발가이드 코드집)
const BANKS: { cd: string; name: string }[] = [
  { cd: '003', name: '기업은행' },
  { cd: '002', name: '산업은행' },
  { cd: '004', name: '국민은행' },
  { cd: '007', name: '수협은행' },
  { cd: '011', name: '농협은행' },
  { cd: '020', name: '우리은행' },
  { cd: '023', name: 'SC제일은행' },
  { cd: '027', name: '씨티은행' },
  { cd: '031', name: '대구은행' },
  { cd: '032', name: '부산은행' },
  { cd: '034', name: '광주은행' },
  { cd: '035', name: '제주은행' },
  { cd: '037', name: '전북은행' },
  { cd: '039', name: '경남은행' },
  { cd: '045', name: '새마을금고' },
  { cd: '048', name: '신협' },
  { cd: '071', name: '우체국' },
  { cd: '081', name: '하나은행' },
  { cd: '088', name: '신한은행' },
  { cd: '089', name: 'K뱅크' },
  { cd: '090', name: '카카오뱅크' },
  { cd: '092', name: '토스뱅크' },
  { cd: '105', name: '웰컴저축은행' },
]
const bankName = (cd: string) => BANKS.find((b) => b.cd === cd)?.name || cd

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => {
      const s = String(r.result || '')
      resolve(s.includes(',') ? s.split(',', 2)[1] : s)
    }
    r.onerror = reject
    r.readAsDataURL(file)
  })
}

export default function HyphenIntegrationPage() {
  const qc = useQueryClient()
  const [showForm, setShowForm] = useState(false)

  const healthQuery = useQuery({
    queryKey: ['hyphen-health'],
    queryFn: () => hyphenApi.health().then((r) => r.data),
    retry: false,
    staleTime: 60_000,
  })
  const credsQuery = useQuery({
    queryKey: ['hyphen-credentials'],
    queryFn: () => hyphenApi.listCredentials().then((r) => r.data.credentials),
    retry: false,
  })

  const delMut = useMutation({
    mutationFn: (id: number) => hyphenApi.deleteCredential(id),
    onSuccess: () => {
      toast.success('삭제되었습니다')
      qc.invalidateQueries({ queryKey: ['hyphen-credentials'] })
    },
    onError: () => toast.error('삭제 실패'),
  })

  const syncAllMut = useMutation({
    mutationFn: () => {
      const to = new Date()
      const from = new Date(); from.setDate(to.getDate() - 29)
      const iso = (d: Date) => d.toISOString().slice(0, 10)
      return hyphenApi.syncAll({ start_date: iso(from), end_date: iso(to) }).then((r) => r.data)
    },
    onSuccess: (d) => {
      toast.success(`${d.synced}개 계좌 동기화 완료`)
      qc.invalidateQueries({ queryKey: ['hyphen-credentials'] })
      qc.invalidateQueries({ queryKey: ['hyphen-tx-db'] })
    },
    onError: () => toast.error('전체 동기화 실패'),
  })

  const creds = credsQuery.data || []

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-end justify-between flex-wrap gap-2">
        <div>
          <h1>하이픈 은행연동</h1>
          <p className="text-2xs text-ink-500 dark:text-ink-400 mt-0.5">
            은행 로그인(기업뱅킹=공동인증서)하면 <b>전 계좌를 자동으로 불러와</b> 목록에서 선택해 등록합니다. 인증정보는 <b>암호화 보관·30일 후 자동삭제</b>됩니다.
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          {creds.length > 0 && (
            <button onClick={() => syncAllMut.mutate()} disabled={syncAllMut.isPending} className="btn-secondary">
              {syncAllMut.isPending ? '동기화 중…' : '전체 동기화'}
            </button>
          )}
          <button onClick={() => setShowForm(true)} className="btn-primary">
            <BuildingLibraryIcon className="h-3.5 w-3.5 mr-1" />
            계좌 등록
          </button>
        </div>
      </div>

      {/* 연결 상태 */}
      {healthQuery.data && (
        <div className="flex items-center gap-2 flex-wrap">
          {healthQuery.data.configured ? (
            <div className="rounded-md border border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950 px-3 py-1 flex items-center gap-2">
              <CheckCircleIcon className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
              <span className="text-2xs text-emerald-800 dark:text-emerald-200">하이픈 연결됨</span>
            </div>
          ) : (
            <div className="rounded-md border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950 px-3 py-1 flex items-center gap-2">
              <ExclamationTriangleIcon className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
              <span className="text-2xs text-amber-800 dark:text-amber-200">
                서버에 HYPHEN_USER_ID / HYPHEN_HKEY 미설정
              </span>
            </div>
          )}
        </div>
      )}

      {/* 등록된 계좌 */}
      <div className="panel">
        <div className="px-3 py-2 border-b border-ink-200 dark:border-ink-800 flex items-center gap-1.5 text-2xs font-semibold text-ink-700 dark:text-ink-300 uppercase tracking-wider">
          <BuildingLibraryIcon className="h-3.5 w-3.5" />
          등록된 계좌 ({creds.length})
        </div>
        <div className="p-2 space-y-2">
          {credsQuery.isLoading && <div className="text-2xs text-ink-400 px-2 py-3 text-center">불러오는 중…</div>}
          {!credsQuery.isLoading && creds.length === 0 && (
            <div className="text-2xs text-ink-400 px-2 py-6 text-center">
              등록된 계좌가 없습니다. 우측 상단 “계좌 등록”으로 추가하세요.
            </div>
          )}
          {creds.map((c) => (
            <CredentialCard
              key={c.id}
              cred={c}
              onDelete={() => { if (confirm('이 계좌 인증정보를 삭제할까요?')) delMut.mutate(c.id) }}
            />
          ))}
        </div>
      </div>

      {/* 홈택스 세금계산서 */}
      <TaxInvoicePanel />

      {/* 법인카드 */}
      <CardPanel />

      {showForm && (
        <IdLoginModal
          onClose={() => setShowForm(false)}
          onSaved={() => {
            setShowForm(false)
            qc.invalidateQueries({ queryKey: ['hyphen-credentials'] })
          }}
        />
      )}
    </div>
  )
}

function CredentialCard({ cred, onDelete }: { cred: HyphenCredential; onDelete: () => void }) {
  const qc = useQueryClient()
  const [range, setRange] = useState(() => {
    const to = new Date()
    const from = new Date(); from.setDate(to.getDate() - 29)
    const iso = (d: Date) => d.toISOString().slice(0, 10)
    return { from: iso(from), to: iso(to) }
  })

  // 로컬 원장(DB) 즉시 조회
  const dbQuery = useQuery({
    queryKey: ['hyphen-tx-db', cred.acct_no, range.from, range.to],
    queryFn: () => hyphenApi.transactionsDb({ start_date: range.from, end_date: range.to, acct_no: cred.acct_no }).then((r) => r.data),
    retry: false,
  })

  // 은행에서 가져와 DB 저장(동기화)
  const syncMut = useMutation({
    mutationFn: () => hyphenApi.sync(cred.id, { start_date: range.from, end_date: range.to }).then((r) => r.data),
    onSuccess: (d) => {
      if (!d.ok) { toast.error(`동기화 실패: ${d.error || ''}`); return }
      toast.success(`동기화 완료 · 신규 ${d.inserted}건 (${d.elapsed_sec}s)`)
      qc.invalidateQueries({ queryKey: ['hyphen-credentials'] })
      qc.invalidateQueries({ queryKey: ['hyphen-tx-db', cred.acct_no] })
    },
    onError: (e: any) => toast.error(e?.response?.data?.detail?.error || e?.response?.data?.detail || '동기화 실패'),
  })

  const expiring = cred.days_left <= 5
  const db = dbQuery.data
  const list: any[] = db?.transactions || []

  return (
    <div className={`rounded-md border p-2.5 ${cred.is_expired ? 'border-rose-300 dark:border-rose-800 bg-rose-50/50 dark:bg-rose-950/30' : 'border-ink-200 dark:border-ink-800'}`}>
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-ink-900 dark:text-ink-50 flex items-center gap-2">
            {cred.label || bankName(cred.bank_cd)}
            <span className="text-2xs font-mono text-ink-500 dark:text-ink-400">
              {bankName(cred.bank_cd)} ****{cred.acct_last4}
            </span>
            <span className="badge bg-ink-50 dark:bg-ink-900 text-ink-600 dark:text-ink-300 border-ink-200 dark:border-ink-800">
              {cred.login_method === 'CERT' ? '인증서' : '아이디'}
            </span>
          </div>
          <div className="text-2xs mt-1 flex items-center gap-2 flex-wrap">
            {cred.last_balance != null && (
              <span className="text-ink-700 dark:text-ink-200 font-mono">잔액 {formatCurrency(cred.last_balance, false)}</span>
            )}
            <span className="text-ink-400">· 마지막 동기화 {cred.last_synced_at ? new Date(cred.last_synced_at).toLocaleString('ko-KR') : '없음'}</span>
            <span className={`inline-flex items-center gap-1 ${expiring ? 'text-rose-600 dark:text-rose-400 font-semibold' : 'text-ink-500 dark:text-ink-400'}`}>
              <ClockIcon className="h-3 w-3" />
              {cred.is_expired ? '만료됨 — 재등록 필요' : `만료 D-${cred.days_left}`}
            </span>
          </div>
        </div>
        <button onClick={onDelete} className="btn-secondary text-rose-600 dark:text-rose-400" title="삭제">
          <TrashIcon className="h-3 w-3" />
        </button>
      </div>

      {/* 기간 + 동기화 */}
      <div className="mt-2 pt-2 border-t border-ink-100 dark:border-ink-800 flex items-center gap-1.5 flex-wrap">
        <input type="date" value={range.from} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))}
          className="bg-transparent border border-ink-200 dark:border-ink-800 rounded px-1.5 py-1 text-2xs" />
        <span className="text-ink-300">→</span>
        <input type="date" value={range.to} onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))}
          className="bg-transparent border border-ink-200 dark:border-ink-800 rounded px-1.5 py-1 text-2xs" />
        <button onClick={() => syncMut.mutate()} disabled={syncMut.isPending || cred.is_expired} className="btn-primary">
          {syncMut.isPending ? '은행에서 가져오는 중…' : '은행에서 동기화'}
        </button>
        <span className="text-2xs text-ink-400">
          원장 {db?.count ?? 0}건
          {db && ` · 입 ${formatCurrency(db.in_sum, false)} / 출 ${formatCurrency(db.out_sum, false)}`}
        </span>
      </div>

      {/* 로컬 원장(즉시) */}
      <div className="mt-2 max-h-64 overflow-y-auto border border-ink-100 dark:border-ink-800 rounded">
        <table className="min-w-full text-2xs">
          <thead className="bg-canvas-50 dark:bg-ink-950 sticky top-0">
            <tr>
              <th className="px-2 py-1 text-left font-semibold text-ink-500">일자</th>
              <th className="px-2 py-1 text-left font-semibold text-ink-500">적요</th>
              <th className="px-2 py-1 text-right font-semibold text-ink-500">입금</th>
              <th className="px-2 py-1 text-right font-semibold text-ink-500">출금</th>
              <th className="px-2 py-1 text-right font-semibold text-ink-500">잔액</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100 dark:divide-ink-800">
            {list.map((row, i) => (
              <tr key={i}>
                <td className="px-2 py-1 font-mono whitespace-nowrap text-ink-500">{row.tr_date} {row.tr_time}</td>
                <td className="px-2 py-1 truncate max-w-[180px]">{row.tr_name || row.counterparty_name}</td>
                <td className="px-2 py-1 text-right font-mono text-emerald-700 dark:text-emerald-300">
                  {row.in_amt > 0 ? formatCurrency(row.in_amt, false) : ''}
                </td>
                <td className="px-2 py-1 text-right font-mono text-rose-700 dark:text-rose-300">
                  {row.out_amt > 0 ? formatCurrency(row.out_amt, false) : ''}
                </td>
                <td className="px-2 py-1 text-right font-mono text-ink-700 dark:text-ink-300">
                  {row.balance != null ? formatCurrency(row.balance, false) : ''}
                </td>
              </tr>
            ))}
            {list.length === 0 && (
              <tr><td colSpan={5} className="px-2 py-4 text-center text-ink-400">
                {dbQuery.isLoading ? '불러오는 중…' : '원장이 비어 있습니다. "은행에서 동기화"를 누르세요.'}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function IdLoginModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [step, setStep] = useState<'login' | 'select'>('login')
  const [method, setMethod] = useState<'CERT' | 'ID'>('CERT')
  const [form, setForm] = useState({ bank_cd: '003', user_id: '', user_pw: '', acct_pw: '', sign_pw: '' })
  const [certB64, setCertB64] = useState('')
  const [keyB64, setKeyB64] = useState('')
  const [gustation, setGustation] = useState(false)
  const [accounts, setAccounts] = useState<{ acctNo: string; acctNm: string; acctHolder: string; balance: string; curCd: string }[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const commonBody = () =>
    method === 'CERT'
      ? { bank_cd: form.bank_cd, login_method: 'CERT', sign_cert_b64: certB64, sign_pri_b64: keyB64, sign_pw: form.sign_pw, acct_pw: form.acct_pw || undefined }
      : { bank_cd: form.bank_cd, login_method: 'ID', user_id: form.user_id, user_pw: form.user_pw, acct_pw: form.acct_pw || undefined }

  const loadMut = useMutation({
    mutationFn: () => hyphenApi.listAccounts({ ...commonBody(), gustation }).then((r) => r.data),
    onSuccess: (d) => {
      setAccounts(d.accounts || [])
      setSelected(new Set((d.accounts || []).map((a) => a.acctNo)))
      setStep('select')
      if (!d.accounts?.length) toast('계좌가 조회되지 않았습니다. 정보를 확인하세요.', { icon: '⚠️' })
    },
    onError: (e: any) => toast.error(e?.response?.data?.detail?.error || e?.response?.data?.detail || '계좌 조회 실패'),
  })

  const saveMut = useMutation({
    mutationFn: async () => {
      const chosen = accounts.filter((a) => selected.has(a.acctNo))
      const base = commonBody()
      await Promise.all(chosen.map((a) =>
        hyphenApi.registerCredential({
          ...base,
          acct_no: a.acctNo.replace(/\D/g, ''),
          label: a.acctNm || `${bankName(form.bank_cd)}(${a.acctNo.slice(-4)})`,
        } as any),
      ))
      return chosen.length
    },
    onSuccess: (n) => { toast.success(`${n}개 계좌가 암호화 등록되었습니다 (30일 유효)`); onSaved() },
    onError: (e: any) => toast.error(e?.response?.data?.detail || '등록 실패'),
  })

  const toggle = (acctNo: string) => setSelected((prev) => {
    const next = new Set(prev)
    if (next.has(acctNo)) next.delete(acctNo); else next.add(acctNo)
    return next
  })

  const canLoad = form.bank_cd && (method === 'CERT' ? certB64 && keyB64 && form.sign_pw : form.user_id && form.user_pw)

  return (
    <div className="fixed inset-0 z-50 bg-ink-900/40 flex items-center justify-center p-4">
      <div className="bg-white dark:bg-ink-900 rounded-lg shadow-pop w-full max-w-lg max-h-[85vh] overflow-y-auto border border-ink-200 dark:border-ink-800">
        <div className="sticky top-0 bg-white dark:bg-ink-900 border-b border-ink-200 dark:border-ink-800 px-4 py-2.5 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-ink-900 dark:text-ink-50">
            {step === 'login' ? '은행 로그인' : '등록할 계좌 선택'}
          </h3>
          <button onClick={onClose} className="text-ink-400 hover:text-ink-700 dark:hover:text-ink-200 text-lg leading-none">×</button>
        </div>

        {step === 'login' ? (
          <div className="p-4 space-y-3">
            <div className="rounded-md bg-blue-50 dark:bg-blue-950 border border-blue-200 dark:border-blue-800 px-3 py-2 text-2xs text-blue-800 dark:text-blue-200">
              로그인하면 전 계좌를 불러옵니다. 입력정보는 <b>AES-256 암호화</b> 저장되고 <b>30일 후 자동 삭제</b>됩니다.
            </div>
            <div className="grid grid-cols-2 gap-2">
              <label className="text-2xs text-ink-600 dark:text-ink-400">
                은행
                <select value={form.bank_cd} onChange={(e) => setForm((f) => ({ ...f, bank_cd: e.target.value }))}
                  className="mt-1 w-full border border-ink-200 dark:border-ink-800 rounded px-2 py-1.5 text-xs bg-transparent">
                  {BANKS.map((b) => <option key={b.cd} value={b.cd}>{b.name} ({b.cd})</option>)}
                </select>
              </label>
              <label className="text-2xs text-ink-600 dark:text-ink-400">
                로그인 방식
                <select value={method} onChange={(e) => setMethod(e.target.value as 'CERT' | 'ID')}
                  className="mt-1 w-full border border-ink-200 dark:border-ink-800 rounded px-2 py-1.5 text-xs bg-transparent">
                  <option value="CERT">공동인증서 (기업뱅킹 권장)</option>
                  <option value="ID">아이디 로그인</option>
                </select>
              </label>
            </div>

            {method === 'CERT' ? (
              <>
                <div className="rounded-md bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-800 px-3 py-2 text-2xs text-amber-800 dark:text-amber-200">
                  인증서 파일은 <b>바탕화면 → 하이픈_IBK인증서</b> 폴더에 준비해 두었습니다. 아래에서 그 폴더의 <code>signCert.der</code>, <code>signPri.key</code>를 선택하세요.
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <label className="text-2xs text-ink-600 dark:text-ink-400">
                    인증서 (signCert.der)
                    <input type="file" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setCertB64(await fileToBase64(f)) }}
                      className="mt-1 w-full text-2xs file:mr-2 file:text-2xs file:border-0 file:bg-ink-100 dark:file:bg-ink-800 file:px-2 file:py-1 file:rounded" />
                    {certB64 && <span className="text-emerald-600 dark:text-emerald-400">✓ 첨부됨</span>}
                  </label>
                  <label className="text-2xs text-ink-600 dark:text-ink-400">
                    개인키 (signPri.key)
                    <input type="file" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setKeyB64(await fileToBase64(f)) }}
                      className="mt-1 w-full text-2xs file:mr-2 file:text-2xs file:border-0 file:bg-ink-100 dark:file:bg-ink-800 file:px-2 file:py-1 file:rounded" />
                    {keyB64 && <span className="text-emerald-600 dark:text-emerald-400">✓ 첨부됨</span>}
                  </label>
                </div>
                <label className="block text-2xs text-ink-600 dark:text-ink-400">
                  인증서 비밀번호
                  <input type="password" value={form.sign_pw} onChange={(e) => setForm((f) => ({ ...f, sign_pw: e.target.value }))}
                    className="mt-1 w-full border border-ink-200 dark:border-ink-800 rounded px-2 py-1.5 text-xs bg-transparent" />
                </label>
              </>
            ) : (
              <>
                <label className="block text-2xs text-ink-600 dark:text-ink-400">
                  인터넷뱅킹 아이디
                  <input value={form.user_id} onChange={(e) => setForm((f) => ({ ...f, user_id: e.target.value }))}
                    className="mt-1 w-full border border-ink-200 dark:border-ink-800 rounded px-2 py-1.5 text-xs bg-transparent" />
                </label>
                <label className="block text-2xs text-ink-600 dark:text-ink-400">
                  인터넷뱅킹 비밀번호
                  <input type="password" value={form.user_pw} onChange={(e) => setForm((f) => ({ ...f, user_pw: e.target.value }))}
                    className="mt-1 w-full border border-ink-200 dark:border-ink-800 rounded px-2 py-1.5 text-xs bg-transparent" />
                </label>
              </>
            )}

            <label className="block text-2xs text-ink-600 dark:text-ink-400">
              계좌 비밀번호 <span className="text-ink-400">(거래내역 조회 시 필요할 수 있음 · 선택)</span>
              <input type="password" value={form.acct_pw} onChange={(e) => setForm((f) => ({ ...f, acct_pw: e.target.value }))}
                placeholder="4자리" className="mt-1 w-full border border-ink-200 dark:border-ink-800 rounded px-2 py-1.5 text-xs bg-transparent" />
            </label>
            <label className="flex items-center gap-1.5 text-2xs text-ink-500 dark:text-ink-400 cursor-pointer">
              <input type="checkbox" checked={gustation} onChange={(e) => setGustation(e.target.checked)} className="w-3 h-3" />
              테스트베드(무료·실계좌 조회 안 함)
            </label>
            <div className="flex items-center justify-end gap-2 pt-1">
              <button onClick={onClose} className="btn-secondary">취소</button>
              <button onClick={() => loadMut.mutate()} disabled={!canLoad || loadMut.isPending} className="btn-primary">
                {loadMut.isPending ? '계좌 불러오는 중…' : '계좌 불러오기'}
              </button>
            </div>
          </div>
        ) : (
          <div className="p-4 space-y-3">
            <div className="text-2xs text-ink-500 dark:text-ink-400">
              {bankName(form.bank_cd)} · {accounts.length}개 계좌 조회됨 · 추적할 계좌를 선택하세요.
            </div>
            <div className="space-y-1.5 max-h-72 overflow-y-auto">
              {accounts.map((a) => (
                <label key={a.acctNo} className="flex items-center gap-2 px-2 py-1.5 rounded border border-ink-100 dark:border-ink-800 cursor-pointer hover:bg-ink-50 dark:hover:bg-ink-800">
                  <input type="checkbox" checked={selected.has(a.acctNo)} onChange={() => toggle(a.acctNo)} className="w-3.5 h-3.5" />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium text-ink-900 dark:text-ink-50 truncate">{a.acctNm || '계좌'}</div>
                    <div className="text-2xs text-ink-400 font-mono">{a.acctNo} {a.acctHolder && `· ${a.acctHolder}`}</div>
                  </div>
                  {a.balance !== '' && (
                    <div className="text-2xs font-mono text-ink-700 dark:text-ink-300">{formatCurrency(Number(a.balance) || 0, false)}</div>
                  )}
                </label>
              ))}
              {accounts.length === 0 && <div className="text-2xs text-ink-400 text-center py-6">조회된 계좌가 없습니다.</div>}
            </div>
            <div className="flex items-center justify-between gap-2 pt-1">
              <button onClick={() => setStep('login')} className="btn-secondary">← 다시 로그인</button>
              <button
                onClick={() => saveMut.mutate()}
                disabled={selected.size === 0 || saveMut.isPending}
                className="btn-primary"
              >
                {saveMut.isPending ? '등록 중…' : `선택 ${selected.size}개 계좌 등록`}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

const CARD_CODES: { cd: string; name: string }[] = [
  { cd: '001', name: '신한카드' }, { cd: '002', name: '현대카드' }, { cd: '003', name: '삼성카드' },
  { cd: '004', name: 'KB국민카드' }, { cd: '005', name: '롯데카드' }, { cd: '006', name: '하나카드' },
  { cd: '007', name: '우리카드' }, { cd: '008', name: '농협카드' }, { cd: '009', name: '씨티카드' },
  { cd: '010', name: 'BC카드' }, { cd: '011', name: '수협카드' }, { cd: '012', name: '광주카드' },
  { cd: '013', name: '전북카드' }, { cd: '014', name: '제주카드' },
]
const cardName = (cd: string) => CARD_CODES.find((c) => c.cd === cd)?.name || cd

function last3mRange() {
  const to = new Date(); const from = new Date(); from.setMonth(to.getMonth() - 3)
  const iso = (d: Date) => d.toISOString().slice(0, 10)
  return { from: iso(from), to: iso(to) }
}

function TaxInvoicePanel() {
  const qc = useQueryClient()
  const [range, setRange] = useState(last3mRange)
  const q = useQuery({
    queryKey: ['hyphen-tax', range.from, range.to],
    queryFn: () => hyphenApi.taxInvoices({ start_date: range.from, end_date: range.to }).then((r) => r.data),
    retry: false,
  })
  const syncMut = useMutation({
    mutationFn: () => hyphenApi.taxSync({ start_date: range.from, end_date: range.to }).then((r) => r.data),
    onSuccess: (d) => {
      if (!d.ok) { toast.error(d.error || '동기화 실패'); return }
      toast.success(`세금계산서 동기화 · 신규 ${d.inserted}건`)
      qc.invalidateQueries({ queryKey: ['hyphen-tax'] })
    },
    onError: (e: any) => toast.error(e?.response?.data?.detail?.error || '동기화 실패'),
  })
  const d = q.data
  const list: any[] = d?.invoices || []
  return (
    <div className="panel p-3">
      <div className="text-2xs font-semibold text-ink-700 dark:text-ink-300 uppercase tracking-wider flex items-center gap-1.5 mb-2">
        <DocumentTextIcon className="h-3.5 w-3.5" />홈택스 세금계산서 (법인 인증서 재사용)
      </div>
      <div className="flex items-center gap-1.5 flex-wrap mb-2">
        <input type="date" value={range.from} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))}
          className="bg-transparent border border-ink-200 dark:border-ink-800 rounded px-1.5 py-1 text-2xs" />
        <span className="text-ink-300">→</span>
        <input type="date" value={range.to} onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))}
          className="bg-transparent border border-ink-200 dark:border-ink-800 rounded px-1.5 py-1 text-2xs" />
        <button onClick={() => syncMut.mutate()} disabled={syncMut.isPending} className="btn-primary">
          {syncMut.isPending ? '홈택스에서 가져오는 중…' : '홈택스 동기화'}
        </button>
        {d && (
          <span className="text-2xs text-ink-500 dark:text-ink-400">
            {d.count}건 · 매출 <span className="text-emerald-700 dark:text-emerald-300 font-mono">{formatCurrency(d.sales_amount, false)}</span>
            {' · '}매입 <span className="text-rose-700 dark:text-rose-300 font-mono">{formatCurrency(d.purchase_amount, false)}</span>
          </span>
        )}
      </div>
      <div className="max-h-64 overflow-y-auto border border-ink-100 dark:border-ink-800 rounded">
        <table className="min-w-full text-2xs">
          <thead className="bg-canvas-50 dark:bg-ink-950 sticky top-0">
            <tr>
              <th className="px-2 py-1 text-left font-semibold text-ink-500">발행일</th>
              <th className="px-2 py-1 text-center font-semibold text-ink-500">구분</th>
              <th className="px-2 py-1 text-left font-semibold text-ink-500">거래처</th>
              <th className="px-2 py-1 text-right font-semibold text-ink-500">공급가</th>
              <th className="px-2 py-1 text-right font-semibold text-ink-500">세액</th>
              <th className="px-2 py-1 text-right font-semibold text-ink-500">합계</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100 dark:divide-ink-800">
            {list.slice(0, 300).map((r, i) => (
              <tr key={i}>
                <td className="px-2 py-1 font-mono whitespace-nowrap text-ink-500">{r.issue_dt}</td>
                <td className="px-2 py-1 text-center">
                  <span className={r.sup_byr === '01' ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}>
                    {r.sup_byr === '01' ? '매출' : '매입'}
                  </span>
                </td>
                <td className="px-2 py-1 truncate max-w-[180px]">{r.counterparty}</td>
                <td className="px-2 py-1 text-right font-mono">{formatCurrency(r.sup_amt, false)}</td>
                <td className="px-2 py-1 text-right font-mono text-ink-500">{formatCurrency(r.tax_amt, false)}</td>
                <td className="px-2 py-1 text-right font-mono font-semibold">{formatCurrency(r.tot_amt, false)}</td>
              </tr>
            ))}
            {list.length === 0 && (
              <tr><td colSpan={6} className="px-2 py-4 text-center text-ink-400">
                {q.isLoading ? '불러오는 중…' : '원장이 비어 있습니다. “홈택스 동기화”를 누르세요.'}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function CardPanel() {
  const qc = useQueryClient()
  const [range, setRange] = useState(last3mRange)
  const [form, setForm] = useState({ card_cd: '001', card_no: '', label: '', login_method: 'CERT', user_id: '', user_pw: '' })
  const cardsQ = useQuery({ queryKey: ['hyphen-cards'], queryFn: () => hyphenApi.listCards().then((r) => r.data.cards), retry: false })
  const txQ = useQuery({
    queryKey: ['hyphen-card-tx', range.from, range.to],
    queryFn: () => hyphenApi.cardTx({ start_date: range.from, end_date: range.to }).then((r) => r.data),
    retry: false,
  })
  const regMut = useMutation({
    mutationFn: () => hyphenApi.registerCard({
      card_cd: form.card_cd, card_no: form.card_no.replace(/\D/g, ''), label: form.label || undefined,
      login_method: form.login_method,
      user_id: form.login_method === 'ID' ? form.user_id : undefined,
      user_pw: form.login_method === 'ID' ? form.user_pw : undefined,
    }).then((r) => r.data),
    onSuccess: () => { toast.success('카드 등록됨'); setForm((f) => ({ ...f, card_no: '', label: '' })); qc.invalidateQueries({ queryKey: ['hyphen-cards'] }) },
    onError: () => toast.error('카드 등록 실패'),
  })
  const delMut = useMutation({
    mutationFn: (id: number) => hyphenApi.deleteCard(id),
    onSuccess: () => { toast.success('삭제됨'); qc.invalidateQueries({ queryKey: ['hyphen-cards'] }) },
  })
  const syncMut = useMutation({
    mutationFn: () => hyphenApi.cardsSync({ start_date: range.from, end_date: range.to }).then((r) => r.data),
    onSuccess: (d) => { toast.success(`카드 동기화 · 신규 ${d.inserted}건`); qc.invalidateQueries({ queryKey: ['hyphen-card-tx'] }); qc.invalidateQueries({ queryKey: ['hyphen-cards'] }) },
    onError: () => toast.error('카드 동기화 실패'),
  })
  const cards = cardsQ.data || []
  const list: any[] = txQ.data?.transactions || []
  const isCert = form.login_method === 'CERT'
  return (
    <div className="panel p-3">
      <div className="text-2xs font-semibold text-ink-700 dark:text-ink-300 uppercase tracking-wider flex items-center gap-1.5 mb-2">
        <CreditCardIcon className="h-3.5 w-3.5" />법인카드 연동 (인증서 재사용 또는 카드사 아이디)
      </div>
      <div className="flex items-end gap-1.5 flex-wrap mb-2">
        <label className="text-2xs text-ink-500">카드사
          <select value={form.card_cd} onChange={(e) => setForm((f) => ({ ...f, card_cd: e.target.value }))}
            className="mt-0.5 block border border-ink-200 dark:border-ink-800 rounded px-1.5 py-1 text-2xs bg-transparent">
            {CARD_CODES.map((c) => <option key={c.cd} value={c.cd}>{c.name}</option>)}
          </select>
        </label>
        <label className="text-2xs text-ink-500">카드번호
          <input value={form.card_no} onChange={(e) => setForm((f) => ({ ...f, card_no: e.target.value }))}
            placeholder="숫자만" className="mt-0.5 block border border-ink-200 dark:border-ink-800 rounded px-1.5 py-1 text-2xs bg-transparent font-mono w-40" />
        </label>
        <label className="text-2xs text-ink-500">별명
          <input value={form.label} onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
            className="mt-0.5 block border border-ink-200 dark:border-ink-800 rounded px-1.5 py-1 text-2xs bg-transparent w-28" />
        </label>
        <label className="text-2xs text-ink-500">로그인
          <select value={form.login_method} onChange={(e) => setForm((f) => ({ ...f, login_method: e.target.value }))}
            className="mt-0.5 block border border-ink-200 dark:border-ink-800 rounded px-1.5 py-1 text-2xs bg-transparent">
            <option value="CERT">공동인증서</option>
            <option value="ID">카드사 아이디</option>
          </select>
        </label>
        {!isCert && (
          <>
            <input value={form.user_id} onChange={(e) => setForm((f) => ({ ...f, user_id: e.target.value }))}
              placeholder="카드사 아이디" className="border border-ink-200 dark:border-ink-800 rounded px-1.5 py-1 text-2xs bg-transparent w-28" />
            <input type="password" value={form.user_pw} onChange={(e) => setForm((f) => ({ ...f, user_pw: e.target.value }))}
              placeholder="비밀번호" className="border border-ink-200 dark:border-ink-800 rounded px-1.5 py-1 text-2xs bg-transparent w-28" />
          </>
        )}
        <button onClick={() => regMut.mutate()} disabled={!form.card_no || regMut.isPending} className="btn-secondary">카드 등록</button>
      </div>
      {cards.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {cards.map((c) => (
            <span key={c.id} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-2xs border border-ink-200 dark:border-ink-800">
              {cardName(c.card_cd)} {c.card_no.slice(-4)} {c.label && `· ${c.label}`}
              <button onClick={() => delMut.mutate(c.id)} className="text-rose-500 ml-0.5">×</button>
            </span>
          ))}
        </div>
      )}
      <div className="flex items-center gap-1.5 flex-wrap mb-2">
        <input type="date" value={range.from} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))}
          className="bg-transparent border border-ink-200 dark:border-ink-800 rounded px-1.5 py-1 text-2xs" />
        <span className="text-ink-300">→</span>
        <input type="date" value={range.to} onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))}
          className="bg-transparent border border-ink-200 dark:border-ink-800 rounded px-1.5 py-1 text-2xs" />
        <button onClick={() => syncMut.mutate()} disabled={syncMut.isPending || cards.length === 0} className="btn-primary">
          {syncMut.isPending ? '카드사에서 가져오는 중…' : '카드 동기화'}
        </button>
        {txQ.data && <span className="text-2xs text-ink-500 dark:text-ink-400">{txQ.data.count}건 · 합계 <span className="font-mono">{formatCurrency(txQ.data.total, false)}</span></span>}
      </div>
      <div className="max-h-64 overflow-y-auto border border-ink-100 dark:border-ink-800 rounded">
        <table className="min-w-full text-2xs">
          <thead className="bg-canvas-50 dark:bg-ink-950 sticky top-0">
            <tr>
              <th className="px-2 py-1 text-left font-semibold text-ink-500">일시</th>
              <th className="px-2 py-1 text-left font-semibold text-ink-500">카드</th>
              <th className="px-2 py-1 text-left font-semibold text-ink-500">가맹점</th>
              <th className="px-2 py-1 text-right font-semibold text-ink-500">금액</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100 dark:divide-ink-800">
            {list.slice(0, 300).map((r, i) => (
              <tr key={i}>
                <td className="px-2 py-1 font-mono whitespace-nowrap text-ink-500">{r.use_dt} {r.use_tm}</td>
                <td className="px-2 py-1 font-mono text-ink-400">{cardName(r.card_cd)} {String(r.card_no).slice(-4)}</td>
                <td className="px-2 py-1 truncate max-w-[180px]">{r.use_store}</td>
                <td className="px-2 py-1 text-right font-mono font-semibold text-rose-700 dark:text-rose-300">{formatCurrency(r.use_amt, false)}</td>
              </tr>
            ))}
            {list.length === 0 && (
              <tr><td colSpan={4} className="px-2 py-4 text-center text-ink-400">
                {cards.length === 0 ? '카드를 먼저 등록하세요.' : (txQ.isLoading ? '불러오는 중…' : '원장이 비어 있습니다. “카드 동기화”를 누르세요.')}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
