import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { replayOps } from '../../shared/annots'
import type { PdfAnnot, PdfAnnotOp, ReaderOpen, ReaderStatus } from '../../shared/types'
import type { Library } from '../library'
import { applyOps, loadPdf, readAnnots, stripManaged, UnsupportedPdfError } from './annotations'

// PDF 閱讀器的存檔：畫面送來的修改先排隊（也寫進本機的暫存檔，程式關掉也不會遺失），
// 再寫回文獻原本的 PDF。每次寫入前重新讀一次檔案，只套用這台電腦的修改，
// 所以另一台電腦剛畫的重點也會留下。檔案被 Acrobat 等程式開著時，等一下再試。

/** 第一次畫重點前的原檔備份（「文獻」資料夾裡的隱藏資料夾） */
export const BACKUP_DIR = '.原始檔'
const RETRY_MS = 5000
const MAX_REREAD = 3

const backupRel = (paperId: string): string => `${BACKUP_DIR}/${paperId}.pdf`

class LockedError extends Error {}

const isLock = (err: unknown): boolean => ['EBUSY', 'EPERM', 'EACCES'].includes((err as NodeJS.ErrnoException).code ?? '')

/** 讀檔；被其他程式鎖住時丟 LockedError */
function readFile(file: string): Uint8Array {
  try {
    return new Uint8Array(fs.readFileSync(file))
  } catch (err) {
    if (isLock(err)) throw new LockedError()
    throw err
  }
}

/** 先寫暫存檔再改名；檔案被其他程式鎖住時丟 LockedError */
function replaceFile(dest: string, data: Uint8Array): void {
  const tmp = path.join(path.dirname(dest), `.${path.basename(dest)}.rdtmp`)
  fs.writeFileSync(tmp, data)
  try {
    fs.renameSync(tmp, dest)
  } catch (err) {
    fs.rmSync(tmp, { force: true })
    if (isLock(err)) throw new LockedError()
    throw err
  }
}

