// 主程式與畫面之間共用的資料型別

export interface Project {
  id: string
  name: string
  created_at: string
}

export interface Milestone {
  id: string
  project_id: string
  title: string
  due_date: string | null // YYYY-MM-DD
  done: number // 0 或 1
  sort: number
  is_defense: number // 1 = 口試倒數依據
}

export interface Task {
  id: string
  project_id: string
  title: string
  due_date: string | null // YYYY-MM-DD
  done: number
  done_at: string | null
  created_at: string
}

export interface SyncStatus {
  enabled: boolean
  /** 雲端資料夾（…\ResearchDesk） */
  dir: string | null
  /** 雲端資料夾目前找得到；找不到時照常使用本機資料 */
  available: boolean
  /** 曾經同步過資料的其他電腦數量 */
  otherDevices: number
  lastSyncAt: number | null
}

export interface CloudCandidate {
  label: string
  path: string
  /** 裡面已經有 ResearchDesk 資料（例如另一台電腦已經在用） */
  hasData: boolean
}

export type SyncEnableResult = 'done' | 'needsChoice'
export type SyncChoice = 'merge' | 'discard'

/** 邊欄面板在邊欄視窗裡的位置（像素，從視窗頂端算起） */
export interface SidebarLayout {
  expanded: boolean
  top: number
  height: number
  dragging: boolean
}

export interface AppStatus {
  sync: SyncStatus
  /** 目前資料所在的資料夾（雲端或本機） */
  dataDir: string
  currentProjectId: string | null
  launchAtLogin: boolean
  /** 邊欄小條的垂直位置，0 = 最上方、1 = 最下方 */
  sidebarTop: number
  version: string
}

export type MilestonePatch = Partial<Pick<Milestone, 'title' | 'due_date' | 'done'>>
export type TaskPatch = Partial<Pick<Task, 'title' | 'due_date' | 'done'>>

export interface DeskApi {
  status(): Promise<AppStatus>
  projects: {
    list(): Promise<Project[]>
    create(name: string): Promise<Project>
    rename(id: string, name: string): Promise<void>
    remove(id: string): Promise<void>
    setCurrent(id: string): Promise<void>
  }
  milestones: {
    list(projectId: string): Promise<Milestone[]>
    create(projectId: string, title: string): Promise<void>
    update(id: string, patch: MilestonePatch): Promise<void>
    remove(id: string): Promise<void>
    move(id: string, direction: -1 | 1): Promise<void>
    setDefense(id: string): Promise<void>
  }
  tasks: {
    list(projectId: string): Promise<Task[]>
    create(projectId: string, title: string, dueDate: string | null): Promise<void>
    update(id: string, patch: TaskPatch): Promise<void>
    remove(id: string): Promise<void>
  }
  sync: {
    candidates(): Promise<CloudCandidate[]>
    /** 開啟資料夾選擇視窗，取消時回傳 null */
    pickFolder(): Promise<string | null>
    enable(folder: string, choice?: SyncChoice): Promise<SyncEnableResult>
    disable(): Promise<void>
    now(): Promise<AppStatus>
  }
  settings: {
    openDataDir(): Promise<void>
    setLaunchAtLogin(on: boolean): Promise<void>
  }
  window: {
    /** 告訴主程式面板目前的範圍，用來判斷滑鼠在不在邊欄上 */
    setSidebarLayout(layout: SidebarLayout): Promise<void>
    saveSidebarTop(ratio: number): Promise<void>
    openFull(): Promise<void>
    closeFull(): Promise<void>
    quit(): Promise<void>
  }
  /** 主程式偵測到滑鼠移到細條上（enter），或離開邊欄一段時間（leave） */
  onSidebarHover(callback: (event: 'enter' | 'leave') => void): () => void
  onChanged(callback: () => void): () => void
}

// 心理學碩士論文里程碑範本
export const MILESTONE_TEMPLATE: { title: string; isDefense?: boolean }[] = [
  { title: '研究計畫書撰寫' },
  { title: '計畫書口試' },
  { title: 'IRB 送審' },
  { title: 'IRB 核准' },
  { title: '資料蒐集' },
  { title: '資料分析' },
  { title: '論文撰寫' },
  { title: '學位口試', isDefense: true },
  { title: '論文修改與上傳' }
]
