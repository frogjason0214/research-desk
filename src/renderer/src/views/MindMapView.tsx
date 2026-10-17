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
  useUpdateNodeInternals,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { toPng } from 'html-to-image'
import { FileUp, GitFork, ImageDown, Link2, ListPlus, Maximize, Network, Plus, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Focus, MindMap, MindNode, NodeLinks, Paper, Task } from '../../../shared/types'
import { EditableTitle } from '../components/EditableTitle'
import { IconButton } from '../components/IconButton'
import { relativeDay } from '../dates'
import { importPdfFile, isPdf, JobList, useImportJobs } from '../importing'
import { tidyLayout, type LayoutMode } from '../mindLayout'
import { desk } from '../useDesk'

type Run = (fn: () => Promise<unknown>) => Promise<void>

interface NodeData extends Record<string, unknown> {
  text: string
  isRoot: boolean
  /** 在中心節點左邊的分支：連接點左右對調 */
  side: 'left' | 'right'
  childCount: number
  hiddenCount: number
  collapsed: boolean
  editing: boolean
  /** 拖 PDF 經過這個節點 */
  dropping: boolean
  papers: number
  tasks: number
  onToggle: (id: string) => void
  onEdit: (id: string) => void
  onRename: (id: string, text: string | null) => void
}

type FlowNode = Node<NodeData, 'mind'>

// ---------- 節點外觀 ----------

/** 這個按鍵會輸入文字（含注音、拼音組字）嗎？ */
function isTyping(e: React.KeyboardEvent): boolean {
  if (e.nativeEvent.isComposing || e.keyCode === 229 || e.key === 'Process') return true
  return e.key.length === 1 && e.key !== ' ' && !e.ctrlKey && !e.metaKey && !e.altKey
}

