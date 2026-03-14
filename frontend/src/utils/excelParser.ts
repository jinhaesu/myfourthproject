/**
 * 클라이언트 사이드 엑셀 파싱 유틸리티
 * 더존 계정별 원장 형식 지원 (다양한 헤더 패턴)
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

          // 계정별 원장 감지: 항상 먼저 시도
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

    // 계정 섹션 헤더 감지 (모든 셀 검사)
    let foundHeader = false
    for (let c = 0; c < row.length; c++) {
      const cell = row[c]
      if (cell == null || cell === '') continue
      const header = tryMatchAccountHeader(String(cell).trim(), row, c)
      if (header) {
        currentCode = header.code
        currentName = header.name
        foundHeader = true
        break
      }
    }
    if (foundHeader) continue

    // 현재 계정코드 없으면 스킵
    if (!currentCode) continue

    // 적요 추출
    const desc = String(row[colMap['description']] || '').trim()
    if (skipDescs.has(desc)) continue

    // 상대계정 코드
    const relCode = colMap['code'] !== undefined ? String(row[colMap['code']] || '').trim() : ''
    // relCode가 숫자가 아니면 무시 (헤더 텍스트 "코드" 등)
    const cleanRelCode = /^\d+$/.test(relCode) ? relCode : ''

    const debit = colMap['debit'] !== undefined ? (parseFloat(String(row[colMap['debit']] || 0).replace(/,/g, '')) || 0) : 0
    const credit = colMap['credit'] !== undefined ? (parseFloat(String(row[colMap['credit']] || 0).replace(/,/g, '')) || 0) : 0
    if (debit === 0 && credit === 0) continue

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
