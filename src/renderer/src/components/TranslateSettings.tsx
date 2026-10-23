import { useEffect, useState } from 'react'
import { desk } from '../useDesk'

type Run = (fn: () => Promise<unknown>) => Promise<void>

/** 設定頁的「Google 翻譯」區塊（PDF 閱讀器選字翻譯用） */
export function TranslateSettings({ run }: { run: Run }) {
  const [hasKey, setHasKey] = useState<boolean | null>(null)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const reload = (): Promise<void> => desk.translate.status().then((s) => setHasKey(s.hasKey))
  useEffect(() => {
    reload()
  }, [])
  if (hasKey === null) return null

  return (
    <section>
      <h3>Google 翻譯</h3>
      {hasKey ? (
        <>
          <p>已設定 Google Cloud Translation API 金鑰。在 PDF 閱讀器選取文字後，按旁邊的「翻譯」就能看中文翻譯。</p>
          <button className="btn" onClick={() => run(async () => { await desk.translate.clearKey(); await reload() })}>
            移除金鑰
          </button>
        </>
      ) : (
        <>
          <p>
            填入 Google Cloud Translation API 金鑰後，在 PDF 閱讀器選取文字就能翻譯成中文（選中文會翻成英文）。金鑰在{' '}
            <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer">
              Google Cloud Console
            </a>{' '}
            建立，需要先啟用帳單與 Cloud Translation API；每月前 50 萬字免費。
          </p>
          <form
            className="inline-add"
            onSubmit={(e) => {
              e.preventDefault()
              run(async () => {
                setBusy(true)
                try {
                  await desk.translate.setKey(key)
                  setKey('')
                  await reload()
                } finally {
                  setBusy(false)
                }
              })
            }}
          >
            <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="貼上 API 金鑰" aria-label="Google 翻譯 API 金鑰" />
            <button className="btn btn-primary" type="submit" disabled={!key.trim() || busy}>
              {busy ? '驗證中…' : '儲存'}
            </button>
          </form>
        </>
      )}
      <p className="muted">金鑰以加密方式存在這台電腦，不會放進雲端資料夾；每台電腦要各自設定。</p>
    </section>
  )
}
