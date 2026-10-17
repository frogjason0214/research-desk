import { useRef, useState } from 'react'

/**
 * 平常是文字，滑過出現虛底線和 ✎，點一下變成輸入框並全選。
 * Enter 或點別處儲存，Esc 取消。
 */
export function EditableTitle({
  value,
  label,
  className = '',
  onSave
}: {
  value: string
  label: string
  className?: string
  onSave: (value: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const done = useRef(false) // Esc 取消後，輸入框消失時的 blur 不要再儲存

  if (!editing) {
    return (
      <button
        className={`editable ${className}`}
        title="點一下修改名稱"
        onClick={() => {
          done.current = false
          setEditing(true)
        }}
      >
        <span className="editable-text">{value}</span>
        <span className="editable-icon" aria-hidden>
          ✎
        </span>
        <span className="sr-only">（{label}，點一下修改）</span>
      </button>
    )
  }

  const finish = (input: HTMLInputElement, save: boolean): void => {
    if (done.current) return
    done.current = true
    const next = input.value.trim()
    setEditing(false)
    if (save && next && next !== value) onSave(next)
  }

  return (
    <input
      className={`editable-input ${className}`}
      defaultValue={value}
      aria-label={label}
      autoFocus
      onFocus={(e) => e.target.select()}
      onBlur={(e) => finish(e.target, true)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') finish(e.currentTarget, false)
      }}
    />
  )
}
