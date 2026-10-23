import { generateJSON, type JSONContent } from '@tiptap/core'
import Image from '@tiptap/extension-image'
import Link from '@tiptap/extension-link'
import Table from '@tiptap/extension-table'
import TableCell from '@tiptap/extension-table-cell'
import TableHeader from '@tiptap/extension-table-header'
import TableRow from '@tiptap/extension-table-row'
import TaskItem from '@tiptap/extension-task-item'
import TaskList from '@tiptap/extension-task-list'
import StarterKit from '@tiptap/starter-kit'
import MarkdownIt from 'markdown-it'
import { findMath } from './math'

// 匯入 .md：Markdown → HTML → 編輯器的區塊。格式定義要和 NoteEditor 一致。

const md = new MarkdownIt({ html: false, linkify: true, breaks: false })
// desk-note: 是程式內的圖片位址，markdown-it 預設會擋掉不認識的協定
const validate = md.validateLink.bind(md)
md.validateLink = (url) => url.startsWith('desk-note:') || validate(url)

// 公式原封不動當文字留著（裡面的 _、*、\ 不能被當成 Markdown 語法），編輯器會再把它畫成公式
md.inline.ruler.before('escape', 'math', (state, silent) => {
  // \$ 要留著反斜線，否則編輯器會把兩個 $ 之間當成公式
  if (state.src.startsWith('\\$', state.pos)) {
    if (!silent) state.push('text', '', 0).content = '\\$'
    state.pos += 2
    return true
  }
  if (state.src[state.pos] !== '$') return false
  if (state.pos > 0 && state.src[state.pos - 1] === '\\') return false
  const span = findMath(state.src.slice(state.pos))[0]
  if (!span || span.from !== 0) return false
  if (!silent) state.push('text', '', 0).content = state.src.slice(state.pos, state.pos + span.to)
  state.pos += span.to
  return true
})
// 跨好幾行的 $$ … $$ 變成一個段落
md.block.ruler.before('paragraph', 'mathBlock', (state, startLine, endLine, silent) => {
  const lineText = (n: number): string => state.src.slice(state.bMarks[n] + state.tShift[n], state.eMarks[n])
  const first = lineText(startLine)
  if (!first.startsWith('$$') || (first.length > 2 && first.trimEnd().endsWith('$$'))) return false
  let end = startLine + 1
  while (end < endLine && !lineText(end).trimEnd().endsWith('$$')) end++
  if (end >= endLine) return false
  if (silent) return true
  const tex = [first.slice(2), ...Array.from({ length: end - startLine - 1 }, (_, i) => lineText(startLine + 1 + i)), lineText(end).trimEnd().slice(0, -2)]
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' ')
  state.push('paragraph_open', 'p', 1)
  const inline = state.push('text_raw', '', 0)
  inline.content = `$$${tex}$$`
  state.push('paragraph_close', 'p', -1)
  state.line = end + 1
  return true
})
md.renderer.rules.text_raw = (tokens, i) => md.utils.escapeHtml(tokens[i].content)

const extensions = [
  StarterKit,
  Table,
  TableRow,
  TableHeader,
  TableCell,
  Image.configure({ inline: false }),
  Link,
  TaskList,
  TaskItem.configure({ nested: true })
]

/** 「- [ ] 事項」：markdown-it 沒有勾選清單，轉成編輯器認得的 HTML */
function markTaskLists(html: string): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
  for (const ul of doc.querySelectorAll('ul')) {
    const items = [...ul.children].filter((c) => c.tagName === 'LI')
    const box = (li: Element): RegExpMatchArray | null => {
      const host = li.firstElementChild?.tagName === 'P' ? li.firstElementChild : li
      return (host.firstChild?.nodeType === Node.TEXT_NODE ? host.firstChild.textContent ?? '' : '').match(/^\[( |x|X)\]\s+/)
    }
    if (!items.length || !items.every(box)) continue
    ul.setAttribute('data-type', 'taskList')
    for (const li of items) {
      const m = box(li)!
      const host = li.firstElementChild?.tagName === 'P' ? li.firstElementChild : li
      host.firstChild!.textContent = (host.firstChild!.textContent ?? '').slice(m[0].length)
      li.setAttribute('data-type', 'taskItem')
      li.setAttribute('data-checked', m[1] === ' ' ? 'false' : 'true')
    }
  }
  return doc.body.innerHTML
}

const isEmptyParagraph = (n: JSONContent): boolean => n.type === 'paragraph' && !n.content?.length

/**
 * 第一行是「# 標題」時拿來當頁面標題；匯出時內文標題都降了一級，
 * 匯入時若其餘標題都是二級以下就升回來。
 */
export function markdownToPage(markdown: string, fallbackTitle: string): { title: string; blocks: string[] } {
  const doc = generateJSON(markTaskLists(md.render(markdown)), extensions) as JSONContent
  let nodes = (doc.content ?? []).filter((n) => !isEmptyParagraph(n))
  let title = fallbackTitle
  const first = nodes[0]
  if (first?.type === 'heading' && first.attrs?.level === 1) {
    title = (first.content ?? []).map((c) => c.text ?? '').join('').trim() || fallbackTitle
    nodes = nodes.slice(1)
    const headings = nodes.filter((n) => n.type === 'heading')
    if (headings.length && headings.every((h) => Number(h.attrs?.level) >= 2))
      nodes = nodes.map((n) => (n.type === 'heading' ? { ...n, attrs: { ...n.attrs, level: Number(n.attrs?.level) - 1 } } : n))
  }
  return { title, blocks: nodes.map((n) => JSON.stringify(n)) }
}
