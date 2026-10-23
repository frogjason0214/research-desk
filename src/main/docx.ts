import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  Math as DocMath,
  MathAngledBrackets,
  MathCurlyBrackets,
  MathFraction,
  MathIntegral,
  MathRadical,
  MathRoundBrackets,
  MathRun,
  MathSquareBrackets,
  MathSubScript,
  MathSubSuperScript,
  MathSum,
  MathSuperScript,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type MathComponent,
  type ParagraphChild
} from 'docx'
import { apaCitation } from '../shared/apa'
import { inTextFor, orderReferences } from '../shared/citation'
import { parseLatex, type MathNode } from '../shared/latex'
import { findMath } from '../shared/mathText'
import type { Paper } from '../shared/types'

// 筆記 → Word（.docx）：台灣論文常見版面（標楷體＋Times New Roman、12 點、1.5 倍行距），
// 引用依文獻目前的書目重新產生（含 a／b 與頁碼），文末附 APA 參考文獻。

export interface PmNode {
  type: string
  attrs?: Record<string, unknown>
  content?: PmNode[]
  text?: string
  marks?: { type: string; attrs?: Record<string, unknown> }[]
}

export interface DocxSection {
  title: string
  /** 0 = 匯出的那一頁，1 = 子頁… */
  depth: number
  blocks: PmNode[]
}

export interface DocxWarnings {
  missingCitations: number
  unconvertedMath: number
  missingImages: number
}

const EAST = '標楷體'
const LATIN = 'Times New Roman'
const MONO = 'Consolas'
const FONT = { ascii: LATIN, hAnsi: LATIN, eastAsia: EAST, cs: LATIN }
const HALF_INCH = 720
// A4 版心寬約 15.9 公分，以 96 dpi 計約 600 像素
const MAX_IMAGE_PX = 600
const HEADINGS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6]
const heading = (level: number): (typeof HEADINGS)[number] => HEADINGS[Math.min(Math.max(level, 1), 6) - 1]

// ---------- 公式 ----------

function mathNodes(nodes: MathNode[]): MathComponent[] {
  const out: MathComponent[] = []
  for (const n of nodes) {
    switch (n.t) {
      case 'run':
        out.push(n.upright ? new MathRun({ text: n.text, normalText: true }) : new MathRun(n.text))
        break
      case 'frac':
        out.push(new MathFraction({ numerator: mathNodes(n.num), denominator: mathNodes(n.den) }))
        break
      case 'sup':
        out.push(new MathSuperScript({ children: mathNodes(n.base), superScript: mathNodes(n.sup) }))
        break
      case 'sub':
        out.push(new MathSubScript({ children: mathNodes(n.base), subScript: mathNodes(n.sub) }))
        break
      case 'subsup':
        out.push(new MathSubSuperScript({ children: mathNodes(n.base), subScript: mathNodes(n.sub), superScript: mathNodes(n.sup) }))
        break
      case 'sqrt':
        out.push(new MathRadical({ children: mathNodes(n.body), degree: n.degree ? mathNodes(n.degree) : undefined }))
        break
      case 'nary': {
        const sub = n.sub ? mathNodes(n.sub) : undefined
        const sup = n.sup ? mathNodes(n.sup) : undefined
        const body = mathNodes(n.body)
        if (n.op === 'sum') out.push(new MathSum({ children: body, subScript: sub, superScript: sup }))
        else if (n.op === 'int') out.push(new MathIntegral({ children: body, subScript: sub, superScript: sup }))
        else {
          // docx 沒有 ∏ 的元件：用上下標接在 ∏ 符號上
          const base = [new MathRun('∏')]
          if (sub && sup) out.push(new MathSubSuperScript({ children: base, subScript: sub, superScript: sup }))
          else if (sub) out.push(new MathSubScript({ children: base, subScript: sub }))
          else if (sup) out.push(new MathSuperScript({ children: base, superScript: sup }))
          else out.push(...base)
          out.push(...body)
        }
        break
      }
      case 'accent': {
        // 重音記號：可以合併的文字每個字後面加組合字元（x̄、x̂），其他情況放在最後
        const only = n.body.length === 1 && n.body[0].t === 'run' ? n.body[0] : null
        if (only) out.push(new MathRun([...only.text].map((c) => c + n.char).join('')))
        else out.push(...mathNodes(n.body), new MathRun(n.char))
        break
      }
      case 'paren': {
        const children = mathNodes(n.body)
        if (n.open === '(' && n.close === ')') out.push(new MathRoundBrackets({ children }))
        else if (n.open === '[' && n.close === ']') out.push(new MathSquareBrackets({ children }))
        else if (n.open === '{' && n.close === '}') out.push(new MathCurlyBrackets({ children }))
        else if (n.open === '⟨' && n.close === '⟩') out.push(new MathAngledBrackets({ children }))
        else out.push(...(n.open ? [new MathRun(n.open)] : []), ...children, ...(n.close ? [new MathRun(n.close)] : []))
        break
      }
    }
  }
  return out
}

