import path from 'node:path'
import type { CalendarInfo, EventInput } from '../../shared/types'
import type { LocalConfig } from '../config'
import type { Store } from '../store'
import { GoogleAuth } from './auth'
import { CalendarApi } from './calendar'
import { AuthExpiredError, GoogleApiError } from './errors'
import { TaskCalendarSync } from './taskSync'

const RESYNC_MS = 10 * 60 * 1000

/** 把 Google 登入、行事曆讀寫與待辦同步組在一起，提供給主程式的 IPC */
export function createGoogle(opts: {
  store: Store
  userData: string
  config: LocalConfig
  saveConfig: () => void
  onChange: () => void
}) {
  const { store, config } = opts
  const auth = new GoogleAuth(path.join(opts.userData, 'google-token.bin'))
  const api = new CalendarApi(auth)

  const researchCalendar = async (): Promise<string> => {
    if (config.researchCalendarId) return config.researchCalendarId
    config.researchCalendarId = await api.ensureResearchCalendar()
    opts.saveConfig()
    return config.researchCalendarId
  }

  // 「研究任務」行事曆被使用者在 Google 刪掉時，忘掉舊的 ID，下次重新找或建立
  const forgetResearchCalendar = (): void => {
    delete config.researchCalendarId
    opts.saveConfig()
  }

  const withResearchRetry = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn()
    } catch (err) {
      if (err instanceof GoogleApiError && err.status === 404 && config.researchCalendarId) {
        forgetResearchCalendar()
        return fn()
      }
      throw err
    }
  }

  const taskSync = new TaskCalendarSync(
    store,
    api,
    path.join(opts.userData, 'gcal-tasks.json'),
    researchCalendar,
    forgetResearchCalendar
  )

  auth.onChange(() => {
    if (auth.signedIn) taskSync.schedule()
    opts.onChange()
  })
  store.onChange(() => auth.signedIn && taskSync.schedule())
  setInterval(() => auth.signedIn && taskSync.run(), RESYNC_MS)
  if (auth.signedIn) taskSync.schedule()

  const calendars = async (): Promise<CalendarInfo[]> => {
    const researchId = await researchCalendar()
    return api.calendars(researchId)
  }

  // 呼叫 API 時發現登入過期，通知畫面更新提示
  const guard = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn()
    } catch (err) {
      if (err instanceof AuthExpiredError) opts.onChange()
      throw err
    }
  }

  return {
    status: () => ({ ...auth.status(), taskSyncError: taskSync.lastError }),
    handlers: {
      'google.signIn': () => auth.signIn(),
      'google.signOut': () => {
        auth.signOut()
        forgetResearchCalendar()
      },
      'calendar.calendars': () => guard(() => withResearchRetry(calendars)),
      'calendar.events': (from: string, to: string) =>
        guard(() => withResearchRetry(async () => api.events(await calendars(), from, to))),
      'calendar.create': (input: EventInput) => guard(() => api.create(input)),
      'calendar.update': (calendarId: string, id: string, input: EventInput) =>
        guard(() => api.update(calendarId, id, input)),
      'calendar.remove': (calendarId: string, id: string) => guard(() => api.remove(calendarId, id))
    }
  }
}
