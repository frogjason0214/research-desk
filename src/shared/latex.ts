// LaTeX 公式（論文常用的子集）解析成樹，匯出 Word 時再轉成原生方程式。
// 支援：分數、上下標、根號、Σ／∏／∫（含上下限）、上橫線與帽子等重音、希臘字母、常用運算與關係符號、
// \left( \right)、\text{}、log 等函數名。不認得的指令讓整個公式失敗，由呼叫端保留原文。

export type MathNode =
  | { t: 'run'; text: string; upright?: boolean }
  | { t: 'frac'; num: MathNode[]; den: MathNode[] }
  | { t: 'sup'; base: MathNode[]; sup: MathNode[] }
  | { t: 'sub'; base: MathNode[]; sub: MathNode[] }
  | { t: 'subsup'; base: MathNode[]; sub: MathNode[]; sup: MathNode[] }
  | { t: 'sqrt'; body: MathNode[]; degree?: MathNode[] }
  | { t: 'nary'; op: 'sum' | 'prod' | 'int'; sub?: MathNode[]; sup?: MathNode[]; body: MathNode[] }
  | { t: 'accent'; char: string; body: MathNode[] }
  | { t: 'paren'; open: string; close: string; body: MathNode[] }

const SYMBOLS: Record<string, string> = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ϵ', varepsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ',
  iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', varpi: 'ϖ', rho: 'ρ', varrho: 'ϱ', sigma: 'σ',
  varsigma: 'ς', tau: 'τ', upsilon: 'υ', phi: 'ϕ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  times: '×', cdot: '⋅', div: '÷', pm: '±', mp: '∓', ast: '∗', star: '⋆', circ: '∘', bullet: '∙',
  le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠', approx: '≈', sim: '∼', simeq: '≃', equiv: '≡', propto: '∝',
  lt: '<', gt: '>', ll: '≪', gg: '≫', in: '∈', notin: '∉', subset: '⊂', subseteq: '⊆', cup: '∪', cap: '∩',
  infty: '∞', partial: '∂', nabla: '∇', forall: '∀', exists: '∃', neg: '¬', land: '∧', lor: '∨',
  to: '→', rightarrow: '→', leftarrow: '←', Rightarrow: '⇒', Leftarrow: '⇐', leftrightarrow: '↔', Leftrightarrow: '⇔',
  ldots: '…', cdots: '⋯', dots: '…', vdots: '⋮', mid: '|', prime: '′', angle: '∠', degree: '°',
  '%': '%', '$': '$', '#': '#', '&': '&', _: '_', '{': '{', '}': '}', ',': ' ', ';': ' ', ':': ' ', '!': '', quad: '  ', qquad: '    ', ' ': ' '
}
const FUNCTIONS = new Set(['log', 'ln', 'exp', 'sin', 'cos', 'tan', 'max', 'min', 'lim', 'Pr', 'det', 'var', 'cov', 'arg', 'sup', 'inf'])
const ACCENTS: Record<string, string> = { bar: '\u0304', overline: '\u0305', hat: '\u0302', widehat: '\u0302', tilde: '\u0303', widetilde: '\u0303', vec: '\u20d7', dot: '\u0307', ddot: '\u0308' }
const TEXT_CMDS = new Set(['text', 'mathrm', 'textrm', 'operatorname', 'mathit', 'mathbf', 'textbf', 'mathsf'])
const NARY: Record<string, 'sum' | 'prod' | 'int'> = { sum: 'sum', prod: 'prod', int: 'int' }
const FRACS = new Set(['frac', 'dfrac', 'tfrac'])
const DELIMS: Record<string, string> = { '(': '(', ')': ')', '[': '[', ']': ']', '\\{': '{', '\\}': '}', '|': '|', '.': '', '\\langle': '⟨', '\\rangle': '⟩', '\\|': '‖' }

class Fail extends Error {}

type Tok = { k: 'cmd'; v: string } | { k: 'ch'; v: string }

function tokenize(src: string): Tok[] {
  const out: Tok[] = []
  for (let i = 0; i < src.length; ) {
    const c = src[i]
    if (c === '\\') {
      const m = /^\\([A-Za-z]+|.)/.exec(src.slice(i))
      if (!m) throw new Fail()
      out.push({ k: 'cmd', v: m[1] })
      i += m[0].length
    } else {
      out.push({ k: 'ch', v: c })
      i++
    }
  }
  return out
}

