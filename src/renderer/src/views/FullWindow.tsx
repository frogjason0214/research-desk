import { useState } from 'react'
import type { Milestone, Task, UpdateStatus } from '../../../shared/types'
import { AddTask } from '../components/AddTask'
import { ErrorBanner, GoogleBanner, SyncBanner, UpdateBanner } from '../components/Banners'
import { Countdown } from '../components/Countdown'
import { CreateProject } from '../components/CreateProject'
import { EditableTitle } from '../components/EditableTitle'
import { GoogleSettings } from '../components/GoogleSettings'
import { SyncSettings } from '../components/SyncSettings'
import { TaskRow } from '../components/TaskRow'
import { desk, useDesk, useRun, type DeskState } from '../useDesk'
import { CalendarView } from './CalendarView'

type Tab = 'milestones' | 'tasks' | 'settings'

const SOON = ['文獻', '心智圖', 'AI 教授']

/** 主畫面：目前專案的分頁，或跨專案的功能頁 */
type Page = 'project' | 'calendar'

export function FullWindow() {
  const state = useDesk()
  const [error, run, clearError] = useRun()
  const [tab, setTab] = useState<Tab>('milestones')
  const [page, setPage] = useState<Page>('project')
  const [newProject, setNewProject] = useState('')

  if (!state) return null
  const current = state.projects.find((p) => p.id === state.projectId)

  return (
    <div className="full">
      <nav className="nav" aria-label="專案與功能">
        <h1 className="brand">Research Desk</h1>

        <h2 className="nav-heading">研究專案</h2>
        <ul className="nav-list">
          {state.projects.map((p) => (
            <li key={p.id}>
              <button
                className={`nav-item${p.id === state.projectId && page === 'project' ? ' is-active' : ''}`}
                onClick={() => {
                  setPage('project')
                  run(() => desk.projects.setCurrent(p.id))
                }}
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
          <input
            value={newProject}
            onChange={(e) => setNewProject(e.target.value)}
            placeholder="＋ 新專案"
            aria-label="新專案名稱"
          />
        </form>

        <h2 className="nav-heading">工具</h2>
        <ul className="nav-list">
          <li>
            <button
              className={`nav-item${page === 'calendar' ? ' is-active' : ''}`}
              onClick={() => setPage('calendar')}
            >
              行事曆
            </button>
          </li>
        </ul>

        <h2 className="nav-heading">即將推出</h2>
        <ul className="nav-list">
          {SOON.map((s) => (
            <li key={s}>
              <span className="nav-item is-disabled">{s}</span>
            </li>
          ))}
        </ul>

        <button className="nav-back" onClick={() => desk.window.closeFull()}>
          縮回邊欄
        </button>
      </nav>

      <main className="main">
        <SyncBanner status={state.status} onRetry={() => run(() => desk.sync.now())} />
        <GoogleBanner status={state.status} onSignIn={() => run(() => desk.google.signIn())} />
        <UpdateBanner status={state.status} onInstall={() => run(() => desk.update.install())} />
        <ErrorBanner error={error} onClose={clearError} />

        {page === 'calendar' ? (
          <CalendarView status={state.status} run={run} />
        ) : !current ? (
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
              <h2 className="project-name">{current.name}</h2>
              <div className="tabs" role="tablist">
                {(
                  [
                    ['milestones', '里程碑'],
                    ['tasks', '待辦'],
                    ['settings', '設定']
                  ] as [Tab, string][]
                ).map(([key, label]) => (
                  <button
                    key={key}
                    role="tab"
                    aria-selected={tab === key}
                    className={`tab${tab === key ? ' is-active' : ''}`}
                    onClick={() => setTab(key)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </header>

            {tab === 'milestones' && <MilestonesView state={state} run={run} />}
            {tab === 'tasks' && <TasksView state={state} run={run} />}
            {tab === 'settings' && <SettingsView state={state} run={run} onDeleted={() => setTab('milestones')} />}
          </>
        )}
      </main>
    </div>
  )
}

type Run = (fn: () => Promise<unknown>) => Promise<void>

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

function MilestonesView({ state, run }: { state: DeskState; run: Run }) {
  const [title, setTitle] = useState('')
  const list = state.milestones

  return (
    <div className="milestones-layout">
      <div>
        <p className="lead">勾選完成的階段，並替每個階段填上預計日期。標記為「倒數」的里程碑會顯示在邊欄。</p>
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
                title="設為邊欄倒數的依據"
                aria-pressed={!!m.is_defense}
              >
                倒數
              </button>
              <div className="row-actions">
                <button
                  className="icon-btn"
                  disabled={i === 0}
                  onClick={() => run(() => desk.milestones.move(m.id, -1))}
                  aria-label="上移"
                >
                  ↑
                </button>
                <button
                  className="icon-btn"
                  disabled={i === list.length - 1}
                  onClick={() => run(() => desk.milestones.move(m.id, 1))}
                  aria-label="下移"
                >
                  ↓
                </button>
                <button
                  className="icon-btn"
                  onClick={() => confirm(`刪除里程碑「${m.title}」？`) && run(() => desk.milestones.remove(m.id))}
                  aria-label={`刪除「${m.title}」`}
                >
                  ✕
                </button>
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
      </div>
      <aside className="milestones-aside">
        <Countdown milestones={list} />
      </aside>
    </div>
  )
}

function TasksView({ state, run }: { state: DeskState; run: Run }) {
  const [showDone, setShowDone] = useState(false)
  const open = state.tasks.filter((t) => !t.done)
  const done = state.tasks
    .filter((t) => t.done)
    .sort((a, b) => (b.done_at ?? '').localeCompare(a.done_at ?? ''))
    .slice(0, 30)

  const row = (t: Task) => (
    <TaskRow
      key={`${t.id}-${t.title}`}
      task={t}
      editable
      onToggle={() => run(() => desk.tasks.update(t.id, { done: t.done ? 0 : 1 }))}
      onRename={(title) => run(() => desk.tasks.update(t.id, { title }))}
      onDate={(due_date) => run(() => desk.tasks.update(t.id, { due_date }))}
      onRemove={() => run(() => desk.tasks.remove(t.id))}
    />
  )

  return (
    <div className="tasks-view">
      <AddTask onAdd={(title, date) => run(() => desk.tasks.create(state.projectId!, title, date))} />
      {open.length === 0 ? (
        <p className="muted">目前沒有未完成的待辦。</p>
      ) : (
        <ul className="task-list task-list-full">{open.map(row)}</ul>
      )}
      {done.length > 0 && (
        <>
          <button className="link-btn" onClick={() => setShowDone(!showDone)}>
            {showDone ? '隱藏已完成' : `顯示最近完成的 ${done.length} 項`}
          </button>
          {showDone && <ul className="task-list task-list-full">{done.map(row)}</ul>}
        </>
      )}
    </div>
  )
}

function SettingsView({ state, run, onDeleted }: { state: DeskState; run: Run; onDeleted: () => void }) {
  const current = state.projects.find((p) => p.id === state.projectId)!
  return (
    <div className="settings">
      <section>
        <h3>這個專案</h3>
        <label className="field">
          <span>專案名稱</span>
          <input
            key={current.name}
            defaultValue={current.name}
            onBlur={(e) =>
              e.target.value.trim() !== current.name && run(() => desk.projects.rename(current.id, e.target.value))
            }
          />
        </label>
        <button
          className="btn btn-danger"
          onClick={() =>
            confirm(`確定刪除「${current.name}」？裡面的里程碑與待辦都會一起刪除，無法復原。`) &&
            run(async () => {
              await desk.projects.remove(current.id)
              onDeleted()
            })
          }
        >
          刪除這個專案
        </button>
      </section>

      <SyncSettings status={state.status} run={run} />

      <GoogleSettings status={state.status} run={run} />

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
