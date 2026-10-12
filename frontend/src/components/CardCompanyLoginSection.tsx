import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { hyphenApi } from '@/services/api'

const COMPANIES: { cd: string; nm: string }[] = [
  { cd: '010', nm: 'BC카드' }, { cd: '006', nm: '하나카드' }, { cd: '001', nm: '신한카드' },
  { cd: '002', nm: '현대카드' }, { cd: '003', nm: '삼성카드' }, { cd: '004', nm: 'KB국민카드' },
  { cd: '005', nm: '롯데카드' }, { cd: '007', nm: '우리카드' }, { cd: '008', nm: '농협카드' },
]

/** 카드사 매입내역 로그인(사업자번호용) - 관리자 전용 패널(하이픈 연동 페이지는 이미 관리자 전용).
 *  카드 등록/삭제와 무관: 로그인 정보만 암호화 저장하고, 비밀번호는 다시 표시하지 않는다. */
export default function CardCompanyLoginSection() {
  const qc = useQueryClient()
  const [cd, setCd] = useState('010')
  const [uid, setUid] = useState('')
  const [pw, setPw] = useState('')
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)

  const q = useQuery({ queryKey: ['hyphen-card-login'], queryFn: () => hyphenApi.cardLoginStatus().then((r) => r.data.logins) })
  const saved = (q.data || []).find((l) => l.card_cd === cd)

  const testMut = useMutation({
    mutationFn: () => hyphenApi.testCardLogin(cd).then((r) => r.data),
    onSuccess: (d) => setResult(d.ok
      ? { ok: true, text: `성공 · 카드 ${d.card_last4} 최근 30일 ${d.rows}건 중 사업자번호 포함 ${d.with_biz_no}건 (하이픈 1콜)` }
      : { ok: false, text: `실패 · ${d.error || '알 수 없는 오류'}` }),
    onError: (e: any) => setResult({ ok: false, text: e.response?.data?.detail || '시험 조회 실패' }),
  })
  const saveMut = useMutation({
    mutationFn: () => hyphenApi.saveCardLogin({ card_cd: cd, user_id: uid, user_pw: pw }),
    onSuccess: () => {
      setUid(''); setPw('')   // 입력값은 즉시 비움
      qc.invalidateQueries({ queryKey: ['hyphen-card-login'] })
      toast.success('저장했습니다. 시험 조회를 진행합니다.')
      setResult(null)
      testMut.mutate()
    },
    onError: (e: any) => toast.error(e.response?.data?.detail || '저장 실패'),
  })

  return (
    <div className="mb-3 p-2 rounded border border-ink-200 dark:border-ink-800">
      <div className="text-2xs font-semibold text-ink-700 dark:text-ink-200 mb-1">카드사 매입내역 로그인 (사업자번호용)</div>
      <div className="text-2xs text-ink-500 dark:text-ink-400 mb-1.5">
        카드사 기업회원 아이디로 매입내역(가맹점 사업자번호)을 조회합니다. 승인내역 동기화는 기존 인증서 로그인을 그대로 사용합니다.
      </div>
      <div className="flex items-center gap-1.5 flex-wrap">
        <select value={cd} onChange={(e) => { setCd(e.target.value); setResult(null) }}
          className="bg-transparent border border-ink-200 dark:border-ink-800 rounded px-1.5 py-1 text-2xs">
          {COMPANIES.map((c) => <option key={c.cd} value={c.cd} className="bg-white dark:bg-ink-900">{c.nm}</option>)}
        </select>
        <input value={uid} onChange={(e) => setUid(e.target.value)} placeholder="아이디" autoComplete="off"
          className="bg-transparent border border-ink-200 dark:border-ink-800 rounded px-1.5 py-1 text-2xs w-32" />
        <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="비밀번호" autoComplete="new-password"
          className="bg-transparent border border-ink-200 dark:border-ink-800 rounded px-1.5 py-1 text-2xs w-32" />
        <button onClick={() => saveMut.mutate()} disabled={saveMut.isPending || !uid.trim() || !pw} className="btn-primary">
          {saveMut.isPending ? '저장 중…' : '저장'}
        </button>
        <button onClick={() => { setResult(null); testMut.mutate() }} disabled={testMut.isPending || !saved} className="btn-secondary">
          {testMut.isPending ? '조회 중…' : '저장 후 시험 조회'}
        </button>
      </div>
      <div className="mt-1 text-2xs text-ink-500 dark:text-ink-400">
        {saved
          ? <>저장됨 (아이디 {saved.id_hint}) · 최근 갱신 {saved.updated_at ? saved.updated_at.slice(0, 16).replace('T', ' ') : '-'}{saved.updated_by ? ` · ${saved.updated_by}` : ''}</>
          : '저장된 로그인 없음'}
      </div>
      {result && (
        <div className={`mt-1 text-2xs ${result.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>{result.text}</div>
      )}
    </div>
  )
}
