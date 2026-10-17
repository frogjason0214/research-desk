import { safeStorage } from 'electron'
import fs from 'node:fs'

// Gemini API（直接用 REST）。每個人在設定頁填自己的金鑰，以 DPAPI 加密存在這台電腦，不放雲端資料夾。

export const GEMINI_MODEL = 'gemini-3.5-flash-lite'
const API = 'https://generativelanguage.googleapis.com/v1beta/models'

export type Part = { text: string } | { inline_data: { mime_type: string; data: string } }

/** Gemini 的 responseSchema（OpenAPI 子集） */
export type Schema =
  | { type: 'STRING'; description?: string }
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

  /** 一般文字回覆（第四階段的對話會用到） */
  async text(parts: Part[], system?: string): Promise<string> {
    if (!this.key) throw new Error('尚未設定 Gemini API 金鑰，請到「設定」填入。')
    return this.call(this.key, parts, {}, system)
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
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      const msg: string = data.error?.message ?? ''
      if (res.status === 400 && /API key/i.test(msg)) throw new Error('Gemini API 金鑰無效，請確認是否複製完整。')
      if (res.status === 403) throw new Error('這把 Gemini 金鑰沒有權限，請確認 Google AI Studio 裡的專案設定。')
      if (res.status === 429) throw new Error('Gemini 免費額度暫時用完了，請稍後再試。')
      throw new Error(`Gemini 錯誤（${res.status}）：${msg}`)
    }
    const text = data.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? '').join('') ?? ''
    if (!text) throw new Error('Gemini 沒有回覆內容（可能被安全篩選擋下）。')
    return text
  }
}
