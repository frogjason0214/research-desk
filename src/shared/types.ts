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

// ---------- 文獻 ----------

export interface Author {
  family: string
  given: string
}

/** 書目欄位（APA 引用格式會用到的部分） */
export interface Bib {
  title: string
  authors: Author[]
  year: string
  /** 網頁的發布日期 YYYY-MM-DD（可只有年或年月） */
  date: string
  /** 期刊名稱，或網頁的網站名稱 */
  journal: string
  volume: string
  issue: string
  pages: string
  doi: string
  url: string
}

export interface Paper extends Bib {
  id: string
  project_id: string
  /** pdf：PDF；web：網頁快照；ref：只有書目與摘要（從推薦加入） */
  kind: 'pdf' | 'web' | 'ref'
  lang: 'en' | 'zh'
  /** ok：書目已確認；pending：待確認（AI 判讀或還沒有書目） */
  bib_status: 'ok' | 'pending'
  study_type: string
  sample: string
  measures: string
  findings: string
  /** 1 = 上面四項是 AI 預填，請核對 */
  ai_filled: number
  notes: string
  /** 1 = 這篇文獻（全文與欄位）永不送 AI */
  no_ai: number
  /** 1 = 筆記永不送 AI */
  notes_no_ai: number
  /** ok：已抽出全文；empty：PDF 沒有文字（掃描檔）；pending：處理中 */
  text_status: 'ok' | 'empty' | 'pending'
  /** 正在背景查書目或 AI 預填（只在這台電腦、這次執行有效） */
  busy: number
  /** 背景處理最後一次的錯誤 */
  error: string | null
  added_at: string
}

export interface PaperHit {
  paperId: string
  page: number
  text: string
}

export type PaperPatch = Partial<
  Pick<
    Paper,
    | 'title'
    | 'year'
    | 'date'
    | 'journal'
    | 'volume'
    | 'issue'
    | 'pages'
    | 'doi'
    | 'url'
    | 'study_type'
    | 'sample'
    | 'measures'
    | 'findings'
    | 'notes'
    | 'no_ai'
    | 'notes_no_ai'
    | 'ai_filled'
    | 'lang'
  >
> & { authors?: Author[] }

export interface PdfImport {
  name: string
  data: ArrayBuffer
  /** 每一頁抽出的文字 */
  pages: string[]
  noAi: boolean
}

export interface AiStatus {
  hasKey: boolean
  model: string
  /** 匯入文獻時自動使用 AI（這台電腦的設定） */
  autoFill: boolean
  /** 每天第一次展開邊欄時產生每日建議 */
  daily: boolean
  hasOpenAlexKey: boolean
}

/** 心理學研究類型（AI 預填也從這裡選） */
export const STUDY_TYPES = ['實驗', '準實驗', '問卷調查', '縱貫研究', '質性研究', '混合方法', '後設分析', '系統性回顧', '個案研究', '理論／評論', '其他']

// ---------- 心智圖 ----------

export interface MindMap {
  id: string
  project_id: string
  name: string
  created_at: string
}

export interface MindNode {
  id: string
  map_id: string
  /** null = 中心節點 */
  parent_id: string | null
  text: string
  x: number
  y: number
  /** 1 = 子分支收合 */
  collapsed: number
  color: string
}

export type NodePatch = Partial<Pick<MindNode, 'text' | 'x' | 'y' | 'collapsed' | 'color'>>

export type LinkType = 'node' | 'task' | 'paper'

/** 指向某個心智圖節點 */
export interface NodeRef {
  mapId: string
  mapName: string
  nodeId: string
  text: string
}

export interface PaperRef {
  id: string
  title: string
  year: string
}

/** 節點連到的文獻與待辦 */
export interface NodeLinks {
  papers: PaperRef[]
  tasks: Task[]
}

/** 待辦連到的節點與文獻（待辦頁顯示用） */
export interface TaskLinks {
  nodes: NodeRef[]
  papers: PaperRef[]
}

/** 跨頁面跳轉：從文獻跳到節點、從節點跳到文獻、從每日建議跳到對話 */
export type Focus =
  | { page: 'literature'; paperId: string }
  | { page: 'mindmap'; mapId: string; nodeId: string }
  | { page: 'professor'; conversationId: string }

