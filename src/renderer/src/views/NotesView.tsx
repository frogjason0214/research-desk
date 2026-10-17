import { ChevronDown, ChevronRight, FileDown, FilePlus, FileText, FileUp, Plus, RotateCcw, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Focus, NotePage } from '../../../shared/types'
import { IconButton } from '../components/IconButton'
import { markdownToPage } from '../notes/markdown'
import { NoteEditor } from '../notes/NoteEditor'
import { desk } from '../useDesk'

type Run = (fn: () => Promise<unknown>) => Promise<void>
type Drop = { id: string; zone: 'before' | 'after' | 'inside' }

const PAGE_DRAG = 'application/x-research-note'
const TRASH_DAYS = 30
const titleOf = (p: NotePage): string => p.title || '未命名'

// 每台電腦自己記得：上次開的頁面、展開的頁面
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

/** 筆記：左邊頁面樹，右邊頁面內容 */
export function NotesView({ projectId, run, onNavigate }: { projectId: string; run: Run; onNavigate: (f: Focus) => void }) {
  const [pages, setPages] = useState<NotePage[]>([])
  const [currentId, setCurrentId] = useState<string | null>(() => remember.get(`notes.page.${projectId}`))
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(JSON.parse(remember.get(`notes.open.${projectId}`) ?? '[]') as string[]))
  const [fresh, setFresh] = useState<string | null>(null)
  const [showTrash, setShowTrash] = useState(false)
  const [drop, setDrop] = useState<Drop | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => desk.notes.pages(projectId).then(setPages), [projectId])
  useEffect(() => {
    load()
    return desk.onChanged(load)
  }, [load])

  // 樹上看得到的頁面：自己或上層在垃圾桶的都不算；上層不見了的放到最上層
  const { live, trashed, children } = useMemo(() => {
    const byId = new Map(pages.map((p) => [p.id, p]))
    const inTrash = (p: NotePage): boolean => {
      for (let cur: NotePage | undefined = p, n = 0; cur && n < 100; cur = cur.parent_id ? byId.get(cur.parent_id) : undefined, n++)
        if (cur.trashed_at) return true
      return false
    }
    const live = pages.filter((p) => !inTrash(p))
    const liveIds = new Set(live.map((p) => p.id))
    const children = new Map<string | null, NotePage[]>()
    for (const p of live) {
      const parent = p.parent_id && liveIds.has(p.parent_id) ? p.parent_id : null
      children.set(parent, [...(children.get(parent) ?? []), p])
    }
    for (const list of children.values()) list.sort((a, b) => a.sort - b.sort || a.created_at.localeCompare(b.created_at))
    const trashed = pages.filter((p) => p.trashed_at).sort((a, b) => (b.trashed_at ?? '').localeCompare(a.trashed_at ?? ''))
    return { live, trashed, children }
  }, [pages])

  const current = live.find((p) => p.id === currentId) ?? null
  // 打開的頁面被刪掉（或第一次進來）時，改開第一頁
  useEffect(() => {
    if (!current && live.length && pages.length) setCurrentId((children.get(null) ?? live)[0].id)
  }, [current, live, children, pages.length])
  useEffect(() => {
    if (currentId) remember.set(`notes.page.${projectId}`, currentId)
  }, [currentId, projectId])

  const toggle = (id: string, open?: boolean): void =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (open ?? !next.has(id)) next.add(id)
      else next.delete(id)
      remember.set(`notes.open.${projectId}`, JSON.stringify([...next]))
      return next
    })

  const create = (parentId: string | null): void => {
    run(async () => {
      const page = await desk.notes.create(projectId, parentId)
      if (parentId) toggle(parentId, true)
      await load()
      setCurrentId(page.id)
      setFresh(page.id)
    })
  }

  /** 匯入 .md：每個檔案變成最上層的一頁，打開第一個 */
  const importMd = (): void => {
    run(async () => {
      const files = await desk.notes.pickMd()
      let first: string | null = null
      for (const f of files) {
        const { title, blocks } = markdownToPage(f.markdown, f.name)
        const id = await desk.notes.importPage(projectId, null, title, blocks)
        first ??= id
      }
      if (!first) return
      await load()
      setCurrentId(first)
    })
  }

  /** 拖曳放下：前面、後面、或變成子頁 */
  const move = (id: string, target: Drop): void => {
    const t = pages.find((p) => p.id === target.id)
    if (!t || id === t.id) return
    // 不能放進自己的子頁
    for (let cur: NotePage | undefined = t; cur; cur = pages.find((p) => p.id === cur!.parent_id)) if (cur.id === id) return
    let parentId: string | null
    let sort: number
    if (target.zone === 'inside') {
      parentId = t.id
      const kids = children.get(t.id) ?? []
      sort = kids.length ? kids[kids.length - 1].sort + 1 : 0
      toggle(t.id, true)
    } else {
      parentId = t.parent_id && live.some((p) => p.id === t.parent_id) ? t.parent_id : null
      const sibs = (children.get(parentId) ?? []).filter((p) => p.id !== id)
      const i = sibs.findIndex((p) => p.id === t.id)
      const near = target.zone === 'before' ? sibs[i - 1] : sibs[i + 1]
      sort = near ? (t.sort + near.sort) / 2 : t.sort + (target.zone === 'before' ? -1 : 1)
    }
    run(() => desk.notes.move(id, parentId, sort))
  }

  const renderItem = (p: NotePage, depth: number) => {
    const kids = children.get(p.id) ?? []
    const open = expanded.has(p.id)
    const dropZone = drop?.id === p.id ? drop.zone : null
    return (
      <li key={p.id}>
        <div
          className={`note-item${p.id === currentId ? ' is-active' : ''}${dropZone ? ` is-drop-${dropZone}` : ''}`}
          style={{ paddingLeft: 6 + depth * 14 }}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData(PAGE_DRAG, p.id)
            e.dataTransfer.effectAllowed = 'move'
          }}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes(PAGE_DRAG)) return
            e.preventDefault()
            const box = e.currentTarget.getBoundingClientRect()
            const y = (e.clientY - box.top) / box.height
            const zone = y < 0.28 ? 'before' : y > 0.72 ? 'after' : 'inside'
            if (drop?.id !== p.id || drop.zone !== zone) setDrop({ id: p.id, zone })
          }}
          onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setDrop(null)}
          onDrop={(e) => {
            e.preventDefault()
            const id = e.dataTransfer.getData(PAGE_DRAG)
            if (id && drop) move(id, drop)
            setDrop(null)
          }}
          onDragEnd={() => setDrop(null)}
        >
          <button
            className="note-twisty"
            aria-label={open ? '收合子頁' : '展開子頁'}
            style={{ visibility: kids.length ? 'visible' : 'hidden' }}
            onClick={() => toggle(p.id)}
          >
            {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
          </button>
          <button className="note-item-title" onClick={() => setCurrentId(p.id)}>
            <FileText size={14} strokeWidth={1.8} aria-hidden />
            <span>{titleOf(p)}</span>
          </button>
          <span className="note-item-actions">
            <button className="note-mini" title="新增子頁" aria-label={`在「${titleOf(p)}」底下新增子頁`} onClick={() => create(p.id)}>
              <Plus size={14} aria-hidden />
            </button>
            <button
              className="note-mini"
              title="丟到垃圾桶"
              aria-label={`把「${titleOf(p)}」丟到垃圾桶`}
              onClick={() => run(() => desk.notes.trash(p.id))}
            >
              <Trash2 size={14} aria-hidden />
            </button>
          </span>
        </div>
        {open && kids.length > 0 && <ul className="note-tree">{kids.map((k) => renderItem(k, depth + 1))}</ul>}
      </li>
    )
  }

  const roots = children.get(null) ?? []

  return (
    <div className="notes">
      <aside className="notes-side" aria-label="筆記頁面">
        <div className="notes-side-head">
          <span>頁面</span>
          <span className="notes-side-tools">
            <IconButton icon={FileUp} label="匯入 .md（可以多選）" onClick={importMd} />
            <IconButton icon={FilePlus} label="新增頁面" onClick={() => create(null)} />
          </span>
        </div>
        {roots.length === 0 ? (
          <p className="muted notes-empty">還沒有筆記。按上面的圖示新增第一頁。</p>
        ) : (
          <ul className="note-tree">{roots.map((p) => renderItem(p, 0))}</ul>
        )}
        <div className="notes-trash">
          <button className="link-btn" onClick={() => setShowTrash(!showTrash)}>
            <Trash2 size={14} aria-hidden /> 垃圾桶（{trashed.length}）
          </button>
          {showTrash && <Trash pages={trashed} run={run} />}
        </div>
      </aside>

      <section className="notes-main">
        {error && (
          <p className="banner banner-error" role="alert">
            {error}
            <button className="link-btn" onClick={() => setError(null)}>
              關閉
            </button>
          </p>
        )}
        {current ? (
          <div className="note-page" key={current.id}>
            <div className="note-page-head">
              <Breadcrumb page={current} pages={live} onOpen={setCurrentId} />
              <span className="spacer" />
              <IconButton
                icon={FileDown}
                label="匯出這一頁成 .md"
                onClick={() =>
                  // 讓編輯器先把還沒存的內容存進去（失去焦點時存檔）
                  run(async () => {
                    ;(document.activeElement as HTMLElement | null)?.blur()
                    await new Promise((r) => window.setTimeout(r, 150))
                    await desk.notes.exportMd(current.id, current.title)
                  })
                }
              />
            </div>
            <PageTitle page={current} run={run} autoFocus={fresh === current.id} />
            <NoteEditor
              pageId={current.id}
              projectId={projectId}
              onNavigate={onNavigate}
              onError={setError}
              autoFocus={false}
            />
          </div>
        ) : (
          <div className="empty-card">
            <h3>筆記</h3>
            <p className="muted">
              像 Notion 一樣的筆記：頁面可以有子頁，打 / 插入標題、清單、表格、圖片，打 @ 引用文獻。每一頁也會在「筆記」資料夾存一份 Markdown。
            </p>
            <button className="btn btn-primary" onClick={() => create(null)}>
              新增第一頁
            </button>{' '}
            <button className="btn" onClick={importMd}>
              匯入 .md
            </button>
          </div>
        )}
      </section>
    </div>
  )
}

