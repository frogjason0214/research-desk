import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { CloudCandidate } from '../shared/types'
import { hasLibraryData, LIBRARY_FOLDER } from './library'

// 偵測這台電腦上的雲端硬碟資料夾，讓使用者點一下就能開啟同步

function readDropbox(): { label: string; path: string }[] {
  const found: { label: string; path: string }[] = []
  for (const base of [process.env.APPDATA, process.env.LOCALAPPDATA]) {
    if (!base) continue
    try {
      const info = JSON.parse(fs.readFileSync(path.join(base, 'Dropbox', 'info.json'), 'utf8'))
      if (info.personal?.path) found.push({ label: 'Dropbox', path: info.personal.path })
      if (info.business?.path) found.push({ label: 'Dropbox（團隊）', path: info.business.path })
    } catch {
      /* 沒有安裝 Dropbox */
    }
  }
  return found
}

function readGoogleDrive(): { label: string; path: string }[] {
  const found: { label: string; path: string }[] = []
  // Google Drive 電腦版預設掛成一個磁碟機（通常是 G:）
  for (let c = 'D'.charCodeAt(0); c <= 'Z'.charCodeAt(0); c++) {
    for (const name of ['My Drive', '我的雲端硬碟']) {
      found.push({ label: 'Google Drive', path: `${String.fromCharCode(c)}:\\${name}` })
    }
  }
  // 「鏡像」模式或舊版「備份與同步」
  const home = os.homedir()
  for (const name of ['My Drive', '我的雲端硬碟', 'Google Drive']) {
    found.push({ label: 'Google Drive', path: path.join(home, name) })
  }
  return found
}

export function detectCloudFolders(): CloudCandidate[] {
  const raw: { label: string; path: string }[] = []
  if (process.env.OneDriveConsumer) raw.push({ label: 'OneDrive', path: process.env.OneDriveConsumer })
  if (process.env.OneDriveCommercial) raw.push({ label: 'OneDrive（學校／公司）', path: process.env.OneDriveCommercial })
  if (process.env.OneDrive) raw.push({ label: 'OneDrive', path: process.env.OneDrive })
  raw.push(...readGoogleDrive(), ...readDropbox())
  raw.push({ label: 'iCloud Drive', path: path.join(os.homedir(), 'iCloudDrive') })

  const seen = new Set<string>()
  const result: CloudCandidate[] = []
  for (const c of raw) {
    const key = path.resolve(c.path).toLowerCase()
    if (seen.has(key) || !isDir(c.path)) continue
    seen.add(key)
    result.push({ ...c, hasData: hasLibraryData(path.join(c.path, LIBRARY_FOLDER)) })
  }
  return result
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}
