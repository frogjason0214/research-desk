import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Clock } from './clock'
import { readLegacyRows, TABLES } from './schema'

// 資料的真正來源：每台電腦只寫自己的變更紀錄檔 changes/<裝置編號>.jsonl，
// 讀取時合併所有電腦的紀錄，同一個欄位以時間戳最晚的為準。
// 因為每個檔案只有一台電腦會寫，雲端硬碟不會產生衝突副本，也就不需要鎖定。
//
// 資料夾結構（本機與雲端相同）：
//   changes/   每台電腦一個 .jsonl
//   files/     PDF、網頁快照（寫入後不再修改）
//
// 本機資料夾永遠保有所有紀錄的完整副本；開啟同步時，雲端資料夾是各台電腦交換紀錄的地方。
// 雲端資料夾暫時找不到時照常使用本機副本，恢復後自動補上。

export const LIBRARY_FOLDER = 'ResearchDesk'
const CHANGES = 'changes'
const FILES = 'files'
const LEGACY_DB = 'research-desk.sqlite'
const LEGACY_LOCK = 'research-desk.lock'
const COMPACT_MIN_LINES = 2000

export interface Op {
  tb: string
  id: string
  f: string
  v: unknown
  ts: string
}

interface Cell {
  v: unknown
  ts: string
}
export type Row = Map<string, Cell>
export type State = Map<string, Map<string, Row>>

export type AttachResult = 'done' | 'needsChoice'
export type AttachChoice = 'merge' | 'discard'

// ---------- 檔案工具 ----------

const isDir = (p: string): boolean => {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

const sizeOf = (p: string): number => {
  try {
    return fs.statSync(p).size
  } catch {
    return 0
  }
}

const readText = (p: string): string => {
  try {
    return fs.readFileSync(p, 'utf8')
  } catch {
    return ''
  }
}

/** 先寫暫存檔再改名，雲端硬碟不會同步到寫一半的檔案 */
function writeAtomic(dest: string, text: string): void {
  const tmp = `${dest}.tmp`
  fs.writeFileSync(tmp, text)
  fs.renameSync(tmp, dest)
}

function listLogs(dir: string): string[] {
  try {
    return fs.readdirSync(path.join(dir, CHANGES)).filter((n) => n.endsWith('.jsonl'))
  } catch {
    return []
  }
}

function parseLog(text: string): Op[] {
  const ops: Op[] = []
  for (const line of text.split('\n')) {
    if (!line) continue
    try {
      const op = JSON.parse(line) as Op
      if (typeof op.tb === 'string' && typeof op.id === 'string' && typeof op.f === 'string' && typeof op.ts === 'string')
        ops.push(op)
    } catch {
      /* 同步到一半的最後一行，下次讀取時就會完整 */
    }
  }
  return ops
}

const serialize = (ops: Op[]): string => ops.map((o) => JSON.stringify(o) + '\n').join('')

/** 資料夾裡是否已經有研究資料（新格式或舊版資料庫） */
export function hasLibraryData(dir: string, exceptDevice?: string): boolean {
  if (fs.existsSync(path.join(dir, LEGACY_DB))) return true
  return listLogs(dir).some((n) => n !== `${exceptDevice}.jsonl` && sizeOf(path.join(dir, CHANGES, n)) > 0)
}

function copyMissingFiles(from: string, to: string): void {
  if (!isDir(from)) return
  fs.mkdirSync(to, { recursive: true })
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name)
    const dest = path.join(to, entry.name)
    if (entry.isDirectory()) copyMissingFiles(src, dest)
    else if (!fs.existsSync(dest)) fs.copyFileSync(src, dest)
  }
}

// ---------- 資料庫 ----------

export class Library {
  state: State = new Map()
  clock: Clock
  cloudDir: string | null = null
  lastSyncAt: number | null = null
  private pushNeeded = true
  private seen = new Map<string, string>()
  private listeners = new Set<() => void>()
  private pushTimer: NodeJS.Timeout | null = null
  private syncing: Promise<boolean> | null = null
  private migrated = new Set<string>()

  constructor(
    private localDir: string,
    public deviceId: string
  ) {
    this.clock = new Clock(deviceId)
    fs.mkdirSync(path.join(localDir, CHANGES), { recursive: true })
    fs.mkdirSync(path.join(localDir, FILES), { recursive: true })
    if (!fs.existsSync(this.ownLocal)) fs.writeFileSync(this.ownLocal, '')
    this.rebuild()
    this.compactOwn()
  }

  private get ownName(): string {
    return `${this.deviceId}.jsonl`
  }

