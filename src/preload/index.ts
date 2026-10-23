import { contextBridge, ipcRenderer } from 'electron'
import type { AiStream, DeskApi, Focus, ReaderStatus } from '../shared/types'

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
    importDoi: call('papers.importDoi'),
    update: call('papers.update'),
    confirmBib: call('papers.confirmBib'),
    lookupDoi: call('papers.lookupDoi'),
    aiFill: call('papers.aiFill'),
    open: call('papers.open'),
    remove: call('papers.remove'),
    search: call('papers.search'),
    copy: call('papers.copy')
  },
  reader: {
    open: call('reader.open'),
    queue: call('reader.queue'),
    status: call('reader.status'),
    restore: call('reader.restore')
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
  notes: {
    pages: call('notes.pages'),
    create: call('notes.create'),
    rename: call('notes.rename'),
    move: call('notes.move'),
    trash: call('notes.trash'),
    restore: call('notes.restore'),
    purge: call('notes.purge'),
    blocks: call('notes.blocks'),
    saveBlocks: call('notes.saveBlocks'),
    saveImage: call('notes.saveImage'),
    exportMd: call('notes.exportMd'),
    pickMd: call('notes.pickMd'),
    importPage: call('notes.importPage'),
    appendBlocks: call('notes.appendBlocks')
  },
  marks: {
    list: call('marks.list'),
    add: call('marks.add'),
    update: call('marks.update'),
    remove: call('marks.remove')
  },
  links: {
    add: call('links.add'),
    remove: call('links.remove'),
    forNode: call('links.forNode'),
    forMap: call('links.forMap'),
    forPaper: call('links.forPaper'),
    forTasks: call('links.forTasks')
  },
  translate: {
    status: call('translate.status'),
    setKey: call('translate.setKey'),
    clearKey: call('translate.clearKey'),
    text: call('translate.text')
  },
  ai: {
    status: call('ai.status'),
    setKey: call('ai.setKey'),
    clearKey: call('ai.clearKey'),
    setAutoFill: call('ai.setAutoFill'),
    setDaily: call('ai.setDaily'),
    setOpenAlexKey: call('ai.setOpenAlexKey')
  },
  professor: {
    conversations: call('professor.conversations'),
    create: call('professor.create'),
    rename: call('professor.rename'),
    remove: call('professor.remove'),
    messages: call('professor.messages'),
    send: call('professor.send'),
    daily: call('professor.daily'),
    startFromTip: call('professor.startFromTip'),
    recommend: call('professor.recommend')
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
    remove: call('calendar.remove'),
    hidden: call('calendar.hidden'),
    setHidden: call('calendar.setHidden')
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
    openFull: (focus) => ipcRenderer.invoke('window:openFull', focus),
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
  onAiStream: (callback) => {
    const handler = (_e: unknown, s: AiStream): void => callback(s)
    ipcRenderer.on('ai:stream', handler)
    return () => ipcRenderer.removeListener('ai:stream', handler)
  },
  onNavigate: (callback) => {
    const handler = (_e: unknown, f: Focus): void => callback(f)
    ipcRenderer.on('desk:navigate', handler)
    return () => ipcRenderer.removeListener('desk:navigate', handler)
  },
  onReaderStatus: (callback) => {
    const handler = (_e: unknown, s: ReaderStatus): void => callback(s)
    ipcRenderer.on('reader:status', handler)
    return () => ipcRenderer.removeListener('reader:status', handler)
  },
  onChanged: (callback) => {
    const handler = (): void => callback()
    ipcRenderer.on('desk:changed', handler)
    return () => ipcRenderer.removeListener('desk:changed', handler)
  }
}

contextBridge.exposeInMainWorld('desk', api)
