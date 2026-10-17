import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Archive, ExternalLink, FileText, FileUp, Globe, Link2, Newspaper, Trash2 } from 'lucide-react'
import { apaCitation, inTextCitation } from '../../../shared/apa'
import {
  STUDY_TYPES,
  type Author,
  type Focus,
  type NodeRef,
  type Paper,
  type PaperHit,
  type PaperPatch,
  type Task,
  type TaskLinks
} from '../../../shared/types'
import { IconButton } from '../components/IconButton'
import { importPdfFile, isPdf, JobList, useImportJobs } from '../importing'
import { desk } from '../useDesk'

type Run = (fn: () => Promise<unknown>) => Promise<void>

const authorLine = (p: Paper): string => {
  const names = p.authors.map((a) => (p.lang === 'zh' ? `${a.family}${a.given}` : a.family))
  if (names.length === 0) return ''
  return names.length > 3 ? `${names.slice(0, 3).join(p.lang === 'zh' ? '、' : ', ')} 等` : names.join(p.lang === 'zh' ? '、' : ', ')
}

export function LiteratureView({
  projectId,
  tasks,
  run,
  focusPaperId,
  onNavigate
}: {
  projectId: string
  tasks: Task[]
  run: Run
  focusPaperId: string | null
  onNavigate: (f: Focus) => void
}) {
  const [papers, setPapers] = useState<Paper[]>([])
  const [selected, setSelected] = useState<string | null>(focusPaperId)
  useEffect(() => {
    if (focusPaperId) setSelected(focusPaperId)
  }, [focusPaperId])
  const [filter, setFilter] = useState('')
  const [hits, setHits] = useState<PaperHit[] | null>(null)
  const { jobs, run: runJob } = useImportJobs()
  const [url, setUrl] = useState('')
  const [noAi, setNoAi] = useState(false)
  const [dragging, setDragging] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  const load = useCallback(() => desk.papers.list(projectId).then(setPapers), [projectId])
  useEffect(() => {
    load()
    return desk.onChanged(load)
  }, [load])

  const importFiles = async (files: File[]): Promise<void> => {
    for (const file of files.filter(isPdf)) {
      const id = await runJob(file.name, () => importPdfFile(projectId, file, noAi))
      if (id) setSelected(id)
    }
  }

  const importUrl = async (): Promise<void> => {
    const target = url.trim()
    if (!target) return
    setUrl('')
    const id = await runJob(target, () => desk.papers.importWeb(projectId, target, noAi))
    if (id) setSelected(id)
  }

  // 篩選標題、作者、期刊、筆記；按 Enter 才搜尋全文
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return papers
    return papers.filter((p) =>
      [p.title, p.journal, p.notes, p.findings, p.year, ...p.authors.map((a) => a.family + a.given)].join(' ').toLowerCase().includes(q)
    )
  }, [papers, filter])
  const current = papers.find((p) => p.id === selected) ?? null

  return (
    <div
      className={`lit${dragging ? ' is-dragging' : ''}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault()
          setDragging(true)
        }
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        importFiles([...e.dataTransfer.files])
      }}
    >
      <aside className="lit-list">
        <div className="lit-import">
          <button className="btn btn-primary btn-icon" onClick={() => fileInput.current?.click()}>
            <FileUp size={18} strokeWidth={1.8} aria-hidden />
            匯入 PDF
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="application/pdf"
            multiple
            hidden
            onChange={(e) => {
              importFiles([...(e.target.files ?? [])])
              e.target.value = ''
            }}
          />
          <form
            className="lit-url"
            onSubmit={(e) => {
              e.preventDefault()
              importUrl()
            }}
          >
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="貼上網址加入網頁" aria-label="網頁網址" />
            <IconButton icon={Link2} label="加入這個網頁" type="submit" disabled={!url.trim()} />
          </form>
          <label className="check muted">
            <input type="checkbox" checked={noAi} onChange={(e) => setNoAi(e.target.checked)} />
            這次匯入的不送 AI
          </label>
          <p className="muted lit-hint">也可以把 PDF 直接拖進這個頁面。</p>
        </div>

        <JobList jobs={jobs} />

        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (filter.trim()) desk.papers.search(projectId, filter).then(setHits)
          }}
        >
          <input
            className="lit-filter"
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value)
              setHits(null)
            }}
            placeholder="篩選標題、作者；按 Enter 搜尋全文"
            aria-label="篩選文獻"
          />
        </form>

        {hits ? (
          <HitList hits={hits} papers={papers} onOpen={setSelected} onClose={() => setHits(null)} />
        ) : papers.length === 0 ? (
          <p className="muted lit-empty">還沒有文獻。匯入 PDF 或貼上網址開始建立文獻庫。</p>
        ) : (
          <ul className="lit-items">
            {shown.map((p) => (
              <li key={p.id}>
                <button className={`lit-item${p.id === selected ? ' is-active' : ''}`} onClick={() => setSelected(p.id)}>
                  <span className="lit-item-title">{p.title || '（沒有標題）'}</span>
                  <span className="lit-item-meta">
                    {[authorLine(p), p.year].filter(Boolean).join('・') || (p.kind === 'web' ? p.journal : '')}
                  </span>
                  <span className="lit-badges">
                    {p.kind === 'web' && <span className="badge">網頁</span>}
                    {p.kind === 'ref' && <span className="badge">只有書目</span>}
                    {p.busy ? <span className="badge is-busy">處理中</span> : null}
                    {p.bib_status === 'pending' && !p.busy && <span className="badge is-warn">待確認</span>}
                    {p.no_ai ? <span className="badge">不送 AI</span> : null}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>

      <section className="lit-detail">
        {current ? (
          <PaperDetail
            key={current.id}
            paper={current}
            tasks={tasks}
            run={run}
            onDeleted={() => setSelected(null)}
            onNavigate={onNavigate}
          />
        ) : (
          <div className="empty-card">
            <h3>文獻庫</h3>
            <p className="muted">
              匯入的 PDF 會自動抽出全文；英文文獻用 DOI 向 CrossRef 查詢書目，中文文獻由 AI 判讀（標示「待確認」）。選左邊的文獻查看與編輯。
            </p>
          </div>
        )}
      </section>

      {dragging && <div className="drop-hint">放開以匯入 PDF</div>}
    </div>
  )
}

function HitList({
  hits,
  papers,
  onOpen,
  onClose
}: {
  hits: PaperHit[]
  papers: Paper[]
  onOpen: (id: string) => void
  onClose: () => void
}) {
  return (
    <div className="lit-hits">
      <div className="lit-hits-head">
        <span className="muted">全文搜尋：{hits.length} 個段落</span>
        <button className="link-btn" onClick={onClose}>
          返回列表
        </button>
      </div>
      <ul className="lit-items">
        {hits.map((h, i) => {
          const p = papers.find((x) => x.id === h.paperId)
          return (
            <li key={i}>
              <button className="lit-item" onClick={() => onOpen(h.paperId)}>
                <span className="lit-item-title">{p?.title}</span>
                <span className="lit-item-meta">{h.page ? `第 ${h.page} 頁` : '網頁'}</span>
                <span className="lit-snippet">{h.text.slice(0, 160)}…</span>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/** 失去焦點時才儲存的文字欄位 */
function Field({
  label,
  value,
  onSave,
  multiline,
  wide,
  placeholder
}: {
  label: string
  value: string
  onSave: (v: string) => void
  multiline?: boolean
  wide?: boolean
  placeholder?: string
}) {
  const props = {
    defaultValue: value,
    placeholder,
    onBlur: (e: { target: { value: string } }) => e.target.value.trim() !== value && onSave(e.target.value.trim())
  }
  // key 跟著值變，資料從別處更新時輸入框會換成新值
  return (
    <label className={`field${wide ? ' is-wide' : ''}`}>
      {label && <span>{label}</span>}
      {multiline ? <textarea key={value} rows={3} {...props} /> : <input key={value} {...props} />}
    </label>
  )
}

/** 文獻出現在哪些心智圖節點、連到哪些待辦（雙向連結） */
function PaperLinks({ paper, tasks, run, onNavigate }: { paper: Paper; tasks: Task[]; run: Run; onNavigate: (f: Focus) => void }) {
  const [nodes, setNodes] = useState<NodeRef[]>([])
  const [taskLinks, setTaskLinks] = useState<Record<string, TaskLinks>>({})
  const [pick, setPick] = useState('')
  useEffect(() => {
    const load = (): void => {
      desk.links.forPaper(paper.id).then(setNodes)
      desk.links.forTasks(paper.project_id).then(setTaskLinks)
    }
    load()
    return desk.onChanged(load)
  }, [paper.id, paper.project_id])

  const linkedTasks = tasks.filter((t) => taskLinks[t.id]?.papers.some((x) => x.id === paper.id))
  return (
    <section className="paper-section">
      <h3>出現在哪些節點</h3>
      {nodes.length === 0 ? (
        <p className="muted">還沒有心智圖節點連結這篇文獻。在「心智圖」選一個節點，就能從右側連結文獻。</p>
      ) : (
        <ul className="mm-links">
          {nodes.map((n) => (
            <li key={n.nodeId}>
              <button className="link-btn" onClick={() => onNavigate({ page: 'mindmap', mapId: n.mapId, nodeId: n.nodeId })}>
                {n.mapName} › {n.text}
              </button>
            </li>
          ))}
        </ul>
      )}
      <h3>相關待辦</h3>
      {linkedTasks.length > 0 && (
        <ul className="mm-links">
          {linkedTasks.map((t) => (
            <li key={t.id} className={t.done ? 'is-done' : ''}>
              <span>{t.title}</span>
              <button className="icon-btn" aria-label="取消連結" onClick={() => run(() => desk.links.remove('task', t.id, 'paper', paper.id))}>
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="inline-add">
        <select value={pick} onChange={(e) => setPick(e.target.value)} aria-label="選擇待辦">
          <option value="">連結到待辦…</option>
          {tasks
            .filter((t) => !t.done && !linkedTasks.includes(t))
            .map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
        </select>
        <button className="btn" disabled={!pick} onClick={() => run(async () => { await desk.links.add('task', pick, 'paper', paper.id); setPick('') })}>
          連結
        </button>
      </div>
    </section>
  )
}

function PaperDetail({
  paper: p,
  tasks,
  run,
  onDeleted,
  onNavigate
}: {
  paper: Paper
  tasks: Task[]
  run: Run
  onDeleted: () => void
  onNavigate: (f: Focus) => void
}) {
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const [doi, setDoi] = useState(p.doi)
  const update = (patch: PaperPatch): Promise<void> => run(() => desk.papers.update(p.id, patch))
  const cite = apaCitation(p, p.kind, p.lang)
  const inText = inTextCitation(p, p.lang)

  const copy = (what: string, text: string, html: string): void => {
    run(async () => {
      await desk.papers.copy(text, html)
      setCopied(what)
      setTimeout(() => setCopied(null), 1500)
    })
  }

  const setAuthors = (authors: Author[]): Promise<void> => update({ authors })

  return (
    <div className="paper">
      <header className="paper-head">
        <h2>{p.title || '（沒有標題）'}</h2>
        <div className="btn-row">
          <IconButton
            icon={p.kind === 'pdf' ? FileText : p.kind === 'ref' ? ExternalLink : Newspaper}
            label={p.kind === 'pdf' ? '開啟 PDF' : p.kind === 'ref' ? '開啟 DOI 連結' : '開啟正文快照'}
            onClick={() => run(() => desk.papers.open(p.id, 'file'))}
          />
          {p.kind === 'web' && <IconButton icon={Archive} label="開啟整頁快照" onClick={() => run(() => desk.papers.open(p.id, 'page'))} />}
          {p.kind === 'web' && p.url && (
            <a className="ibtn" href={p.url} target="_blank" rel="noreferrer" title="開啟原網頁" aria-label="開啟原網頁">
              <Globe size={18} strokeWidth={1.8} aria-hidden />
            </a>
          )}
          <span className="spacer" />
          <IconButton
            icon={Trash2}
            label={confirmDelete ? '再按一次刪除這篇文獻' : '刪除這篇文獻'}
            danger
            active={confirmDelete}
            onClick={() => (confirmDelete ? run(async () => { await desk.papers.remove(p.id); onDeleted() }) : setConfirmDelete(true))}
          />
        </div>
        {confirmDelete && <p className="muted">再按一次垃圾桶圖示就會刪除這篇文獻與它的檔案。</p>}
        {p.busy ? <p className="banner banner-info">正在查詢書目與整理欄位…</p> : null}
        {p.error && !p.busy ? <p className="banner banner-warn">{p.error}</p> : null}
        {p.kind === 'ref' && <p className="muted">這篇是從推薦加入的，只有書目與摘要。下載 PDF 後用「匯入 PDF」可以取得全文。</p>}
        {p.text_status === 'empty' && p.kind !== 'ref' && (
          <p className="muted">這份{p.kind === 'pdf' ? ' PDF 沒有文字層（可能是掃描檔）' : '網頁抓不到正文'}，全文搜尋與 AI 引用內文無法使用。</p>
        )}
      </header>

      <section className="paper-section">
        <h3>APA 參考文獻</h3>
        <p className="citation" dangerouslySetInnerHTML={{ __html: cite.html }} />
        <div className="btn-row">
          <button className="btn" onClick={() => copy('ref', cite.text, cite.html)}>
            {copied === 'ref' ? '已複製' : '複製參考文獻'}
          </button>
          <button className="btn" onClick={() => copy('in', inText, inText)}>
            {copied === 'in' ? '已複製' : `複製文中引用 ${inText}`}
          </button>
        </div>
      </section>

      <section className="paper-section">
        <div className="section-head">
          <h3>書目</h3>
          {p.bib_status === 'pending' ? (
            <>
              <span className="badge is-warn">待確認</span>
              <span className="spacer" />
              <button className="btn btn-primary" onClick={() => run(() => desk.papers.confirmBib(p.id))}>
                確認書目
              </button>
            </>
          ) : (
            <span className="badge is-ok">已確認</span>
          )}
        </div>
        {p.bib_status === 'pending' && (
          <p className="muted">書目由 AI 判讀或尚未取得，請對照原文核對後按「確認書目」。有 DOI 的話可以直接查詢。</p>
        )}
        <div className="field-grid">
          <Field label="篇名" value={p.title} onSave={(title) => update({ title })} wide />
          <AuthorsEditor authors={p.authors} lang={p.lang} onSave={setAuthors} />
          <Field label="年份" value={p.year} onSave={(year) => update({ year })} placeholder="2024" />
          {p.kind === 'web' && <Field label="發布日期" value={p.date} onSave={(date) => update({ date })} placeholder="2024-03-05" />}
          <Field label={p.kind === 'web' ? '網站／期刊' : '期刊'} value={p.journal} onSave={(journal) => update({ journal })} wide />
          <Field label="卷" value={p.volume} onSave={(volume) => update({ volume })} />
          <Field label="期" value={p.issue} onSave={(issue) => update({ issue })} />
          <Field label="頁碼" value={p.pages} onSave={(pages) => update({ pages })} placeholder="45-67" />
          <label className="field">
            <span>語言（決定引用格式）</span>
            <select value={p.lang} onChange={(e) => update({ lang: e.target.value as Paper['lang'] })}>
              <option value="en">英文</option>
              <option value="zh">中文</option>
            </select>
          </label>
          <div className="field is-wide">
            <span>DOI</span>
            <div className="inline-add">
              <input value={doi} onChange={(e) => setDoi(e.target.value)} placeholder="10.1037/..." onBlur={() => doi.trim() !== p.doi && update({ doi: doi.trim() })} />
              <button className="btn" disabled={!doi.trim() || !!p.busy} onClick={() => run(() => desk.papers.lookupDoi(p.id, doi))}>
                查詢 CrossRef
              </button>
            </div>
          </div>
          {p.kind === 'web' && <Field label="網址" value={p.url} onSave={(url) => update({ url })} wide />}
        </div>
      </section>

      <section className="paper-section">
        <div className="section-head">
          <h3>研究內容</h3>
          {p.ai_filled ? <span className="badge is-warn">AI 預填，請核對</span> : null}
          <span className="spacer" />
          {p.ai_filled ? (
            <button className="btn" onClick={() => update({ ai_filled: 0 })}>
              核對完成
            </button>
          ) : null}
          <button
            className="btn"
            disabled={!!p.no_ai || !!p.busy}
            title={p.no_ai ? '這篇勾選了「不送 AI」' : '空白的欄位由 AI 預填'}
            onClick={() => run(() => desk.papers.aiFill(p.id))}
          >
            AI 預填
          </button>
        </div>
        <div className="field-grid">
          <label className="field">
            <span>研究類型</span>
            <select value={p.study_type} onChange={(e) => update({ study_type: e.target.value })}>
              <option value="">（未填）</option>
              {[...new Set([...STUDY_TYPES, ...(p.study_type ? [p.study_type] : [])])].map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <Field label="樣本數與對象" value={p.sample} onSave={(sample) => update({ sample })} wide />
          <Field label="使用量表" value={p.measures} onSave={(measures) => update({ measures })} wide multiline />
          <Field label="主要發現" value={p.findings} onSave={(findings) => update({ findings })} wide multiline />
        </div>
      </section>

      <PaperLinks paper={p} tasks={tasks} run={run} onNavigate={onNavigate} />

      <section className="paper-section">
        <h3>筆記</h3>
        <Field label="" value={p.notes} onSave={(notes) => update({ notes })} wide multiline />
        <label className="check">
          <input type="checkbox" checked={!!p.notes_no_ai} onChange={(e) => update({ notes_no_ai: e.target.checked ? 1 : 0 })} />
          筆記不送 AI
        </label>
      </section>

      <section className="paper-section">
        <label className="check">
          <input type="checkbox" checked={!!p.no_ai} onChange={(e) => update({ no_ai: e.target.checked ? 1 : 0 })} />
          這篇文獻不送 AI（全文、欄位與筆記都不會送出）
        </label>
      </section>
    </div>
  )
}

function AuthorsEditor({ authors, lang, onSave }: { authors: Author[]; lang: Paper['lang']; onSave: (a: Author[]) => void }) {
  const [list, setList] = useState<Author[]>(authors)
  useEffect(() => setList(authors), [authors])
  const commit = (next: Author[]): void => {
    if (JSON.stringify(next) !== JSON.stringify(authors)) onSave(next)
  }
  return (
    <div className="field is-wide">
      <span>作者（{lang === 'zh' ? '姓／名，例如 王／小明' : 'Family／Given，例如 Smith／John A.'}）</span>
      <ul className="authors">
        {list.map((a, i) => (
          <li key={i}>
            <input
              value={a.family}
              placeholder={lang === 'zh' ? '姓' : 'Family'}
              onChange={(e) => setList(list.map((x, j) => (j === i ? { ...x, family: e.target.value } : x)))}
              onBlur={() => commit(list)}
            />
            <input
              value={a.given}
              placeholder={lang === 'zh' ? '名' : 'Given'}
              onChange={(e) => setList(list.map((x, j) => (j === i ? { ...x, given: e.target.value } : x)))}
              onBlur={() => commit(list)}
            />
            <button className="icon-btn" aria-label="移除作者" onClick={() => commit(list.filter((_, j) => j !== i))}>
              ✕
            </button>
          </li>
        ))}
      </ul>
      <button className="link-btn" onClick={() => setList([...list, { family: '', given: '' }])}>
        ＋ 新增作者
      </button>
    </div>
  )
}
