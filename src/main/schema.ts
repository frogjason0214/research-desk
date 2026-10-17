import initSqlJs, { type SqlJsStatic } from 'sql.js'
import fs from 'node:fs'

// 資料表與欄位。資料本身存成「變更紀錄」，這裡的 SQLite 只是記憶體裡的查詢快取。

export const TABLES: Record<string, { fields: string[]; required: string[] }> = {
  // folder：文獻資料夾目前的位置（改名時用來把整個資料夾跟著改名）
  projects: { fields: ['name', 'created_at', 'folder'], required: ['name'] },
  milestones: {
    fields: ['project_id', 'title', 'due_date', 'done', 'sort', 'is_defense'],
    required: ['project_id', 'title']
  },
  tasks: {
    fields: ['project_id', 'title', 'due_date', 'done', 'done_at', 'created_at', 'gcal_event_id'],
    required: ['project_id', 'title']
  },
  papers: {
    fields: [
      'project_id', 'kind', 'lang', 'bib_status',
      // 書目；authors 存成 JSON 字串
      'title', 'authors', 'year', 'date', 'journal', 'volume', 'issue', 'pages', 'doi', 'url',
      // 心理學欄位
      'study_type', 'sample', 'measures', 'findings', 'ai_filled',
      'notes', 'no_ai', 'notes_no_ai', 'text_status', 'added_at',
      // 檔案目前的位置（相對於「文獻」資料夾，JSON）：{ main: [...], txt, links: [...] }
      'files'
    ],
    required: ['project_id', 'kind']
  },
  mindmaps: { fields: ['project_id', 'name', 'created_at', 'folder'], required: ['project_id', 'name'] },
  mm_nodes: {
    fields: ['map_id', 'parent_id', 'text', 'x', 'y', 'collapsed', 'color', 'created_at', 'folder'],
    required: ['map_id']
  },
  // 心智圖上的手繪筆跡（stroke）與便利貼（note），位置是畫布座標；points 是 JSON 數字陣列
  mm_marks: {
    fields: ['map_id', 'kind', 'color', 'size', 'points', 'x', 'y', 'w', 'text', 'created_at'],
    required: ['map_id', 'kind']
  },
  // 筆記：頁面樹與頁面裡的區塊（以區塊為單位合併，兩台電腦改不同段落不會互蓋）
  note_pages: {
    fields: ['project_id', 'parent_id', 'title', 'sort', 'created_at', 'updated_at', 'trashed_at'],
    required: ['project_id']
  },
  note_blocks: { fields: ['page_id', 'sort', 'content'], required: ['page_id'] },
  conversations: {
    fields: ['project_id', 'title', 'role', 'created_at', 'updated_at'],
    required: ['project_id', 'role']
  },
  // sources 存成 JSON：回答引用到的文獻段落
  messages: {
    fields: ['conversation_id', 'role', 'text', 'sources', 'created_at'],
    required: ['conversation_id', 'role']
  },
  // 每日建議：ID 是「專案:日期」，兩台電腦共用同一則
  daily_tips: { fields: ['project_id', 'date', 'role', 'text', 'sources', 'created_at'], required: ['project_id', 'date'] },
  // 節點、文獻、待辦之間的連結；ID 由兩端組成，兩台電腦同時加同一條連結也只有一筆
  links: { fields: ['a_type', 'a_id', 'b_type', 'b_id'], required: ['a_type', 'a_id', 'b_type', 'b_id'] }
}

/** 刪除也是一個欄位修改，才能和其他電腦的修改比較先後 */
export const DELETED = '_deleted'

export const CACHE_SCHEMA = `
CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, created_at TEXT, folder TEXT);
CREATE TABLE milestones (
  id TEXT PRIMARY KEY, project_id TEXT, title TEXT, due_date TEXT,
  done INTEGER DEFAULT 0, sort INTEGER DEFAULT 0, is_defense INTEGER DEFAULT 0
);
CREATE TABLE tasks (
  id TEXT PRIMARY KEY, project_id TEXT, title TEXT, due_date TEXT,
  done INTEGER DEFAULT 0, done_at TEXT, created_at TEXT, gcal_event_id TEXT
);
CREATE TABLE papers (
  id TEXT PRIMARY KEY, project_id TEXT, kind TEXT, lang TEXT DEFAULT 'en', bib_status TEXT DEFAULT 'pending',
  title TEXT DEFAULT '', authors TEXT DEFAULT '[]', year TEXT DEFAULT '', date TEXT DEFAULT '',
  journal TEXT DEFAULT '', volume TEXT DEFAULT '', issue TEXT DEFAULT '', pages TEXT DEFAULT '',
  doi TEXT DEFAULT '', url TEXT DEFAULT '',
  study_type TEXT DEFAULT '', sample TEXT DEFAULT '', measures TEXT DEFAULT '', findings TEXT DEFAULT '',
  ai_filled INTEGER DEFAULT 0, notes TEXT DEFAULT '', no_ai INTEGER DEFAULT 0, notes_no_ai INTEGER DEFAULT 0,
  text_status TEXT DEFAULT 'pending', added_at TEXT, files TEXT
);
CREATE INDEX idx_papers_project ON papers(project_id);
CREATE TABLE mindmaps (id TEXT PRIMARY KEY, project_id TEXT, name TEXT, created_at TEXT, folder TEXT);
CREATE TABLE mm_nodes (
  id TEXT PRIMARY KEY, map_id TEXT, parent_id TEXT, text TEXT DEFAULT '',
  x REAL DEFAULT 0, y REAL DEFAULT 0, collapsed INTEGER DEFAULT 0, color TEXT DEFAULT '', created_at TEXT, folder TEXT
);
CREATE INDEX idx_nodes_map ON mm_nodes(map_id);
CREATE TABLE mm_marks (
  id TEXT PRIMARY KEY, map_id TEXT, kind TEXT, color TEXT DEFAULT 'ink', size REAL DEFAULT 2, points TEXT DEFAULT '[]',
  x REAL DEFAULT 0, y REAL DEFAULT 0, w REAL DEFAULT 180, text TEXT DEFAULT '', created_at TEXT
);
CREATE INDEX idx_marks_map ON mm_marks(map_id);
CREATE TABLE links (id TEXT PRIMARY KEY, a_type TEXT, a_id TEXT, b_type TEXT, b_id TEXT);
CREATE TABLE note_pages (
  id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, title TEXT DEFAULT '', sort REAL DEFAULT 0,
  created_at TEXT, updated_at TEXT, trashed_at TEXT
);
CREATE INDEX idx_note_pages_project ON note_pages(project_id);
CREATE TABLE note_blocks (id TEXT PRIMARY KEY, page_id TEXT, sort REAL DEFAULT 0, content TEXT DEFAULT '{}');
CREATE INDEX idx_note_blocks_page ON note_blocks(page_id);
CREATE TABLE conversations (id TEXT PRIMARY KEY, project_id TEXT, title TEXT DEFAULT '', role TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT, role TEXT, text TEXT DEFAULT '', sources TEXT DEFAULT '[]', created_at TEXT);
CREATE INDEX idx_messages_conv ON messages(conversation_id);
CREATE TABLE daily_tips (id TEXT PRIMARY KEY, project_id TEXT, date TEXT, role TEXT, text TEXT DEFAULT '', sources TEXT DEFAULT '[]', created_at TEXT);
CREATE INDEX idx_links_a ON links(a_id);
CREATE INDEX idx_links_b ON links(b_id);
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
