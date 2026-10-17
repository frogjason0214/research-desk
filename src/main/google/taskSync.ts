import { createHash } from 'node:crypto'
import fs from 'node:fs'
import type { Store } from '../store'
import { shiftDate, TASK_PROP, type CalendarApi } from './calendar'
import { AuthExpiredError, GoogleApiError } from './errors'

// 待辦 → 「研究任務」行事曆：有截止日的待辦成為全天事件，改期、完成、刪除都會更新。
// 事件 ID 由待辦 ID 算出來，兩台電腦同時推送也只會有一個事件。
// 每台電腦記住自己推送過的內容（本機檔案），只推送有變的部分。

const DEBOUNCE_MS = 3000

interface TaskRow {
  id: string
  title: string
  due_date: string | null
  done: number
  project: string | null
}

interface Pushed {
  calendarId: string
  entries: Record<string, string>
}

/** Google 事件 ID 只能用 a–v 與 0–9；UUID 去掉連字號後是 0–9a–f，剛好符合 */
export const eventIdForTask = (taskId: string): string => `rdt${taskId.replace(/-/g, '').toLowerCase()}`

function desiredEvent(t: TaskRow): object {
  return {
    summary: `${t.done ? '✓ ' : ''}${t.title}`,
    description: `Research Desk 待辦${t.project ? `・專案：${t.project}` : ''}\n請在 Research Desk 裡修改，這裡的修改會被覆蓋。`,
    start: { date: t.due_date },
    end: { date: shiftDate(t.due_date!, 1) },
    transparency: 'transparent',
    extendedProperties: { private: { [TASK_PROP]: t.id } }
  }
}

export class TaskCalendarSync {
  private timer: NodeJS.Timeout | null = null
  private running: Promise<void> | null = null
  private again = false
  lastError: string | null = null

  constructor(
    private store: Store,
    private api: CalendarApi,
    private file: string,
    private researchCalendar: () => Promise<string>,
    private onCalendarMissing: () => void
  ) {}

  schedule(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.run(), DEBOUNCE_MS)
  }

  run(): Promise<void> {
    if (this.running) {
      this.again = true
      return this.running
    }
    this.running = this.sync()
      .catch((err) => {
        // 行事曆被刪掉了：下次重新建立，並重新推送全部待辦
        if (err instanceof GoogleApiError && err.status === 404) {
          this.onCalendarMissing()
          this.again = true
        }
        this.lastError = err instanceof Error ? err.message : String(err)
        if (!(err instanceof AuthExpiredError)) console.warn('[gcal]', err)
      })
      .finally(() => {
        this.running = null
        if (this.again) {
          this.again = false
          this.schedule()
        }
      })
    return this.running
  }

  private load(calendarId: string): Pushed {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Pushed
      if (data.calendarId === calendarId) return data
    } catch {
      /* 第一次 */
    }
    return { calendarId, entries: {} }
  }

  private save(data: Pushed): void {
    fs.writeFileSync(this.file, JSON.stringify(data))
  }

  private async sync(): Promise<void> {
    const calendarId = await this.researchCalendar()
    const pushed = this.load(calendarId)
    const tasks = this.store.all<TaskRow>(
      `SELECT t.id, t.title, t.due_date, t.done, p.name AS project
       FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
       WHERE t.due_date IS NOT NULL AND (p.id IS NOT NULL)`
    )
    const wanted = new Map(tasks.map((t) => [t.id, t]))

    // 新增或更新
    for (const t of tasks) {
      const body = desiredEvent(t)
      const hash = createHash('sha1').update(JSON.stringify(body)).digest('hex')
      if (pushed.entries[t.id] === hash) continue
      await this.api.put(calendarId, eventIdForTask(t.id), body)
      pushed.entries[t.id] = hash
      this.save(pushed)
    }
    // 待辦被刪除、或拿掉截止日
    for (const id of Object.keys(pushed.entries)) {
      if (wanted.has(id)) continue
      await this.api.remove(calendarId, eventIdForTask(id))
      delete pushed.entries[id]
      this.save(pushed)
    }
    this.lastError = null
  }
}
