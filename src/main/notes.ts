import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { NoteBlock, NoteBlockChanges, NotePage } from '../shared/types'
import type { Library } from './library'
import { safeName } from './papers/organizer'
import type { Store } from './store'

// 筆記（簡易版 Notion）：每個專案一棵頁面樹，頁面內容以區塊為單位存進變更紀錄。
// 另外在「筆記」資料夾產生同樣階層的 Markdown 副本，方便在程式外閱讀（在外面修改不會回寫）。

export const ATTACHMENTS = '附件'
const TRASH_DAYS = 30
const MIRROR_DEBOUNCE_MS = 3000
/** 程式產生的 Markdown 第一行；只有帶這行的 .md 會被程式更新或刪除 */
export const MD_MARKER = '<!-- Research Desk 自動產生的副本；請在程式裡修改，這裡的修改不會回寫 -->'
const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml'
}
/** 編輯器裡的圖片位址：desk-note:附件/xxx.png */
export const IMAGE_SCHEME = 'desk-note'

const now = (): string => new Date().toISOString()

export function imageType(file: string): string | null {
  return IMAGE_TYPES[path.extname(file).toLowerCase()] ?? null
}

export function createNotesHandlers(store: Store, library: Library) {
  const pageOf = (id: string): NotePage | undefined => store.get<NotePage>('SELECT * FROM note_pages WHERE id = ?', [id])
  const pagesOf = (projectId: string): NotePage[] =>
    store.all<NotePage>('SELECT * FROM note_pages WHERE project_id = ? ORDER BY sort, created_at', [projectId])

  /** 頁面與它所有子頁 */
  const subtree = (page: NotePage): string[] => {
    const all = pagesOf(page.project_id)
    const ids = [page.id]
    for (let i = 0; i < ids.length; i++) all.filter((p) => p.parent_id === ids[i]).forEach((p) => ids.push(p.id))
    return ids
  }

  const purge = (id: string): void => {
    const page = pageOf(id)
    if (!page) return
    const ids = subtree(page)
    const marks = ids.map(() => '?').join(',')
    const blocks = store.all<{ id: string }>(`SELECT id FROM note_blocks WHERE page_id IN (${marks})`, ids)
    store.write((tx) => {
      blocks.forEach((b) => tx.remove('note_blocks', b.id))
      ids.forEach((p) => tx.remove('note_pages', p))
    })
  }

  return {
    'notes.pages': pagesOf,

    'notes.create': (projectId: string, parentId: string | null): NotePage => {
      const siblings = pagesOf(projectId).filter((p) => p.parent_id === parentId)
      const time = now()
      const page: NotePage = {
        id: randomUUID(),
        project_id: projectId,
        parent_id: parentId,
        title: '',
        sort: siblings.length ? Math.max(...siblings.map((p) => p.sort)) + 1 : 0,
        created_at: time,
        updated_at: time,
        trashed_at: null
      }
      const { id, ...fields } = page
      store.write((tx) => tx.set('note_pages', id, fields))
      return page
    },

    'notes.rename': (id: string, title: string): void =>
      store.write((tx) => tx.set('note_pages', id, { title: title.trim(), updated_at: now() })),

    /** 拖曳搬到別的位置；不能搬進自己的子頁 */
    'notes.move': (id: string, parentId: string | null, sort: number): void => {
      const page = pageOf(id)
      if (!page) return
      if (parentId && subtree(page).includes(parentId)) throw new Error('不能把頁面搬進它自己的子頁裡')
      store.write((tx) => tx.set('note_pages', id, { parent_id: parentId, sort }))
    },

    /** 丟進垃圾桶：子頁跟著一起（從樹上消失），30 天內可以還原 */
    'notes.trash': (id: string): void => store.write((tx) => tx.set('note_pages', id, { trashed_at: now() })),

    /** 還原；原本的上層已經不在或也在垃圾桶時，放回最上層 */
    'notes.restore': (id: string): void => {
      const page = pageOf(id)
      if (!page) return
      const parent = page.parent_id ? pageOf(page.parent_id) : undefined
      const fields: Record<string, unknown> = { trashed_at: null }
      if (page.parent_id && (!parent || parent.trashed_at)) fields.parent_id = null
      store.write((tx) => tx.set('note_pages', id, fields))
    },

    'notes.purge': purge,

    'notes.blocks': (pageId: string): NoteBlock[] =>
      store.all<NoteBlock>('SELECT id, sort, content FROM note_blocks WHERE page_id = ? ORDER BY sort', [pageId]),

    /** 只寫有變動的區塊（內容或順序），其他電腦同時改別的區塊不會被蓋掉 */
    'notes.saveBlocks': (pageId: string, changes: NoteBlockChanges): void => {
      if (!changes.upserts.length && !changes.removes.length) return
      store.write((tx) => {
        for (const b of changes.upserts) {
          const fields: Record<string, unknown> = { page_id: pageId, sort: b.sort }
          if (b.content !== undefined) fields.content = b.content
          tx.set('note_blocks', b.id, fields)
        }
        changes.removes.forEach((id) => tx.remove('note_blocks', id))
        tx.set('note_pages', pageId, { updated_at: now() })
      })
    },

    'notes.saveImage': (name: string, data: ArrayBuffer): string => {
      const ext = imageType(name) ? path.extname(name).toLowerCase() : '.png'
      const rel = `${ATTACHMENTS}/${randomUUID()}${ext}`
      library.writeNote(rel, new Uint8Array(data))
      return `${IMAGE_SCHEME}:${rel}`
    },

    /** 啟動時清掉放進垃圾桶超過 30 天的頁面 */
    purgeOldTrash: (): void => {
      const limit = new Date(Date.now() - TRASH_DAYS * 86400_000).toISOString()
      store
        .all<{ id: string }>('SELECT id FROM note_pages WHERE trashed_at IS NOT NULL AND trashed_at < ?', [limit])
        .forEach((p) => purge(p.id))
    }
  }
}

