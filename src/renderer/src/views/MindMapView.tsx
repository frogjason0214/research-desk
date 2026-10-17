import {
  Background,
  Controls,
  getNodesBounds,
  getViewportForBounds,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  useReactFlow,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { toPng } from 'html-to-image'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Focus, MindMap, MindNode, NodeLinks, Paper, Task } from '../../../shared/types'
import { EditableTitle } from '../components/EditableTitle'
import { relativeDay } from '../dates'
import { desk } from '../useDesk'

type Run = (fn: () => Promise<unknown>) => Promise<void>

interface NodeData extends Record<string, unknown> {
  text: string
  isRoot: boolean
  childCount: number
  hiddenCount: number
  collapsed: boolean
  editing: boolean
  papers: number
  tasks: number
  onToggle: (id: string) => void
  onEdit: (id: string) => void
  onRename: (id: string, text: string | null) => void
}

type FlowNode = Node<NodeData, 'mind'>

// ---------- 節點外觀 ----------

function MindNodeView({ id, data, selected }: NodeProps<FlowNode>) {
  const input = useRef<HTMLInputElement>(null)
  // 新節點在量好尺寸前是隱藏的，autoFocus 會失敗；重試到真的拿到焦點為止
  useEffect(() => {
    if (!data.editing) return
    let tries = 0
    let timer: number | undefined
    const tick = (): void => {
      const el = input.current
      if (!el) return
      el.focus()
      if (document.activeElement === el) el.select()
      else if (tries++ < 30) timer = window.setTimeout(tick, 30)
    }
    tick()
    return () => window.clearTimeout(timer)
  }, [data.editing])

  return (
    <div
      className={`mm-node${data.isRoot ? ' is-root' : ''}${selected ? ' is-selected' : ''}`}
      onDoubleClick={() => data.onEdit(id)}
    >
      <Handle type="target" position={Position.Left} className="mm-handle" isConnectable={false} />
      {data.editing ? (
        <input
          ref={input}
          className="mm-input nodrag"
          defaultValue={data.text}
          onBlur={(e) => data.onRename(id, e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') e.currentTarget.blur()
            if (e.key === 'Escape') data.onRename(id, null)
          }}
          aria-label="節點文字"
        />
      ) : (
        <span className="mm-text">{data.text}</span>
      )}
      {(data.papers > 0 || data.tasks > 0) && (
        <span className="mm-counts" title="連結的文獻／待辦">
          {data.papers > 0 && <span>文獻 {data.papers}</span>}
          {data.tasks > 0 && <span>待辦 {data.tasks}</span>}
        </span>
      )}
      {data.childCount > 0 && (
        <button
          className="mm-toggle nodrag"
          onClick={(e) => {
            e.stopPropagation()
            data.onToggle(id)
          }}
          title={data.collapsed ? '展開子分支' : '收合子分支'}
          aria-label={data.collapsed ? '展開子分支' : '收合子分支'}
        >
          {data.collapsed ? `+${data.hiddenCount}` : '−'}
        </button>
      )}
      <Handle type="source" position={Position.Right} className="mm-handle" isConnectable={false} />
    </div>
  )
}

const nodeTypes = { mind: MindNodeView }

/** 每個節點的子孫（收合時要藏起來的部分） */
function descendants(nodes: MindNode[], id: string): string[] {
  const out: string[] = []
  const stack = [id]
  while (stack.length) {
    const cur = stack.pop()!
    for (const n of nodes) if (n.parent_id === cur) (out.push(n.id), stack.push(n.id))
  }
  return out
}

// ---------- 頁面 ----------

