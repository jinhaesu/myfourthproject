/**
 * 클라이언트 사이드 엑셀 파싱 유틸리티
 * 지원 양식:
 *  1) 위하고/더존 '분개장' — 상대계정·차/대변 양면 모두 포함 (가장 완전)
 *  2) 위하고/더존 '계정별 원장' — 한 계정의 거래만 (상대계정 정보 없음)
 *  3) 일반 엑셀 (헤더가 첫 행에 있는 표준 양식)
 */
import * as XLSX from 'xlsx'

export interface ParsedRow {
  description: string
  account_code: string
  merchant_name: string
  amount: number
  debit: number
  credit: number
  date: string
  account_name: string
  source_account_code: string
  source_account_name: string
}

export interface ParseResult {
  rows: ParsedRow[]
  sheetCount: number
  sheetsProcessed: number
}

export function parseExcelForUpload(file: File): Promise<ParseResult> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target!.result as ArrayBuffer)
        const workbook = XLSX.read(data, { type: 'array' })

        const allRows: ParsedRow[] = []
        let sheetsProcessed = 0

        for (const sheetName of workbook.SheetNames) {
          const sheet = workbook.Sheets[sheetName]
          const rawRows: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' })

          if (rawRows.length < 2) continue

          // 분개장 양식 우선 (상대계정까지 완전한 정보)
          if (isJournalFormat(rawRows)) {
            const parsed = parseJournal(rawRows)
            if (parsed.length > 0) {
              allRows.push(...parsed)
              sheetsProcessed++
              continue
            }
          }

          // 계정별 원장 감지
          if (isAccountLedgerFormat(rawRows)) {
            const parsed = parseAccountLedger(rawRows)
            if (parsed.length > 0) {
              allRows.push(...parsed)
              sheetsProcessed++
              continue
            }
          }

          // fallback: 일반 형식
          const parsed = parseNormalFormat(rawRows)
          if (parsed.length > 0) {
            allRows.push(...parsed)
            sheetsProcessed++
          }
        }

        resolve({ rows: allRows, sheetCount: workbook.SheetNames.length, sheetsProcessed })
      } catch (err) {
        reject(err)
      }
    }
    reader.onerror = () => reject(new Error('파일 읽기 실패'))
    reader.readAsArrayBuffer(file)
  })
}


// ============ 분개장(전표) 양식 ============

// 한국 K-GAAP 표준 계정과목명 → 3자리 코드
const ACCT_NAME_TO_CODE: Record<string, string> = {
  // 자산
  '현금': '101', '당좌예금': '102', '보통예금': '103', '제예금': '104',
  '단기금융상품': '105', '단기매매증권': '107',
  '외상매출금': '108', '받을어음': '110', '단기대여금': '114', '미수금': '120',
  '미수수익': '116', '선급금': '131', '선급비용': '133', '가지급금': '134',
  '부가세대급금': '135',
  '원재료': '153', '재공품': '169', '제품': '150', '상품': '146',
  '저장품': '173', '소모품': '173',
  '토지': '201', '건물': '202', '구축물': '204', '기계장치': '206',
  '차량운반구': '208', '비품': '212', '공구와기구': '210', '시설장치': '214',
  '감가상각누계액': '203', '개발비': '218', '특허권': '231',
  '임차보증금': '232', '전세권': '233', '보증금': '232',
  // 부채
  '외상매입금': '251', '지급어음': '252', '미지급금': '253',
  '예수금': '254', '부가세예수금': '255', '선수금': '255',
  '미지급비용': '262', '미지급세금': '261',
  '단기차입금': '260', '장기차입금': '293', '사채': '291',
  '퇴직급여충당부채': '295',
  // 자본
  '자본금': '331', '주식발행초과금': '341', '이익잉여금': '375',
  // 수익
  '상품매출': '401', '제품매출': '404', '용역매출': '403',
  '공사매출': '402', '임대료수익': '904', '수출매출': '404',
  '이자수익': '901', '배당금수익': '902', '잡이익': '930',
  '외환차익': '907', '외화환산이익': '906',
  // 비용 - 매출원가/제조원가 (제)
  '상품매출원가': '451', '제품매출원가': '455',
  '원재료비': '501', '복리후생비': '511', '여비교통비': '512',
  '접대비': '513', '통신비': '514', '수도광열비': '515', '세금과공과': '517',
  '감가상각비(제)': '518', '지급임차료': '519', '수선비': '520',
  '보험료': '521', '차량유지비': '522', '교육훈련비': '525',
  '도서인쇄비': '526', '소모품비(제)': '530',
  '지급수수료(제)': '531',
  '광고선전비(제)': '533', '운반비(제)': '524',
  // 비용 - 판관비 (판)
  '직원급여': '801', '급여': '801', '잡급': '803',
  '복리후생비(판)': '811', '여비교통비(판)': '812', '접대비(판)': '813',
  '통신비(판)': '814', '수도광열비(판)': '815', '세금과공과(판)': '817',
  '감가상각비(판)': '818', '지급임차료(판)': '819', '수선비(판)': '820',
  '보험료(판)': '821', '차량유지비(판)': '822', '경상연구개발비': '823',
  '운반비': '824', '운반비(판)': '824', '교육훈련비(판)': '825',
  '도서인쇄비(판)': '826', '회의비(판)': '827',
  '판매수수료': '839', '지급수수료': '831', '지급수수료(판)': '831',
  '광고선전비': '833', '광고선전비(판)': '833',
  '소모품비': '830', '소모품비(판)': '830',
  '대손상각비': '835',
  '이자비용': '951', '외환차손': '952', '잡손실': '980',
  '기부금': '953', '재해손실': '961',
}

