import type { PageViewport, PDFDocumentProxy } from 'pdfjs-dist'
import type { TextContent } from 'pdfjs-dist/types/src/display/api'
import 'pdfjs-dist/web/pdf_viewer.css'
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Copy,
  ExternalLink,
  Highlighter,
  History,
  Languages,
  MousePointer2,
  Search,
  SquareDashed,
  StickyNote,
  Trash2,
  Undo2,
  ZoomIn,
  ZoomOut
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { HIGHLIGHT_COLORS, newAnnotKey, replayOps } from '../../../shared/annots'
import type { HighlightColor, Paper, PdfAnnot, PdfAnnotOp, ReaderStatus } from '../../../shared/types'
import { IconButton } from '../components/IconButton'
import { errorText } from '../importing'
import { shortcut } from '../platform'
import { desk } from '../useDesk'
import { boxesToQuads, boxToPdfRect, mergeLines, type Box } from './geometry'
import { pageText, PdfPage, type PageHandle, type PageHit, type Tool } from './PdfPage'
import { openPdf } from './pdfjs'

const COLOR_LABELS: Record<HighlightColor, string> = { yellow: '黃', green: '綠', blue: '藍', pink: '粉' }
const SEND_DELAY_MS = 1200
const MIN_SCALE = 0.5
const MAX_SCALE = 3
const PAGE_GAP = 12

const remember = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key)
    } catch {
      return null
    }
  },
  set(key: string, value: string): void {
    try {
      localStorage.setItem(key, value)
    } catch {
      /* 無法儲存就算了 */
    }
  }
}

/** 復原時要做的相反動作；null 表示不能復原（刪除其他程式的註記） */
function inverse(op: PdfAnnotOp, before: PdfAnnot[]): PdfAnnotOp | null {
  if (op.type === 'add') return { type: 'remove', key: op.annot.key }
  const old = before.find((a) => a.key === op.key)
  if (!old) return null
  if (op.type === 'remove') return old.mine ? { type: 'add', annot: old } : null
  return { type: 'update', key: op.key, contents: old.contents, color: old.color ?? undefined }
}

const STATE_TEXT: Record<ReaderStatus['state'], string> = {
  saved: '已存回 PDF',
  pending: '儲存中…',
  locked: 'PDF 正在其他程式開著，關掉後會自動存檔',
  error: '存檔失敗'
}