// ---------- Markdown ----------

interface PmNode {
  type: string
  attrs?: Record<string, unknown>
  content?: PmNode[]
  text?: string
  marks?: { type: string; attrs?: Record<string, unknown> }[]
}

function inline(nodes: PmNode[] | undefined, image: (src: string) => string): string {
  return (nodes ?? [])
    .map((n) => {
      if (n.type === 'hardBreak') return '  \n'
      if (n.type === 'mention') return String(n.attrs?.label ?? '')
      if (n.type === 'image') return `![${n.attrs?.alt ?? ''}](${image(String(n.attrs?.src ?? ''))})`
      let t = n.text ?? ''
      for (const m of n.marks ?? []) {
        if (m.type === 'bold') t = `**${t}**`
        else if (m.type === 'italic') t = `*${t}*`
        else if (m.type === 'strike') t = `~~${t}~~`
        else if (m.type === 'code') t = `\`${t}\``
      }
      return t
    })
    .join('')
}

/** 編輯器的區塊 JSON 轉成 Markdown（只處理筆記用得到的格式） */
export function blockToMarkdown(node: PmNode, image: (src: string) => string, indent = ''): string {
  const children = node.content ?? []
  switch (node.type) {
    case 'paragraph':
      return indent + inline(children, image)
    case 'heading':
      // 頁面標題是 #，頁面裡的標題往下一層
      return `${'#'.repeat(Math.min(6, Number(node.attrs?.level ?? 1) + 1))} ${inline(children, image)}`
    case 'blockquote':
      return children.map((c) => blockToMarkdown(c, image).replace(/^/gm, '> ')).join('\n>\n')
    case 'codeBlock':
      return '```' + String(node.attrs?.language ?? '') + '\n' + children.map((c) => c.text ?? '').join('') + '\n```'
    case 'horizontalRule':
      return '---'
    case 'image':
      return `![${node.attrs?.alt ?? ''}](${image(String(node.attrs?.src ?? ''))})`
    case 'bulletList':
    case 'orderedList':
      return children
        .map((item, i) => {
          const bullet = node.type === 'bulletList' ? '- ' : `${Number(node.attrs?.start ?? 1) + i}. `
          const [first, ...rest] = item.content ?? []
          const lines = [indent + bullet + (first ? blockToMarkdown(first, image).trimStart() : '')]
          for (const r of rest) lines.push(blockToMarkdown(r, image, indent + '  '))
          return lines.join('\n')
        })
        .join('\n')
    case 'table': {
      const rows = children.map((row) =>
        (row.content ?? []).map((cell) =>
          (cell.content ?? []).map((p) => inline(p.content, image)).join(' ').replace(/\|/g, '\\|')
        )
      )
      if (!rows.length) return ''
      const width = Math.max(...rows.map((r) => r.length))
      const line = (r: string[]): string => `| ${Array.from({ length: width }, (_, i) => r[i] ?? '').join(' | ')} |`
      return [line(rows[0]), `|${' --- |'.repeat(width)}`, ...rows.slice(1).map(line)].join('\n')
    }
    default:
      return inline(children, image)
  }
}

