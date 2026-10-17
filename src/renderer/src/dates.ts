// 日期一律以 YYYY-MM-DD 字串處理，避免時區造成差一天

const pad = (n: number): string => String(n).padStart(2, '0')

export function todayStr(): string {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function toUtc(s: string): number {
  const [y, m, d] = s.split('-').map(Number)
  return Date.UTC(y, m - 1, d)
}

/** b 減 a 的天數 */
export function daysBetween(a: string, b: string): number {
  return Math.round((toUtc(b) - toUtc(a)) / 86_400_000)
}

export function addDays(s: string, n: number): string {
  const d = new Date(toUtc(s) + n * 86_400_000)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

/** 3/14（五） */
export function shortDate(s: string): string {
  const [, m, d] = s.split('-').map(Number)
  const w = new Date(toUtc(s)).getUTCDay()
  return `${m}/${d}（${WEEKDAYS[w]}）`
}

/** 相對說法：今天、明天、3 天後、逾期 2 天 */
export function relativeDay(s: string, today = todayStr()): string {
  const n = daysBetween(today, s)
  if (n === 0) return '今天'
  if (n === 1) return '明天'
  if (n === -1) return '昨天'
  if (n < 0) return `逾期 ${-n} 天`
  return `${n} 天後`
}
