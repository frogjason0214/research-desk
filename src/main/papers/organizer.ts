import fs from 'node:fs'
import path from 'node:path'
import type { Library } from '../library'
import type { Store } from '../store'

// 依心智圖整理文獻檔案：
//   文獻\<專案>\<心智圖>\<節點>\<子節點>\…\作者 年份 篇名.pdf
//   文獻\<專案>\未分類\…          還沒連到任何節點的文獻
//   文獻\<專案>\全文\…txt         所有抽出的全文
// 一篇文獻連到多個節點：檔案放在第一個節點，其他節點放 Windows 捷徑（.lnk）。
// 每個節點都有資料夾（空的也建立）。只會搬移、改名檔案與清掉「空的」資料夾，不刪除任何檔案。

export const UNSORTED = '未分類'
export const FULLTEXT = '全文'
const SEGMENT_MAX = 40
const NAME_MAX = 80
const DEBOUNCE_MS = 2500
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i

/** 檔案目前的位置，相對於「文獻」資料夾 */
export interface PaperFiles {
  main: string[]
  txt: string | null
  links: string[]
}

interface PaperRow {
  id: string
  project_id: string
  kind: 'pdf' | 'web' | 'ref'
  title: string | null
  year: string | null
  authors: string | null
  files: string | null
}

/** Windows 檔名不能用的字元換掉、長度截斷 */
export function safeName(name: string, max = SEGMENT_MAX): string {
  let s = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
  if (s.length > max) s = s.slice(0, max).trim()
  if (!s) s = '未命名'
  if (RESERVED.test(s)) s = `${s}_`
  return s
}

/** 作者 年份 篇名 */
export function paperBaseName(p: { title: string | null; year: string | null; authors: string | null }): string {
  let first = ''
  try {
    const list = JSON.parse(p.authors || '[]') as { family: string; given: string }[]
    first = list[0] ? (/^[㐀-鿿]/.test(list[0].family) ? `${list[0].family}${list[0].given}` : list[0].family) : ''
  } catch {
    /* 沒有作者 */
  }
  return safeName([first, p.year ?? '', p.title || '未命名文獻'].filter(Boolean).join(' '), NAME_MAX)
}

/** 每篇文獻應該在哪裡（相對於「文獻」資料夾） */
export interface Plan {
  /** 主要檔案所在資料夾 */
  dir: string
  base: string
  /** 其他連結節點的資料夾（放捷徑） */
  shortcutDirs: string[]
  txtDir: string
}

/** 專案、心智圖、節點各自對應的資料夾（由上往下排，改名時依序處理） */
export interface Owner {
  tb: 'projects' | 'mindmaps' | 'mm_nodes'
  id: string
  rel: string
  recorded: string | null
}

export function planProject(
  store: Store,
  projectId: string
): { folders: string[]; papers: Map<string, Plan>; owners: Owner[] } {
  const project = store.get<{ name: string; folder: string | null }>('SELECT name, folder FROM projects WHERE id = ?', [projectId])
  const root = safeName(project?.name ?? '專案')
  const owners: Owner[] = [{ tb: 'projects', id: projectId, rel: root, recorded: project?.folder ?? null }]
  const maps = store.all<{ id: string; name: string; folder: string | null }>(
    'SELECT id, name, folder FROM mindmaps WHERE project_id = ? ORDER BY created_at',
    [projectId]
  )
  const folders = new Set<string>([path.join(root, UNSORTED), path.join(root, FULLTEXT)])
  const nodeDir = new Map<string, string>()
  const nodeOrder = new Map<string, number>()
  let order = 0

  for (const map of maps) {
    const nodes = store.all<{ id: string; parent_id: string | null; text: string; folder: string | null }>(
      'SELECT id, parent_id, text, folder FROM mm_nodes WHERE map_id = ? ORDER BY created_at',
      [map.id]
    )
    const mapDir = path.join(root, safeName(map.name))
    folders.add(mapDir)
    owners.push({ tb: 'mindmaps', id: map.id, rel: mapDir, recorded: map.folder })
    // 中心節點對應心智圖資料夾本身，其他節點依階層往下
    const walk = (parentId: string, dir: string): void => {
      for (const n of nodes.filter((x) => x.parent_id === parentId)) {
        const d = path.join(dir, safeName(n.text))
        nodeDir.set(n.id, d)
        nodeOrder.set(n.id, order++)
        folders.add(d)
        owners.push({ tb: 'mm_nodes', id: n.id, rel: d, recorded: n.folder })
        walk(n.id, d)
      }
    }
    for (const r of nodes.filter((n) => !n.parent_id)) {
      nodeDir.set(r.id, mapDir)
      nodeOrder.set(r.id, order++)
      walk(r.id, mapDir)
    }
  }

  const papers = new Map<string, Plan>()
  const rows = store.all<PaperRow>('SELECT id, project_id, kind, title, year, authors, files FROM papers WHERE project_id = ?', [projectId])
  const links = store.all<{ node: string; paper: string }>(
    `SELECT a_id AS node, b_id AS paper FROM links WHERE a_type = 'node' AND b_type = 'paper'`
  )
  for (const p of rows) {
    // 「第一個」節點：依心智圖建立順序與節點順序，兩台電腦算出來一樣
    const dirs = [...new Set(links.filter((l) => l.paper === p.id && nodeDir.has(l.node)).sort((a, b) => nodeOrder.get(a.node)! - nodeOrder.get(b.node)!).map((l) => nodeDir.get(l.node)!))]
    papers.set(p.id, {
      dir: dirs[0] ?? path.join(root, UNSORTED),
      base: paperBaseName(p),
      shortcutDirs: dirs.slice(1),
      txtDir: path.join(root, FULLTEXT)
    })
  }
  return { folders: [...folders], papers, owners }
}

