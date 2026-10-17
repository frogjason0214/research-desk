import { app, BrowserWindow, dialog, ipcMain, screen, shell } from 'electron'
import path from 'node:path'
import type { AppStatus, SidebarLayout } from '../shared/types'
import { detectCloudFolders } from './cloud'
import { loadConfig, saveConfig, type LocalConfig } from './config'
import { createDataHandlers } from './handlers'
import { Library, LIBRARY_FOLDER, type AttachChoice, type AttachResult } from './library'
import { Store } from './store'

const SIDEBAR_EXPANDED = 320
const SIDEBAR_COLLAPSED = 28
const COLLAPSE_DELAY_MS = 700 // 滑鼠離開多久後收合
const CURSOR_POLL_MS = 50
const SYNC_INTERVAL_MS = 20 * 1000

let sidebar: BrowserWindow | null = null
let full: BrowserWindow | null = null
let config: LocalConfig
let store: Store
let library: Library

// ---------- 視窗 ----------

function loadView(win: BrowserWindow, view: 'sidebar' | 'full'): void {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) win.loadURL(`${devUrl}#/${view}`)
  else win.loadFile(path.join(__dirname, '../renderer/index.html'), { hash: `/${view}` })
}

const webPreferences = (): Electron.WebPreferences => ({
  preload: path.join(__dirname, '../preload/index.js'),
  contextIsolation: true,
  nodeIntegration: false
})

// 邊欄視窗是一塊透明的長條（展開寬度 × 螢幕高度），畫面上的面板只佔其中一段；
// 只有面板所在的範圍接收滑鼠，其他透明的部分點擊會穿透到下面的視窗。
function sidebarBounds(): Electron.Rectangle {
  const area = screen.getPrimaryDisplay().workArea
  return { x: area.x + area.width - SIDEBAR_EXPANDED, y: area.y, width: SIDEBAR_EXPANDED, height: area.height }
}

let layout: SidebarLayout = { expanded: false, top: 0, height: 0, dragging: false }
let ignoring = true

function setIgnoring(ignore: boolean): void {
  if (ignore === ignoring) return
  ignoring = ignore
  sidebar?.setIgnoreMouseEvents(ignore)
}

/**
 * 由主程式定時看滑鼠位置，決定展開、收合，以及透明部分要不要讓滑鼠穿透。
 * 不依賴網頁的 mouseleave：滑鼠移動很快或移出透明視窗時，Windows 常常不會送出這個事件。
 */
function watchCursor(): void {
  let outsideSince: number | null = null
  setInterval(() => {
    if (!sidebar) return
    const p = screen.getCursorScreenPoint()
    const b = sidebar.getBounds()
    const right = b.x + b.width
    const top = b.y + layout.top
    const inY = p.y >= top && p.y < top + layout.height
    if (layout.dragging) return // 拖曳中不改變任何狀態
    if (!layout.expanded) {
      outsideSince = null
      setIgnoring(true)
      if (inY && p.x >= right - SIDEBAR_COLLAPSED && p.x < right) sidebar.webContents.send('sidebar:enter')
      return
    }
    const inside = inY && p.x >= b.x && p.x < right
    setIgnoring(!inside)
    if (inside) {
      outsideSince = null
      return
    }
    const now = Date.now()
    if (outsideSince === null) outsideSince = now
    else if (now - outsideSince >= COLLAPSE_DELAY_MS) {
      outsideSince = now // 畫面決定不收合（固定、輸入到一半）時，之後再問一次
      sidebar.webContents.send('sidebar:leave')
    }
  }, CURSOR_POLL_MS)
}

function createSidebar(): void {
  sidebar = new BrowserWindow({
    ...sidebarBounds(),
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    backgroundColor: '#00000000',
    transparent: true,
    webPreferences: webPreferences()
  })
  sidebar.setAlwaysOnTop(true, 'floating')
  sidebar.setIgnoreMouseEvents(true)
  sidebar.once('ready-to-show', () => sidebar?.showInactive())
  sidebar.on('closed', () => (sidebar = null))
  loadView(sidebar, 'sidebar')
}

function openFull(): void {
  if (full) {
    full.show()
    full.focus()
    return
  }
  full = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 820,
    minHeight: 560,
    title: 'Research Desk',
    autoHideMenuBar: true,
    show: false,
    webPreferences: webPreferences()
  })
  full.once('ready-to-show', () => full?.show())
  full.on('closed', () => (full = null))
  loadView(full, 'full')
}

function broadcastChanged(): void {
  BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('desk:changed'))
}

// ---------- 資料與同步 ----------

