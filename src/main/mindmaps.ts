import { randomUUID } from 'node:crypto'
import type {
  LinkType,
  MindMap,
  MindNode,
  NodeLinks,
  NodePatch,
  NodeRef,
  PaperRef,
  Task,
  TaskLinks
} from '../shared/types'
import type { Store, Tx } from './store'

// 心智圖：每個專案可以有多張，節點自由擺放（使用者手動繪製，AI 不自動產生）。
// 節點可以連結文獻與待辦；待辦也可以連結文獻。連結存在 links 表，兩端排序固定：node < task < paper。

const RANK: Record<LinkType, number> = { node: 0, task: 1, paper: 2 }
const CHILD_DX = 240
const CHILD_DY = 64

const now = (): string => new Date().toISOString()

/** 連結的兩端依固定順序排好，ID 由兩端組成 */
function normalize(t1: LinkType, id1: string, t2: LinkType, id2: string) {
  const [a, b] = RANK[t1] <= RANK[t2] ? [[t1, id1], [t2, id2]] : [[t2, id2], [t1, id1]]
  return { id: `${a[0]}:${a[1]}>${b[0]}:${b[1]}`, a_type: a[0], a_id: a[1], b_type: b[0], b_id: b[1] }
}

function cleanText(text: string): string {
  const t = text.trim()
  if (!t) throw new Error('名稱不能是空白')
  return t
}