function accountNameToCode(name: string): string {
  if (!name) return ''
  const n = String(name).trim()
  if (ACCT_NAME_TO_CODE[n]) return ACCT_NAME_TO_CODE[n]
  // 접미사 변형 ('소모품비(제)' → '소모품비')
  const base = n.replace(/\([^)]*\)\s*$/, '').trim()
  if (base !== n && ACCT_NAME_TO_CODE[base]) return ACCT_NAME_TO_CODE[base]
  return ''
}

function isJournalFormat(rows: any[][]): boolean {
  if (rows.length < 5) return false
  let hasJournalTitle = false
  let hasDrCrHeader = false
  for (let r = 0; r < Math.min(10, rows.length); r++) {
    const row = rows[r]
    if (!row) continue
    for (const cell of row) {
      if (cell == null || cell === '') continue
      const normalized = String(cell).replace(/\s/g, '').trim()
      if (normalized.includes('분개장')) hasJournalTitle = true
      if (normalized === '차변' || normalized === '대변') hasDrCrHeader = true
    }
    if (hasJournalTitle && hasDrCrHeader) return true
  }
  return hasJournalTitle
}

function parseJournal(rows: any[][]): ParsedRow[] {
  const result: ParsedRow[] = []

  // 연도 추출
  let year = String(new Date().getFullYear())
  for (let r = 0; r < Math.min(5, rows.length); r++) {
    for (const cell of rows[r] || []) {
      if (cell != null) {
        const m = String(cell).match(/(20\d{2})\s*년/)
        if (m) { year = m[1]; break }
      }
    }
  }

  // 위하고 분개장은 항상 6컬럼: [0]월일 [1]번호 [2]차변금액 [3]차변계정 [4]대변계정 [5]대변금액
  const COL_MD = 0, COL_NUM = 1, COL_DR_AMT = 2, COL_DR_ACC = 3, COL_CR_ACC = 4, COL_CR_AMT = 5

  const toFloat = (v: any): number => {
    if (v == null || v === '') return 0
    const n = parseFloat(String(v).replace(/,/g, '').trim())
    return isNaN(n) ? 0 : n
  }

  interface Entry { amount: number; account: string }
  interface Voucher {
    date: string; number: string
    debits: Entry[]; credits: Entry[]
    description: string; merchant: string
  }

  let voucher: Voucher | null = null
  let headerFound = false

  const flush = (v: Voucher | null) => {
    if (!v) return
    if (v.debits.length === 0 && v.credits.length === 0) return
    const crMain = v.credits.length
      ? v.credits.reduce((a, b) => Math.abs(b.amount) > Math.abs(a.amount) ? b : a).account
      : ''
    const drMain = v.debits.length
      ? v.debits.reduce((a, b) => Math.abs(b.amount) > Math.abs(a.amount) ? b : a).account
      : ''
    for (const d of v.debits) {
      result.push({
        description: v.description || d.account,
        account_code: accountNameToCode(crMain),
        merchant_name: v.merchant || '',
        amount: Math.abs(d.amount),
        debit: d.amount >= 0 ? d.amount : 0,
        credit: d.amount < 0 ? -d.amount : 0,
        date: v.date,
        account_name: crMain,
        source_account_code: accountNameToCode(d.account),
        source_account_name: d.account,
      })
    }
    for (const c of v.credits) {
      result.push({
        description: v.description || c.account,
        account_code: accountNameToCode(drMain),
        merchant_name: v.merchant || '',
        amount: Math.abs(c.amount),
        debit: c.amount < 0 ? -c.amount : 0,
        credit: c.amount >= 0 ? c.amount : 0,
        date: v.date,
        account_name: drMain,
        source_account_code: accountNameToCode(c.account),
        source_account_name: c.account,
      })
    }
  }

  for (let idx = 0; idx < rows.length; idx++) {
    const row = rows[idx] || []
    const padded = row.length < 6 ? [...row, ...new Array(6 - row.length).fill('')] : row

    const mdRaw = padded[COL_MD]
    const numRaw = padded[COL_NUM]
    const drAmtRaw = padded[COL_DR_AMT]
    const drAccRaw = padded[COL_DR_ACC]
    const crAccRaw = padded[COL_CR_ACC]
    const crAmtRaw = padded[COL_CR_AMT]

    const md = mdRaw != null ? String(mdRaw).trim() : ''
    const num = numRaw != null ? String(numRaw).trim() : ''
    const drAcc = drAccRaw != null ? String(drAccRaw).trim() : ''
    const crAcc = crAccRaw != null ? String(crAccRaw).trim() : ''

    // 페이지 헤더 반복 skip
    const cellText = padded.filter((c) => c != null && c !== '').map(String).join(' ')
    if (
      cellText.includes('분   개   장') || cellText.includes('분개장') ||
      cellText.includes('회사명') || cellText.includes('구     분') ||
      cellText.includes('월/일')
    ) {
      headerFound = true
      continue
    }

    if (!headerFound) continue

    // 새 분개 시작 — 월/일 패턴
    if (/^\d{1,2}\/\d{1,2}$/.test(md)) {
      flush(voucher)
      voucher = {
        date: `${year}-${md.replace('/', '-')}`,
        number: num,
        debits: [], credits: [],
        description: '', merchant: '',
      }
    }

    if (!voucher) continue

    const drAmt = toFloat(drAmtRaw)
    const crAmt = toFloat(crAmtRaw)

    if (drAmt !== 0 && drAcc) voucher.debits.push({ amount: drAmt, account: drAcc })
    if (crAmt !== 0 && crAcc) voucher.credits.push({ amount: crAmt, account: crAcc })

    // 금액 0인 행 + 양쪽 텍스트만 있는 경우 → 적요+거래처
    if (drAmt === 0 && crAmt === 0) {
      if (drAcc && !voucher.description) voucher.description = drAcc
      if (crAcc && !voucher.merchant) voucher.merchant = crAcc
    }
  }

  flush(voucher)
  return result
}


