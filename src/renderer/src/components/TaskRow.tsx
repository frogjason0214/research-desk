import type { Task } from '../../../shared/types'
import { relativeDay, todayStr } from '../dates'

interface Props {
  task: Task
  onToggle: () => void
  editable?: boolean
  onRename?: (title: string) => void
  onDate?: (date: string | null) => void
  onRemove?: () => void
}

export function TaskRow({ task, onToggle, editable, onRename, onDate, onRemove }: Props) {
  const overdue = !task.done && task.due_date !== null && task.due_date < todayStr()
  return (
    <li className={`task-row${task.done ? ' is-done' : ''}${overdue ? ' is-overdue' : ''}`}>
      <input
        type="checkbox"
        checked={!!task.done}
        onChange={onToggle}
        aria-label={task.done ? `標記「${task.title}」為未完成` : `完成「${task.title}」`}
      />
      {editable ? (
        <input
          className="task-title-input"
          defaultValue={task.title}
          onBlur={(e) => e.target.value.trim() !== task.title && onRename?.(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          aria-label="任務名稱"
        />
      ) : (
        <span className="task-title">{task.title}</span>
      )}
      {editable ? (
        <input
          type="date"
          className="date-input"
          value={task.due_date ?? ''}
          onChange={(e) => onDate?.(e.target.value || null)}
          aria-label="截止日"
        />
      ) : (
        task.due_date && <span className="task-due">{relativeDay(task.due_date)}</span>
      )}
      {editable && (
        <button className="icon-btn" onClick={onRemove} aria-label={`刪除「${task.title}」`} title="刪除">
          ✕
        </button>
      )}
    </li>
  )
}
