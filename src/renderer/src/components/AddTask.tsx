import { useState } from 'react'

/** 新增待辦：輸入名稱按 Enter，可選截止日 */
export function AddTask({ onAdd, compact }: { onAdd: (title: string, date: string | null) => void; compact?: boolean }) {
  const [title, setTitle] = useState('')
  const [date, setDate] = useState('')

  const submit = (): void => {
    if (!title.trim()) return
    onAdd(title, date || null)
    setTitle('')
    setDate('')
  }

  return (
    <form
      className={`add-task${compact ? ' compact' : ''}`}
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="新增待辦，按 Enter"
        aria-label="新增待辦"
      />
      <input
        type="date"
        className="date-input"
        value={date}
        onChange={(e) => setDate(e.target.value)}
        aria-label="截止日（可留空）"
      />
      {!compact && (
        <button type="submit" className="btn" disabled={!title.trim()}>
          新增
        </button>
      )}
    </form>
  )
}
