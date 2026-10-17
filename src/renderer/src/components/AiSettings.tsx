import { useEffect, useState } from 'react'
import type { AiStatus } from '../../../shared/types'
import { desk } from '../useDesk'

type Run = (fn: () => Promise<unknown>) => Promise<void>

/** 設定頁的「AI（Gemini）」區塊 */
export function AiSettings({ run }: { run: Run }) {
  const [ai, setAi] = useState<AiStatus | null>(null)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [openAlex, setOpenAlex] = useState('')
  const reload = (): Promise<void> => desk.ai.status().then(setAi)
  useEffect(() => {
    reload()
  }, [])
  if (!ai) return null

  return (
    <section>
      <h3>AI（Gemini）</h3>
      {ai.hasKey ? (
        <>
          <p>已設定 Gemini API 金鑰（模型：{ai.model}）。</p>
          <button className="btn" onClick={() => run(async () => { await desk.ai.clearKey(); await reload() })}>
            移除金鑰
          </button>
        </>
      ) : (
        <>
          <p>
            填入自己的 Gemini API 金鑰後，匯入文獻時會自動判讀中文書目、預填研究類型等欄位。金鑰可在{' '}
            <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">
              Google AI Studio
            </a>{' '}
            免費建立。
          </p>
          <form
            className="inline-add"
            onSubmit={(e) => {
              e.preventDefault()
              run(async () => {
                setBusy(true)
                try {
                  await desk.ai.setKey(key)
                  setKey('')
                  await reload()
                } finally {
                  setBusy(false)
                }
              })
            }}
          >
            <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="貼上 API 金鑰" aria-label="Gemini API 金鑰" />
            <button className="btn btn-primary" type="submit" disabled={!key.trim() || busy}>
              {busy ? '驗證中…' : '儲存'}
            </button>
          </form>
        </>
      )}
      <label className="check">
        <input
          type="checkbox"
          checked={ai.autoFill}
          onChange={(e) => run(async () => { await desk.ai.setAutoFill(e.target.checked); await reload() })}
        />
        匯入文獻時自動使用 AI
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={ai.daily}
          onChange={(e) => run(async () => { await desk.ai.setDaily(e.target.checked); await reload() })}
        />
        每天第一次展開邊欄時產生「AI 本日建議」
      </label>
      <form
        className="inline-add"
        onSubmit={(e) => {
          e.preventDefault()
          run(async () => {
            await desk.ai.setOpenAlexKey(openAlex)
            setOpenAlex('')
            await reload()
          })
        }}
      >
        <input
          type="password"
          value={openAlex}
          onChange={(e) => setOpenAlex(e.target.value)}
          placeholder={ai.hasOpenAlexKey ? '已設定 OpenAlex 金鑰（輸入新的可更換）' : 'OpenAlex 金鑰（選填）'}
          aria-label="OpenAlex 金鑰"
        />
        <button className="btn" type="submit" disabled={!openAlex.trim()}>
          儲存
        </button>
        {ai.hasOpenAlexKey && (
          <button className="btn" type="button" onClick={() => run(async () => { await desk.ai.setOpenAlexKey(''); await reload() })}>
            移除
          </button>
        )}
      </form>
      <p className="muted">
        「推薦新文獻」使用 OpenAlex 學術資料庫，不填金鑰也能用（與同一網路的人共用每日額度）；常用的話可以到{' '}
        <a href="https://openalex.org/settings/api" target="_blank" rel="noreferrer">
          OpenAlex
        </a>{' '}
        免費申請金鑰。
      </p>
      <p className="muted">
        金鑰以 Windows 加密存在這台電腦，不會放進雲端資料夾。使用免費額度時，送出的內容可能被 Google 用於改進產品；不想送出的文獻或筆記請勾選「不送 AI」。
      </p>
    </section>
  )
}
