import { safeStorage, shell } from 'electron'
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import type { GoogleStatus } from '../../shared/types'
import { AuthExpiredError } from './errors'

// Google 登入：桌面應用程式的標準流程（瀏覽器登入 → 導回本機 127.0.0.1 → 以 PKCE 換取權杖）。
// 權杖只存在這台電腦，用 Windows 的 DPAPI（safeStorage）加密，不放雲端資料夾。
// OAuth 用戶端是「測試模式」時，refresh token 約 7 天失效，屆時狀態變成 expired，請使用者重新登入。

const CLIENT_ID = import.meta.env.MAIN_VITE_GOOGLE_CLIENT_ID ?? ''
// 桌面應用程式的 client secret 依 Google 文件不視為機密，但仍放在 .env，不進版本控制
const CLIENT_SECRET = import.meta.env.MAIN_VITE_GOOGLE_CLIENT_SECRET ?? ''
const SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/calendar']
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000

interface Tokens {
  access_token: string
  refresh_token: string
  expires_at: number
  email: string
}

const base64url = (buf: Buffer): string => buf.toString('base64url')

function emailFromIdToken(idToken: string | undefined): string {
  try {
    return JSON.parse(Buffer.from(idToken!.split('.')[1], 'base64url').toString()).email ?? ''
  } catch {
    return ''
  }
}

const DONE_PAGE = (ok: boolean): string => `<!doctype html><meta charset="utf-8"><title>Research Desk</title>
<body style="font-family:system-ui,sans-serif;display:grid;place-items:center;height:90vh;color:#333">
<div style="text-align:center"><h2>${ok ? '登入完成' : '登入沒有完成'}</h2>
<p>${ok ? '可以關閉這個分頁，回到 Research Desk。' : '請回到 Research Desk 再試一次。'}</p></div>`

export class GoogleAuth {
  private tokens: Tokens | null = null
  private expired = false
  private refreshing: Promise<string> | null = null
  private listeners = new Set<() => void>()

  constructor(private file: string) {
    this.load()
  }

  get configured(): boolean {
    return !!CLIENT_ID
  }

  get signedIn(): boolean {
    return !!this.tokens && !this.expired
  }

  status(): GoogleStatus {
    return {
      configured: this.configured,
      state: !this.tokens ? 'signedOut' : this.expired ? 'expired' : 'signedIn',
      email: this.tokens?.email ?? null
    }
  }

  onChange(listener: () => void): void {
    this.listeners.add(listener)
  }

  private emit(): void {
    this.listeners.forEach((l) => l())
  }

  private load(): void {
    try {
      const buf = fs.readFileSync(this.file)
      this.tokens = JSON.parse(safeStorage.decryptString(buf)) as Tokens
    } catch {
      this.tokens = null
    }
  }

  private save(): void {
    if (!this.tokens) {
      fs.rmSync(this.file, { force: true })
      return
    }
    fs.writeFileSync(this.file, safeStorage.encryptString(JSON.stringify(this.tokens)))
  }

  /** 開啟瀏覽器登入，等使用者完成後回來 */
  async signIn(): Promise<void> {
    if (!this.configured) throw new Error('尚未設定 Google 用戶端，請參考 README 的「Google 行事曆設定」。')
    const verifier = base64url(randomBytes(32))
    const challenge = base64url(createHash('sha256').update(verifier).digest())
    const state = base64url(randomBytes(16))

    const { code, redirectUri } = await new Promise<{ code: string; redirectUri: string }>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        if (url.pathname !== '/callback') {
          res.writeHead(404).end()
          return
        }
        const ok = url.searchParams.get('state') === state && !!url.searchParams.get('code')
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(DONE_PAGE(ok))
        clearTimeout(timer)
        server.close()
        if (ok) resolve({ code: url.searchParams.get('code')!, redirectUri })
        else reject(new Error(url.searchParams.get('error') === 'access_denied' ? '已取消 Google 登入。' : 'Google 登入失敗。'))
      })
      const timer = setTimeout(() => {
        server.close()
        reject(new Error('等候 Google 登入逾時，請再試一次。'))
      }, LOGIN_TIMEOUT_MS)
      let redirectUri = ''
      server.listen(0, '127.0.0.1', () => {
        redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`
        const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth')
        auth.search = new URLSearchParams({
          client_id: CLIENT_ID,
          redirect_uri: redirectUri,
          response_type: 'code',
          scope: SCOPES.join(' '),
          code_challenge: challenge,
          code_challenge_method: 'S256',
          access_type: 'offline',
          prompt: 'consent',
          state
        }).toString()
        shell.openExternal(auth.toString())
      })
    })

    const data = await this.tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier
    })
    this.tokens = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + data.expires_in * 1000,
      email: emailFromIdToken(data.id_token)
    }
    this.expired = false
    this.save()
    this.emit()
  }

  signOut(): void {
    const token = this.tokens?.refresh_token
    this.tokens = null
    this.expired = false
    this.save()
    this.emit()
    // 順便撤銷授權；失敗也沒關係
    if (token) fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: 'POST' }).catch(() => {})
  }

  /** 取得可用的 access token，快過期時自動更新 */
  async accessToken(force = false): Promise<string> {
    if (!this.tokens || this.expired) throw new AuthExpiredError()
    if (!force && Date.now() < this.tokens.expires_at - 60_000) return this.tokens.access_token
    if (!this.refreshing) {
      this.refreshing = this.refresh().finally(() => (this.refreshing = null))
    }
    return this.refreshing
  }

  private async refresh(): Promise<string> {
    try {
      const data = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: this.tokens!.refresh_token })
      this.tokens = { ...this.tokens!, access_token: data.access_token, expires_at: Date.now() + data.expires_in * 1000 }
      this.save()
      return this.tokens.access_token
    } catch (err) {
      if (err instanceof AuthExpiredError) {
        this.expired = true
        this.emit()
      }
      throw err
    }
  }

  private async tokenRequest(params: Record<string, string>) {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...params })
    })
    const data = await res.json()
    if (!res.ok) {
      if (data.error === 'invalid_grant') throw new AuthExpiredError()
      throw new Error(`Google 登入錯誤：${data.error_description ?? data.error ?? res.status}`)
    }
    return data as { access_token: string; refresh_token: string; expires_in: number; id_token?: string }
  }

  /** 呼叫 Google API；權杖被拒時更新一次再試 */
  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const send = async (token: string): Promise<Response> =>
      fetch(url, {
        ...init,
        headers: { ...init.headers, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
      })
    let res = await send(await this.accessToken())
    if (res.status === 401) res = await send(await this.accessToken(true))
    return res
  }
}
