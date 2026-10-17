import { useCallback, useEffect, useState } from 'react'
import type { AppStatus, Milestone, Project, Task } from '../../shared/types'

export const desk = window.desk

export interface DeskState {
  status: AppStatus
  projects: Project[]
  projectId: string | null
  milestones: Milestone[]
  tasks: Task[]
}

/** 載入目前專案的所有資料；任何視窗修改資料後自動重新整理 */
export function useDesk(): DeskState | null {
  const [state, setState] = useState<DeskState | null>(null)

  const load = useCallback(async () => {
    const [status, projects] = await Promise.all([desk.status(), desk.projects.list()])
    const projectId =
      status.currentProjectId && projects.some((p) => p.id === status.currentProjectId)
        ? status.currentProjectId
        : (projects[0]?.id ?? null)
    const [milestones, tasks] = projectId
      ? await Promise.all([desk.milestones.list(projectId), desk.tasks.list(projectId)])
      : [[], []]
    setState({ status, projects, projectId, milestones, tasks })
  }, [])

  useEffect(() => {
    load()
    return desk.onChanged(load)
  }, [load])

  return state
}

/** 執行操作並捕捉錯誤訊息（例如唯讀模式） */
export function useRun(): [string | null, (fn: () => Promise<unknown>) => Promise<void>, () => void] {
  const [error, setError] = useState<string | null>(null)
  const run = useCallback(async (fn: () => Promise<unknown>) => {
    try {
      setError(null)
      await fn()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // Electron 會在訊息前加上 "Error invoking remote method ..."，只保留後半
      setError(msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    }
  }, [])
  return [error, run, () => setError(null)]
}
