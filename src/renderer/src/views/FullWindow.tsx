import {
  ArrowDown,
  ArrowUp,
  BookOpen,
  CalendarDays,
  GraduationCap,
  PanelRightClose,
  Settings,
  Workflow,
  X,
  type LucideIcon
} from 'lucide-react'
import { useEffect, useState } from 'react'
import type { Focus, Milestone, UpdateStatus } from '../../../shared/types'
import { AiSettings } from '../components/AiSettings'
import { ErrorBanner, GoogleBanner, SyncBanner, UpdateBanner } from '../components/Banners'
import { CreateProject } from '../components/CreateProject'
import { EditableTitle } from '../components/EditableTitle'
import { GoogleSettings } from '../components/GoogleSettings'
import { IconButton } from '../components/IconButton'
import { SyncSettings } from '../components/SyncSettings'
import { desk, useDesk, useRun, type DeskState } from '../useDesk'
import { LiteratureView } from './LiteratureView'
import { MindMapView } from './MindMapView'
import { ProfessorView } from './ProfessorView'
import { TodayView } from './TodayView'

/** 左側導覽的五個入口；「今天」是打開時的第一頁 */
type Page = 'today' | 'literature' | 'mindmap' | 'professor' | 'settings'

const PAGES: [Page, string, LucideIcon][] = [
  ['today', '今天', CalendarDays],
  ['literature', '文獻', BookOpen],
  ['mindmap', '心智圖', Workflow],
  ['professor', 'AI 教授', GraduationCap],
  ['settings', '設定', Settings]
]

type Run = (fn: () => Promise<unknown>) => Promise<void>

export function FullWindow() {
  const state = useDesk()
  const [error, run, clearError] = useRun()
  const [page, setPage] = useState<Page>('today')
  // 從文獻跳到心智圖節點、從節點或待辦跳到文獻、從每日建議跳到對話
  const [focus, setFocus] = useState<Focus | null>(null)
  const navigate = (f: Focus): void => {
    setFocus(f)
    setPage(f.page)
  }
  // 邊欄（例如每日建議的「繼續討論」）要求跳到某一頁
  useEffect(() => desk.onNavigate(navigate), [])
  const [newProject, setNewProject] = useState('')

  if (!state) return null
  const current = state.projects.find((p) => p.id === state.projectId)
  const label = PAGES.find(([key]) => key === page)?.[1]

  return (
    <div className="full">
      <nav className="nav" aria-label="專案與功能">
        <h1 className="brand">Research Desk</h1>

        <h2 className="nav-heading">研究專案</h2>
        <ul className="nav-list">
          {state.projects.map((p) => (
            <li key={p.id}>
              <button
                className={`nav-item nav-project${p.id === state.projectId ? ' is-current' : ''}`}
                onClick={() => run(() => desk.projects.setCurrent(p.id))}
              >
                {p.name}
              </button>
            </li>
          ))}
        </ul>
        <form
          className="nav-add"
          onSubmit={(e) => {
            e.preventDefault()
            if (!newProject.trim()) return
            run(async () => {
              const p = await desk.projects.create(newProject)
              await desk.projects.setCurrent(p.id)
              setNewProject('')
            })
          }}
        >
          <input value={newProject} onChange={(e) => setNewProject(e.target.value)} placeholder="＋ 新專案" aria-label="新專案名稱" />
        </form>

        <ul className="nav-list nav-pages">
          {PAGES.map(([key, text, Icon]) => (
            <li key={key}>
              <button
                className={`nav-item${page === key ? ' is-active' : ''}`}
                onClick={() => {
                  setPage(key)
                  setFocus(null)
                }}
              >
                <Icon size={18} strokeWidth={1.8} aria-hidden />
                {text}
              </button>
            </li>
          ))}
        </ul>

        <button className="nav-back" onClick={() => desk.window.closeFull()} title="縮回邊欄">
          <PanelRightClose size={18} strokeWidth={1.8} aria-hidden />
          縮回邊欄
        </button>
      </nav>

      <main className="main">
        <SyncBanner status={state.status} onRetry={() => run(() => desk.sync.now())} />
        <GoogleBanner status={state.status} onSignIn={() => run(() => desk.google.signIn())} />
        <UpdateBanner status={state.status} onInstall={() => run(() => desk.update.install())} />
        <ErrorBanner error={error} onClose={clearError} />

        {!current ? (
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
            <header className="main-head">
              <h2 className="project-name">
                {current.name}
                <span className="page-name">・{label}</span>
              </h2>
            </header>
            {page === 'today' && (
              <TodayView state={state} run={run} onNavigate={navigate} onOpenMilestones={() => setPage('settings')} />
            )}
            {page === 'literature' && (
              <LiteratureView
                projectId={current.id}
                tasks={state.tasks}
                run={run}
                focusPaperId={focus?.page === 'literature' ? focus.paperId : null}
                onNavigate={navigate}
              />
            )}
            {page === 'mindmap' && (
              <MindMapView
                projectId={current.id}
                tasks={state.tasks}
                run={run}
                focus={focus?.page === 'mindmap' ? focus : null}
                onNavigate={navigate}
              />
            )}
            {page === 'professor' && (
              <ProfessorView
                projectId={current.id}
                run={run}
                focusConversationId={focus?.page === 'professor' ? focus.conversationId : null}
                onNavigate={navigate}
              />
            )}
            {page === 'settings' && <SettingsView state={state} run={run} onDeleted={() => setPage('today')} />}
          </>
        )}
      </main>
    </div>
  )
}

