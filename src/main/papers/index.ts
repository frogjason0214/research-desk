import { clipboard, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Author, Bib, Paper, PaperPatch, PdfImport, Recommendation } from '../../shared/types'
import type { Gemini } from '../ai/gemini'
import type { Library } from '../library'
import type { Store } from '../store'
import { aiBibliography, aiPsychFields } from './ai'
import { crossrefByDoi } from './crossref'
import { bylineAuthors, splitName, splitSiteSuffix } from './names'
import { chunkPages, detectLang, findDoi, search, type Chunk } from './text'
import { captureWeb, snapshotHtml, type WebCapture } from './web'

// 文獻庫：匯入 PDF／網頁、查書目、AI 預填、引用格式。
// 檔案放在 files/papers/：<id>.pdf、<id>.html（正文快照）、<id>.mhtml（整頁）、<id>.txt（全文，PDF 以換頁符 \f 分頁）

const MIN_TEXT = 200

type Row = Omit<Paper, 'authors' | 'busy' | 'error'> & { authors: string | null }

const fileOf = (id: string, ext: 'pdf' | 'html' | 'mhtml' | 'txt'): string => `papers/${id}.${ext}`

function parseAuthors(json: string | null): Author[] {
  try {
    const list = JSON.parse(json ?? '[]')
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

/** 只保留有值的欄位，避免 AI 留空的欄位蓋掉已有資料 */
function nonEmpty(bib: Partial<Bib>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(bib)) {
    if (k === 'authors') {
      if (Array.isArray(v) && v.length) out.authors = JSON.stringify(v)
    } else if (typeof v === 'string' && v.trim()) out[k] = v.trim()
  }
  return out
}

export function createPapers(opts: {
  store: Store
  library: Library
  gemini: Gemini
  autoFill: () => boolean
  onChange: () => void
}) {
  const { store, library, gemini } = opts
  const busy = new Set<string>()
  const errors = new Map<string, string>()
  const chunkCache = new Map<string, Chunk[]>()

  const row = (id: string): Row | undefined => store.get<Row>('SELECT * FROM papers WHERE id = ?', [id])
  const set = (id: string, fields: Record<string, unknown>): void => {
    if (Object.keys(fields).length && row(id)) store.write((tx) => tx.set('papers', id, fields))
  }
  const setBusy = (id: string, on: boolean): void => {
    if (on) busy.add(id)
    else busy.delete(id)
    opts.onChange()
  }
  /** 這篇現在可以送 AI 嗎（每一步都重新讀，使用者途中勾「不送 AI」會立刻生效） */
  const aiAllowed = (id: string, manual = false): boolean =>
    gemini.hasKey && (manual || opts.autoFill()) && !row(id)?.no_ai

  const toPaper = (r: Row): Paper => {
    const p = { ...r } as unknown as Paper
    for (const k of ['title', 'year', 'date', 'journal', 'volume', 'issue', 'pages', 'doi', 'url', 'study_type', 'sample', 'measures', 'findings', 'notes'] as const)
      p[k] = (r[k] as string | null) ?? ''
    p.authors = parseAuthors(r.authors)
    p.busy = busy.has(r.id) ? 1 : 0
    p.error = errors.get(r.id) ?? null
    return p
  }

  const readText = (id: string): string => {
    const file = library.resolveFile(fileOf(id, 'txt'))
    return file ? fs.readFileSync(file, 'utf8') : ''
  }

  /** 書目與心理學欄位：DOI → CrossRef；沒有就交給 AI（標示待確認）；再由 AI 預填四個欄位 */
  async function enrich(id: string, text: string, manual = false): Promise<void> {
    setBusy(id, true)
    errors.delete(id)
    try {
      const p = row(id)
      if (!p) return
      const doi = p.doi || findDoi(text.slice(0, 30000))
      if (p.bib_status !== 'ok' && doi) {
        const bib = await crossrefByDoi(doi).catch(() => null)
        if (bib) set(id, { ...nonEmpty(bib), bib_status: 'ok' })
      }

      const pdfFile = library.resolveFile(fileOf(id, 'pdf'))
      const source = text.length >= MIN_TEXT ? { text } : pdfFile ? { pdf: fs.readFileSync(pdfFile) } : null
      if (!source) return

      if (row(id)?.bib_status !== 'ok' && aiAllowed(id, manual)) {
        const bib = await aiBibliography(gemini, source)
        set(id, { ...nonEmpty(bib), bib_status: 'pending' })
        // AI 讀到 DOI 的話，再用 CrossRef 校正
        if (bib.doi) {
          const cr = await crossrefByDoi(bib.doi).catch(() => null)
          if (cr) set(id, { ...nonEmpty(cr), bib_status: 'ok' })
        }
      }
      if (aiAllowed(id, manual)) {
        const f = await aiPsychFields(gemini, source)
        const current = row(id)!
        // 使用者已經填過的欄位不覆蓋
        const fill: Record<string, unknown> = {}
        for (const k of ['study_type', 'sample', 'measures', 'findings'] as const) {
          if (!current[k] && f[k]?.trim()) fill[k] = f[k].trim()
        }
        if (Object.keys(fill).length) set(id, { ...fill, ai_filled: 1 })
      }
    } catch (err) {
      errors.set(id, err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(id, false)
    }
  }

  function chunksOf(id: string, kind: Paper['kind']): Chunk[] {
    let c = chunkCache.get(id)
    if (!c) {
      const text = readText(id)
      // 只有 PDF 有頁碼；網頁與摘要整篇當一頁（頁碼記為 0）
      c = chunkPages(kind === 'pdf' ? text.split('\f') : [text], kind !== 'pdf')
      chunkCache.set(id, c)
    }
    return c
  }

  const base = (projectId: string, kind: Paper['kind'], noAi: boolean): Record<string, unknown> => ({
    project_id: projectId,
    kind,
    bib_status: 'pending',
    no_ai: noAi ? 1 : 0,
    notes_no_ai: 0,
    ai_filled: 0,
    added_at: new Date().toISOString()
  })

  return {
    /** 給第四階段 AI 用：搜尋專案內可送 AI 的文獻段落 */
    searchForAi(projectId: string, query: string, limit = 8) {
      const papers = store.all<Row>('SELECT * FROM papers WHERE project_id = ? AND no_ai = 0', [projectId])
      const items = papers.flatMap((p) => chunksOf(p.id, p.kind).map((c) => ({ ...c, paper: toPaper(p) })))
      return search(items, query, limit)
    },

    handlers: {
      'papers.list': (projectId: string): Paper[] =>
        store.all<Row>('SELECT * FROM papers WHERE project_id = ? ORDER BY added_at DESC', [projectId]).map(toPaper),

      'papers.importPdf': async (projectId: string, file: PdfImport): Promise<string> => {
        const id = randomUUID()
        const text = file.pages.join('\f')
        library.writeFile(fileOf(id, 'pdf'), new Uint8Array(file.data))
        library.writeFile(fileOf(id, 'txt'), text)
        const firstPages = file.pages.slice(0, 2).join('\n')
        store.write((tx) =>
          tx.set('papers', id, {
            ...base(projectId, 'pdf', file.noAi),
            title: file.name.replace(/\.pdf$/i, ''),
            lang: detectLang(firstPages),
            text_status: text.replace(/\s/g, '').length >= MIN_TEXT ? 'ok' : 'empty'
          })
        )
        void enrich(id, text)
        return id
      },

      'papers.importWeb': async (projectId: string, url: string, noAi: boolean): Promise<string> => {
        const id = randomUUID()
        // 先存到暫存資料夾，成功後才寫進文獻庫
        const tmp = path.join(os.tmpdir(), `rd-${id}.mhtml`)
        let c: WebCapture
        try {
          c = await captureWeb(url.trim(), tmp)
          library.writeFile(fileOf(id, 'mhtml'), fs.readFileSync(tmp))
        } finally {
          fs.rmSync(tmp, { force: true })
        }
        library.writeFile(fileOf(id, 'html'), snapshotHtml(c, new Date().toLocaleString('zh-TW')))
        library.writeFile(fileOf(id, 'txt'), c.text)

        const m = c.meta
        const hasCitation = !!(m.title && m.authors.length)
        const authors = m.authors.length ? m.authors.map(splitName) : bylineAuthors(c.byline || m.author)
        // Readability 有時已經去掉標題後面的網站名，所以用網頁原本的 og:title 判斷網站名稱
        const named = hasCitation
          ? { title: m.title, site: m.journal || c.siteName }
          : splitSiteSuffix(m.title || c.title, c.siteName, c.url)
        const pages = m.firstpage ? `${m.firstpage}${m.lastpage ? `-${m.lastpage}` : ''}` : ''
        store.write((tx) =>
          tx.set('papers', id, {
            ...base(projectId, 'web', noAi),
            lang: detectLang(`${c.title}\n${c.text}`),
            text_status: c.text.length >= MIN_TEXT ? 'ok' : 'empty',
            title: named.title,
            authors: JSON.stringify(authors),
            year: (m.date || c.published).slice(0, 4),
            date: (m.date || c.published).slice(0, 10).replace(/\//g, '-'),
            journal: named.site,
            volume: m.volume,
            issue: m.issue,
            pages,
            doi: findDoi(m.doi),
            url: c.url,
            // 出版社網頁上的 citation_* 標籤是正式書目，直接視為已確認
            bib_status: hasCitation ? 'ok' : 'pending'
          })
        )
        void enrich(id, c.text)
        return id
      },

      /** 從推薦加入：只有書目與摘要（沒有 PDF），之後下載 PDF 可以再匯入 */
      'papers.importDoi': async (projectId: string, rec: Recommendation): Promise<string> => {
        const id = randomUUID()
        const bib = await crossrefByDoi(rec.doi).catch(() => null)
        if (rec.abstract) library.writeFile(fileOf(id, 'txt'), `${rec.title}\n\n${rec.abstract}`)
        store.write((tx) =>
          tx.set('papers', id, {
            ...base(projectId, 'ref', false),
            lang: detectLang(rec.title),
            text_status: rec.abstract ? 'ok' : 'empty',
            title: rec.title,
            year: rec.year,
            journal: rec.venue,
            doi: rec.doi,
            url: rec.url,
            ...(bib ? { ...nonEmpty(bib), bib_status: 'ok' } : {})
          })
        )
        void enrich(id, rec.abstract)
        return id
      },

      'papers.update': (id: string, patch: PaperPatch): void => {
        const { authors, ...rest } = patch
        const fields: Record<string, unknown> = { ...rest }
        if (authors) fields.authors = JSON.stringify(authors.filter((a) => a.family.trim() || a.given.trim()))
        set(id, fields)
      },

      'papers.confirmBib': (id: string): void => set(id, { bib_status: 'ok' }),

      /** 手動輸入 DOI 查 CrossRef */
      'papers.lookupDoi': async (id: string, doi: string): Promise<void> => {
        const clean = findDoi(doi) || doi.trim()
        if (!clean) throw new Error('請輸入 DOI，例如 10.1037/abc0000123')
        setBusy(id, true)
        try {
          const bib = await crossrefByDoi(clean)
          if (!bib) throw new Error('CrossRef 找不到這個 DOI，請確認是否正確。')
          set(id, { ...nonEmpty(bib), bib_status: 'ok' })
        } finally {
          setBusy(id, false)
        }
      },

      /** 手動按「AI 預填」：補上書目（若還沒確認）與四個心理學欄位 */
      'papers.aiFill': async (id: string): Promise<void> => {
        if (!gemini.hasKey) throw new Error('尚未設定 Gemini API 金鑰，請到「設定」填入。')
        if (row(id)?.no_ai) throw new Error('這篇勾選了「不送 AI」。')
        await enrich(id, readText(id), true)
        const err = errors.get(id)
        if (err) throw new Error(err)
      },

      'papers.open': async (id: string, which: 'file' | 'page'): Promise<void> => {
        const p = row(id)
        if (!p) return
        if (p.kind === 'ref') {
          // 只有書目的文獻：開 DOI 連結
          if (p.url) await shell.openExternal(p.url)
          return
        }
        const rel = p.kind === 'pdf' ? fileOf(id, 'pdf') : fileOf(id, which === 'page' ? 'mhtml' : 'html')
        const file = library.resolveFile(rel)
        if (!file) throw new Error('找不到檔案。如果剛在另一台電腦匯入，請等雲端硬碟同步完成。')
        const err = await shell.openPath(file)
        if (err) throw new Error(err)
      },

      'papers.remove': (id: string): void => {
        store.write((tx) => tx.remove('papers', id))
        for (const ext of ['pdf', 'html', 'mhtml', 'txt'] as const) library.removeFile(fileOf(id, ext))
        chunkCache.delete(id)
      },

      /** 全文搜尋（目前專案）：回傳符合的段落 */
      'papers.search': (projectId: string, query: string) => {
        const papers = store.all<Row>('SELECT * FROM papers WHERE project_id = ?', [projectId])
        const items = papers.flatMap((p) => chunksOf(p.id, p.kind).map((c) => ({ ...c, paperId: p.id })))
        return search(items, query, 30).map((h) => ({ paperId: h.item.paperId, page: h.item.page, text: h.item.text }))
      },

      'papers.copy': (text: string, html: string): void => clipboard.write({ text, html })
    }
  }
}
