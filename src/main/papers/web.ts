import { BrowserWindow } from 'electron'
import fs from 'node:fs'

// 網頁快照：用隱藏視窗開網頁（JavaScript 產生的內容也抓得到），
// 存整頁 .mhtml，再用 Mozilla Readability 抽出正文，並讀取學術網站常見的 citation_* 書目標籤。

const LOAD_TIMEOUT_MS = 30_000
const SETTLE_MS = 1500
const CAPTURE_PARTITION = 'web-capture'
let downloadsBlocked = false

export interface WebMeta {
  doi: string
  title: string
  authors: string[]
  date: string
  journal: string
  volume: string
  issue: string
  firstpage: string
  lastpage: string
  site: string
  author: string
}

export interface WebCapture {
  url: string
  title: string
  byline: string
  siteName: string
  published: string
  /** 正文 HTML（已移除廣告、選單） */
  content: string
  text: string
  meta: WebMeta
}

const COLLECT_META = `(() => {
  const q = (n) => [...document.querySelectorAll('meta[name="' + n + '" i], meta[property="' + n + '" i]')]
    .map((m) => m.content.trim()).filter(Boolean)
  return {
    doi: q('citation_doi')[0] || q('dc.identifier')[0] || '',
    title: q('citation_title')[0] || q('og:title')[0] || '',
    authors: q('citation_author'),
    date: q('citation_publication_date')[0] || q('citation_date')[0] || q('article:published_time')[0] || q('date')[0] || '',
    journal: q('citation_journal_title')[0] || '',
    volume: q('citation_volume')[0] || '',
    issue: q('citation_issue')[0] || '',
    firstpage: q('citation_firstpage')[0] || '',
    lastpage: q('citation_lastpage')[0] || '',
    site: q('og:site_name')[0] || '',
    author: q('author')[0] || ''
  }
})()`

let readabilitySource: string | null = null
const readability = (): string =>
  (readabilitySource ??= fs.readFileSync(require.resolve('@mozilla/readability/Readability.js'), 'utf8'))

/** 檢查網址是不是 PDF（PDF 請下載後用「匯入 PDF」，才能抽全文） */
async function isPdf(url: string): Promise<boolean> {
  if (/\.pdf(\?|#|$)/i.test(url)) return true
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow' })
    return (res.headers.get('content-type') ?? '').includes('application/pdf')
  } catch {
    return false
  }
}

export async function captureWeb(url: string, mhtmlPath: string): Promise<WebCapture> {
  if (!/^https?:\/\//i.test(url)) throw new Error('請貼上以 http:// 或 https:// 開頭的網址')
  if (await isPdf(url)) throw new Error('這是 PDF 檔的連結。請先下載 PDF，再用「匯入 PDF」，才能抽出全文。')

  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    // 獨立、不保存的 session：不會帶到使用者在其他地方的登入狀態，也不會留下 cookie
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: CAPTURE_PARTITION }
  })
  if (!downloadsBlocked) {
    win.webContents.session.on('will-download', (e) => e.preventDefault())
    downloadsBlocked = true
  }
  win.webContents.setAudioMuted(true)
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  try {
    await Promise.race([
      win.loadURL(url),
      new Promise((_, reject) => setTimeout(() => reject(new Error('網頁載入逾時（30 秒），請確認網址或稍後再試。')), LOAD_TIMEOUT_MS))
    ])
    await new Promise((r) => setTimeout(r, SETTLE_MS))

    await win.webContents.savePage(mhtmlPath, 'MHTML')
    const meta = (await win.webContents.executeJavaScript(COLLECT_META)) as WebMeta
    const article = (await win.webContents.executeJavaScript(`(() => {
      ${readability()}
      const parsed = new Readability(document.cloneNode(true)).parse()
      return parsed && { title: parsed.title || '', byline: parsed.byline || '', siteName: parsed.siteName || '',
        published: parsed.publishedTime || '', content: parsed.content || '', text: parsed.textContent || '' }
    })()`)) as Omit<WebCapture, 'url' | 'meta'> | null
    const finalUrl = win.webContents.getURL()
    const pageTitle = win.webContents.getTitle()

    return {
      url: finalUrl || url,
      title: article?.title || meta.title || pageTitle,
      byline: article?.byline ?? '',
      siteName: article?.siteName || meta.site || new URL(finalUrl || url).hostname.replace(/^www\./, ''),
      published: article?.published || meta.date,
      content: article?.content ?? '',
      text: (article?.text ?? '').replace(/\n{3,}/g, '\n\n').trim(),
      meta
    }
  } finally {
    win.destroy()
  }
}

/** 正文快照：一個可以直接用瀏覽器開的 HTML 檔 */
export function snapshotHtml(c: WebCapture, capturedAt: string): string {
  const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  return `<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(c.title)}</title>
<style>body{max-width:760px;margin:40px auto;padding:0 20px;font:17px/1.75 system-ui,"Microsoft JhengHei",sans-serif;color:#222}
img{max-width:100%;height:auto}header{border-bottom:1px solid #ddd;margin-bottom:24px;padding-bottom:12px;color:#666;font-size:14px}
h1{font-size:28px;line-height:1.3;color:#111}</style></head>
<body><header>Research Desk 網頁快照・擷取於 ${esc(capturedAt)}<br>原始網址：<a href="${esc(c.url)}">${esc(c.url)}</a></header>
<h1>${esc(c.title)}</h1>
${c.byline ? `<p><em>${esc(c.byline)}</em></p>` : ''}
${c.content || `<pre style="white-space:pre-wrap">${esc(c.text)}</pre>`}
</body></html>`
}
