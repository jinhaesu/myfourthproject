/**
 * 법인 계좌 간 이체(internal transfer) 식별 헬퍼
 *
 * A통장→B통장 이체는 회계상 매출도 비용도 아니다.
 * 이 헬퍼를 사용해 분석 전에 해당 거래를 필터링한다.
 *
 * 판별 로직은 백엔드 internal_transfers.py(_resolve_counterparty)와 동일:
 *  - 통장거래 적요(bankTransaction.content)에 '우리 계좌'의 은행 별칭 + 계좌 뒷자리(4/3)가
 *    함께 등장하면 내부이체
 *  - 적요에 회사명(조인앤조인) 변형이 있으면 내부이체(상대 계좌 미상)
 * ⚠ 그랜터 통장거래는 구조화된 counterparty가 대부분 비어 있고 실제 상대방은 content에 있음.
 * ⚠ BANK_ACCOUNT 자산의 계좌번호는 최상위 a.number, 은행명은 a.organizationName 에 있음.
 */

const norm = (s: unknown) => String(s ?? '').replace(/[\s()（）㈜\-_.]/g, '').replace(/주식회사/g, '').toLowerCase()
const digitsOnly = (s: unknown) => String(s ?? '').replace(/\D/g, '')

// 은행명 → 적요에 등장하는 짧은 별칭 (백엔드 _BANK_SHORT와 동일)
const BANK_SHORT: Record<string, string[]> = {
  기업은행: ['기업', 'ibk'],
  신한은행: ['신한'],
  하나은행: ['하나', 'keb', '외환'],
  국민은행: ['국민', 'kb'],
  우리은행: ['우리'],
  농협은행: ['농협', 'nh'],
  농협: ['농협', 'nh'],
  새마을금고: ['새마을', 'mg'],
  카카오뱅크: ['카카오'],
  토스뱅크: ['토스'],
  산업은행: ['산업', 'kdb'],
  수협은행: ['수협'],
  부산은행: ['부산'],
  대구은행: ['대구'],
}

interface OwnAccount {
  bank: string
  number: string
  last4: string
  last3: string
  /** 정규화된 은행 별칭들 */
  shorts: string[]
}

export interface OwnAccountSet {
  accounts: OwnAccount[]
  /** 계좌번호(전체 숫자) 집합 — 상대 계좌번호 직접 매칭용 */
  numbers: Set<string>
}

/**
 * 본인 소유 은행 계좌 정보를 그랜터 자산 응답에서 추출.
 * granterApi.listAllAssets() 응답: { CARD: [...], BANK_ACCOUNT: [...], ... }
 * 각 BANK_ACCOUNT 자산: { id, number, organizationName, name, bankAccount: {...}, ... }
 */
export function buildOwnAccountSet(allAssets: any): OwnAccountSet {
  const accounts: OwnAccount[] = []
  const numbers = new Set<string>()
  const banks = (allAssets?.BANK_ACCOUNT as any[]) || []

  for (const a of banks) {
    const ba = a?.bankAccount || {}
    const number = digitsOnly(a?.number || ba?.number)
    const bank = String(a?.organizationName || ba?.bankName || ba?.organizationName || '').trim()
    if (!number) continue
    numbers.add(number)
    const shorts = (BANK_SHORT[bank] || (bank ? [bank.slice(0, 2)] : [])).map(norm).filter(Boolean)
    accounts.push({
      bank,
      number,
      last4: number.length >= 4 ? number.slice(-4) : number,
      last3: number.length >= 3 ? number.slice(-3) : number,
      shorts,
    })
  }

  return { accounts, numbers }
}

/**
 * 한 ticket이 본인 계좌 간 이체인지 판정.
 * BANK_TRANSACTION_TICKET 외에는 무조건 false.
 */
