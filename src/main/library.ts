import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Clock } from './clock'
import { readLegacyRows, TABLES } from './schema'

// 資料的真正來源：每台電腦只寫自己的變更紀錄檔 changes/<裝置編號>.jsonl，
// 讀取時合併所有電腦的紀錄，同一個欄位以時間戳最晚的為準。
// 因為每個檔案只有一台電腦會寫，雲端硬碟不會產生衝突副本，也就不需要鎖定。
//
// 資料夾結構：
//   changes/   每台電腦一個 .jsonl
//   文獻/      PDF、網頁快照、全文（依心智圖節點分資料夾，見 papers/organizer.ts）
//
// 沒開同步：資料只在這台電腦（userData/library）。
// 開了同步：資料只在雲端資料夾，這台電腦不另存一份。雲端資料夾暫時找不到時，
// 新的修改先暫存在本機 pending.jsonl、檔案暫存在本機 文獻/，資料夾恢復後自動搬過去。

export const LIBRARY_FOLDER = 'ResearchDesk'
const CHANGES = 'changes'
export const FILES = '文獻'
const PENDING = 'pending.jsonl'
const LEGACY_DB = 'research-desk.sqlite'
const LEGACY_LOCK = 'research-desk.lock'
const COMPACT_MIN_LINES = 2000
const TAIL_BYTES = 64

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

/** ops：這次新增的修改（可以只更新相關資料列）；null：整份資料重算 */
export type ChangeListener = (ops: Op[] | null) => void

// ---------- 檔案工具 ----------

