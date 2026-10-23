import { inTextCitation } from './apa'
import type { Paper } from './types'

// 引用的頁碼、同作者同年份的 a／b、參考文獻排序。主程式（匯出 Word、.md）與畫面（筆記、閱讀器）共用。

type Lang = 'en' | 'zh'

/** 把頁碼接進文中引用：(Smith, 2020) → (Smith, 2020, p. 5)；（王小明，2020）→（王小明，2020，頁 5） */
export function withLocator(label: string, locator: string | null | undefined): string {
  const loc = (locator ?? '').trim()
  if (!loc) return label
  if (label.endsWith('）')) return `${label.slice(0, -1)}，${loc}）`
  if (label.endsWith(')')) return `${label.slice(0, -1)}, ${loc})`
  return `${label} ${loc}`
}

/** 頁碼的寫法：英文 p. 5，中文 頁 5 */
export const pageLocator = (page: number | string, lang: Lang): string => (lang === 'zh' ? `頁 ${page}` : `p. ${page}`)

/**
 * 重點在 PDF 第 pageIndex 頁（從 0 起算）時，引用要寫的頁碼：
 * 1. PDF 有純數字的頁碼標籤就用它；2. 書目有起始頁就推算；3. 都沒有就用 PDF 的第幾頁。
 */
export function pageNumberFor(pageIndex: number, opts: { pageLabel?: string | null; paperPages?: string | null }): number {
  const label = (opts.pageLabel ?? '').trim()
  if (/^\d+$/.test(label)) return Number(label)
  const start = /^\s*(\d+)/.exec(opts.paperPages ?? '')
  if (start) return Number(start[1]) + pageIndex
  return pageIndex + 1
}

const yearOf = (p: Pick<Paper, 'date' | 'year'>, lang: Lang): string => (p.date || p.year).slice(0, 4) || (lang === 'zh' ? '無日期' : 'n.d.')

/** 文中引用（含 a／b 與頁碼），依文獻目前的書目產生 */
export function inTextFor(paper: Paper, suffix = '', locator?: string | null): string {
  let label = inTextCitation(paper, paper.lang)
  if (suffix) {
    const year = yearOf(paper, paper.lang)
    const at = label.lastIndexOf(year)
    if (at >= 0) label = label.slice(0, at + year.length) + suffix + label.slice(at + year.length)
  }
  return withLocator(label, locator)
}

const authorKey = (p: Paper): string =>
  p.authors.map((a) => (p.lang === 'zh' ? `${a.family}${a.given}` : `${a.family}, ${a.given}`)).join('; ') || p.title

const strokes = new Intl.Collator('zh-TW-u-co-stroke')
const latin = new Intl.Collator('en', { sensitivity: 'base' })

/**
 * 參考文獻排序：中文在前（依第一作者姓名筆畫），英文在後（依姓氏字母、年份）。
 * 同作者（全部作者相同）同年份的多篇依標題排，加上 a、b、c…。
 */
export function orderReferences(papers: Paper[]): { paper: Paper; suffix: string }[] {
  const cmp = (a: Paper, b: Paper): number => {
    if (a.lang !== b.lang) return a.lang === 'zh' ? -1 : 1
    const coll = a.lang === 'zh' ? strokes : latin
    return (
      coll.compare(authorKey(a), authorKey(b)) ||
      yearOf(a, a.lang).localeCompare(yearOf(b, b.lang)) ||
      coll.compare(a.title, b.title)
    )
  }
  const sorted = [...papers].sort(cmp)
  const groups = new Map<string, Paper[]>()
  for (const p of sorted) {
    const key = `${p.lang}|${authorKey(p)}|${yearOf(p, p.lang)}`
    groups.set(key, [...(groups.get(key) ?? []), p])
  }
  return sorted.map((p) => {
    const group = groups.get(`${p.lang}|${authorKey(p)}|${yearOf(p, p.lang)}`)!
    const i = group.indexOf(p)
    return { paper: p, suffix: group.length > 1 ? String.fromCharCode(97 + i) : '' }
  })
}
