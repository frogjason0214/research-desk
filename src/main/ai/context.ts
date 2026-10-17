import type { Milestone, MindNode, ProfessorRole, Source, Task } from '../../shared/types'
import type { Store } from '../store'

// 整理給 AI 教授看的專案內容。勾選「不送 AI」的文獻（含全文與筆記）、勾選「筆記不送 AI」的筆記都不會放進來。
// 每一筆文獻標 [P1]、每一段全文標 [S1]，AI 回答時用這些標記引用，畫面再把標記變成可點的來源。

const MAX_PAPERS = 60
const MAX_NODES = 150
const MAX_CHUNKS = 8
const FIELD_CHARS = 300

export interface ChunkHit {
  page: number
  text: string
  paper: { id: string; title: string; year: string }
}

export type SearchFn = (projectId: string, query: string, limit: number) => { item: ChunkHit }[]

interface PaperRow {
  id: string
  title: string
  year: string
  authors: string
  journal: string
  study_type: string
  sample: string
  measures: string
  findings: string
  notes: string
  notes_no_ai: number
}

const clip = (s: string | null | undefined, n = FIELD_CHARS): string => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

function authorNames(json: string): string {
  try {
    const list = JSON.parse(json || '[]') as { family: string; given: string }[]
    const names = list.map((a) => a.family || a.given).filter(Boolean)
    return names.length > 3 ? `${names.slice(0, 3).join(', ')} 等` : names.join(', ')
  } catch {
    return ''
  }
}

export interface ProjectContext {
  text: string
  sources: Source[]
}

export function buildContext(store: Store, search: SearchFn, projectId: string, query: string): ProjectContext {
  const project = store.get<{ name: string }>('SELECT name FROM projects WHERE id = ?', [projectId])
  const out: string[] = [`## 研究專案：${project?.name ?? ''}`]
  const sources: Source[] = []

  // 里程碑
  const milestones = store.all<Milestone>('SELECT * FROM milestones WHERE project_id = ? ORDER BY sort', [projectId])
  if (milestones.length) {
    out.push('## 論文里程碑')
    for (const m of milestones)
      out.push(`- [${m.done ? 'x' : ' '}] ${m.title}${m.due_date ? `（預計 ${m.due_date}）` : ''}${m.is_defense ? '（學位口試）' : ''}`)
  }

  // 未完成待辦
  const tasks = store.all<Task>(
    'SELECT * FROM tasks WHERE project_id = ? AND done = 0 ORDER BY due_date IS NULL, due_date LIMIT 20',
    [projectId]
  )
  if (tasks.length) {
    out.push('## 未完成待辦')
    for (const t of tasks) out.push(`- ${t.title}${t.due_date ? `（${t.due_date}）` : ''}`)
  }

  // 心智圖：縮排大綱
  const maps = store.all<{ id: string; name: string }>('SELECT id, name FROM mindmaps WHERE project_id = ? ORDER BY created_at', [projectId])
  let nodeBudget = MAX_NODES
  for (const map of maps) {
    const nodes = store.all<MindNode>('SELECT * FROM mm_nodes WHERE map_id = ? ORDER BY y', [map.id])
    const root = nodes.find((n) => !n.parent_id)
    if (!root || nodeBudget <= 0) continue
    out.push(`## 心智圖「${map.name}」`)
    const walk = (node: MindNode, depth: number): void => {
      if (nodeBudget-- <= 0) return
      out.push(`${'  '.repeat(depth)}- ${node.text}`)
      nodes.filter((n) => n.parent_id === node.id).forEach((c) => walk(c, depth + 1))
    }
    walk(root, 0)
  }

  // 文獻庫概要
  const papers = store.all<PaperRow>(
    `SELECT id, title, year, authors, journal, study_type, sample, measures, findings, notes, notes_no_ai
     FROM papers WHERE project_id = ? AND no_ai = 0 ORDER BY added_at DESC LIMIT ?`,
    [projectId, MAX_PAPERS]
  )
  if (papers.length) {
    out.push('## 文獻庫（引用時用 [P編號]）')
    papers.forEach((p, i) => {
      const key = `P${i + 1}`
      sources.push({ key, paperId: p.id, title: p.title, year: p.year ?? '', page: 0 })
      const parts = [
        `[${key}] ${p.title || '（沒有標題）'}（${p.year || '無年份'}）${authorNames(p.authors)}${p.journal ? `，${p.journal}` : ''}`,
        p.study_type && `研究類型：${p.study_type}`,
        p.sample && `樣本：${clip(p.sample)}`,
        p.measures && `量表：${clip(p.measures)}`,
        p.findings && `主要發現：${clip(p.findings, 500)}`,
        !p.notes_no_ai && p.notes && `使用者筆記：${clip(p.notes, 500)}`
      ].filter(Boolean)
      out.push(parts.join('\n  '))
    })
  }

  // 與問題最相關的全文段落
  const hits = query.trim() ? search(projectId, query, MAX_CHUNKS) : []
  if (hits.length) {
    out.push('## 相關全文段落（引用時用 [S編號]）')
    hits.forEach(({ item }, i) => {
      const key = `S${i + 1}`
      sources.push({ key, paperId: item.paper.id, title: item.paper.title, year: item.paper.year, page: item.page })
      out.push(`[${key}] 《${item.paper.title}》（${item.paper.year || '無年份'}）${item.page ? `第 ${item.page} 頁` : ''}：\n${item.text}`)
    })
  }

  return { text: out.join('\n'), sources }
}