// ---------- 主程式 ----------

interface Ctx {
  papers: Map<string, Paper>
  suffix: Map<string, string>
  cited: Set<string>
  warnings: DocxWarnings
  readImage: (src: string) => Buffer | null
  /** 每個編號清單各自從 1 開始 */
  listInstance: number
}

type Marks = { bold?: boolean; italics?: boolean; strike?: boolean; code?: boolean }

function textRuns(text: string, marks: Marks, ctx: Ctx): ParagraphChild[] {
  const out: ParagraphChild[] = []
  const plain = (t: string): void => {
    if (!t) return
    // \$ 是真的錢字號
    const value = t.replace(/\\\$/g, '$')
    out.push(new TextRun({ text: value, bold: marks.bold, italics: marks.italics, strike: marks.strike, font: marks.code ? MONO : undefined }))
  }
  if (marks.code) {
    plain(text)
    return out
  }
  let at = 0
  for (const m of findMath(text)) {
    plain(text.slice(at, m.from))
    const tree = parseLatex(m.tex)
    if (tree) out.push(new DocMath({ children: mathNodes(tree) }))
    else {
      ctx.warnings.unconvertedMath++
      plain(text.slice(m.from, m.to))
    }
    at = m.to
  }
  plain(text.slice(at))
  return out
}

function inline(nodes: PmNode[] | undefined, ctx: Ctx): ParagraphChild[] {
  const out: ParagraphChild[] = []
  for (const n of nodes ?? []) {
    if (n.type === 'hardBreak') {
      out.push(new TextRun({ text: '', break: 1 }))
      continue
    }
    if (n.type === 'mention') {
      const id = String(n.attrs?.id ?? '')
      const paper = ctx.papers.get(id)
      const locator = (n.attrs?.locator as string | null) ?? null
      if (paper) {
        ctx.cited.add(id)
        out.push(new TextRun(inTextFor(paper, ctx.suffix.get(id) ?? '', locator)))
      } else {
        ctx.warnings.missingCitations++
        const label = String(n.attrs?.label ?? '')
        out.push(new TextRun(locator ? label.replace(/[)）]$/, (c) => (c === '）' ? `，${locator}）` : `, ${locator})`)) : label))
      }
      continue
    }
    if (n.type === 'image') {
      const img = imageRun(String(n.attrs?.src ?? ''), ctx)
      if (img) out.push(img)
      continue
    }
    const marks: Marks = {}
    let link: string | null = null
    for (const m of n.marks ?? []) {
      if (m.type === 'bold') marks.bold = true
      else if (m.type === 'italic') marks.italics = true
      else if (m.type === 'strike') marks.strike = true
      else if (m.type === 'code') marks.code = true
      else if (m.type === 'link' && m.attrs?.href) link = String(m.attrs.href)
    }
    const runs = textRuns(n.text ?? '', marks, ctx)
    if (link)
      out.push(
        new ExternalHyperlink({
          link,
          children: [new TextRun({ text: (n.text ?? '').replace(/\\\$/g, '$'), style: 'Hyperlink', bold: marks.bold, italics: marks.italics })]
        })
      )
    else out.push(...runs)
  }
  return out
}

/** 讀 PNG、JPEG、GIF 的寬高（像素） */
function imageSize(buf: Buffer): { type: 'png' | 'jpg' | 'gif'; width: number; height: number } | null {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return { type: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
  if (buf.length > 10 && buf.toString('ascii', 0, 3) === 'GIF') return { type: 'gif', width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) return null
      const marker = buf[i + 1]
      const len = buf.readUInt16BE(i + 2)
      // SOF0–SOF15（除了 DHT、JPG、DAC）記錄寬高
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
        return { type: 'jpg', height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) }
      i += 2 + len
    }
  }
  return null
}

function imageRun(src: string, ctx: Ctx): ImageRun | null {
  const data = ctx.readImage(src)
  const size = data && imageSize(data)
  if (!data || !size || !size.width || !size.height) {
    ctx.warnings.missingImages++
    return null
  }
  const scale = Math.min(1, MAX_IMAGE_PX / size.width)
  return new ImageRun({
    type: size.type,
    data,
    transformation: { width: Math.round(size.width * scale), height: Math.round(size.height * scale) }
  })
}