export function createMindmapHandlers(store: Store) {
  const nodesOf = (mapId: string): MindNode[] =>
    store.all<MindNode>('SELECT * FROM mm_nodes WHERE map_id = ? ORDER BY created_at', [mapId])

  /** 某個節點與它所有後代 */
  const subtree = (mapId: string, rootId: string): string[] => {
    const nodes = nodesOf(mapId)
    const ids = [rootId]
    for (let i = 0; i < ids.length; i++) nodes.filter((n) => n.parent_id === ids[i]).forEach((n) => ids.push(n.id))
    return ids
  }

  const removeLinksOf = (tx: Tx, ids: string[]): void => {
    if (ids.length === 0) return
    const marks = ids.map(() => '?').join(',')
    store
      .all<{ id: string }>(`SELECT id FROM links WHERE a_id IN (${marks}) OR b_id IN (${marks})`, [...ids, ...ids])
      .forEach((l) => tx.remove('links', l.id))
  }

  const nodeRefs = (where: string, params: string[]): NodeRef[] =>
    store.all<NodeRef>(
      `SELECT m.id AS mapId, m.name AS mapName, n.id AS nodeId, n.text AS text
       FROM links l JOIN mm_nodes n ON n.id = l.a_id JOIN mindmaps m ON m.id = n.map_id
       WHERE l.a_type = 'node' AND ${where} ORDER BY m.name, n.text`,
      params
    )

  return {
    'mindmaps.list': (projectId: string): MindMap[] =>
      store.all<MindMap>('SELECT * FROM mindmaps WHERE project_id = ? ORDER BY created_at', [projectId]),

    /** 新的心智圖：中心節點的文字就是圖名 */
    'mindmaps.create': (projectId: string, name: string): MindMap => {
      const map: MindMap = { id: randomUUID(), project_id: projectId, name: cleanText(name), created_at: now() }
      store.write((tx) => {
        tx.set('mindmaps', map.id, { project_id: projectId, name: map.name, created_at: map.created_at })
        tx.set('mm_nodes', randomUUID(), {
          map_id: map.id,
          parent_id: null,
          text: map.name,
          x: 0,
          y: 0,
          collapsed: 0,
          color: '',
          created_at: map.created_at
        })
      })
      return map
    },

    'mindmaps.rename': (id: string, name: string): void =>
      store.write((tx) => tx.set('mindmaps', id, { name: cleanText(name) })),

    'mindmaps.remove': (id: string): void => {
      const ids = nodesOf(id).map((n) => n.id)
      store.write((tx) => {
        removeLinksOf(tx, ids)
        ids.forEach((n) => tx.remove('mm_nodes', n))
        tx.remove('mindmaps', id)
      })
    },

    'nodes.list': nodesOf,

    /** 新增子節點；沒給位置時放在父節點右邊、現有子節點的下方 */
    'nodes.add': (mapId: string, parentId: string, text: string, pos?: { x: number; y: number }): string => {
      const parent = store.get<MindNode>('SELECT * FROM mm_nodes WHERE id = ?', [parentId])
      if (!parent) throw new Error('找不到上層節點')
      const siblings = nodesOf(mapId).filter((n) => n.parent_id === parentId)
      const id = randomUUID()
      const x = pos?.x ?? parent.x + CHILD_DX
      const y = pos?.y ?? (siblings.length ? Math.max(...siblings.map((s) => s.y)) + CHILD_DY : parent.y)
      store.write((tx) =>
        tx.set('mm_nodes', id, {
          map_id: mapId,
          parent_id: parentId,
          text: cleanText(text),
          x,
          y,
          collapsed: 0,
          color: '',
          created_at: now()
        })
      )
      // 收合中的父節點加了子節點就展開，才看得到新節點
      if (parent.collapsed) store.write((tx) => tx.set('mm_nodes', parentId, { collapsed: 0 }))
      return id
    },

    'nodes.update': (id: string, patch: NodePatch): void => {
      const fields: Record<string, unknown> = { ...patch }
      if (patch.text !== undefined) fields.text = cleanText(patch.text)
      store.write((tx) => tx.set('mm_nodes', id, fields))
    },

    /** 拖曳結束：一次寫入多個節點的新位置（拖父節點時子孫一起移動） */
    'nodes.move': (moves: { id: string; x: number; y: number }[]): void =>
      store.write((tx) => moves.forEach((m) => tx.set('mm_nodes', m.id, { x: Math.round(m.x), y: Math.round(m.y) }))),

    /** 刪除節點與它的所有子孫（中心節點不能刪，請刪整張圖） */
    'nodes.remove': (id: string): void => {
      const node = store.get<MindNode>('SELECT * FROM mm_nodes WHERE id = ?', [id])
      if (!node) return
      if (!node.parent_id) throw new Error('中心節點不能刪除；要刪除請刪掉整張心智圖。')
      const ids = subtree(node.map_id, id)
      store.write((tx) => {
        removeLinksOf(tx, ids)
        ids.forEach((n) => tx.remove('mm_nodes', n))
      })
    },

    'links.add': (t1: LinkType, id1: string, t2: LinkType, id2: string): void => {
      const { id, ...fields } = normalize(t1, id1, t2, id2)
      store.write((tx) => tx.set('links', id, fields))
    },

    'links.remove': (t1: LinkType, id1: string, t2: LinkType, id2: string): void =>
      store.write((tx) => tx.remove('links', normalize(t1, id1, t2, id2).id)),

    'links.forNode': (nodeId: string): NodeLinks => ({
      papers: store.all<PaperRef>(
        `SELECT p.id, p.title, p.year FROM links l JOIN papers p ON p.id = l.b_id
         WHERE l.a_type = 'node' AND l.a_id = ? AND l.b_type = 'paper' ORDER BY p.title`,
        [nodeId]
      ),
      tasks: store.all<Task>(
        `SELECT t.id, t.project_id, t.title, t.due_date, t.done, t.done_at, t.created_at
         FROM links l JOIN tasks t ON t.id = l.b_id
         WHERE l.a_type = 'node' AND l.a_id = ? AND l.b_type = 'task' ORDER BY t.done, t.due_date IS NULL, t.due_date`,
        [nodeId]
      )
    }),

    /** 一張圖裡每個節點連了幾篇文獻、幾個待辦（節點上顯示數字用） */
    'links.forMap': (mapId: string): Record<string, { papers: number; tasks: number }> => {
      const result: Record<string, { papers: number; tasks: number }> = {}
      store
        .all<{ nodeId: string; type: string; n: number }>(
          `SELECT l.a_id AS nodeId, l.b_type AS type, COUNT(*) AS n
           FROM links l JOIN mm_nodes nd ON nd.id = l.a_id
           LEFT JOIN papers p ON l.b_type = 'paper' AND p.id = l.b_id
           LEFT JOIN tasks t ON l.b_type = 'task' AND t.id = l.b_id
           WHERE l.a_type = 'node' AND nd.map_id = ? AND (p.id IS NOT NULL OR t.id IS NOT NULL)
           GROUP BY l.a_id, l.b_type`,
          [mapId]
        )
        .forEach(({ nodeId, type, n }) => {
          const r = (result[nodeId] ??= { papers: 0, tasks: 0 })
          if (type === 'paper') r.papers = n
          else r.tasks = n
        })
      return result
    },

    /** 文獻「出現在哪些節點」 */
    'links.forPaper': (paperId: string): NodeRef[] => nodeRefs(`l.b_type = 'paper' AND l.b_id = ?`, [paperId]),

    /** 專案內每個待辦連到的節點與文獻 */
    'links.forTasks': (projectId: string): Record<string, TaskLinks> => {
      const result: Record<string, TaskLinks> = {}
      const get = (id: string): TaskLinks => (result[id] ??= { nodes: [], papers: [] })
      store
        .all<NodeRef & { taskId: string }>(
          `SELECT t.id AS taskId, m.id AS mapId, m.name AS mapName, n.id AS nodeId, n.text AS text
           FROM links l JOIN tasks t ON t.id = l.b_id JOIN mm_nodes n ON n.id = l.a_id JOIN mindmaps m ON m.id = n.map_id
           WHERE l.a_type = 'node' AND l.b_type = 'task' AND t.project_id = ?`,
          [projectId]
        )
        .forEach(({ taskId, ...ref }) => get(taskId).nodes.push(ref))
      store
        .all<PaperRef & { taskId: string }>(
          `SELECT t.id AS taskId, p.id, p.title, p.year
           FROM links l JOIN tasks t ON t.id = l.a_id JOIN papers p ON p.id = l.b_id
           WHERE l.a_type = 'task' AND l.b_type = 'paper' AND t.project_id = ?`,
          [projectId]
        )
        .forEach(({ taskId, ...ref }) => get(taskId).papers.push(ref))
      return result
    },

    /** 從節點直接產生待辦，並互相連結 */
    'nodes.createTask': (nodeId: string, title: string, dueDate: string | null): void => {
      const node = store.get<MindNode>('SELECT * FROM mm_nodes WHERE id = ?', [nodeId])
      const map = node && store.get<MindMap>('SELECT * FROM mindmaps WHERE id = ?', [node.map_id])
      if (!map) throw new Error('找不到節點')
      const taskId = randomUUID()
      const link = normalize('node', nodeId, 'task', taskId)
      store.write((tx) => {
        tx.set('tasks', taskId, {
          project_id: map.project_id,
          title: cleanText(title),
          due_date: dueDate || null,
          done: 0,
          done_at: null,
          created_at: now()
        })
        tx.set('links', link.id, { a_type: link.a_type, a_id: link.a_id, b_type: link.b_type, b_id: link.b_id })
      })
    }
  }
}