const BASE = `你是一位心理學研究所的學術導師，同時也擔任學位口試委員。你的工作是幫研究生把研究想清楚：研究方向、研究方法與統計、挑戰論點。你不負責催進度。

規則：
- 使用繁體中文（台灣用語）；專有名詞、量表名稱、統計方法可保留英文。
- 根據下方的「專案內容」回答。引用專案裡的文獻時，在句尾標註來源標記，例如 [P3] 或 [S2]，只能使用下方出現過的標記。
- 不要提到下方文獻庫以外的具體論文（作者、年份、篇名都不行），因為你可能記錯。如果需要新文獻，請建議使用者使用「推薦新文獻」功能，它只會列出資料庫查得到的真實論文。
- 不確定或資料不足時直接說明，並指出需要補充什麼。
- 回答精簡、有結構，可以用條列；必要時反問一個關鍵問題。`

const ROLE_PROMPTS: Record<ProfessorRole, string> = {
  direction: '這次的角色：研究方向與缺口。根據文獻庫與心智圖，指出尚未被研究的問題、相互矛盾的發現、可以延伸的方向，並評估可行性。',
  methods: '這次的角色：研究方法與統計。針對研究設計、取樣、量表的信效度、統計分析方法、檢定力與前提假設給具體建議，指出可能的威脅與替代做法。',
  committee:
    '這次的角色：模擬口試委員。對使用者的研究與論點提出尖銳但合理的質疑，一次只問一到兩個問題，等使用者回答後再追問或指出回答的不足。不要直接給標準答案，最後才總結使用者可以加強的地方。',
  general: '這次是一般討論，依使用者的問題給予學術上的建議。'
}

export function systemPrompt(role: ProfessorRole, context: string): string {
  return `${BASE}\n\n${ROLE_PROMPTS[role]}\n\n# 專案內容\n${context}`
}

/** 只保留回答裡真的引用到的來源 */
export function usedSources(text: string, sources: Source[]): Source[] {
  const used = new Set<string>()
  // [P1]、[S2]，也接受合併寫法 [P1, S2]
  for (const m of text.matchAll(/\[([PS]\d+(?:\s*[,，、]\s*[PS]\d+)*)\]/g)) m[1].split(/\s*[,，、]\s*/).forEach((k) => used.add(k))
  return sources.filter((s) => used.has(s.key))
}