function Breadcrumb({ page, pages, onOpen }: { page: NotePage; pages: NotePage[]; onOpen: (id: string) => void }) {
  const chain: NotePage[] = []
  for (let cur = pages.find((p) => p.id === page.parent_id); cur && chain.length < 20; cur = pages.find((p) => p.id === cur!.parent_id))
    chain.unshift(cur)
  if (!chain.length) return null
  return (
    <nav className="note-crumbs" aria-label="上層頁面">
      {chain.map((p) => (
        <span key={p.id}>
          <button className="link-btn" onClick={() => onOpen(p.id)}>
            {titleOf(p)}
          </button>
          <span aria-hidden> / </span>
        </span>
      ))}
    </nav>
  )
}

function PageTitle({ page, run, autoFocus }: { page: NotePage; run: Run; autoFocus: boolean }) {
  const input = useRef<HTMLInputElement>(null)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (input.current && document.activeElement !== input.current) input.current.value = page.title
  }, [page.title])
  useEffect(() => {
    if (autoFocus) input.current?.focus()
  }, [autoFocus])
  const save = (): void => {
    window.clearTimeout(timer.current)
    const title = input.current?.value.trim() ?? ''
    if (title !== page.title) run(() => desk.notes.rename(page.id, title))
  }
  useEffect(() => () => window.clearTimeout(timer.current), [])
  return (
    <input
      ref={input}
      className="note-title"
      defaultValue={page.title}
      placeholder="未命名"
      aria-label="頁面標題"
      onChange={() => {
        window.clearTimeout(timer.current)
        timer.current = window.setTimeout(save, 800)
      }}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing || e.keyCode === 229) return
        if (e.key === 'Enter') {
          e.preventDefault()
          save()
          ;(e.currentTarget.closest('.note-page')?.querySelector('.note-prose') as HTMLElement | null)?.focus()
        }
      }}
    />
  )
}

