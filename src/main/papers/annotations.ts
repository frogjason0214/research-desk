import {
  closePath,
  fill,
  lineTo,
  moveTo,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFString,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  setFillingRgbColor,
  setGraphicsState,
  setLineWidth,
  setStrokingRgbColor,
  stroke,
  type PDFPage
} from 'pdf-lib'
import { HIGHLIGHT_COLORS, OUR_KEY_PREFIX } from '../../shared/annots'
import type { HighlightColor, PdfAnnot, PdfAnnotOp } from '../../shared/types'

// PDF 註記的讀寫（純資料處理，不碰檔案）：
// - 螢光筆（Highlight）、框選（Square）、便利貼（Text）用 PDF 標準格式寫進去，Acrobat、預覽程式都看得到。
// - 便利貼的文字放在 /Contents，由各閱讀器用系統字型顯示，中文不會有字型問題。
// - 每個註記有編號（/NM），存檔時以「一個註記」為單位套用修改，兩台電腦畫的重點都會留下。

const COLORS = HIGHLIGHT_COLORS
const OURS = OUR_KEY_PREFIX
const AUTHOR = 'Research Desk'
/** 由本程式管理（畫在畫面上、可以刪除）的註記種類；其他種類交給 pdf.js 直接畫 */
const MANAGED = new Set(['Highlight', 'Underline', 'StrikeOut', 'Squiggly', 'Square', 'Text'])
const NOTE_SIZE = 20

export class UnsupportedPdfError extends Error {}

export async function loadPdf(bytes: Uint8Array): Promise<PDFDocument> {
  const encrypted = new UnsupportedPdfError('這個 PDF 有加密保護，只能閱讀，不能畫重點。')
  const odd = new UnsupportedPdfError('這個 PDF 的格式比較特殊，只能閱讀，不能畫重點。')
  let doc: PDFDocument
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false })
    if (doc.getPageCount() === 0) throw odd
  } catch (err) {
    throw err instanceof Error && /encrypt/i.test(err.message) ? encrypted : odd
  }
  if (doc.isEncrypted) throw encrypted
  return doc
}

const num = (o: unknown): number => (o instanceof PDFNumber ? o.asNumber() : 0)
const nums = (arr: PDFArray | undefined): number[] => (arr ? arr.asArray().map(num) : [])
const text = (o: unknown): string => (o instanceof PDFString || o instanceof PDFHexString ? o.decodeText() : '')
const round = (n: number): number => Math.round(n * 100) / 100

function annotRefs(page: PDFPage): { ref: PDFRef | null; dict: PDFDict }[] {
  const arr = page.node.Annots()
  if (!arr) return []
  return arr.asArray().flatMap((o) => {
    const dict = o instanceof PDFRef ? page.doc.context.lookup(o) : o
    return dict instanceof PDFDict ? [{ ref: o instanceof PDFRef ? o : null, dict }] : []
  })
}

function colorName(rgb: number[]): HighlightColor | null {
  for (const [name, c] of Object.entries(COLORS) as [HighlightColor, number[]][])
    if (c.every((v, i) => Math.abs(v - (rgb[i] ?? -1)) < 0.02)) return name
  return null
}

/** 註記的編號：有 /NM 用 /NM，否則用種類＋頁碼＋位置 */
function keyOf(dict: PDFDict, pageIndex: number): string {
  const nm = text(dict.get(PDFName.of('NM')))
  if (nm) return nm
  const subtype = dict.get(PDFName.of('Subtype'))?.toString().slice(1)
  const rect = nums(dict.lookupMaybe(PDFName.of('Rect'), PDFArray)).map((n) => Math.round(n))
  return `p${pageIndex}-${subtype}-${rect.join('_')}`
}