export const isDir = (p: string): boolean => {
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
function writeAtomic(dest: string, data: string | Uint8Array): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const tmp = `${dest}.tmp`
  fs.writeFileSync(tmp, data)
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

/** 兩份紀錄合併（去掉重複），用在搬移紀錄時避免遺失 */
function unionLogs(a: string, b: string): string {
  const seen = new Set<string>()
  const out: Op[] = []
  for (const op of [...parseLog(a), ...parseLog(b)]) {
    const key = `${op.ts}|${op.tb}|${op.id}|${op.f}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(op)
  }
  return serialize(out)
}

/** 資料夾裡是否已經有研究資料（新格式或舊版資料庫） */
export function hasLibraryData(dir: string, exceptDevice?: string): boolean {
  if (fs.existsSync(path.join(dir, LEGACY_DB))) return true
  return listLogs(dir).some((n) => n !== `${exceptDevice}.jsonl` && sizeOf(path.join(dir, CHANGES, n)) > 0)
}

/** 把 from 底下的檔案搬到 to（目的地已有同名檔就保留目的地的） */
export function moveTree(from: string, to: string): void {
  if (!isDir(from)) return
  fs.mkdirSync(to, { recursive: true })
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name)
    const dest = path.join(to, entry.name)
    if (entry.isDirectory()) moveTree(src, dest)
    else if (!fs.existsSync(dest)) fs.copyFileSync(src, dest)
  }
  fs.rmSync(from, { recursive: true, force: true })
}

function copyTree(from: string, to: string): void {
  if (!isDir(from)) return
  fs.mkdirSync(to, { recursive: true })
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name)
    const dest = path.join(to, entry.name)
    if (entry.isDirectory()) copyTree(src, dest)
    else if (!fs.existsSync(dest)) fs.copyFileSync(src, dest)
  }
}

// ---------- 資料庫 ----------

export class Library {
  state: State = new Map()
  clock: Clock
  cloudDir: string | null = null
  lastSyncAt: number | null = null
  /** 每個紀錄檔讀到哪裡：大小與最後幾個位元組（用來確認是接在後面寫的） */
  private read = new Map<string, { size: number; tail: string }>()
  private listeners = new Set<ChangeListener>()
  private syncing: Promise<boolean> | null = null
  private migrated = new Set<string>()

  constructor(
    private localDir: string,
    public deviceId: string
  ) {
    this.clock = new Clock(deviceId)
    fs.mkdirSync(path.join(localDir, CHANGES), { recursive: true })
    this.loadAll(localDir)
    this.applyPending()
  }

  private get ownName(): string {
    return `${this.deviceId}.jsonl`
  }

  private get pendingFile(): string {
    return path.join(this.localDir, PENDING)
  }

  /** 雲端資料夾目前找得到 */
  get available(): boolean {
    return !!this.cloudDir && isDir(this.cloudDir)
  }

  /** 目前讀寫紀錄的資料夾：開同步時是雲端，否則是本機 */
  private get activeDir(): string {
    return this.cloudDir ?? this.localDir
  }

  /** 使用者在「開啟資料夾」看到的位置 */
  get dataDir(): string {
    return this.activeDir
  }

  /** 文獻檔案的根目錄；雲端找不到時暫存在本機 */
  get filesDir(): string {
    return path.join(this.cloudDir && !this.available ? this.localDir : this.activeDir, FILES)
  }

  /** 找出檔案實際位置：雲端資料夾優先，其次是本機暫存 */
  resolveFile(rel: string): string | null {
    for (const dir of [this.available ? this.cloudDir : null, this.localDir]) {
      if (dir && fs.existsSync(path.join(dir, FILES, rel))) return path.join(dir, FILES, rel)
    }
    return null
  }

  writeFile(rel: string, data: string | Uint8Array): void {
    writeAtomic(path.join(this.filesDir, rel), data)
  }

  removeFile(rel: string): void {
    for (const dir of [this.cloudDir, this.localDir]) if (dir) fs.rmSync(path.join(dir, FILES, rel), { force: true })
  }

  /** 曾經同步過資料的其他電腦數量 */
  otherDevices(): number {
    return listLogs(this.activeDir).filter((n) => n !== this.ownName && sizeOf(path.join(this.activeDir, CHANGES, n)) > 0).length
  }

  /** 這台電腦有沒有任何資料 */
  hasLocalData(): boolean {
    return hasLibraryData(this.localDir) || sizeOf(this.pendingFile) > 0
  }

  onChange(listener: ChangeListener): void {
    this.listeners.add(listener)
  }

  private emit(ops: Op[] | null): void {
    this.listeners.forEach((l) => l(ops))
  }

  // ---------- 讀取 ----------

  private apply(op: Op): void {
    this.clock.observe(op.ts)
    let table = this.state.get(op.tb)
    if (!table) this.state.set(op.tb, (table = new Map()))
    let row = table.get(op.id)
    if (!row) table.set(op.id, (row = new Map()))
    const cell = row.get(op.f)
    if (!cell || op.ts > cell.ts) row.set(op.f, { v: op.v, ts: op.ts })
  }

  private remember(name: string, text: string): void {
    const bytes = Buffer.byteLength(text)
    this.read.set(name, { size: bytes, tail: Buffer.from(text).subarray(Math.max(0, bytes - TAIL_BYTES)).toString('latin1') })
  }

  /** 從某個資料夾讀所有紀錄，重算整份資料 */
  private loadAll(dir: string): void {
    this.state = new Map()
    this.read.clear()
    for (const name of listLogs(dir)) {
      const text = readText(path.join(dir, CHANGES, name))
      parseLog(text).forEach((op) => this.apply(op))
      this.remember(name, text)
    }
  }

  /** 暫存中的修改也算進目前的資料 */
  private applyPending(): void {
    parseLog(readText(this.pendingFile)).forEach((op) => this.apply(op))
  }

  /**
   * 檢查其他電腦的紀錄有沒有變；接在後面寫的只讀新的部分，被整理過（變短或內容不同）就整份重讀。
   * 回傳：新讀到的修改；null 表示需要整份重算。
   */
  private readChanges(dir: string): Op[] | null {
    const fresh: Op[] = []
    for (const name of listLogs(dir)) {
      if (name === this.ownName && this.cloudDir) continue // 自己寫的已經算進去了
      const file = path.join(dir, CHANGES, name)
      const size = sizeOf(file)
      const known = this.read.get(name)
      if (known && known.size === size) continue
      const buf = fs.readFileSync(file)
      if (known && size > known.size && buf.subarray(known.size - Math.min(TAIL_BYTES, known.size), known.size).toString('latin1') === known.tail) {
        const added = buf.subarray(known.size).toString('utf8')
        // 最後一行可能還沒寫完：只吃到最後一個換行
        const end = added.lastIndexOf('\n') + 1
        const ops = parseLog(added.slice(0, end))
        ops.forEach((op) => this.apply(op))
        fresh.push(...ops)
        this.remember(name, buf.subarray(0, known.size + Buffer.byteLength(added.slice(0, end))).toString('utf8'))
      } else if (!known) {
        const text = buf.toString('utf8')
        const ops = parseLog(text)
        ops.forEach((op) => this.apply(op))
        fresh.push(...ops)
        this.remember(name, text)
      } else {
        return null
      }
    }
    return fresh
  }

  // ---------- 寫入 ----------

  append(ops: Op[]): void {
    if (ops.length === 0) return
    ops.forEach((op) => this.apply(op))
    const text = serialize(ops)
    if (!this.cloudDir) {
      fs.appendFileSync(path.join(this.localDir, CHANGES, this.ownName), text)
      return
    }
    // 開同步：直接寫進雲端自己的紀錄檔；找不到或被鎖住就先暫存
    try {
      if (!this.available) throw new Error('offline')
      this.flushPending()
      fs.mkdirSync(path.join(this.cloudDir, CHANGES), { recursive: true })
      fs.appendFileSync(path.join(this.cloudDir, CHANGES, this.ownName), text)
    } catch {
      fs.appendFileSync(this.pendingFile, text)
    }
  }

  /** 把暫存的修改寫進雲端自己的紀錄檔 */
  private flushPending(): void {
    if (!this.cloudDir || !this.available) return
    const pending = readText(this.pendingFile)
    if (!pending) return
    fs.mkdirSync(path.join(this.cloudDir, CHANGES), { recursive: true })
    fs.appendFileSync(path.join(this.cloudDir, CHANGES, this.ownName), pending)
    fs.rmSync(this.pendingFile, { force: true })
  }

  /** 自己的紀錄太長時，只保留目前仍然有效的修改 */
  private compactOwn(): void {
    const file = path.join(this.activeDir, CHANGES, this.ownName)
    const ops = parseLog(readText(file))
    if (ops.length < COMPACT_MIN_LINES) return
    const winners = ops.filter((op) => this.state.get(op.tb)?.get(op.id)?.get(op.f)?.ts === op.ts)
    if (winners.length * 3 > ops.length) return
    writeAtomic(file, serialize(winners))
  }

  // ---------- 和雲端資料夾交換 ----------

  /** 檢查雲端有沒有其他電腦的新修改；有的話回傳 true */
  sync(): Promise<boolean> {
    if (!this.syncing) this.syncing = this.doSync().finally(() => (this.syncing = null))
    return this.syncing
  }

  private async doSync(): Promise<boolean> {
    if (!this.cloudDir || !this.available) return false
    try {
      if (await this.migrateLegacy(this.cloudDir)) {
        this.emit(null)
        return true
      }
      this.flushPending()
      // 雲端找不到時暫存在本機的檔案，搬到雲端
      moveTree(path.join(this.localDir, FILES), path.join(this.cloudDir, FILES))
      const fresh = this.readChanges(this.cloudDir)
      this.lastSyncAt = Date.now()
      if (fresh === null) {
        this.loadAll(this.cloudDir)
        this.applyPending()
        this.emit(null)
        return true
      }
      if (fresh.length) {
        this.emit(fresh)
        return true
      }
    } catch (err) {
      console.warn('[sync]', err)
    }
    return false
  }

  /** 舊版的 research-desk.sqlite：轉成這台電腦的變更紀錄，舊檔改名當備份 */
  private async migrateLegacy(dir: string): Promise<boolean> {
    if (this.migrated.has(dir)) return false
    this.migrated.add(dir)
    const legacy = path.join(dir, LEGACY_DB)
    if (!fs.existsSync(legacy)) return false

    const alreadyConverted = listLogs(dir).some((n) => n !== this.ownName && sizeOf(path.join(dir, CHANGES, n)) > 0)
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

  /**
   * 本機的紀錄搬進雲端資料夾後刪掉本機那份（開同步後不在本機另存）。
   * 同一台電腦的紀錄兩邊都有時合併，避免遺失。
   */
  private moveLocalLogsTo(dir: string): void {
    fs.mkdirSync(path.join(dir, CHANGES), { recursive: true })
    for (const name of listLogs(this.localDir)) {
      const src = path.join(this.localDir, CHANGES, name)
      const dest = path.join(dir, CHANGES, name)
      const local = readText(src)
      if (!local) continue
      const remote = readText(dest)
      if (!remote) writeAtomic(dest, local)
      else if (!remote.startsWith(local) && remote !== local) writeAtomic(dest, unionLogs(remote, local))
    }
    fs.rmSync(path.join(this.localDir, CHANGES), { recursive: true, force: true })
    fs.mkdirSync(path.join(this.localDir, CHANGES), { recursive: true })
  }

  /** 程式啟動時接上之前設定好的雲端資料夾 */
  async connect(dir: string): Promise<void> {
    this.cloudDir = dir
    if (!this.available) {
      // 找不到：只能用暫存中的修改，資料夾恢復後再讀
      this.state = new Map()
      this.read.clear()
      this.applyPending()
      this.emit(null)
      return
    }
    this.moveLocalLogsTo(dir) // 舊版會在本機另存一份，搬過去後刪掉
    this.loadAll(dir)
    this.applyPending()
    this.compactOwn()
    await this.sync()
    this.emit(null)
  }

  /**
   * 使用者在設定裡開啟同步（或重新指定資料夾）。
   * 雲端和這台都有資料時先回傳 needsChoice，讓使用者選擇合併或改用雲端資料。
   */
  async attach(dir: string, choice?: AttachChoice): Promise<AttachResult> {
    fs.mkdirSync(path.join(dir, CHANGES), { recursive: true })
    const cloudHasData = hasLibraryData(dir, this.deviceId)
    // 已經在用雲端（例如換資料夾）時，目前的資料都在舊的雲端資料夾裡，先抄回本機再搬
    if (this.cloudDir && this.available && this.cloudDir !== dir) {
      copyTree(path.join(this.cloudDir, CHANGES), path.join(this.localDir, CHANGES))
      copyTree(path.join(this.cloudDir, FILES), path.join(this.localDir, FILES))
    }
    if (cloudHasData && this.hasLocalData() && !choice) return 'needsChoice'
    if (cloudHasData && choice === 'discard') this.discardLocal()

    // 暫存的修改先寫進本機自己的紀錄，再一起搬
    const pending = readText(this.pendingFile)
    if (pending) {
      fs.appendFileSync(path.join(this.localDir, CHANGES, this.ownName), pending)
      fs.rmSync(this.pendingFile, { force: true })
    }
    this.moveLocalLogsTo(dir)
    moveTree(path.join(this.localDir, FILES), path.join(dir, FILES))
    this.migrated.delete(dir)
    this.cloudDir = dir
    this.loadAll(dir)
    await this.sync()
    this.emit(null)
    return 'done'
  }

  /** 改用雲端資料：本機紀錄移到備份資料夾，並換一個新的裝置編號重新開始 */
  private discardLocal(): void {
    const backup = path.join(this.localDir, '..', `library-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`)
    fs.renameSync(path.join(this.localDir, CHANGES), backup)
    fs.mkdirSync(path.join(this.localDir, CHANGES), { recursive: true })
    if (fs.existsSync(this.pendingFile)) fs.renameSync(this.pendingFile, path.join(backup, PENDING))
    this.deviceId = randomUUID()
    this.clock = new Clock(this.deviceId)
    this.state = new Map()
  }

  /** 停止同步：把最新的紀錄與檔案複製回本機，雲端那份不動 */
  async detach(): Promise<void> {
    if (this.cloudDir && this.available) {
      await this.sync()
      this.flushPending()
      for (const name of listLogs(this.cloudDir)) {
        writeAtomic(path.join(this.localDir, CHANGES, name), readText(path.join(this.cloudDir, CHANGES, name)))
      }
      copyTree(path.join(this.cloudDir, FILES), path.join(this.localDir, FILES))
    } else {
      // 雲端找不到：暫存的修改留在本機自己的紀錄裡
      const pending = readText(this.pendingFile)
      if (pending) fs.appendFileSync(path.join(this.localDir, CHANGES, this.ownName), pending)
      fs.rmSync(this.pendingFile, { force: true })
    }
    this.cloudDir = null
    this.loadAll(this.localDir)
    this.emit(null)
  }

  /** 結束程式前把暫存的修改寫進雲端 */
  async flush(): Promise<void> {
    await this.sync()
  }
}
