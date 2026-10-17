import { useReactFlow, ViewportPortal, type Rect } from '@xyflow/react'
import { X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { MarkColor, MarkPatch, MindMark, NewMark } from '../../../shared/types'
import { desk } from '../useDesk'

// 心智圖上的手繪筆跡與便利貼：固定在畫布座標上，跟著縮放平移，但不跟著節點移動。

export type Tool = 'select' | 'pen' | 'eraser' | 'note'

export const MARK_COLORS: { key: MarkColor; label: string }[] = [
  { key: 'ink', label: '黑' },
  { key: 'red', label: '紅' },
  { key: 'blue', label: '藍' },
  { key: 'green', label: '綠' }
]
export const PEN_SIZES = [
  { size: 2, label: '細' },
  { size: 5, label: '粗' }
]

type Run = (fn: () => Promise<unknown>) => Promise<void>
type Undo = () => Promise<unknown>

const parsePoints = (m: MindMark): number[] => {
  try {
    return JSON.parse(m.points) as number[]
  } catch {
    return []
  }
}

/** 平滑的筆跡路徑：相鄰兩點的中點用二次曲線連起來 */
export function strokePath(pts: number[]): string {
  if (pts.length < 2) return ''
  if (pts.length < 4) return `M${pts[0]} ${pts[1]}l0.01 0`
  let d = `M${pts[0]} ${pts[1]}`
  for (let i = 2; i < pts.length - 2; i += 2) {
    const mx = (pts[i] + pts[i + 2]) / 2
    const my = (pts[i + 1] + pts[i + 3]) / 2
    d += `Q${pts[i]} ${pts[i + 1]} ${mx} ${my}`
  }
  return d + `L${pts[pts.length - 2]} ${pts[pts.length - 1]}`
}

/** 點到筆跡最近的距離（畫布單位） */
function distanceToStroke(pts: number[], x: number, y: number): number {
  let best = Infinity
  for (let i = 0; i + 1 < pts.length; i += 2) {
    const ax = pts[i]
    const ay = pts[i + 1]
    const bx = pts[i + 2] ?? ax
    const by = pts[i + 3] ?? ay
    const dx = bx - ax
    const dy = by - ay
    const len = dx * dx + dy * dy
    const t = len ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len)) : 0
    best = Math.min(best, Math.hypot(x - (ax + t * dx), y - (ay + t * dy)))
  }
  return best
}

/** 筆跡與便利貼的資料、操作，以及復原（Ctrl+Z）紀錄 */
export function useMarks(mapId: string, run: Run) {
  const [marks, setMarks] = useState<MindMark[]>([])
  const history = useRef<Undo[]>([])

  const load = useCallback(() => desk.marks.list(mapId).then(setMarks), [mapId])
  useEffect(() => {
    load()
    return desk.onChanged(load)
  }, [load])

  const add = async (mark: NewMark, record = true): Promise<string | null> => {
    let id: string | null = null
    await run(async () => {
      id = await desk.marks.add(mapId, mark)
      setMarks((list) => [...list, { ...mark, id: id!, map_id: mapId }])
    })
    if (id && record) history.current.push(() => remove(id!, false))
    return id
  }

  const remove = async (id: string, record = true): Promise<void> => {
    const old = marks.find((m) => m.id === id)
    setMarks((list) => list.filter((m) => m.id !== id))
    await run(() => desk.marks.remove(id))
    if (old && record) {
      const { id: _id, map_id: _map, ...data } = old
      history.current.push(() => add(data, false))
    }
  }

  const update = async (id: string, patch: MarkPatch, record = true): Promise<void> => {
    const old = marks.find((m) => m.id === id)
    setMarks((list) => list.map((m) => (m.id === id ? { ...m, ...patch } : m)))
    await run(() => desk.marks.update(id, patch))
    if (old && record) {
      const before = Object.fromEntries(Object.keys(patch).map((k) => [k, old[k as keyof MindMark]])) as MarkPatch
      history.current.push(() => update(id, before, false))
    }
  }

  const undo = async (): Promise<void> => {
    const step = history.current.pop()
    if (step) await step()
  }

  return { marks, add, remove, update, undo, canUndo: () => history.current.length > 0 }
}

