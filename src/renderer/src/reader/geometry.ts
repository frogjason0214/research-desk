import type { PageViewport } from 'pdfjs-dist'

// 畫面座標（每一頁左上角為原點的 CSS 像素）與 PDF 座標（點、左下角為原點）互換

export interface Box {
  left: number
  top: number
  width: number
  height: number
}

/** PDF 的矩形 → 頁面上的方框 */
export function pdfRectToBox(viewport: PageViewport, rect: number[]): Box {
  const [x1, y1, x2, y2] = viewport.convertToViewportRectangle(rect)
  return { left: Math.min(x1, x2), top: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) }
}

/** 螢光筆每一行（四個角）→ 頁面上的方框 */
export function quadsToBoxes(viewport: PageViewport, quads: number[]): Box[] {
  const boxes: Box[] = []
  for (let i = 0; i + 7 < quads.length; i += 8) {
    const pts = [0, 2, 4, 6].map((j) => viewport.convertToViewportPoint(quads[i + j], quads[i + j + 1]))
    const xs = pts.map((p) => p[0])
    const ys = pts.map((p) => p[1])
    const left = Math.min(...xs)
    const top = Math.min(...ys)
    boxes.push({ left, top, width: Math.max(...xs) - left, height: Math.max(...ys) - top })
  }
  return boxes
}

/** 頁面上的方框 → PDF 矩形 [x1, y1, x2, y2]（x1 < x2、y1 < y2） */
export function boxToPdfRect(viewport: PageViewport, b: Box): [number, number, number, number] {
  const [ax, ay] = viewport.convertToPdfPoint(b.left, b.top)
  const [bx, by] = viewport.convertToPdfPoint(b.left + b.width, b.top + b.height)
  return [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)].map((n) => Math.round(n * 100) / 100) as [
    number,
    number,
    number,
    number
  ]
}

/** 選取文字的方框：同一行相鄰的合併成一條（一行一個螢光筆區塊） */
export function mergeLines(boxes: Box[]): Box[] {
  const sorted = boxes.filter((b) => b.width > 0.5 && b.height > 0.5).sort((a, b) => a.top - b.top || a.left - b.left)
  const lines: Box[] = []
  for (const b of sorted) {
    const line = lines.find((l) => {
      const overlap = Math.min(l.top + l.height, b.top + b.height) - Math.max(l.top, b.top)
      const near = b.left <= l.left + l.width + Math.max(l.height, b.height) * 1.5 && b.left + b.width >= l.left - Math.max(l.height, b.height) * 1.5
      return overlap > Math.min(l.height, b.height) * 0.5 && near
    })
    if (!line) {
      lines.push({ ...b })
      continue
    }
    const right = Math.max(line.left + line.width, b.left + b.width)
    const bottom = Math.max(line.top + line.height, b.top + b.height)
    line.left = Math.min(line.left, b.left)
    line.top = Math.min(line.top, b.top)
    line.width = right - line.left
    line.height = bottom - line.top
  }
  return lines
}

/** 每一行 → PDF 的 QuadPoints（左上、右上、左下、右下），以及包住全部的矩形 */
export function boxesToQuads(viewport: PageViewport, lines: Box[]): { quads: number[]; rect: [number, number, number, number] } {
  const quads: number[] = []
  let rect: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity]
  for (const l of lines) {
    const [x1, y1, x2, y2] = boxToPdfRect(viewport, l)
    quads.push(x1, y2, x2, y2, x1, y1, x2, y1)
    rect = [Math.min(rect[0], x1), Math.min(rect[1], y1), Math.max(rect[2], x2), Math.max(rect[3], y2)]
  }
  return { quads, rect }
}