/** 段落裡只有一個 $$…$$：獨立置中 */
function displayMath(node: PmNode, ctx: Ctx): Paragraph | null {
  const kids = node.content ?? []
  if (kids.length !== 1 || kids[0].type !== 'text' || kids[0].marks?.length) return null
  const t = (kids[0].text ?? '').trim()
  const spans = findMath(t)
  if (spans.length !== 1 || !spans[0].display || spans[0].from !== 0 || spans[0].to !== t.length) return null
  const tree = parseLatex(spans[0].tex)
  if (!tree) return null
  return new Paragraph({ alignment: AlignmentType.CENTER, children: [new DocMath({ children: mathNodes(tree) })] })
}

function blocks(nodes: PmNode[], ctx: Ctx, headingBase: number, indent = 0): (Paragraph | Table)[] {
  const out: (Paragraph | Table)[] = []
  const ind = indent ? { left: indent } : undefined
  for (const node of nodes) {
    const kids = node.content ?? []
    switch (node.type) {
      case 'paragraph':
        out.push(displayMath(node, ctx) ?? new Paragraph({ children: inline(kids, ctx), indent: ind }))
        break
      case 'heading':
        out.push(new Paragraph({ heading: heading(headingBase + Number(node.attrs?.level ?? 1)), children: inline(kids, ctx) }))
        break
      case 'blockquote':
        out.push(...blocksQuoted(kids, ctx, headingBase, indent))
        break
      case 'codeBlock':
        for (const line of kids.map((c) => c.text ?? '').join('').split('\n'))
          out.push(
            new Paragraph({
              indent: ind,
              shading: { type: ShadingType.CLEAR, fill: 'F2F2F2', color: 'auto' },
              spacing: { line: 240 },
              children: [new TextRun({ text: line, font: MONO, size: 20 })]
            })
          )
        break
      case 'horizontalRule':
        out.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun('＊　＊　＊')] }))
        break
      case 'image': {
        const img = imageRun(String(node.attrs?.src ?? ''), ctx)
        if (img) out.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [img] }))
        break
      }
      case 'bulletList':
      case 'orderedList':
        out.push(...list(node, ctx, headingBase, 0))
        break
      case 'taskList':
        for (const item of kids) {
          const [first, ...rest] = item.content ?? []
          const box = item.attrs?.checked ? '☑ ' : '☐ '
          out.push(new Paragraph({ indent: { left: indent + HALF_INCH / 2 }, children: [new TextRun(box), ...inline(first?.content, ctx)] }))
          out.push(...blocks(rest, ctx, headingBase, indent + HALF_INCH))
        }
        break
      case 'table':
        out.push(table(node, ctx))
        break
      default:
        if (kids.length) out.push(new Paragraph({ children: inline(kids, ctx), indent: ind }))
    }
  }
  return out
}

/** 引言裡的段落：左右各縮排 0.5 吋 */
function blocksQuoted(nodes: PmNode[], ctx: Ctx, headingBase: number, indent: number): (Paragraph | Table)[] {
  return nodes.flatMap((n): (Paragraph | Table)[] =>
    n.type === 'paragraph'
      ? [displayMath(n, ctx) ?? new Paragraph({ children: inline(n.content, ctx), indent: { left: indent + HALF_INCH, right: HALF_INCH } })]
      : blocks([n], ctx, headingBase, indent + HALF_INCH)
  )
}

function list(node: PmNode, ctx: Ctx, headingBase: number, level: number): Paragraph[] {
  const ordered = node.type === 'orderedList'
  const instance = ordered ? ++ctx.listInstance : 0
  const out: Paragraph[] = []
  for (const item of node.content ?? []) {
    const [first, ...rest] = item.content ?? []
    out.push(
      new Paragraph({
        numbering: { reference: ordered ? 'numbers' : 'bullets', level: Math.min(level, 8), instance: ordered ? instance : undefined },
        children: inline(first?.content, ctx)
      })
    )
    for (const r of rest) {
      if (r.type === 'bulletList' || r.type === 'orderedList') out.push(...list(r, ctx, headingBase, level + 1))
      else out.push(...(blocks([r], ctx, headingBase, (level + 1) * HALF_INCH) as Paragraph[]))
    }
  }
  return out
}

function table(node: PmNode, ctx: Ctx): Table {
  const border = { style: BorderStyle.SINGLE, size: 4, color: '808080' }
  const rows = (node.content ?? []).map(
    (row, r) =>
      new TableRow({
        tableHeader: r === 0,
        children: (row.content ?? []).map(
          (cell) =>
            new TableCell({
              borders: { top: border, bottom: border, left: border, right: border },
              children: (cell.content ?? []).map(
                (p) => new Paragraph({ children: inline(r === 0 || cell.type === 'tableHeader' ? bolded(p.content) : p.content, ctx) })
              )
            })
        )
      })
  )
  return new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } })
}