// ---------- AI 教授 ----------

/** direction：研究方向與缺口；methods：研究方法與統計；committee：模擬口試委員；general：一般討論 */
export type ProfessorRole = 'direction' | 'methods' | 'committee' | 'general'

export const ROLE_LABELS: Record<ProfessorRole, string> = {
  direction: '研究方向與缺口',
  methods: '研究方法與統計',
  committee: '模擬口試委員',
  general: '一般討論'
}

/** 回答引用的來源：S＝文獻段落，P＝文獻整體（書目與欄位） */
export interface Source {
  key: string
  paperId: string
  title: string
  year: string
  page: number
}

export interface Conversation {
  id: string
  project_id: string
  title: string
  role: ProfessorRole
  created_at: string
  updated_at: string
}

export interface ChatMessage {
  id: string
  conversation_id: string
  role: 'user' | 'model'
  text: string
  sources: Source[]
  created_at: string
}

export interface DailyTip {
  date: string
  role: ProfessorRole
  text: string
  sources: Source[]
}

/** 推薦的新文獻：一定是在 OpenAlex 查得到、有 DOI 的論文 */
export interface Recommendation {
  doi: string
  title: string
  year: string
  authors: string
  venue: string
  citedBy: number
  url: string
  abstract: string
  /** AI 寫的推薦理由 */
  reason: string
  /** 已經在文獻庫裡 */
  inLibrary: boolean
}

export interface AiStream {
  conversationId: string
  /** 目前為止的完整回覆 */
  text: string
  done: boolean
}

// ---------- Google 行事曆 ----------

export interface GoogleStatus {
  /** 這個版本有沒有設定 Google 用戶端（.env） */
  configured: boolean
  state: 'signedOut' | 'signedIn' | 'expired'
  email: string | null
}

export interface CalendarInfo {
  id: string
  name: string
  color: string
  primary: boolean
  /** 自動建立的「研究任務」行事曆 */
  research: boolean
  writable: boolean
}

export interface CalendarEvent {
  id: string
  calendarId: string
  title: string
  description: string
  allDay: boolean
  /** 全天：YYYY-MM-DD；有時間：ISO 8601 */
  start: string
  /** 全天：最後一天（含）；有時間：ISO 8601 */
  end: string
  color: string
  /** 由待辦產生的事件，請在待辦修改 */
  taskId: string | null
  writable: boolean
  link: string | null
}

export interface EventInput {
  calendarId: string
  title: string
  description: string
  allDay: boolean
  /** 全天：YYYY-MM-DD；有時間：本地時間 YYYY-MM-DDTHH:mm */
  start: string
  /** 全天：最後一天（含）；有時間：本地時間 YYYY-MM-DDTHH:mm */
  end: string
}

/** 邊欄面板在邊欄視窗裡的位置（像素，從視窗頂端算起） */
export interface SidebarLayout {
  expanded: boolean
  top: number
  height: number
  dragging: boolean
}

export interface UpdateStatus {
  /** dev：開發模式不檢查；latest：已是最新版；ready：新版已下載，重新啟動即可更新 */
  state: 'dev' | 'idle' | 'checking' | 'latest' | 'downloading' | 'ready' | 'error'
  version?: string
  progress?: number
  error?: string
}