export function createReader(opts: {
  library: Library
  /** 文獻 PDF 目前的完整路徑（文獻整理可能搬動檔案，每次都重新找） */
  locate: (paperId: string) => string | null
  /** 還沒寫進 PDF 的修改存在這裡 */
  pendingFile: string
  emit: (s: ReaderStatus) => void
  retryMs?: number
}) {
  const { library, locate } = opts
  let pending: Record<string, PdfAnnotOp[]> = {}
  try {
    pending = JSON.parse(fs.readFileSync(opts.pendingFile, 'utf8')) as Record<string, PdfAnnotOp[]>
  } catch {
    /* 沒有暫存 */
  }
  const persist = (): void => {
    const live = Object.fromEntries(Object.entries(pending).filter(([, ops]) => ops.length))
    if (Object.keys(live).length) fs.writeFileSync(opts.pendingFile, JSON.stringify(live))
    else fs.rmSync(opts.pendingFile, { force: true })
  }
  /** 檔案裡最後讀到的註記（加上排隊中的修改就是畫面上該看到的） */
  const fileAnnots = new Map<string, PdfAnnot[]>()
  const states = new Map<string, ReaderStatus>()
  const chains = new Map<string, Promise<void>>()
  const timers = new Map<string, NodeJS.Timeout>()

  const report = (paperId: string, state: ReaderStatus['state'], error?: string): ReaderStatus => {
    const s: ReaderStatus = { paperId, annots: replayOps(fileAnnots.get(paperId) ?? [], pending[paperId] ?? []), state, error }
    states.set(paperId, s)
    opts.emit(s)
    return s
  }

  const hasBackup = (paperId: string): boolean => !!library.resolveFile(backupRel(paperId))

  const makeBackup = (bytes: Uint8Array, paperId: string): void => {
    library.writeFile(backupRel(paperId), bytes)
    const dir = path.join(library.filesDir, BACKUP_DIR)
    if (process.platform === 'win32') execFile('attrib', ['+h', dir], () => undefined)
  }

  /** 把排隊的修改寫進 PDF */
  const save = async (paperId: string): Promise<void> => {
    const ops = pending[paperId] ?? []
    if (!ops.length) return
    for (let attempt = 0; attempt < MAX_REREAD; attempt++) {
      const file = locate(paperId)
      if (!file) {
        report(paperId, 'error', '找不到 PDF 檔。如果剛在另一台電腦匯入，請等雲端硬碟同步完成。')
        return
      }
      const before = fs.statSync(file)
      const bytes = readFile(file)
      const doc = await loadPdf(bytes)
      if (!hasBackup(paperId)) makeBackup(bytes, paperId)
      applyOps(doc, ops)
      const out = await doc.save()
      // 讀檔到寫檔之間檔案被搬走（文獻整理）就寫到新位置；被另一台改過就重來一次
      const target = locate(paperId) ?? file
      const now = fs.statSync(target)
      if (now.mtimeMs !== before.mtimeMs || now.size !== before.size) continue
      replaceFile(target, out)
      fileAnnots.set(paperId, readAnnots(doc))
      pending[paperId] = (pending[paperId] ?? []).slice(ops.length)
      persist()
      if (pending[paperId].length) schedule(paperId, 0)
      report(paperId, pending[paperId].length ? 'pending' : 'saved')
      return
    }
    throw new Error('PDF 一直在變動（可能正在同步），稍後再試。')
  }

  const run = (paperId: string): Promise<void> => {
    const next = (chains.get(paperId) ?? Promise.resolve())
      .then(() => save(paperId))
      .catch((err) => {
        if (err instanceof LockedError) {
          report(paperId, 'locked')
          schedule(paperId, opts.retryMs ?? RETRY_MS)
        } else if (err instanceof UnsupportedPdfError) {
          // 只能閱讀的檔案不會有修改；保險起見丟掉
          pending[paperId] = []
          persist()
          report(paperId, 'error', err.message)
        } else {
          report(paperId, 'error', err instanceof Error ? err.message : String(err))
          schedule(paperId, opts.retryMs ?? RETRY_MS)
        }
      })
    chains.set(paperId, next)
    return next
  }

  function schedule(paperId: string, ms: number): void {
    clearTimeout(timers.get(paperId))
    timers.set(
      paperId,
      setTimeout(() => {
        timers.delete(paperId)
        void run(paperId)
      }, ms)
    )
  }

  // 上次沒寫完的修改：啟動後再試
  for (const id of Object.keys(pending)) schedule(id, 2000)

  return {
    open: async (paperId: string): Promise<ReaderOpen> => {
      await chains.get(paperId)
      const file = locate(paperId)
      if (!file) throw new Error('找不到 PDF 檔。如果剛在另一台電腦匯入，請等雲端硬碟同步完成。')
      let bytes: Uint8Array
      try {
        bytes = readFile(file)
      } catch (err) {
        if (err instanceof LockedError) throw new Error('這個 PDF 被其他程式鎖住（例如 Acrobat），請先關掉再開啟。')
        throw err
      }
      try {
        const doc = await loadPdf(bytes)
        fileAnnots.set(paperId, readAnnots(doc))
        const data = await stripManaged(doc)
        return { data, annots: replayOps(fileAnnots.get(paperId)!, pending[paperId] ?? []), readOnly: null, hasBackup: hasBackup(paperId) }
      } catch (err) {
        if (!(err instanceof UnsupportedPdfError)) throw err
        return { data: bytes, annots: [], readOnly: err.message, hasBackup: hasBackup(paperId) }
      }
    },

    /** 畫面送來的修改：排隊並馬上試著寫入 */
    queue: (paperId: string, ops: PdfAnnotOp[]): ReaderStatus => {
      pending[paperId] = [...(pending[paperId] ?? []), ...ops]
      persist()
      const s = report(paperId, 'pending')
      clearTimeout(timers.get(paperId))
      void run(paperId)
      return s
    },

    status: (paperId: string): ReaderStatus | null => states.get(paperId) ?? null,

    hasBackup,

    /** 還原成第一次畫重點前的原檔 */
    restore: async (paperId: string): Promise<void> => {
      await chains.get(paperId)
      const backup = library.resolveFile(backupRel(paperId))
      const file = locate(paperId)
      if (!backup || !file) throw new Error('找不到原始 PDF 的備份。')
      clearTimeout(timers.get(paperId))
      const original = new Uint8Array(fs.readFileSync(backup))
      try {
        replaceFile(file, original)
      } catch (err) {
        if (err instanceof LockedError) throw new Error('這個 PDF 正在其他程式開著（例如 Acrobat），請先關掉再還原。')
        throw err
      }
      pending[paperId] = []
      persist()
      library.removeFile(backupRel(paperId))
      // 原檔裡可能本來就有其他程式畫的重點
      fileAnnots.set(paperId, await loadPdf(original).then(readAnnots, () => []))
      report(paperId, 'saved')
    },

    /** 刪除文獻時一起刪掉備份與排隊的修改 */
    forget: (paperId: string): void => {
      clearTimeout(timers.get(paperId))
      delete pending[paperId]
      persist()
      library.removeFile(backupRel(paperId))
    },

    /** 結束程式前：能寫的都寫進去（寫不進去的留在暫存檔，下次再試） */
    flush: async (): Promise<void> => {
      await Promise.all(Object.keys(pending).map((id) => (pending[id]?.length ? run(id) : Promise.resolve())))
    }
  }
}
