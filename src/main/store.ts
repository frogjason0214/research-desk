import type { Database, SqlValue } from 'sql.js'
import type { Library, Op } from './library'
import { CACHE_SCHEMA, DELETED, loadSql, TABLES } from './schema'

// 查詢用的記憶體 SQLite，內容由變更紀錄算出來；不會存成檔案。
// 修改一律透過 write() 轉成變更紀錄，寫進這台電腦自己的紀錄檔。

export interface Tx {
  /** 新增或修改一筆資料的部分欄位 */
  set(tb: string, id: string, fields: Record<string, unknown>): void
  remove(tb: string, id: string): void
}

export class Store {
  private db!: Database
  private listeners = new Set<() => void>()

  constructor(private library: Library) {}

  async open(): Promise<void> {
    const SQL = await loadSql()
    this.db = new SQL.Database()
    this.db.exec(CACHE_SCHEMA)
    this.rebuild()
    // 其他電腦的修改：只更新相關資料列；需要整份重算時 ops 是 null
    this.library.onChange((ops) => {
      if (ops) this.refreshRows(touchedRows(ops))
      else this.rebuild()
      this.notify()
    })
  }

  /** 整個快取重算：啟動時、收到其他電腦的修改時 */
  private rebuild(): void {
    this.db.exec('BEGIN')
    for (const tb of Object.keys(TABLES)) {
      this.db.run(`DELETE FROM ${tb}`)
      for (const id of this.library.state.get(tb)?.keys() ?? []) this.insertRow(tb, id)
    }
    this.db.exec('COMMIT')
  }

  /** 只重算這次修改到的資料列（資料多時，整個重算一次要半秒以上） */
  private refreshRows(rows: Map<string, Set<string>>): void {
    this.db.exec('BEGIN')
    for (const [tb, ids] of rows) {
      for (const id of ids) {
        this.db.run(`DELETE FROM ${tb} WHERE id = ?`, [id])
        this.insertRow(tb, id)
      }
    }
    this.db.exec('COMMIT')
  }

  private insertRow(tb: string, id: string): void {
    const def = TABLES[tb]
    const row = this.library.state.get(tb)?.get(id)
    if (!row || row.get(DELETED)?.v) return
    if (def.required.some((f) => row.get(f)?.v == null)) return // 其他電腦的紀錄還沒同步完整
    const fields = def.fields.filter((f) => row.get(f) !== undefined)
    this.db.run(
      `INSERT INTO ${tb} (id, ${fields.join(', ')}) VALUES (?, ${fields.map(() => '?').join(', ')})`,
      [id, ...fields.map((f) => row.get(f)!.v as SqlValue)]
    )
  }

  all<T>(sql: string, params: SqlValue[] = []): T[] {
    const stmt = this.db.prepare(sql)
    stmt.bind(params)
    const rows: T[] = []
    while (stmt.step()) rows.push(stmt.getAsObject() as T)
    stmt.free()
    return rows
  }

  get<T>(sql: string, params: SqlValue[] = []): T | undefined {
    return this.all<T>(sql, params)[0]
  }

  /** 收集一組修改，寫成變更紀錄後重新整理快取 */
  write(fn: (tx: Tx) => void): void {
    const ops: Op[] = []
    const push = (tb: string, id: string, f: string, v: unknown): void => {
      ops.push({ tb, id, f, v: v ?? null, ts: this.library.clock.now() })
    }
    fn({
      set: (tb, id, fields) => {
        for (const [f, v] of Object.entries(fields)) {
          if (!TABLES[tb].fields.includes(f)) throw new Error(`未知的欄位：${tb}.${f}`)
          push(tb, id, f, v)
        }
      },
      remove: (tb, id) => push(tb, id, DELETED, 1)
    })
    if (ops.length === 0) return
    this.library.append(ops)
    this.refreshRows(touchedRows(ops))
    this.notify()
  }

  onChange(listener: () => void): void {
    this.listeners.add(listener)
  }

  private notify(): void {
    this.listeners.forEach((l) => l())
  }
}

/** 一組修改動到哪些資料表的哪些資料列 */
function touchedRows(ops: Op[]): Map<string, Set<string>> {
  const touched = new Map<string, Set<string>>()
  for (const op of ops) {
    if (!TABLES[op.tb]) continue
    if (!touched.has(op.tb)) touched.set(op.tb, new Set())
    touched.get(op.tb)!.add(op.id)
  }
  return touched
}
