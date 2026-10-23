import { Extension } from '@tiptap/core'
import type { Node as PmNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import katex from 'katex'
import 'katex/dist/katex.min.css'
import { findMath } from '../../../shared/mathText'

export { findMath }

// 數學公式：文字裡的 $…$（行內）與 $$…$$（獨立顯示）用 KaTeX 畫出來。
// 公式在文件裡就是一般文字，所以 .md 映像、匯出不用特別處理；編輯時游標移進公式會露出原始碼。

const cache = new Map<string, string>()
function renderTex(tex: string, display: boolean): string {
  const key = `${display ? 'D' : 'I'}${tex}`
  let html = cache.get(key)
  if (html === undefined) {
    html = katex.renderToString(tex, { displayMode: display, throwOnError: false, strict: 'ignore' })
    if (cache.size > 500) cache.clear()
    cache.set(key, html)
  }
  return html
}

const key = new PluginKey<DecorationSet>('noteMath')

function build(doc: PmNode, selFrom: number, selTo: number, editable: boolean): DecorationSet {
  const decos: Decoration[] = []
  doc.descendants((node, pos, parent) => {
    if (node.type.name === 'codeBlock') return false
    if (!node.isText || !node.text || node.marks.some((m) => m.type.name === 'code')) return
    if (parent?.type.name === 'codeBlock') return
    // \$ 是「真的錢字號」：沒在編輯它時把反斜線藏起來
    for (let at = node.text.indexOf('\\$'); at >= 0; at = node.text.indexOf('\\$', at + 2)) {
      const from = pos + at
      if (!(editable && selFrom <= from + 2 && selTo >= from)) decos.push(Decoration.inline(from, from + 1, { class: 'note-math-hidden' }))
    }
    for (const m of findMath(node.text)) {
      const from = pos + m.from
      const to = pos + m.to
      // 編輯模式下游標在公式裡：顯示原始碼，不畫
      if (editable && selFrom <= to && selTo >= from) {
        decos.push(Decoration.inline(from, to, { class: 'note-math-source' }))
        continue
      }
      decos.push(Decoration.inline(from, to, { class: 'note-math-hidden' }))
      decos.push(
        Decoration.widget(
          from,
          () => {
            const el = document.createElement('span')
            el.className = `note-math${m.display ? ' is-display' : ''}`
            el.innerHTML = renderTex(m.tex, m.display)
            el.dataset.pos = String(from)
            return el
          },
          { key: `${m.display ? 'D' : 'I'}${from}:${m.tex}`, side: -1 }
        )
      )
    }
  })
  return DecorationSet.create(doc, decos)
}

export const NoteMath = Extension.create({
  name: 'noteMath',
  addProseMirrorPlugins() {
    const editor = this.editor
    return [
      new Plugin<DecorationSet>({
        key,
        state: {
          init: (_, state) => build(state.doc, state.selection.from, state.selection.to, editor.isEditable),
          apply: (tr, old, _oldState, state) =>
            tr.docChanged || tr.selectionSet || tr.getMeta(key)
              ? build(state.doc, state.selection.from, state.selection.to, editor.isEditable)
              : old
        },
        props: {
          decorations: (state) => key.getState(state),
          handleDOMEvents: {
            // 編輯模式點畫好的公式：把游標放進去，露出原始碼
            mousedown: (view, event) => {
              const el = (event.target as HTMLElement).closest<HTMLElement>('.note-math')
              if (!el || !editor.isEditable) return false
              event.preventDefault()
              view.focus()
              view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, Number(el.dataset.pos) + 1)))
              return true
            }
          }
        }
      })
    ]
  }
})

/** 切換編輯／顯示後要重畫（可不可以編輯會影響要不要露出原始碼） */
export function refreshMath(view: EditorView): void {
  view.dispatch(view.state.tr.setMeta(key, true))
}
