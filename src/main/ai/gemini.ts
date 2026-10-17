import { safeStorage } from 'electron'
import fs from 'node:fs'

// Gemini API（直接用 REST）。每個人在設定頁填自己的金鑰，以 DPAPI 加密存在這台電腦，不放雲端資料夾。

export const GEMINI_MODEL = 'gemini-3.5-flash-lite'
// 自動化測試可以指向本機的模擬伺服器
const API = process.env.RESEARCH_DESK_GEMINI_API ?? 'https://generativelanguage.googleapis.com/v1beta/models'

export type Part = { text: string } | { inline_data: { mime_type: string; data: string } }

/** Gemini 的 responseSchema（OpenAPI 子集） */
export type Schema =
  | { type: 'STRING'; description?: string }
  | { type: 'INTEGER'; description?: string }
  | { type: 'ARRAY'; items: Schema; description?: string }
  | { type: 'OBJECT'; properties: Record<string, Schema>; required?: string[]; description?: string }

export class Gemini {
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

  /** 儲存前先試呼叫一次，確認金鑰可用 */
  async setKey(key: string): Promise<void> {
    const k = key.trim()
    if (!k) throw new Error('請貼上 Gemini API 金鑰')
    await this.call(k, [{ text: '回覆 OK' }])
    this.key = k
    fs.writeFileSync(this.file, safeStorage.encryptString(k))
  }

  clearKey(): void {
    this.key = null
    fs.rmSync(this.file, { force: true })
  }

  /** 要求以 JSON 回覆，並依 schema 解析 */
  async json<T>(parts: Part[], schema: Schema, system?: string): Promise<T> {
    if (!this.key) throw new Error('尚未設定 Gemini API 金鑰，請到「設定」填入。')
    const text = await this.call(this.key, parts, { responseMimeType: 'application/json', responseSchema: schema }, system)
    return JSON.parse(text) as T
  }

  /**
   * 多輪對話，邊產生邊回報（Server-Sent Events）。onText 收到的是目前為止的完整回覆。
   */
  async stream(contents: Turn[], system: string, onText: (text: string) => void, temperature = 0.7): Promise<string> {
    if (!this.key) throw new Error('尚未設定 Gemini API 金鑰，請到「設定」填入。')
    const res = await fetch(`${API}/${GEMINI_MODEL}:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.key },
      body: JSON.stringify({
        contents,
        generationConfig: { temperature },
        systemInstruction: { parts: [{ text: system }] }
      })
    })
    if (!res.ok || !res.body) throw await apiError(res)
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let full = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      // 每個事件以空行分隔，內容在 data: 之後
      let cut: number
      while ((cut = buffer.indexOf('\n\n')) >= 0) {
        const event = buffer.slice(0, cut)
        buffer = buffer.slice(cut + 2)
        for (const line of event.split('\n')) {
          if (!line.startsWith('data:')) continue
          try {
            const data = JSON.parse(line.slice(5))
            const piece = data.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? '').join('') ?? ''
            if (piece) {
              full += piece
              onText(full)
            }
          } catch {
            /* 不完整的事件，忽略 */
          }
        }
      }
    }
    if (!full) throw new Error('Gemini 沒有回覆內容（可能被安全篩選擋下），請換個說法再試。')
    return full
  }

  private async call(key: string, parts: Part[], config: object = {}, system?: string): Promise<string> {
    const res = await fetch(`${API}/${GEMINI_MODEL}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: { temperature: 0.2, ...config },
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {})
      })
    })
    if (!res.ok) throw await apiError(res)
    const data = await res.json().catch(() => ({}))
    const text = data.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? '').join('') ?? ''
    if (!text) throw new Error('Gemini 沒有回覆內容（可能被安全篩選擋下）。')
    return text
  }
}

export interface Turn {
  role: 'user' | 'model'
  parts: { text: string }[]
}

async function apiError(res: Response): Promise<Error> {
  const data = await res.json().catch(() => ({}))
  const msg: string = data.error?.message ?? ''
  if (res.status === 400 && /API key/i.test(msg)) return new Error('Gemini API 金鑰無效，請確認是否複製完整。')
  if (res.status === 403) return new Error('這把 Gemini 金鑰沒有權限，請確認 Google AI Studio 裡的專案設定。')
  if (res.status === 429) return new Error('Gemini 免費額度暫時用完了，請稍後再試。')
  return new Error(`Gemini 錯誤（${res.status}）：${msg}`)
}
