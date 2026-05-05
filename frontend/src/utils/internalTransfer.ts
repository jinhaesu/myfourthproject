/**
 * 법인 계좌 간 이체(internal transfer) 식별 헬퍼
 *
 * A통장→B통장 이체는 회계상 매출도 비용도 아니다.
 * 이 헬퍼를 사용해 분석 전에 해당 거래를 필터링한다.
 */

/**
 * 본인 소유 은행 계좌 정보를 그랜터 자산 응답에서 추출.
 * granterApi.listAllAssets() 응답 형태:
 *   { CARD: [...], BANK_ACCOUNT: [...], HOME_TAX_ACCOUNT: [...], ... }
 * 각 자산: { bankAccount: { nickName, accountName, accountNumber, ... }, organizationName, ... }
 */
export interface OwnAccountSet {
  /** 정규화된 계좌명/별칭 (소문자, 공백 제거) */
  names: Set<string>
  /** 숫자만 남긴 계좌번호 */
  numbers: Set<string>
  /** 디버깅용 raw 항목 */
  raw: Array<{ name: string; number: string }>
}

export function buildOwnAccountSet(allAssets: any): OwnAccountSet {
  const names = new Set<string>()
  const numbers = new Set<string>()
  const raw: Array<{ name: string; number: string }> = []
  const banks = (allAssets?.BANK_ACCOUNT as any[]) || []

  const norm = (s: string) => s.replace(/\s+/g, '').toLowerCase()

  for (const a of banks) {
    const ba = a?.bankAccount || {}
    const nickName      = String(ba.nickName    || '').trim()
    const accountName   = String(ba.accountName || '').trim()
    const accountNumber = String(ba.accountNumber || '').replace(/[^0-9]/g, '')
    const orgName       = String(a.organizationName || '').trim()

    if (nickName)    names.add(norm(nickName))
    if (accountName) names.add(norm(accountName))
    if (accountNumber) numbers.add(accountNumber)

    // 회사명+계좌번호 조합도 추가 (예: "조인앤조인 503-1234-...")
    if (orgName && accountNumber) {
      names.add(norm(`${orgName}${accountNumber}`))
    }

    raw.push({ name: nickName || accountName, number: accountNumber })
  }

  return { names, numbers, raw }
}

/**
 * 한 ticket이 본인 계좌 간 이체인지 판정.
 * BANK_TRANSACTION_TICKET 외에는 무조건 false.
 */
export function isInternalTransfer(ticket: any, own: OwnAccountSet): boolean {
  const bt = ticket?.bankTransaction
  if (!bt) return false

  // own이 비어있으면 필터 불가 → 그대로 통과
  if (own.names.size === 0 && own.numbers.size === 0) return false

  const norm = (s: string) => String(s || '').replace(/\s+/g, '').toLowerCase()

  // 1. 거래상대방 이름 매칭 (counterparty / opponent / counterpartyName)
  const cpNameRaw = String(bt.counterparty || bt.opponent || bt.counterpartyName || '').trim()
  if (cpNameRaw && own.names.has(norm(cpNameRaw))) return true

  // 2. 거래상대방 계좌번호 매칭 (전체)
  const cpNum = String(bt.counterpartyAccountNumber || bt.opponentAccountNumber || '').replace(/[^0-9]/g, '')
  if (cpNum && own.numbers.has(cpNum)) return true

  // 3. 마지막 8자리 매칭 (마스킹된 계좌번호 대응)
  if (cpNum && cpNum.length >= 8) {
    const last8 = cpNum.slice(-8)
    for (const ownNum of own.numbers) {
      if (ownNum.length >= 8 && ownNum.slice(-8) === last8) return true
    }
  }

  return false
}

/**
 * tickets 배열에서 internal transfer를 제외한 새 배열을 반환.
 * own이 비어있으면 원본 배열을 그대로 반환(자산 쿼리 실패 시 안전 처리).
 */
export function filterOutInternalTransfers(tickets: any[], own: OwnAccountSet): any[] {
  if (!tickets?.length) return tickets ?? []
  if (own.names.size === 0 && own.numbers.size === 0) return tickets
  return tickets.filter((t) => !isInternalTransfer(t, own))
}
