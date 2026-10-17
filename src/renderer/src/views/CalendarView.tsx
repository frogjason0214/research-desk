import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AppStatus, CalendarEvent, CalendarInfo } from '../../../shared/types'
import { EventDialog, toLocalInput, type DialogTarget } from '../components/EventDialog'
import { addDays, daysBetween, todayStr } from '../dates'
import { desk } from '../useDesk'

type Run = (fn: () => Promise<unknown>) => Promise<void>
type Mode = 'month' | 'week'

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']
const HOUR_PX = 44
const HIDDEN_KEY = 'calendar.hidden'

const weekday = (date: string): number => new Date(`${date}T00:00:00`).getDay()
const localDate = (iso: string): string => toLocalInput(iso).slice(0, 10)
const timeLabel = (iso: string): string => toLocalInput(iso).slice(11)

function readHidden(): string[] {
  try {
    return JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? '[]')
  } catch {
    return []
  }
}

function writeHidden(ids: string[]): void {
  try {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify(ids))
  } catch {
    /* 無法儲存就算了 */
  }
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

/** 某一天有哪些行程（跨日的行程每一天都算） */
function onDay(events: CalendarEvent[], date: string): CalendarEvent[] {
  return events.filter((e) =>
    e.allDay ? e.start <= date && date <= e.end : localDate(e.start) <= date && date <= localDate(new Date(new Date(e.end).getTime() - 1).toISOString())
  )
}

export function CalendarView({ status, run }: { status: AppStatus; run: Run }) {
  const g = status.google
  if (!g.configured) {
    return (
      <div className="empty-card">
        <h3>行事曆尚未啟用</h3>
        <p className="muted">這個版本還沒有設定 Google 用戶端。開發者請依 README 的「Google 行事曆設定」建立 .env 後重新建置。</p>
      </div>
    )
  }
  if (g.state !== 'signedIn') {
    return (
      <div className="empty-card">
        <h3>{g.state === 'expired' ? 'Google 登入已過期' : '連接 Google 行事曆'}</h3>
        <p className="muted">
          {g.state === 'expired'
            ? '測試階段的登入大約每 7 天需要重新登入一次。'
            : '登入後可以在這裡查看與編輯行程；有截止日的待辦也會自動出現在「研究任務」行事曆。'}
        </p>
        <button className="btn btn-primary" onClick={() => run(() => desk.google.signIn())}>
          {g.state === 'expired' ? '重新登入 Google' : '登入 Google'}
        </button>
        <p className="muted">會開啟瀏覽器完成登入，完成後回到這裡即可。</p>
      </div>
    )
  }
  return <SignedInCalendar run={run} />
}