export function MindMapView({
  projectId,
  tasks,
  run,
  focus,
  onNavigate
}: {
  projectId: string
  tasks: Task[]
  run: Run
  focus: Extract<Focus, { page: 'mindmap' }> | null
  onNavigate: (f: Focus) => void
}) {
  const [maps, setMaps] = useState<MindMap[]>([])
  const [mapId, setMapId] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)

  const load = useCallback(
    () =>
      desk.mindmaps.list(projectId).then((list) => {
        setMaps(list)
        setMapId((cur) => (cur && list.some((m) => m.id === cur) ? cur : (list[0]?.id ?? null)))
      }),
    [projectId]
  )
  useEffect(() => {
    load()
    return desk.onChanged(load)
  }, [load])
  useEffect(() => {
    if (focus) setMapId(focus.mapId)
  }, [focus])

  const current = maps.find((m) => m.id === mapId)

  return (
    <div className="mm-page">
      <div className="mm-maps">
        {maps.length > 0 && (
          <select
            value={mapId ?? ''}
            onChange={(e) => {
              setMapId(e.target.value)
              setConfirmDelete(false)
            }}
            aria-label="選擇心智圖"
          >
            {maps.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        )}
        {current && (
          <>
            <EditableTitle value={current.name} label="心智圖名稱" onSave={(name) => run(() => desk.mindmaps.rename(current.id, name))} />
            <button
              className="btn btn-danger"
              onClick={() => (confirmDelete ? run(() => desk.mindmaps.remove(current.id)) : setConfirmDelete(true))}
            >
              {confirmDelete ? '確定刪除整張圖？' : '刪除這張圖'}
            </button>
          </>
        )}
        <span className="spacer" />
        <form
          className="lit-url"
          onSubmit={(e) => {
            e.preventDefault()
            if (!newName.trim()) return
            run(async () => {
              const m = await desk.mindmaps.create(projectId, newName)
              setNewName('')
              setMapId(m.id)
            })
          }}
        >
          <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="新心智圖名稱" aria-label="新心智圖名稱" />
          <button className="btn" type="submit" disabled={!newName.trim()}>
            ＋ 新增
          </button>
        </form>
      </div>

      {current ? (
        <ReactFlowProvider key={current.id}>
          <MapCanvas
            map={current}
            projectId={projectId}
            tasks={tasks}
            run={run}
            focusNodeId={focus?.mapId === current.id ? focus.nodeId : null}
            onNavigate={onNavigate}
          />
        </ReactFlowProvider>
      ) : (
        <div className="empty-card">
          <h3>心智圖</h3>
          <p className="muted">在左邊輸入名稱建立第一張心智圖，例如「研究架構」或「文獻脈絡」。節點可以連結文獻與待辦。</p>
        </div>
      )}
    </div>
  )
}

// ---------- 畫布 ----------

