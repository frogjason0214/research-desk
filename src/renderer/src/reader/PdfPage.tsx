import type { PageViewport, PDFDocumentProxy } from 'pdfjs-dist'
import type { TextContent, TextItem } from 'pdfjs-dist/types/src/display/api'
import { MessageSquareText, StickyNote } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { PdfAnnot } from '../../../shared/types'
import { pdfRectToBox, quadsToBoxes, type Box } from './geometry'
import { pdfjs } from './pdfjs'

export type Tool = 'select' | 'highlight' | 'area' | 'note'

/** 搜尋結果在這一頁的位置（以這一頁的文字串接後的字元位置表示） */
export interface PageHit {
  start: number
  end: number
  current: boolean
}

export interface PageHandle {
  div: HTMLDivElement
  viewport: PageViewport
}

const css = (rgb: number[]): string => `rgb(${rgb.map((v) => Math.round(v * 255)).join(' ')})`

/** 這一頁的文字串接起來（搜尋用）與每個字元屬於哪個文字片段 */
export function pageText(content: TextContent): { text: string; items: { item: TextItem; start: number }[] } {
  let text = ''
  const items: { item: TextItem; start: number }[] = []
  for (const raw of content.items) {
    if (!('str' in raw)) continue
    items.push({ item: raw, start: text.length })
    text += raw.str
    if (raw.hasEOL) text += ' '
  }
  return { text, items }
}

/** 搜尋結果 → 頁面上的方框（每個文字片段依字數比例估算位置） */
function hitBoxes(viewport: PageViewport, content: TextContent, hit: PageHit): Box[] {
  const { items } = pageText(content)
  const boxes: Box[] = []
  for (const { item, start } of items) {
    const end = start + item.str.length
    const from = Math.max(hit.start, start)
    const to = Math.min(hit.end, end)
    if (from >= to || !item.str.length) continue
    const tx = pdfjs.Util.transform(viewport.transform, item.transform)
    const fontHeight = Math.hypot(tx[2], tx[3])
    const width = item.width * viewport.scale
    const left = tx[4] + (width * (from - start)) / item.str.length
    boxes.push({ left, top: tx[5] - fontHeight, width: (width * (to - from)) / item.str.length, height: fontHeight * 1.15 })
  }
  return boxes
}

/**
 * PDF 的一頁：底圖（canvas）、可以選取的文字層、註記與搜尋結果。
 * 看得到（或快看到）時才畫，捲遠了就釋放，幾百頁的 PDF 也不會吃太多記憶體。
 */