function SignedInCalendar({ run }: { run: Run }) {
  const [mode, setMode] = useState<Mode>('month')
  const [anchor, setAnchor] = useState(todayStr())
  const [calendars, setCalendars] = useState<CalendarInfo[]>([])
  const [events, setEvents] = useState<CalendarEvent[]>([])
  const [hidden, setHidden] = useState<string[]>(readHidden)
  const [loading, setLoading] = useState(false)
  const [dialog, setDialog] = useState<DialogTarget | null>(null)
  const range = useMemo(() => rangeOf(mode, anchor), [mode, anchor])

  const load = useCallback(
    () =>
      run(async () => {
        setLoading(true)
        try {
          const [cals, evs] = await Promise.all([desk.calendar.calendars(), desk.calendar.events(range.start, range.end)])
          setCalendars(cals)
          setEvents(evs)
        } finally {
          setLoading(false)
        }
      }),
    [run, range]
  )

  useEffect(() => {
    load()
  }, [load])

  // 待辦改了之後，約幾秒會同步到「研究任務」行事曆，再重新讀一次
  useEffect(() => {
    let timer: number | undefined
    const off = desk.onChanged(() => {
      window.clearTimeout(timer)
      timer = window.setTimeout(load, 6000)
    })
    return () => {
      off()
      window.clearTimeout(timer)
    }
  }, [load])

  const visible = events.filter((e) => !hidden.includes(e.calendarId))
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
    mode === 'month'
      ? `${y} 年 ${m} 月`
      : `${range.start.replace(/-/g, '/')} – ${addDays(range.end, -1).slice(5).replace('-', '/')}`

  const toggleCal = (id: string): void => {
    const next = hidden.includes(id) ? hidden.filter((h) => h !== id) : [...hidden, id]
    setHidden(next)
    writeHidden(next)
  }

  return (
    <div className="calendar">
      <div className="cal-toolbar">
        <button className="btn" onClick={() => setAnchor(todayStr())}>
          今天
        </button>
        <button className="icon-btn" onClick={() => step(-1)} aria-label="上一頁">
          ‹
        </button>
        <button className="icon-btn" onClick={() => step(1)} aria-label="下一頁">
          ›
        </button>
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
        <button className="btn btn-primary" onClick={() => setDialog({ kind: 'new', date: today })}>
          ＋ 新增行程
        </button>
      </div>

      <ul className="cal-legend">
        {calendars.map((c) => (
          <li key={c.id}>
            <label className="check">
              <input type="checkbox" checked={!hidden.includes(c.id)} onChange={() => toggleCal(c.id)} />
              <span className="swatch" style={{ background: c.color }} />
              {c.name}
            </label>
          </li>
        ))}
      </ul>

      {mode === 'month' ? (
        <MonthGrid
          range={range}
          month={anchor.slice(0, 7)}
          today={today}
          events={visible}
          onNew={(date) => setDialog({ kind: 'new', date })}
          onOpen={(event) => setDialog({ kind: 'edit', event })}
        />
      ) : (
        <WeekGrid
          range={range}
          today={today}
          events={visible}
          onNew={(date, hour) => setDialog({ kind: 'new', date, hour })}
          onOpen={(event) => setDialog({ kind: 'edit', event })}
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

function Chip({ event, onOpen }: { event: CalendarEvent; onOpen: (e: CalendarEvent) => void }) {
  return (
    <button
      className={`chip-event${event.allDay ? ' is-allday' : ''}`}
      style={{ ['--c' as string]: event.color }}
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

function MonthGrid({
  range,
  month,
  today,
  events,
  onNew,
  onOpen
}: {
  range: { start: string; end: string }
  month: string
  today: string
  events: CalendarEvent[]
  onNew: (date: string) => void
  onOpen: (e: CalendarEvent) => void
}) {
  const days = Array.from({ length: daysBetween(range.start, range.end) }, (_, i) => addDays(range.start, i))
  return (
    <div className="month">
      {WEEKDAYS.map((w) => (
        <div key={w} className="month-head">
          {w}
        </div>
      ))}
      {days.map((d) => {
        const list = onDay(events, d).sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start.localeCompare(b.start))
        return (
          <div
            key={d}
            className={`month-cell${d.slice(0, 7) !== month ? ' is-other' : ''}${d === today ? ' is-today' : ''}`}
            onClick={() => onNew(d)}
          >
            <span className="month-date">{Number(d.slice(8))}</span>
            {list.slice(0, 3).map((e) => (
              <Chip key={e.calendarId + e.id} event={e} onOpen={onOpen} />
            ))}
            {list.length > 3 && <span className="more">還有 {list.length - 3} 項</span>}
          </div>
        )
      })}
    </div>
  )
}

/** 同一天互相重疊的行程排成並排的欄 */
function layoutDay(list: CalendarEvent[], date: string) {
  const items = list
    .map((e) => {
      const s = Math.max(new Date(e.start).getTime(), new Date(`${date}T00:00:00`).getTime())
      const en = Math.min(new Date(e.end).getTime(), new Date(`${addDays(date, 1)}T00:00:00`).getTime())
      const base = new Date(`${date}T00:00:00`).getTime()
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
  events,
  onNew,
  onOpen
}: {
  range: { start: string; end: string }
  today: string
  events: CalendarEvent[]
  onNew: (date: string, hour?: number) => void
  onOpen: (e: CalendarEvent) => void
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
          <div key={d} className="week-allday-cell" onClick={() => onNew(d)}>
            {onDay(events, d)
              .filter((e) => e.allDay)
              .map((e) => (
                <Chip key={e.calendarId + e.id} event={e} onOpen={onOpen} />
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
              onDay(events, d).filter((e) => !e.allDay),
              d
            ).map(({ e, top, bottom, lane, lanes }) => (
              <button
                key={e.calendarId + e.id}
                className="week-event"
                style={{
                  ['--c' as string]: e.color,
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