function status(): AppStatus {
  return {
    sync: {
      enabled: !!library.cloudDir,
      dir: library.cloudDir,
      available: library.available,
      otherDevices: library.otherDevices(),
      lastSyncAt: library.lastSyncAt
    },
    dataDir: library.dataDir,
    currentProjectId: config.currentProjectId ?? null,
    launchAtLogin: app.getLoginItemSettings().openAtLogin,
    sidebarTop: config.sidebarTop ?? 0.5,
    version: app.getVersion()
  }
}

// ---------- IPC ----------

function registerIpc(): void {
  const data = createDataHandlers(store) as Record<string, (...args: never[]) => unknown>

  const handlers: Record<string, (...args: never[]) => unknown> = {
    ...data,
    status,
    'sync.candidates': () => detectCloudFolders(),
    'sync.pickFolder': async () => {
      const result = await dialog.showOpenDialog({
        title: '選擇要存放研究資料的雲端硬碟資料夾',
        defaultPath: process.env.OneDrive ?? app.getPath('documents'),
        properties: ['openDirectory', 'createDirectory']
      })
      return result.canceled ? null : (result.filePaths[0] ?? null)
    },
    'sync.enable': async (folder: string, choice?: AttachChoice): Promise<AttachResult> => {
      // 使用者選雲端硬碟的根目錄時，在裡面建立 ResearchDesk 子資料夾
      const dir = path.basename(folder) === LIBRARY_FOLDER ? folder : path.join(folder, LIBRARY_FOLDER)
      const result = await library.attach(dir, choice)
      if (result === 'done') {
        config.syncDir = dir
        config.deviceId = library.deviceId // 選「改用雲端資料」時會換新的編號
        saveConfig(config)
        broadcastChanged()
      }
      return result
    },
    'sync.disable': async () => {
      await library.detach()
      delete config.syncDir
      saveConfig(config)
      broadcastChanged()
    },
    'sync.now': async () => {
      await library.sync()
      broadcastChanged()
      return status()
    },
    'projects.setCurrent': (id: string) => {
      config.currentProjectId = id
      saveConfig(config)
      broadcastChanged()
    },
    'settings.openDataDir': () => shell.openPath(library.dataDir),
    'settings.setLaunchAtLogin': (on: boolean) => {
      app.setLoginItemSettings({ openAtLogin: on })
      broadcastChanged()
    }
  }

  ipcMain.handle('desk:call', async (_event, method: string, args: unknown[]) => {
    const fn = handlers[method]
    if (!fn) throw new Error(`未知的操作：${method}`)
    return (fn as (...a: unknown[]) => unknown)(...args)
  })

  ipcMain.handle('window:setSidebarLayout', (_event, next: SidebarLayout) => {
    layout = next
    if (!next.expanded) setIgnoring(true)
  })
  ipcMain.handle('window:saveSidebarTop', (_event, ratio: number) => {
    config.sidebarTop = Math.min(1, Math.max(0, ratio))
    saveConfig(config)
  })
  ipcMain.handle('window:openFull', () => openFull())
  ipcMain.handle('window:closeFull', () => full?.close())
  ipcMain.handle('window:quit', () => app.quit())
}

// ---------- 啟動 ----------

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => openFull())

  app.whenReady().then(async () => {
    config = loadConfig()

    // 資料一律先存在這台電腦；開啟同步後再和雲端資料夾交換
    library = new Library(path.join(app.getPath('userData'), 'library'), config.deviceId)
    if (config.syncDir) await library.connect(config.syncDir)

    store = new Store(library)
    await store.open()
    store.onChange(broadcastChanged)

    registerIpc()
    createSidebar()

    // 定期檢查其他電腦的修改；雲端資料夾消失或恢復時更新畫面上的提示
    let wasAvailable = library.available
    setInterval(async () => {
      await library.sync()
      if (library.available !== wasAvailable) {
        wasAvailable = library.available
        broadcastChanged()
      }
    }, SYNC_INTERVAL_MS)

    watchCursor()
    screen.on('display-metrics-changed', () => sidebar?.setBounds(sidebarBounds()))
  })

  // 關掉完整視窗時，邊欄仍然常駐
  app.on('window-all-closed', () => {
    /* 不自動結束，從設定頁的「結束程式」離開 */
  })

  // 結束前把還沒上傳的修改寫進雲端資料夾
  let flushed = false
  app.on('before-quit', (event) => {
    if (flushed || !library) return
    event.preventDefault()
    library.flush().finally(() => {
      flushed = true
      app.quit()
    })
  })
}