export interface AppStatus {
  sync: SyncStatus
  update: UpdateStatus
  google: GoogleStatus & {
    /** 待辦同步到行事曆時最後一次的錯誤 */
    taskSyncError: string | null
  }
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
  papers: {
    list(projectId: string): Promise<Paper[]>
    importPdf(projectId: string, file: PdfImport): Promise<string>
    importWeb(projectId: string, url: string, noAi: boolean): Promise<string>
    /** 從推薦加入：只有書目與摘要 */
    importDoi(projectId: string, rec: Recommendation): Promise<string>
    update(id: string, patch: PaperPatch): Promise<void>
    confirmBib(id: string): Promise<void>
    lookupDoi(id: string, doi: string): Promise<void>
    aiFill(id: string): Promise<void>
    /** file：PDF 或正文快照；page：網頁整頁快照 */
    open(id: string, which: 'file' | 'page'): Promise<void>
    remove(id: string): Promise<void>
    search(projectId: string, query: string): Promise<PaperHit[]>
    /** 複製到剪貼簿（純文字與 HTML，貼到 Word 會保留斜體） */
    copy(text: string, html: string): Promise<void>
  }
  mindmaps: {
    list(projectId: string): Promise<MindMap[]>
    create(projectId: string, name: string): Promise<MindMap>
    rename(id: string, name: string): Promise<void>
    remove(id: string): Promise<void>
    /** 另存 PNG 圖片（會跳出存檔視窗）；取消時回傳 false */
    saveImage(name: string, dataUrl: string): Promise<boolean>
  }
  nodes: {
    list(mapId: string): Promise<MindNode[]>
    add(mapId: string, parentId: string, text: string, pos?: { x: number; y: number }): Promise<string>
    update(id: string, patch: NodePatch): Promise<void>
    move(moves: { id: string; x: number; y: number }[]): Promise<void>
    remove(id: string): Promise<void>
    createTask(nodeId: string, title: string, dueDate: string | null): Promise<void>
  }
  links: {
    add(t1: LinkType, id1: string, t2: LinkType, id2: string): Promise<void>
    remove(t1: LinkType, id1: string, t2: LinkType, id2: string): Promise<void>
    forNode(nodeId: string): Promise<NodeLinks>
    forMap(mapId: string): Promise<Record<string, { papers: number; tasks: number }>>
    forPaper(paperId: string): Promise<NodeRef[]>
    forTasks(projectId: string): Promise<Record<string, TaskLinks>>
  }
  ai: {
    status(): Promise<AiStatus>
    setKey(key: string): Promise<void>
    clearKey(): Promise<void>
    setAutoFill(on: boolean): Promise<void>
    setDaily(on: boolean): Promise<void>
    setOpenAlexKey(key: string): Promise<void>
  }
  professor: {
    conversations(projectId: string): Promise<Conversation[]>
    create(projectId: string, role: ProfessorRole): Promise<Conversation>
    rename(id: string, title: string): Promise<void>
    remove(id: string): Promise<void>
    messages(conversationId: string): Promise<ChatMessage[]>
    /** 回覆透過 onAiStream 逐步送來；完成後存進對話紀錄 */
    send(conversationId: string, text: string): Promise<void>
    /** 今天的建議；還沒有就產生（沒有金鑰或關閉時回傳 null） */
    daily(projectId: string): Promise<DailyTip | null>
    /** 從今天的建議開一個對話，回傳對話 ID */
    startFromTip(projectId: string): Promise<string>
    recommend(projectId: string): Promise<Recommendation[]>
  }
  google: {
    signIn(): Promise<void>
    signOut(): Promise<void>
  }
  calendar: {
    calendars(): Promise<CalendarInfo[]>
    /** [from, to) 之間的行程，日期為 YYYY-MM-DD */
    events(from: string, to: string): Promise<CalendarEvent[]>
    create(input: EventInput): Promise<void>
    update(calendarId: string, id: string, input: EventInput): Promise<void>
    remove(calendarId: string, id: string): Promise<void>
  }
  update: {
    check(): Promise<void>
    /** 結束程式並安裝已下載的新版本 */
    install(): Promise<void>
  }
  settings: {
    openDataDir(): Promise<void>
    setLaunchAtLogin(on: boolean): Promise<void>
  }
  window: {
    /** 告訴主程式面板目前的範圍，用來判斷滑鼠在不在邊欄上 */
    setSidebarLayout(layout: SidebarLayout): Promise<void>
    saveSidebarTop(ratio: number): Promise<void>
    openFull(focus?: Focus): Promise<void>
    closeFull(): Promise<void>
    quit(): Promise<void>
  }
  /** 主程式偵測到滑鼠移到細條上（enter），或離開邊欄一段時間（leave） */
  onSidebarHover(callback: (event: 'enter' | 'leave') => void): () => void
  onChanged(callback: () => void): () => void
  onAiStream(callback: (s: AiStream) => void): () => void
  /** 其他視窗要求完整視窗跳到某一頁 */
  onNavigate(callback: (f: Focus) => void): () => void
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