export function PdfPage({
  pdf,
  index,
  scale,
  size,
  root,
  annots,
  tool,
  selectedKey,
  hits,
  textContent,
  onRegister,
  onSelect,
  onArea,
  onNote,
  popover
}: {
  pdf: PDFDocumentProxy
  index: number
  scale: number
  /** 縮放 1 時的頁面大小 */
  size: { width: number; height: number }
  root: HTMLElement | null
  annots: PdfAnnot[]
  tool: Tool
  selectedKey: string | null
  hits: PageHit[]
  textContent: (index: number) => Promise<TextContent>
  onRegister: (index: number, handle: PageHandle | null) => void
  onSelect: (annot: PdfAnnot) => void
  onArea: (index: number, box: Box, viewport: PageViewport) => void
  onNote: (index: number, x: number, y: number, viewport: PageViewport) => void
  popover: (annot: PdfAnnot, box: Box) => ReactNode
}) {
  const div = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const textDiv = useRef<HTMLDivElement>(null)
  const [near, setNear] = useState(false)
  const [viewport, setViewport] = useState<PageViewport | null>(null)
  const [content, setContent] = useState<TextContent | null>(null)
  const [drag, setDrag] = useState<{ x: number; y: number; w: number; h: number } | null>(null)

  // 接近畫面時才畫
  useEffect(() => {
    const el = div.current
    if (!el || !root) return
    const io = new IntersectionObserver(([e]) => setNear(e.isIntersecting), { root, rootMargin: '1200px 0px' })
    io.observe(el)
    return () => io.disconnect()
  }, [root])

  useEffect(() => {
    if (!near) {
      setViewport(null)
      return
    }
    let cancelled = false
    let renderTask: { cancel: () => void; promise: Promise<void> } | null = null
    let textLayer: { cancel: () => void } | null = null
    void (async () => {
      const page = await pdf.getPage(index + 1)
      if (cancelled) return
      const vp = page.getViewport({ scale })
      const dpr = window.devicePixelRatio || 1
      const c = canvas.current!
      c.width = Math.floor(vp.width * dpr)
      c.height = Math.floor(vp.height * dpr)
      c.style.width = `${vp.width}px`
      c.style.height = `${vp.height}px`
      renderTask = page.render({
        canvasContext: c.getContext('2d')!,
        viewport: vp,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined
      })
      setViewport(vp)
      onRegister(index, { div: div.current!, viewport: vp })
      const tc = await textContent(index)
      if (cancelled) return
      setContent(tc)
      const t = textDiv.current!
      t.replaceChildren()
      const layer = new pdfjs.TextLayer({ textContentSource: tc, container: t, viewport: vp })
      textLayer = layer
      await layer.render().catch(() => undefined)
      await renderTask.promise.catch(() => undefined)
    })()
    return () => {
      cancelled = true
      renderTask?.cancel()
      textLayer?.cancel()
      textDiv.current?.replaceChildren()
      const c = canvas.current
      if (c) {
        c.width = 0
        c.height = 0
      }
      onRegister(index, null)
    }
    // onRegister、textContent 由上層固定提供
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [near, scale, pdf, index])

  const width = size.width * scale
  const height = size.height * scale

  // 框選與放便利貼：位置相對於這一頁
  const local = (e: React.PointerEvent): { x: number; y: number } => {
    const r = div.current!.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }
  const capture = tool === 'area' || tool === 'note'

  return (
    <div
      ref={div}
      className={`rd-page tool-${tool}`}
      data-page={index}
      style={{ width, height, ['--scale-factor' as string]: scale }}
    >
      <canvas ref={canvas} className="rd-canvas" />
      <div ref={textDiv} className="textLayer" />
      <div
        className="rd-overlay"
        style={{ pointerEvents: capture ? 'auto' : 'none' }}
        onPointerDown={(e) => {
          if (!capture || e.button !== 0 || !viewport) return
          const p = local(e)
          if (tool === 'note') {
            // 不讓瀏覽器把焦點移到捲動區，便利貼的輸入框才拿得到焦點
            e.preventDefault()
            onNote(index, p.x, p.y, viewport)
            return
          }
          e.currentTarget.setPointerCapture(e.pointerId)
          setDrag({ x: p.x, y: p.y, w: 0, h: 0 })
        }}
        onPointerMove={(e) => {
          if (!drag) return
          const p = local(e)
          setDrag({ ...drag, w: p.x - drag.x, h: p.y - drag.y })
        }}
        onPointerUp={() => {
          if (!drag || !viewport) return
          const box = {
            left: Math.min(drag.x, drag.x + drag.w),
            top: Math.min(drag.y, drag.y + drag.h),
            width: Math.abs(drag.w),
            height: Math.abs(drag.h)
          }
          setDrag(null)
          if (box.width > 6 && box.height > 6) onArea(index, box, viewport)
        }}
      >
        {viewport &&
          annots.map((a) => {
            const selected = a.key === selectedKey
            const clickable = tool === 'select'
            const common = {
              // 外框蓋住整頁但不接收滑鼠，只有色塊和便利貼可以點
              className: `rd-annot is-${a.kind}${a.mine ? '' : ' is-foreign'}${selected ? ' is-selected' : ''}${clickable ? ' is-clickable' : ''}`,
              onClick: (e: React.MouseEvent) => {
                e.stopPropagation()
                onSelect(a)
              },
              title: a.contents || undefined,
              'data-key': a.key
            }
            if (a.kind === 'note') {
              const b = pdfRectToBox(viewport, a.rect)
              return (
                <button key={a.key} {...common} style={{ left: b.left, top: b.top, background: css(a.rgb), pointerEvents: clickable ? 'auto' : 'none' }} aria-label={`便利貼：${a.contents || '（空白）'}`}>
                  <StickyNote size={14} aria-hidden />
                </button>
              )
            }
            const boxes = a.kind === 'highlight' || a.kind === 'mark' ? quadsToBoxes(viewport, a.quads) : [pdfRectToBox(viewport, a.rect)]
            const shown = boxes.length ? boxes : [pdfRectToBox(viewport, a.rect)]
            const last = shown[shown.length - 1]
            return (
              <div key={a.key} {...common} role="button" aria-label={a.contents ? `重點，註解：${a.contents}` : '重點'}>
                {shown.map((b, i) => (
                  <span
                    key={i}
                    className="rd-annot-box"
                    style={{ left: b.left, top: b.top, width: b.width, height: b.height, ['--c' as string]: css(a.rgb) }}
                  />
                ))}
                {a.contents && a.kind !== 'mark' && (
                  <span className="rd-annot-comment" style={{ left: last.left + last.width - 6, top: last.top - 10 }}>
                    <MessageSquareText size={12} aria-hidden />
                  </span>
                )}
              </div>
            )
          })}
        {viewport &&
          content &&
          hits.flatMap((h, i) =>
            hitBoxes(viewport, content, h).map((b, j) => (
              <span
                key={`h${i}-${j}`}
                className={`rd-hit${h.current ? ' is-current' : ''}`}
                style={{ left: b.left, top: b.top, width: b.width, height: b.height }}
              />
            ))
          )}
        {drag && (
          <span
            className="rd-drag"
            style={{
              left: Math.min(drag.x, drag.x + drag.w),
              top: Math.min(drag.y, drag.y + drag.h),
              width: Math.abs(drag.w),
              height: Math.abs(drag.h)
            }}
          />
        )}
      </div>
      {viewport &&
        annots
          .filter((a) => a.key === selectedKey)
          .map((a) => {
            const b = a.kind === 'highlight' || a.kind === 'mark' ? (quadsToBoxes(viewport, a.quads)[0] ?? pdfRectToBox(viewport, a.rect)) : pdfRectToBox(viewport, a.rect)
            return <div key={a.key}>{popover(a, b)}</div>
          })}
      {!viewport && <span className="rd-page-num">{index + 1}</span>}
    </div>
  )
}
