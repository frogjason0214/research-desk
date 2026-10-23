import { Extension, type Editor, type JSONContent } from '@tiptap/core'
import Image from '@tiptap/extension-image'
import Link from '@tiptap/extension-link'
import Mention from '@tiptap/extension-mention'
import Placeholder from '@tiptap/extension-placeholder'
import Table from '@tiptap/extension-table'
import TableCell from '@tiptap/extension-table-cell'
import TableHeader from '@tiptap/extension-table-header'
import TableRow from '@tiptap/extension-table-row'
import TaskItem from '@tiptap/extension-task-item'
import TaskList from '@tiptap/extension-task-list'
import { PluginKey } from '@tiptap/pm/state'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Suggestion from '@tiptap/suggestion'
import {
  AtSign,
  BetweenHorizontalEnd,
  BetweenVerticalEnd,
  Bold,
  Columns3,
  Heading1,
  Heading2,
  Heading3,
  ImagePlus,
  Italic,
  List,
  ListChecks,
  ListOrdered,
  Minus,
  Quote,
  Rows3,
  Sigma,
  SquareCode,
  Table as TableIcon,
  Trash2,
  type LucideIcon
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { inTextCitation } from '../../../shared/apa'
import { withLocator } from '../../../shared/citation'
import type { Focus, NoteBlock, NoteBlockChanges, Paper } from '../../../shared/types'
import { IconButton } from '../components/IconButton'
import { errorText } from '../importing'
import { desk } from '../useDesk'
import { shortcut } from '../platform'
import { BlockId } from './blockIds'
import { NoteMath, refreshMath } from './math'
import { suggestionRender, SuggestionMenu, useMenuController, type MenuController, type MenuItem } from './SuggestionMenu'

const SAVE_DELAY_MS = 700

// ---------- 「/」插入區塊 ----------

interface SlashAction {
  key: string
  label: string
  /** 也可以用這些字搜尋 */
  words: string
  icon: LucideIcon
  run: (editor: Editor, pickImage: () => void) => void
}

const SLASH: SlashAction[] = [
  { key: 'h1', label: '大標題', words: 'h1 heading 標題', icon: Heading1, run: (e) => e.chain().focus().setNode('heading', { level: 1 }).run() },
  { key: 'h2', label: '中標題', words: 'h2 heading 標題', icon: Heading2, run: (e) => e.chain().focus().setNode('heading', { level: 2 }).run() },
  { key: 'h3', label: '小標題', words: 'h3 heading 標題', icon: Heading3, run: (e) => e.chain().focus().setNode('heading', { level: 3 }).run() },
  { key: 'ul', label: '項目清單', words: 'list bullet 清單', icon: List, run: (e) => e.chain().focus().toggleBulletList().run() },
  { key: 'task', label: '勾選清單', words: 'todo task check 待辦 勾選', icon: ListChecks, run: (e) => e.chain().focus().toggleTaskList().run() },
  { key: 'ol', label: '編號清單', words: 'list number ordered 清單 編號', icon: ListOrdered, run: (e) => e.chain().focus().toggleOrderedList().run() },
  { key: 'quote', label: '引言', words: 'quote 引用', icon: Quote, run: (e) => e.chain().focus().toggleBlockquote().run() },
  { key: 'code', label: '程式碼', words: 'code 程式', icon: SquareCode, run: (e) => e.chain().focus().toggleCodeBlock().run() },
  { key: 'hr', label: '分隔線', words: 'divider hr line 分隔', icon: Minus, run: (e) => e.chain().focus().setHorizontalRule().run() },
  {
    key: 'table',
    label: '表格',
    words: 'table 表格',
    icon: TableIcon,
    run: (e) => e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
  },
  { key: 'image', label: '圖片', words: 'image picture 圖片 照片', icon: ImagePlus, run: (_e, pick) => pick() },
  { key: 'math', label: '數學公式', words: 'math latex formula 公式 數學', icon: Sigma, run: (e) => insertMath(e) }
]

/** 插入一組 $$ $$，游標放在中間 */
function insertMath(editor: Editor): void {
  const { from } = editor.state.selection
  editor.chain().focus().insertContent('$$$$').setTextSelection(from + 2).run()
}

const SlashCommand = Extension.create<{ ctrl: MenuController | null; pickImage: () => void }>({
  name: 'slashCommand',
  addOptions() {
    return { ctrl: null, pickImage: () => undefined }
  },
  addProseMirrorPlugins() {
    const { ctrl, pickImage } = this.options
    return [
      Suggestion<MenuItem>({
        editor: this.editor,
        char: '/',
        pluginKey: new PluginKey('slashCommand'),
        items: ({ query }) => {
          const q = query.toLowerCase()
          return SLASH.filter((a) => !q || a.label.includes(q) || a.words.includes(q)).map((a) => {
            const Icon = a.icon
            return { key: a.key, label: a.label, icon: <Icon size={16} strokeWidth={1.8} aria-hidden /> }
          })
        },
        command: ({ editor, range, props }) => {
          editor.chain().focus().deleteRange(range).run()
          SLASH.find((a) => a.key === props.key)?.run(editor, pickImage)
        },
        render: suggestionRender(ctrl!)
      })
    ]
  }
})

// ---------- 區塊與存檔 ----------

/** 資料庫的區塊 → 編輯器文件 */
function toDoc(blocks: NoteBlock[]): JSONContent {
  const content = blocks
    .map((b): JSONContent | null => {
      try {
        const node = JSON.parse(b.content) as JSONContent
        return { ...node, attrs: { ...node.attrs, bid: b.id } }
      } catch {
        return null
      }
    })
    .filter((n): n is JSONContent => !!n)
  return { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] }
}

