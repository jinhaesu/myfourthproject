export function formatCurrency(value: number | string | undefined | null, withSymbol = true): string {
  const num = typeof value === 'string' ? Number(value) : (value ?? 0)
  if (Number.isNaN(num)) return '-'
  const formatted = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 0 }).format(num)
  return withSymbol ? `₩ ${formatted}` : formatted
}

export function formatCompactWon(value: number | string | undefined | null): string {
  const num = typeof value === 'string' ? Number(value) : (value ?? 0)
  if (Number.isNaN(num)) return '-'
  const abs = Math.abs(num)
  const sign = num < 0 ? '-' : ''
  if (abs >= 100_000_000) return `${sign}${(abs / 100_000_000).toFixed(1)}억`
  if (abs >= 10_000) return `${sign}${(abs / 10_000).toFixed(0)}만`
  return new Intl.NumberFormat('ko-KR').format(num)
}

export function formatPct(value: number | undefined | null, digits = 1): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '-'
  return `${value.toFixed(digits)}%`
}

export function formatDate(value: string | Date | undefined | null): string {
  if (!value) return '-'
  const d = typeof value === 'string' ? new Date(value) : value
  if (Number.isNaN(d.getTime())) return '-'
  return d.toLocaleDateString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit' })
}

export function formatDateTime(value: string | Date | undefined | null): string {
  if (!value) return '-'
  const d = typeof value === 'string' ? new Date(value) : value
  if (Number.isNaN(d.getTime())) return '-'
  return d.toLocaleString('ko-KR', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  })
}

/** 마지막 업데이트 시각: HH:MM (오늘) / MM/DD HH:MM (다른 날) */
export function formatLastUpdated(ms: number | undefined | null): string {
  if (!ms) return ''
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return ''
  const now = new Date()
  const isSameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  if (isSameDay) return `${hh}:${mm}`
  const M = String(d.getMonth() + 1).padStart(2, '0')
  const D = String(d.getDate()).padStart(2, '0')
  return `${M}/${D} ${hh}:${mm}`
}

export function formatRelativeTime(value: string | Date | undefined | null): string {
  if (!value) return '-'
  const d = typeof value === 'string' ? new Date(value) : value
  if (Number.isNaN(d.getTime())) return '-'
  const diff = Date.now() - d.getTime()
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return '방금 전'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}분 전`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}시간 전`
  const day = Math.floor(hr / 24)
  if (day < 7) return `${day}일 전`
  return formatDate(d)
}

/**
 * granterApi.listTicketsAllTypes 응답을 평탄한 ticket 배열로 변환.
 * 백엔드 응답: { EXPENSE_TICKET: [...], BANK_TRANSACTION_TICKET: [...], ... }
 * 또는 단일 listTickets처럼 [...] 배열일 수도, { data: [...] } 형태일 수도.
 */
export function flattenTickets(raw: any): any[] {
  if (!raw) return []
  if (Array.isArray(raw)) return raw
  if (typeof raw === 'object') {
    // { ticketType: [...] } 객체
    const all: any[] = []
    for (const v of Object.values(raw)) {
      if (Array.isArray(v)) all.push(...v)
      else if (v && typeof v === 'object' && Array.isArray((v as any).data)) {
        all.push(...(v as any).data)
      }
    }
    if (all.length > 0) return all
    // { data: [...] } fallback
    if (Array.isArray((raw as any).data)) return (raw as any).data
  }
  return []
}

// 로컬 timezone 기준 yyyy-MM-dd (toISOString은 UTC라 KST 자정이 전날로 변환되는 버그 방지)
export function isoLocal(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function todayISO(): string {
  return isoLocal(new Date())
}

export function firstDayOfMonth(): string {
  const d = new Date()
  d.setDate(1)
  return isoLocal(d)
}

export function maskBusinessNumber(num: string | undefined | null): string {
  if (!num) return '-'
  const digits = num.replace(/-/g, '')
  if (digits.length !== 10) return num
  return `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`
}
