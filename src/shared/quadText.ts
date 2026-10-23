// 重點範圍內的文字：從 PDF 的文字片段取出落在重點位置內的字（主程式測試與畫面共用，純函式）

/** pdf.js 文字片段裡需要的部分（測試時可以自己造） */
export interface TextRun {
  str: string
  /** [a, b, c, d, e, f]：e、f 是基線起點（PDF 座標） */
  transform: number[]
  width: number
  height: number
  hasEOL?: boolean
}

type Rect = [number, number, number, number]

/** quads（每 8 個數一行）→ 每一行的範圍 */
function quadRects(quads: number[]): Rect[] {
  const out: Rect[] = []
  for (let i = 0; i + 7 < quads.length; i += 8) {
    const xs = [quads[i], quads[i + 2], quads[i + 4], quads[i + 6]]
    const ys = [quads[i + 1], quads[i + 3], quads[i + 5], quads[i + 7]]
    out.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)])
  }
  return out
}

const isCjk = (c: string): boolean => /[\u3000-\u9fff\uff00-\uffef]/.test(c)

/**
 * 取落在重點範圍內的字：每個文字片段的寬度平均分給每個字，字的中心點落在任一行的範圍內才算。
 * 換行處：英文行尾的連字號斷字接回，其他英文補空白，中文直接接起來。
 */
export function textInQuads(runs: TextRun[], quads: number[]): string {
  const rects = quadRects(quads)
  if (!rects.length) return ''
  const inside = (x: number, y: number): boolean => rects.some(([x1, y1, x2, y2]) => x >= x1 - 0.5 && x <= x2 + 0.5 && y >= y1 - 0.5 && y <= y2 + 0.5)
  const lines: { y: number; text: string }[] = []
  for (const run of runs) {
    const chars = [...run.str]
    if (!chars.length || !run.width) continue
    const [a, b, , d, x0, y0] = run.transform
    // 只處理水平的文字
    if (Math.abs(b) > Math.abs(a) * 0.2) continue
    const size = run.height || Math.abs(d) || 10
    const cw = run.width / chars.length
    let got = ''
    chars.forEach((c, i) => {
      if (inside(x0 + (i + 0.5) * cw, y0 + size * 0.35)) got += c
    })
    if (!got) continue
    const line = lines.find((l) => Math.abs(l.y - y0) < size * 0.5)
    if (line) line.text += got
    else lines.push({ y: y0, text: got })
  }
  // 由上到下（PDF 的 y 往上增加）
  lines.sort((p, q) => q.y - p.y)
  let out = ''
  for (const { text } of lines) {
    const t = text.replace(/\s+/g, ' ').trim()
    if (!t) continue
    if (!out) out = t
    else if (/[A-Za-z]-$/.test(out) && /^[a-z]/.test(t)) out = out.slice(0, -1) + t
    else if (isCjk(out[out.length - 1]) || isCjk(t[0])) out += t
    else out += ` ${t}`
  }
  return out.trim()
}
