import { hierarchy, tree, type HierarchyPointNode } from 'd3-hierarchy'

// 心智圖一鍵整理：向右展開的樹狀，或左右平衡。中心節點位置不變。
// 每一層一欄，欄寬依該層最寬的節點；收合的節點底下的子孫跟著它一起移動。

export interface LayoutNode {
  id: string
  parent_id: string | null
  x: number
  y: number
  collapsed: number
}

export type LayoutMode = 'right' | 'balanced'

const GAP_X = 56
const GAP_Y = 14

interface Item {
  id: string
  children: Item[]
}

export function tidyLayout(
  nodes: LayoutNode[],
  size: (id: string) => { w: number; h: number },
  mode: LayoutMode
): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>()
  const root = nodes.find((n) => !n.parent_id)
  if (!root) return out
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const kids = (id: string): LayoutNode[] => nodes.filter((n) => n.parent_id === id)

  // 只排看得到的節點（收合的節點不展開它的子孫）
  const build = (n: LayoutNode): Item => ({ id: n.id, children: n.collapsed ? [] : kids(n.id).map(build) })
  const rootSize = size(root.id)
  const rowH = Math.max(...nodes.map((n) => size(n.id).h), 30) + GAP_Y
  const centerY = root.y + rootSize.h / 2

  const branches = kids(root.id).map(build)
  const leafCount = (i: Item): number => (i.children.length ? i.children.reduce((s, c) => s + leafCount(c), 0) : 1)

  // 左右平衡：依分支大小輪流分配到比較少的那一邊
  let right = branches
  let left: Item[] = []
  if (mode === 'balanced' && branches.length > 1) {
    right = []
    let r = 0
    let l = 0
    for (const b of branches) {
      if (r <= l) {
        right.push(b)
        r += leafCount(b)
      } else {
        left.push(b)
        l += leafCount(b)
      }
    }
  }

  const placeSide = (side: Item[], dir: 1 | -1): void => {
    if (side.length === 0) return
    const laid = tree<Item>().nodeSize([rowH, 1]).separation((a, b) => (a.parent === b.parent ? 1 : 1.3))(
      hierarchy<Item>({ id: root.id, children: side })
    )
    const all = laid.descendants().filter((d) => d.depth > 0)
    // 每一層的欄寬
    const colW: number[] = []
    for (const d of all) colW[d.depth] = Math.max(colW[d.depth] ?? 0, size(d.data.id).w)
    const colStart: number[] = []
    let acc = 0
    for (let depth = 1; depth < colW.length; depth++) {
      colStart[depth] = acc
      acc += (colW[depth] ?? 0) + GAP_X
    }
    // 這一邊整體垂直置中在中心節點
    const xs = all.map((d) => d.x)
    const mid = (Math.min(...xs) + Math.max(...xs)) / 2
    for (const d of all as HierarchyPointNode<Item>[]) {
      const s = size(d.data.id)
      const y = centerY + (d.x - mid) - s.h / 2
      const x =
        dir === 1
          ? root.x + rootSize.w + GAP_X + colStart[d.depth]
          : root.x - GAP_X - colStart[d.depth] - s.w
      out.set(d.data.id, { x: Math.round(x), y: Math.round(y) })
    }
  }
  placeSide(right, 1)
  placeSide(left, -1)

  // 收合節點底下看不到的子孫：跟著最近一個有排到的祖先移動同樣距離
  for (const n of nodes) {
    if (n.id === root.id || out.has(n.id)) continue
    let a = n.parent_id ? byId.get(n.parent_id) : undefined
    while (a && !out.has(a.id)) a = a.parent_id ? byId.get(a.parent_id) : undefined
    if (!a) continue
    const moved = out.get(a.id)!
    out.set(n.id, { x: n.x + (moved.x - a.x), y: n.y + (moved.y - a.y) })
  }
  return out
}