type Saved = Map<string, { sort: number; content: string }>

const savedFrom = (blocks: NoteBlock[]): Saved => new Map(blocks.map((b) => [b.id, { sort: b.sort, content: b.content }]))

/** 目前的文件和上次存的比，只列出改到的區塊 */
function diff(doc: JSONContent, saved: Saved): { changes: NoteBlockChanges; next: Saved } {
  const next: Saved = new Map()
  const upserts: NoteBlockChanges['upserts'] = []
  ;(doc.content ?? []).forEach((node, sort) => {
    const bid = node.attrs?.bid as string | undefined
    if (!bid) return
    // 還沒寫過字的空段落不存
    if (!saved.has(bid) && node.type === 'paragraph' && !node.content?.length) return
    const content = JSON.stringify(node)
    next.set(bid, { sort, content })
    const old = saved.get(bid)
    if (!old || old.content !== content) upserts.push({ id: bid, sort, content })
    else if (old.sort !== sort) upserts.push({ id: bid, sort })
  })
  const removes = [...saved.keys()].filter((id) => !next.has(id))
  return { changes: { upserts, removes }, next }
}

const sameSaved = (a: Saved, b: Saved): boolean =>
  a.size === b.size && [...a].every(([id, v]) => b.get(id)?.content === v.content && b.get(id)?.sort === v.sort)

// ---------- 編輯器 ----------

