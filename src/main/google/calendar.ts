import type { CalendarEvent, CalendarInfo, EventInput } from '../../shared/types'
import type { GoogleAuth } from './auth'
import { GoogleApiError } from './errors'

// Google Calendar REST API（直接用 fetch，不引入龐大的 googleapis 套件）

const API = 'https://www.googleapis.com/calendar/v3'
export const RESEARCH_CALENDAR_NAME = '研究任務'
const RESEARCH_MARK = 'Research Desk 自動建立'
const TASK_PROP = 'researchDeskTask'

interface GEvent {
  id: string
  status?: string
  summary?: string
  description?: string
  htmlLink?: string
  colorId?: string
  start: { date?: string; dateTime?: string }
  end: { date?: string; dateTime?: string }
  extendedProperties?: { private?: Record<string, string> }
}

interface GCalendar {
  id: string
  summary: string
  description?: string
  backgroundColor?: string
  primary?: boolean
  selected?: boolean
  accessRole: string
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** YYYY-MM-DD 加減天數 */
export function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d + days))
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`
}

export class CalendarApi {
  constructor(private auth: GoogleAuth) {}

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.auth.fetch(`${API}${path}`, init)
    if (res.status === 204) return undefined as T
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new GoogleApiError(res.status, `Google 行事曆錯誤（${res.status}）：${data.error?.message ?? ''}`)
    return data as T
  }

  private async rawCalendars(): Promise<GCalendar[]> {
    const data = await this.request<{ items: GCalendar[] }>('/users/me/calendarList?maxResults=250')
    return data.items ?? []
  }

  /** 找出「研究任務」行事曆，沒有就建立。先找再建，避免兩台電腦各建一個 */
  async ensureResearchCalendar(): Promise<string> {
    const found = (await this.rawCalendars()).find(
      (c) => c.summary === RESEARCH_CALENDAR_NAME && c.accessRole === 'owner'
    )
    if (found) return found.id
    const created = await this.request<{ id: string }>('/calendars', {
      method: 'POST',
      body: JSON.stringify({
        summary: RESEARCH_CALENDAR_NAME,
        description: `${RESEARCH_MARK}：Research Desk 待辦的截止日。在 App 裡修改待辦即可，這裡的修改會被覆蓋。`
      })
    })
    return created.id
  }

  async calendars(researchId: string | null): Promise<CalendarInfo[]> {
    return (await this.rawCalendars())
      .filter((c) => c.selected || c.primary || c.id === researchId)
      .map((c) => ({
        id: c.id,
        name: c.primary ? '我的行事曆' : c.summary,
        color: c.backgroundColor ?? '#4f6d7a',
        primary: !!c.primary,
        research: c.id === researchId,
        writable: c.accessRole === 'owner' || c.accessRole === 'writer'
      }))
  }

  /** 讀取多個行事曆在 [from, to)（YYYY-MM-DD，本地時間）之間的行程 */
  async events(cals: CalendarInfo[], from: string, to: string): Promise<CalendarEvent[]> {
    const timeMin = new Date(`${from}T00:00:00`).toISOString()
    const timeMax = new Date(`${to}T00:00:00`).toISOString()
    const lists = await Promise.all(
      cals.map(async (cal) => {
        const q = new URLSearchParams({ timeMin, timeMax, singleEvents: 'true', orderBy: 'startTime', maxResults: '2500' })
        const data = await this.request<{ items: GEvent[] }>(`/calendars/${encodeURIComponent(cal.id)}/events?${q}`)
        return (data.items ?? []).filter((e) => e.status !== 'cancelled').map((e) => toEvent(e, cal))
      })
    )
    return lists.flat()
  }

  async create(input: EventInput): Promise<void> {
    await this.request(`/calendars/${encodeURIComponent(input.calendarId)}/events`, {
      method: 'POST',
      body: JSON.stringify(fromInput(input))
    })
  }

  async update(calendarId: string, id: string, input: EventInput): Promise<void> {
    const path = `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(id)}`
    if (input.calendarId !== calendarId) {
      // 換行事曆：先搬過去再更新內容
      await this.request(`${path}/move?destination=${encodeURIComponent(input.calendarId)}`, { method: 'POST' })
      return this.update(input.calendarId, id, input)
    }
    await this.request(path, { method: 'PATCH', body: JSON.stringify(fromInput(input)) })
  }

  async remove(calendarId: string, id: string): Promise<void> {
    try {
      await this.request(`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(id)}`, {
        method: 'DELETE'
      })
    } catch (err) {
      // 已經刪除過就當作成功
      if (!(err instanceof GoogleApiError && (err.status === 404 || err.status === 410))) throw err
    }
  }

  /** 以固定 ID 寫入事件：存在（或已刪除）就整筆更新，否則新增 */
  async put(calendarId: string, id: string, body: object): Promise<void> {
    const path = `/calendars/${encodeURIComponent(calendarId)}/events`
    const full = JSON.stringify({ ...body, id, status: 'confirmed' })
    try {
      await this.request(`${path}/${id}`, { method: 'PUT', body: full })
    } catch (err) {
      if (!(err instanceof GoogleApiError && err.status === 404)) throw err
      await this.request(path, { method: 'POST', body: full })
    }
  }
}

export { TASK_PROP }

function toEvent(e: GEvent, cal: CalendarInfo): CalendarEvent {
  const allDay = !!e.start.date
  const taskId = e.extendedProperties?.private?.[TASK_PROP] ?? null
  return {
    id: e.id,
    calendarId: cal.id,
    title: e.summary ?? '（沒有標題）',
    description: e.description ?? '',
    allDay,
    start: allDay ? e.start.date! : e.start.dateTime!,
    end: allDay ? shiftDate(e.end.date!, -1) : e.end.dateTime!,
    color: cal.color,
    taskId,
    writable: cal.writable && !taskId,
    link: e.htmlLink ?? null
  }
}

function fromInput(input: EventInput): object {
  const title = input.title.trim()
  if (!title) throw new Error('行程名稱不能是空白')
  const base = { summary: title, description: input.description }
  if (input.allDay) {
    if (input.end < input.start) throw new Error('結束日期不能早於開始日期')
    return { ...base, start: { date: input.start }, end: { date: shiftDate(input.end, 1) } }
  }
  const start = new Date(input.start)
  const end = new Date(input.end)
  if (!(end > start)) throw new Error('結束時間必須晚於開始時間')
  return { ...base, start: { dateTime: start.toISOString() }, end: { dateTime: end.toISOString() } }
}