// ============ 계정별 원장 형식 감지 ============

function isAccountLedgerFormat(rows: any[][]): boolean {
  let dateHeaderCount = 0
  let hasAccountHeader = false

  // 최대 100행까지 검사
  const scanLimit = Math.min(100, rows.length)

  for (let r = 0; r < scanLimit; r++) {
    const row = rows[r]
    if (!row) continue

    for (let c = 0; c < row.length; c++) {
      const cell = row[c]
      if (cell == null || cell === '') continue
      const s = String(cell).trim()
      const normalized = s.replace(/\s/g, '')

      // "계정별" + "원장" 텍스트
      if (normalized.includes('계정별') && normalized.includes('원장')) return true

      // "날짜" 헤더 카운트 (2번 이상이면 반복 헤더 = 계정별 원장)
      if (normalized === '날짜') dateHeaderCount++

      // 계정 섹션 헤더 패턴
      if (tryMatchAccountHeader(s, row, c)) hasAccountHeader = true

      // "전기이월" = 계정별 원장 특유의 행
      if (normalized === '전기이월' || normalized === '전월이월') hasAccountHeader = true
    }

    // 날짜 헤더가 2번 이상 나오면 계정별 원장
    if (dateHeaderCount >= 2) return true
  }

  return hasAccountHeader && dateHeaderCount >= 1
}


/**
 * 계정 섹션 헤더 패턴 매칭 (다양한 더존 형식 지원)
 * Returns: { code, name } or null
 */
