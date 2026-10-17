import { useState } from 'react'
import { extractPdfText } from './pdf'
import { desk } from './useDesk'

/** 匯入工作的進度（文獻頁、心智圖共用） */
export interface Job {
  key: string
  label: string
  state: 'working' | 'done' | 'error'
  message?: string
}

/** 主程式丟回來的錯誤去掉 Electron 加的前綴 */
export function errorText(err: unknown): string {
  return err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err)
}

export function isPdf(file: File): boolean {
  return /\.pdf$/i.test(file.name)
}

export async function importPdfFile(projectId: string, file: File, noAi: boolean): Promise<string> {
  const data = await file.arrayBuffer()
  const pages = await extractPdfText(data)
  return desk.papers.importPdf(projectId, { name: file.name, data, pages, noAi })
}

/**
 * 最近 6 筆匯入工作；run 會更新狀態並回傳新文獻的 id（失敗回傳 null）。
 * autoHide：完成幾毫秒後從清單移除（失敗的多留一段時間）
 */
export function useImportJobs(autoHide?: number): {
  jobs: Job[]
  run: (label: string, work: () => Promise<string>) => Promise<string | null>
} {
  const [jobs, setJobs] = useState<Job[]>([])
  const update = (key: string, patch: Partial<Job>): void => {
    setJobs((list) => list.map((j) => (j.key === key ? { ...j, ...patch } : j)))
    if (autoHide) window.setTimeout(() => setJobs((list) => list.filter((j) => j.key !== key)), patch.state === 'error' ? autoHide * 3 : autoHide)
  }
  const run = async (label: string, work: () => Promise<string>): Promise<string | null> => {
    const key = `${Date.now()}-${Math.random()}`
    setJobs((list) => [{ key, label, state: 'working' as const }, ...list].slice(0, 6))
    try {
      const id = await work()
      update(key, { state: 'done' })
      return id
    } catch (err) {
      update(key, { state: 'error', message: errorText(err) })
      return null
    }
  }
  return { jobs, run }
}

export function JobList({ jobs, className = '' }: { jobs: Job[]; className?: string }) {
  if (jobs.length === 0) return null
  return (
    <ul className={`lit-jobs ${className}`}>
      {jobs.map((j) => (
        <li key={j.key} className={`job is-${j.state}`}>
          <span className="job-label">{j.label}</span>
          <span className="job-state">{j.state === 'working' ? '處理中…' : j.state === 'done' ? '已加入' : j.message}</span>
        </li>
      ))}
    </ul>
  )
}
