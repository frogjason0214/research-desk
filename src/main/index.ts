import { app, BrowserWindow, dialog, ipcMain, net, protocol, screen, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AiStatus, AppStatus, Focus, PdfAnnotOp, SidebarLayout } from '../shared/types'
import { createProfessor } from './ai/professor'
import { Gemini, GEMINI_MODEL } from './ai/gemini'
import { Translator } from './ai/translate'
import { createPapers } from './papers'
import { Organizer } from './papers/organizer'
import { createReader } from './papers/reader'
import { detectCloudFolders } from './cloud'
import { loadConfig, saveConfig, type LocalConfig } from './config'
import { createGoogle } from './google'
import { createDataHandlers } from './handlers'
import { createMindmapHandlers } from './mindmaps'
import { ATTACHMENTS, createNotesHandlers, IMAGE_SCHEME, imageType, NotesMirror } from './notes'
import { Library, LIBRARY_FOLDER, type AttachChoice, type AttachResult } from './library'
import { Store } from './store'
import { createUpdater } from './updater'

const SIDEBAR_EXPANDED = 320
const SIDEBAR_COLLAPSED = 28
const COLLAPSE_DELAY_MS = 700 // 滑鼠離開多久後收合
const CURSOR_POLL_MS = 50
const SYNC_INTERVAL_MS = 20 * 1000
/** Mac 版目前只存本機：不開跨電腦同步，也不建 Windows 捷徑 */
const IS_MAC = process.platform === 'darwin'

let sidebar: BrowserWindow | null = null
let full: BrowserWindow | null = null
let config: LocalConfig
let store: Store
let library: Library
let google: ReturnType<typeof createGoogle>
let updater: ReturnType<typeof createUpdater>
let gemini: Gemini
let translator: Translator
let papers: ReturnType<typeof createPapers>
let reader: ReturnType<typeof createReader> | undefined
let professor: ReturnType<typeof createProfessor>
let flushed = false

/** 結束前把還沒上傳的修改寫進雲端資料夾 */
async function flushBeforeQuit(): Promise<void> {
  if (flushed) return
  await reader?.flush().catch(() => {})
  await library?.flush().catch(() => {})
  flushed = true
}

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
    if (!sidebar || !sidebar.isVisible()) return
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
  // Mac：切換桌面或其他 App 全螢幕時也看得到邊欄
  if (IS_MAC) sidebar.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  sidebar.setIgnoreMouseEvents(true)
  sidebar.once('ready-to-show', () => updateSidebarVisibility())
  sidebar.on('closed', () => (sidebar = null))
  loadView(sidebar, 'sidebar')
}

/** 完整視窗在畫面上時把邊欄藏起來；完整視窗關掉或最小化時，邊欄回到右側細條 */
function updateSidebarVisibility(): void {
  if (!sidebar) return
  const fullOnScreen = !!full && full.isVisible() && !full.isMinimized()
  if (fullOnScreen) {
    if (sidebar.isVisible()) sidebar.hide()
  } else if (!sidebar.isVisible()) {
    sidebar.showInactive()
  }
}

/** 開啟完整視窗；給 focus 時跳到指定的頁面（例如從邊欄的每日建議跳到對話） */
function openFull(focus?: Focus): void {
  if (full) {
    if (full.isMinimized()) full.restore()
    full.show()
    full.focus()
    if (focus) full.webContents.send('desk:navigate', focus)
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
  full.on('show', updateSidebarVisibility)
  full.on('hide', updateSidebarVisibility)
  full.on('minimize', updateSidebarVisibility)
  full.on('restore', updateSidebarVisibility)
  if (focus) full.webContents.once('did-finish-load', () => full?.webContents.send('desk:navigate', focus))
  full.on('closed', () => {
    full = null
    updateSidebarVisibility()
  })
  // 畫面裡的外部連結（例如「在 Google 日曆開啟」）用預設瀏覽器開
  full.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url)
    return { action: 'deny' }
  })
  loadView(full, 'full')
}

function broadcastChanged(): void {
  BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('desk:changed'))
}

// ---------- 資料與同步 ----------