function updateText(u: UpdateStatus): string {
  switch (u.state) {
    case 'dev':
      return '（開發模式，不檢查更新）'
    case 'checking':
      return '・正在檢查更新…'
    case 'latest':
      return '・已是最新版本'
    case 'downloading':
      return `・正在下載 ${u.version}（${u.progress ?? 0}%）`
    case 'ready':
      return `・新版本 ${u.version} 已下載`
    case 'error':
      return `・檢查更新失敗：${u.error}`
    default:
      return ''
  }
}

function MilestonesSection({ state, run }: { state: DeskState; run: Run }) {
  const [title, setTitle] = useState('')
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const list = state.milestones

  return (
    <section>
      <h3>論文里程碑</h3>
      <p className="muted">勾選完成的階段、填上預計日期。標記「倒數」的里程碑會顯示在「今天」頁與邊欄。</p>
      <ol className="milestone-list">
        {list.map((m: Milestone, i) => (
          <li key={m.id} className={`milestone-row${m.done ? ' is-done' : ''}`}>
            <input
              type="checkbox"
              checked={!!m.done}
              onChange={() => run(() => desk.milestones.update(m.id, { done: m.done ? 0 : 1 }))}
              aria-label={`完成「${m.title}」`}
            />
            <EditableTitle
              className="milestone-title"
              value={m.title}
              label="里程碑名稱"
              onSave={(title) => run(() => desk.milestones.update(m.id, { title }))}
            />
            <input
              type="date"
              className="date-input"
              value={m.due_date ?? ''}
              onChange={(e) => run(() => desk.milestones.update(m.id, { due_date: e.target.value || null }))}
              aria-label={`「${m.title}」日期`}
            />
            <button
              className={`chip${m.is_defense ? ' is-on' : ''}`}
              onClick={() => run(() => desk.milestones.setDefense(m.id))}
              title="設為倒數的依據"
              aria-pressed={!!m.is_defense}
            >
              倒數
            </button>
            <div className="row-actions">
              <IconButton icon={ArrowUp} label="上移" disabled={i === 0} onClick={() => run(() => desk.milestones.move(m.id, -1))} />
              <IconButton
                icon={ArrowDown}
                label="下移"
                disabled={i === list.length - 1}
                onClick={() => run(() => desk.milestones.move(m.id, 1))}
              />
              <IconButton
                icon={X}
                label={confirmRemove === m.id ? `再按一次刪除「${m.title}」` : `刪除「${m.title}」`}
                danger
                active={confirmRemove === m.id}
                onClick={() => (confirmRemove === m.id ? run(() => desk.milestones.remove(m.id)) : setConfirmRemove(m.id))}
              />
            </div>
          </li>
        ))}
      </ol>
      <form
        className="inline-add"
        onSubmit={(e) => {
          e.preventDefault()
          if (!title.trim()) return
          run(async () => {
            await desk.milestones.create(state.projectId!, title)
            setTitle('')
          })
        }}
      >
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="新增里程碑" />
        <button className="btn" type="submit" disabled={!title.trim()}>
          新增
        </button>
      </form>
    </section>
  )
}

function SettingsView({ state, run, onDeleted }: { state: DeskState; run: Run; onDeleted: () => void }) {
  const current = state.projects.find((p) => p.id === state.projectId)!
  const [confirmDelete, setConfirmDelete] = useState(false)
  return (
    <div className="settings">
      <section>
        <h3>這個專案</h3>
        <label className="field">
          <span>專案名稱</span>
          <input
            key={current.name}
            defaultValue={current.name}
            onBlur={(e) => e.target.value.trim() !== current.name && run(() => desk.projects.rename(current.id, e.target.value))}
          />
        </label>
        <button
          className="btn btn-danger"
          onClick={() =>
            confirmDelete
              ? run(async () => {
                  await desk.projects.remove(current.id)
                  onDeleted()
                })
              : setConfirmDelete(true)
          }
        >
          {confirmDelete ? `確定刪除「${current.name}」？里程碑、待辦、文獻、心智圖都會刪除` : '刪除這個專案'}
        </button>
      </section>

      <MilestonesSection state={state} run={run} />

      <SyncSettings status={state.status} run={run} />

      <GoogleSettings status={state.status} run={run} />

      <AiSettings run={run} />

      <section>
        <h3>程式</h3>
        <label className="check">
          <input
            type="checkbox"
            checked={state.status.launchAtLogin}
            onChange={(e) => run(() => desk.settings.setLaunchAtLogin(e.target.checked))}
          />
          開機時自動啟動
        </label>
        <p className="muted">
          版本 {state.status.version}
          {updateText(state.status.update)}
        </p>
        {state.status.update.state === 'ready' ? (
          <button className="btn btn-primary" onClick={() => run(() => desk.update.install())}>
            重新啟動並更新
          </button>
        ) : (
          state.status.update.state !== 'dev' && (
            <button
              className="btn"
              disabled={state.status.update.state === 'checking' || state.status.update.state === 'downloading'}
              onClick={() => run(() => desk.update.check())}
            >
              檢查更新
            </button>
          )
        )}
        <button className="btn" onClick={() => desk.window.quit()}>
          結束程式
        </button>
      </section>
    </div>
  )
}
