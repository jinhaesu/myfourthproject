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

export function todayISO(): string {
  return new Date().toISOString().slice(0, 10)
}

export function firstDayOfMonth(): string {
  const d = new Date()
  d.setDate(1)
  return d.toISOString().slice(0, 10)
}

export function maskBusinessNumber(num: string | undefined | null): string {
  if (!num) return '-'
  const digits = num.replace(/-/g, '')
  if (digits.length !== 10) return num
  return `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`
}