/** 匯出圖片時，筆跡與便利貼的範圍 */
export function marksBounds(marks: MindMark[], root: HTMLElement | null): Rect | null {
  let x1 = Infinity
  let y1 = Infinity
  let x2 = -Infinity
  let y2 = -Infinity
  for (const m of marks) {
    if (m.kind === 'stroke') {
      const pts = parsePoints(m)
      for (let i = 0; i + 1 < pts.length; i += 2) {
        x1 = Math.min(x1, pts[i] - m.size)
        y1 = Math.min(y1, pts[i + 1] - m.size)
        x2 = Math.max(x2, pts[i] + m.size)
        y2 = Math.max(y2, pts[i + 1] + m.size)
      }
    } else {
      const h = root?.querySelector<HTMLElement>(`[data-mark-id="${m.id}"]`)?.offsetHeight ?? 80
      x1 = Math.min(x1, m.x)
      y1 = Math.min(y1, m.y)
      x2 = Math.max(x2, m.x + m.w)
      y2 = Math.max(y2, m.y + h)
    }
  }
  return x1 === Infinity ? null : { x: x1, y: y1, width: x2 - x1, height: y2 - y1 }
}

/**
 * 畫筆、橡皮擦、便利貼的指標處理。回傳的 handlers 掛在畫布外層（capture 階段），
 * 使用畫筆時攔下滑鼠事件，React Flow 就不會平移畫面或拖動節點。
 */
export function useDrawing({
  tool,
  color,
  size,
  marks,
  onStroke,
  onErase,
  onNote
}: {
  tool: Tool
  color: MarkColor
  size: number
  marks: MindMark[]
  onStroke: (points: number[]) => void
  onErase: (id: string) => void
  onNote: (x: number, y: number) => void
}) {
  const flow = useReactFlow()
  const [live, setLive] = useState<number[] | null>(null)
  const drawing = useRef<number[] | null>(null)
  const erasing = useRef(false)
  const erased = useRef(new Set<string>())
  const lastErase = useRef<{ x: number; y: number } | null>(null)
  // 畫完、擦完或放完便利貼後的那次 click 不要傳給 React Flow（不然會取消選取、搶走便利貼的焦點）
  const swallowClick = useRef(false)

  // 便利貼、縮放按鈕照常操作
  const passThrough = (e: React.PointerEvent | React.MouseEvent): boolean =>
    tool === 'select' || e.button !== 0 || !!(e.target as HTMLElement).closest('.mm-note, .react-flow__controls')

  /** 擦過的路徑（上一個位置到這個位置）碰到的筆跡整條刪掉 */
  const eraseAt = (x: number, y: number): void => {
    const reach = 8 / flow.getZoom()
    const from = lastErase.current ?? { x, y }
    lastErase.current = { x, y }
    const steps = Math.max(1, Math.ceil(Math.hypot(x - from.x, y - from.y) / reach))
    for (const m of marks) {
      if (m.kind !== 'stroke' || erased.current.has(m.id)) continue
      const pts = parsePoints(m)
      for (let i = 0; i <= steps; i++) {
        const px = from.x + ((x - from.x) * i) / steps
        const py = from.y + ((y - from.y) * i) / steps
        if (distanceToStroke(pts, px, py) <= m.size / 2 + reach) {
          erased.current.add(m.id)
          onErase(m.id)
          break
        }
      }
    }
  }

  const handlers = {
    onMouseDownCapture: (e: React.MouseEvent) => {
      if (!passThrough(e)) e.stopPropagation()
    },
    onClickCapture: (e: React.MouseEvent) => {
      if (!swallowClick.current) return
      swallowClick.current = false
      e.stopPropagation()
    },
    onPointerDownCapture: (e: React.PointerEvent<HTMLDivElement>) => {
      swallowClick.current = false
      if (passThrough(e)) return
      swallowClick.current = true
      e.stopPropagation()
      e.preventDefault()
      const p = flow.screenToFlowPosition({ x: e.clientX, y: e.clientY })
      if (tool === 'note') return onNote(p.x, p.y)
      e.currentTarget.setPointerCapture(e.pointerId)
      if (tool === 'pen') {
        drawing.current = [p.x, p.y]
        setLive(drawing.current)
      } else {
        erasing.current = true
        erased.current = new Set()
        lastErase.current = null
        eraseAt(p.x, p.y)
      }
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (!drawing.current && !erasing.current) return
      const p = flow.screenToFlowPosition({ x: e.clientX, y: e.clientY })
      if (erasing.current) return eraseAt(p.x, p.y)
      const pts = drawing.current!
      const min = 1.5 / flow.getZoom()
      if (Math.hypot(p.x - pts[pts.length - 2], p.y - pts[pts.length - 1]) < min) return
      drawing.current = [...pts, Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10]
      setLive(drawing.current)
    },
    onPointerUp: () => {
      const pts = drawing.current
      drawing.current = null
      erasing.current = false
      setLive(null)
      if (pts) onStroke(pts.length >= 4 ? pts : [...pts, pts[0] + 0.01, pts[1]])
    }
  }

  return { handlers, live, liveStyle: { color, size } }
}