export function ReaderView({ paper, onBack }: { paper: Paper; onBack: () => void }) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [sizes, setSizes] = useState<{ width: number; height: number }[]>([])
  const [readOnly, setReadOnly] = useState<string | null>(null)
  const [hasBackup, setHasBackup] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [fileAnnots, setFileAnnots] = useState<PdfAnnot[]>([])
  const [unsent, setUnsent] = useState<PdfAnnotOp[]>([])
  const [saveState, setSaveState] = useState<ReaderStatus | null>(null)
  const [tool, setTool] = useState<Tool>('select')
  const [color, setColor] = useState<HighlightColor>('yellow')
  const [scale, setScale] = useState(1)
  const [selected, setSelected] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState<{ page: number; start: number; end: number }[] | null>(null)
  const [matchIndex, setMatchIndex] = useState(0)
  const [actionError, setActionError] = useState<string | null>(null)
  const [translation, setTranslation] = useState<Translation | null>(null)
  const scroller = useRef<HTMLDivElement | null>(null)
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null)
  const pages = useRef(new Map<number, PageHandle>())
  const texts = useRef(new Map<number, Promise<TextContent>>())
  const undoStack = useRef<PdfAnnotOp[]>([])
  const sendTimer = useRef<number | undefined>(undefined)
  const unsentRef = useRef<PdfAnnotOp[]>([])
  const searchInput = useRef<HTMLInputElement>(null)
  // 放便利貼的那一下點擊不要當成「點旁邊關閉」
  const justPlaced = useRef(false)
  const pageKey = `reader.page.${paper.id}`

  const annots = useMemo(() => replayOps(fileAnnots, unsent), [fileAnnots, unsent])
  const byPage = useMemo(() => {
    const m = new Map<number, PdfAnnot[]>()
    for (const a of annots) m.set(a.page, [...(m.get(a.page) ?? []), a])
    return m
  }, [annots])

  // ---------- 開啟 ----------
  useEffect(() => {
    let doc: PDFDocumentProxy | null = null
    let cancelled = false
    void (async () => {
      try {
        const opened = await desk.reader.open(paper.id)
        if (cancelled) return
        setReadOnly(opened.readOnly)
        setHasBackup(opened.hasBackup)
        setFileAnnots(opened.annots)
        doc = await openPdf(opened.data).promise
        if (cancelled) return
        const list: { width: number; height: number }[] = []
        for (let i = 1; i <= doc.numPages; i++) {
          const vp = (await doc.getPage(i)).getViewport({ scale: 1 })
          list.push({ width: vp.width, height: vp.height })
        }
        if (cancelled) return
        setSizes(list)
        setPdf(doc)
      } catch (err) {
        setLoadError(errorText(err))
      }
    })()
    const off = desk.onReaderStatus((s) => {
      if (s.paperId !== paper.id) return
      setFileAnnots(s.annots)
      setSaveState(s)
      if (s.state === 'saved') setHasBackup(true)
    })
    return () => {
      cancelled = true
      off()
      void doc?.destroy()
    }
  }, [paper.id])

  // 第一次排好版面：適合寬度、回到上次讀到的頁
  useEffect(() => {
    if (!pdf || !sizes.length || !scroller.current) return
    const width = scroller.current.clientWidth - 72 // 左右留白與捲軸
    const fit = Math.min(MAX_SCALE, Math.max(MIN_SCALE, width / Math.max(...sizes.map((s) => s.width))))
    setScale(Math.round(fit * 100) / 100)
    const last = Number(remember.get(pageKey) ?? 1)
    requestAnimationFrame(() => goToPage(Math.min(Math.max(1, last), sizes.length), fit, 'auto'))
    // 只在開啟時執行
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdf, sizes])

  const textContent = useCallback(
    (index: number): Promise<TextContent> => {
      let t = texts.current.get(index)
      if (!t && pdf) {
        t = pdf.getPage(index + 1).then((p) => p.getTextContent())
        texts.current.set(index, t)
      }
      return t ?? Promise.reject(new Error('PDF 還沒開啟'))
    },
    [pdf]
  )
  const register = useCallback((index: number, handle: PageHandle | null) => {
    if (handle) pages.current.set(index, handle)
    else pages.current.delete(index)
  }, [])

  // ---------- 頁數與縮放 ----------
  const pageTop = (index: number, s = scale): number => sizes.slice(0, index).reduce((y, p) => y + p.height * s + PAGE_GAP, 0)
  function goToPage(n: number, s = scale, behavior: ScrollBehavior = 'smooth'): void {
    scroller.current?.scrollTo({ top: pageTop(n - 1, s), behavior })
  }
  const onScroll = (): void => {
    const el = scroller.current
    if (!el || !sizes.length) return
    const mid = el.scrollTop + el.clientHeight / 3
    let y = 0
    let n = sizes.length
    for (let i = 0; i < sizes.length; i++) {
      y += sizes[i].height * scale + PAGE_GAP
      if (y > mid) {
        n = i + 1
        break
      }
    }
    if (n !== page) {
      setPage(n)
      remember.set(pageKey, String(n))
    }
  }
  const zoom = (next: number): void => {
    const el = scroller.current
    const ratio = el ? el.scrollTop / Math.max(1, el.scrollHeight) : 0
    const s = Math.round(Math.min(MAX_SCALE, Math.max(MIN_SCALE, next)) * 100) / 100
    setScale(s)
    requestAnimationFrame(() => el && (el.scrollTop = ratio * el.scrollHeight))
  }

  // ---------- 修改：先在畫面上生效，停一下再送去寫入 PDF ----------
  const send = (): void => {
    window.clearTimeout(sendTimer.current)
    sendTimer.current = undefined
    const ops = unsentRef.current
    if (!ops.length) return
    unsentRef.current = []
    void desk.reader.queue(paper.id, ops).then((s) => {
      setFileAnnots(s.annots)
      setSaveState(s)
      setUnsent(unsentRef.current)
    })
  }
  const apply = (op: PdfAnnotOp, undoable = true): void => {
    if (readOnly) return
    if (undoable) {
      const inv = inverse(op, replayOps(fileAnnots, unsentRef.current))
      if (inv) undoStack.current.push(inv)
    }
    unsentRef.current = [...unsentRef.current, op]
    setUnsent(unsentRef.current)
    window.clearTimeout(sendTimer.current)
    sendTimer.current = window.setTimeout(send, SEND_DELAY_MS)
  }
  const undo = (): void => {
    const op = undoStack.current.pop()
    if (op) apply(op, false)
  }
  // 離開閱讀器時把還沒送出的修改送出
  useEffect(() => () => send(), [])

  const newAnnot = (pageIndex: number, kind: PdfAnnot['kind'], rect: PdfAnnot['rect'], quads: number[] = []): PdfAnnot => ({
    key: newAnnotKey(),
    page: pageIndex,
    kind,
    color: kind === 'note' ? 'yellow' : color,
    rgb: HIGHLIGHT_COLORS[kind === 'note' ? 'yellow' : color],
    rect,
    quads,
    contents: '',
    mine: true
  })

  /** 選取工具：放開滑鼠時在選取的文字旁邊放「翻譯」按鈕 */
  const offerTranslation = (): void => {
    const sel = window.getSelection()
    const el = scroller.current
    const text = sel && !sel.isCollapsed && sel.rangeCount ? sel.toString().trim() : ''
    if (!el || !text || !el.contains(sel!.anchorNode)) {
      setTranslation(null)
      return
    }
    const rects = [...sel!.getRangeAt(0).getClientRects()].filter((r) => r.width > 0)
    const last = rects[rects.length - 1]
    if (!last) return
    const box = el.getBoundingClientRect()
    setTranslation({
      text,
      left: Math.max(0, last.right - box.left + el.scrollLeft - 40),
      top: last.bottom - box.top + el.scrollTop + 6,
      state: 'offer'
    })
  }

  const translate = async (): Promise<void> => {
    const t = translation
    if (!t) return
    setTranslation({ ...t, state: 'loading' })
    try {
      const r = await desk.translate.text(t.text)
      setTranslation((cur) => (cur && cur.text === t.text ? { ...cur, state: 'done', result: r.text } : cur))
    } catch (err) {
      setTranslation((cur) => (cur && cur.text === t.text ? { ...cur, state: 'error', result: errorText(err) } : cur))
    }
  }

  /** 螢光筆：放開滑鼠時把選取的文字變成重點（可以跨頁） */
  const onMouseUp = (e: React.MouseEvent): void => {
    if (tool === 'select') {
      if (!(e.target as HTMLElement).closest('.rd-translate, .rd-popover')) offerTranslation()
      return
    }
    if (tool !== 'highlight' || readOnly) return
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || !sel.rangeCount) return
    const rects = [...sel.getRangeAt(0).getClientRects()]
    for (const [index, { div, viewport }] of pages.current) {
      const r = div.getBoundingClientRect()
      const inPage: Box[] = rects
        .filter((c) => c.top >= r.top - 2 && c.bottom <= r.bottom + 2 && c.left >= r.left - 2 && c.right <= r.right + 2)
        .filter((c) => c.height < r.height / 4)
        .map((c) => ({ left: c.left - r.left, top: c.top - r.top, width: c.width, height: c.height }))
      const lines = mergeLines(inPage)
      if (!lines.length) continue
      const { quads, rect } = boxesToQuads(viewport, lines)
      apply({ type: 'add', annot: newAnnot(index, 'highlight', rect, quads) })
    }
    sel.removeAllRanges()
  }

  const onArea = (index: number, box: Box, viewport: PageViewport): void =>
    apply({ type: 'add', annot: newAnnot(index, 'area', boxToPdfRect(viewport, box)) })

  const onNote = (index: number, x: number, y: number, viewport: PageViewport): void => {
    const rect = boxToPdfRect(viewport, { left: x - 10, top: y - 10, width: 20, height: 20 })
    const a = newAnnot(index, 'note', rect)
    apply({ type: 'add', annot: a })
    setTool('select')
    setSelected(a.key)
    justPlaced.current = true
  }

  // ---------- 搜尋 ----------
  const runSearch = async (q: string): Promise<void> => {
    const needle = q.trim().toLowerCase()
    if (!pdf || !needle) {
      setMatches(null)
      return
    }
    const found: { page: number; start: number; end: number }[] = []
    for (let i = 0; i < pdf.numPages; i++) {
      const { text } = pageText(await textContent(i))
      const hay = text.toLowerCase()
      for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + needle.length))
        found.push({ page: i, start: at, end: at + needle.length })
    }
    setMatches(found)
    setMatchIndex(0)
    if (found.length) showMatch(found[0])
  }
  const showMatch = (m: { page: number; start: number }): void => {
    const el = scroller.current
    if (!el) return
    el.scrollTo({ top: pageTop(m.page) - 40, behavior: 'smooth' })
  }
  const step = (dir: 1 | -1): void => {
    if (!matches?.length) return
    const i = (matchIndex + dir + matches.length) % matches.length
    setMatchIndex(i)
    showMatch(matches[i])
  }
  const hitsFor = (index: number): PageHit[] =>
    (matches ?? []).flatMap((m, i) => (m.page === index ? [{ start: m.start, end: m.end, current: i === matchIndex }] : []))

  // ---------- 鍵盤 ----------
  const onKeyDown = (e: React.KeyboardEvent): void => {
    const target = e.target as HTMLElement
    const typing = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA'
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault()
      searchInput.current?.focus()
      searchInput.current?.select()
    } else if (!typing && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault()
      undo()
    } else if (!typing && (e.key === 'Delete' || e.key === 'Backspace') && selected) {
      e.preventDefault()
      removeAnnot(selected)
    } else if (e.key === 'Escape' && !typing) {
      setTranslation(null)
      setSelected(null)
      setConfirm(null)
      setTool('select')
    }
  }

  const removeAnnot = (key: string): void => {
    const a = latest().find((x) => x.key === key)
    if (!a) return
    // 其他程式畫的刪掉就不能復原，再按一次才刪
    if (!a.mine && confirm !== key) {
      setConfirm(key)
      return
    }
    apply({ type: 'remove', key })
    setSelected(null)
    setConfirm(null)
  }

  /** 畫面上最新的註記（剛改的還沒重新整理畫面時也算進去） */
  const latest = (): PdfAnnot[] => replayOps(fileAnnots, unsentRef.current)

  const closePopover = (): void => {
    const a = latest().find((x) => x.key === selected)
    // 沒寫字的便利貼不留
    if (a?.kind === 'note' && a.mine && !a.contents.trim()) {
      undoStack.current.pop()
      apply({ type: 'remove', key: a.key }, false)
    }
    setSelected(null)
    setConfirm(null)
  }

  const popover = (a: PdfAnnot, box: Box) => (
    <AnnotPopover
      annot={a}
      box={box}
      readOnly={!!readOnly}
      confirming={confirm === a.key}
      onColor={(c) => apply({ type: 'update', key: a.key, color: c })}
      onContents={(text) => {
        const cur = latest().find((x) => x.key === a.key)
        if (cur && text !== cur.contents) apply({ type: 'update', key: a.key, contents: text })
      }}
      onRemove={() => removeAnnot(a.key)}
      onClose={closePopover}
    />
  )

  const restore = (): void => {
    if (confirm !== 'restore') {
      setConfirm('restore')
      return
    }
    setConfirm(null)
    void (async () => {
      try {
        send()
        await desk.reader.restore(paper.id)
        // 重新開啟
        texts.current.clear()
        undoStack.current = []
        const opened = await desk.reader.open(paper.id)
        setFileAnnots(opened.annots)
        setHasBackup(false)
        const doc = await openPdf(opened.data).promise
        setPdf(doc)
      } catch (err) {
        setActionError(errorText(err))
      }
    })()
  }

  // 畫面上的修改還沒送出時也算「儲存中」，不要顯示上一次的「已存回」
  const state = unsent.length && saveState?.state !== 'locked' ? 'pending' : (saveState?.state ?? null)

  return (
    <div className="reader" onKeyDown={onKeyDown}>
      <div className="reader-bar" role="toolbar" aria-label="閱讀器">
        <IconButton icon={ArrowLeft} label="返回文獻清單" onClick={onBack} />
        <span className="reader-title" title={paper.title}>
          {paper.title || '（沒有標題）'}
        </span>
        {sizes.length > 0 && (
          <span className="reader-pages">
            <input
              aria-label="跳到第幾頁"
              value={page}
              onChange={(e) => setPage(Number(e.target.value.replace(/\D/g, '')) || 1)}
              onKeyDown={(e) => e.key === 'Enter' && goToPage(Math.min(Math.max(1, page), sizes.length))}
            />
            / {sizes.length}
          </span>
        )}
        <IconButton icon={ZoomOut} label="縮小" onClick={() => zoom(scale - 0.15)} />
        <span className="reader-zoom">{Math.round(scale * 100)}%</span>
        <IconButton icon={ZoomIn} label="放大" onClick={() => zoom(scale + 0.15)} />
        <span className="reader-sep" />
        <IconButton icon={MousePointer2} label="選取（點重點可加註解、刪除；Esc）" active={tool === 'select'} onClick={() => setTool('select')} />
        <IconButton icon={Highlighter} label="螢光筆：選取文字就畫上重點" active={tool === 'highlight'} disabled={!!readOnly} onClick={() => setTool('highlight')} />
        <IconButton icon={SquareDashed} label="框選一塊區域（掃描版、表格、圖）" active={tool === 'area'} disabled={!!readOnly} onClick={() => setTool('area')} />
        <IconButton icon={StickyNote} label="便利貼：在頁面上點一下" active={tool === 'note'} disabled={!!readOnly} onClick={() => setTool('note')} />
        <span className="reader-colors" role="group" aria-label="螢光筆顏色">
          {(Object.keys(HIGHLIGHT_COLORS) as HighlightColor[]).map((c) => (
            <button
              key={c}
              className={`reader-swatch${color === c ? ' is-on' : ''}`}
              style={{ background: `rgb(${HIGHLIGHT_COLORS[c].map((v) => Math.round(v * 255)).join(' ')})` }}
              aria-label={`${COLOR_LABELS[c]}色`}
              aria-pressed={color === c}
              title={`${COLOR_LABELS[c]}色`}
              disabled={!!readOnly}
              onClick={() => {
                setColor(c)
                if (tool === 'select' || tool === 'note') setTool('highlight')
              }}
            />
          ))}
        </span>
        <IconButton icon={Undo2} label={`復原（${shortcut('Z')}）`} disabled={!!readOnly} onClick={undo} />
        {/* 存檔狀態放在工具列裡，出現或消失時頁面不會跳動 */}
        <span className={`reader-state${state ? ` is-${state}` : ''}`} role="status" title={saveState?.error}>
          {state ? STATE_TEXT[state] : ''}
          {saveState?.error ? `：${saveState.error}` : ''}
        </span>
        <span className="spacer" />
        <form
          className="reader-search"
          onSubmit={(e) => {
            e.preventDefault()
            if (matches && query.trim().toLowerCase() === (searchInput.current?.dataset.last ?? '')) step(1)
            else {
              if (searchInput.current) searchInput.current.dataset.last = query.trim().toLowerCase()
              void runSearch(query)
            }
          }}
        >
          <Search size={15} aria-hidden />
          <input
            ref={searchInput}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              if (!e.target.value.trim()) setMatches(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && e.shiftKey) {
                e.preventDefault()
                step(-1)
              }
              if (e.key === 'Escape') {
                setQuery('')
                setMatches(null)
              }
            }}
            placeholder={`搜尋這篇（${shortcut('F')}）`}
            aria-label="搜尋這篇"
          />
          {matches && <span className="reader-count">{matches.length ? `${matchIndex + 1}/${matches.length}` : '0'}</span>}
          {matches && matches.length > 1 && (
            <>
              <button type="button" className="note-mini" aria-label="上一個" onClick={() => step(-1)}>
                <ChevronUp size={14} aria-hidden />
              </button>
              <button type="button" className="note-mini" aria-label="下一個" onClick={() => step(1)}>
                <ChevronDown size={14} aria-hidden />
              </button>
            </>
          )}
        </form>
        <IconButton icon={ExternalLink} label="用其他程式開啟" onClick={() => void desk.papers.open(paper.id, 'file').catch((e) => setActionError(errorText(e)))} />
        {hasBackup && (
          <IconButton
            icon={History}
            label={confirm === 'restore' ? '再按一次：還原成原始 PDF（所有重點會消失）' : '還原成原始 PDF'}
            danger={confirm === 'restore'}
            active={confirm === 'restore'}
            onClick={restore}
          />
        )}
      </div>

      {readOnly && <p className="banner banner-warn">{readOnly}</p>}
      {confirm === 'restore' && <p className="banner banner-warn">再按一次「還原」會把 PDF 換回第一次畫重點前的原檔，畫過的重點和便利貼都會消失。</p>}
      {(loadError || actionError) && (
        <p className="banner banner-error" role="alert">
          {loadError ?? actionError}
          {actionError && (
            <button className="link-btn" onClick={() => setActionError(null)}>
              關閉
            </button>
          )}
        </p>
      )}

      <div
        className={`reader-scroll tool-${tool}`}
        ref={(el) => {
          scroller.current = el
          if (el !== scrollEl) setScrollEl(el)
        }}
        tabIndex={0}
        onScroll={onScroll}
        onMouseUp={onMouseUp}
        onClick={(e) => {
          if (justPlaced.current) {
            justPlaced.current = false
            return
          }
          if (selected && !(e.target as HTMLElement).closest('.rd-popover, .rd-annot')) closePopover()
        }}
      >
        {!pdf && !loadError && <p className="muted reader-loading">正在開啟 PDF…</p>}
        {pdf &&
          sizes.map((s, i) => (
            <PdfPage
              key={i}
              pdf={pdf}
              index={i}
              scale={scale}
              size={s}
              root={scrollEl}
              annots={byPage.get(i) ?? []}
              tool={tool}
              selectedKey={selected}
              hits={hitsFor(i)}
              textContent={textContent}
              onRegister={register}
              onSelect={(a) => {
                setSelected(a.key)
                setConfirm(null)
              }}
              onArea={onArea}
              onNote={onNote}
              popover={popover}
            />
          ))}
        {translation && tool === 'select' && (
          <TranslationBox translation={translation} onTranslate={translate} onClose={() => setTranslation(null)} />
        )}
      </div>
    </div>
  )
}

