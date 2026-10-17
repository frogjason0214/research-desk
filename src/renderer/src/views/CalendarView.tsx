import { CalendarPlus, ChevronLeft, ChevronRight, Eye, Plus, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AppStatus, CalendarEvent, CalendarInfo, Task } from '../../../shared/types'
import { EventDialog, toLocalInput, type DialogTarget } from '../components/EventDialog'
import { IconButton } from '../components/IconButton'
import { addDays, daysBetween, todayStr } from '../dates'
import { TASK_DRAG } from '../dnd'
import { desk } from '../useDesk'

// 行事曆：待辦直接畫在上面（依狀態上色），Google 行程統一一種顏色。
// 「研究任務」行事曆是待辦同步過去的副本，這裡不再顯示，避免重複。
// 沒登入 Google 也能用，只顯示待辦。

type Run = (fn: () => Promise<unknown>) => Promise<void>
type Mode = 'month' | 'week'

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']
const HOUR_PX = 44

const weekday = (date: string): number => new Date(`${date}T00:00:00`).getDay()
const localDate = (iso: string): string => toLocalInput(iso).slice(0, 10)
const timeLabel = (iso: string): string => toLocalInput(iso).slice(11)

/** 待辦狀態：決定顏色 */
export function taskState(t: Task, today = todayStr()): 'done' | 'overdue' | 'today' | 'upcoming' {
  if (t.done) return 'done'
  if (!t.due_date) return 'upcoming'
  if (t.due_date < today) return 'overdue'
  if (t.due_date === today) return 'today'
  return 'upcoming'
}

/** 畫面要顯示的日期範圍 [start, end) */
function rangeOf(mode: Mode, anchor: string): { start: string; end: string } {
  if (mode === 'week') {
    const start = addDays(anchor, -weekday(anchor))
    return { start, end: addDays(start, 7) }
  }
  const first = `${anchor.slice(0, 7)}-01`
  const start = addDays(first, -weekday(first))
  return { start, end: addDays(start, 42) }
}

/** 某一天有哪些 Google 行程（跨日的行程每一天都算） */
function eventsOn(events: CalendarEvent[], date: string): CalendarEvent[] {
  return events.filter((e) =>
    e.allDay
      ? e.start <= date && date <= e.end
      : localDate(e.start) <= date && date <= localDate(new Date(new Date(e.end).getTime() - 1).toISOString())
  )
}