function status(): AppStatus {
  return {
    sync: {
      supported: !IS_MAC,
      enabled: !!library.cloudDir,
      dir: library.cloudDir,
      available: library.available,
      otherDevices: library.otherDevices(),
      lastSyncAt: library.lastSyncAt
    },
    google: google.status(),
    update: updater.status(),
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
  const mindmaps = createMindmapHandlers(store)
  // 會讀寫任意路徑的函式不直接開放給畫面，只透過下面的存檔／開檔視窗使用
  const { exportMarkdown, readMarkdown, purgeOldTrash, ...notes } = createNotesHandlers(store, library)
  purgeOldTrash()

  const handlers: Record<string, (...args: never[]) => unknown> = {
    ...data,
    ...(google.handlers as Record<string, (...args: never[]) => unknown>),
    ...(papers.handlers as Record<string, (...args: never[]) => unknown>),
    ...(mindmaps as Record<string, (...args: never[]) => unknown>),
    ...(notes as Record<string, (...args: never[]) => unknown>),
    'notes.exportMd': async (pageId: string, title: string): Promise<boolean> => {
      // 自動化測試用：直接存到指定位置，不跳存檔視窗
      const testPath = process.env.RESEARCH_DESK_EXPORT_PATH
      const result = testPath
        ? { canceled: false, filePath: testPath }
        : await dialog.showSaveDialog({
            title: '匯出筆記',
            defaultPath: path.join(app.getPath('documents'), `${title.replace(/[\\/:*?"<>|]/g, '_') || '未命名'}.md`),
            filters: [{ name: 'Markdown', extensions: ['md'] }]
          })
      if (result.canceled || !result.filePath) return false
      const file = exportMarkdown(pageId, result.filePath)
      if (!testPath) shell.showItemInFolder(file)
      return true
    },
    'notes.pickMd': async (): Promise<{ name: string; markdown: string }[]> => {
      const testPaths = process.env.RESEARCH_DESK_IMPORT_PATHS
      const files = testPaths
        ? testPaths.split('|')
        : (
            await dialog.showOpenDialog({
              title: '匯入 Markdown',
              filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'txt'] }],
              properties: ['openFile', 'multiSelections']
            })
          ).filePaths
      return files.map(readMarkdown)
    },
    // 刪除專案時連同文獻的檔案、心智圖、筆記一起刪
    'projects.remove': (id: string) => {
      for (const p of store.all<{ id: string }>('SELECT id FROM papers WHERE project_id = ?', [id])) {
        papers.handlers['papers.remove'](p.id)
        reader?.forget(p.id)
      }
      for (const m of store.all<{ id: string }>('SELECT id FROM mindmaps WHERE project_id = ?', [id]))
        mindmaps['mindmaps.remove'](m.id)
      for (const p of store.all<{ id: string }>('SELECT id FROM note_pages WHERE project_id = ? AND parent_id IS NULL', [id]))
        notes['notes.purge'](p.id)
      // 上層已經不在的頁面（例如兩台電腦同時搬動）也一起清掉
      for (const p of store.all<{ id: string }>('SELECT id FROM note_pages WHERE project_id = ?', [id])) notes['notes.purge'](p.id)
      for (const c of store.all<{ id: string }>('SELECT id FROM conversations WHERE project_id = ?', [id]))
        professor.handlers['professor.remove'](c.id)
      const tips = store.all<{ id: string }>('SELECT id FROM daily_tips WHERE project_id = ?', [id])
      if (tips.length) store.write((tx) => tips.forEach((t) => tx.remove('daily_tips', t.id)))
      return (data['projects.remove'] as (id: string) => void)(id)
    },
    'papers.remove': (id: string) => {
      papers.handlers['papers.remove'](id)
      reader?.forget(id)
    },
    'reader.open': (paperId: string) => reader!.open(paperId),
    'reader.queue': (paperId: string, ops: PdfAnnotOp[]) => reader!.queue(paperId, ops),
    'reader.status': (paperId: string) => reader!.status(paperId),
    'reader.restore': (paperId: string) => reader!.restore(paperId),
    'mindmaps.saveImage': async (name: string, dataUrl: string): Promise<boolean> => {
      // 自動化測試用：直接存到指定位置，不跳存檔視窗
      const testPath = process.env.RESEARCH_DESK_EXPORT_PATH
      const result = testPath ? { canceled: false, filePath: testPath } : await dialog.showSaveDialog({
        title: '匯出心智圖',
        defaultPath: path.join(app.getPath('documents'), `${name.replace(/[\\/:*?"<>|]/g, '_')}.png`),
        filters: [{ name: 'PNG 圖片', extensions: ['png'] }]
      })
      if (result.canceled || !result.filePath) return false
      await fs.promises.writeFile(result.filePath, Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64'))
      if (!testPath) shell.showItemInFolder(result.filePath)
      return true
    },
    ...(professor.handlers as Record<string, (...args: never[]) => unknown>),
    'ai.status': (): AiStatus => ({
      hasKey: gemini.hasKey,
      model: GEMINI_MODEL,
      autoFill: config.aiAutoFill ?? true,
      daily: config.aiDaily ?? true,
      hasOpenAlexKey: !!config.openAlexKey
    }),
    'calendar.hidden': () => config.calendarHidden ?? [],
    'calendar.setHidden': (ids: string[]) => {
      config.calendarHidden = ids
      saveConfig(config)
    },
    'ai.setDaily': (on: boolean) => {
      config.aiDaily = on
      saveConfig(config)
    },
    'ai.setOpenAlexKey': (key: string) => {
      config.openAlexKey = key.trim() || undefined
      saveConfig(config)
    },
    'translate.status': () => ({ hasKey: translator.hasKey }),
    'translate.setKey': (key: string) => translator.setKey(key),
    'translate.clearKey': () => translator.clearKey(),
    'translate.text': (text: string) => translator.translate(text),
    'ai.setKey': (key: string) => gemini.setKey(key),
    'ai.clearKey': () => gemini.clearKey(),
    'ai.setAutoFill': (on: boolean) => {
      config.aiAutoFill = on
      saveConfig(config)
    },
    status,
    'update.check': () => updater.check(),
    'update.install': () => updater.install(),
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
      if (IS_MAC) throw new Error('Mac 版目前只存在這台電腦，不支援跨電腦同步。')
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
  ipcMain.handle('window:openFull', (_event, focus?: Focus) => openFull(focus))
  ipcMain.handle('window:closeFull', () => full?.close())
  ipcMain.handle('window:quit', () => app.quit())
}

