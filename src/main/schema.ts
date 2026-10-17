import initSqlJs, { type SqlJsStatic } from 'sql.js'
import fs from 'node:fs'

// 資料表與欄位。資料本身存成「變更紀錄」，這裡的 SQLite 只是記憶體裡的查詢快取。

export const TABLES: Record<string, { fields: string[]; required: string[] }> = {
  projects: { fields: ['name', 'created_at'], required: ['name'] },
  milestones: {
    fields: ['project_id', 'title', 'due_date', 'done', 'sort', 'is_defense'],
    required: ['project_id', 'title']
  },
  tasks: {
    fields: ['project_id', 'title', 'due_date', 'done', 'done_at', 'created_at', 'gcal_event_id'],
    required: ['project_id', 'title']
  }
}

/** 刪除也是一個欄位修改，才能和其他電腦的修改比較先後 */
export const DELETED = '_deleted'

export const CACHE_SCHEMA = `
CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, created_at TEXT);
CREATE TABLE milestones (
  id TEXT PRIMARY KEY, project_id TEXT, title TEXT, due_date TEXT,
  done INTEGER DEFAULT 0, sort INTEGER DEFAULT 0, is_defense INTEGER DEFAULT 0
);
CREATE TABLE tasks (
  id TEXT PRIMARY KEY, project_id TEXT, title TEXT, due_date TEXT,
  done INTEGER DEFAULT 0, done_at TEXT, created_at TEXT, gcal_event_id TEXT
);
CREATE INDEX idx_milestones_project ON milestones(project_id);
CREATE INDEX idx_tasks_project ON tasks(project_id);
`

// 使用 sql.js（純 WebAssembly 的 SQLite），不需要在 Windows 上編譯原生模組。
let sqlPromise: Promise<SqlJsStatic> | null = null
export function loadSql(): Promise<SqlJsStatic> {
  if (!sqlPromise) {
    const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm').replace('app.asar', 'app.asar.unpacked')
    const buf = fs.readFileSync(wasmPath)
    const wasmBinary = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
    sqlPromise = initSqlJs({ wasmBinary })
  }
  return sqlPromise
}

/** 讀取舊版的單一資料庫檔（research-desk.sqlite），用來轉換成變更紀錄 */
export async function readLegacyRows(file: string): Promise<Record<string, Record<string, unknown>[]>> {
  const SQL = await loadSql()
  const db = new SQL.Database(fs.readFileSync(file))
  const result: Record<string, Record<string, unknown>[]> = {}
  try {
    for (const tb of Object.keys(TABLES)) {
      try {
        const res = db.exec(`SELECT * FROM ${tb}`)[0]
        result[tb] = res ? res.values.map((row) => Object.fromEntries(res.columns.map((c, i) => [c, row[i]]))) : []
      } catch {
        result[tb] = []
      }
    }
  } finally {
    db.close()
  }
  return result
}
