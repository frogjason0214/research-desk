import type { Focus, Task, TaskLinks } from '../../../shared/types'
import { relativeDay, todayStr } from '../dates'

interface Props {
  task: Task
  onToggle: () => void
  editable?: boolean
  onRename?: (title: string) => void
  onDate?: (date: string | null) => void
  onRemove?: () => void
  /** 這個待辦連到的心智圖節點與文獻 */
  links?: TaskLinks
  onNavigate?: (f: Focus) => void
}

export function TaskRow({ task, onToggle, editable, onRename, onDate, onRemove, links, onNavigate }: Props) {
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
      {links && onNavigate && (links.nodes.length > 0 || links.papers.length > 0) && (
        <span className="task-links">
          {links.nodes.map((n) => (
            <button
              key={n.nodeId}
              className="badge is-link"
              onClick={() => onNavigate({ page: 'mindmap', mapId: n.mapId, nodeId: n.nodeId })}
              title={`心智圖「${n.mapName}」`}
            >
              節點：{n.text}
            </button>
          ))}
          {links.papers.map((p) => (
            <button
              key={p.id}
              className="badge is-link"
              onClick={() => onNavigate({ page: 'literature', paperId: p.id })}
              title={p.title}
            >
              文獻：{p.title.length > 24 ? `${p.title.slice(0, 24)}…` : p.title}
            </button>
          ))}
        </span>
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