function tryMatchAccountHeader(cellText: string, row: any[], cellIdx: number): { code: string; name: string } | null {
  const s = cellText.trim()

  // 패턴 1: [000101] 보통예금
  const m1 = s.match(/\[(\d{3,6})\]\s*(.+)/)
  if (m1) return { code: m1[1], name: m1[2].trim() }

  // 패턴 2: (000101) 보통예금
  const m2 = s.match(/\((\d{3,6})\)\s*(.+)/)
  if (m2) return { code: m2[1], name: m2[2].trim() }

  // 패턴 3: 000101 보통예금 (숫자 + 한글, 같은 셀)
  const m3 = s.match(/^(\d{3,6})\s+([가-힣\w].{1,})$/)
  if (m3 && /[가-힣]/.test(m3[2])) return { code: m3[1], name: m3[2].trim() }

  // 패턴 4: 숫자만 있는 셀 + 다음 셀에 한글 이름
  if (/^\d{3,6}$/.test(s) && cellIdx + 1 < row.length) {
    const nextCell = String(row[cellIdx + 1] || '').trim()
    if (nextCell && /^[가-힣]/.test(nextCell) && nextCell.length >= 2) {
      return { code: s, name: nextCell }
    }
  }

  return null
}


// ============ 계정별 원장 파싱 ============

function parseAccountLedger(rows: any[][]): ParsedRow[] {
  const result: ParsedRow[] = []

  // 기간 행에서 연도 추출
  let year = String(new Date().getFullYear())
  for (let r = 0; r < Math.min(10, rows.length); r++) {
    for (const cell of rows[r] || []) {
      if (cell != null) {
        const match = String(cell).match(/(20\d{2})\s*[.\/-]/)
        if (match) { year = match[1]; break }
      }
    }
    if (year !== String(new Date().getFullYear())) break
  }

  // 첫 번째 "날짜" 헤더 찾기 → 컬럼 매핑
  const colMap: Record<string, number> = {}
  let firstHeaderRow = -1

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r]
    if (!row) continue
    for (let c = 0; c < row.length; c++) {
      const h = String(row[c] || '').replace(/\s/g, '')
      if (h === '날짜') {
        firstHeaderRow = r
        // 이 행에서 컬럼 매핑
        for (let cc = 0; cc < row.length; cc++) {
          const hh = String(row[cc] || '').replace(/\s/g, '')
          if (hh === '날짜' && !colMap['date']) colMap['date'] = cc
          else if ((hh === '적요란' || hh === '적요') && !colMap['description']) colMap['description'] = cc
          else if (hh === '코드' && !colMap['code']) colMap['code'] = cc
          else if ((hh === '거래처' || hh === '거래처명') && !colMap['merchant']) colMap['merchant'] = cc
          else if (hh === '차변' && !colMap['debit']) colMap['debit'] = cc
          else if (hh === '대변' && !colMap['credit']) colMap['credit'] = cc
        }
        break
      }
    }
    if (firstHeaderRow >= 0) break
  }

  if (firstHeaderRow === -1) return result

  // 적요 컬럼이 없으면, 날짜 다음 컬럼을 적요로 추정
  if (colMap['description'] === undefined && colMap['date'] !== undefined) {
    colMap['description'] = colMap['date'] + 1
  }
  if (colMap['description'] === undefined) return result

  // 스킵할 적요 값
  const skipDescs = new Set(['', '전기이월', '전월이월', '월계', '누계', '합계', '이월잔액', '차기이월', '잔액'])

  // 현재 계정 섹션
  let currentCode = ''
  let currentName = ''

  // firstHeaderRow 이전에 계정 헤더가 있을 수 있으므로 위로 탐색
  for (let r = Math.max(0, firstHeaderRow - 5); r < firstHeaderRow; r++) {
    const row = rows[r]
    if (!row) continue
    for (let c = 0; c < row.length; c++) {
      const cell = row[c]
      if (cell == null || cell === '') continue
      const header = tryMatchAccountHeader(String(cell).trim(), row, c)
      if (header) {
        currentCode = header.code
        currentName = header.name
        break
      }
    }
  }

  // 전체 데이터 행 파싱
  // 핵심: 금액(차변/대변)이 있는 행 = 데이터 행, 금액이 없는 행 = 헤더/요약 행
  // 데이터 행에서는 절대 계정 헤더 매칭을 하지 않음 (코드+거래처 오인 방지)
  for (let r = firstHeaderRow + 1; r < rows.length; r++) {
    const row = rows[r]
    if (!row || row.length === 0) continue

    // 반복되는 "날짜" 헤더행 스킵
    let isHeaderRow = false
    for (const cell of row) {
      if (String(cell || '').replace(/\s/g, '') === '날짜') {
        isHeaderRow = true
        break
      }
    }
    if (isHeaderRow) continue

    // 차변/대변 금액을 먼저 파싱
    const debit = colMap['debit'] !== undefined ? (parseFloat(String(row[colMap['debit']] || 0).replace(/,/g, '')) || 0) : 0
    const credit = colMap['credit'] !== undefined ? (parseFloat(String(row[colMap['credit']] || 0).replace(/,/g, '')) || 0) : 0

    // 금액이 없는 행 → 계정 섹션 헤더 또는 요약행 (전기이월, 합계 등)
    if (debit === 0 && credit === 0) {
      for (let c = 0; c < row.length; c++) {
        const cell = row[c]
        if (cell == null || cell === '') continue
        const header = tryMatchAccountHeader(String(cell).trim(), row, c)
        if (header) {
          currentCode = header.code
          currentName = header.name
          break
        }
      }
      continue  // 금액 없는 행은 항상 스킵
    }

    // ── 여기부터 금액이 있는 데이터 행만 처리 ──

    // 현재 계정코드 없으면 스킵
    if (!currentCode) continue

    // 적요 추출
    const desc = String(row[colMap['description']] || '').trim()
    if (skipDescs.has(desc)) continue

    // 상대계정 코드
    const relCode = colMap['code'] !== undefined ? String(row[colMap['code']] || '').trim() : ''
    const cleanRelCode = /^\d+$/.test(relCode) ? relCode : ''

    const merchant = colMap['merchant'] !== undefined ? String(row[colMap['merchant']] || '').trim() : ''

    let dateStr = ''
    if (colMap['date'] !== undefined && row[colMap['date']] != null) {
      let d = String(row[colMap['date']]).trim()
      if (d && /^\d/.test(d)) {
        if (!d.startsWith('20')) {
          d = `${year}-${d.replace(/[.\/]/g, '-')}`
        }
        dateStr = d
      }
    }

    result.push({
      description: desc,
      account_code: cleanRelCode || currentCode,
      merchant_name: merchant,
      amount: debit || credit || 0,
      debit, credit,
      date: dateStr,
      account_name: currentName,
      source_account_code: currentCode,
      source_account_name: currentName,
    })
  }

  return result
}


