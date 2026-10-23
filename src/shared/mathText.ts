// 找出文字裡的數學公式（$…$、$$…$$）。編輯器、.md 匯入、匯出 Word 共用，純函式。

export interface MathSpan {
  from: number
  to: number
  tex: string
  display: boolean
}

/**
 * 找出文字裡的公式。和 HackMD 一樣：\$ 不算；$ 後面緊接空白、或結尾的 $ 後面接數字的不算，
 * 避免「$100 和 $200」被當成公式。
 */
export function findMath(text: string): MathSpan[] {
  const out: MathSpan[] = []
  let i = 0
  while (i < text.length) {
    const at = text.indexOf('$', i)
    if (at < 0) break
    if (at > 0 && text[at - 1] === '\\') {
      i = at + 1
      continue
    }
    if (text[at + 1] === '$') {
      const end = text.indexOf('$$', at + 2)
      const tex = end > 0 ? text.slice(at + 2, end) : ''
      if (end > 0 && tex.trim()) {
        out.push({ from: at, to: end + 2, tex: tex.trim(), display: true })
        i = end + 2
      } else i = at + 2
      continue
    }
    let end = -1
    if (text[at + 1] && !/\s/.test(text[at + 1])) {
      for (let j = at + 1; j < text.length; j++) {
        const c = text[j]
        if (c === '\n') break
        if (c === '$' && text[j - 1] !== '\\') {
          if (!/\s/.test(text[j - 1]) && !/\d/.test(text[j + 1] ?? '')) end = j
          break
        }
      }
    }
    if (end > at + 1) {
      out.push({ from: at, to: end + 1, tex: text.slice(at + 1, end), display: false })
      i = end + 1
    } else i = at + 1
  }
  return out
}
