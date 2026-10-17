import { randomUUID } from 'node:crypto'
import type {
  AiStream,
  ChatMessage,
  Conversation,
  DailyTip,
  ProfessorRole,
  Recommendation,
  Source
} from '../../shared/types'
import { ROLE_LABELS } from '../../shared/types'
import type { Store } from '../store'
import { buildContext, systemPrompt, usedSources, type SearchFn } from './context'
import type { Gemini, Turn } from './gemini'
import { searchWorks, type Work } from './openalex'

// AI 教授：專案對話（多個對話、各有角色）、每日建議、推薦新文獻。

const HISTORY_TURNS = 16
const DAILY_ROLES: ProfessorRole[] = ['direction', 'methods', 'committee']

const now = (): string => new Date().toISOString()
const pad = (n: number): string => String(n).padStart(2, '0')
const today = (): string => {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

type Row<T> = Omit<T, 'sources'> & { sources: string | null }
const parseSources = (json: string | null): Source[] => {
  try {
    return JSON.parse(json ?? '[]')
  } catch {
    return []
  }
}

export function createProfessor(opts: {
  store: Store
  gemini: Gemini
  search: SearchFn
  openAlexKey: () => string | undefined
  dailyEnabled: () => boolean
  emit: (s: AiStream) => void
}) {
  const { store, gemini } = opts
  const streaming = new Set<string>()
  const generatingDaily = new Map<string, Promise<DailyTip | null>>()

  const conversation = (id: string): Conversation | undefined =>
    store.get<Conversation>('SELECT * FROM conversations WHERE id = ?', [id])

  const messagesOf = (conversationId: string): ChatMessage[] =>
    store
      .all<Row<ChatMessage>>('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at', [conversationId])
      .map((m) => ({ ...m, sources: parseSources(m.sources) }))

  const addMessage = (conversationId: string, role: 'user' | 'model', text: string, sources: Source[] = []): void => {
    const at = now()
    store.write((tx) => {
      tx.set('messages', randomUUID(), { conversation_id: conversationId, role, text, sources: JSON.stringify(sources), created_at: at })
      tx.set('conversations', conversationId, { updated_at: at })
    })
  }

  /**
   * 找相關全文段落用的查詢：使用者的問題、上一則回答的開頭，再加上 AI 整理的中英文關鍵字。
   * 使用者常用中文問、文獻卻是英文，只用原句做關鍵字搜尋會找不到。
   */
  const queryFor = async (history: ChatMessage[], text: string): Promise<string> => {
    const lastModel = [...history].reverse().find((m) => m.role === 'model')
    const base = `${text} ${lastModel?.text.slice(0, 300) ?? ''}`
    try {
      const { keywords } = await gemini.json<{ keywords: string[] }>(
        [{ text: `把下面這段研究相關的問題整理成搜尋學術文獻全文用的關鍵字：英文 4～8 個、繁體中文 2～4 個（學術用語、量表或統計名稱）。\n\n${base.slice(0, 1500)}` }],
        { type: 'OBJECT', properties: { keywords: { type: 'ARRAY', items: { type: 'STRING' } } }, required: ['keywords'] }
      )
      return `${base} ${(keywords ?? []).join(' ')}`
    } catch {
      return base
    }
  }

  const createConversation = (projectId: string, role: ProfessorRole, title = ''): Conversation => {
    const c: Conversation = { id: randomUUID(), project_id: projectId, title, role, created_at: now(), updated_at: now() }
    store.write((tx) =>
      tx.set('conversations', c.id, { project_id: projectId, title, role, created_at: c.created_at, updated_at: c.updated_at })
    )
    return c
  }

  async function generateDaily(projectId: string): Promise<DailyTip | null> {
    const date = today()
    const id = `${projectId}:${date}`
    const existing = store.get<Row<DailyTip>>('SELECT * FROM daily_tips WHERE id = ?', [id])
    if (existing) return { ...existing, sources: parseSources(existing.sources) }
    if (!gemini.hasKey || !opts.dailyEnabled()) return null

    // 三種角色每天輪流
    const dayNumber = Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 86_400_000)
    const role = DAILY_ROLES[dayNumber % DAILY_ROLES.length]
    const recent = store.all<{ title: string }>('SELECT title FROM papers WHERE project_id = ? AND no_ai = 0 ORDER BY added_at DESC LIMIT 5', [projectId])
    const ctx = buildContext(store, opts.search, projectId, recent.map((p) => p.title).join(' '))
    const text = await gemini.stream(
      [
        {
          role: 'user',
          parts: [
            {
              text: `請以「${ROLE_LABELS[role]}」的角度，給我今天的一則建議：約 120～200 字，具體到可以今天就開始想或動手，最後提出一個值得思考的問題。不要開場白。`
            }
          ]
        }
      ],
      systemPrompt(role, ctx.text),
      () => {},
      0.9
    )
    const sources = usedSources(text, ctx.sources)
    store.write((tx) =>
      tx.set('daily_tips', id, { project_id: projectId, date, role, text, sources: JSON.stringify(sources), created_at: now() })
    )
    return { date, role, text, sources }
  }

  return {
    handlers: {
      'professor.conversations': (projectId: string): Conversation[] =>
        store.all<Conversation>('SELECT * FROM conversations WHERE project_id = ? ORDER BY updated_at DESC', [projectId]),

      'professor.create': (projectId: string, role: ProfessorRole): Conversation => createConversation(projectId, role),

      'professor.rename': (id: string, title: string): void =>
        store.write((tx) => tx.set('conversations', id, { title: title.trim() })),

      'professor.remove': (id: string): void => {
        const ids = store.all<{ id: string }>('SELECT id FROM messages WHERE conversation_id = ?', [id])
        store.write((tx) => {
          ids.forEach((m) => tx.remove('messages', m.id))
          tx.remove('conversations', id)
        })
      },

      'professor.messages': messagesOf,

      /** 送出訊息；回覆以 ai:stream 事件逐步傳給畫面，完成後存進對話紀錄 */
      'professor.send': async (conversationId: string, text: string): Promise<void> => {
        const content = text.trim()
        if (!content) return
        if (!gemini.hasKey) throw new Error('尚未設定 Gemini API 金鑰，請到「設定」填入。')
        const conv = conversation(conversationId)
        if (!conv) throw new Error('找不到這個對話')
        if (streaming.has(conversationId)) throw new Error('上一則回覆還在產生中')

        const history = messagesOf(conversationId)
        addMessage(conversationId, 'user', content)
        if (!conv.title) store.write((tx) => tx.set('conversations', conversationId, { title: content.slice(0, 30) }))

        const ctx = buildContext(store, opts.search, conv.project_id, await queryFor(history, content))
        const turns: Turn[] = [...history.slice(-HISTORY_TURNS), { role: 'user' as const, text: content }].map((m) => ({
          role: m.role,
          parts: [{ text: m.text }]
        }))
        // Gemini 要求第一則是使用者；從每日建議開始的對話第一則是 AI，前面補一句
        if (turns[0]?.role === 'model') turns.unshift({ role: 'user', parts: [{ text: '請給我今天的建議。' }] })

        streaming.add(conversationId)
        try {
          const answer = await gemini.stream(turns, systemPrompt(conv.role, ctx.text), (partial) =>
            opts.emit({ conversationId, text: partial, done: false })
          )
          addMessage(conversationId, 'model', answer, usedSources(answer, ctx.sources))
        } finally {
          streaming.delete(conversationId)
          opts.emit({ conversationId, text: '', done: true })
        }
      },

      /** 今天的建議（沒有就產生）；同一時間只產生一次 */
      'professor.daily': (projectId: string): Promise<DailyTip | null> => {
        let p = generatingDaily.get(projectId)
        if (!p) {
          p = generateDaily(projectId).finally(() => generatingDaily.delete(projectId))
          generatingDaily.set(projectId, p)
        }
        return p
      },

      /** 從每日建議開一個對話，第一則是那則建議 */
      'professor.startFromTip': (projectId: string): string => {
        const tip = store.get<Row<DailyTip>>('SELECT * FROM daily_tips WHERE id = ?', [`${projectId}:${today()}`])
        if (!tip) throw new Error('今天還沒有建議')
        const c = createConversation(projectId, tip.role, `${tip.date} 每日建議`)
        addMessage(c.id, 'model', tip.text, parseSources(tip.sources))
        return c.id
      },

      /**
       * 推薦新文獻：AI 依專案內容產生搜尋關鍵字 → OpenAlex 查真實論文 → AI 只從查到的結果挑選並說明理由
       */
      'professor.recommend': async (projectId: string): Promise<Recommendation[]> => {
        if (!gemini.hasKey) throw new Error('尚未設定 Gemini API 金鑰，請到「設定」填入。')
        const ctx = buildContext(store, opts.search, projectId, '')
        const { queries } = await gemini.json<{ queries: string[] }>(
          [{ text: `根據以下研究專案內容，產生 3 個用來在英文學術資料庫搜尋新文獻的關鍵字查詢（英文，每個 3～8 個字），涵蓋不同面向。\n\n${ctx.text}` }],
          { type: 'OBJECT', properties: { queries: { type: 'ARRAY', items: { type: 'STRING' } } }, required: ['queries'] }
        )

        const have = new Set(
          store
            .all<{ doi: string }>(`SELECT doi FROM papers WHERE project_id = ? AND doi != ''`, [projectId])
            .map((p) => p.doi.toLowerCase())
        )
        const seen = new Set<string>()
        const works: Work[] = []
        for (const q of (queries ?? []).slice(0, 4)) {
          for (const w of await searchWorks(q, opts.openAlexKey(), 8)) {
            const key = w.doi.toLowerCase()
            if (seen.has(key) || have.has(key)) continue
            seen.add(key)
            works.push(w)
          }
        }
        if (works.length === 0) return []
        const candidates = works.slice(0, 24)

        const { picks } = await gemini.json<{ picks: { index: number; reason: string }[] }>(
          [
            {
              text: `以下是資料庫查到的論文（編號 0 起）。請從中挑出最多 8 篇對這個研究專案最有幫助的，用繁體中文（台灣用語）各寫一句推薦理由，說明它和專案的關係。只能從清單裡挑，不要加入清單以外的論文。\n\n# 專案\n${ctx.text.slice(0, 6000)}\n\n# 候選論文\n${candidates
                .map((w, i) => `${i}. ${w.title}（${w.year}，${w.venue}，被引用 ${w.citedBy} 次）\n摘要：${w.abstract.slice(0, 500)}`)
                .join('\n')}`
            }
          ],
          {
            type: 'OBJECT',
            properties: {
              picks: {
                type: 'ARRAY',
                items: {
                  type: 'OBJECT',
                  properties: { index: { type: 'INTEGER' }, reason: { type: 'STRING' } },
                  required: ['index', 'reason']
                }
              }
            },
            required: ['picks']
          }
        )

        // 只接受指向清單內的編號
        const result: Recommendation[] = []
        const used = new Set<number>()
        for (const p of picks ?? []) {
          const w = candidates[p.index]
          if (!w || used.has(p.index)) continue
          used.add(p.index)
          result.push({ ...w, url: `https://doi.org/${w.doi}`, reason: p.reason, inLibrary: false })
          if (result.length >= 8) break
        }
        return result
      }
    }
  }
}
