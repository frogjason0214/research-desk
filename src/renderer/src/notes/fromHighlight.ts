import type { JSONContent } from '@tiptap/core'
import { inTextCitation } from '../../../shared/apa'
import { withLocator } from '../../../shared/citation'
import type { Paper, PdfAnnot } from '../../../shared/types'
import { cropArea, describe, type HighlightItem, type OpenedPdf } from '../reader/highlightText'
import { desk } from '../useDesk'

// 重點 → 筆記區塊：螢光筆是引言＋引用（含頁碼），框選是截圖＋引用，便利貼是註解＋引用

const cite = (paper: Paper, locator: string): JSONContent => ({
  type: 'mention',
  attrs: { id: paper.id, label: inTextCitation(paper, paper.lang), locator }
})
const para = (content: JSONContent[]): JSONContent => ({ type: 'paragraph', content })
const text = (t: string): JSONContent => ({ type: 'text', text: t })

/** 一個重點的區塊（框選的截圖要先存好，傳 imageSrc 進來） */
export function highlightBlocks(paper: Paper, item: HighlightItem, imageSrc?: string): JSONContent[] {
  const { annot, locator } = item
  const comment = annot.contents.trim()
  const out: JSONContent[] = []
  if (annot.kind === 'area' && imageSrc) {
    out.push({ type: 'image', attrs: { src: imageSrc, alt: `${paper.title} ${locator}` } })
    out.push(para([cite(paper, locator)]))
    if (comment) out.push(para([text(comment)]))
  } else if (item.text) {
    out.push({ type: 'blockquote', content: [para([text(`${item.text} `), cite(paper, locator)])] })
    if (comment) out.push(para([text(comment)]))
  } else {
    // 便利貼，或讀不出文字的重點：註解＋引用
    out.push(para(comment ? [text(`${comment} `), cite(paper, locator)] : [cite(paper, locator)]))
  }
  return out
}

/** 把幾個重點依序加到某頁筆記的最後面 */
export async function addHighlightsToNote(paper: Paper, opened: OpenedPdf, annots: PdfAnnot[], pageId: string): Promise<void> {
  const blocks: JSONContent[] = []
  for (const a of annots) {
    const item = await describe(opened, paper, a)
    let src: string | undefined
    if (a.kind === 'area') {
      const page = await opened.pdf.getPage(a.page + 1)
      src = await desk.notes.saveImage('highlight.png', await cropArea(page, a.rect))
    }
    blocks.push(...highlightBlocks(paper, item, src))
  }
  await desk.notes.appendBlocks(pageId, blocks.map((b) => JSON.stringify(b)))
}

/** 「複製」：每筆一段純文字（原文或〔圖〕、引用含頁碼、註解） */
export function highlightsAsText(paper: Paper, items: HighlightItem[]): string {
  const label = inTextCitation(paper, paper.lang)
  return items
    .map(({ annot, text: t, locator }) => {
      const c = withLocator(label, locator)
      const body = annot.kind === 'area' ? '〔圖〕' : t ? `「${t}」` : ''
      const comment = annot.contents.trim()
      return [body ? `${body} ${c}` : c, comment].filter(Boolean).join('\n')
    })
    .join('\n\n')
}