export function CalendarPanel({
  status,
  tasks,
  run,
  selectedTask,
  onSelectTask
}: {
  status: AppStatus
  tasks: Task[]
  run: Run
  selectedTask: string | null
  onSelectTask: (id: string) => void
}) {
  const g = status.google
  const googleOn = g.configured && g.state === 'signedIn'
  const [mode, setMode] = useState<Mode>('month')
  const [anchor, setAnchor] = useState(todayStr())
  const [calendars, setCalendars] = useState<CalendarInfo[]>([])
  const [events, setEvents] = useState<CalendarEvent[]>([])
  const [hidden, setHidden] = useState<string[]>([])
  const [showPicker, setShowPicker] = useState(false)
  const [loading, setLoading] = useState(false)
  const [dialog, setDialog] = useState<DialogTarget | null>(null)
  const range = useMemo(() => rangeOf(mode, anchor), [mode, anchor])

  useEffect(() => {
    desk.calendar.hidden().then(setHidden)
  }, [])

  const load = useCallback(() => {
    if (!googleOn) {
      setEvents([])
      return Promise.resolve()
    }
    return run(async () => {
      setLoading(true)
      try {
        const [cals, evs] = await Promise.all([desk.calendar.calendars(), desk.calendar.events(range.start, range.end)])
        setCalendars(cals)
        setEvents(evs)
      } finally {
        setLoading(false)
      }
    })
  }, [run, range, googleOn])

  useEffect(() => {
    load()
  }, [load])

  // 待辦本身直接從資料畫，不必等 Google；只有 Google 行程需要重新讀
  const googleEvents = events.filter((e) => {
    const cal = calendars.find((c) => c.id === e.calendarId)
    return !e.taskId && !cal?.research && !hidden.includes(e.calendarId)
  })
  const today = todayStr()

  const step = (dir: -1 | 1): void => {
    if (mode === 'week') setAnchor(addDays(anchor, dir * 7))
    else {
      const [y, m] = anchor.split('-').map(Number)
      const d = new Date(y, m - 1 + dir, 1)
      setAnchor(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`)
    }
  }

  const [y, m] = anchor.split('-').map(Number)
  const title =
    mode === 'month' ? `${y} 年 ${m} 月` : `${range.start.replace(/-/g, '/')} – ${addDays(range.end, -1).slice(5).replace('-', '/')}`

  const toggleCal = (id: string): void => {
    const next = hidden.includes(id) ? hidden.filter((h) => h !== id) : [...hidden, id]
    setHidden(next)
    run(() => desk.calendar.setHidden(next))
  }

  // 把待辦拖到某一天：設成那天截止
  const dropOn = (date: string) => ({
    onDragOver: (e: React.DragEvent) => {
      if (e.dataTransfer.types.includes(TASK_DRAG)) {
        e.preventDefault()
        e.currentTarget.classList.add('is-drop')
      }
    },
    onDragLeave: (e: React.DragEvent) => e.currentTarget.classList.remove('is-drop'),
    onDrop: (e: React.DragEvent) => {
      e.currentTarget.classList.remove('is-drop')
      const id = e.dataTransfer.getData(TASK_DRAG)
      if (id) {
        e.preventDefault()
        run(() => desk.tasks.update(id, { due_date: date }))
      }
    }
  })

  const tasksOn = (date: string): Task[] => tasks.filter((t) => t.due_date === date)
  const newEvent = (date: string, hour?: number): void => {
    if (googleOn) setDialog({ kind: 'new', date, hour })
  }

  return (
    <div className="calendar">
      <div className="cal-toolbar">
        <button className="btn btn-small" onClick={() => setAnchor(todayStr())}>
          今天
        </button>
        <IconButton icon={ChevronLeft} label="上一頁" onClick={() => step(-1)} />
        <IconButton icon={ChevronRight} label="下一頁" onClick={() => step(1)} />
        <h3 className="cal-title">{title}</h3>
        {loading && <span className="muted">讀取中…</span>}
        <span className="spacer" />
        <div className="seg" role="group" aria-label="檢視方式">
          <button className={mode === 'month' ? 'is-on' : ''} onClick={() => setMode('month')}>
            月
          </button>
          <button className={mode === 'week' ? 'is-on' : ''} onClick={() => setMode('week')}>
            週
          </button>
        </div>
        {googleOn ? (
          <>
            <IconButton icon={Eye} label="選擇要顯示的 Google 行事曆" active={showPicker} onClick={() => setShowPicker(!showPicker)} />
            <IconButton icon={RefreshCw} label="重新讀取 Google 行程" onClick={() => load()} />
            <IconButton icon={Plus} label="新增 Google 行程" onClick={() => setDialog({ kind: 'new', date: today })} />
          </>
        ) : (
          g.configured && (
            <IconButton
              icon={CalendarPlus}
              label={g.state === 'expired' ? 'Google 登入已過期，重新登入' : '連接 Google 行事曆'}
              onClick={() => run(() => desk.google.signIn())}
            />
          )
        )}
      </div>

      <ul className="cal-legend" aria-label="顏色說明">
        <li><span className="swatch is-overdue" />逾期待辦</li>
        <li><span className="swatch is-today" />今天到期</li>
        <li><span className="swatch is-upcoming" />之後到期</li>
        <li><span className="swatch is-done" />已完成</li>
        {googleOn && <li><span className="swatch is-google" />Google 行程</li>}
        <li className="muted">把右邊的待辦拖到日期上就能設定截止日</li>
      </ul>

      {showPicker && googleOn && (
        <ul className="cal-picker">
          {calendars
            .filter((c) => !c.research)
            .map((c) => (
              <li key={c.id}>
                <label className="check">
                  <input type="checkbox" checked={!hidden.includes(c.id)} onChange={() => toggleCal(c.id)} />
                  {c.name}
                </label>
              </li>
            ))}
        </ul>
      )}

      {mode === 'month' ? (
        <div className="month">
          {WEEKDAYS.map((w) => (
            <div key={w} className="month-head">
              {w}
            </div>
          ))}
          {Array.from({ length: daysBetween(range.start, range.end) }, (_, i) => addDays(range.start, i)).map((d) => {
            const dayTasks = tasksOn(d)
            const dayEvents = eventsOn(googleEvents, d)
            const shown = 3
            return (
              <div
                key={d}
                className={`month-cell${d.slice(0, 7) !== anchor.slice(0, 7) ? ' is-other' : ''}${d === today ? ' is-today' : ''}`}
                onClick={() => newEvent(d)}
                {...dropOn(d)}
              >
                <span className="month-date">{Number(d.slice(8))}</span>
                {dayTasks.slice(0, shown).map((t) => (
                  <TaskChip key={t.id} task={t} selected={t.id === selectedTask} onSelect={onSelectTask} />
                ))}
                {dayEvents.slice(0, Math.max(0, shown - dayTasks.length)).map((e) => (
                  <EventChip key={e.calendarId + e.id} event={e} onOpen={(event) => setDialog({ kind: 'edit', event })} />
                ))}
                {dayTasks.length + dayEvents.length > shown && <span className="more">還有 {dayTasks.length + dayEvents.length - shown} 項</span>}
              </div>
            )
          })}
        </div>
      ) : (
        <WeekGrid
          range={range}
          today={today}
          tasksOn={tasksOn}
          events={googleEvents}
          selectedTask={selectedTask}
          onSelectTask={onSelectTask}
          onNew={newEvent}
          onOpen={(event) => setDialog({ kind: 'edit', event })}
          dropOn={dropOn}
        />
      )}

      {dialog && (
        <EventDialog
          target={dialog}
          calendars={calendars}
          onClose={() => setDialog(null)}
          onSave={async (input) => {
            await run(async () => {
              if (dialog.kind === 'edit') await desk.calendar.update(dialog.event.calendarId, dialog.event.id, input)
              else await desk.calendar.create(input)
              setDialog(null)
            })
            load()
          }}
          onDelete={async () => {
            if (dialog.kind !== 'edit') return
            await run(async () => {
              await desk.calendar.remove(dialog.event.calendarId, dialog.event.id)
              setDialog(null)
            })
            load()
          }}
        />
      )}
    </div>
  )
}

function TaskChip({ task, selected, onSelect }: { task: Task; selected: boolean; onSelect: (id: string) => void }) {
  return (
    <button
      className={`chip-event chip-task is-${taskState(task)}${selected ? ' is-selected' : ''}`}
      draggable
      onDragStart={(e) => e.dataTransfer.setData(TASK_DRAG, task.id)}
      onClick={(e) => {
        e.stopPropagation()
        onSelect(task.id)
      }}
      title={`待辦：${task.title}`}
    >
      {task.title}
    </button>
  )
}

function EventChip({ event, onOpen }: { event: CalendarEvent; onOpen: (e: CalendarEvent) => void }) {
  return (
    <button
      className={`chip-event chip-google${event.allDay ? ' is-allday' : ''}`}
      onClick={(e) => {
        e.stopPropagation()
        onOpen(event)
      }}
      title={event.title}
    >
      {!event.allDay && <span className="chip-time">{timeLabel(event.start)}</span>}
      {event.title}
    </button>
  )
}

/** 同一天互相重疊的行程排成並排的欄 */
function layoutDay(list: CalendarEvent[], date: string) {
  const base = new Date(`${date}T00:00:00`).getTime()
  const items = list
    .map((e) => {
      const s = Math.max(new Date(e.start).getTime(), base)
      const en = Math.min(new Date(e.end).getTime(), new Date(`${addDays(date, 1)}T00:00:00`).getTime())
      return { e, top: (s - base) / 60000, bottom: Math.max((en - base) / 60000, (s - base) / 60000 + 20), lane: 0, lanes: 1 }
    })
    .sort((a, b) => a.top - b.top)
  const ends: number[] = []
  for (const it of items) {
    let lane = ends.findIndex((end) => end <= it.top)
    if (lane === -1) lane = ends.length
    ends[lane] = it.bottom
    it.lane = lane
  }
  for (const it of items) {
    it.lanes = Math.max(...items.filter((o) => o.top < it.bottom && o.bottom > it.top).map((o) => o.lane)) + 1
  }
  return items
}

function WeekGrid({
  range,
  today,
  tasksOn,
  events,
  selectedTask,
  onSelectTask,
  onNew,
  onOpen,
  dropOn
}: {
  range: { start: string; end: string }
  today: string
  tasksOn: (date: string) => Task[]
  events: CalendarEvent[]
  selectedTask: string | null
  onSelectTask: (id: string) => void
  onNew: (date: string, hour?: number) => void
  onOpen: (e: CalendarEvent) => void
  dropOn: (date: string) => Record<string, (e: React.DragEvent) => void>
}) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(range.start, i))
  const body = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (body.current) body.current.scrollTop = 8 * HOUR_PX // 從早上 8 點開始顯示
  }, [])
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes()

  return (
    <div className="week">
      <div className="week-head">
        <div className="week-gutter" />
        {days.map((d) => (
          <div key={d} className={`week-day${d === today ? ' is-today' : ''}`}>
            {WEEKDAYS[weekday(d)]} <strong>{Number(d.slice(8))}</strong>
          </div>
        ))}
      </div>
      <div className="week-allday">
        <div className="week-gutter">全天</div>
        {days.map((d) => (
          <div key={d} className="week-allday-cell" onClick={() => onNew(d)} {...dropOn(d)}>
            {tasksOn(d).map((t) => (
              <TaskChip key={t.id} task={t} selected={t.id === selectedTask} onSelect={onSelectTask} />
            ))}
            {eventsOn(events, d)
              .filter((e) => e.allDay)
              .map((e) => (
                <EventChip key={e.calendarId + e.id} event={e} onOpen={onOpen} />
              ))}
          </div>
        ))}
      </div>
      <div className="week-body" ref={body}>
        <div className="week-gutter">
          {Array.from({ length: 24 }, (_, h) => (
            <div key={h} className="hour-label" style={{ height: HOUR_PX }}>
              {h > 0 && `${h}:00`}
            </div>
          ))}
        </div>
        {days.map((d) => (
          <div key={d} className="week-col" style={{ height: HOUR_PX * 24 }}>
            {Array.from({ length: 24 }, (_, h) => (
              <div key={h} className="hour-slot" style={{ height: HOUR_PX }} onClick={() => onNew(d, h)} />
            ))}
            {layoutDay(
              eventsOn(events, d).filter((e) => !e.allDay),
              d
            ).map(({ e, top, bottom, lane, lanes }) => (
              <button
                key={e.calendarId + e.id}
                className="week-event chip-google"
                style={{
                  top: (top / 60) * HOUR_PX,
                  height: ((bottom - top) / 60) * HOUR_PX - 2,
                  left: `${(lane / lanes) * 100}%`,
                  width: `${100 / lanes}%`
                }}
                onClick={() => onOpen(e)}
              >
                <span className="chip-time">
                  {timeLabel(e.start)}–{timeLabel(e.end)}
                </span>
                {e.title}
              </button>
            ))}
            {d === today && <div className="now-line" style={{ top: (nowMin / 60) * HOUR_PX }} />}
          </div>
        ))}
      </div>
    </div>
  )
}