export function pageToMarkdown(title: string, blocks: NoteBlock[], image: (src: string) => string): string {
  const body = blocks
    .map((b) => {
      try {
        return blockToMarkdown(JSON.parse(b.content) as PmNode, image)
      } catch {
        return ''
      }
    })
    .join('\n\n')
  return `${MD_MARKER}\n\n# ${title || '未命名'}\n\n${body}\n`
}

/**
 * 「筆記」資料夾裡的 Markdown 副本：專案\頁面.md，子頁放在「專案\上層頁面\」裡。
 * 只在內容不同時才寫檔，兩台電腦算出來的結果一樣，不會一直互相同步。
 */
export class NotesMirror {
  private timer: NodeJS.Timeout | null = null

  constructor(
    private store: Store,
    private library: Library
  ) {}

  schedule(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.run(), MIRROR_DEBOUNCE_MS)
  }

  run(): void {
    this.timer = null
    if (this.library.cloudDir && !this.library.available) return
    try {
      const root = this.library.notesDir
      const keep = new Set<string>()
      const projects = this.store.all<{ id: string; name: string }>('SELECT id, name FROM projects')
      const used = new Set<string>()
      for (const project of projects) {
        let dir = safeName(project.name)
        for (let i = 2; used.has(dir.toLowerCase()); i++) dir = `${safeName(project.name)} (${i})`
        used.add(dir.toLowerCase())
        const pages = this.store
          .all<NotePage>('SELECT * FROM note_pages WHERE project_id = ? AND trashed_at IS NULL ORDER BY sort, created_at', [project.id])
        this.writeLevel(root, dir, pages, null, keep)
      }
      this.prune(root, root, keep)
    } catch (err) {
      console.warn('[notes mirror]', err)
    }
  }

  private writeLevel(root: string, dir: string, pages: NotePage[], parentId: string | null, keep: Set<string>): void {
    const names = new Set<string>()
    for (const page of pages.filter((p) => p.parent_id === parentId)) {
      const base = safeName(page.title || '未命名')
      let name = base
      for (let i = 2; names.has(name.toLowerCase()); i++) name = `${base} (${i})`
      names.add(name.toLowerCase())
      const rel = path.join(dir, `${name}.md`)
      const file = path.join(root, rel)
      // 圖片連結：從這個 .md 的位置指到「筆記\附件」
      const toAttachments = path.relative(path.dirname(file), path.join(root, ATTACHMENTS)).split(path.sep).join('/')
      const image = (src: string): string =>
        src.startsWith(`${IMAGE_SCHEME}:${ATTACHMENTS}/`) ? `${toAttachments}/${src.slice(IMAGE_SCHEME.length + ATTACHMENTS.length + 2)}` : src
      const blocks = this.store.all<NoteBlock>('SELECT id, sort, content FROM note_blocks WHERE page_id = ? ORDER BY sort', [page.id])
      const text = pageToMarkdown(page.title, blocks, image)
      keep.add(path.resolve(file).toLowerCase())
      let current: string | null = null
      try {
        current = fs.readFileSync(file, 'utf8')
      } catch {
        /* 還沒有這個檔 */
      }
      if (current !== text) this.library.writeNote(rel, text)
      this.writeLevel(root, path.join(dir, name), pages, page.id, keep)
    }
  }

  /** 刪掉不再對應任何頁面的副本（只刪程式產生的 .md）與空資料夾 */
  private prune(root: string, dir: string, keep: Set<string>): boolean {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return false
    }
    let empty = true
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (dir === root && e.name === ATTACHMENTS) {
          empty = false
          continue
        }
        if (!this.prune(root, full, keep)) empty = false
        else fs.rmSync(full, { recursive: true, force: true })
      } else if (e.name.toLowerCase().endsWith('.md') && !keep.has(path.resolve(full).toLowerCase()) && isOurs(full)) {
        fs.rmSync(full, { force: true })
      } else {
        empty = false
      }
    }
    return empty && dir !== root
  }
}

function isOurs(file: string): boolean {
  try {
    const fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(MD_MARKER.length * 3)
    const n = fs.readSync(fd, buf, 0, buf.length, 0)
    fs.closeSync(fd)
    return buf.subarray(0, n).toString('utf8').startsWith(MD_MARKER)
  } catch {
    return false
  }
}
