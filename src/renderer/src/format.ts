const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const day = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
const fullDay = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' })

export function formatDate(ms: number): string {
  const date = new Date(ms)
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  if (ms >= startOfToday) return time.format(date)
  if (ms >= startOfToday - 86_400_000) return 'Yesterday'
  return date.getFullYear() === now.getFullYear() ? day.format(date) : fullDay.format(date)
}

export function formatCount(n: number, unit: string): string {
  return `${n.toLocaleString()} ${unit}${n === 1 ? '' : 's'}`
}
