import type { Author } from '../../shared/types'

// 從網頁署名、標題整理出作者與網站名稱

const CJK_NAME = /^[㐀-鿿]{2,4}$/

/** 「Smith, John」「John Smith」「王小明」→ 姓與名 */
export function splitName(name: string): Author {
  const n = name.trim()
  if (n.includes(',')) {
    const [family, ...rest] = n.split(',')
    return { family: family.trim(), given: rest.join(',').trim() }
  }
  if (CJK_NAME.test(n)) return { family: n[0], given: n.slice(1) }
  const parts = n.split(/\s+/)
  return { family: parts.pop() ?? '', given: parts.join(' ') }
}

const NOT_A_PERSON = /contributors|projects|staff|team|editor|newsroom|admin|編輯部|小編|記者群/i
const ORG_SUFFIX = /,\s*(inc|ltd|llc|co|corp)\.?$/i
const ORG_WORDS =
  /\b(association|society|institute|university|foundation|organi[sz]ation|cent(er|re)|department|ministry|council|agency|college|school|hospital|clinic|press|news|times|journal|group|inc|ltd)\b|協會|學會|大學|研究院|基金會|中心|部$|署$|局$/i
/** John Smith、Mary-Ann O'Neil、J. R. R. Tolkien：2～4 個大寫開頭的字 */
const PERSON = /^[\p{Lu}][\p{L}.'’-]*(\s+[\p{Lu}][\p{L}.'’-]*){1,3}$/u
/** Smith, John A. */
const FAMILY_FIRST = /^[\p{Lu}][\p{L}'’-]+,\s*[\p{Lu}][\p{L}.\s'’-]*$/u

/** 網頁署名 → 作者：個人姓名拆成姓與名；機構當作團體作者；「Contributors to …」之類的不算作者 */
export function bylineAuthors(byline: string): Author[] {
  const b = byline.replace(/^(by|written by|文[／/]|作者[:：]?)\s*/i, '').trim()
  if (!b || NOT_A_PERSON.test(b) || b.length > 80) return []
  if (ORG_WORDS.test(b)) return [{ family: b, given: '' }]
  if (PERSON.test(b) || CJK_NAME.test(b) || (FAMILY_FIRST.test(b) && !ORG_SUFFIX.test(b))) return [splitName(b)]
  return [{ family: b, given: '' }]
}

/** 「Cognitive dissonance - Wikipedia」→ 標題「Cognitive dissonance」、網站「Wikipedia」 */
export function splitSiteSuffix(title: string, site: string, url: string): { title: string; site: string } {
  const m = title.match(/^(.*\S)\s+[-|–—·:]\s+([^-|–—·]{2,40})$/)
  if (!m) return { title, site }
  const suffix = m[2].trim()
  const host = new URL(url).hostname.toLowerCase()
  const squash = (s: string): string => s.toLowerCase().replace(/[^a-z0-9㐀-鿿]/g, '')
  const related =
    !site || squash(site).includes(squash(suffix)) || squash(suffix).includes(squash(site)) || host.includes(squash(suffix))
  return related ? { title: m[1], site: suffix } : { title, site }
}