function MindNodeView({ id, data, selected }: NodeProps<FlowNode>) {
  const input = useRef<HTMLTextAreaElement>(null)
  // 節點換到中心節點另一邊時，連接點位置改了，要請 React Flow 重新量
  const updateInternals = useUpdateNodeInternals()
  useEffect(() => updateInternals(id), [id, data.side, data.isRoot, updateInternals])
  // 選取的節點有一個看起來像文字的輸入框拿著焦點：直接打字（含中文組字）就開始改名，
  // 組字直接顯示在節點上。新節點在量好尺寸前是隱藏的，focus 會失敗；重試到拿到焦點為止
  const armed = selected && !data.editing
  // 直接打字開始改名時，已經輸入的字不能再被全選
  const typed = useRef(false)
  useEffect(() => {
    if (!selected && !data.editing) return
    if (typed.current) {
      typed.current = false
      return
    }
    let tries = 0
    const tick = (): void => {
      const el = input.current
      if (!el) return
      if (document.activeElement !== el) {
        // 使用者正在側欄或其他地方輸入時不要搶焦點
        const active = document.activeElement as HTMLElement | null
        if (!data.editing && active && active !== document.body && !active.closest('.mm-canvas')) return
        el.focus()
      }
      if (document.activeElement === el) el.select()
      else if (tries++ < 30) timer = window.setTimeout(tick, 30)
    }
    // 等這次點擊或 blur 把焦點移完再判斷
    let timer = window.setTimeout(tick, 0)
    return () => window.clearTimeout(timer)
  }, [selected, data.editing])
  const startTyping = (): void => {
    if (!input.current?.classList.contains('is-armed')) return
    typed.current = true
    data.onEdit(id)
  }
  // 不在編輯時，其他電腦改了文字要更新
  useEffect(() => {
    const el = input.current
    if (data.editing || !el || el.value === data.text) return
    el.value = data.text
    if (document.activeElement === el) el.select()
  }, [data.text, data.editing])

  return (
    <div
      className={`mm-node${data.isRoot ? ' is-root' : ''}${selected ? ' is-selected' : ''}${data.side === 'left' ? ' is-left' : ''}${data.dropping ? ' is-drop' : ''}`}
      onDoubleClick={() => data.onEdit(id)}
    >
      {data.isRoot ? (
        <>
          <Handle id="out-r" type="source" position={Position.Right} className="mm-handle" isConnectable={false} />
          <Handle id="out-l" type="source" position={Position.Left} className="mm-handle" isConnectable={false} />
        </>
      ) : (
        <>
          <Handle id="in" type="target" position={data.side === 'left' ? Position.Right : Position.Left} className="mm-handle" isConnectable={false} />
          <Handle id="out" type="source" position={data.side === 'left' ? Position.Left : Position.Right} className="mm-handle" isConnectable={false} />
        </>
      )}
      {selected || data.editing ? (
        <textarea
          ref={input}
          className={`mm-input${armed ? ' is-armed' : ' nodrag'}`}
          defaultValue={data.text}
          rows={1}
          spellCheck={false}
          data-armed={armed ? '1' : undefined}
          onBlur={(e) => data.editing && data.onRename(id, e.target.value)}
          onKeyDown={(e) => {
            if (armed) {
              // 打字就開始改名（取代原本的文字）；其他按鍵交給畫布（Tab、Enter、Delete…）
              if (isTyping(e)) {
                e.stopPropagation()
                startTyping()
              } else if (e.key.startsWith('Arrow')) e.preventDefault()
              return
            }
            e.stopPropagation()
            // 注音／拼音組字時的 Enter 是選字，不是結束編輯
            if (e.nativeEvent.isComposing || e.keyCode === 229) return
            if (e.key === 'Enter') {
              e.preventDefault()
              e.currentTarget.blur()
            }
            if (e.key === 'Escape') {
              e.currentTarget.value = data.text
              data.onRename(id, null)
            }
          }}
          onCompositionStart={() => armed && startTyping()}
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
            <IconButton
              icon={Trash2}
              label={confirmDelete ? '再按一次刪除整張心智圖' : '刪除這張心智圖'}
              danger
              active={confirmDelete}
              onClick={() => (confirmDelete ? run(() => desk.mindmaps.remove(current.id)) : setConfirmDelete(true))}
            />
            {confirmDelete && <span className="muted">再按一次垃圾桶就會刪除整張圖</span>}
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
  const [panelOpen, setPanelOpen] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  const dragStart = useRef<Map<string, { x: number; y: number }> | null>(null)
  const wrapper = useRef<HTMLDivElement>(null)
  const fitted = useRef(false)
  const imports = useImportJobs(6000)
  // 拖 PDF 進畫布：undefined＝沒在拖、null＝在空白處、字串＝在那個節點上
  const [dropNode, setDropNode] = useState<string | null | undefined>(undefined)

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
      if (text !== null && n && text.trim() && text.trim() !== n.text) run(() => desk.nodes.update(id, { text: text.trim() }))
    },
    [nodes, run]
  )

  // 收合的節點底下的子孫都不顯示
  const hidden = useMemo(() => {
    const set = new Set<string>()
    for (const n of nodes) if (n.collapsed) descendants(nodes, n.id).forEach((d) => set.add(d))
    return set
  }, [nodes])

  // 在中心節點左邊的節點：連接點與收合按鈕放另一側
  const rootNode = nodes.find((n) => !n.parent_id)
  const sideOf = useCallback((n: MindNode): 'left' | 'right' => (rootNode && n.parent_id && n.x < rootNode.x ? 'left' : 'right'), [rootNode])

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
              side: sideOf(n),
              childCount: kids,
              hiddenCount: n.collapsed ? descendants(nodes, n.id).length : 0,
              collapsed: !!n.collapsed,
              editing: n.id === editing,
              dropping: n.id === dropNode,
              papers: counts[n.id]?.papers ?? 0,
              tasks: counts[n.id]?.tasks ?? 0,
              onToggle: toggle,
              onEdit: setEditing,
              onRename: rename
            }
          }
        })
    })
  }, [nodes, hidden, selected, editing, counts, toggle, rename, sideOf, dropNode])

  const edges: Edge[] = useMemo(
    () =>
      nodes
        .filter((n) => n.parent_id && !hidden.has(n.id))
        .map((n) => ({
          id: `e-${n.id}`,
          source: n.parent_id!,
          target: n.id,
          // 中心節點往左、往右各有一個連接點；其他節點一進一出
          sourceHandle: n.parent_id === rootNode?.id ? (sideOf(n) === 'left' ? 'out-l' : 'out-r') : 'out',
          targetHandle: 'in',
          className: 'mm-edge'
        })),
    [nodes, hidden, rootNode, sideOf]
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

    flow.setCenter(target.x + 80, target.y + 20, { zoom: 1.1, duration: 400 })
    // 只在跳轉目標改變時執行
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusNodeId, nodes.length > 0])

  const onNodesChange = useCallback((changes: NodeChange<FlowNode>[]) => {
    // 刪除與選取由這個元件自己處理
    setRfNodes((nds) => applyNodeChanges(changes.filter((c) => c.type !== 'remove' && c.type !== 'select'), nds))
  }, [])

  /** 新節點在畫面外時，把畫面移過去（不改變縮放） */
  const ensureVisible = (n: { x: number; y: number }): void => {
    // 畫布的範圍已經不含側欄（側欄打開時畫布變窄）
    const box = wrapper.current?.getBoundingClientRect()
    if (!box) return
    const p = flow.flowToScreenPosition({ x: n.x, y: n.y })
    if (p.x < box.left + 20 || p.x > box.right - 160 || p.y < box.top + 20 || p.y > box.bottom - 60) {
      flow.setCenter(n.x + 80, n.y + 20, { zoom: flow.getZoom(), duration: 250 })
    }
  }

  // 打開側欄後畫布變窄：等版面調整好，把選取的節點移回看得到的地方
  useEffect(() => {
    if (!panelOpen) return
    const n = nodes.find((x) => x.id === selected)
    if (!n) return
    const t = window.setTimeout(() => ensureVisible(n), 60)
    return () => window.clearTimeout(t)
    // 只在打開側欄或換選取節點時執行
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelOpen, selected])

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
    const field = target.tagName === 'INPUT' || (target.tagName === 'TEXTAREA' && !target.dataset.armed)
    if (editing || !selected || field) return
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

  /** 一鍵整理：用 React Flow 量好的節點大小排版，中心節點不動 */
  const tidy = (mode: LayoutMode): void => {
    const sizes = new Map(flow.getNodes().map((n) => [n.id, { w: n.measured?.width ?? 140, h: n.measured?.height ?? 34 }]))
    const pos = tidyLayout(nodes, (id) => sizes.get(id) ?? { w: 140, h: 34 }, mode)
    const moves = [...pos].map(([id, p]) => ({ id, ...p }))
    if (moves.length === 0) return
    run(async () => {
      await desk.nodes.move(moves)
      window.setTimeout(() => flow.fitView({ padding: 0.3, maxZoom: 1.2, duration: 300 }), 100)
    })
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

  /** 從檔案總管拖 PDF 進來：放在節點上就連到那個節點 */
  const nodeAt = (e: React.DragEvent): string | null =>
    (document.elementFromPoint(e.clientX, e.clientY)?.closest('.react-flow__node') as HTMLElement | null)?.dataset.id ?? null
  const dropFiles = async (files: File[], nodeId: string | null): Promise<void> => {
    for (const file of files.filter(isPdf)) {
      const id = await imports.run(file.name, () => importPdfFile(projectId, file, false))
      if (id && nodeId) await run(() => desk.links.add('node', nodeId, 'paper', id))
    }
  }
  const dropText = dropNode ? `放開就匯入並連到「${nodes.find((n) => n.id === dropNode)?.text ?? ''}」` : '放到節點上會自動連結；放在空白處只匯入'

  const sel = nodes.find((n) => n.id === selected)
  const pendingCount = pendingDelete ? descendants(nodes, pendingDelete).length : 0

  return (
    <div className="mm-main">
      <div className="mm-toolbar">
        <IconButton icon={Plus} label="新增子節點（Tab）" disabled={!sel} onClick={() => sel && addChild(sel.id)} />
        <IconButton
          icon={ListPlus}
          label="新增同層節點（Enter）"
          disabled={!sel || !sel.parent_id}
          onClick={() => sel && addChild(sel.parent_id!)}
        />
        <IconButton icon={Trash2} label="刪除節點（Delete）" disabled={!sel || !sel.parent_id} onClick={() => sel && remove(sel.id)} />
        <IconButton
          icon={Link2}
          label={panelOpen ? '關閉連結側欄' : '連結文獻與待辦'}
          disabled={!sel}
          active={panelOpen && !!sel}
          onClick={() => setPanelOpen(!panelOpen)}
        />
        <span className="spacer" />
        <IconButton icon={GitFork} label="整理：向右展開" onClick={() => tidy('right')} />
        <IconButton icon={Network} label="整理：左右平衡" onClick={() => tidy('balanced')} />
        <IconButton icon={Maximize} label="看全部" onClick={() => flow.fitView({ padding: 0.3, maxZoom: 1.2, duration: 300 })} />
        <IconButton icon={ImageDown} label="匯出圖片" onClick={exportImage} />
      </div>
      {pendingDelete && (
        <p className="banner banner-warn">
          這個節點底下還有 {pendingCount} 個節點，再按一次「刪除」或 Delete 會一起刪除；按 Esc 取消。
        </p>
      )}
      <div className="mm-body">
        <div
          className={`mm-canvas${dropNode !== undefined ? ' is-dragging' : ''}`}
          ref={wrapper}
          tabIndex={0}
          onKeyDown={onKeyDown}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes('Files')) return
            e.preventDefault()
            e.dataTransfer.dropEffect = 'copy'
            const id = nodeAt(e)
            if (id !== dropNode) setDropNode(id)
          }}
          onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as globalThis.Node | null) && setDropNode(undefined)}
          onDrop={(e) => {
            if (!e.dataTransfer.types.includes('Files')) return
            e.preventDefault()
            const id = nodeAt(e)
            setDropNode(undefined)
            if (id) setSelected(id)
            dropFiles([...e.dataTransfer.files], id)
          }}
        >
          <ReactFlow
            nodes={rfNodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onNodeClick={(_, node) => {
              setSelected(node.id)
              setPendingDelete(null)
              // 已經選取的節點再點一次：焦點交回節點的文字框，才能直接打字
              if (node.id === selected && !editing) {
                const el = wrapper.current?.querySelector<HTMLTextAreaElement>(`.react-flow__node[data-id="${node.id}"] .mm-input`)
                el?.focus()
                el?.select()
              }
            }}
            onPaneClick={() => {
              setSelected(null)
              setPendingDelete(null)
              wrapper.current?.focus()
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
          {dropNode !== undefined && <p className="mm-drop-hint">{dropText}</p>}
          <JobList jobs={imports.jobs} className="mm-jobs" />
          <p className="mm-help muted">Tab 子節點・Enter 同層・F2／雙擊 改名・Delete 刪除・空白鍵 收合</p>
        </div>
        {/* 連結側欄：按工具列的連結圖示才打開；打開時畫布變窄，不會擋住節點 */}
        {panelOpen && sel && (
          <NodePanel
            key={sel.id}
            node={sel}
            isRoot={sel.id === root?.id}
            projectId={projectId}
            tasks={tasks}
            run={run}
            onNavigate={onNavigate}
            onClose={() => setPanelOpen(false)}
          />
        )}
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
  const [url, setUrl] = useState('')
  const [noAi, setNoAi] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const imports = useImportJobs()
  /** 匯入的文獻直接連到這個節點 */
  const importAndLink = async (label: string, work: () => Promise<string>): Promise<void> => {
    const id = await imports.run(label, work)
    if (id) await run(() => desk.links.add('node', node.id, 'paper', id))
  }

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
        <div className="mm-import">
          <IconButton icon={FileUp} label="匯入 PDF 並連到這個節點" onClick={() => fileInput.current?.click()} />
          <input
            ref={fileInput}
            type="file"
            accept="application/pdf"
            multiple
            hidden
            onChange={(e) => {
              const files = [...(e.target.files ?? [])].filter(isPdf)
              e.target.value = ''
              void (async () => {
                for (const file of files) await importAndLink(file.name, () => importPdfFile(projectId, file, noAi))
              })()
            }}
          />
          <form
            className="lit-url"
            onSubmit={(e) => {
              e.preventDefault()
              const target = url.trim()
              if (!target) return
              setUrl('')
              void importAndLink(target, () => desk.papers.importWeb(projectId, target, noAi))
            }}
          >
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="貼上網址加入網頁" aria-label="網頁網址" />
            <IconButton icon={Link2} label="加入這個網頁並連到節點" type="submit" disabled={!url.trim()} />
          </form>
        </div>
        <label className="check muted">
          <input type="checkbox" checked={noAi} onChange={(e) => setNoAi(e.target.checked)} />
          這次匯入的不送 AI
        </label>
        <JobList jobs={imports.jobs} />
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