export function isInternalTransfer(ticket: any, own: OwnAccountSet): boolean {
  const bt = ticket?.bankTransaction
  if (!bt) return false
  if (!own.accounts.length && own.numbers.size === 0) return false

  // 실제 상대방/적요는 content 에 있음 (counterparty는 대부분 빈 값)
  const memo = norm(bt.content || bt.counterparty || bt.opponent || bt.description || '')
  if (!memo) return false

  // 1. 회사명(조인앤조인 등)이 적요에 있으면 내부이체
  for (const variant of SELF_COMPANY.nameVariants) {
    const v = norm(variant)
    if (v && memo.includes(v)) return true
  }

  // 2. 상대 계좌번호가 우리 계좌번호와 일치 (전체 또는 마지막 8자리)
  const cpNum = digitsOnly(bt.counterpartyAccountNumber || bt.opponentAccountNumber || '')
  if (cpNum) {
    if (own.numbers.has(cpNum)) return true
    if (cpNum.length >= 8) {
      const last8 = cpNum.slice(-8)
      for (const n of own.numbers) if (n.length >= 8 && n.slice(-8) === last8) return true
    }
  }

  // 3. 적요에 우리 계좌의 은행 별칭 + 뒷자리(4 우선, 3 보조)가 함께 등장 → 내부이체
  for (const acc of own.accounts) {
    const bankHit = acc.shorts.some((s) => s && memo.includes(s))
    if (!bankHit) continue
    if (acc.last4 && memo.includes(acc.last4)) return true
    if (acc.last3 && memo.includes(acc.last3)) return true
  }

  return false
}

/**
 * tickets 배열에서 internal transfer를 제외한 새 배열을 반환.
 * own이 비어있으면 원본 배열을 그대로 반환(자산 쿼리 실패 시 안전 처리).
 */
export function filterOutInternalTransfers(tickets: any[], own: OwnAccountSet): any[] {
  if (!tickets?.length) return tickets ?? []
  if (!own.accounts.length && own.numbers.size === 0) return tickets
  return tickets.filter((t) => !isInternalTransfer(t, own))
}

// ─────────────────────────────────────────────────────────────────────────────
// 본인 회사 식별 (거래처 스코어링 등에서 자기 자신을 거래처로 잡는 것 방지)
// ─────────────────────────────────────────────────────────────────────────────

/** 본인 회사 식별용 고정 정보 (조인앤조인 사업자등록증 기준) */
export const SELF_COMPANY = {
  businessNumbers: ['503-87-01038', '5038701038'],
  nameVariants: [
    '주식회사조인앤조인',
    '(주)조인앤조인',
    '㈜조인앤조인',
    '조인앤조인',
    'joinandjoin',
    'join&join',
  ],
}

const _selfBNSet = new Set(SELF_COMPANY.businessNumbers.map((s) => s.replace(/[^0-9]/g, '')))
const _selfNameSet = new Set(
  SELF_COMPANY.nameVariants.map((s) => s.replace(/\s+/g, '').toLowerCase())
)

/**
 * 사업자번호 또는 회사명이 본인 회사인지 판정.
 * - 사업자번호는 하이픈/공백 제거 후 정확 매칭 (10자리)
 * - 회사명은 공백 제거·소문자 후 정확 매칭
 *
 * 부분 일치는 false positive가 많아 제외 (예: '조인사' 같은 다른 거래처).
 * 사업자번호가 있으면 그것만으로 충분, 없으면 회사명 정확 매칭만.
 */
export function isSelfCompany(opts: {
  businessNumber?: string | null
  companyName?: string | null
}): boolean {
  const bn = String(opts.businessNumber || '').replace(/[^0-9]/g, '')
  if (bn && _selfBNSet.has(bn)) return true

  const name = String(opts.companyName || '').replace(/\s+/g, '').toLowerCase()
  if (name && _selfNameSet.has(name)) return true

  return false
}

/** 거래처(contact) 문자열 자체가 본인 회사인지 판정 */
export function isSelfContact(contact: string | null | undefined): boolean {
  return isSelfCompany({ companyName: contact })
}