  private get ownLocal(): string {
    return path.join(this.localDir, CHANGES, this.ownName)
  }

  /** 雲端資料夾目前找得到 */
  get available(): boolean {
    return !!this.cloudDir && isDir(this.cloudDir)
  }

  /** 使用者在「開啟資料夾」看到的位置 */
  get dataDir(): string {
    return this.cloudDir ?? this.localDir
  }

  get filesDir(): string {
    return path.join(this.available ? this.cloudDir! : this.localDir, FILES)
  }

  /** 曾經同步過資料的其他電腦數量 */
  otherDevices(): number {
    return listLogs(this.localDir).filter(
      (n) => n !== this.ownName && sizeOf(path.join(this.localDir, CHANGES, n)) > 0
    ).length
  }

  /** 這台電腦有沒有任何資料（自己建立的，或之前同步下來的） */
  hasLocalData(): boolean {
    return hasLibraryData(this.localDir)
  }

  onChange(listener: () => void): void {
    this.listeners.add(listener)
  }

  private emit(): void {
    this.listeners.forEach((l) => l())
  }

  // ---------- 寫入與合併 ----------

  append(ops: Op[]): void {
    if (ops.length === 0) return
    fs.appendFileSync(this.ownLocal, serialize(ops))
    ops.forEach((op) => this.apply(op))
    this.pushNeeded = true
    this.schedulePush()
  }

  private apply(op: Op): void {
    this.clock.observe(op.ts)
    let table = this.state.get(op.tb)
    if (!table) this.state.set(op.tb, (table = new Map()))
    let row = table.get(op.id)
    if (!row) table.set(op.id, (row = new Map()))
    const cell = row.get(op.f)
    if (!cell || op.ts > cell.ts) row.set(op.f, { v: op.v, ts: op.ts })
  }

  /** 從本機所有紀錄重新算出目前的資料 */
  private rebuild(): void {
    this.state = new Map()
    for (const name of listLogs(this.localDir)) {
      parseLog(readText(path.join(this.localDir, CHANGES, name))).forEach((op) => this.apply(op))
    }
  }

  /** 自己的紀錄太長時，只保留目前仍然有效的修改 */
  private compactOwn(): void {
    const ops = parseLog(readText(this.ownLocal))
    if (ops.length < COMPACT_MIN_LINES) return
    const winners = ops.filter((op) => this.state.get(op.tb)?.get(op.id)?.get(op.f)?.ts === op.ts)
    if (winners.length * 3 > ops.length) return
    writeAtomic(this.ownLocal, serialize(winners))
    this.pushNeeded = true
  }

  // ---------- 和雲端資料夾交換 ----------

  private schedulePush(): void {
    if (this.pushTimer) clearTimeout(this.pushTimer)
    this.pushTimer = setTimeout(() => void this.sync(), 2000)
  }

  /** 和雲端資料夾交換紀錄；有收到其他電腦的新資料時回傳 true */
  sync(): Promise<boolean> {
    if (!this.syncing) {
      this.syncing = this.doSync().finally(() => (this.syncing = null))
    }
    return this.syncing
  }

  private async doSync(): Promise<boolean> {
    if (!this.cloudDir || !this.available) return false
    const cloud = this.cloudDir
    let changed = false
    try {
      fs.mkdirSync(path.join(cloud, CHANGES), { recursive: true })
      fs.mkdirSync(path.join(cloud, FILES), { recursive: true })
      if (await this.migrateLegacy(cloud)) changed = true

      for (const name of listLogs(cloud)) {
        if (name === this.ownName) continue
        const src = path.join(cloud, CHANGES, name)
        const stat = fs.statSync(src)
        const sig = `${stat.size}:${stat.mtimeMs}`
        if (this.seen.get(name) === sig) continue
        this.pullLog(src, path.join(this.localDir, CHANGES, name))
        this.seen.set(name, sig)
        changed = true
      }

      const ownCloud = path.join(cloud, CHANGES, this.ownName)
      if (this.pushNeeded || !fs.existsSync(ownCloud)) {
        this.pushNeeded = false
        writeAtomic(ownCloud, readText(this.ownLocal))
      }
      this.lastSyncAt = Date.now()
    } catch (err) {
      // 雲端硬碟暫時鎖住檔案之類的狀況，下次再試
      this.pushNeeded = true
      console.warn('[sync]', err)
    }
    if (changed) {
      this.rebuild()
      this.emit()
    }
    return changed
  }