interface Translation {
  text: string
  left: number
  top: number
  state: 'offer' | 'loading' | 'done' | 'error'
  /** 翻譯結果或錯誤訊息 */
  result?: string
}

function TranslationBox({
  translation: t,
  onTranslate,
  onClose
}: {
  translation: Translation
  onTranslate: () => void
  onClose: () => void
}) {
  const [copied, setCopied] = useState(false)
  if (t.state === 'offer')
    return (
      <button
        className="btn rd-translate rd-translate-offer"
        style={{ left: t.left, top: t.top }}
        // 按下去時不要清掉選取
        onMouseDown={(e) => e.preventDefault()}
        onClick={onTranslate}
      >
        <Languages size={14} aria-hidden /> 翻譯
      </button>
    )
  return (
    <div className="rd-translate rd-translate-box" style={{ left: Math.max(0, t.left - 200), top: t.top }} onMouseUp={(e) => e.stopPropagation()}>
      {t.state === 'loading' && <p className="muted">翻譯中…</p>}
      {t.state === 'done' && <p className="rd-translate-text">{t.result}</p>}
      {t.state === 'error' && <p className="rd-translate-error" role="alert">{t.result}</p>}
      <div className="rd-popover-actions">
        {t.state === 'done' ? (
          <button
            className="btn"
            onClick={() => {
              navigator.clipboard.writeText(t.result ?? '')
              setCopied(true)
            }}
          >
            <Copy size={14} aria-hidden /> {copied ? '已複製' : '複製'}
          </button>
        ) : (
          <span />
        )}
        <button className="btn" onClick={onClose}>
          關閉
        </button>
      </div>
    </div>
  )
}

