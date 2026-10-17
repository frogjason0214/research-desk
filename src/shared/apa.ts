import type { Author, Bib } from './types'

// APA 第 7 版參考文獻條目。回傳純文字與 HTML（期刊名、卷數、網頁標題用斜體）。
// 英文：Author, A. A., & Author, B. B. (2020). Title. Journal, 12(3), 45–67. https://doi.org/...
// 中文：王小明、李大華（2020）。標題。期刊，12（3），45–67。https://doi.org/...

export interface Citation {
  text: string
  html: string
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** 名字縮寫：Mary Ann → M. A.；Jean-Paul → J.-P. */
function initials(given: string): string {
  return given
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) =>
      part
        .split('-')
        .map((p) => `${p[0].toUpperCase()}.`)
        .join('-')
    )
    .join(' ')
}

function enName(a: Author): string {
  if (!a.given) return a.family
  return `${a.family}, ${initials(a.given)}`
}

function enAuthors(list: Author[]): string {
  const names = list.map(enName)
  if (names.length === 0) return ''
  if (names.length === 1) return names[0]
  if (names.length <= 20) return `${names.slice(0, -1).join(', ')}, & ${names[names.length - 1]}`
  // 超過 20 位：前 19 位、刪節號、最後一位
  return `${names.slice(0, 19).join(', ')}, . . . ${names[names.length - 1]}`
}

function zhAuthors(list: Author[]): string {
  const names = list.map((a) => `${a.family}${a.given}`)
  if (names.length > 20) return `${names.slice(0, 19).join('、')}、……${names[names.length - 1]}`
  return names.join('、')
}

/** 句尾補句點（標題本身以 ? ! 結尾就不補） */
const end = (s: string): string => (/[.?!。？！]$/.test(s) ? s : `${s}.`)
const pagesDash = (p: string): string => p.replace(/\s*[-‐–—]\s*/g, '–')
const doiUrl = (doi: string): string => (doi ? `https://doi.org/${doi.replace(/^https?:\/\/(dx\.)?doi\.org\//, '')}` : '')

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

function enDate(b: Bib): string {
  const [y, m, d] = (b.date || b.year).split('-')
  if (!y) return 'n.d.'
  if (!m) return y
  return `${y}, ${MONTHS[Number(m) - 1]}${d ? ` ${Number(d)}` : ''}`
}

export function apaCitation(b: Bib, kind: 'pdf' | 'web', lang: 'en' | 'zh'): Citation {
  return lang === 'zh' ? zhCitation(b, kind) : enCitation(b, kind)
}

function enCitation(b: Bib, kind: 'pdf' | 'web'): Citation {
  const authors = enAuthors(b.authors)
  const link = doiUrl(b.doi) || (kind === 'web' ? b.url : '')

  if (kind === 'web' && !b.volume && !b.doi) {
    // 網頁：Author. (2020, March 5). Title. Site. URL
    const date = `(${enDate(b)}).`
    const head = authors ? `${end(authors)} ${date}` : ''
    const site = b.journal && b.journal !== authors ? `${end(b.journal)} ` : ''
    const title = end(b.title || 'Untitled')
    const text = authors ? `${head} ${title} ${site}${link}` : `${title} ${date} ${site}${link}`
    const html = authors
      ? `${esc(head)} <i>${esc(title)}</i> ${esc(site)}${esc(link)}`
      : `<i>${esc(title)}</i> ${esc(date)} ${esc(site)}${esc(link)}`
    return { text: text.trim(), html: html.trim() }
  }

  // 期刊文章
  const year = `(${b.year || 'n.d.'}).`
  const head = authors ? `${end(authors)} ${year}` : ''
  const title = end(b.title || 'Untitled')
  const vol = b.volume ? `, ${b.volume}` : ''
  const issue = b.issue ? `(${b.issue})` : ''
  const pages = b.pages ? `, ${pagesDash(b.pages)}` : ''
  const source = b.journal ? `${b.journal}${vol}${issue}${pages}.` : ''
  const sourceHtml = b.journal ? `<i>${esc(b.journal)}${b.volume ? `, ${esc(b.volume)}` : ''}</i>${esc(issue)}${esc(pages)}.` : ''

  const parts = authors ? [head, title, source, link] : [title, year, source, link]
  const htmlParts = authors ? [esc(head), esc(title), sourceHtml, esc(link)] : [esc(title), esc(year), sourceHtml, esc(link)]
  return { text: parts.filter(Boolean).join(' '), html: htmlParts.filter(Boolean).join(' ') }
}

function zhCitation(b: Bib, kind: 'pdf' | 'web'): Citation {
  const authors = zhAuthors(b.authors)
  const link = doiUrl(b.doi) || (kind === 'web' ? b.url : '')
  const year = `（${(b.date || b.year).replace(/-/g, '/') || '無日期'}）`
  const title = b.title || '無標題'
  const lead = authors ? `${authors}${year}。` : `${title}${year}。`

  if (kind === 'web' && !b.volume && !b.doi) {
    const titlePart = authors ? `${title}。` : ''
    const site = b.journal ? `${b.journal}。` : ''
    return {
      text: `${lead}${titlePart}${site}${link}`,
      html: `${esc(lead)}${authors ? `<i>${esc(title)}</i>。` : ''}${esc(site)}${esc(link)}`
    }
  }

  const titlePart = authors ? `${title}。` : ''
  const vol = b.volume ? `，${b.volume}` : ''
  const issue = b.issue ? `（${b.issue}）` : ''
  const pages = b.pages ? `，${pagesDash(b.pages)}` : ''
  const source = b.journal ? `${b.journal}${vol}${issue}${pages}。` : ''
  const sourceHtml = b.journal ? `<i>${esc(b.journal)}${b.volume ? `，${esc(b.volume)}` : ''}</i>${esc(issue)}${esc(pages)}。` : ''
  return {
    text: `${lead}${titlePart}${source}${link}`,
    html: `${esc(lead)}${esc(titlePart)}${sourceHtml}${esc(link)}`
  }
}

/** 文中引用：(Wang & Lee, 2020)／（王小明、李大華，2020） */
export function inTextCitation(b: Bib, lang: 'en' | 'zh'): string {
  const year = (b.date || b.year).slice(0, 4) || (lang === 'zh' ? '無日期' : 'n.d.')
  const fam = b.authors.map((a) => (lang === 'zh' ? `${a.family}${a.given}` : a.family))
  if (lang === 'zh') {
    const who = fam.length === 0 ? b.title : fam.length <= 2 ? fam.join('、') : `${fam[0]}等人`
    return `（${who}，${year}）`
  }
  const who = fam.length === 0 ? b.title : fam.length === 1 ? fam[0] : fam.length === 2 ? `${fam[0]} & ${fam[1]}` : `${fam[0]} et al.`
  return `(${who}, ${year})`
}