export function NoteEditor({
  pageId,
  projectId,
  onNavigate,
  onError,
  autoFocus,
  mode,
  onLoaded,
  onRequestEdit
}: {
  pageId: string
  projectId: string
  onNavigate: (f: Focus) => void
  onError: (message: string) => void
  autoFocus: boolean
  /** view：顯示模式（不能改，只能打勾待辦） */
  mode: 'edit' | 'view'
  /** 第一次載入完成；hasContent 決定預設要不要顯示模式 */
  onLoaded?: (hasContent: boolean) => void
  /** 顯示模式下雙擊內容 */
  onRequestEdit?: () => void
}) {
  const [slashMenu, slashCtrl] = useMenuController()
  const [citeMenu, citeCtrl] = useMenuController()
  const papers = useRef<Paper[]>([])
  const fileInput = useRef<HTMLInputElement>(null)
  const saved = useRef<Saved>(new Map())
  const latest = useRef<JSONContent | null>(null)
  const timer = useRef<number | undefined>(undefined)
  const saving = useRef<Promise<void>>(Promise.resolve())
  const remotePending = useRef(false)
  const loaded = useRef(false)
  const editorRef = useRef<Editor | null>(null)
  // 雙擊進編輯時，游標要放在雙擊的位置
  const editAt = useRef<number | null>(null)
  const [headings, setHeadings] = useState<Heading[]>([])
  const [citeEdit, setCiteEdit] = useState<CiteEdit | null>(null)

  useEffect(() => {
    const load = (): void => void desk.papers.list(projectId).then((list) => (papers.current = list))
    load()
    return desk.onChanged(load)
  }, [projectId])

  const save = (): Promise<void> => {
    window.clearTimeout(timer.current)
    timer.current = undefined
    const doc = latest.current
    if (!doc || !loaded.current) return saving.current
    const { changes, next } = diff(doc, saved.current)
    if (!changes.upserts.length && !changes.removes.length) return saving.current
    saved.current = next
    saving.current = saving.current
      .then(() => desk.notes.saveBlocks(pageId, changes))
      .catch((err) => onError(errorText(err)))
    return saving.current
  }

  const insertImages = async (editor: Editor, files: File[], pos?: number): Promise<void> => {
    for (const file of files.filter((f) => f.type.startsWith('image/'))) {
      try {
        const src = await desk.notes.saveImage(file.name || 'image.png', await file.arrayBuffer())
        const node = { type: 'image', attrs: { src, alt: file.name.replace(/\.[^.]+$/, '') } }
        if (pos === undefined) editor.chain().focus().insertContent(node).run()
        else editor.chain().focus().insertContentAt(pos, node).run()
      } catch (err) {
        onError(errorText(err))
      }
    }
  }

  const editor = useEditor({
    extensions: [
      StarterKit,
      BlockId,
      Placeholder.configure({ placeholder: '輸入文字；打 / 插入標題、清單、表格、圖片，打 @ 引用文獻' }),
      Table.configure({ resizable: false }),
      TableRow,
      TableHeader,
      TableCell,
      Image.configure({ inline: false }),
      TaskList,
      TaskItem.configure({
        nested: true,
        // 顯示模式也能打勾：文件由下面的 change 事件更新（這裡拿到的 node 可能是舊的）
        onReadOnlyChecked: () => true
      }),
      Link.configure({ openOnClick: false, autolink: true, linkOnPaste: true, HTMLAttributes: { target: '_blank', rel: 'noreferrer' } }),
      NoteMath,
      CiteMention.configure({
        HTMLAttributes: { class: 'note-cite' },
        renderText: ({ node }) => citeText(node.attrs),
        renderHTML: ({ options, node }) => ['span', { ...options.HTMLAttributes, title: '點一下打開這篇文獻' }, citeText(node.attrs)],
        suggestion: {
          char: '@',
          pluginKey: new PluginKey('cite'),
          items: ({ query }): MenuItem[] => {
            const q = query.trim().toLowerCase()
            return papers.current
              .filter((p) => !q || [p.title, p.year, ...p.authors.map((a) => a.family + a.given)].join(' ').toLowerCase().includes(q))
              .slice(0, 8)
              .map((p) => ({ key: p.id, label: inTextCitation(p, p.lang), hint: p.title }))
          },
          command: ({ editor, range, props }) => {
            const item = props as unknown as MenuItem
            editor
              .chain()
              .focus()
              .insertContentAt(range, [
                { type: 'mention', attrs: { id: item.key, label: item.label } },
                { type: 'text', text: ' ' }
              ])
              .run()
          },
          render: suggestionRender(citeCtrl)
        }
      }),
      SlashCommand.configure({ ctrl: slashCtrl, pickImage: () => fileInput.current?.click() })
    ],
    editable: mode === 'edit',
    editorProps: {
      attributes: { class: 'note-prose', 'aria-label': '筆記內容' },
      handlePaste: (_view, event) => {
        const files = [...(event.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'))
        if (!files.length || !editorRef.current) return false
        void insertImages(editorRef.current, files)
        return true
      },
      handleDrop: (view, event) => {
        const files = [...(event.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith('image/'))
        if (!files.length || !editorRef.current) return false
        const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos
        void insertImages(editorRef.current, files, pos)
        return true
      },
      handleDOMEvents: {
        click: (view, event) => {
          const target = event.target as HTMLElement
          const cite = target.closest<HTMLElement>('.note-cite')
          if (cite?.dataset.id) {
            // 編輯模式：可以改頁碼；顯示模式：打開文獻
            if (view.editable) {
              const pos = view.posAtDOM(cite, 0)
              const box = cite.getBoundingClientRect()
              const host = view.dom.closest('.note-editor')?.getBoundingClientRect()
              setCiteEdit({
                pos: view.state.doc.nodeAt(pos)?.type.name === 'mention' ? pos : pos - 1,
                paperId: cite.dataset.id,
                locator: cite.dataset.locator ?? '',
                left: box.left - (host?.left ?? 0),
                top: box.bottom - (host?.top ?? 0) + 4
              })
              return true
            }
            onNavigate({ page: 'literature', paperId: cite.dataset.id })
            return true
          }
          setCiteEdit(null)
          // 連結：顯示模式點一下打開；編輯模式要按住 Ctrl（Mac 是 ⌘）
          const link = target.closest<HTMLAnchorElement>('a[href]')
          if (link && (!view.editable || event.ctrlKey || event.metaKey)) {
            event.preventDefault()
            window.open(link.href, '_blank')
            return true
          }
          if (link) event.preventDefault()
          return false
        },
        change: (view, event) => {
          const box = event.target as HTMLInputElement
          const li = box.closest('ul[data-type="taskList"] > li')
          if (view.editable || box.type !== 'checkbox' || !li) return false
          let at = -1
          view.state.doc.descendants((n, pos) => {
            if (at >= 0) return false
            if (n.type.name === 'taskItem' && view.nodeDOM(pos) === li) at = pos
          })
          const node = at >= 0 ? view.state.doc.nodeAt(at) : null
          if (!node) return false
          view.dispatch(view.state.tr.setNodeMarkup(at, undefined, { ...node.attrs, checked: box.checked }))
          return false
        },
        dblclick: (view, event) => {
          if (view.editable || (event.target as HTMLElement).closest('a, .note-cite, input')) return false
          editAt.current = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? null
          onRequestEdit?.()
          return true
        }
      }
    },
    onUpdate: ({ editor }) => {
      latest.current = editor.getJSON()
      setHeadings(headingsOf(latest.current))
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => void save(), SAVE_DELAY_MS)
    },
    // 打字時其他電腦改了這頁：等離開編輯器再更新，免得游標跳走
    onBlur: () => {
      void save()
      if (remotePending.current) void reload()
    }
  })

  editorRef.current = editor

  /** 從資料庫重新載入（第一次開啟，或其他電腦改了這頁） */
  const reload = async (): Promise<void> => {
    if (!editor) return
    await save()
    const blocks = await desk.notes.blocks(pageId)
    const remote = savedFrom(blocks)
    if (loaded.current && sameSaved(remote, saved.current)) return
    if (loaded.current && editor.isFocused) {
      remotePending.current = true
      return
    }
    remotePending.current = false
    saved.current = remote
    editor.commands.setContent(toDoc(blocks), false)
    latest.current = editor.getJSON()
    setHeadings(headingsOf(latest.current))
    if (!loaded.current) {
      loaded.current = true
      onLoaded?.(blocks.length > 0)
      if (autoFocus) editor.commands.focus('end')
    }
  }

  useEffect(() => {
    if (!editor) return
    void reload()
    return desk.onChanged(() => {
      // 自己的修改還沒存完時不比對
      if (timer.current === undefined) void reload()
    })
    // reload 每次 render 都是新的函式；只在換頁或編輯器建立時重新訂閱
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, pageId])

  // 換頁或關閉時把還沒存的修改寫進去
  useEffect(() => () => void save(), [])

  // 切換編輯／顯示
  useEffect(() => {
    if (!editor || editor.isEditable === (mode === 'edit')) return
    if (mode === 'view') void save()
    editor.setEditable(mode === 'edit', false)
    refreshMath(editor.view)
    if (mode === 'edit') {
      const at = editAt.current
      editAt.current = null
      const active = document.activeElement
      if (at !== null) editor.chain().focus().setTextSelection(at).run()
      // 正在打頁面標題（例如剛新增的頁面）就不要搶走游標
      else if (!(active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement)) editor.commands.focus()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, mode])

  if (!editor) return null
  const tool = (icon: LucideIcon, label: string, active: boolean, run: () => void) => (
    <IconButton icon={icon} label={label} active={active} onClick={run} />
  )
  const chain = () => editor.chain().focus()

  // 兩種模式用同一棵樹，切換時編輯器不用重新掛載
  const view = mode === 'view'
  return (
    <div className={`note-editor${view ? ' is-view' : ''}`}>
      <div className="note-toolbar" role="toolbar" aria-label="格式" hidden={view}>
        {tool(Bold, `粗體（${shortcut('B')}）`, editor.isActive('bold'), () => chain().toggleBold().run())}
        {tool(Italic, `斜體（${shortcut('I')}）`, editor.isActive('italic'), () => chain().toggleItalic().run())}
        <span className="note-toolbar-sep" />
        {tool(Heading1, '大標題', editor.isActive('heading', { level: 1 }), () => chain().toggleHeading({ level: 1 }).run())}
        {tool(Heading2, '中標題', editor.isActive('heading', { level: 2 }), () => chain().toggleHeading({ level: 2 }).run())}
        {tool(Heading3, '小標題', editor.isActive('heading', { level: 3 }), () => chain().toggleHeading({ level: 3 }).run())}
        {tool(List, '項目清單', editor.isActive('bulletList'), () => chain().toggleBulletList().run())}
        {tool(ListOrdered, '編號清單', editor.isActive('orderedList'), () => chain().toggleOrderedList().run())}
        {tool(ListChecks, '勾選清單（行首打 [ ] 加空白也可以）', editor.isActive('taskList'), () => chain().toggleTaskList().run())}
        {tool(Quote, '引言', editor.isActive('blockquote'), () => chain().toggleBlockquote().run())}
        {tool(SquareCode, '程式碼', editor.isActive('codeBlock'), () => chain().toggleCodeBlock().run())}
        {tool(Minus, '分隔線', false, () => chain().setHorizontalRule().run())}
        <span className="note-toolbar-sep" />
        {tool(TableIcon, '插入表格', false, () => chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run())}
        {tool(ImagePlus, '插入圖片（也可以直接貼上或拖進來）', false, () => fileInput.current?.click())}
        {tool(AtSign, '引用文獻', false, () => chain().insertContent(' @').run())}
        {tool(Sigma, '數學公式（$…$ 寫在句子裡，$$…$$ 獨立一行）', false, () => insertMath(editor))}
        {editor.isActive('table') && (
          <span className="note-table-tools" role="group" aria-label="表格">
            {tool(BetweenHorizontalEnd, '下方加一列', false, () => chain().addRowAfter().run())}
            {tool(BetweenVerticalEnd, '右邊加一欄', false, () => chain().addColumnAfter().run())}
            {tool(Rows3, '刪除這一列', false, () => chain().deleteRow().run())}
            {tool(Columns3, '刪除這一欄', false, () => chain().deleteColumn().run())}
            <IconButton icon={Trash2} label="刪除表格" danger onClick={() => chain().deleteTable().run()} />
          </span>
        )}
      </div>
      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          const files = [...(e.target.files ?? [])]
          e.target.value = ''
          void insertImages(editor, files)
        }}
      />
      <EditorContent editor={editor} className="note-content" />
      {view && <NoteToc headings={headings} />}
      {citeEdit && !view && (
        <CitePopover
          edit={citeEdit}
          onSave={(locator) => {
            const node = editor.state.doc.nodeAt(citeEdit.pos)
            if (node?.type.name === 'mention')
              editor.chain().focus().command(({ tr }) => {
                tr.setNodeMarkup(citeEdit.pos, undefined, { ...node.attrs, locator: locator.trim() || null })
                return true
              }).run()
            setCiteEdit(null)
          }}
          onOpen={() => {
            setCiteEdit(null)
            onNavigate({ page: 'literature', paperId: citeEdit.paperId })
          }}
          onClose={() => setCiteEdit(null)}
        />
      )}
      <SuggestionMenu state={slashMenu} empty="沒有符合的區塊" />
      <SuggestionMenu state={citeMenu} empty="找不到文獻；先到「文獻」匯入" />
    </div>
  )
}

// ---------- 引用與頁碼 ----------

/** @引用：多一個頁碼（locator），例如 p. 5、頁 5 */
const CiteMention = Mention.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      locator: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-locator'),
        renderHTML: (attrs) => (attrs.locator ? { 'data-locator': attrs.locator } : {})
      }
    }
  }
})

