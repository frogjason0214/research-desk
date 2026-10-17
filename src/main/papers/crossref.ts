import type { Author, Bib } from '../../shared/types'

// CrossRef：以 DOI 查完整書目（英文期刊論文幾乎都有）

const UA = 'ResearchDesk/0.1 (https://github.com/frogjason0214/research-desk)'

interface CrossrefWork {
  title?: string[]
  author?: { family?: string; given?: string; name?: string }[]
  'container-title'?: string[]
  volume?: string
  issue?: string
  page?: string
  DOI?: string
  URL?: string
  issued?: { 'date-parts'?: number[][] }
  'published-print'?: { 'date-parts'?: number[][] }
  'published-online'?: { 'date-parts'?: number[][] }
}

/** 查不到（404）回傳 null；網路錯誤丟出例外 */
export async function crossrefByDoi(doi: string): Promise<Partial<Bib> | null> {
  const res = await fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, {
    headers: { 'User-Agent': UA }
  })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`CrossRef 查詢失敗（${res.status}）`)
  const w = ((await res.json()) as { message: CrossrefWork }).message
  return fromWork(w)
}

function fromWork(w: CrossrefWork): Partial<Bib> {
  const parts =
    w['published-print']?.['date-parts']?.[0] ?? w.issued?.['date-parts']?.[0] ?? w['published-online']?.['date-parts']?.[0]
  const authors: Author[] = (w.author ?? []).map((a) => ({
    family: a.family ?? a.name ?? '',
    given: a.given ?? ''
  }))
  return {
    title: (w.title?.[0] ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(),
    authors,
    year: parts?.[0] ? String(parts[0]) : '',
    journal: w['container-title']?.[0] ?? '',
    volume: w.volume ?? '',
    issue: w.issue ?? '',
    pages: w.page ?? '',
    doi: w.DOI ?? ''
  }
}
