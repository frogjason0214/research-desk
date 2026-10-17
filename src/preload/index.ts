import { contextBridge, ipcRenderer } from 'electron'
import type { DeskApi } from '../shared/types'

// 畫面只能透過這個橋接物件存取資料，無法直接碰到檔案系統
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const call = (method: string) => (...args: unknown[]): Promise<any> => ipcRenderer.invoke('desk:call', method, args)

const api: DeskApi = {
  status: call('status'),
  projects: {
    list: call('projects.list'),
    create: call('projects.create'),
    rename: call('projects.rename'),
    remove: call('projects.remove'),
    setCurrent: call('projects.setCurrent')
  },
  milestones: {
    list: call('milestones.list'),
    create: call('milestones.create'),
    update: call('milestones.update'),
    remove: call('milestones.remove'),
    move: call('milestones.move'),
    setDefense: call('milestones.setDefense')
  },
  tasks: {
    list: call('tasks.list'),
    create: call('tasks.create'),
    update: call('tasks.update'),
    remove: call('tasks.remove')
  },
  sync: {
    candidates: call('sync.candidates'),
    pickFolder: call('sync.pickFolder'),
    enable: call('sync.enable'),
    disable: call('sync.disable'),
    now: call('sync.now')
  },
  papers: {
    list: call('papers.list'),
    importPdf: call('papers.importPdf'),
    importWeb: call('papers.importWeb'),
    update: call('papers.update'),
    confirmBib: call('papers.confirmBib'),
    lookupDoi: call('papers.lookupDoi'),
    aiFill: call('papers.aiFill'),
    open: call('papers.open'),
    remove: call('papers.remove'),
    search: call('papers.search'),
    copy: call('papers.copy')
  },
  mindmaps: {
    list: call('mindmaps.list'),
    create: call('mindmaps.create'),
    rename: call('mindmaps.rename'),
    remove: call('mindmaps.remove'),
    saveImage: call('mindmaps.saveImage')
  },
  nodes: {
    list: call('nodes.list'),
    add: call('nodes.add'),
    update: call('nodes.update'),
    move: call('nodes.move'),
    remove: call('nodes.remove'),
    createTask: call('nodes.createTask')
  },
  links: {
    add: call('links.add'),
    remove: call('links.remove'),
    forNode: call('links.forNode'),
    forMap: call('links.forMap'),
    forPaper: call('links.forPaper'),
    forTasks: call('links.forTasks')
  },
  ai: {
    status: call('ai.status'),
    setKey: call('ai.setKey'),
    clearKey: call('ai.clearKey'),
    setAutoFill: call('ai.setAutoFill')
  },
  google: {
    signIn: call('google.signIn'),
    signOut: call('google.signOut')
  },
  calendar: {
    calendars: call('calendar.calendars'),
    events: call('calendar.events'),
    create: call('calendar.create'),
    update: call('calendar.update'),
    remove: call('calendar.remove')
  },
  update: {
    check: call('update.check'),
    install: call('update.install')
  },
  settings: {
    openDataDir: call('settings.openDataDir'),
    setLaunchAtLogin: call('settings.setLaunchAtLogin')
  },
  window: {
    setSidebarLayout: (layout) => ipcRenderer.invoke('window:setSidebarLayout', layout),
    saveSidebarTop: (ratio) => ipcRenderer.invoke('window:saveSidebarTop', ratio),
    openFull: () => ipcRenderer.invoke('window:openFull'),
    closeFull: () => ipcRenderer.invoke('window:closeFull'),
    quit: () => ipcRenderer.invoke('window:quit')
  },
  onSidebarHover: (callback) => {
    const enter = (): void => callback('enter')
    const leave = (): void => callback('leave')
    ipcRenderer.on('sidebar:enter', enter)
    ipcRenderer.on('sidebar:leave', leave)
    return () => {
      ipcRenderer.removeListener('sidebar:enter', enter)
      ipcRenderer.removeListener('sidebar:leave', leave)
    }
  },
  onChanged: (callback) => {
    const handler = (): void => callback()
    ipcRenderer.on('desk:changed', handler)
    return () => ipcRenderer.removeListener('desk:changed', handler)
  }
}

contextBridge.exposeInMainWorld('desk', api)
