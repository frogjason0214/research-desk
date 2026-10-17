import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'

// 每個最上層區塊都有固定的編號（bid），存檔時以區塊為單位比對，
// 兩台電腦同時改同一頁的不同段落時，各自只寫自己改到的區塊。

export const BLOCK_TYPES = [
  'paragraph',
  'heading',
  'bulletList',
  'orderedList',
  'blockquote',
  'codeBlock',
  'horizontalRule',
  'table',
  'image'
]

export const BlockId = Extension.create({
  name: 'blockId',

  addGlobalAttributes() {
    return [
      {
        types: BLOCK_TYPES,
        attributes: {
          bid: {
            default: null,
            // 按 Enter 分出來的新段落要拿新的編號
            keepOnSplit: false,
            parseHTML: (el) => el.getAttribute('data-bid'),
            renderHTML: (attrs) => (attrs.bid ? { 'data-bid': attrs.bid } : {})
          }
        }
      }
    ]
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('blockId'),
        // 沒有編號或編號重複（例如複製貼上）的最上層區塊補上新編號
        appendTransaction: (transactions, _old, state) => {
          if (!transactions.some((t) => t.docChanged)) return null
          const seen = new Set<string>()
          const tr = state.tr
          let changed = false
          state.doc.forEach((node, offset) => {
            if (!('bid' in node.attrs)) return
            let bid = node.attrs.bid as string | null
            if (!bid || seen.has(bid)) {
              bid = crypto.randomUUID()
              tr.setNodeMarkup(offset, undefined, { ...node.attrs, bid })
              changed = true
            }
            seen.add(bid)
          })
          return changed ? tr.setMeta('addToHistory', false) : null
        }
      })
    ]
  }
})
