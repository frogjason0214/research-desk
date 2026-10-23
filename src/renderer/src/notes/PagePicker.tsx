import { FilePlus, FileText } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { NotePage } from '../../../shared/types'
import { errorText } from '../importing'
import { desk } from '../useDesk'

// 「加到筆記」的選頁小選單：搜尋、預選上次加過的頁、可以新增頁面

const lastKey = (projectId: string): string => `notes.addTo.${projectId}`

export function lastAddedPage(projectId: string): string | null {
  try {
    return localStorage.getItem(lastKey(projectId))
  } catch {
    return null
  }
}

function rememberPage(projectId: string, pageId: string): void {
  try {
    localStorage.setItem(lastKey(projectId), pageId)
  } catch {
    /* 無法儲存就算了 */
  }
}

/** 還在頁面樹上的頁（自己或上層都不在垃圾桶），附上路徑 */
function livePages(pages: NotePage[]): { page: NotePage; path: string }[] {
  const byId = new Map(pages.map((p) => [p.id, p]))
  const out: { page: NotePage; path: string }[] = []
  for (const p of pages) {
    const chain: NotePage[] = []
    let ok = true
    for (let cur: NotePage | undefined = p, n = 0; cur && n < 50; cur = cur.parent_id ? byId.get(cur.parent_id) : undefined, n++) {
      if (cur.trashed_at) ok = false
      chain.unshift(cur)
    }
    if (ok) out.push({ page: p, path: chain.map((c) => c.title || '未命名').join(' / ') })
  }
  return out.sort((a, b) => a.path.localeCompare(b.path, 'zh-TW'))
}

export function PagePicker({
  projectId,
  newTitle,
  onPick,
  onClose
}: {
  projectId: string
  /** 搜尋框空白時，「新增頁面」用的標題 */
  newTitle: string
  onPick: (page: { id: string; title: string }) => void
  onClose: () => void
}) {
  const [pages, setPages] = useState<NotePage[] | null>(null)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void desk.notes.pages(projectId).then(setPages)
  }, [projectId])

  const all = useMemo(() => livePages(pages ?? []), [pages])
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = q ? all.filter((x) => x.path.toLowerCase().includes(q)) : all
    // 上次加過的頁排最前面
    const last = lastAddedPage(projectId)
    const i = list.findIndex((x) => x.page.id === last)
    return i > 0 ? [list[i], ...list.slice(0, i), ...list.slice(i + 1)] : list
  }, [all, query, projectId])
  useEffect(() => setActive(0), [query])

  // 點選單外面就關閉
  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (box.current && !box.current.contains(e.target as Node)) onClose()
    }
    window.addEventListener('mousedown', onDown, true)
    return () => window.removeEventListener('mousedown', onDown, true)
  }, [onClose])

  const pick = (page: NotePage): void => {
    rememberPage(projectId, page.id)
    onPick({ id: page.id, title: page.title || '未命名' })
  }
  const create = async (): Promise<void> => {
    try {
      const title = query.trim() || newTitle
      const page = await desk.notes.create(projectId, null)
      await desk.notes.rename(page.id, title)
      rememberPage(projectId, page.id)
      onPick({ id: page.id, title })
    } catch (err) {
      setError(errorText(err))
    }
  }

  return (
    <div className="page-picker" ref={box} role="dialog" aria-label="加到哪一頁筆記">
      <input
        autoFocus
        className="page-picker-search"
        placeholder="搜尋筆記頁面，或輸入新頁面的標題"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) return
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setActive((i) => Math.min(i + 1, shown.length))
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setActive((i) => Math.max(i - 1, 0))
          } else if (e.key === 'Enter') {
            e.preventDefault()
            if (active < shown.length) pick(shown[active].page)
            else void create()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onClose()
          }
          e.stopPropagation()
        }}
      />
      <ul className="page-picker-list" role="listbox">
        {pages === null && <li className="muted">讀取中…</li>}
        {shown.map((x, i) => (
          <li
            key={x.page.id}
            role="option"
            aria-selected={i === active}
            className={i === active ? 'is-active' : ''}
            onMouseEnter={() => setActive(i)}
            onClick={() => pick(x.page)}
          >
            <FileText size={14} aria-hidden />
            <span className="page-picker-path">{x.path}</span>
            {x.page.id === lastAddedPage(projectId) && <span className="badge">上次</span>}
          </li>
        ))}
        <li
          role="option"
          aria-selected={active === shown.length}
          className={`page-picker-new${active === shown.length ? ' is-active' : ''}`}
          onMouseEnter={() => setActive(shown.length)}
          onClick={() => void create()}
        >
          <FilePlus size={14} aria-hidden />
          <span>新增頁面「{query.trim() || newTitle}」</span>
        </li>
      </ul>
      {error && <p className="page-picker-error">{error}</p>}
    </div>
  )
}
