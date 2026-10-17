import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateStatus } from '../shared/types'

// 自動更新：安裝版啟動時向 GitHub Releases 檢查新版本，背景下載，下載完提示重新啟動。
// 開發模式（npm run dev）不檢查。

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000

export function createUpdater(opts: { onChange: () => void; beforeInstall: () => Promise<void> }) {
  let status: UpdateStatus = { state: app.isPackaged ? 'idle' : 'dev' }
  const set = (next: UpdateStatus): void => {
    status = next
    opts.onChange()
  }

  if (app.isPackaged) {
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.on('checking-for-update', () => set({ state: 'checking' }))
    autoUpdater.on('update-not-available', () => set({ state: 'latest' }))
    autoUpdater.on('update-available', (info) => set({ state: 'downloading', version: info.version, progress: 0 }))
    autoUpdater.on('download-progress', (p) =>
      set({ state: 'downloading', version: status.version, progress: Math.round(p.percent) })
    )
    autoUpdater.on('update-downloaded', (info) => set({ state: 'ready', version: info.version }))
    autoUpdater.on('error', (err) => set({ state: 'error', error: err.message.split('\n')[0] }))

    const check = (): void => void autoUpdater.checkForUpdates().catch(() => {})
    setTimeout(check, 10_000)
    setInterval(check, CHECK_EVERY_MS)
  }

  return {
    status: () => status,
    check: async (): Promise<void> => {
      if (!app.isPackaged) return
      await autoUpdater.checkForUpdates()
    },
    install: async (): Promise<void> => {
      if (status.state !== 'ready') return
      await opts.beforeInstall()
      autoUpdater.quitAndInstall()
    }
  }
}