function toAnnot(dict: PDFDict, pageIndex: number): PdfAnnot | null {
  const subtype = dict.get(PDFName.of('Subtype'))?.toString().slice(1) ?? ''
  if (!MANAGED.has(subtype)) return null
  const key = keyOf(dict, pageIndex)
  const mine = key.startsWith(OURS)
  const rgbRaw = nums(dict.lookupMaybe(PDFName.of(subtype === 'Square' ? 'IC' : 'C'), PDFArray))
  const rgbFallback = nums(dict.lookupMaybe(PDFName.of('C'), PDFArray))
  const rgb = (rgbRaw.length === 3 ? rgbRaw : rgbFallback.length === 3 ? rgbFallback : COLORS.yellow) as [number, number, number]
  const rect = nums(dict.lookupMaybe(PDFName.of('Rect'), PDFArray))
  const r: [number, number, number, number] = [
    Math.min(rect[0] ?? 0, rect[2] ?? 0),
    Math.min(rect[1] ?? 0, rect[3] ?? 0),
    Math.max(rect[0] ?? 0, rect[2] ?? 0),
    Math.max(rect[1] ?? 0, rect[3] ?? 0)
  ]
  const kind: PdfAnnot['kind'] =
    subtype === 'Highlight' ? 'highlight' : subtype === 'Square' ? 'area' : subtype === 'Text' ? 'note' : 'mark'
  return {
    key,
    page: pageIndex,
    kind,
    color: colorName(rgb),
    rgb: rgb.map(round) as [number, number, number],
    rect: r.map(round) as [number, number, number, number],
    quads: nums(dict.lookupMaybe(PDFName.of('QuadPoints'), PDFArray)).map(round),
    contents: text(dict.get(PDFName.of('Contents'))),
    mine
  }
}

/** 列出所有本程式管理的註記（回覆別人註記的註解不單獨列出） */
export function readAnnots(doc: PDFDocument): PdfAnnot[] {
  const out: PdfAnnot[] = []
  doc.getPages().forEach((page, i) => {
    for (const { dict } of annotRefs(page)) {
      if (dict.get(PDFName.of('IRT'))) continue
      const a = toAnnot(dict, i)
      if (a) out.push(a)
    }
  })
  return out
}

/** 給 pdf.js 畫頁面用：拿掉本程式管理的註記（改由畫面另外畫，才能點選、刪除） */
export async function stripManaged(doc: PDFDocument): Promise<Uint8Array> {
  for (const page of doc.getPages()) {
    for (const { ref, dict } of annotRefs(page)) {
      const subtype = dict.get(PDFName.of('Subtype'))?.toString().slice(1) ?? ''
      if ((MANAGED.has(subtype) || subtype === 'Popup') && ref) page.node.removeAnnot(ref)
    }
  }
  return doc.save({ useObjectStreams: false })
}

// ---------- 寫入 ----------

/** 外觀（appearance stream）：其他閱讀器照這個畫，不用自己猜 */
function appearance(doc: PDFDocument, a: PdfAnnot): PDFRef {
  const [x1, y1, x2, y2] = a.rect
  const [r, g, b] = a.rgb
  const ops =
    a.kind === 'note'
      ? [
          pushGraphicsState(),
          setFillingRgbColor(r, g, b),
          rectangle(x1, y1, x2 - x1, y2 - y1),
          fill(),
          setStrokingRgbColor(0.35, 0.3, 0.1),
          setLineWidth(1),
          ...[0.7, 0.5, 0.3].flatMap((t) => [
            moveTo(x1 + 4, y1 + (y2 - y1) * t),
            lineTo(x2 - 4, y1 + (y2 - y1) * t),
            stroke()
          ]),
          popGraphicsState()
        ]
      : [
          pushGraphicsState(),
          setGraphicsState('GS0'),
          setFillingRgbColor(r, g, b),
          ...(a.kind === 'highlight' ? quadsOf(a) : [[x1, y2, x2, y2, x1, y1, x2, y1]]).flatMap((q) => [
            moveTo(q[0], q[1]),
            lineTo(q[2], q[3]),
            lineTo(q[6], q[7]),
            lineTo(q[4], q[5]),
            closePath(),
            fill()
          ]),
          popGraphicsState()
        ]
  const stream = doc.context.formXObject(ops, {
    BBox: [x1, y1, x2, y2],
    Resources: { ExtGState: { GS0: { Type: 'ExtGState', BM: 'Multiply', CA: 1, ca: 1 } } }
  })
  return doc.context.register(stream)
}

const quadsOf = (a: PdfAnnot): number[][] => {
  const q: number[][] = []
  for (let i = 0; i + 7 < a.quads.length; i += 8) q.push(a.quads.slice(i, i + 8))
  return q
}

