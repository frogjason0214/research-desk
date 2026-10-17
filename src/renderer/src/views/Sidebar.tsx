import { useCallback, useEffect, useRef, useState } from 'react'
import type { Task } from '../../../shared/types'
import { AddTask } from '../components/AddTask'
import { ErrorBanner, GoogleBanner, SyncBanner, UpdateBanner } from '../components/Banners'
import { Countdown } from '../components/Countdown'
import { CreateProject } from '../components/CreateProject'
import { DailyTip } from '../components/DailyTip'
import { TaskRow } from '../components/TaskRow'
import { addDays, daysBetween, todayStr } from '../dates'
import { desk, useDesk, useRun } from '../useDesk'

const STRIP_RATIO = 1 / 5 // 收合小條佔螢幕高度的比例
const PANEL_CHROME = 26 // 內容捲動區的上下內距 + 面板上下框線

const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, n))

export function Sidebar() {
  const state = useDesk()
  const [error, run, clearError] = useRun()
  const [expanded, setExpanded] = useState(false)
  const [pinned, setPinned] = useState(false)
  const pinnedRef = useRef(pinned)
  pinnedRef.current = pinned
  const content = useRef<HTMLDivElement>(null)

  // ---------- 位置與大小 ----------
  const [screenH, setScreenH] = useState(window.innerHeight)
  const [localRatio, setLocalRatio] = useState<number | null>(null)
  const [natural, setNatural] = useState(0) // 展開內容本來需要的高度
  const [dragging, setDragging] = useState(false)
  const head = useRef<HTMLElement>(null)
  const inner = useRef<HTMLDivElement>(null)
  const drag = useRef<{ startY: number; startTop: number } | null>(null)

  useEffect(() => {
    const onResize = (): void => setScreenH(window.innerHeight)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // 內容變多變少時重新量高度，展開的面板跟著內容伸縮
  useEffect(() => {
    if (!head.current || !inner.current) return
    const measure = (): void =>
      setNatural((head.current?.offsetHeight ?? 0) + (inner.current?.offsetHeight ?? 0) + PANEL_CHROME)
    const ro = new ResizeObserver(measure)
    ro.observe(head.current)
    ro.observe(inner.current)
    measure()
    return () => ro.disconnect()
  }, [state === null])

  const ratio = localRatio ?? state?.status.sidebarTop ?? 0.5
  const stripH = Math.round(screenH * STRIP_RATIO)
  const stripTop = Math.round(ratio * (screenH - stripH))
  const openH = clamp(natural, stripH, screenH)
  // 展開時和小條上緣對齊往下長；超出螢幕底部就往上挪
  const panelTop = expanded ? Math.min(stripTop, screenH - openH) : stripTop
  const panelH = expanded ? openH : stripH

  useEffect(() => {
    desk.window.setSidebarLayout({ expanded, top: panelTop, height: panelH, dragging })
  }, [expanded, panelTop, panelH, dragging])

  const moveTo = (top: number): number => {
    const r = clamp(top / Math.max(1, screenH - stripH), 0, 1)
    setLocalRatio(r)
    return r
  }

  // ---------- 展開／收合 ----------

  const expand = useCallback(() => setExpanded(true), [])

  const collapse = useCallback(() => {
    if (pinnedRef.current) return
    // 輸入框裡有還沒送出的文字時先不收合；只是游標停在空白輸入框不算
    const active = document.activeElement as HTMLInputElement | null
    if (active?.tagName === 'INPUT' && active.value.trim()) return
    active?.blur()
    setExpanded(false)
  }, [])

  // 展開／收合由主程式依滑鼠位置通知
  useEffect(() => desk.onSidebarHover((e) => (e === 'enter' ? expand() : collapse())), [expand, collapse])

  // 收合時內容在畫面外，不能被 Tab 鍵或螢幕閱讀器讀到
  useEffect(() => {
    if (content.current) content.current.inert = !expanded
  }, [expanded, state])

  const defense = state?.milestones.find((m) => m.is_defense)
  const days = defense?.due_date ? daysBetween(todayStr(), defense.due_date) : null

  return (
    <div className={`dock${expanded ? ' is-open' : ''}${dragging ? ' is-dragging' : ''}`}>
      <div className="panel" style={{ top: panelTop, height: panelH }}>
        <div className="strip-inner" aria-label={days !== null ? `距離口試 ${days} 天` : '研究桌'}>
          <span className="strip-dot" />
          {days !== null && <span className="strip-days">{days}</span>}
        </div>
        {state && (
          <div className="panel-content" ref={content}>
            <header className="sidebar-head" ref={head}>
              <button
                className="drag-handle"
                title="按住上下拖曳，移動邊欄位置"
                aria-label="移動邊欄位置（可用上下方向鍵）"
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture(e.pointerId)
                  drag.current = { startY: e.screenY, startTop: panelTop }
                  setDragging(true)
                }}
                onPointerMove={(e) => {
                  if (drag.current) moveTo(drag.current.startTop + e.screenY - drag.current.startY)
                }}
                onPointerUp={() => {
                  drag.current = null
                  setDragging(false)
                  desk.window.saveSidebarTop(ratio)
                }}
                onKeyDown={(e) => {
                  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
                  e.preventDefault()
                  const step = (e.key === 'ArrowUp' ? -1 : 1) * screenH * 0.05
                  desk.window.saveSidebarTop(moveTo(panelTop + step))
                }}
              >
                ⋮⋮
              </button>
              {state.projects.length > 0 ? (
                <select
                  className="project-select"
                  value={state.projectId ?? ''}
                  onChange={(e) => run(() => desk.projects.setCurrent(e.target.value))}
                  aria-label="目前專案"
                >
                  {state.projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="sidebar-title">Research Desk</span>
              )}
              <button
                className={`icon-btn${pinned ? ' is-on' : ''}`}
                onClick={() => setPinned(!pinned)}
                title={pinned ? '取消固定（滑鼠移開會收合）' : '固定展開'}
                aria-pressed={pinned}
              >
                ⊙
              </button>
              <button className="icon-btn" onClick={() => desk.window.openFull()} title="開啟完整視窗">
                ⤢
              </button>
            </header>

            <div className="sidebar-body">
              <div className="sidebar-inner" ref={inner}>
                <SyncBanner status={state.status} onRetry={() => run(() => desk.sync.now())} />
                <GoogleBanner status={state.status} onSignIn={() => run(() => desk.google.signIn())} />
                <UpdateBanner status={state.status} onInstall={() => run(() => desk.update.install())} />
                <ErrorBanner error={error} onClose={clearError} />

                {!state.projectId ? (
                  <CreateProject
                    onCreate={(name) =>
                      run(async () => {
                        const p = await desk.projects.create(name)
                        await desk.projects.setCurrent(p.id)
                      })
                    }
                  />
                ) : (
                  <>
                    <Countdown milestones={state.milestones} onSetDate={() => desk.window.openFull()} />

                    <DailyTip projectId={state.projectId} expanded={expanded} />

                    <TodayTasks
                      tasks={state.tasks}
                      onToggle={(t) => run(() => desk.tasks.update(t.id, { done: t.done ? 0 : 1 }))}
                    />
                    <AddTask
                      compact
                      onAdd={(title, date) => run(() => desk.tasks.create(state.projectId!, title, date))}
                    />
                  </>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/** 邊欄的待辦：逾期、今天、7 天內、未排日期 */
function TodayTasks({ tasks, onToggle }: { tasks: Task[]; onToggle: (t: Task) => void }) {
  const today = todayStr()
  const weekEnd = addDays(today, 7)
  const open = tasks.filter((t) => !t.done)
  const groups: { name: string; items: Task[] }[] = [
    { name: '逾期', items: open.filter((t) => t.due_date && t.due_date < today) },
    { name: '今天', items: open.filter((t) => t.due_date === today) },
    { name: '接下來 7 天', items: open.filter((t) => t.due_date && t.due_date > today && t.due_date <= weekEnd) },
    { name: '未排日期', items: open.filter((t) => !t.due_date).slice(0, 5) }
  ].filter((g) => g.items.length > 0)

  return (
    <section className="today" aria-label="待辦">
      <h3>待辦</h3>
      {groups.length === 0 && <p className="muted">這週沒有到期的待辦。在下方新增一項吧。</p>}
      {groups.map((g) => (
        <div key={g.name} className="task-group">
          <h4 className={g.name === '逾期' ? 'warn' : ''}>{g.name}</h4>
          <ul className="task-list">
            {g.items.map((t) => (
              <TaskRow key={t.id} task={t} onToggle={() => onToggle(t)} />
            ))}
          </ul>
        </div>
      ))}
    </section>
  )
}