  /** 把其他電腦的紀錄抄到本機；正常情況是附加在後面，否則合併兩邊避免遺失 */
  private pullLog(src: string, dest: string): void {
    const remote = readText(src)
    const local = readText(dest)
    if (remote.startsWith(local)) {
      writeAtomic(dest, remote)
      return
    }
    const known = new Set(parseLog(remote).map((op) => op.ts))
    const extra = parseLog(local).filter((op) => !known.has(op.ts))
    writeAtomic(dest, (remote.endsWith('\n') || !remote ? remote : remote + '\n') + serialize(extra))
  }

  /** 舊版的 research-desk.sqlite：轉成這台電腦的變更紀錄，舊檔改名當備份 */
  private async migrateLegacy(dir: string): Promise<boolean> {
    if (this.migrated.has(dir)) return false
    this.migrated.add(dir)
    const legacy = path.join(dir, LEGACY_DB)
    if (!fs.existsSync(legacy)) return false

    // 其他電腦已經轉換過，就不用再轉一次
    const alreadyConverted = listLogs(dir).some(
      (n) => n !== this.ownName && sizeOf(path.join(dir, CHANGES, n)) > 0
    )
    let imported = false
    if (!alreadyConverted) {
      const tables = await readLegacyRows(legacy)
      const ops: Op[] = []
      for (const [tb, rows] of Object.entries(tables)) {
        for (const row of rows) {
          for (const f of TABLES[tb].fields) {
            if (row[f] !== undefined) ops.push({ tb, id: String(row.id), f, v: row[f], ts: this.clock.now() })
          }
        }
      }
      this.append(ops)
      imported = ops.length > 0
    }

    let backup = path.join(dir, `${LEGACY_DB}.bak`)
    if (fs.existsSync(backup)) backup = path.join(dir, `${LEGACY_DB}.${Date.now()}.bak`)
    fs.renameSync(legacy, backup)
    fs.rmSync(path.join(dir, LEGACY_LOCK), { force: true })
    return imported
  }

  /** 程式啟動時接上之前設定好的雲端資料夾 */
  async connect(dir: string): Promise<void> {
    this.cloudDir = dir
    this.pushNeeded = true
    await this.sync()
  }

  /**
   * 使用者在設定裡開啟同步（或重新指定資料夾）。
   * 雲端和這台都有資料時先回傳 needsChoice，讓使用者選擇合併或改用雲端資料。
   */
  async attach(dir: string, choice?: AttachChoice): Promise<AttachResult> {
    fs.mkdirSync(path.join(dir, CHANGES), { recursive: true })
    const cloudHasData = hasLibraryData(dir, this.deviceId)
    if (cloudHasData && this.hasLocalData() && !choice) return 'needsChoice'
    if (cloudHasData && choice === 'discard') this.discardLocal()

    // 本機的紀錄（包含之前從其他電腦同步下來的）一起放進雲端
    for (const name of listLogs(this.localDir)) {
      const dest = path.join(dir, CHANGES, name)
      if (name !== this.ownName && !fs.existsSync(dest))
        writeAtomic(dest, readText(path.join(this.localDir, CHANGES, name)))
    }
    // PDF 等檔案搬到雲端資料夾
    const localFiles = path.join(this.localDir, FILES)
    copyMissingFiles(localFiles, path.join(dir, FILES))
    fs.rmSync(localFiles, { recursive: true, force: true })
    fs.mkdirSync(localFiles, { recursive: true })

    this.seen.clear()
    this.migrated.delete(dir)
    await this.connect(dir)
    this.rebuild()
    this.emit()
    return 'done'
  }

  /** 改用雲端資料：本機紀錄移到備份資料夾，並換一個新的裝置編號重新開始 */
  private discardLocal(): void {
    const backup = path.join(this.localDir, '..', `library-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`)
    fs.renameSync(path.join(this.localDir, CHANGES), backup)
    fs.mkdirSync(path.join(this.localDir, CHANGES), { recursive: true })
    this.deviceId = randomUUID()
    this.clock = new Clock(this.deviceId)
    fs.writeFileSync(this.ownLocal, '')
    this.rebuild()
  }

  /** 停止同步：把最新資料和檔案複製回本機，雲端那份不動 */
  async detach(): Promise<void> {
    if (this.cloudDir && this.available) {
      await this.sync()
      copyMissingFiles(path.join(this.cloudDir, FILES), path.join(this.localDir, FILES))
    }
    this.cloudDir = null
    this.seen.clear()
    this.emit()
  }

  /** 結束程式前把還沒上傳的修改寫進雲端 */
  async flush(): Promise<void> {
    if (this.pushTimer) clearTimeout(this.pushTimer)
    await this.sync()
  }
}

