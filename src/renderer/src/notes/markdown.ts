import { generateJSON, type JSONContent } from '@tiptap/core'
import Image from '@tiptap/extension-image'
import Table from '@tiptap/extension-table'
import TableCell from '@tiptap/extension-table-cell'
import TableHeader from '@tiptap/extension-table-header'
import TableRow from '@tiptap/extension-table-row'
import StarterKit from '@tiptap/starter-kit'
import MarkdownIt from 'markdown-it'

// 匯入 .md：Markdown → HTML → 編輯器的區塊。格式定義要和 NoteEditor 一致。

const md = new MarkdownIt({ html: false, linkify: false, breaks: false })
// desk-note: 是程式內的圖片位址，markdown-it 預設會擋掉不認識的協定
const validate = md.validateLink.bind(md)
md.validateLink = (url) => url.startsWith('desk-note:') || validate(url)

const extensions = [StarterKit, Table, TableRow, TableHeader, TableCell, Image.configure({ inline: false })]

const isEmptyParagraph = (n: JSONContent): boolean => n.type === 'paragraph' && !n.content?.length

/**
 * 第一行是「# 標題」時拿來當頁面標題；匯出時內文標題都降了一級，
 * 匯入時若其餘標題都是二級以下就升回來。
 */
export function markdownToPage(markdown: string, fallbackTitle: string): { title: string; blocks: string[] } {
  const doc = generateJSON(md.render(markdown), extensions) as JSONContent
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
