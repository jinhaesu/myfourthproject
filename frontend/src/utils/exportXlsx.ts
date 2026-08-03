import * as XLSX from 'xlsx'

type Cell = string | number | null | undefined

/**
 * 배열-오브-배열(AOA) 시트들을 하나의 .xlsx로 즉시 다운로드.
 * 첫 행을 헤더로 넣어서 호출하면 됨.
 */
export function downloadXlsx(
  filename: string,
  sheets: { name: string; rows: Cell[][] }[],
) {
  const wb = XLSX.utils.book_new()
  for (const s of sheets) {
    const ws = XLSX.utils.aoa_to_sheet(s.rows)
    XLSX.utils.book_append_sheet(wb, ws, (s.name || 'Sheet').slice(0, 31))
  }
  XLSX.writeFile(wb, filename.endsWith('.xlsx') ? filename : `${filename}.xlsx`)
}