function MapCanvas({
  map,
  projectId,
  tasks,
  run,
  focusNodeId,
  onNavigate
}: {
  map: MindMap
  projectId: string
  tasks: Task[]
  run: Run
  focusNodeId: string | null
  onNavigate: (f: Focus) => void
}) {
  const flow = useReactFlow<FlowNode>()
  const [nodes, setNodes] = useState<MindNode[]>([])
  const [counts, setCounts] = useState<Record<string, { papers: number; tasks: number }>>({})
  const [rfNodes, setRfNodes] = useState<FlowNode[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  const dragStart = useRef<Map<string, { x: number; y: number }> | null>(null)
  const wrapper = useRef<HTMLDivElement>(null)
  const fitted = useRef(false)

  const load = useCallback(async () => {
    const [list, c] = await Promise.all([desk.nodes.list(map.id), desk.links.forMap(map.id)])
    setNodes(list)
    setCounts(c)
  }, [map.id])
  useEffect(() => {
    load()
    return desk.onChanged(load)
  }, [load])

  const root = nodes.find((n) => !n.parent_id)

  const toggle = useCallback(
    (id: string) => {
      const n = nodes.find((x) => x.id === id)
      if (n) run(() => desk.nodes.update(id, { collapsed: n.collapsed ? 0 : 1 }))
    },
    [nodes, run]
  )
  const rename = useCallback(
    (id: string, text: string | null) => {
      setEditing(null)
      const n = nodes.find((x) => x.id === id)
      if (text !== null && n && text.trim() && text.trim() !== n.text) run(() => desk.nodes.update(id, { text }))
      wrapper.current?.focus()
    },
    [nodes, run]
  )

  // 收合的節點底下的子孫都不顯示
  const hidden = useMemo(() => {
    const set = new Set<string>()
    for (const n of nodes) if (n.collapsed) descendants(nodes, n.id).forEach((d) => set.add(d))
    return set
  }, [nodes])

  // 資料變動時合併進 React Flow 的節點（保留它量好的尺寸）
  useEffect(() => {
    setRfNodes((prev) => {
      const old = new Map(prev.map((n) => [n.id, n]))
      return nodes
        .filter((n) => !hidden.has(n.id))
        .map((n) => {
          const kids = nodes.filter((k) => k.parent_id === n.id).length
          const prevNode = old.get(n.id)
          const dragging = dragStart.current?.has(n.id)
          return {
            ...prevNode,
            id: n.id,
            type: 'mind' as const,
            position: dragging && prevNode ? prevNode.position : { x: n.x, y: n.y },
            selected: n.id === selected,
            data: {
              text: n.text,
              isRoot: !n.parent_id,
              childCount: kids,
              hiddenCount: n.collapsed ? descendants(nodes, n.id).length : 0,
              collapsed: !!n.collapsed,
              editing: n.id === editing,
              papers: counts[n.id]?.papers ?? 0,
              tasks: counts[n.id]?.tasks ?? 0,
              onToggle: toggle,
              onEdit: setEditing,
              onRename: rename
            }
          }
        })
    })
  }, [nodes, hidden, selected, editing, counts, toggle, rename])

  const edges: Edge[] = useMemo(
    () =>
      nodes
        .filter((n) => n.parent_id && !hidden.has(n.id))
        .map((n) => ({ id: `e-${n.id}`, source: n.parent_id!, target: n.id, className: 'mm-edge' })),
    [nodes, hidden]
  )

  // 第一次載入時縮放到看得到全部
  useEffect(() => {
    if (!fitted.current && rfNodes.length && rfNodes.every((n) => n.measured)) {
      fitted.current = true
      if (!focusNodeId) flow.fitView({ padding: 0.3, maxZoom: 1.2 })
    }
  }, [rfNodes, flow, focusNodeId])

  // 從文獻或待辦跳過來：展開上層、選取並置中
  useEffect(() => {
    const target = focusNodeId && nodes.find((n) => n.id === focusNodeId)
    if (!target) return
    const closed: string[] = []
    let p = nodes.find((n) => n.id === target.parent_id)
    while (p) {
      if (p.collapsed) closed.push(p.id)
      p = nodes.find((n) => n.id === p!.parent_id)
    }
    closed.forEach((id) => run(() => desk.nodes.update(id, { collapsed: 0 })))
    setSelected(target.id)
    // 右側有節點側欄，畫面中心往右偏半個側欄寬，節點才會落在可見區域中間
    flow.setCenter(target.x + 80 + 160 / 1.1, target.y + 20, { zoom: 1.1, duration: 400 })
    // 只在跳轉目標改變時執行
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusNodeId, nodes.length > 0])

  const onNodesChange = useCallback((changes: NodeChange<FlowNode>[]) => {
    // 刪除與選取由這個元件自己處理
    setRfNodes((nds) => applyNodeChanges(changes.filter((c) => c.type !== 'remove' && c.type !== 'select'), nds))
  }, [])

  /** 新節點在畫面外時，把畫面移過去（不改變縮放） */
  const ensureVisible = (n: { x: number; y: number }): void => {
    const box = wrapper.current?.getBoundingClientRect()
    if (!box) return
    const p = flow.flowToScreenPosition({ x: n.x, y: n.y })
    const panelWidth = 320
    if (p.x < box.left + 20 || p.x > box.right - panelWidth - 160 || p.y < box.top + 20 || p.y > box.bottom - 60) {
      flow.setCenter(n.x + 120, n.y + 20, { zoom: flow.getZoom(), duration: 250 })
    }
  }

  const addChild = async (parentId: string): Promise<void> => {
    await run(async () => {
      const id = await desk.nodes.add(map.id, parentId, '新節點')
      const list = await desk.nodes.list(map.id)
      setNodes(list)
      setSelected(id)
      setEditing(id)
      const n = list.find((x) => x.id === id)
      if (n) ensureVisible(n)
    })
  }

  const remove = (id: string): void => {
    const n = nodes.find((x) => x.id === id)
    if (!n || !n.parent_id) return
    const kids = descendants(nodes, id).length
    if (kids > 0 && pendingDelete !== id) {
      setPendingDelete(id)
      return
    }
    setPendingDelete(null)
    run(async () => {
      await desk.nodes.remove(id)
      setSelected(n.parent_id)
    })
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    // 只處理畫布本身的按鍵；側欄裡的輸入框、按鈕不受影響
    const target = e.target as HTMLElement
    if (editing || !selected || target.tagName === 'INPUT') return
    if (target !== wrapper.current && !target.closest('.react-flow')) return
    const n = nodes.find((x) => x.id === selected)
    if (!n) return
    if (e.key === 'Tab') {
      e.preventDefault()
      addChild(n.id)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      addChild(n.parent_id ?? n.id)
    } else if (e.key === 'F2') {
      e.preventDefault()
      setEditing(n.id)
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      remove(n.id)
    } else if (e.key === ' ') {
      e.preventDefault()
      if (nodes.some((k) => k.parent_id === n.id)) toggle(n.id)
    } else if (e.key === 'Escape') {
      setPendingDelete(null)
    }
  }

  const exportImage = (): void => {
    run(async () => {
      const all = flow.getNodes()
      if (!all.length) return
      const bounds = getNodesBounds(all)
      const width = Math.round(Math.max(800, bounds.width + 160))
      const height = Math.round(Math.max(500, bounds.height + 160))
      const vp = getViewportForBounds(bounds, width, height, 0.2, 2, 0.08)
      const el = wrapper.current?.querySelector('.react-flow__viewport') as HTMLElement
      const bg = getComputedStyle(document.documentElement).getPropertyValue('--panel').trim() || '#ffffff'
      const dataUrl = await toPng(el, {
        backgroundColor: bg,
        width,
        height,
        pixelRatio: 2,
        style: { width: `${width}px`, height: `${height}px`, transform: `translate(${vp.x}px, ${vp.y}px) scale(${vp.zoom})` }
      }).catch(() => {
        throw new Error('匯出圖片失敗，請稍後再試。')
      })
      await desk.mindmaps.saveImage(map.name, dataUrl)
    })
  }

  const sel = nodes.find((n) => n.id === selected)
  const pendingCount = pendingDelete ? descendants(nodes, pendingDelete).length : 0

  return (
    <div className="mm-main">
      <div className="mm-toolbar">
        <button className="btn" disabled={!sel} onClick={() => sel && addChild(sel.id)} title="Tab">
          ＋ 子節點
        </button>
        <button className="btn" disabled={!sel || !sel.parent_id} onClick={() => sel && addChild(sel.parent_id!)} title="Enter">
          ＋ 同層節點
        </button>
        <button className="btn" disabled={!sel || !sel.parent_id} onClick={() => sel && remove(sel.id)} title="Delete">
          刪除
        </button>
        <span className="spacer" />
        <button className="btn" onClick={() => flow.fitView({ padding: 0.3, maxZoom: 1.2, duration: 300 })}>
          看全部
        </button>
        <button className="btn" onClick={exportImage}>
          匯出圖片
        </button>
      </div>
      {pendingDelete && (
        <p className="banner banner-warn">
          這個節點底下還有 {pendingCount} 個節點，再按一次「刪除」或 Delete 會一起刪除；按 Esc 取消。
        </p>
      )}
      <div className="mm-body">
        <div className="mm-canvas" ref={wrapper} tabIndex={0} onKeyDown={onKeyDown}>
          <ReactFlow
            nodes={rfNodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onNodeClick={(_, node) => {
              setSelected(node.id)
              setPendingDelete(null)
              wrapper.current?.focus()
            }}
            onPaneClick={() => {
              setSelected(null)
              setPendingDelete(null)
            }}
            onNodeDragStart={(_, node) => {
              // 拖父節點時子孫一起移動：記下起點
              const ids = [node.id, ...descendants(nodes, node.id)]
              dragStart.current = new Map(
                rfNodes.filter((n) => ids.includes(n.id)).map((n) => [n.id, { ...n.position }])
              )
              setSelected(node.id)
            }}
            onNodeDrag={(_, node) => {
              const start = dragStart.current
              const origin = start?.get(node.id)
              if (!start || !origin) return
              const dx = node.position.x - origin.x
              const dy = node.position.y - origin.y
              setRfNodes((nds) =>
                nds.map((n) => (n.id !== node.id && start.has(n.id) ? { ...n, position: { x: start.get(n.id)!.x + dx, y: start.get(n.id)!.y + dy } } : n))
              )
            }}
            onNodeDragStop={(_, node) => {
              const start = dragStart.current
              const origin = start?.get(node.id)
              dragStart.current = null
              if (!start || !origin) return
              const dx = node.position.x - origin.x
              const dy = node.position.y - origin.y
              if (dx === 0 && dy === 0) return
              // 收合的子孫雖然沒顯示，也跟著移動
              const ids = [node.id, ...descendants(nodes, node.id)]
              const moves = nodes.filter((n) => ids.includes(n.id)).map((n) => ({ id: n.id, x: n.x + dx, y: n.y + dy }))
              run(() => desk.nodes.move(moves))
            }}
            deleteKeyCode={null}
            selectionKeyCode={null}
            multiSelectionKeyCode={null}
            nodesConnectable={false}
            minZoom={0.2}
            maxZoom={2}
            proOptions={{ hideAttribution: true }}
            colorMode="system"
          >
            <Background gap={24} size={1} />
            <Controls showInteractive={false} />
          </ReactFlow>
          <p className="mm-help muted">Tab 子節點・Enter 同層・F2／雙擊 改名・Delete 刪除・空白鍵 收合</p>
          {/* 節點側欄浮在畫布右側，不壓縮畫布寬度 */}
          {sel && (
            <NodePanel
              key={sel.id}
              node={sel}
              isRoot={sel.id === root?.id}
              projectId={projectId}
              tasks={tasks}
              run={run}
              onNavigate={onNavigate}
              onClose={() => setSelected(null)}
            />
          )}
        </div>
      </div>
    </div>
  )
}

// ---------- 節點側欄：連結文獻與待辦 ----------

function NodePanel({
  node,
  projectId,
  tasks,
  run,
  onNavigate,
  onClose
}: {
  node: MindNode
  isRoot: boolean
  projectId: string
  tasks: Task[]
  run: Run
  onNavigate: (f: Focus) => void
  onClose: () => void
}) {
  const [links, setLinks] = useState<NodeLinks>({ papers: [], tasks: [] })
  const [papers, setPapers] = useState<Paper[]>([])
  const [paperPick, setPaperPick] = useState('')
  const [taskPick, setTaskPick] = useState('')
  const [newTask, setNewTask] = useState('')
  const [newDue, setNewDue] = useState('')

  const load = useCallback(async () => {
    const [l, p] = await Promise.all([desk.links.forNode(node.id), desk.papers.list(projectId)])
    setLinks(l)
    setPapers(p)
  }, [node.id, projectId])
  useEffect(() => {
    load()
    return desk.onChanged(load)
  }, [load])

  const linkedPaperIds = new Set(links.papers.map((p) => p.id))
  const linkedTaskIds = new Set(links.tasks.map((t) => t.id))

  return (
    <aside className="mm-panel">
      <button className="icon-btn mm-panel-close" onClick={onClose} aria-label="關閉節點側欄">
        ✕
      </button>
      <EditableTitle value={node.text} label="節點文字" className="mm-panel-title" onSave={(text) => run(() => desk.nodes.update(node.id, { text }))} />

      <section>
        <h4>連結的文獻</h4>
        {links.papers.length === 0 && <p className="muted">還沒有連結文獻。</p>}
        <ul className="mm-links">
          {links.papers.map((p) => (
            <li key={p.id}>
              <button className="link-btn" onClick={() => onNavigate({ page: 'literature', paperId: p.id })}>
                {p.title || '（沒有標題）'}
                {p.year && `（${p.year}）`}
              </button>
              <button className="icon-btn" aria-label="取消連結" onClick={() => run(() => desk.links.remove('node', node.id, 'paper', p.id))}>
                ✕
              </button>
            </li>
          ))}
        </ul>
        <div className="inline-add">
          <select value={paperPick} onChange={(e) => setPaperPick(e.target.value)} aria-label="選擇文獻">
            <option value="">選擇要連結的文獻…</option>
            {papers
              .filter((p) => !linkedPaperIds.has(p.id))
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title || '（沒有標題）'}
                </option>
              ))}
          </select>
          <button
            className="btn"
            disabled={!paperPick}
            onClick={() => run(async () => { await desk.links.add('node', node.id, 'paper', paperPick); setPaperPick('') })}
          >
            連結
          </button>
        </div>
      </section>

      <section>
        <h4>待辦</h4>
        {links.tasks.length === 0 && <p className="muted">還沒有待辦。</p>}
        <ul className="mm-links">
          {links.tasks.map((t) => (
            <li key={t.id} className={t.done ? 'is-done' : ''}>
              <label className="check">
                <input type="checkbox" checked={!!t.done} onChange={() => run(() => desk.tasks.update(t.id, { done: t.done ? 0 : 1 }))} />
                <span>{t.title}</span>
              </label>
              {t.due_date && <span className="task-due">{relativeDay(t.due_date)}</span>}
              <button className="icon-btn" aria-label="取消連結" onClick={() => run(() => desk.links.remove('node', node.id, 'task', t.id))}>
                ✕
              </button>
            </li>
          ))}
        </ul>
        <form
          className="mm-newtask"
          onSubmit={(e) => {
            e.preventDefault()
            if (!newTask.trim()) return
            run(async () => {
              await desk.nodes.createTask(node.id, newTask, newDue || null)
              setNewTask('')
              setNewDue('')
            })
          }}
        >
          <input value={newTask} onChange={(e) => setNewTask(e.target.value)} placeholder="從這個節點新增待辦" aria-label="新待辦" />
          <input type="date" className="date-input" value={newDue} onChange={(e) => setNewDue(e.target.value)} aria-label="截止日" />
          <button className="btn" type="submit" disabled={!newTask.trim()}>
            新增
          </button>
        </form>
        <div className="inline-add">
          <select value={taskPick} onChange={(e) => setTaskPick(e.target.value)} aria-label="選擇既有待辦">
            <option value="">連結既有待辦…</option>
            {tasks
              .filter((t) => !linkedTaskIds.has(t.id) && !t.done)
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                </option>
              ))}
          </select>
          <button
            className="btn"
            disabled={!taskPick}
            onClick={() => run(async () => { await desk.links.add('node', node.id, 'task', taskPick); setTaskPick('') })}
          >
            連結
          </button>
        </div>
      </section>
    </aside>
  )
}
