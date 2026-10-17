import { useEffect, useState } from 'react'
import { ROLE_LABELS, type DailyTip as Tip } from '../../../shared/types'
import { todayStr } from '../dates'
import { desk } from '../useDesk'
import { AiMarkdown } from './AiMarkdown'

/** 邊欄的「AI 本日建議」：當天第一次展開邊欄時產生，三種角色每天輪流 */
export function DailyTip({ projectId, expanded }: { projectId: string; expanded: boolean }) {
  const [tip, setTip] = useState<Tip | null>(null)
  const [state, setState] = useState<'idle' | 'loading' | 'none' | 'error'>('idle')
  const [error, setError] = useState('')
  const [loadedFor, setLoadedFor] = useState('')

  useEffect(() => {
    const key = `${projectId}:${todayStr()}`
    if (!expanded || loadedFor === key) return
    setLoadedFor(key)
    setState('loading')
    desk.professor
      .daily(projectId)
      .then((t) => {
        setTip(t)
        setState(t ? 'idle' : 'none')
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err))
        setState('error')
        setLoadedFor('') // 下次展開再試
      })
  }, [expanded, projectId, loadedFor])

  return (
    <section className="advice" aria-label="AI 本日建議">
      <h3>
        AI 本日建議{tip && <span className="advice-role">・{ROLE_LABELS[tip.role]}</span>}
      </h3>
      {state === 'loading' && <p className="muted">AI 教授正在想今天的建議…</p>}
      {state === 'none' && <p className="muted">在完整視窗的「設定」填入 Gemini 金鑰後，每天會有一則研究方向、方法或口試式的提問。</p>}
      {state === 'error' && <p className="muted">今天的建議暫時無法產生：{error}</p>}
      {tip && state === 'idle' && (
        <>
          <div className="advice-text">
            <AiMarkdown text={tip.text} sources={tip.sources} onNavigate={(f) => desk.window.openFull(f)} />
          </div>
          <button
            className="link-btn"
            onClick={async () => {
              const id = await desk.professor.startFromTip(projectId)
              await desk.window.openFull({ page: 'professor', conversationId: id })
            }}
          >
            繼續討論 →
          </button>
        </>
      )}
    </section>
  )
}