/** 表格標題列：文字加粗 */
const bolded = (nodes: PmNode[] | undefined): PmNode[] =>
  (nodes ?? []).map((n) => (n.type === 'text' ? { ...n, marks: [...(n.marks ?? []), { type: 'bold' }] } : n))

/** 參考文獻條目：HTML 裡的 <i> 變成斜體；同作者同年加 a／b */
function referenceParagraph(paper: Paper, suffix: string): Paragraph {
  let { html } = apaCitation(paper, paper.kind, paper.lang)
  if (suffix) {
    const year = (paper.date || paper.year).slice(0, 4) || (paper.lang === 'zh' ? '無日期' : 'n.d.')
    html = html.replace(paper.lang === 'zh' ? `（${year}` : `(${year}`, (m) => `${m}${suffix}`)
  }
  const decode = (s: string): string => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
  const children: TextRun[] = []
  for (const part of html.split(/(<i>.*?<\/i>)/)) {
    if (!part) continue
    const italic = part.startsWith('<i>')
    children.push(new TextRun({ text: decode(italic ? part.slice(3, -4) : part), italics: italic }))
  }
  return new Paragraph({ children, indent: { left: HALF_INCH, hanging: HALF_INCH } })
}

/** 產生 .docx；回傳檔案內容與要提醒使用者的事 */
export async function buildDocx(input: {
  sections: DocxSection[]
  papers: Paper[]
  readImage: (src: string) => Buffer | null
}): Promise<{ buffer: Buffer; warnings: DocxWarnings }> {
  const papers = new Map(input.papers.map((p) => [p.id, p]))
  // 先找出引用到哪些文獻，才能決定 a／b
  const citedIds = new Set<string>()
  const walk = (n: PmNode): void => {
    if (n.type === 'mention' && papers.has(String(n.attrs?.id))) citedIds.add(String(n.attrs?.id))
    n.content?.forEach(walk)
  }
  input.sections.forEach((s) => s.blocks.forEach(walk))
  const ordered = orderReferences([...citedIds].map((id) => papers.get(id)!))
  const ctx: Ctx = {
    papers,
    suffix: new Map(ordered.map((o) => [o.paper.id, o.suffix])),
    cited: new Set(),
    warnings: { missingCitations: 0, unconvertedMath: 0, missingImages: 0 },
    readImage: input.readImage,
    listInstance: 0
  }

  const body: (Paragraph | Table)[] = []
  for (const s of input.sections) {
    body.push(new Paragraph({ heading: heading(s.depth + 1), children: [new TextRun(s.title || '未命名')] }))
    body.push(...blocks(s.blocks, ctx, s.depth + 1))
  }
  if (ordered.length) {
    body.push(new Paragraph({ heading: heading(1), children: [new TextRun('參考文獻')] }))
    for (const { paper, suffix } of ordered) body.push(referenceParagraph(paper, suffix))
  }

  const headingStyle = (size: number) => ({ run: { font: FONT, size, bold: true, color: '000000' }, paragraph: { spacing: { before: 240, after: 120 } } })
  const levels = (format: (typeof LevelFormat)[keyof typeof LevelFormat], text: (i: number) => string) =>
    Array.from({ length: 9 }, (_, i) => ({
      level: i,
      format,
      text: text(i),
      alignment: AlignmentType.LEFT,
      style: { paragraph: { indent: { left: HALF_INCH * (i + 1), hanging: 360 } } }
    }))

  const doc = new Document({
    creator: 'Research Desk',
    styles: {
      default: {
        document: { run: { font: FONT, size: 24 }, paragraph: { spacing: { line: 360 } } },
        heading1: headingStyle(32),
        heading2: headingStyle(28),
        heading3: headingStyle(26),
        heading4: headingStyle(24),
        heading5: headingStyle(24),
        heading6: headingStyle(24)
      }
    },
    numbering: {
      config: [
        { reference: 'bullets', levels: levels(LevelFormat.BULLET, (i) => ['•', '◦', '▪'][i % 3]) },
        { reference: 'numbers', levels: levels(LevelFormat.DECIMAL, (i) => `%${i + 1}.`) }
      ]
    },
    sections: [
      {
        properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } } },
        children: body
      }
    ]
  })
  return { buffer: await Packer.toBuffer(doc), warnings: ctx.warnings }
}