const EXT: Record<PaperRow['kind'], string[]> = { pdf: ['pdf'], web: ['html', 'mhtml'], ref: [] }

/** 舊版的位置：files/papers/<id>.<ext>（相對於資料夾根目錄） */
const legacyFiles = (p: PaperRow): PaperFiles => ({
  main: EXT[p.kind].map((ext) => path.join('..', 'files', 'papers', `${p.id}.${ext}`)),
  txt: path.join('..', 'files', 'papers', `${p.id}.txt`),
  links: []
})

export function currentFiles(p: Pick<PaperRow, 'id' | 'kind' | 'files'>): PaperFiles {
  if (p.files) {
    try {
      return JSON.parse(p.files) as PaperFiles
    } catch {
      /* 壞掉就當舊版 */
    }
  }
  return legacyFiles(p as PaperRow)
}

export class Organizer {
  private timer: NodeJS.Timeout | null = null
  private running = false
  private again = false

  constructor(
    private store: Store,
    private library: Library,
    /** 建立 Windows 捷徑（測試時可以換掉） */
    private writeShortcut: (linkPath: string, target: string) => void
  ) {}

  schedule(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.run(), DEBOUNCE_MS)
  }

  /** 整理所有專案；寫回位置時會觸發資料變動，所以避免重入 */
  run(): void {
    if (this.running) {
      this.again = true
      return
    }
    // 開同步但雲端資料夾找不到：等恢復後再整理，避免在暫存區搬來搬去
    if (this.library.cloudDir && !this.library.available) return
    this.running = true
    try {
      const keep = new Set<string>()
      for (const p of this.store.all<{ id: string }>('SELECT id FROM projects')) this.organizeProject(p.id).forEach((d) => keep.add(d))
      this.pruneAll(keep)
      // 舊版的 files\papers 搬空之後一起清掉
      const legacy = path.join(this.library.dataDir, 'files')
      if (fs.existsSync(legacy)) this.prune(legacy, new Set())
    } catch (err) {
      console.warn('[organizer]', err)
    } finally {
      this.running = false
      if (this.again) {
        this.again = false
        this.schedule()
      }
    }
  }

  private abs(rel: string): string {
    return path.join(this.library.filesDir, rel)
  }

  /** 找出檔案實際位置（雲端或本機暫存） */
  private find(rel: string): string | null {
    return this.library.resolveFile(rel)
  }

  /** 搬到目的地；目的地已有別的檔案就加上 (2)、(3) */
  private moveTo(from: string, relDir: string, name: string): string {
    const ext = path.extname(name)
    const stem = name.slice(0, name.length - ext.length)
    let rel = path.join(relDir, name)
    for (let i = 2; fs.existsSync(this.abs(rel)) && path.resolve(this.abs(rel)) !== path.resolve(from); i++) {
      rel = path.join(relDir, `${stem} (${i})${ext}`)
    }
    if (path.resolve(this.abs(rel)) !== path.resolve(from)) {
      fs.mkdirSync(path.dirname(this.abs(rel)), { recursive: true })
      fs.renameSync(from, this.abs(rel))
    }
    return rel
  }

  /** 整理一個專案，回傳應該保留的資料夾 */
  organizeProject(projectId: string): string[] {
    const { folders, papers, owners } = planProject(this.store, projectId)
    // 專案、心智圖、節點改名：整個資料夾跟著改名，使用者自己放的檔案也一起搬（由上往下，子資料夾已經跟著父資料夾搬過）
    // 已套用的改名（舊路徑 → 新路徑），之後的路徑都先換算到新的位置
    const applied: { from: string; to: string }[] = []
    const remap = (rel: string): string =>
      applied.reduce((r, a) => (r === a.from || r.startsWith(a.from + path.sep) ? a.to + r.slice(a.from.length) : r), rel)
    const folderUpdates: Owner[] = []
    for (const o of owners) {
      if (o.recorded && o.recorded !== o.rel) {
        const fromRel = remap(o.recorded)
        if (fromRel !== o.rel) {
          const from = this.abs(fromRel)
          const to = this.abs(o.rel)
          if (fs.existsSync(from) && !fs.existsSync(to)) {
            fs.mkdirSync(path.dirname(to), { recursive: true })
            fs.renameSync(from, to)
          }
          applied.push({ from: fromRel, to: o.rel })
        }
      }
      if (o.recorded !== o.rel) folderUpdates.push(o)
    }
    if (folderUpdates.length) this.store.write((tx) => folderUpdates.forEach((o) => tx.set(o.tb, o.id, { folder: o.rel })))
    for (const f of folders) fs.mkdirSync(this.abs(f), { recursive: true })

    const rows = this.store.all<PaperRow>('SELECT id, project_id, kind, title, year, authors, files FROM papers WHERE project_id = ?', [projectId])
    const updates: Record<string, string> = {}
    for (const p of rows) {
      const plan = papers.get(p.id)!
      const raw = currentFiles(p)
      const cur: PaperFiles = { main: raw.main.map(remap), txt: raw.txt && remap(raw.txt), links: raw.links.map(remap) }
      const next: PaperFiles = { main: [], txt: null, links: [] }
      let missing = false

      // 主要檔案
      for (const rel of cur.main) {
        const at = this.find(rel)
        if (!at) {
          missing = true // 可能另一台電腦剛搬走、還沒同步過來；先保留原記錄
          next.main.push(rel)
          continue
        }
        next.main.push(this.moveTo(at, plan.dir, `${plan.base}${path.extname(rel)}`))
      }
      // 全文
      if (cur.txt) {
        const at = this.find(cur.txt)
        if (at) next.txt = this.moveTo(at, plan.txtDir, `${plan.base}.txt`)
        else {
          next.txt = cur.txt
          missing = true
        }
      }
      // 捷徑：其他連結的節點；不需要的刪掉（只刪我們建立的 .lnk）
      const target = next.main[0] && !missing ? this.find(next.main[0]) : null
      const wanted = target ? plan.shortcutDirs.map((d) => path.join(d, `${plan.base}.lnk`)) : []
      for (const old of cur.links) if (!wanted.includes(old)) fs.rmSync(this.abs(old), { force: true })
      for (const rel of wanted) {
        try {
          this.writeShortcut(this.abs(rel), target!)
          next.links.push(rel)
        } catch {
          /* 捷徑建立失敗不影響其他整理 */
        }
      }
      const json = JSON.stringify(next)
      if (json !== p.files) updates[p.id] = json
    }
    if (Object.keys(updates).length) {
      this.store.write((tx) => Object.entries(updates).forEach(([id, files]) => tx.set('papers', id, { files })))
    }
    return folders.map((f) => path.resolve(this.abs(f)))
  }

  /** 刪掉不再對應任何節點、而且完全是空的資料夾；回傳是否刪掉（裡面有任何檔案或要保留的資料夾就不動） */
  private prune(dir: string, keep: Set<string>): boolean {
    let removable = true
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!this.prune(path.join(dir, entry.name), keep)) removable = false
      } else removable = false
    }
    if (removable && !keep.has(path.resolve(dir))) {
      fs.rmdirSync(dir)
      return true
    }
    return false
  }

  /** 整理完所有專案後：清掉空的舊資料夾（包含專案改名後留下的舊專案資料夾） */
  private pruneAll(keep: Set<string>): void {
    const root = this.library.filesDir
    if (!fs.existsSync(root)) return
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory()) this.prune(path.join(root, entry.name), keep)
    }
  }
}