// ============ 일반 형식 파싱 ============

function parseNormalFormat(rows: any[][]): ParsedRow[] {
  if (rows.length < 2) return []

  const headers = rows[0].map((h: any) => String(h || '').trim())
  const mapping: Record<string, string> = {
    '적요': 'description', '적요란': 'description',
    '거래내역': 'description', '내역': 'description',
    '거래처명': 'merchant_name', '거래처': 'merchant_name', '가맹점': 'merchant_name',
    '금액': 'amount', '거래금액': 'amount',
    '계정과목코드': 'account_code', '계정코드': 'account_code',
    '계정과목': 'account_code',
    '계정과목명': 'account_name', '계정명': 'account_name',
    '차변': 'debit', '대변': 'credit', '날짜': 'date',
  }
  // 주의: '코드'는 일반 형식에서 계정코드가 아닐 수 있으므로 제외

  const colIdx: Record<string, number> = {}
  for (let i = 0; i < headers.length; i++) {
    const m = mapping[headers[i]]
    if (m && !(m in colIdx)) colIdx[m] = i
  }

  if (colIdx['description'] === undefined || colIdx['account_code'] === undefined) return []

  const result: ParsedRow[] = []
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]
    const desc = String(row[colIdx['description']] || '').trim()
    const code = String(row[colIdx['account_code']] || '').trim()
    if (!desc || !code) continue

    result.push({
      description: desc,
      account_code: code,
      merchant_name: colIdx['merchant_name'] !== undefined ? String(row[colIdx['merchant_name']] || '').trim() : '',
      amount: colIdx['amount'] !== undefined ? (parseFloat(String(row[colIdx['amount']] || 0)) || 0) : 0,
      debit: colIdx['debit'] !== undefined ? (parseFloat(String(row[colIdx['debit']] || 0)) || 0) : 0,
      credit: colIdx['credit'] !== undefined ? (parseFloat(String(row[colIdx['credit']] || 0)) || 0) : 0,
      date: colIdx['date'] !== undefined ? String(row[colIdx['date']] || '').trim() : '',
      account_name: colIdx['account_name'] !== undefined ? String(row[colIdx['account_name']] || '').trim() : '',
      source_account_code: '',
      source_account_name: '',
    })
  }

  return result
}
