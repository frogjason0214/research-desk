import { Trash2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ROLE_LABELS,
  type ChatMessage,
  type Conversation,
  type Focus,
  type ProfessorRole,
  type Recommendation
} from '../../../shared/types'
import { AiMarkdown, SourceList } from '../components/AiMarkdown'
import { EditableTitle } from '../components/EditableTitle'
import { IconButton } from '../components/IconButton'
import { desk } from '../useDesk'

type Run = (fn: () => Promise<unknown>) => Promise<void>
type Selection = { kind: 'conversation'; id: string } | { kind: 'new' } | { kind: 'recommend' }

const ROLE_HINTS: Record<ProfessorRole, string> = {
  direction: '根據文獻庫與心智圖，找出還沒被研究的問題與可延伸的方向',
  methods: '研究設計、量表、統計分析、檢定力與前提假設',
  committee: '模擬口試：提出質疑、追問，練習回應',
  general: '任何研究上的問題'
}

export function ProfessorView({
  projectId,
  run,
  focusConversationId,
  onNavigate
}: {
  projectId: string
  run: Run
  focusConversationId: string | null
  onNavigate: (f: Focus) => void
}) {
  const [hasKey, setHasKey] = useState<boolean | null>(null)
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [sel, setSel] = useState<Selection>(focusConversationId ? { kind: 'conversation', id: focusConversationId } : { kind: 'new' })

  const load = useCallback(() => {
    desk.ai.status().then((s) => setHasKey(s.hasKey))
    desk.professor.conversations(projectId).then(setConversations)
  }, [projectId])
  useEffect(() => {
    load()
    return desk.onChanged(load)
  }, [load])
  useEffect(() => {
    if (focusConversationId) setSel({ kind: 'conversation', id: focusConversationId })
  }, [focusConversationId])

  if (hasKey === false) {
    return (
      <div className="empty-card">
        <h3>AI 教授需要 Gemini 金鑰</h3>
        <p className="muted">請到專案的「設定」分頁，在「AI（Gemini）」填入自己的 API 金鑰。勾選「不送 AI」的文獻與筆記永遠不會送出。</p>
      </div>
    )
  }

  const current = sel.kind === 'conversation' ? conversations.find((c) => c.id === sel.id) : undefined

  return (
    <div className="prof">
      <aside className="prof-list">
        <button className={`btn${sel.kind === 'new' ? ' btn-primary' : ''}`} onClick={() => setSel({ kind: 'new' })}>
          ＋ 新對話
        </button>
        <button className={`lit-item${sel.kind === 'recommend' ? ' is-active' : ''}`} onClick={() => setSel({ kind: 'recommend' })}>
          <span className="lit-item-title">推薦新文獻</span>
          <span className="lit-item-meta">只列出資料庫查得到的真實論文</span>
        </button>
        <h4 className="nav-heading">對話</h4>
        {conversations.length === 0 && <p className="muted">還沒有對話。</p>}
        <ul className="lit-items">
          {conversations.map((c) => (
            <li key={c.id}>
              <button
                className={`lit-item${sel.kind === 'conversation' && sel.id === c.id ? ' is-active' : ''}`}
                onClick={() => setSel({ kind: 'conversation', id: c.id })}
              >
                <span className="lit-item-title">{c.title || '（新對話）'}</span>
                <span className="lit-item-meta">
                  {ROLE_LABELS[c.role]}・{new Date(c.updated_at).toLocaleDateString('zh-TW')}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <section className="prof-main">
        {sel.kind === 'new' && (
          <NewConversation
            onCreate={(role) =>
              run(async () => {
                const c = await desk.professor.create(projectId, role)
                setSel({ kind: 'conversation', id: c.id })
              })
            }
          />
        )}
        {sel.kind === 'recommend' && <Recommendations projectId={projectId} run={run} onNavigate={onNavigate} />}
        {current && (
          <Chat
            key={current.id}
            conversation={current}
            run={run}
            onNavigate={onNavigate}
            onDeleted={() => setSel({ kind: 'new' })}
          />
        )}
      </section>
    </div>
  )
}

function NewConversation({ onCreate }: { onCreate: (role: ProfessorRole) => void }) {
  return (
    <div className="prof-new">
      <h3>要跟 AI 教授討論什麼？</h3>
      <p className="muted">AI 教授會讀這個專案的文獻（全文、欄位、筆記）、心智圖、待辦與里程碑；勾選「不送 AI」的內容不會送出。</p>
      <div className="role-grid">
        {(Object.keys(ROLE_LABELS) as ProfessorRole[]).map((r) => (
          <button key={r} className="role-card" onClick={() => onCreate(r)}>
            <strong>{ROLE_LABELS[r]}</strong>
            <span>{ROLE_HINTS[r]}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

function Chat({
  conversation,
  run,
  onNavigate,
  onDeleted
}: {
  conversation: Conversation
  run: Run
  onNavigate: (f: Focus) => void
  onDeleted: () => void
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')
  // 送出後、存進紀錄前先顯示的使用者訊息
  const [pending, setPending] = useState<{ text: string; at: number } | null>(null)
  const [streamText, setStreamText] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const bottom = useRef<HTMLDivElement>(null)

  const load = useCallback(() => desk.professor.messages(conversation.id).then(setMessages), [conversation.id])
  useEffect(() => {
    load()
    return desk.onChanged(load)
  }, [load])

  useEffect(
    () =>
      desk.onAiStream((s) => {
        if (s.conversationId !== conversation.id) return
        setStreamText(s.done ? null : s.text)
      }),
    [conversation.id]
  )

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' })
  }, [messages, streamText, pending])

  const busy = pending !== null || streamText !== null
  const send = (): void => {
    const text = draft.trim()
    if (!text || busy) return
    setDraft('')
    setPending({ text, at: Date.now() - 1000 })
    run(async () => {
      try {
        await desk.professor.send(conversation.id, text)
        await load()
      } finally {
        setPending(null)
        setStreamText(null)
      }
    })
  }

  // 訊息已存進紀錄就不再另外顯示
  const showPending = pending !== null && !messages.some((m) => m.role === 'user' && new Date(m.created_at).getTime() >= pending.at)

  return (
    <div className="chat">
      <header className="chat-head">
        <EditableTitle
          value={conversation.title || '（新對話）'}
          label="對話名稱"
          onSave={(title) => run(() => desk.professor.rename(conversation.id, title))}
        />
        <span className="badge">{ROLE_LABELS[conversation.role]}</span>
        <span className="spacer" />
        {confirmDelete && <span className="muted">再按一次垃圾桶就會刪除這個對話</span>}
        <IconButton
          icon={Trash2}
          label={confirmDelete ? '再按一次刪除這個對話' : '刪除對話'}
          danger
          active={confirmDelete}
          onClick={() => (confirmDelete ? run(async () => { await desk.professor.remove(conversation.id); onDeleted() }) : setConfirmDelete(true))}
        />
      </header>

      <div className="chat-log">
        {messages.length === 0 && !pending && (
          <p className="muted chat-empty">
            {conversation.role === 'committee'
              ? '先用幾句話說明你的研究問題與主要論點，口試委員會開始提問。'
              : '輸入你的問題。可以問研究方向、方法、統計，或請它針對某篇文獻討論。'}
          </p>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`msg is-${m.role}`}>
            {m.role === 'model' ? (
              <>
                <AiMarkdown text={m.text} sources={m.sources} onNavigate={onNavigate} />
                <SourceList sources={m.sources} onNavigate={onNavigate} />
              </>
            ) : (
              <p className="msg-text">{m.text}</p>
            )}
          </div>
        ))}
        {showPending && (
          <div className="msg is-user">
            <p className="msg-text">{pending?.text}</p>
          </div>
        )}
        {busy && (
          <div className="msg is-model">
            {streamText ? <AiMarkdown text={streamText} sources={[]} onNavigate={onNavigate} /> : <p className="muted">思考中…</p>}
          </div>
        )}
        <div ref={bottom} />
      </div>

      <form
        className="chat-input"
        onSubmit={(e) => {
          e.preventDefault()
          send()
        }}
      >
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Enter 送出、Shift+Enter 換行；注音輸入選字時的 Enter 不算
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              send()
            }
          }}
          rows={3}
          placeholder="輸入訊息（Enter 送出，Shift+Enter 換行）"
          aria-label="訊息"
        />
        <button className="btn btn-primary" type="submit" disabled={!draft.trim() || busy}>
          送出
        </button>
      </form>
    </div>
  )
}

function Recommendations({ projectId, run, onNavigate }: { projectId: string; run: Run; onNavigate: (f: Focus) => void }) {
  const [items, setItems] = useState<Recommendation[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [added, setAdded] = useState<Record<string, string>>({})

  const search = (): Promise<void> =>
    run(async () => {
      setLoading(true)
      try {
        setItems(await desk.professor.recommend(projectId))
      } finally {
        setLoading(false)
      }
    })

  return (
    <div className="recs">
      <div className="section-head">
        <h3>推薦新文獻</h3>
        <span className="spacer" />
        <button className="btn btn-primary" onClick={search} disabled={loading}>
          {loading ? '搜尋中…（約 10～30 秒）' : items ? '重新推薦' : '開始推薦'}
        </button>
      </div>
      <p className="muted">
        AI 依專案內容產生關鍵字，到 OpenAlex 學術資料庫搜尋，再從查到的論文中挑選並說明理由。每一篇都有 DOI，AI 憑記憶提到、查不到的論文一律不會出現。已在文獻庫的論文會略過。
      </p>
      {items && items.length === 0 && <p className="muted">這次沒有找到合適的新文獻，可以先多匯入幾篇文獻或補充心智圖再試。</p>}
      <ul className="rec-list">
        {items?.map((r) => (
          <li key={r.doi} className="rec">
            <a className="rec-title" href={r.url} target="_blank" rel="noreferrer">
              {r.title}
            </a>
            <span className="lit-item-meta">
              {[r.authors, r.year, r.venue, `被引用 ${r.citedBy} 次`].filter(Boolean).join('・')}
            </span>
            <p className="rec-reason">{r.reason}</p>
            <div className="btn-row">
              {added[r.doi] ? (
                <button className="btn" onClick={() => onNavigate({ page: 'literature', paperId: added[r.doi] })}>
                  已加入，查看
                </button>
              ) : (
                <button
                  className="btn"
                  onClick={() =>
                    run(async () => {
                      const id = await desk.papers.importDoi(projectId, r)
                      setAdded((a) => ({ ...a, [r.doi]: id }))
                    })
                  }
                >
                  加入文獻庫
                </button>
              )}
              <span className="muted rec-doi">DOI {r.doi}</span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
