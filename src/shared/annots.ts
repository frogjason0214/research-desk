import type { HighlightColor, PdfAnnot, PdfAnnotOp } from './types'

// PDF 註記：主程式與畫面共用的部分

export const HIGHLIGHT_COLORS: Record<HighlightColor, [number, number, number]> = {
  yellow: [1, 0.91, 0.25],
  green: [0.55, 0.88, 0.45],
  blue: [0.5, 0.75, 1],
  pink: [1, 0.6, 0.8]
}

/** 本程式建立的註記編號開頭（寫在 PDF 的 /NM） */
export const OUR_KEY_PREFIX = 'rdesk-'

export const newAnnotKey = (): string => OUR_KEY_PREFIX + globalThis.crypto.randomUUID()

/** 把還沒寫進檔案的修改套在註記清單上 */
export function replayOps(annots: PdfAnnot[], ops: PdfAnnotOp[]): PdfAnnot[] {
  let list = annots
  for (const op of ops) {
    if (op.type === 'add') list = list.some((a) => a.key === op.annot.key) ? list : [...list, op.annot]
    else if (op.type === 'remove') list = list.filter((a) => a.key !== op.key)
    else
      list = list.map((a) =>
        a.key === op.key && a.mine
          ? { ...a, contents: op.contents ?? a.contents, ...(op.color ? { color: op.color, rgb: HIGHLIGHT_COLORS[op.color] } : {}) }
          : a
      )
  }
  return list
}
