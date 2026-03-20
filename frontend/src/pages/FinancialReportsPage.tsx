import { useState, useMemo, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { financialApi, aiClassificationApi } from '@/services/api'
import toast from 'react-hot-toast'
import { MagnifyingGlassIcon, XMarkIcon, ArrowPathIcon, ArrowDownTrayIcon, InformationCircleIcon, ChevronDownIcon, ChevronUpIcon, SparklesIcon } from '@heroicons/react/24/outline'
import * as XLSX from 'xlsx'
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Legend,
} from 'recharts'

function fmt(v: number) {
  return new Intl.NumberFormat('ko-KR', { style: 'currency', currency: 'KRW', maximumFractionDigits: 0 }).format(v)
}
function fmtNum(v: number) {
  return new Intl.NumberFormat('ko-KR').format(v)
}
function fmtAmount(v: number) {
  return new Intl.NumberFormat('ko-KR').format(Math.abs(v))
}

type TabType = 'statements' | 'trend' | 'trial' | 'ai-analysis'

// ============ 회계 초보자를 위한 설명 ============
const INCOME_GUIDE = {
  title: '손익계산서란?',
  summary: '회사가 일정 기간 동안 얼마를 벌고(매출), 얼마를 쓰고(비용), 최종적으로 얼마의 이익을 냈는지 보여주는 보고서입니다.',
  sections: [
    { id: 'I', tip: '회사의 주요 영업활동으로 벌어들인 총 수입입니다. (예: 상품 판매, 제품 판매)' },
    { id: 'II', tip: '제품을 만들거나 상품을 구입하는 데 직접 들어간 비용입니다. "상품매출원가 대체"는 재고(자산)에서 원가(비용)로 비용을 옮기는 회계 처리입니다.' },
    { id: 'III', tip: '매출액 - 매출원가. 핵심 수익성 지표로, 이 수치가 마이너스면 팔수록 손해라는 의미입니다.' },
    { id: 'IV', tip: '물건을 팔고 회사를 운영하는 데 드는 비용입니다. (예: 급여, 임차료, 광고비, 운반비)' },
    { id: 'V', tip: '본업에서 발생한 순수 이익입니다. 투자자와 은행이 가장 중요하게 보는 지표입니다.' },
    { id: 'VI', tip: '본업 외에서 발생한 수익입니다. (예: 이자수익, 임대수익, 외화환산이익)' },
    { id: 'VII', tip: '본업 외에서 발생한 비용입니다. (예: 이자비용, 외화환산손실)' },
    { id: 'VIII', tip: '세금을 내기 전 최종 이익입니다.' },
    { id: 'IX', tip: '법인세 등 세금 비용입니다.' },
    { id: 'X', tip: '모든 수익과 비용을 정리한 최종 이익입니다. 회사의 실질적인 성과를 나타냅니다.' },
  ],
}

const BALANCE_GUIDE = {
  title: '재무상태표란?',
  summary: '특정 시점에 회사가 무엇을 가지고 있고(자산), 얼마를 빚지고 있으며(부채), 순수하게 얼마가 남는지(자본)를 보여줍니다.',
  formula: '핵심 공식: 자산 = 부채 + 자본',
  sections: [
    { name: 'I. 유동자산', tip: '1년 이내에 현금으로 바꿀 수 있는 자산 (현금, 예금, 매출채권, 재고)' },
    { name: 'II. 비유동자산', tip: '1년 이상 장기적으로 사용하는 자산 (건물, 기계, 토지, 특허권)' },
    { name: 'I. 유동부채', tip: '1년 이내에 갚아야 하는 부채 (외상매입금, 단기차입금, 미지급금)' },
    { name: 'II. 비유동부채', tip: '1년 이후에 갚는 장기 부채 (장기차입금, 사채)' },
    { name: '자본 항목', tip: '자산에서 부채를 뺀 순수 주주의 몫 (자본금, 이익잉여금)' },
  ],
}

function GuideBox({ title, children, defaultOpen }: { title: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen ?? false)
  return (
    <div className="mb-4 border border-blue-200 rounded-lg bg-blue-50/50 print:hidden">
      <button onClick={() => setOpen(!open)} className="w-full flex items-center justify-between px-4 py-2.5 text-left gap-4">
        <span className="flex items-center gap-2 text-sm font-medium text-blue-700 whitespace-nowrap">
          <InformationCircleIcon className="h-5 w-5 flex-shrink-0" />
          {title}
        </span>
        {open ? <ChevronUpIcon className="h-4 w-4 text-blue-500 flex-shrink-0" /> : <ChevronDownIcon className="h-4 w-4 text-blue-500 flex-shrink-0" />}
      </button>
      {open && <div className="px-4 pb-3 text-sm text-gray-700 leading-relaxed break-keep">{children}</div>}
    </div>
  )
}

function InfoTip({ text }: { text: string }) {
  const [show, setShow] = useState(false)
  return (
    <span className="relative inline-flex ml-1.5 align-middle print:hidden">
      <button onClick={(e) => { e.stopPropagation(); setShow(!show) }}
        className="text-blue-400 hover:text-blue-600 focus:outline-none">
        <InformationCircleIcon className="h-4 w-4" />
      </button>
      {show && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setShow(false)} />
          <div className="absolute z-40 left-0 top-6 w-80 bg-white border border-blue-100 rounded-xl p-4 text-[13px] text-gray-700 shadow-xl leading-[1.7] whitespace-normal break-keep"
            onClick={(e) => e.stopPropagation()}>
            {text}
          </div>
        </>
      )}
    </span>
  )
}

