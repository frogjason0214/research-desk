import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import type { TextItem } from 'pdfjs-dist/types/src/display/api'
import { pageLocator, pageNumberFor } from '../../../shared/citation'
import { textInQuads, type TextRun } from '../../../shared/quadText'

type Rect = [number, number, number, number]
import type { Paper, PdfAnnot } from '../../../shared/types'
import { desk } from '../useDesk'
import { openPdf } from './pdfjs'

// 重點的文字不另外存：需要時打開 PDF，取落在重點位置內的字（舊的、其他程式畫的重點也適用）。

/** 把頁面上的一塊（PDF 座標）畫成 PNG */
export async function cropArea(page: PDFPageProxy, rect: Rect, scale = 2): Promise<ArrayBuffer> {
  const viewport = page.getViewport({ scale })
  const [vx1, vy1, vx2, vy2] = viewport.convertToViewportRectangle(rect)
  const x = Math.min(vx1, vx2)
  const y = Math.min(vy1, vy2)
  const w = Math.max(1, Math.round(Math.abs(vx2 - vx1)))
  const h = Math.max(1, Math.round(Math.abs(vy2 - vy1)))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, w, h)
  await page.render({ canvasContext: ctx, viewport, transform: [1, 0, 0, 1, -x, -y] }).promise
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'))
  if (!blob) throw new Error('無法截取這個區域')
  return blob.arrayBuffer()
}

export interface HighlightItem {
  annot: PdfAnnot
  /** 引用要寫的頁碼，例如 p. 237、頁 237 */
  locator: string
  /** 螢光筆、底線的原文；框選與便利貼是空字串 */
  text: string
}

/** 依頁碼、再依位置由上到下 */
export const byPosition = (a: PdfAnnot, b: PdfAnnot): number => a.page - b.page || b.rect[3] - a.rect[3] || a.rect[0] - b.rect[0]

/** 一篇文獻打開後的 PDF 與頁碼標籤（加到筆記、重點區共用） */
export interface OpenedPdf {
  pdf: PDFDocumentProxy
  labels: string[] | null
}

export async function openForHighlights(data: Uint8Array): Promise<OpenedPdf> {
  const pdf = await openPdf(data).promise
  const labels = await pdf.getPageLabels().catch(() => null)
  return { pdf, labels }
}

const textCache = new WeakMap<PDFDocumentProxy, Map<number, Promise<TextRun[]>>>()

function runsOf(pdf: PDFDocumentProxy, index: number): Promise<TextRun[]> {
  let m = textCache.get(pdf)
  if (!m) textCache.set(pdf, (m = new Map()))
  let p = m.get(index)
  if (!p) {
    p = pdf
      .getPage(index + 1)
      .then((page) => page.getTextContent())
      .then((c) => c.items.filter((i): i is TextItem => 'str' in i))
    m.set(index, p)
  }
  return p
}

/** 一個重點的原文與頁碼 */
export async function describe(opened: OpenedPdf, paper: Paper, annot: PdfAnnot): Promise<HighlightItem> {
  const page = pageNumberFor(annot.page, { pageLabel: opened.labels?.[annot.page], paperPages: paper.pages })
  const locator = pageLocator(page, paper.lang)
  let text = ''
  if ((annot.kind === 'highlight' || annot.kind === 'mark') && annot.quads.length) {
    text = textInQuads(await runsOf(opened.pdf, annot.page), annot.quads)
  }
  return { annot, locator, text }
}

// 同一篇文獻的重點清單暫存起來；閱讀器存回 PDF 後呼叫 forgetHighlights 重新讀
const listCache = new Map<string, Promise<{ items: HighlightItem[]; opened: OpenedPdf }>>()

/** 一篇文獻的所有重點（依位置排序） */
export function loadHighlights(paper: Paper): Promise<{ items: HighlightItem[]; opened: OpenedPdf }> {
  const hit = listCache.get(paper.id)
  if (hit) return hit
  const items = (async () => {
    const { data, annots } = await desk.reader.open(paper.id)
    const opened = await openForHighlights(data)
    const sorted = [...annots].sort(byPosition)
    return { items: await Promise.all(sorted.map((a) => describe(opened, paper, a))), opened }
  })()
  listCache.set(paper.id, items)
  items.catch(() => listCache.delete(paper.id))
  // 只留最近幾篇，舊的 PDF 關掉釋放記憶體
  while (listCache.size > 4) {
    const [oldest, p] = listCache.entries().next().value!
    listCache.delete(oldest)
    void p.then(({ opened }) => opened.pdf.destroy()).catch(() => undefined)
  }
  return items
}

export function forgetHighlights(paperId: string): void {
  const p = listCache.get(paperId)
  listCache.delete(paperId)
  void p?.then(({ opened }) => opened.pdf.destroy()).catch(() => undefined)
}
