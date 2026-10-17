import { useEffect, useState } from 'react'
import type { Focus, Task, TaskLinks } from '../../../shared/types'
import { AddTask } from '../components/AddTask'
import { Countdown } from '../components/Countdown'
import { DailyTip } from '../components/DailyTip'
import { TaskRow } from '../components/TaskRow'
import { desk, type DeskState } from '../useDesk'
import { CalendarPanel } from './CalendarView'

type Run = (fn: () => Promise<unknown>) => Promise<void>

/** 「今天」：上方口試倒數，左邊行事曆、右邊每日建議與待辦 */
export function TodayView({
  state,
  run,
  onNavigate,
  onOpenMilestones
}: {
  state: DeskState
  run: Run
  onNavigate: (f: Focus) => void
  onOpenMilestones: () => void
}) {
  const [selectedTask, setSelectedTask] = useState<string | null>(null)
  return (
    <div className="today-page">
      {/* 倒數裡面可能有「設定口試日期」按鈕，外層不能也是 button */}
      <div
        className="today-countdown"
        role="button"
        tabIndex={0}
        onClick={onOpenMilestones}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onOpenMilestones()}
        title="編輯里程碑"
      >
        <Countdown milestones={state.milestones} row onSetDate={onOpenMilestones} />
      </div>
      <div className="today-grid">
        <CalendarPanel
          status={state.status}
          tasks={state.tasks}
          run={run}
          selectedTask={selectedTask}
          onSelectTask={setSelectedTask}
        />
        <aside className="today-side">
          <DailyTip projectId={state.projectId!} expanded />
          <TaskPanel state={state} run={run} onNavigate={onNavigate} selected={selectedTask} />
        </aside>
      </div>
    </div>
  )
}

function TaskPanel({
  state,
  run,
  onNavigate,
  selected
}: {
  state: DeskState
  run: Run
  onNavigate: (f: Focus) => void
  selected: string | null
}) {
  const [showDone, setShowDone] = useState(false)
  const [links, setLinks] = useState<Record<string, TaskLinks>>({})
  useEffect(() => {
    const load = (): void => void desk.links.forTasks(state.projectId!).then(setLinks)
    load()
    return desk.onChanged(load)
  }, [state.projectId])

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
      draggable
      highlighted={t.id === selected}
      onToggle={() => run(() => desk.tasks.update(t.id, { done: t.done ? 0 : 1 }))}
      onRename={(title) => run(() => desk.tasks.update(t.id, { title }))}
      onDate={(due_date) => run(() => desk.tasks.update(t.id, { due_date }))}
      onRemove={() => run(() => desk.tasks.remove(t.id))}
      links={links[t.id]}
      onNavigate={onNavigate}
    />
  )

  return (
    <section className="task-panel" aria-label="待辦">
      <h3>待辦</h3>
      <AddTask compact onAdd={(title, date) => run(() => desk.tasks.create(state.projectId!, title, date))} />
      {open.length === 0 ? <p className="muted">目前沒有未完成的待辦。</p> : <ul className="task-list task-list-full">{open.map(row)}</ul>}
      {done.length > 0 && (
        <>
          <button className="link-btn" onClick={() => setShowDone(!showDone)}>
            {showDone ? '隱藏已完成' : `顯示最近完成的 ${done.length} 項`}
          </button>
          {showDone && <ul className="task-list task-list-full">{done.map(row)}</ul>}
        </>
      )}
    </section>
  )
}
