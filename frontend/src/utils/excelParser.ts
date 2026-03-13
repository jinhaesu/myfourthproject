/**
 * 클라이언트 사이드 엑셀 파싱 유틸리티
 * 더존 계정별 원장 형식 지원
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

          if (isAccountLedgerFormat(rawRows)) {
            const parsed = parseAccountLedger(rawRows)
            if (parsed.length > 0) {
              allRows.push(...parsed)
              sheetsProcessed++
            }
          } else {
            const parsed = parseNormalFormat(rawRows)
            if (parsed.length > 0) {
              allRows.push(...parsed)
              sheetsProcessed++
            }
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

function isAccountLedgerFormat(rows: any[][]): boolean {
  // 1차: 첫 8행에서 "계정별" + "원장" 텍스트 검색
  for (let r = 0; r < Math.min(8, rows.length); r++) {
    for (const cell of rows[r]) {
      if (cell != null && cell !== '') {
        const normalized = String(cell).replace(/\s/g, '')
        if (normalized.includes('계정별') && normalized.includes('원장')) return true
      }
    }
  }
  // 2차: [코드] 패턴 + 날짜 헤더
  let hasAccountHeader = false
  let hasTableHeader = false
  for (let r = 0; r < Math.min(15, rows.length); r++) {
    for (const cell of rows[r]) {
      if (cell != null && cell !== '') {
        const s = String(cell).trim()
        if (/^\[\d{1,6}\]\s*.+/.test(s)) hasAccountHeader = true
        if (s === '날짜') hasTableHeader = true
      }
    }
  }
  return hasAccountHeader && hasTableHeader
}

function parseAccountLedger(rows: any[][]): ParsedRow[] {
  const result: ParsedRow[] = []

  // 기간 행에서 연도 추출
  let year = String(new Date().getFullYear())
  for (let r = 0; r < Math.min(10, rows.length); r++) {
    for (const cell of rows[r]) {
      if (cell != null) {
        const match = String(cell).match(/(20\d{2})\s*[.\/-]/)
        if (match) { year = match[1]; break }
      }
    }
    if (year !== String(new Date().getFullYear())) break
  }

  // 컬럼 헤더 찾기 (첫 셀 = "날짜")
  const colMap: Record<string, number> = {}
  let headerRow = -1

  for (let r = 0; r < rows.length; r++) {
    const firstCell = rows[r]?.[0]
    if (firstCell != null && String(firstCell).replace(/\s/g, '') === '날짜') {
      headerRow = r
      for (let c = 0; c < rows[r].length; c++) {
        const h = String(rows[r][c] || '').replace(/\s/g, '')
        if (h === '날짜') colMap['date'] = c
        else if (h === '적요란' || h === '적요') colMap['description'] = c
        else if (h === '코드') colMap['code'] = c
        else if (h === '거래처' || h === '거래처명') colMap['merchant'] = c
        else if (h === '차변') colMap['debit'] = c
        else if (h === '대변') colMap['credit'] = c
      }
      break
    }
  }

  if (headerRow === -1 || colMap['description'] === undefined) return result

  // 데이터 행 파싱
  let currentCode = ''
  let currentName = ''
  const skipDescs = new Set(['', '전기이월', '전월이월', '월계', '누계', '합계', '이월잔액'])

  for (let r = headerRow + 1; r < rows.length; r++) {
    const row = rows[r]
    if (!row || row.length === 0) continue

    // 계정 섹션 헤더: [CODE] NAME
    const firstCell = String(row[0] || '').trim()
    const acctMatch = firstCell.match(/^\[(\d{1,6})\]\s*(.+)/)
    if (acctMatch) {
      currentCode = acctMatch[1]
      currentName = acctMatch[2].trim()
      continue
    }

    const desc = String(row[colMap['description']] || '').trim()
    if (skipDescs.has(desc)) continue

    const relCode = colMap['code'] !== undefined ? String(row[colMap['code']] || '').trim() : ''
    const accountCode = relCode || currentCode
    if (!accountCode) continue

    const debit = colMap['debit'] !== undefined ? (parseFloat(String(row[colMap['debit']] || 0)) || 0) : 0
    const credit = colMap['credit'] !== undefined ? (parseFloat(String(row[colMap['credit']] || 0)) || 0) : 0
    const merchant = colMap['merchant'] !== undefined ? String(row[colMap['merchant']] || '').trim() : ''

    let dateStr = ''
    if (colMap['date'] !== undefined && row[colMap['date']] != null) {
      let d = String(row[colMap['date']]).trim()
      if (d && !d.startsWith('20')) {
        d = `${year}-${d.replace(/[.\/]/g, '-')}`
      }
      dateStr = d
    }

    result.push({
      description: desc,
      account_code: accountCode,
      merchant_name: merchant,
      amount: debit || credit || 0,
      debit, credit,
      date: dateStr,
      account_name: '',
      source_account_code: currentCode,
      source_account_name: currentName,
    })
  }

  return result
}

function parseNormalFormat(rows: any[][]): ParsedRow[] {
  if (rows.length < 2) return []

  const headers = rows[0].map((h: any) => String(h || '').trim())
  const mapping: Record<string, string> = {
    '적요': 'description', '적요란': 'description',
    '거래내역': 'description', '내역': 'description',
    '거래처명': 'merchant_name', '거래처': 'merchant_name', '가맹점': 'merchant_name',
    '금액': 'amount', '거래금액': 'amount',
    '계정과목코드': 'account_code', '계정코드': 'account_code',
    '계정과목': 'account_code', '코드': 'account_code',
    '계정과목명': 'account_name', '계정명': 'account_name',
    '차변': 'debit', '대변': 'credit', '날짜': 'date',
  }

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