/** 畫在 React Flow 的畫布座標裡（跟著縮放平移） */
export function MarkLayer({
  marks,
  live,
  liveStyle,
  focusNote,
  onNoteText,
  onNoteMove,
  onNoteResize,
  onNoteRemove
}: {
  marks: MindMark[]
  live: number[] | null
  liveStyle: { color: MarkColor; size: number }
  focusNote: string | null
  onNoteText: (m: MindMark, text: string) => void
  onNoteMove: (m: MindMark, x: number, y: number) => void
  onNoteResize: (m: MindMark, w: number) => void
  onNoteRemove: (m: MindMark) => void
}) {
  const strokes = marks.filter((m) => m.kind === 'stroke')
  return (
    <ViewportPortal>
      <svg className="mm-strokes" aria-hidden>
        {strokes.map((m) => (
          <path key={m.id} d={strokePath(parsePoints(m))} className={`mm-stroke is-${m.color}`} strokeWidth={m.size} />
        ))}
        {live && <path d={strokePath(live)} className={`mm-stroke is-${liveStyle.color}`} strokeWidth={liveStyle.size} />}
      </svg>
      {marks
        .filter((m) => m.kind === 'note')
        .map((m) => (
          <NoteView
            key={m.id}
            mark={m}
            autoFocus={m.id === focusNote}
            onText={(t) => onNoteText(m, t)}
            onMove={(x, y) => onNoteMove(m, x, y)}
            onResize={(w) => onNoteResize(m, w)}
            onRemove={() => onNoteRemove(m)}
          />
        ))}
    </ViewportPortal>
  )
}

/** 便利貼：上方橫條拖曳搬動，右下角拖曳調整寬度 */
function NoteView({
  mark,
  autoFocus,
  onText,
  onMove,
  onResize,
  onRemove
}: {
  mark: MindMark
  autoFocus: boolean
  onText: (text: string) => void
  onMove: (x: number, y: number) => void
  onResize: (w: number) => void
  onRemove: () => void
}) {
  const flow = useReactFlow()
  const [pos, setPos] = useState({ x: mark.x, y: mark.y, w: mark.w })
  const drag = useRef<{ kind: 'move' | 'size'; sx: number; sy: number; x: number; y: number; w: number; zoom: number } | null>(null)
  const text = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (!drag.current) setPos({ x: mark.x, y: mark.y, w: mark.w })
  }, [mark.x, mark.y, mark.w])
  useEffect(() => {
    if (text.current && document.activeElement !== text.current) text.current.value = mark.text
  }, [mark.text])
  useEffect(() => {
    if (autoFocus) text.current?.focus()
  }, [autoFocus])

  const start = (kind: 'move' | 'size') => (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return
    e.stopPropagation()
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { kind, sx: e.clientX, sy: e.clientY, ...pos, zoom: flow.getZoom() }
  }
  const move = (e: React.PointerEvent): void => {
    const d = drag.current
    if (!d) return
    const dx = (e.clientX - d.sx) / d.zoom
    const dy = (e.clientY - d.sy) / d.zoom
    setPos(d.kind === 'move' ? { x: d.x + dx, y: d.y + dy, w: d.w } : { x: d.x, y: d.y, w: Math.max(100, d.w + dx) })
  }
  const end = (): void => {
    const d = drag.current
    drag.current = null
    if (!d) return
    if (d.kind === 'move' && (pos.x !== d.x || pos.y !== d.y)) onMove(Math.round(pos.x), Math.round(pos.y))
    if (d.kind === 'size' && pos.w !== d.w) onResize(Math.round(pos.w))
  }

  return (
    <div className="mm-note nodrag nopan nowheel" data-mark-id={mark.id} style={{ left: pos.x, top: pos.y, width: pos.w }}>
      <div className="mm-note-bar" onPointerDown={start('move')} onPointerMove={move} onPointerUp={end} title="拖曳搬動">
        <button className="mm-note-remove" aria-label="刪除便利貼" title="刪除便利貼" onClick={onRemove}>
          <X size={12} aria-hidden />
        </button>
      </div>
      <textarea
        ref={text}
        className="mm-note-text"
        defaultValue={mark.text}
        placeholder="輸入筆記…"
        aria-label="便利貼內容"
        spellCheck={false}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Escape') e.currentTarget.blur()
        }}
        // 沒寫字的便利貼離開就刪掉
        onBlur={(e) => (!e.target.value.trim() || e.target.value !== mark.text) && onText(e.target.value)}
      />
      <span className="mm-note-size" onPointerDown={start('size')} onPointerMove={move} onPointerUp={end} title="拖曳調整寬度" />
    </div>
  )
}
