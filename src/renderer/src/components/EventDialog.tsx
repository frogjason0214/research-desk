import { useState } from 'react'
import type { CalendarEvent, CalendarInfo, EventInput } from '../../../shared/types'

const pad = (n: number): string => String(n).padStart(2, '0')

/** ISO 時間 → 本地 YYYY-MM-DDTHH:mm（給 datetime-local 輸入框） */
export function toLocalInput(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export type DialogTarget = { kind: 'new'; date: string; hour?: number } | { kind: 'edit'; event: CalendarEvent }

function initial(target: DialogTarget, calendars: CalendarInfo[]): EventInput {
  if (target.kind === 'edit') {
    const e = target.event
    return {
      calendarId: e.calendarId,
      title: e.title,
      description: e.description,
      allDay: e.allDay,
      start: e.allDay ? e.start : toLocalInput(e.start),
      end: e.allDay ? e.end : toLocalInput(e.end)
    }
  }
  const cal = calendars.find((c) => c.primary && c.writable) ?? calendars.find((c) => c.writable)
  const timed = target.hour !== undefined
  return {
    calendarId: cal?.id ?? '',
    title: '',
    description: '',
    allDay: !timed,
    start: timed ? `${target.date}T${pad(target.hour!)}:00` : target.date,
    end: timed ? `${target.date}T${pad(target.hour! + 1)}:00` : target.date
  }
}

/** 新增或修改一個 Google 行程 */
export function EventDialog({
  target,
  calendars,
  onSave,
  onDelete,
  onClose
}: {
  target: DialogTarget
  calendars: CalendarInfo[]
  onSave: (input: EventInput) => Promise<void>
  onDelete: () => Promise<void>
  onClose: () => void
}) {
  const [form, setForm] = useState<EventInput>(() => initial(target, calendars))
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [busy, setBusy] = useState(false)
  const event = target.kind === 'edit' ? target.event : null
  const readOnly = !!event && !event.writable
  const writable = calendars.filter((c) => c.writable && !c.research)
  const set = (patch: Partial<EventInput>): void => setForm((f) => ({ ...f, ...patch }))

  // 切換全天時，日期與時間格式互換
  const toggleAllDay = (allDay: boolean): void => {
    if (allDay) set({ allDay, start: form.start.slice(0, 10), end: form.end.slice(0, 10) })
    else set({ allDay, start: `${form.start.slice(0, 10)}T09:00`, end: `${form.end.slice(0, 10)}T10:00` })
  }

  const submit = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true)
    try {
      await fn()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="dialog"
        role="dialog"
        aria-label={event ? '行程內容' : '新增行程'}
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
        onSubmit={(e) => {
          e.preventDefault()
          if (!readOnly) submit(() => onSave(form))
        }}
      >
        <h3>{readOnly ? '行程內容' : event ? '修改行程' : '新增行程'}</h3>

        {readOnly ? (
          <>
            <p className="dialog-title">{event!.title}</p>
            <p className="muted">
              {event!.allDay
                ? event!.start === event!.end
                  ? event!.start
                  : `${event!.start} – ${event!.end}`
                : `${toLocalInput(event!.start).replace('T', ' ')} – ${toLocalInput(event!.end).slice(11)}`}
            </p>
            {event!.taskId ? (
              <p className="muted">這是由待辦產生的行程，請在「待辦」頁修改日期或標題。</p>
            ) : (
              <p className="muted">這個行事曆沒有修改權限。</p>
            )}
            {event!.description && <p className="dialog-desc">{event!.description}</p>}
          </>
        ) : (
          <>
            <label className="field">
              <span>標題</span>
              <input value={form.title} onChange={(e) => set({ title: e.target.value })} autoFocus required />
            </label>
            <label className="field">
              <span>行事曆</span>
              <select value={form.calendarId} onChange={(e) => set({ calendarId: e.target.value })}>
                {writable.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="check">
              <input type="checkbox" checked={form.allDay} onChange={(e) => toggleAllDay(e.target.checked)} />
              全天
            </label>
            <div className="field-row">
              <label className="field">
                <span>開始</span>
                <input
                  type={form.allDay ? 'date' : 'datetime-local'}
                  value={form.start}
                  required
                  onChange={(e) => {
                    const start = e.target.value
                    // 開始往後移時，結束跟著移，維持原本的長度
                    if (form.allDay && form.end < start) set({ start, end: start })
                    else if (!form.allDay && form.end <= start) {
                      const d = new Date(start)
                      d.setHours(d.getHours() + 1)
                      set({ start, end: toLocalInput(d.toISOString()) })
                    } else set({ start })
                  }}
                />
              </label>
              <label className="field">
                <span>結束</span>
                <input
                  type={form.allDay ? 'date' : 'datetime-local'}
                  value={form.end}
                  min={form.allDay ? form.start : undefined}
                  required
                  onChange={(e) => set({ end: e.target.value })}
                />
              </label>
            </div>
            <label className="field">
              <span>說明</span>
              <textarea rows={3} value={form.description} onChange={(e) => set({ description: e.target.value })} />
            </label>
          </>
        )}

        <div className="dialog-actions">
          {event?.link && (
            <a className="link-btn" href={event.link} target="_blank" rel="noreferrer">
              在 Google 日曆開啟
            </a>
          )}
          <span className="spacer" />
          {event && !readOnly && (
            <button
              type="button"
              className="btn btn-danger"
              disabled={busy}
              onClick={() => (confirmDelete ? submit(onDelete) : setConfirmDelete(true))}
            >
              {confirmDelete ? '確定刪除？' : '刪除'}
            </button>
          )}
          <button type="button" className="btn" onClick={onClose}>
            {readOnly ? '關閉' : '取消'}
          </button>
          {!readOnly && (
            <button type="submit" className="btn btn-primary" disabled={busy || !form.title.trim()}>
              儲存
            </button>
          )}
        </div>
      </form>
    </div>
  )
}
