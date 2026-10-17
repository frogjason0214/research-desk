// OpenAlex：免費的學術論文資料庫。推薦新文獻只從這裡查到的結果挑選，
// 確保每一篇都真實存在、有 DOI；AI 憑記憶提到的論文一律不顯示。

const API = 'https://api.openalex.org/works'

export interface Work {
  doi: string
  title: string
  year: string
  authors: string
  venue: string
  citedBy: number
  abstract: string
}

interface RawWork {
  doi?: string | null
  display_name?: string | null
  publication_year?: number | null
  cited_by_count?: number
  authorships?: { author?: { display_name?: string } }[]
  primary_location?: { source?: { display_name?: string } | null } | null
  abstract_inverted_index?: Record<string, number[]> | null
}

/** OpenAlex 的摘要是「詞 → 位置」索引，還原成文字 */
export function rebuildAbstract(index: Record<string, number[]> | null | undefined): string {
  if (!index) return ''
  const words: string[] = []
  for (const [word, positions] of Object.entries(index)) for (const p of positions) words[p] = word
  return words.filter(Boolean).join(' ')
}

const cleanDoi = (doi: string): string => doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')

export async function searchWorks(query: string, apiKey?: string, perPage = 10): Promise<Work[]> {
  const params = new URLSearchParams({
    search: query,
    filter: 'has_doi:true,type:article',
    'per-page': String(perPage),
    select: 'doi,display_name,publication_year,cited_by_count,authorships,primary_location,abstract_inverted_index'
  })
  if (apiKey) params.set('api_key', apiKey)
  const res = await fetch(`${API}?${params}`)
  if (res.status === 429) throw new Error('OpenAlex 今天的免費查詢額度用完了，可以在設定填入免費的 OpenAlex 金鑰，或明天再試。')
  if (!res.ok) throw new Error(`OpenAlex 查詢失敗（${res.status}）`)
  const data = (await res.json()) as { results: RawWork[] }
  return (data.results ?? [])
    .filter((w) => w.doi && w.display_name)
    .map((w) => {
      const names = (w.authorships ?? []).map((a) => a.author?.display_name).filter(Boolean) as string[]
      return {
        doi: cleanDoi(w.doi!),
        title: w.display_name!.replace(/<[^>]+>/g, ''),
        year: w.publication_year ? String(w.publication_year) : '',
        authors: names.length > 3 ? `${names.slice(0, 3).join(', ')} 等` : names.join(', '),
        venue: w.primary_location?.source?.display_name ?? '',
        citedBy: w.cited_by_count ?? 0,
        abstract: rebuildAbstract(w.abstract_inverted_index)
      }
    })
}
