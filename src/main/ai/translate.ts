import { safeStorage } from 'electron'
import fs from 'node:fs'

// Google Cloud Translation（v2 REST，用 API 金鑰）。金鑰和 Gemini 一樣以 DPAPI 加密存在這台電腦，不放雲端資料夾。

// 自動化測試可以指向本機的模擬伺服器
const API = process.env.RESEARCH_DESK_TRANSLATE_API ?? 'https://translation.googleapis.com/language/translate/v2'
const MAX_CHARS = 5000

/** 中文字佔多數就翻成英文，其他一律翻成繁體中文 */
export function targetFor(text: string): 'zh-TW' | 'en' {
  const cjk = text.match(/[㐀-鿿]/g)?.length ?? 0
  const latin = text.match(/[A-Za-z]/g)?.length ?? 0
  return cjk > latin ? 'en' : 'zh-TW'
}

/** PDF 選取的文字常有斷行與連字號斷字，先接回一段 */
export function cleanSelection(text: string): string {
  return text
    .replace(/([a-z])-\s*\n\s*([a-z])/g, '$1$2')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

export class Translator {
  private key: string | null = null

  constructor(private file: string) {
    try {
      this.key = safeStorage.decryptString(fs.readFileSync(file))
    } catch {
      this.key = null
    }
  }

  get hasKey(): boolean {
    return !!this.key
  }

  /** 儲存前先試翻一次，確認金鑰可用 */
  async setKey(key: string): Promise<void> {
    const k = key.trim()
    if (!k) throw new Error('請貼上 Google Cloud Translation API 金鑰')
    await this.call(k, 'hello', 'zh-TW')
    this.key = k
    fs.writeFileSync(this.file, safeStorage.encryptString(k))
  }

  clearKey(): void {
    this.key = null
    fs.rmSync(this.file, { force: true })
  }

  async translate(raw: string): Promise<{ text: string; target: 'zh-TW' | 'en' }> {
    if (!this.key) throw new Error('尚未設定 Google 翻譯 API 金鑰，請到「設定」填入。')
    const q = cleanSelection(raw)
    if (!q) throw new Error('沒有選到文字')
    if (q.length > MAX_CHARS) throw new Error(`一次最多翻譯 ${MAX_CHARS} 字，請選短一點`)
    const target = targetFor(q)
    return { text: await this.call(this.key, q, target), target }
  }

  private async call(key: string, q: string, target: string): Promise<string> {
    let res: Response
    try {
      res = await fetch(`${API}?key=${encodeURIComponent(key)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q, target, format: 'text' })
      })
    } catch {
      throw new Error('連不上 Google 翻譯，請確認網路連線')
    }
    const body = (await res.json().catch(() => null)) as {
      data?: { translations?: { translatedText: string }[] }
      error?: { message?: string; status?: string }
    } | null
    if (!res.ok) {
      const msg = body?.error?.message ?? ''
      if (res.status === 400 && /API key not valid/i.test(msg)) throw new Error('API 金鑰無效，請重新確認')
      if (res.status === 403) {
        if (/billing/i.test(msg)) throw new Error('這個 Google Cloud 專案還沒啟用帳單，請先設定帳單帳戶')
        if (/not been used|disabled/i.test(msg)) throw new Error('這個 Google Cloud 專案還沒啟用 Cloud Translation API')
        throw new Error(`Google 翻譯拒絕這個金鑰：${msg || '權限不足'}`)
      }
      if (res.status === 429) throw new Error('翻譯次數超過額度，請稍後再試')
      throw new Error(`Google 翻譯發生錯誤（${res.status}）${msg ? `：${msg}` : ''}`)
    }
    const text = body?.data?.translations?.[0]?.translatedText
    if (typeof text !== 'string') throw new Error('Google 翻譯回傳的格式看不懂')
    return decodeEntities(text)
  }
}