function Trash({ pages, run }: { pages: NotePage[]; run: Run }) {
  const [confirm, setConfirm] = useState<string | null>(null)
  if (!pages.length) return <p className="muted notes-empty">垃圾桶是空的。</p>
  return (
    <ul className="note-trash-list">
      {pages.map((p) => {
        const left = Math.max(0, TRASH_DAYS - Math.floor((Date.now() - Date.parse(p.trashed_at!)) / 86400_000))
        return (
          <li key={p.id}>
            <span className="note-trash-title">{titleOf(p)}</span>
            <span className="muted">{left} 天後刪除</span>
            <button className="note-mini" title="還原" aria-label={`還原「${titleOf(p)}」`} onClick={() => run(() => desk.notes.restore(p.id))}>
              <RotateCcw size={14} aria-hidden />
            </button>
            <button
              className={`note-mini${confirm === p.id ? ' is-danger' : ''}`}
              title={confirm === p.id ? '再按一次永久刪除' : '永久刪除'}
              aria-label={confirm === p.id ? `再按一次永久刪除「${titleOf(p)}」` : `永久刪除「${titleOf(p)}」`}
              onClick={() => (confirm === p.id ? run(() => desk.notes.purge(p.id)) : setConfirm(p.id))}
            >
              <Trash2 size={14} aria-hidden />
            </button>
          </li>
        )
      })}
    </ul>
  )
}