function AnnotPopover({
  annot,
  box,
  readOnly,
  confirming,
  onColor,
  onContents,
  onRemove,
  onClose
}: {
  annot: PdfAnnot
  box: Box
  readOnly: boolean
  confirming: boolean
  onColor: (c: HighlightColor) => void
  onContents: (text: string) => void
  onRemove: () => void
  onClose: () => void
}) {
  const text = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (annot.kind !== 'note' || !annot.mine || annot.contents) return
    const id = requestAnimationFrame(() => text.current?.focus())
    return () => cancelAnimationFrame(id)
    // 只在打開時
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [annot.key])
  const editable = annot.mine && !readOnly
  return (
    <div
      className="rd-popover"
      style={{ left: Math.max(0, box.left), top: box.top + box.height + 6 }}
      onMouseUp={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Escape') {
          if (text.current) onContents(text.current.value)
          onClose()
        }
      }}
    >
      {editable && annot.kind !== 'note' && (
        <div className="rd-popover-colors" role="group" aria-label="換顏色">
          {(Object.keys(HIGHLIGHT_COLORS) as HighlightColor[]).map((c) => (
            <button
              key={c}
              className={`reader-swatch${annot.color === c ? ' is-on' : ''}`}
              style={{ background: `rgb(${HIGHLIGHT_COLORS[c].map((v) => Math.round(v * 255)).join(' ')})` }}
              aria-label={`改成${COLOR_LABELS[c]}色`}
              onClick={() => onColor(c)}
            />
          ))}
        </div>
      )}
      {editable ? (
        <textarea
          ref={text}
          className="rd-popover-text"
          defaultValue={annot.contents}
          placeholder={annot.kind === 'note' ? '寫下便利貼內容…' : '加上註解…'}
          aria-label="註解"
          rows={3}
          onBlur={(e) => onContents(e.target.value)}
        />
      ) : (
        <p className="rd-popover-readonly">{annot.contents || (annot.mine ? '' : '其他程式畫的重點，只能刪除。')}</p>
      )}
      <div className="rd-popover-actions">
        {!readOnly && (
          <button className={`btn${confirming ? ' btn-danger' : ''}`} onClick={onRemove}>
            <Trash2 size={14} aria-hidden /> {confirming ? '再按一次刪除（無法復原）' : '刪除'}
          </button>
        )}
        <button
          className="btn"
          onClick={() => {
            if (text.current) onContents(text.current.value)
            onClose()
          }}
        >
          完成
        </button>
      </div>
    </div>
  )
}