/** 解析整個公式；不支援的寫法回傳 null */
export function parseLatex(src: string): MathNode[] | null {
  try {
    const toks = tokenize(src)
    let i = 0
    const peek = (): Tok | undefined => toks[i]
    const skipSpace = (): void => {
      while (peek()?.k === 'ch' && /\s/.test(peek()!.v)) i++
    }

    // 一個「單位」：{…}、一個字、一個指令（含它的參數）
    const atom = (): MathNode[] => {
      skipSpace()
      const tok = toks[i++]
      if (!tok) throw new Fail()
      if (tok.k === 'ch') {
        if (tok.v === '{') {
          const body = list('}')
          i++ // }
          return body
        }
        if (tok.v === '}' || tok.v === '^' || tok.v === '_' || tok.v === '&') throw new Fail()
        if (/[0-9]/.test(tok.v)) {
          // 連續的數字當一個單位（12.5）
          let num = tok.v
          while (peek()?.k === 'ch' && /[0-9.]/.test(peek()!.v)) num += toks[i++].v
          return [{ t: 'run', text: num }]
        }
        return [{ t: 'run', text: tok.v }]
      }
      const name = tok.v
      if (FRACS.has(name)) return [{ t: 'frac', num: atom(), den: atom() }]
      if (name === 'sqrt') {
        skipSpace()
        let degree: MathNode[] | undefined
        if (peek()?.k === 'ch' && peek()!.v === '[') {
          i++
          degree = list(']')
          i++
        }
        return [{ t: 'sqrt', body: atom(), degree }]
      }
      if (ACCENTS[name]) return [{ t: 'accent', char: ACCENTS[name], body: atom() }]
      if (TEXT_CMDS.has(name)) {
        skipSpace()
        if (peek()?.k !== 'ch' || peek()!.v !== '{') throw new Fail()
        i++
        let text = ''
        let depth = 0
        for (;;) {
          const t = toks[i++]
          if (!t) throw new Fail()
          if (t.k === 'ch' && t.v === '{') depth++
          if (t.k === 'ch' && t.v === '}') {
            if (depth === 0) break
            depth--
          }
          text += t.k === 'cmd' ? (SYMBOLS[t.v] ?? '') : t.v
        }
        return [{ t: 'run', text, upright: true }]
      }
      if (FUNCTIONS.has(name)) return [{ t: 'run', text: name, upright: true }]
      if (NARY[name]) {
        const { sub, sup } = scripts()
        skipSpace()
        const body = peek() && !(peek()!.k === 'ch' && peek()!.v === '}') ? withScripts(atom()) : []
        return [{ t: 'nary', op: NARY[name], sub, sup, body }]
      }
      if (name === 'left') {
        const open = delim()
        const body = list('\\right')
        i++ // \right
        const close = delim()
        return [{ t: 'paren', open, close, body }]
      }
      if (name in SYMBOLS) return SYMBOLS[name] ? [{ t: 'run', text: SYMBOLS[name] }] : []
      throw new Fail()
    }

    const delim = (): string => {
      skipSpace()
      const t = toks[i++]
      if (!t) throw new Fail()
      const key = t.k === 'cmd' ? `\\${t.v}` : t.v
      if (!(key in DELIMS)) throw new Fail()
      return DELIMS[key]
    }

    const scripts = (): { sub?: MathNode[]; sup?: MathNode[] } => {
      let sub: MathNode[] | undefined
      let sup: MathNode[] | undefined
      for (;;) {
        skipSpace()
        const t = peek()
        if (t?.k === 'ch' && t.v === '_' && !sub) {
          i++
          sub = atom()
        } else if (t?.k === 'ch' && t.v === '^' && !sup) {
          i++
          sup = atom()
        } else if (t?.k === 'cmd' && t.v === 'limits') i++
        else break
      }
      return { sub, sup }
    }

    const withScripts = (base: MathNode[]): MathNode[] => {
      const { sub, sup } = scripts()
      if (sub && sup) return [{ t: 'subsup', base, sub, sup }]
      if (sub) return [{ t: 'sub', base, sub }]
      if (sup) return [{ t: 'sup', base, sup }]
      return base
    }

    const list = (end: string | null): MathNode[] => {
      const out: MathNode[] = []
      for (;;) {
        skipSpace()
        const t = peek()
        if (!t) {
          if (end !== null) throw new Fail()
          return out
        }
        if (end && ((t.k === 'ch' && t.v === end) || (t.k === 'cmd' && `\\${t.v}` === end))) return out
        out.push(...withScripts(atom()))
      }
    }

    const nodes = list(null)
    return merge(nodes)
  } catch (err) {
    if (err instanceof Fail) return null
    throw err
  }
}

/** 相鄰的一般文字接成一段（Word 裡比較好編輯） */
function merge(nodes: MathNode[]): MathNode[] {
  const out: MathNode[] = []
  for (const n of nodes) {
    const last = out[out.length - 1]
    if (n.t === 'run' && last?.t === 'run' && !n.upright && !last.upright) last.text += n.text
    else out.push(n.t === 'run' ? { ...n } : n)
  }
  return out
}