const citeText = (attrs: Record<string, unknown>): string => withLocator(String(attrs.label ?? ''), attrs.locator as string | null)

interface CiteEdit {
  pos: number
  paperId: string
  locator: string
  left: number
  top: number
}

function CitePopover({ edit, onSave, onOpen, onClose }: { edit: CiteEdit; onSave: (locator: string) => void; onOpen: () => void; onClose: () => void }) {
  const [value, setValue] = useState(edit.locator)
  return (
    <div className="note-cite-pop" style={{ left: Math.max(0, edit.left), top: edit.top }} onMouseDown={(e) => e.stopPropagation()}>
      <label>
        頁碼
        <input
          autoFocus
          value={value}
          placeholder="例如 p. 5、頁 5"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return
            if (e.key === 'Enter') {
              e.preventDefault()
              onSave(value)
            } else if (e.key === 'Escape') onClose()
          }}
        />
      </label>
      <div className="note-cite-pop-actions">
        <button className="btn" onClick={onOpen}>
          打開文獻
        </button>
        <span className="spacer" />
        <button className="btn" onClick={onClose}>
          取消
        </button>
        <button className="btn btn-primary" onClick={() => onSave(value)}>
          儲存
        </button>
      </div>
    </div>
  )
}

// ---------- 目錄（顯示模式） ----------

interface Heading {
  level: number
  text: string
}

function headingsOf(doc: JSONContent): Heading[] {
  return (doc.content ?? [])
    .filter((n) => n.type === 'heading')
    .map((n) => ({
      level: Number(n.attrs?.level ?? 1),
      text: (n.content ?? []).map((c) => c.text ?? (c.attrs?.label as string | undefined) ?? '').join('').trim()
    }))
    .filter((h) => h.text)
}

function NoteToc({ headings }: { headings: Heading[] }) {
  const nav = useRef<HTMLElement>(null)
  if (headings.length < 2) return null
  const top = Math.min(...headings.map((h) => h.level))
  const jump = (i: number): void => {
    const prose = nav.current?.parentElement?.querySelector('.note-prose')
    const el = prose?.querySelectorAll(':scope > h1, :scope > h2, :scope > h3')[i]
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  return (
    <nav className="note-toc" ref={nav} aria-label="目錄">
      <p className="note-toc-title">目錄</p>
      <ul>
        {headings.map((h, i) => (
          <li key={i} style={{ paddingLeft: (h.level - top) * 12 }}>
            <button className="link-btn" onClick={() => jump(i)}>
              {h.text}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  )
}
