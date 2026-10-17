import { randomUUID } from 'node:crypto'
import type { Store } from './store'
import {
  MILESTONE_TEMPLATE,
  type Milestone,
  type MilestonePatch,
  type Project,
  type Task,
  type TaskPatch
} from '../shared/types'

const now = (): string => new Date().toISOString()

function pick(patch: Record<string, unknown>, allowed: string[]): Record<string, unknown> {
  const fields = Object.fromEntries(Object.entries(patch).filter(([k]) => allowed.includes(k)))
  if (Object.keys(fields).length === 0) throw new Error('沒有可更新的欄位')
  return fields
}

function cleanTitle(title: string): string {
  const t = title.trim()
  if (!t) throw new Error('名稱不能是空白')
  return t
}

export function createDataHandlers(store: Store) {
  const milestonesOf = (projectId: string): Milestone[] =>
    store.all<Milestone>('SELECT * FROM milestones WHERE project_id = ? ORDER BY sort', [projectId])

  return {
    'projects.list': (): Project[] =>
      store.all<Project>('SELECT id, name, created_at FROM projects ORDER BY created_at'),

    'projects.create': (name: string): Project => {
      const project: Project = { id: randomUUID(), name: cleanTitle(name), created_at: now() }
      store.write((tx) => {
        tx.set('projects', project.id, { name: project.name, created_at: project.created_at })
        MILESTONE_TEMPLATE.forEach((m, i) => {
          tx.set('milestones', randomUUID(), {
            project_id: project.id,
            title: m.title,
            due_date: null,
            done: 0,
            sort: i,
            is_defense: m.isDefense ? 1 : 0
          })
        })
      })
      return project
    },

    'projects.rename': (id: string, name: string): void =>
      store.write((tx) => tx.set('projects', id, { name: cleanTitle(name) })),

    'projects.remove': (id: string): void => {
      const tasks = store.all<{ id: string }>('SELECT id FROM tasks WHERE project_id = ?', [id])
      const milestones = milestonesOf(id)
      store.write((tx) => {
        tasks.forEach((t) => tx.remove('tasks', t.id))
        milestones.forEach((m) => tx.remove('milestones', m.id))
        tx.remove('projects', id)
      })
    },

    'milestones.list': milestonesOf,

    'milestones.create': (projectId: string, title: string): void => {
      const max = store.get<{ m: number | null }>('SELECT MAX(sort) AS m FROM milestones WHERE project_id = ?', [
        projectId
      ])
      store.write((tx) =>
        tx.set('milestones', randomUUID(), {
          project_id: projectId,
          title: cleanTitle(title),
          due_date: null,
          done: 0,
          sort: (max?.m ?? -1) + 1,
          is_defense: 0
        })
      )
    },

    'milestones.update': (id: string, patch: MilestonePatch): void => {
      if (patch.title !== undefined) patch.title = cleanTitle(patch.title)
      const fields = pick(patch, ['title', 'due_date', 'done'])
      store.write((tx) => tx.set('milestones', id, fields))
    },

    'milestones.remove': (id: string): void => store.write((tx) => tx.remove('milestones', id)),

    'milestones.move': (id: string, direction: -1 | 1): void => {
      const target = store.get<Milestone>('SELECT * FROM milestones WHERE id = ?', [id])
      if (!target) return
      const list = milestonesOf(target.project_id)
      const i = list.findIndex((m) => m.id === id)
      const j = i + direction
      if (j < 0 || j >= list.length) return
      ;[list[i], list[j]] = [list[j], list[i]]
      // 只寫入順序有變的里程碑，減少和其他電腦的修改互相覆蓋
      store.write((tx) => list.forEach((m, k) => m.sort !== k && tx.set('milestones', m.id, { sort: k })))
    },

    'milestones.setDefense': (id: string): void => {
      const target = store.get<Milestone>('SELECT * FROM milestones WHERE id = ?', [id])
      if (!target) return
      store.write((tx) =>
        milestonesOf(target.project_id).forEach((m) => {
          const flag = m.id === id ? 1 : 0
          if (m.is_defense !== flag) tx.set('milestones', m.id, { is_defense: flag })
        })
      )
    },

    'tasks.list': (projectId: string): Task[] =>
      store.all<Task>(
        `SELECT id, project_id, title, due_date, done, done_at, created_at FROM tasks
         WHERE project_id = ? ORDER BY done, due_date IS NULL, due_date, created_at`,
        [projectId]
      ),

    'tasks.create': (projectId: string, title: string, dueDate: string | null): void =>
      store.write((tx) =>
        tx.set('tasks', randomUUID(), {
          project_id: projectId,
          title: cleanTitle(title),
          due_date: dueDate || null,
          done: 0,
          done_at: null,
          created_at: now()
        })
      ),

    'tasks.update': (id: string, patch: TaskPatch): void => {
      if (patch.title !== undefined) patch.title = cleanTitle(patch.title)
      const fields: Record<string, unknown> = { ...patch }
      if (patch.done !== undefined) fields.done_at = patch.done ? now() : null
      store.write((tx) => tx.set('tasks', id, pick(fields, ['title', 'due_date', 'done', 'done_at'])))
    },

    'tasks.remove': (id: string): void => store.write((tx) => tx.remove('tasks', id))
  }
}
