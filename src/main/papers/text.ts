// 文獻全文的處理：找 DOI、判斷語言、切段落、建立索引與搜尋（給第四階段 AI 引用內文）

const DOI_RE = /\b(10\.\d{4,9}\/[^\s"<>]+)/i

/** 從文字中找第一個 DOI，去掉句尾標點 */
export function findDoi(text: string): string {
  const m = text.match(DOI_RE)
  if (!m) return ''
  return m[1].replace(/[.,;:)\]}>'"]+$/, '').replace(/­/g, '')
}

/** 中日韓文字比例高於 15% 視為中文文獻 */
export function detectLang(text: string): 'en' | 'zh' {
  const sample = text.slice(0, 4000).replace(/\s/g, '')
  if (!sample) return 'en'
  const cjk = (sample.match(/[㐀-鿿豈-﫿]/g) ?? []).length
  return cjk / sample.length > 0.15 ? 'zh' : 'en'
}

export interface Chunk {
  /** 第幾頁（從 1 開始）；網頁為 0 */
  page: number
  text: string
}

const CHUNK_CHARS = 1200

/**
 * 切成約 1,200 字的段落。PDF 每頁先依空行分段，太短的段落合併、太長的依句號再切。
 * pages 為每頁文字；網頁傳一個元素、page 記為 0。
 */
export function chunkPages(pages: string[], isWeb = false): Chunk[] {
  const chunks: Chunk[] = []
  pages.forEach((pageText, i) => {
    const page = isWeb ? 0 : i + 1
    const paras = pageText
      .split(/\n\s*\n/)
      .map((p) => p.replace(/\s+/g, ' ').trim())
      .filter((p) => p.length > 0)
    let buf = ''
    const flush = (): void => {
      if (buf.trim()) chunks.push({ page, text: buf.trim() })
      buf = ''
    }
    for (const para of paras) {
      if (para.length > CHUNK_CHARS) {
        flush()
        // 依句子切開過長的段落
        const sentences = para.match(/[^.!?。！？]+[.!?。！？]*/g) ?? [para]
        for (const s of sentences) {
          if (buf.length + s.length > CHUNK_CHARS) flush()
          buf += s
        }
        flush()
      } else {
        if (buf.length + para.length > CHUNK_CHARS) flush()
        buf += (buf ? '\n' : '') + para
      }
    }
    flush()
  })
  return chunks
}

/** 斷詞：英文以單字、中文以兩字一組（bigram），足以做關鍵字搜尋 */
export function tokenize(text: string): string[] {
  const lower = text.toLowerCase()
  const words = lower.match(/[a-z0-9]{2,}/g) ?? []
  const cjk = lower.match(/[㐀-鿿]+/g) ?? []
  const grams: string[] = []
  for (const run of cjk) {
    if (run.length === 1) grams.push(run)
    for (let i = 0; i < run.length - 1; i++) grams.push(run.slice(i, i + 2))
  }
  return [...words, ...grams]
}

export interface Hit<T> {
  item: T
  score: number
}

/** BM25 排序：回傳最相關的前 limit 個 */
export function search<T extends { text: string }>(items: T[], query: string, limit = 8): Hit<T>[] {
  const q = [...new Set(tokenize(query))]
  if (q.length === 0 || items.length === 0) return []
  const docs = items.map((item) => {
    const tokens = tokenize(item.text)
    const tf = new Map<string, number>()
    tokens.forEach((t) => tf.set(t, (tf.get(t) ?? 0) + 1))
    return { item, tf, len: tokens.length }
  })
  const avg = docs.reduce((s, d) => s + d.len, 0) / docs.length || 1
  const df = new Map(q.map((t) => [t, docs.filter((d) => d.tf.has(t)).length]))
  const k1 = 1.2
  const b = 0.75
  return docs
    .map(({ item, tf, len }) => {
      let score = 0
      for (const t of q) {
        const f = tf.get(t) ?? 0
        if (!f) continue
        const n = df.get(t)!
        const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5))
        score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * len) / avg)))
      }
      return { item, score }
    })
    .filter((h) => h.score > 0)
    .sort((a, b2) => b2.score - a.score)
    .slice(0, limit)
}
