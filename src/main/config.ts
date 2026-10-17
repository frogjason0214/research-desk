import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

// 只存在這台電腦的設定（不放雲端資料夾）
export interface LocalConfig {
  /** 這台電腦的編號，決定它的變更紀錄檔名 */
  deviceId: string
  /** 開啟跨電腦同步時的雲端資料夾（…\ResearchDesk）；沒有就是只存本機 */
  syncDir?: string
  currentProjectId?: string
  /** 邊欄小條的垂直位置，0 = 最上方、1 = 最下方 */
  sidebarTop?: number
  /** 這台電腦登入的 Google 帳號裡「研究任務」行事曆的 ID */
  researchCalendarId?: string
  /** 匯入文獻時自動使用 AI（預設開啟） */
  aiAutoFill?: boolean
  /** 每天第一次展開邊欄時產生 AI 每日建議（預設開啟） */
  aiDaily?: boolean
  /** OpenAlex 免費金鑰（選填），推薦新文獻的查詢額度較多 */
  openAlexKey?: string
  /** 舊版設定：使用者選的資料夾，啟動時會轉成 syncDir */
  dataDir?: string
}

const file = (): string => path.join(app.getPath('userData'), 'config.json')

export function loadConfig(): LocalConfig {
  let config: Partial<LocalConfig> = {}
  try {
    config = JSON.parse(fs.readFileSync(file(), 'utf8')) as Partial<LocalConfig>
  } catch {
    /* 第一次啟動 */
  }
  let dirty = false
  if (!config.deviceId) {
    config.deviceId = randomUUID()
    dirty = true
  }
  if (config.dataDir) {
    config.syncDir ??= config.dataDir
    delete config.dataDir
    dirty = true
  }
  if (dirty) saveConfig(config as LocalConfig)
  return config as LocalConfig
}

export function saveConfig(config: LocalConfig): void {
  fs.mkdirSync(path.dirname(file()), { recursive: true })
  fs.writeFileSync(file(), JSON.stringify(config, null, 2))
}