// ---------- 啟動 ----------

// 自動化測試用：指定另一個資料夾，不碰使用者真正的資料
if (process.env.RESEARCH_DESK_USER_DATA) app.setPath('userData', process.env.RESEARCH_DESK_USER_DATA)

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => openFull())
  // Mac：點 Dock 圖示時打開完整視窗
  app.on('activate', () => openFull())

  app.whenReady().then(async () => {
    config = loadConfig()

    // 資料一律先存在這台電腦；開啟同步後再和雲端資料夾交換
    library = new Library(path.join(app.getPath('userData'), 'library'), config.deviceId)
    if (config.syncDir && !IS_MAC) await library.connect(config.syncDir)

    store = new Store(library)
    await store.open()
    store.onChange(broadcastChanged)

    updater = createUpdater({ onChange: broadcastChanged, beforeInstall: flushBeforeQuit })

    gemini = new Gemini(path.join(app.getPath('userData'), 'gemini-key.bin'))
    translator = new Translator(path.join(app.getPath('userData'), 'translate-key.bin'))
    papers = createPapers({
      store,
      library,
      gemini,
      autoFill: () => config.aiAutoFill ?? true,
      onChange: broadcastChanged
    })
    // PDF 閱讀器：螢光筆與便利貼寫回文獻原本的 PDF
    reader = createReader({
      library,
      locate: (id) => papers.locatePdf(id),
      pendingFile: path.join(app.getPath('userData'), 'reader-pending.json'),
      emit: (s) => BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('reader:status', s))
    })
    // 文獻檔案依心智圖節點整理；資料變動後幾秒執行一次
    const organizer = new Organizer(store, library, (link, target) => {
      if (process.platform !== 'win32') return // 捷徑（.lnk）只有 Windows 有
      try {
        if (shell.readShortcutLink(link).target === target) return // 已經是對的就不重寫，避免雲端硬碟一直同步
      } catch {
        /* 還沒有捷徑 */
      }
      fs.mkdirSync(path.dirname(link), { recursive: true })
      shell.writeShortcutLink(link, 'replace', { target })
    })
    store.onChange(() => organizer.schedule())
    organizer.schedule()
    // 筆記的 Markdown 副本
    const mirror = new NotesMirror(store, library)
    store.onChange(() => mirror.schedule())
    mirror.schedule()
    // 筆記裡的圖片：desk-note:附件/xxx.png → 筆記資料夾裡的檔案
    protocol.handle(IMAGE_SCHEME, (req) => {
      const rel = decodeURIComponent(req.url.slice(IMAGE_SCHEME.length + 1)).replace(/^\/+/, '')
      const parts = rel.split('/')
      const file = parts.length === 2 && parts[0] === ATTACHMENTS && !rel.includes('..') && imageType(rel) ? library.resolveNote(rel) : null
      return file ? net.fetch(pathToFileURL(file).toString()) : new Response('找不到圖片', { status: 404 })
    })

    professor = createProfessor({
      store,
      gemini,
      search: (projectId, query, limit) => papers.searchForAi(projectId, query, limit),
      openAlexKey: () => config.openAlexKey,
      dailyEnabled: () => config.aiDaily ?? true,
      // 回覆逐步送給所有視窗（邊欄與完整視窗都可能在看）
      emit: (s) => BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('ai:stream', s))
    })

    google = createGoogle({
      store,
      userData: app.getPath('userData'),
      config,
      saveConfig: () => saveConfig(config),
      onChange: broadcastChanged
    })

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
  app.on('before-quit', (event) => {
    if (flushed || !library) return
    event.preventDefault()
    flushBeforeQuit().finally(() => app.quit())
  })
}