function writeAnnot(doc: PDFDocument, a: PdfAnnot): void {
  const page = doc.getPage(a.page)
  if (!page) return
  if (a.kind === 'note') a = { ...a, rect: [a.rect[0], a.rect[3] - NOTE_SIZE, a.rect[0] + NOTE_SIZE, a.rect[3]] }
  const ctx = doc.context
  const subtype = a.kind === 'highlight' ? 'Highlight' : a.kind === 'area' ? 'Square' : 'Text'
  const dict: Record<string, unknown> = {
    Type: 'Annot',
    Subtype: subtype,
    Rect: a.rect,
    NM: PDFHexString.fromText(a.key),
    T: PDFHexString.fromText(AUTHOR),
    M: PDFString.fromDate(new Date()),
    F: 4,
    P: page.ref,
    C: a.rgb,
    Contents: PDFHexString.fromText(a.contents),
    AP: { N: appearance(doc, a) }
  }
  if (a.kind === 'highlight') dict.QuadPoints = a.quads
  if (a.kind === 'area') Object.assign(dict, { IC: a.rgb, BS: { W: 0 } })
  if (a.kind === 'note') Object.assign(dict, { Name: 'Comment', Open: false })
  const ref = ctx.register(ctx.obj(dict as never))
  page.node.addAnnot(ref)
  // Acrobat 用 Popup 顯示註解文字
  if (a.kind === 'note' || a.contents) {
    const [x1, , x2, y2] = a.rect
    const popup = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Popup', Rect: [x2 + 4, y2 - 120, x2 + 204, y2], Parent: ref, Open: false } as never))
    ;(ctx.lookup(ref) as PDFDict).set(PDFName.of('Popup'), popup)
    page.node.addAnnot(popup)
    void x1
  }
}

function findAnnot(doc: PDFDocument, key: string): { page: PDFPage; index: number; ref: PDFRef | null; dict: PDFDict } | null {
  const pages = doc.getPages()
  for (let i = 0; i < pages.length; i++) {
    for (const item of annotRefs(pages[i])) if (keyOf(item.dict, i) === key) return { page: pages[i], index: i, ...item }
  }
  return null
}

function removeAnnot(doc: PDFDocument, key: string): void {
  const found = findAnnot(doc, key)
  if (!found?.ref) return
  const { page, ref } = found
  // 連帶刪掉它的 Popup，以及回覆它的註解
  for (const item of annotRefs(page)) {
    const parent = item.dict.get(PDFName.of('Parent'))
    const irt = item.dict.get(PDFName.of('IRT'))
    if (item.ref && (parent === ref || irt === ref)) {
      page.node.removeAnnot(item.ref)
      dropObject(doc, item.ref, item.dict)
    }
  }
  page.node.removeAnnot(ref)
  dropObject(doc, ref, found.dict)
}

/** 從檔案裡真的刪掉（pdf-lib 預設會把沒用到的物件留在檔案裡，改幾次檔案就越來越大） */
function dropObject(doc: PDFDocument, ref: PDFRef, dict: PDFDict): void {
  const ap = dict.lookupMaybe(PDFName.of('AP'), PDFDict)
  for (const key of ['N', 'R', 'D']) {
    const stream = ap?.get(PDFName.of(key))
    if (stream instanceof PDFRef) doc.context.delete(stream)
  }
  doc.context.delete(ref)
}

/** 依序套用修改；重複套用同一個修改不會出錯（例如新增已經存在的註記會略過） */
export function applyOps(doc: PDFDocument, ops: PdfAnnotOp[]): void {
  for (const op of ops) {
    if (op.type === 'add') {
      if (!findAnnot(doc, op.annot.key)) writeAnnot(doc, op.annot)
    } else if (op.type === 'remove') {
      removeAnnot(doc, op.key)
    } else {
      const found = findAnnot(doc, op.key)
      if (!found) continue
      const current = toAnnot(found.dict, found.index)
      if (!current?.mine) continue // 其他程式的註記只能刪除
      // 重新寫一次（外觀要跟著換顏色）
      const next: PdfAnnot = {
        ...current,
        contents: op.contents ?? current.contents,
        ...(op.color ? { color: op.color, rgb: COLORS[op.color] } : {})
      }
      if (current.kind === 'note') next.rect = [current.rect[0], current.rect[3] - NOTE_SIZE, current.rect[0] + NOTE_SIZE, current.rect[3]]
      removeAnnot(doc, op.key)
      writeAnnot(doc, next)
    }
  }
}