/** 금액 호버 시 +/- 항목 구성 보기 */
function AmountBreakdown({ items, total, isSubtotal }: { items: any[]; total: number; isSubtotal?: boolean }) {
  const [show, setShow] = useState(false)
  const plusItems = items.filter((i: any) => i.amount >= 0)
  const minusItems = items.filter((i: any) => i.amount < 0)
  const plusTotal = plusItems.reduce((s: number, i: any) => s + i.amount, 0)
  const minusTotal = minusItems.reduce((s: number, i: any) => s + i.amount, 0)

  return (
    <span className="relative cursor-help"
      onMouseEnter={() => items.length > 0 && setShow(true)}
      onMouseLeave={() => setShow(false)}>
      <span className={`${isSubtotal ? (total >= 0 ? 'text-gray-900' : 'text-red-600') : 'text-gray-800'}`}>
        {total < 0 ? `(${fmtAmount(total)})` : fmtAmount(total)}
      </span>
      {show && (
        <div className="absolute z-30 right-0 top-full mt-1 w-80 bg-white border border-gray-200 rounded-xl shadow-xl p-4 text-xs print:hidden"
          onClick={(e) => e.stopPropagation()}>
          <div className="font-bold text-gray-800 mb-3 text-[13px] border-b pb-2">{items.length}개 계정으로 구성</div>
          <div className="space-y-1.5">
            <div className="flex justify-between">
              <span className="text-blue-700">+ 항목 ({plusItems.length}개)</span>
              <span className="font-mono font-semibold text-blue-700">{fmtNum(plusTotal)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-red-600">- 항목 ({minusItems.length}개)</span>
              <span className="font-mono font-semibold text-red-600">({fmtNum(Math.abs(minusTotal))})</span>
            </div>
            <div className="flex justify-between font-bold border-t pt-1.5 mt-1.5 text-[13px]">
              <span>합계</span>
              <span className={`font-mono ${total < 0 ? 'text-red-700' : 'text-gray-900'}`}>
                {total < 0 ? `(${fmtAmount(total)})` : fmtAmount(total)}
              </span>
            </div>
          </div>
          {items.length <= 8 && (
            <div className="mt-3 pt-2 border-t space-y-1 max-h-40 overflow-auto">
              {items.map((i: any, idx: number) => (
                <div key={idx} className="flex justify-between text-[11px] text-gray-500">
                  <span className="truncate mr-2">{i.name}</span>
                  <span className="font-mono whitespace-nowrap">{i.amount < 0 ? `(${fmtAmount(i.amount)})` : fmtNum(i.amount)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </span>
  )
}

/** 개별 과목 금액 호버 → 차변/대변/건수 표시 */
function ItemAmountTip({ item }: { item: any }) {
  const [show, setShow] = useState(false)
  const hasDetail = item.debit !== undefined || item.credit !== undefined
  return (
    <span className="relative cursor-help"
      onMouseEnter={() => hasDetail && setShow(true)}
      onMouseLeave={() => setShow(false)}>
      {item.amount < 0 ? `(${fmtAmount(item.amount)})` : fmtAmount(item.amount)}
      {show && (
        <div className="absolute z-30 right-0 top-full mt-1 w-64 bg-white border border-gray-200 rounded-xl shadow-xl p-3 text-xs print:hidden">
          <div className="font-bold text-gray-800 mb-2 text-[13px] border-b pb-1.5">
            {item.name}
            {item.code && <span className="ml-1 text-gray-400 font-normal text-[11px]">({item.code})</span>}
          </div>
          <div className="space-y-1">
            <div className="flex justify-between">
              <span className="text-gray-500">차변 합계</span>
              <span className="font-mono text-blue-700">{fmtNum(item.debit || 0)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">대변 합계</span>
              <span className="font-mono text-red-600">{fmtNum(item.credit || 0)}</span>
            </div>
            <div className="flex justify-between font-bold border-t pt-1 mt-1">
              <span>순액</span>
              <span className="font-mono">{item.amount < 0 ? `(${fmtAmount(item.amount)})` : fmtNum(item.amount)}</span>
            </div>
            {item.tx_count > 0 && (
              <div className="flex justify-between text-gray-400 text-[11px] mt-1">
                <span>거래 건수</span>
                <span>{fmtNum(item.tx_count)}건</span>
              </div>
            )}
          </div>
        </div>
      )}
    </span>
  )
}

/** 손익계산서/재무상태표 엑셀 다운로드 */
function downloadStatementsExcel(incomeData: any, balanceData: any, year: number, month: number | null) {
  const wb = XLSX.utils.book_new()

  // 손익계산서 시트
  const isRows: any[][] = [
    ['손 익 계 산 서'],
    [`${year}년 ${month ? `${month}월` : '1월 1일 ~ 12월 31일'}`],
    [],
    ['구분', '과 목', '금 액', '비율(%)'],
  ]
  for (const section of (incomeData?.sections || [])) {
    for (const item of (section.items || [])) {
      isRows.push(['', item.name, item.amount, ''])
    }
    isRows.push([`${section.id}.`, section.name, section.total, section.pct !== undefined ? section.pct.toFixed(2) : ''])
  }
  const ws1 = XLSX.utils.aoa_to_sheet(isRows)
  ws1['!cols'] = [{ wch: 8 }, { wch: 30 }, { wch: 18 }, { wch: 10 }]
  XLSX.utils.book_append_sheet(wb, ws1, '손익계산서')

  // 재무상태표 시트
  const bsRows: any[][] = [
    ['재 무 상 태 표'],
    [`${year}년 기준`],
    [],
    ['과 목', '금 액'],
  ]
  for (const section of (balanceData?.sections || [])) {
    bsRows.push([section.name, ''])
    for (const sub of (section.subsections || [])) {
      bsRows.push([`  ${sub.name}`, sub.total])
      for (const item of (sub.items || [])) {
        bsRows.push([`    ${item.name}`, item.amount])
      }
    }
    bsRows.push([`${section.name} 총계`, section.total])
    bsRows.push([])
  }
  const ws2 = XLSX.utils.aoa_to_sheet(bsRows)
  ws2['!cols'] = [{ wch: 35 }, { wch: 18 }]
  XLSX.utils.book_append_sheet(wb, ws2, '재무상태표')

  XLSX.writeFile(wb, `재무제표_${year}년${month ? `_${month}월` : ''}.xlsx`)
}

/** PDF 다운로드 (html2canvas + jsPDF) */
async function downloadPDF(incomeData: any, balanceData: any, year: number, month: number | null) {
  const [{ default: html2canvas }, { jsPDF }] = await Promise.all([
    import('html2canvas'),
    import('jspdf'),
  ])

  const pdf = new jsPDF('p', 'mm', 'a4')
  const PAGE_W = 190, MARGIN = 10, PAGE_H = 277

  async function renderAndAdd(html: string, isFirst: boolean) {
    const div = document.createElement('div')
    div.style.cssText = `position:fixed;left:-9999px;top:0;width:720px;background:#fff;padding:32px;font-family:Pretendard,-apple-system,sans-serif;font-size:12px;color:#222;line-height:1.5;`
    div.innerHTML = html
    document.body.appendChild(div)
    const canvas = await html2canvas(div, { scale: 2, backgroundColor: '#ffffff' })
    document.body.removeChild(div)

    if (!isFirst) pdf.addPage()
    const imgH = canvas.height * PAGE_W / canvas.width
    if (imgH <= PAGE_H) {
      pdf.addImage(canvas, 'PNG', MARGIN, MARGIN, PAGE_W, imgH)
    } else {
      let srcY = 0
      let first = true
      while (srcY < canvas.height) {
        if (!first) pdf.addPage()
        const sliceH = Math.min(canvas.height - srcY, PAGE_H * canvas.width / PAGE_W)
        const sc = document.createElement('canvas')
        sc.width = canvas.width; sc.height = sliceH
        sc.getContext('2d')!.drawImage(canvas, 0, srcY, canvas.width, sliceH, 0, 0, canvas.width, sliceH)
        pdf.addImage(sc, 'PNG', MARGIN, MARGIN, PAGE_W, sliceH * PAGE_W / canvas.width)
        srcY += sliceH; first = false
      }
    }
  }

  // 손익계산서 HTML
  const fmtV = (v: number) => v < 0 ? `(${Math.abs(v).toLocaleString('ko-KR')})` : Math.abs(v).toLocaleString('ko-KR')
  let incHTML = `<div style="text-align:center;margin-bottom:24px;">
    <h1 style="font-size:22px;letter-spacing:10px;margin:0;font-weight:bold;">손 익 계 산 서</h1>
    <p style="font-size:13px;color:#666;margin-top:6px;">주식회사 조인앤조인 | ${year}년 ${month ? `${month}월` : '1월 1일 ~ 12월 31일'}</p>
  </div>
  <table style="width:100%;border-collapse:collapse;">
    <tr style="border-top:3px solid #222;border-bottom:2px solid #222;">
      <th style="text-align:left;padding:8px;width:50px;font-size:12px;">구분</th>
      <th style="text-align:left;padding:8px;font-size:12px;">과 목</th>
      <th style="text-align:right;padding:8px;width:150px;font-size:12px;">금 액</th>
      <th style="text-align:right;padding:8px;width:70px;font-size:12px;">비율(%)</th>
    </tr>`
  for (const s of (incomeData?.sections || [])) {
    for (const i of (s.items || [])) {
      incHTML += `<tr style="border-bottom:1px solid #eee;"><td></td><td style="padding:5px 8px 5px 28px;color:#555;font-size:11px;">${i.name}</td><td style="text-align:right;padding:5px 8px;font-family:monospace;font-size:11px;">${fmtV(i.amount)}</td><td></td></tr>`
    }
    const bg = s.is_subtotal ? 'background:#f3f4f6;' : ''
    const bdr = s.is_subtotal ? 'border-bottom:2px solid #888;' : 'border-bottom:1px solid #ddd;'
    incHTML += `<tr style="${bdr}${bg}"><td style="padding:7px 8px;font-weight:bold;font-size:12px;">${s.id}.</td><td style="padding:7px 8px;font-weight:bold;font-size:12px;">${s.name}</td><td style="text-align:right;padding:7px 8px;font-family:monospace;font-weight:bold;font-size:12px;${s.total < 0 ? 'color:#dc2626;' : ''}">${fmtV(s.total)}</td><td style="text-align:right;padding:7px 8px;color:#888;font-size:11px;">${s.pct !== undefined ? s.pct.toFixed(2) : ''}</td></tr>`
  }
  incHTML += `</table>`

  // 재무상태표 HTML
  let bsHTML = `<div style="text-align:center;margin-bottom:24px;">
    <h1 style="font-size:22px;letter-spacing:10px;margin:0;font-weight:bold;">재 무 상 태 표</h1>
    <p style="font-size:13px;color:#666;margin-top:6px;">주식회사 조인앤조인 | ${year}년 기준</p>
  </div>
  <table style="width:100%;border-collapse:collapse;">
    <tr style="border-top:3px solid #222;border-bottom:2px solid #222;">
      <th style="text-align:left;padding:8px;font-size:12px;">과 목</th>
      <th style="text-align:right;padding:8px;width:170px;font-size:12px;">금 액</th>
    </tr>`
  for (const s of (balanceData?.sections || [])) {
    bsHTML += `<tr style="background:#e5e7eb;border-bottom:1px solid #ccc;"><td colspan="2" style="padding:8px;font-weight:bold;font-size:14px;">${s.name}</td></tr>`
    for (const sub of (s.subsections || [])) {
      bsHTML += `<tr style="border-bottom:1px solid #ddd;"><td style="padding:6px 8px 6px 16px;font-weight:600;font-size:12px;">${sub.name}</td><td style="text-align:right;padding:6px 8px;font-family:monospace;font-weight:600;font-size:12px;">${fmtV(sub.total)}</td></tr>`
      for (const i of (sub.items || [])) {
        bsHTML += `<tr style="border-bottom:1px solid #f0f0f0;"><td style="padding:4px 8px 4px 36px;color:#666;font-size:11px;">${i.name}</td><td style="text-align:right;padding:4px 8px;font-family:monospace;color:#666;font-size:11px;">${fmtV(i.amount)}</td></tr>`
      }
    }
    bsHTML += `<tr style="border-bottom:2px solid #888;background:#f3f4f6;"><td style="padding:8px;font-weight:bold;font-size:12px;">${s.name} 총계</td><td style="text-align:right;padding:8px;font-family:monospace;font-weight:bold;font-size:12px;">${fmtV(s.total)}</td></tr>`
  }
  if (balanceData) {
    bsHTML += `<tr style="border-top:3px solid #222;background:#eff6ff;"><td style="padding:8px;font-weight:bold;font-size:13px;color:#1e40af;">부채 및 자본 총계</td><td style="text-align:right;padding:8px;font-family:monospace;font-weight:bold;font-size:13px;color:#1e40af;">${fmtV((balanceData.total_liabilities ?? 0) + (balanceData.total_equity ?? 0))}</td></tr>`
  }
  bsHTML += `</table>`

  await renderAndAdd(incHTML, true)
  await renderAndAdd(bsHTML, false)
  pdf.save(`재무제표_${year}년${month ? `_${month}월` : ''}.pdf`)
}
const MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]

/** 엑셀 파일에서 [CODE] NAME 또는 (CODE) NAME 매핑 추출 */
function extractAccountMappings(file: File): Promise<Array<{ code: string; name: string }>> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target!.result as ArrayBuffer)
        const workbook = XLSX.read(data, { type: 'array' })
        const mappings: Array<{ code: string; name: string }> = []
        const seen = new Set<string>()

        // 다양한 더존 계정 헤더 패턴
        const patterns = [
          /\[(\d{1,6})\]\s*(.+)/,        // [000101] 보통예금
          /\((\d{1,6})\)\s*(.+)/,        // (000101) 보통예금
          /^(\d{4,6})\s+([가-힣].+)/,    // 000101 보통예금
        ]

        for (const sheetName of workbook.SheetNames) {
          const sheet = workbook.Sheets[sheetName]
          const rows: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' })
          for (const row of rows) {
            for (const cell of row) {
              if (cell != null && cell !== '') {
                const s = String(cell).trim()
                for (const pat of patterns) {
                  const match = s.match(pat)
                  if (match && match[1] && match[2] && !seen.has(match[1])) {
                    const name = match[2].trim()
                    // 이름이 실제 계정명인지 확인 (숫자만 있는 건 제외)
                    if (name && !/^\d+$/.test(name)) {
                      seen.add(match[1])
                      mappings.push({ code: match[1], name })
                    }
                    break
                  }
                }
              }
            }
          }
        }
        resolve(mappings)
      } catch (err) { reject(err) }
    }
    reader.onerror = () => reject(new Error('파일 읽기 실패'))
    reader.readAsArrayBuffer(file)
  })
}

export default function FinancialReportsPage() {
  const [activeTab, setActiveTab] = useState<TabType>('statements')
  const [selectedYear, setSelectedYear] = useState<number | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [syncMsg, setSyncMsg] = useState('')
  const [debugData, setDebugData] = useState<any>(null)
  const [deleting, setDeleting] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const queryClient = useQueryClient()

  const { data: yearsData, isLoading: yearsLoading } = useQuery({
    queryKey: ['financialYears'],
    queryFn: () => financialApi.getAvailableYears().then((r) => r.data),
    staleTime: 3 * 60 * 60 * 1000,  // 3시간 캐시
  })

  /** 엑셀에서 계정명 추출 → DB 보정 */
  const handleSyncNames = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setSyncing(true)
    setSyncMsg('엑셀에서 계정명 추출 중...')
    try {
      const mappings = await extractAccountMappings(file)
      if (mappings.length === 0) {
        setSyncMsg('계정 헤더를 찾을 수 없습니다.')
        return
      }
      setSyncMsg(`${mappings.length}개 계정명 전송 중...`)
      const res = await financialApi.backfillNames(mappings)
      setSyncMsg(`완료! ${res.data.updated_rows}건 보정됨`)
      queryClient.invalidateQueries({ queryKey: ['financialTrialBalance'] })
      queryClient.invalidateQueries({ queryKey: ['financialIncome'] })
      queryClient.invalidateQueries({ queryKey: ['financialBalance'] })
    } catch (err: any) {
      setSyncMsg(`오류: ${err.message}`)
    } finally {
      setSyncing(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const years: number[] = yearsData?.years || []
  const uploads: any[] = yearsData?.uploads || []
  const totalRows = yearsData?.total_raw_rows || 0

  // 연도 자동 선택 (최신 연도)
  const activeYear = selectedYear ?? (years.length > 0 ? years[0] : null)

  const tabs: { id: TabType; label: string }[] = [
    { id: 'statements', label: '손익계산서 / 재무상태표' },
    { id: 'trend', label: '월별 추이' },
    { id: 'trial', label: '시산표' },
    { id: 'ai-analysis', label: 'AI 분석' },
  ]

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">재무보고서</h1>
        <p className="text-gray-500 mt-1">업로드된 전체 데이터 기반 재무제표</p>
      </div>

      {/* 기간 선택 + 데이터 현황 */}
      <div className="card">
        <div className="flex items-center gap-4 flex-wrap">
          <label className="text-sm font-medium text-gray-700">연도 선택</label>
          {yearsLoading ? (
            <span className="text-sm text-gray-400">로딩 중...</span>
          ) : years.length === 0 ? (
            <span className="text-sm text-gray-400">데이터 없음 - AI 분류에서 먼저 데이터를 업로드하세요</span>
          ) : (
            <div className="flex gap-2">
              {years.map((y) => (
                <button
                  key={y}
                  onClick={() => setSelectedYear(y)}
                  className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                    activeYear === y
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                  }`}
                >
                  {y}년
                </button>
              ))}
            </div>
          )}
          {totalRows > 0 && (
            <div className="flex items-center gap-3 ml-auto">
              <span className="text-xs text-gray-400">
                총 {fmtNum(totalRows)}건 | {uploads.length}개 파일 반영
              </span>
              <input ref={fileRef} type="file" accept=".xls,.xlsx" className="hidden"
                onChange={handleSyncNames} />
              <button
                onClick={() => fileRef.current?.click()}
                disabled={syncing}
                className="flex items-center gap-1 px-3 py-1.5 text-xs rounded-lg font-medium bg-gray-100 text-gray-600 hover:bg-gray-200 disabled:opacity-50"
              >
                <ArrowPathIcon className={`h-3.5 w-3.5 ${syncing ? 'animate-spin' : ''}`} />
                계정명 동기화
              </button>
              {activeYear && (
                <button
                  onClick={async () => {
                    if (!confirm(`${activeYear}년 데이터 ${fmtNum(totalRows)}건을 모두 삭제하시겠습니까?\n삭제 후 다시 업로드해야 합니다.`)) return
                    setDeleting(true)
                    try {
                      const res = await aiClassificationApi.deleteDataByYear(activeYear)
                      setSyncMsg(res.data.message)
                      queryClient.invalidateQueries()
                    } catch (err: any) {
                      setSyncMsg(`삭제 오류: ${err.response?.data?.detail || err.message}`)
                    } finally {
                      setDeleting(false)
                    }
                  }}
                  disabled={deleting}
                  className="flex items-center gap-1 px-3 py-1.5 text-xs rounded-lg font-medium bg-red-50 text-red-600 hover:bg-red-100 disabled:opacity-50"
                >
                  {deleting ? '삭제 중...' : '데이터 삭제'}
                </button>
              )}
            </div>
          )}
          {syncMsg && (
            <span className="text-xs text-blue-600 w-full">{syncMsg}</span>
          )}
          {totalRows > 0 && (
            <div className="w-full flex justify-end mt-1">
              <button
                onClick={async () => {
                  try {
                    const res = await financialApi.getDebugData()
                    setDebugData(res.data)
                  } catch (err: any) {
                    setDebugData({ error: err.message })
                  }
                }}
                className="text-xs text-gray-400 hover:text-gray-600 underline"
              >데이터 구조 확인</button>
            </div>
          )}
          {debugData && (
            <div className="w-full mt-2 bg-gray-50 border rounded p-3 text-xs font-mono max-h-80 overflow-auto">
              <div className="flex justify-between mb-2">
                <span className="font-bold text-gray-700">DB 원본 데이터 구조</span>
                <button onClick={() => setDebugData(null)} className="text-gray-400 hover:text-gray-600">닫기</button>
              </div>
              <pre className="whitespace-pre-wrap break-all">{JSON.stringify(debugData, null, 2)}</pre>
            </div>
          )}
        </div>
        {(() => {
          const journalUploads = uploads.filter((u: any) => u.upload_type === 'journal_entry')
          const otherUploads = uploads.filter((u: any) => u.upload_type !== 'journal_entry')
          return (
            <>
              {journalUploads.length > 0 && (
                <div className="mt-3 text-xs text-gray-400">
                  <span className="text-green-600 font-medium">장부 반영 파일:</span>{' '}
                  {journalUploads.slice(0, 5).map((u: any) => u.filename).join(', ')}
                  {journalUploads.length > 5 && ` 외 ${journalUploads.length - 5}개`}
                </div>
              )}
              {otherUploads.length > 0 && (
                <div className="mt-1 text-xs text-gray-400">
                  <span className="text-blue-600 font-medium">학습/분류 데이터:</span>{' '}
                  {otherUploads.slice(0, 3).map((u: any) => u.filename).join(', ')}
                  {otherUploads.length > 3 && ` 외 ${otherUploads.length - 3}개`}
                </div>
              )}
            </>
          )
        })()}
      </div>

      <div className="border-b border-gray-200">
        <nav className="flex gap-4">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`pb-3 px-1 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab.id ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {!activeYear ? (
        <div className="card text-center py-12 text-gray-500">
          <p className="text-lg">데이터를 업로드하세요</p>
          <p className="text-sm mt-1">AI 분류 페이지에서 계정별 원장 파일을 업로드하면 여기에 자동 반영됩니다.</p>
        </div>
      ) : (
        <>
          {activeTab === 'statements' && <StatementsTab year={activeYear} />}
          {activeTab === 'trend' && <TrendTab year={activeYear} />}
          {activeTab === 'trial' && <TrialBalanceTab year={activeYear} />}
          {activeTab === 'ai-analysis' && <AIAnalysisTab year={activeYear} />}
        </>
      )}
    </div>
  )
}

// ============================================================================
// Tab 1: 손익계산서 + 재무상태표
// ============================================================================
function StatementsTab({ year }: { year: number }) {
  const [month, setMonth] = useState<number | null>(null)

  const { data: incomeData, isLoading: incLoading } = useQuery({
    queryKey: ['financialIncome', year, month],
    queryFn: () => financialApi.getIncomeStatement(year, month ?? undefined).then((r) => r.data),
    staleTime: 3 * 60 * 60 * 1000,
  })

  const { data: balanceData, isLoading: balLoading } = useQuery({
    queryKey: ['financialBalance', year],
    queryFn: () => financialApi.getBalanceSheet(year).then((r) => r.data),
    staleTime: 3 * 60 * 60 * 1000,
  })

  if (incLoading || balLoading) return <Loading />

  const sections: any[] = incomeData?.sections || []
  const bsSections: any[] = balanceData?.sections || []

  return (
    <div className="space-y-8 print:space-y-4">
      <div className="card print:hidden">
        <div className="flex items-center gap-3 flex-wrap">
          <label className="text-sm font-medium text-gray-700">월 필터</label>
          <div className="flex gap-1 flex-wrap">
            <button onClick={() => setMonth(null)}
              className={`px-3 py-1.5 text-xs rounded-lg font-medium transition-colors ${
                !month ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}>전체</button>
            {MONTHS.map((m) => (
              <button key={m} onClick={() => setMonth(m)}
                className={`px-3 py-1.5 text-xs rounded-lg font-medium transition-colors ${
                  month === m ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}>{m}월</button>
            ))}
          </div>
          <div className="ml-auto flex gap-2">
            <button onClick={() => downloadStatementsExcel(incomeData, balanceData, year, month)}
              className="flex items-center gap-1 px-3 py-1.5 text-xs rounded-lg font-medium bg-green-50 text-green-700 hover:bg-green-100">
              <ArrowDownTrayIcon className="h-3.5 w-3.5" /> Excel
            </button>
            <button onClick={() => downloadPDF(incomeData, balanceData, year, month)}
              className="flex items-center gap-1 px-3 py-1.5 text-xs rounded-lg font-medium bg-red-50 text-red-700 hover:bg-red-100">
              <ArrowDownTrayIcon className="h-3.5 w-3.5" /> PDF
            </button>
          </div>
        </div>
      </div>

      {/* 손익계산서 */}
      <div className="card" id="print-income">
        <GuideBox title={INCOME_GUIDE.title}>
          <p className="mb-2">{INCOME_GUIDE.summary}</p>
          <p className="text-xs text-blue-600 mt-1">TIP: 비율(%) 열은 매출액 대비 각 항목의 비중을 나타냅니다.</p>
        </GuideBox>
        <div className="text-center border-b-2 border-gray-800 pb-3 mb-4">
          <h2 className="text-xl font-bold text-gray-900 tracking-widest">손 익 계 산 서</h2>
          <p className="text-sm text-gray-500 mt-1">
            {year}년 {month ? `${month}월 1일 ~ ${month}월 말일` : '1월 1일 ~ 12월 31일'}
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b-2 border-gray-800">
                <th className="text-left py-2 px-3 w-16">구분</th>
                <th className="text-left py-2 px-3">과  목</th>
                <th className="text-right py-2 px-3 w-40">금  액</th>
                <th className="text-right py-2 px-3 w-20">비율(%)</th>
              </tr>
            </thead>
            <tbody>
              {sections.map((section: any) => {
                const isSubtotal = section.is_subtotal
                const items: any[] = section.items || []
                return (
                  <SectionGroup key={section.id}>
                    {items.map((item: any, idx: number) => (
                      <tr key={`${section.id}-${idx}`} className="border-b border-gray-100 hover:bg-gray-50">
                        <td className="py-1.5 px-3"></td>
                        <td className="py-1.5 px-3 pl-12 text-gray-700">{item.name}</td>
                        <td className="py-1.5 px-3 text-right font-mono text-gray-700">
                          <ItemAmountTip item={item} />
                        </td>
                        <td className="py-1.5 px-3"></td>
                      </tr>
                    ))}
                    <tr className={`border-b ${isSubtotal ? 'border-gray-400 bg-gray-50' : 'border-gray-200'}`}>
                      <td className={`py-2 px-3 font-bold ${isSubtotal ? 'text-gray-900' : 'text-gray-700'}`}>{section.id}.</td>
                      <td className={`py-2 px-3 font-bold ${isSubtotal ? 'text-gray-900' : 'text-gray-700'}`}>
                        {section.name}
                        {(() => { const tip = INCOME_GUIDE.sections.find((s: any) => s.id === section.id); return tip ? <InfoTip text={tip.tip} /> : null })()}
                      </td>
                      <td className="py-2 px-3 text-right font-mono font-bold">
                        <AmountBreakdown items={items} total={section.total} isSubtotal={isSubtotal} />
                      </td>
                      <td className="py-2 px-3 text-right font-mono text-gray-500">
                        {section.pct !== undefined ? section.pct.toFixed(2) : ''}
                      </td>
                    </tr>
                  </SectionGroup>
                )
              })}
            </tbody>
          </table>
        </div>
        {sections.length === 0 && <div className="text-center py-8 text-gray-400">해당 기간의 데이터가 없습니다.</div>}
      </div>

      <hr className="border-gray-300" />

      {/* 재무상태표 */}
      <div className="card" id="print-balance">
        <GuideBox title={BALANCE_GUIDE.title}>
          <p className="mb-2">{BALANCE_GUIDE.summary}</p>
          <p className="font-semibold text-blue-700 text-xs mt-1">{BALANCE_GUIDE.formula}</p>
        </GuideBox>
        <div className="text-center border-b-2 border-gray-800 pb-3 mb-4">
          <h2 className="text-xl font-bold text-gray-900 tracking-widest">재 무 상 태 표</h2>
          <p className="text-sm text-gray-500 mt-1">{year}년 기준</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b-2 border-gray-800">
                <th className="text-left py-2 px-3">과  목</th>
                <th className="text-right py-2 px-3 w-44">금  액</th>
              </tr>
            </thead>
            <tbody>
              {bsSections.map((section: any) => (
                <SectionGroup key={section.id}>
                  <tr className="bg-gray-100 border-b border-gray-300">
                    <td colSpan={2} className="py-2 px-3 font-bold text-gray-900 text-base">{section.name}</td>
                  </tr>
                  {(section.subsections || []).map((sub: any, si: number) => (
                    <SectionGroup key={si}>
                      <tr className="border-b border-gray-200">
                        <td className="py-1.5 px-3 pl-6 font-semibold text-gray-800">
                          {sub.name}
                          {(() => { const tip = BALANCE_GUIDE.sections.find((s: any) => s.name === sub.name); return tip ? <InfoTip text={tip.tip} /> : null })()}
                        </td>
                        <td className="py-1.5 px-3 text-right font-mono font-semibold text-gray-800">
                          <AmountBreakdown items={sub.items || []} total={sub.total} />
                        </td>
                      </tr>
                      {(sub.items || []).map((item: any, idx: number) => (
                        <tr key={idx} className="border-b border-gray-100 hover:bg-gray-50">
                          <td className="py-1 px-3 pl-12 text-gray-600">{item.name}</td>
                          <td className="py-1 px-3 text-right font-mono text-gray-600">
                            <ItemAmountTip item={item} />
                          </td>
                        </tr>
                      ))}
                    </SectionGroup>
                  ))}
                  <tr className="border-b-2 border-gray-400 bg-gray-50">
                    <td className="py-2 px-3 font-bold text-gray-900">{section.name} 총계</td>
                    <td className="py-2 px-3 text-right font-mono font-bold text-gray-900">{fmtAmount(section.total)}</td>
                  </tr>
                </SectionGroup>
              ))}
              {bsSections.length > 0 && (
                <tr className="border-t-2 border-gray-800 bg-blue-50">
                  <td className="py-2 px-3 font-bold text-blue-800">부채 및 자본 총계</td>
                  <td className="py-2 px-3 text-right font-mono font-bold text-blue-800">
                    {fmtAmount((balanceData?.total_liabilities ?? 0) + (balanceData?.total_equity ?? 0))}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {bsSections.length === 0 && <div className="text-center py-8 text-gray-400">데이터가 없습니다.</div>}
      </div>
    </div>
  )
}

function SectionGroup({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}

// ============================================================================
// Tab 2: 월별 추이
// ============================================================================
function TrendTab({ year }: { year: number }) {
  const { data: trend, isLoading } = useQuery({
    queryKey: ['financialTrend', year],
    queryFn: () => financialApi.getMonthlyTrend(year).then((r) => r.data),
    staleTime: 3 * 60 * 60 * 1000,
  })

  if (isLoading) return <Loading />

  const trendData = (trend?.data || []).map((m: any) => ({
    month: m.month?.replace(/^\d{4}-0?/, '') + '월',
    차변: m.debit_total,
    대변: m.credit_total,
    순액: m.net,
    건수: m.tx_count,
  }))

  const totalDebit = trendData.reduce((s: number, m: any) => s + m.차변, 0)
  const totalCredit = trendData.reduce((s: number, m: any) => s + m.대변, 0)

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="card">
          <p className="text-sm text-gray-500">연간 총 차변</p>
          <p className="text-xl font-bold text-blue-600">{fmt(totalDebit)}</p>
        </div>
        <div className="card">
          <p className="text-sm text-gray-500">연간 총 대변</p>
          <p className="text-xl font-bold text-red-600">{fmt(totalCredit)}</p>
        </div>
        <div className="card">
          <p className="text-sm text-gray-500">연간 순액</p>
          <p className={`text-xl font-bold ${totalDebit - totalCredit >= 0 ? 'text-green-600' : 'text-red-600'}`}>
            {fmt(totalDebit - totalCredit)}
          </p>
        </div>
      </div>

      <div className="card">
        <h3 className="text-sm font-semibold text-gray-700 mb-4">월별 차변 / 대변</h3>
        <div className="h-80">
          {trendData.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={trendData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="month" fontSize={12} />
                <YAxis fontSize={11} tickFormatter={(v: number) => `${(v / 10000).toFixed(0)}만`} />
                <Tooltip formatter={(v: number) => fmt(v)} />
                <Legend />
                <Bar dataKey="차변" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                <Bar dataKey="대변" fill="#ef4444" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : <Empty />}
        </div>
      </div>

      <div className="card">
        <h3 className="text-sm font-semibold text-gray-700 mb-4">월별 순액 추이</h3>
        <div className="h-64">
          {trendData.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={trendData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="month" fontSize={12} />
                <YAxis fontSize={11} tickFormatter={(v: number) => `${(v / 10000).toFixed(0)}만`} />
                <Tooltip formatter={(v: number) => fmt(v)} />
                <Line type="monotone" dataKey="순액" stroke="#10b981" strokeWidth={2} dot={{ r: 4 }} />
              </LineChart>
            </ResponsiveContainer>
          ) : <Empty />}
        </div>
      </div>

      <div className="card">
        <h3 className="text-sm font-semibold text-gray-700 mb-3">월별 상세</h3>
        {trendData.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="table w-full text-sm">
              <thead className="table-header">
                <tr><th>월</th><th className="text-right">차변</th><th className="text-right">대변</th><th className="text-right">순액</th><th className="text-right">건수</th></tr>
              </thead>
              <tbody className="table-body">
                {trendData.map((m: any, i: number) => (
                  <tr key={i}>
                    <td className="font-medium">{m.month}</td>
                    <td className="amount text-blue-600">{fmt(m.차변)}</td>
                    <td className="amount text-red-600">{fmt(m.대변)}</td>
                    <td className={`amount font-bold ${m.순액 >= 0 ? 'text-green-600' : 'text-red-600'}`}>{fmt(m.순액)}</td>
                    <td className="text-right text-gray-500">{fmtNum(m.건수)}</td>
                  </tr>
                ))}
                <tr className="bg-gray-100 font-bold border-t-2">
                  <td>합계</td>
                  <td className="amount text-blue-700">{fmt(totalDebit)}</td>
                  <td className="amount text-red-700">{fmt(totalCredit)}</td>
                  <td className={`amount ${totalDebit - totalCredit >= 0 ? 'text-green-700' : 'text-red-700'}`}>{fmt(totalDebit - totalCredit)}</td>
                  <td className="text-right text-gray-500">{fmtNum(trendData.reduce((s: number, m: any) => s + m.건수, 0))}</td>
                </tr>
              </tbody>
            </table>
          </div>
        ) : <Empty />}
      </div>
    </div>
  )
}

// ============================================================================
// Tab 3: 시산표
// ============================================================================
function TrialBalanceTab({ year }: { year: number }) {
  const [search, setSearch] = useState('')
  const [selectedAccount, setSelectedAccount] = useState<string | null>(null)
  const [detailPage, setDetailPage] = useState(1)
  const [selectedMonth, setSelectedMonth] = useState<number | null>(null)
  // 상단 고정 그래프용 계정
  const [chartAccount, setChartAccount] = useState<string | null>(null)
  // AI 분개 점검용 체크박스 상태
  const [checkedAccounts, setCheckedAccounts] = useState<Set<string>>(new Set())
  const [checkLoading, setCheckLoading] = useState(false)
  const [checkResult, setCheckResult] = useState<any>(null)
  const [checkError, setCheckError] = useState('')
  const [checkElapsed, setCheckElapsed] = useState(0)

  // 시산표 (월 선택 시 해당 월만 조회)
  const { data: trialData, isLoading } = useQuery({
    queryKey: ['financialTrialBalance', year, selectedMonth],
    queryFn: () => financialApi.getTrialBalance(year, selectedMonth || undefined).then((r) => r.data),
    staleTime: 3 * 60 * 60 * 1000,
  })

  // 선택된 계정의 상세 내역 (월 필터 포함)
  const { data: detailData, isLoading: detailLoading } = useQuery({
    queryKey: ['financialAccountDetail', year, selectedAccount, detailPage, selectedMonth],
    queryFn: () => financialApi.getAccountDetail(selectedAccount!, year, detailPage, 30, selectedMonth || undefined).then((r) => r.data),
    enabled: !!selectedAccount,
    staleTime: 3 * 60 * 60 * 1000,
  })

  // 선택된 계정의 월별 추이 (상단 고정 그래프)
  const { data: chartTrendData } = useQuery({
    queryKey: ['financialAccountTrend', year, chartAccount],
    queryFn: () => financialApi.getMonthlyTrend(year, chartAccount!).then((r) => r.data),
    enabled: !!chartAccount,
    staleTime: 3 * 60 * 60 * 1000,
  })

  const items: any[] = trialData?.items || []

  const filtered = useMemo(() => {
    if (!search.trim()) return items
    const kw = search.toLowerCase()
    return items.filter((a: any) =>
      a.account_code.toLowerCase().includes(kw) ||
      a.account_name.toLowerCase().includes(kw) ||
      (a.category_name || '').toLowerCase().includes(kw)
    )
  }, [items, search])

  const CATEGORY_COLORS: Record<string, string> = {
    '자산': 'bg-green-50 text-green-700',
    '부채': 'bg-orange-50 text-orange-700',
    '자본': 'bg-purple-50 text-purple-700',
    '수익': 'bg-blue-50 text-blue-700',
    '매출원가': 'bg-red-50 text-red-700',
    '판관비': 'bg-red-50 text-red-700',
    '비용': 'bg-red-50 text-red-700',
    '영업외': 'bg-yellow-50 text-yellow-700',
  }

  const grouped = useMemo(() => {
    const groups: Record<string, { name: string; items: any[] }> = {}
    for (const item of filtered) {
      const catName = item.category_name || '미분류'
      if (!groups[catName]) groups[catName] = { name: catName, items: [] }
      groups[catName].items.push(item)
    }
    const order = ['자산', '부채', '자본', '수익', '매출원가', '판관비', '비용', '영업외', '미분류']
    return Object.entries(groups).sort(([a], [b]) => {
      const ai = order.indexOf(a) === -1 ? 99 : order.indexOf(a)
      const bi = order.indexOf(b) === -1 ? 99 : order.indexOf(b)
      return ai - bi
    })
  }, [filtered])

  const totals = useMemo(() =>
    filtered.reduce((acc: any, a: any) => ({
      debit: acc.debit + (a.debit_total || 0),
      credit: acc.credit + (a.credit_total || 0),
    }), { debit: 0, credit: 0 }),
  [filtered])

  if (isLoading) return <Loading />

  return (
    <div className="space-y-4">
      {/* 검색 + 월 선택 바 */}
      <div className="card">
        <div className="flex items-center gap-2 mb-3">
          <MagnifyingGlassIcon className="h-5 w-5 text-gray-400" />
          <input type="text" placeholder="계정코드, 계정명, 카테고리 검색..." value={search}
            onChange={(e) => setSearch(e.target.value)} className="input flex-1" />
        </div>
        <div className="flex items-center gap-1 flex-wrap">
          <span className="text-xs text-gray-500 mr-1">월:</span>
          <button
            onClick={() => setSelectedMonth(null)}
            className={`px-3 py-1.5 text-xs rounded-lg font-medium transition-colors ${
              selectedMonth === null ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >전체</button>
          {Array.from({ length: 12 }, (_, i) => i + 1).map(m => (
            <button
              key={m}
              onClick={() => setSelectedMonth(selectedMonth === m ? null : m)}
              className={`px-3 py-1.5 text-xs rounded-lg font-medium transition-colors ${
                selectedMonth === m ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >{m}월</button>
          ))}
        </div>
      </div>

      {/* 상단 고정 그래프: 선택한 계정의 월별 추이 */}
      {chartAccount && chartTrendData?.data && (
        <div className="card">
          <div className="flex justify-between items-center mb-3">
            <h3 className="text-sm font-semibold text-gray-700">
              {chartAccount} {items.find((a: any) => a.account_code === chartAccount)?.account_name || ''} — 월별 추이 ({year}년)
            </h3>
            <div className="flex items-center gap-2">
              <button
                onClick={async () => {
                  try {
                    const res = await financialApi.exportAccountDetailExcel(chartAccount, year)
                    const blob = new Blob([res.data])
                    const url = URL.createObjectURL(blob)
                    const a = document.createElement('a')
                    a.href = url
                    a.download = `분개내역_${chartAccount}_${year}.xlsx`
                    a.click()
                    URL.revokeObjectURL(url)
                  } catch { toast.error('엑셀 다운로드 실패') }
                }}
                className="px-2.5 py-1 text-xs bg-green-600 text-white rounded hover:bg-green-700"
              >엑셀</button>
              <button onClick={() => setChartAccount(null)} className="text-gray-400 hover:text-gray-600 text-sm">✕ 닫기</button>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={chartTrendData.data}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="month" tickFormatter={(v: string) => v.split('-')[1] + '월'} tick={{ fontSize: 11 }} />
                <YAxis tickFormatter={(v: number) => v >= 10000 ? (v / 10000).toFixed(0) + '만' : v.toLocaleString()} tick={{ fontSize: 10 }} />
                <Tooltip formatter={(v: number) => v.toLocaleString() + '원'} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="debit_total" name="차변" fill="#3B82F6" />
                <Bar dataKey="credit_total" name="대변" fill="#EF4444" />
              </BarChart>
            </ResponsiveContainer>
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={chartTrendData.data}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="month" tickFormatter={(v: string) => v.split('-')[1] + '월'} tick={{ fontSize: 11 }} />
                <YAxis tickFormatter={(v: number) => v >= 10000 ? (v / 10000).toFixed(0) + '만' : v.toLocaleString()} tick={{ fontSize: 10 }} />
                <Tooltip formatter={(v: number) => v.toLocaleString() + '원'} />
                <Line type="monotone" dataKey="net" name="잔액" stroke="#10B981" strokeWidth={2} dot />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      <div className="card">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-gray-700">
            시산표 ({fmtNum(filtered.length)}개 계정)
            {selectedMonth && <span className="text-blue-600 ml-1">— {selectedMonth}월</span>}
          </h3>
          {checkedAccounts.size > 0 && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-teal-700 bg-teal-50 px-2 py-1 rounded">{checkedAccounts.size}개 계정 선택됨</span>
              <button
                onClick={async () => {
                  setCheckLoading(true)
                  setCheckError('')
                  setCheckResult(null)
                  setCheckElapsed(0)
                  const t0 = Date.now()
                  const timer = setInterval(() => setCheckElapsed(Math.floor((Date.now() - t0) / 1000)), 1000)
                  try {
                    const res = await financialApi.getAIAccountCheck(year, Array.from(checkedAccounts))
                    setCheckResult(res.data)
                  } catch (err: any) {
                    setCheckError(err.response?.data?.detail || err.message)
                  } finally {
                    clearInterval(timer)
                    setCheckLoading(false)
                  }
                }}
                disabled={checkLoading}
                className="flex items-center gap-1 px-3 py-1.5 text-xs rounded-lg font-medium bg-teal-600 text-white hover:bg-teal-700 disabled:opacity-50 transition-colors"
              >
                {checkLoading ? (
                  <><ArrowPathIcon className="h-3.5 w-3.5 animate-spin" /> AI 점검 중... ({checkElapsed}초)</>
                ) : (
                  <><SparklesIcon className="h-3.5 w-3.5" /> AI 분개 점검</>
                )}
              </button>
              <button onClick={() => { setCheckedAccounts(new Set()); setCheckResult(null); setCheckError('') }}
                className="text-xs text-gray-500 hover:text-gray-700">선택 해제</button>
            </div>
          )}
        </div>
        {grouped.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="table w-full text-sm">
              <thead className="table-header">
                <tr>
                  <th className="w-8 text-center">
                    <input type="checkbox"
                      checked={filtered.length > 0 && checkedAccounts.size === filtered.length}
                      ref={(el) => { if (el) el.indeterminate = checkedAccounts.size > 0 && checkedAccounts.size < filtered.length }}
                      onChange={(e) => {
                        if (e.target.checked) setCheckedAccounts(new Set(filtered.map((a: any) => a.account_code)))
                        else setCheckedAccounts(new Set())
                      }}
                      className="rounded border-gray-300"
                    />
                  </th>
                  <th>계정코드</th><th>계정명</th><th>카테고리</th>
                  <th className="text-right">차변합계</th><th className="text-right">대변합계</th>
                  <th className="text-right">잔액</th><th className="text-right">건수</th>
                </tr>
              </thead>
              <tbody className="table-body">
                {grouped.map(([catName, group]) => (
                  <SectionGroup key={catName}>
                    <tr className={CATEGORY_COLORS[catName] || 'bg-gray-50 text-gray-700'}>
                      <td colSpan={8} className="font-bold text-xs py-1">{group.name} ({group.items.length}개)</td>
                    </tr>
                    {group.items.map((a: any) => (
                      <>
                        <tr key={a.account_code} className={`cursor-pointer hover:bg-blue-50 ${checkedAccounts.has(a.account_code) ? 'bg-teal-50' : ''} ${chartAccount === a.account_code ? 'bg-blue-50 ring-1 ring-blue-300' : ''}`}
                          onClick={() => {
                            setChartAccount(chartAccount === a.account_code ? null : a.account_code)
                            setSelectedAccount(a.account_code)
                            setDetailPage(1)
                          }}>
                          <td className="text-center" onClick={(e) => e.stopPropagation()}>
                            <input type="checkbox"
                              checked={checkedAccounts.has(a.account_code)}
                              onChange={(e) => {
                                setCheckedAccounts(prev => {
                                  const next = new Set(prev)
                                  if (e.target.checked) next.add(a.account_code)
                                  else next.delete(a.account_code)
                                  return next
                                })
                              }}
                              className="rounded border-gray-300"
                            />
                          </td>
                          <td className="text-gray-500 font-mono text-xs pl-2">{a.account_code}</td>
                          <td className="font-medium">{a.account_name}</td>
                          <td className="text-xs text-gray-400">{a.category_name || '미분류'}</td>
                          <td className="amount">{fmt(a.debit_total)}</td>
                          <td className="amount">{fmt(a.credit_total)}</td>
                          <td className={`amount font-bold ${a.balance >= 0 ? 'text-blue-600' : 'text-red-600'}`}>{fmt(a.balance)}</td>
                          <td className="text-right text-gray-500">{fmtNum(a.tx_count)}</td>
                        </tr>
                      </>
                    ))}
                  </SectionGroup>
                ))}
                <tr className="bg-gray-100 font-bold border-t-2 border-gray-300">
                  <td></td>
                  <td colSpan={3} className="text-right">합계</td>
                  <td className="amount">{fmt(totals.debit)}</td>
                  <td className="amount">{fmt(totals.credit)}</td>
                  <td className={`amount ${totals.debit - totals.credit >= 0 ? 'text-blue-600' : 'text-red-600'}`}>{fmt(totals.debit - totals.credit)}</td>
                  <td></td>
                </tr>
              </tbody>
            </table>
          </div>
        ) : <div className="text-center py-8 text-gray-400">데이터가 없습니다.</div>}
      </div>

      {/* AI 분개 점검 결과 */}
      {checkLoading && (
        <div className="card text-center py-12">
          <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-teal-600 mx-auto" />
          <p className="text-gray-500 mt-3">AI(Claude)가 선택된 계정의 분개를 점검하고 있습니다...</p>
          <p className="text-xs text-gray-400 mt-1">계정 수에 따라 1~3분 소요 ({checkElapsed}초 경과)</p>
        </div>
      )}
      {checkError && (
        <div className="card p-4 bg-red-50 border border-red-200 text-sm text-red-700">{checkError}</div>
      )}
      {checkResult && !checkLoading && (
        <div className="card space-y-4">
          <h3 className="text-sm font-bold text-gray-900 flex items-center gap-2">
            <SparklesIcon className="h-4 w-4 text-teal-600" /> AI 분개 점검 결과
          </h3>
          {checkResult.analysis?.overall_summary && (
            <div className="p-3 bg-gray-50 rounded-lg text-sm text-gray-700">{checkResult.analysis.overall_summary}</div>
          )}
          {(checkResult.analysis?.accounts || []).map((acct: any, idx: number) => (
            <div key={idx} className={`border rounded-lg overflow-hidden ${
              acct.status === '정상' ? 'border-green-200' : acct.status === '문제발견' ? 'border-red-200' : 'border-yellow-200'
            }`}>
              <div className={`px-4 py-2.5 flex items-center justify-between ${
                acct.status === '정상' ? 'bg-green-50' : acct.status === '문제발견' ? 'bg-red-50' : 'bg-yellow-50'
              }`}>
                <span className="font-bold text-sm">{acct.code} - {acct.name}</span>
                <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                  acct.status === '정상' ? 'bg-green-200 text-green-800' : acct.status === '문제발견' ? 'bg-red-200 text-red-800' : 'bg-yellow-200 text-yellow-800'
                }`}>{acct.status}</span>
              </div>
              <div className="p-4 space-y-2">
                {acct.summary && <p className="text-sm text-gray-700">{acct.summary}</p>}
                {(acct.findings || []).map((f: any, fi: number) => (
                  <div key={fi} className={`p-3 rounded text-sm border ${
                    f.severity === 'high' ? 'border-red-200 bg-red-50' : f.severity === 'medium' ? 'border-yellow-200 bg-yellow-50' : 'border-gray-200 bg-gray-50'
                  }`}>
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${
                        f.severity === 'high' ? 'bg-red-200 text-red-800' : f.severity === 'medium' ? 'bg-yellow-200 text-yellow-800' : 'bg-gray-200 text-gray-700'
                      }`}>{f.severity === 'high' ? '높음' : f.severity === 'medium' ? '보통' : '낮음'}</span>
                      <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${
                        ['fund_leakage','intentional_error','round_tripping','ghost_vendor'].includes(f.type)
                          ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-600'
                      }`}>{{
                        misclassification: '계정 오분류',
                        duplicate: '중복 분개',
                        unusual_amount: '비정상 금액',
                        wrong_counterpart: '상대계정 부적절',
                        fund_leakage: '자금 유출 의심',
                        wrong_transfer: '이체 오류',
                        intentional_error: '의도적 실수 의심',
                        round_tripping: '회전거래 의심',
                        ghost_vendor: '유령 거래처 의심',
                        internal_control: '내부통제 취약',
                      }[f.type as string] || f.type}</span>
                    </div>
                    <p className="text-gray-800">{f.description}</p>
                    {f.transaction_detail && <p className="text-xs text-gray-500 mt-1">관련 거래: {f.transaction_detail}</p>}
                    {f.recommendation && <p className="text-xs text-blue-600 mt-1">권장: {f.recommendation}</p>}
                  </div>
                ))}
                {(!acct.findings || acct.findings.length === 0) && <p className="text-sm text-green-600">이상 없음</p>}
              </div>
            </div>
          ))}
          {checkResult.generated_at && (
            <p className="text-xs text-gray-400 text-right">점검 시각: {new Date(checkResult.generated_at).toLocaleString('ko-KR')}</p>
          )}
        </div>
      )}

      {selectedAccount && (
        <DetailModal
          accountCode={selectedAccount}
          accountName={items.find((a: any) => a.account_code === selectedAccount)?.account_name || ''}
          data={detailData}
          isLoading={detailLoading}
          page={detailPage}
          onPageChange={setDetailPage}
          onClose={() => { setSelectedAccount(null); setSelectedMonth(null) }}
          year={year}
          selectedMonth={selectedMonth}
        />
      )}


      <style>{`
        @media print {
          .no-print { display: none !important; }
          body { font-size: 12px; }
          table { page-break-inside: auto; }
          tr { page-break-inside: avoid; }
        }
      `}</style>
    </div>
  )
}

// ============================================================================
// Detail Modal
// ============================================================================
function DetailModal({ accountCode, accountName, data, isLoading, page, onPageChange, onClose, year, selectedMonth }: {
  accountCode: string; accountName: string; data: any; isLoading: boolean
  page: number; onPageChange: (p: number) => void; onClose: () => void
  year?: number; selectedMonth?: number | null
}) {
  const items: any[] = data?.items || []
  const totalPages = data?.total_pages || 1
  const summary = data?.summary || {}

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl w-full max-w-5xl max-h-[80vh] flex flex-col mx-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between p-5 border-b">
          <div>
            <h3 className="text-lg font-bold">
              {accountCode} - {accountName}
              {selectedMonth && <span className="text-blue-600 ml-2 font-normal text-base">({selectedMonth}월)</span>}
            </h3>
            <p className="text-sm text-gray-500">
              차변: {fmt(summary.debit_total || 0)} | 대변: {fmt(summary.credit_total || 0)} | 잔액: {fmt(summary.balance || 0)}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={async () => {
                try {
                  const res = await financialApi.exportAccountDetailExcel(accountCode, year, selectedMonth || undefined)
                  const blob = new Blob([res.data])
                  const url = URL.createObjectURL(blob)
                  const a = document.createElement('a')
                  a.href = url
                  a.download = `분개내역_${accountCode}_${year || 'all'}${selectedMonth ? '_' + selectedMonth + '월' : ''}.xlsx`
                  a.click()
                  URL.revokeObjectURL(url)
                } catch { toast.error('엑셀 다운로드 실패') }
              }}
              className="px-3 py-1.5 text-sm bg-green-600 text-white rounded hover:bg-green-700"
            >
              엑셀 다운로드
            </button>
            <button
              onClick={() => window.print()}
              className="px-3 py-1.5 text-sm border border-gray-300 rounded hover:bg-gray-50"
            >
              인쇄
            </button>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><XMarkIcon className="h-6 w-6" /></button>
          </div>
        </div>
        <div className="flex-1 overflow-auto p-5">
          {isLoading ? <Loading /> : items.length > 0 ? (
            <table className="table w-full text-sm">
              <thead className="table-header"><tr><th>날짜</th><th>적요</th><th>거래처</th><th className="text-right">차변</th><th className="text-right">대변</th></tr></thead>
              <tbody className="table-body">
                {items.map((item: any, i: number) => (
                  <tr key={i}>
                    <td className="text-gray-500">{item.transaction_date || '-'}</td>
                    <td className="font-medium">{item.description}</td>
                    <td className="text-gray-500">{item.merchant_name || '-'}</td>
                    <td className="amount">{item.debit_amount ? fmt(item.debit_amount) : '-'}</td>
                    <td className="amount">{item.credit_amount ? fmt(item.credit_amount) : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <div className="text-center py-8 text-gray-400">거래 내역 없음</div>}
        </div>
        {totalPages > 1 && (
          <div className="flex items-center justify-center gap-3 p-4 border-t">
            <button onClick={() => onPageChange(page - 1)} disabled={page <= 1} className="btn-secondary text-sm disabled:opacity-50">이전</button>
            <span className="text-sm text-gray-600">{page} / {totalPages}</span>
            <button onClick={() => onPageChange(page + 1)} disabled={page >= totalPages} className="btn-secondary text-sm disabled:opacity-50">다음</button>
          </div>
        )}
      </div>
    </div>
  )
}

// ============================================================================
// Tab 4: AI 분석
// ============================================================================
const AI_CATEGORIES = [
  { key: 'financial_improvements', title: '재무적으로 개선할 점', color: 'blue', icon: '📊' },
  { key: 'pl_improvements', title: '손익에서 개선할 점', color: 'green', icon: '📈' },
  { key: 'account_notable', title: '계정별 과목 특이사항', color: 'yellow', icon: '🔍' },
  { key: 'accounting_concerns', title: '회계적 우려 및 확인 사항', color: 'red', icon: '⚠️' },
] as const

const AI_CACHE_TTL = 3 * 60 * 60 * 1000  // 3시간
function getAICache(year: number, month: number | null) {
  try {
    const key = `ai_analysis_${year}_${month ?? 'all'}`
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const { data, ts } = JSON.parse(raw)
    if (Date.now() - ts > AI_CACHE_TTL) { localStorage.removeItem(key); return null }
    return data
  } catch { return null }
}
function setAICache(year: number, month: number | null, data: any) {
  try {
    const key = `ai_analysis_${year}_${month ?? 'all'}`
    localStorage.setItem(key, JSON.stringify({ data, ts: Date.now() }))
  } catch { /* quota exceeded 무시 */ }
}

function AIAnalysisTab({ year }: { year: number }) {
  const [analysisData, setAnalysisData] = useState<any>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [expandedCat, setExpandedCat] = useState<string | null>(null)
  const [selectedMonth, setSelectedMonth] = useState<number | null>(null)
  const [cachedAt, setCachedAt] = useState<string | null>(null)
  const [elapsed, setElapsed] = useState(0)

  // 분석 모드: 'full' = 전체 분석, 'account-check' = 선택 계정 분개 점검
  const [analysisMode, setAnalysisMode] = useState<'full' | 'account-check'>('full')
  // 계정 분개 점검용 상태
  const [selectedAccountCodes, setSelectedAccountCodes] = useState<string[]>([])
  const [accountCheckData, setAccountCheckData] = useState<any>(null)
  const [accountCheckLoading, setAccountCheckLoading] = useState(false)
  const [accountCheckError, setAccountCheckError] = useState('')
  const [accountCheckElapsed, setAccountCheckElapsed] = useState(0)
  const [accountSearchTerm, setAccountSearchTerm] = useState('')

  // 시산표 데이터 로드 (계정 목록용)
  const { data: trialData } = useQuery({
    queryKey: ['financialTrialBalance', year],
    queryFn: () => financialApi.getTrialBalance(year).then((r) => r.data),
    staleTime: 3 * 60 * 60 * 1000,
  })
  const trialItems: any[] = trialData?.items || []

  // 계정 검색 필터
  const filteredTrialItems = useMemo(() => {
    if (!accountSearchTerm.trim()) return trialItems
    const kw = accountSearchTerm.toLowerCase()
    return trialItems.filter((a: any) =>
      a.account_code.toLowerCase().includes(kw) ||
      a.account_name.toLowerCase().includes(kw) ||
      (a.category_name || '').toLowerCase().includes(kw)
    )
  }, [trialItems, accountSearchTerm])

  // 캐시 자동 로드
  useMemo(() => {
    const cached = getAICache(year, selectedMonth)
    if (cached) {
      setAnalysisData(cached)
      setExpandedCat(AI_CATEGORIES[0].key)
      setCachedAt(cached.generated_at)
    } else {
      setAnalysisData(null)
      setCachedAt(null)
    }
    setError('')
  }, [year, selectedMonth])

  const runAnalysis = async (force = false) => {
    if (!force) {
      const cached = getAICache(year, selectedMonth)
      if (cached) { setAnalysisData(cached); setExpandedCat(AI_CATEGORIES[0].key); setCachedAt(cached.generated_at); return }
    }
    setLoading(true)
    setError('')
    setAnalysisData(null)
    setCachedAt(null)
    setElapsed(0)
    const t0 = Date.now()
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 1000)
    try {
      const res = await financialApi.getAIAnalysis(year, selectedMonth ?? undefined)
      setAnalysisData(res.data)
      setExpandedCat(AI_CATEGORIES[0].key)
      setAICache(year, selectedMonth, res.data)
      setCachedAt(null)
    } catch (err: any) {
      const detail = err.response?.data?.detail || err.message
      setError(detail)
    } finally {
      clearInterval(timer)
      setLoading(false)
    }
  }

  const runAccountCheck = async () => {
    if (selectedAccountCodes.length === 0) {
      setAccountCheckError('점검할 계정과목을 1개 이상 선택해주세요.')
      return
    }
    setAccountCheckLoading(true)
    setAccountCheckError('')
    setAccountCheckData(null)
    setAccountCheckElapsed(0)
    const t0 = Date.now()
    const timer = setInterval(() => setAccountCheckElapsed(Math.floor((Date.now() - t0) / 1000)), 1000)
    try {
      const res = await financialApi.getAIAccountCheck(year, selectedAccountCodes)
      setAccountCheckData(res.data)
    } catch (err: any) {
      const detail = err.response?.data?.detail || err.message
      setAccountCheckError(detail)
    } finally {
      clearInterval(timer)
      setAccountCheckLoading(false)
    }
  }

  const toggleAccountCode = (code: string) => {
    setSelectedAccountCodes(prev =>
      prev.includes(code) ? prev.filter(c => c !== code) : [...prev, code]
    )
  }

  const analysis = analysisData?.analysis

  const colorMap: Record<string, string> = {
    blue: 'border-blue-200 bg-blue-50',
    green: 'border-green-200 bg-green-50',
    yellow: 'border-yellow-200 bg-yellow-50',
    red: 'border-red-200 bg-red-50',
  }
  const headerColorMap: Record<string, string> = {
    blue: 'text-blue-800 bg-blue-100',
    green: 'text-green-800 bg-green-100',
    yellow: 'text-yellow-800 bg-yellow-100',
    red: 'text-red-800 bg-red-100',
  }

  return (
    <div className="space-y-6">
      <div className="card">
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div>
            <h3 className="text-lg font-bold text-gray-900 flex items-center gap-2">
              <SparklesIcon className="h-5 w-5 text-purple-500" />
              AI 재무 분석
            </h3>
            <p className="text-sm text-gray-500 mt-1">
              {year}년{selectedMonth ? ` ${selectedMonth}월` : ''} 재무 데이터를 AI(Claude Opus)가 분석합니다.
            </p>
          </div>
        </div>

        {/* 분석 모드 선택 */}
        <div className="mt-4 flex items-center gap-3">
          <label className="text-sm font-medium text-gray-700">분석 모드</label>
          <div className="flex gap-1">
            <button onClick={() => setAnalysisMode('full')}
              className={`px-4 py-1.5 text-xs rounded-lg font-medium transition-colors ${
                analysisMode === 'full' ? 'bg-purple-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}>전체 분석</button>
            <button onClick={() => setAnalysisMode('account-check')}
              className={`px-4 py-1.5 text-xs rounded-lg font-medium transition-colors ${
                analysisMode === 'account-check' ? 'bg-teal-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}>선택 계정 분개 점검</button>
          </div>
        </div>

        {/* 전체 분석 모드 UI */}
        {analysisMode === 'full' && (
          <>
            <div className="mt-4 flex items-center justify-between flex-wrap gap-3">
              <div className="flex items-center gap-3 flex-wrap">
                <label className="text-sm font-medium text-gray-700">분석 기간</label>
                <div className="flex gap-1 flex-wrap">
                  <button onClick={() => setSelectedMonth(null)}
                    className={`px-3 py-1.5 text-xs rounded-lg font-medium transition-colors ${
                      !selectedMonth ? 'bg-purple-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                    }`}>연간 전체</button>
                  {MONTHS.map((m) => (
                    <button key={m} onClick={() => setSelectedMonth(m)}
                      className={`px-3 py-1.5 text-xs rounded-lg font-medium transition-colors ${
                        selectedMonth === m ? 'bg-purple-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                      }`}>{m}월</button>
                  ))}
                </div>
              </div>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => runAnalysis(false)}
                  disabled={loading}
                  className="flex items-center gap-2 px-5 py-2.5 rounded-lg font-medium text-white bg-purple-600 hover:bg-purple-700 disabled:opacity-50 transition-colors"
                >
                  {loading ? (
                    <><ArrowPathIcon className="h-4 w-4 animate-spin" /> 분석 중... ({elapsed}초)</>
                  ) : (
                    <><SparklesIcon className="h-4 w-4" /> 분석 시작</>
                  )}
                </button>
                {analysis && (
                  <button
                    onClick={() => runAnalysis(true)}
                    disabled={loading}
                    className="flex items-center gap-2 px-3 py-2.5 rounded-lg font-medium text-purple-700 bg-purple-50 hover:bg-purple-100 disabled:opacity-50 transition-colors text-sm"
                  >
                    <ArrowPathIcon className="h-4 w-4" /> 다시 분석
                  </button>
                )}
              </div>
            </div>

            {cachedAt && (
              <p className="mt-2 text-xs text-purple-500">
                캐시된 결과 표시 중 (분석 시각: {new Date(cachedAt).toLocaleString('ko-KR')}) - "다시 분석"으로 새로 분석 가능
              </p>
            )}
          </>
        )}

        {/* 계정 분개 점검 모드 UI */}
        {analysisMode === 'account-check' && (
          <div className="mt-4 space-y-3">
            <p className="text-sm text-gray-500">
              시산표에서 계정과목을 선택하면 해당 계정의 분개/계정 분류가 올바른지 AI가 점검합니다.
            </p>
            <div className="flex items-center gap-2">
              <MagnifyingGlassIcon className="h-4 w-4 text-gray-400" />
              <input
                type="text"
                placeholder="계정코드 또는 계정명 검색..."
                value={accountSearchTerm}
                onChange={(e) => setAccountSearchTerm(e.target.value)}
                className="flex-1 px-3 py-1.5 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-teal-500 focus:border-teal-500"
              />
              {selectedAccountCodes.length > 0 && (
                <button
                  onClick={() => setSelectedAccountCodes([])}
                  className="text-xs text-gray-500 hover:text-gray-700 px-2 py-1"
                >
                  선택 초기화
                </button>
              )}
            </div>

            {/* 선택된 계정 태그 */}
            {selectedAccountCodes.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {selectedAccountCodes.map((code) => {
                  const acct = trialItems.find((a: any) => a.account_code === code)
                  return (
                    <span key={code} className="inline-flex items-center gap-1 px-2.5 py-1 bg-teal-100 text-teal-800 text-xs rounded-full font-medium">
                      {code} {acct?.account_name || ''}
                      <button onClick={() => toggleAccountCode(code)} className="hover:text-teal-600">
                        <XMarkIcon className="h-3.5 w-3.5" />
                      </button>
                    </span>
                  )
                })}
              </div>
            )}

            {/* 계정 목록 (체크박스 선택) */}
            <div className="max-h-60 overflow-y-auto border border-gray-200 rounded-lg">
              {filteredTrialItems.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-4">
                  {trialItems.length === 0 ? '시산표 데이터가 없습니다.' : '검색 결과가 없습니다.'}
                </p>
              ) : (
                <table className="w-full text-xs">
                  <thead className="bg-gray-50 sticky top-0">
                    <tr>
                      <th className="px-3 py-2 text-left w-8"></th>
                      <th className="px-3 py-2 text-left">코드</th>
                      <th className="px-3 py-2 text-left">계정명</th>
                      <th className="px-3 py-2 text-left">분류</th>
                      <th className="px-3 py-2 text-right">차변</th>
                      <th className="px-3 py-2 text-right">대변</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredTrialItems.map((item: any) => {
                      const isSelected = selectedAccountCodes.includes(item.account_code)
                      return (
                        <tr
                          key={item.account_code}
                          onClick={() => toggleAccountCode(item.account_code)}
                          className={`cursor-pointer hover:bg-teal-50 transition-colors ${isSelected ? 'bg-teal-50' : ''}`}
                        >
                          <td className="px-3 py-1.5">
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() => toggleAccountCode(item.account_code)}
                              className="h-3.5 w-3.5 text-teal-600 rounded"
                              onClick={(e) => e.stopPropagation()}
                            />
                          </td>
                          <td className="px-3 py-1.5 font-mono text-gray-600">{item.account_code}</td>
                          <td className="px-3 py-1.5 font-medium text-gray-900">{item.account_name}</td>
                          <td className="px-3 py-1.5 text-gray-500">{item.category_name || '-'}</td>
                          <td className="px-3 py-1.5 text-right text-gray-700">{item.total_debit ? fmtNum(item.total_debit) : '-'}</td>
                          <td className="px-3 py-1.5 text-right text-gray-700">{item.total_credit ? fmtNum(item.total_credit) : '-'}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
            </div>

            <div className="flex items-center justify-between">
              <span className="text-xs text-gray-500">
                {selectedAccountCodes.length}개 계정 선택됨 (시산표 전체 {trialItems.length}개)
              </span>
              <button
                onClick={runAccountCheck}
                disabled={accountCheckLoading || selectedAccountCodes.length === 0}
                className="flex items-center gap-2 px-5 py-2.5 rounded-lg font-medium text-white bg-teal-600 hover:bg-teal-700 disabled:opacity-50 transition-colors"
              >
                {accountCheckLoading ? (
                  <><ArrowPathIcon className="h-4 w-4 animate-spin" /> 점검 중... ({accountCheckElapsed}초)</>
                ) : (
                  <><SparklesIcon className="h-4 w-4" /> 분개 점검 시작</>
                )}
              </button>
            </div>
          </div>
        )}

        {/* 공통 에러 표시 */}
        {analysisMode === 'full' && error && (
          <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
            {error}
          </div>
        )}
        {analysisMode === 'account-check' && accountCheckError && (
          <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
            {accountCheckError}
          </div>
        )}
      </div>

      {/* 전체 분석 모드 - 로딩 / 결과 */}
      {analysisMode === 'full' && loading && (
        <div className="card text-center py-16">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-600 mx-auto" />
          <p className="text-gray-500 mt-4">AI(Claude Opus 4.6)가 재무 데이터를 분석하고 있습니다...</p>
          <p className="text-xs text-gray-400 mt-1">Opus 모델은 정밀 분석을 위해 1~3분 정도 소요될 수 있습니다. ({elapsed}초 경과)</p>
        </div>
      )}

      {analysisMode === 'full' && analysis && !loading && (
        <div className="space-y-4">
          {AI_CATEGORIES.map((cat) => {
            const items: any[] = analysis[cat.key] || []
            const isExpanded = expandedCat === cat.key
            return (
              <div key={cat.key} className={`border rounded-lg overflow-hidden ${colorMap[cat.color]}`}>
                <button
                  onClick={() => setExpandedCat(isExpanded ? null : cat.key)}
                  className={`w-full flex items-center justify-between px-5 py-3.5 text-left ${headerColorMap[cat.color]}`}
                >
                  <span className="font-bold text-sm flex items-center gap-2">
                    <span>{cat.icon}</span> {cat.title}
                    <span className="text-xs font-normal opacity-70">({items.length}개 항목)</span>
                  </span>
                  {isExpanded ? <ChevronUpIcon className="h-4 w-4" /> : <ChevronDownIcon className="h-4 w-4" />}
                </button>
                {isExpanded && (
                  <div className="p-4 space-y-3 bg-white/70">
                    {items.map((item: any, idx: number) => (
                      <div key={idx} className="border border-gray-200 rounded-lg p-4 bg-white">
                        <h4 className="font-bold text-gray-900 text-sm mb-2">{item.title}</h4>
                        {item.current && (
                          <div className="mb-1.5">
                            <span className="text-xs font-medium text-gray-500 mr-1">현황:</span>
                            <span className="text-sm text-gray-700">{item.current}</span>
                          </div>
                        )}
                        {item.issue && (
                          <div className="mb-1.5">
                            <span className="text-xs font-medium text-orange-600 mr-1">문제점:</span>
                            <span className="text-sm text-gray-700">{item.issue}</span>
                          </div>
                        )}
                        {item.recommendation && (
                          <div>
                            <span className="text-xs font-medium text-blue-600 mr-1">개선방안:</span>
                            <span className="text-sm text-gray-700">{item.recommendation}</span>
                          </div>
                        )}
                      </div>
                    ))}
                    {items.length === 0 && <p className="text-sm text-gray-400 text-center py-4">분석 항목 없음</p>}
                  </div>
                )}
              </div>
            )
          })}
          {analysisData?.generated_at && !cachedAt && (
            <p className="text-xs text-gray-400 text-right">분석 시각: {new Date(analysisData.generated_at).toLocaleString('ko-KR')}</p>
          )}
        </div>
      )}

      {analysisMode === 'full' && !analysis && !loading && !error && (
        <div className="card text-center py-16 text-gray-400">
          <SparklesIcon className="h-12 w-12 mx-auto mb-3 text-gray-300" />
          <p className="text-lg">"분석 시작" 버튼을 눌러주세요</p>
          <p className="text-sm mt-1">{year}년{selectedMonth ? ` ${selectedMonth}월` : ''} 손익계산서, 재무상태표, 시산표 데이터를 종합 분석합니다.</p>
        </div>
      )}

      {/* 계정 분개 점검 모드 - 로딩 / 결과 */}
      {analysisMode === 'account-check' && accountCheckLoading && (
        <div className="card text-center py-16">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-teal-600 mx-auto" />
          <p className="text-gray-500 mt-4">AI가 선택된 {selectedAccountCodes.length}개 계정의 분개를 점검하고 있습니다...</p>
          <p className="text-xs text-gray-400 mt-1">계정 수에 따라 1~3분 정도 소요될 수 있습니다. ({accountCheckElapsed}초 경과)</p>
        </div>
      )}

      {analysisMode === 'account-check' && accountCheckData && !accountCheckLoading && (
        <div className="space-y-4">
          {/* 요약 */}
          {accountCheckData.summary && (
            <div className="card">
              <h4 className="font-bold text-gray-900 text-sm mb-2">점검 요약</h4>
              <p className="text-sm text-gray-700">{accountCheckData.summary}</p>
            </div>
          )}
          {/* 계정별 점검 결과 */}
          {(accountCheckData.accounts || accountCheckData.results || []).map((acct: any, idx: number) => (
            <div key={idx} className={`card border-l-4 ${acct.has_issues ? 'border-l-orange-500' : 'border-l-green-500'}`}>
              <div className="flex items-center gap-2 mb-2">
                <span className="font-mono text-xs bg-gray-100 px-2 py-0.5 rounded">{acct.account_code}</span>
                <span className="font-bold text-sm text-gray-900">{acct.account_name}</span>
                {acct.has_issues ? (
                  <span className="text-xs bg-orange-100 text-orange-700 px-2 py-0.5 rounded-full font-medium">확인 필요</span>
                ) : (
                  <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-medium">정상</span>
                )}
              </div>
              {acct.analysis && <p className="text-sm text-gray-700 mb-2">{acct.analysis}</p>}
              {acct.issues && acct.issues.length > 0 && (
                <div className="space-y-1.5">
                  {acct.issues.map((issue: any, iIdx: number) => (
                    <div key={iIdx} className="bg-orange-50 border border-orange-200 rounded p-2.5 text-sm">
                      {typeof issue === 'string' ? (
                        <p className="text-gray-700">{issue}</p>
                      ) : (
                        <>
                          {issue.title && <p className="font-medium text-orange-800 mb-1">{issue.title}</p>}
                          {issue.description && <p className="text-gray-700">{issue.description}</p>}
                          {issue.recommendation && (
                            <p className="text-blue-700 mt-1 text-xs">
                              <span className="font-medium">개선방안:</span> {issue.recommendation}
                            </p>
                          )}
                        </>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {acct.entries && acct.entries.length > 0 && (
                <div className="mt-2">
                  <p className="text-xs font-medium text-gray-500 mb-1">샘플 분개 내역:</p>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs border">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="px-2 py-1 text-left">날짜</th>
                          <th className="px-2 py-1 text-left">적요</th>
                          <th className="px-2 py-1 text-right">차변</th>
                          <th className="px-2 py-1 text-right">대변</th>
                          {acct.entries.some((e: any) => e.issue) && <th className="px-2 py-1 text-left">문제</th>}
                        </tr>
                      </thead>
                      <tbody>
                        {acct.entries.map((entry: any, eIdx: number) => (
                          <tr key={eIdx} className={entry.issue ? 'bg-orange-50' : ''}>
                            <td className="px-2 py-1 text-gray-600">{entry.date || '-'}</td>
                            <td className="px-2 py-1 text-gray-700">{entry.description || '-'}</td>
                            <td className="px-2 py-1 text-right">{entry.debit ? fmtNum(entry.debit) : '-'}</td>
                            <td className="px-2 py-1 text-right">{entry.credit ? fmtNum(entry.credit) : '-'}</td>
                            {acct.entries.some((e: any) => e.issue) && (
                              <td className="px-2 py-1 text-orange-600">{entry.issue || ''}</td>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          ))}
          {accountCheckData.generated_at && (
            <p className="text-xs text-gray-400 text-right">점검 시각: {new Date(accountCheckData.generated_at).toLocaleString('ko-KR')}</p>
          )}
        </div>
      )}

      {analysisMode === 'account-check' && !accountCheckData && !accountCheckLoading && !accountCheckError && (
        <div className="card text-center py-16 text-gray-400">
          <SparklesIcon className="h-12 w-12 mx-auto mb-3 text-gray-300" />
          <p className="text-lg">계정을 선택한 후 "분개 점검 시작" 버튼을 눌러주세요</p>
          <p className="text-sm mt-1">선택한 계정의 분개 처리가 올바른지 AI가 점검합니다.</p>
        </div>
      )}
    </div>
  )
}


function Loading() {
  return <div className="text-center py-8"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto" /><p className="text-gray-500 mt-2">로딩 중...</p></div>
}
function Empty() {
  return <div className="flex items-center justify-center h-full text-gray-400 text-sm">데이터가 없습니다.</div>
}
