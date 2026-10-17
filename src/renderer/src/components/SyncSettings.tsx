import { useEffect, useState } from 'react'
import type { AppStatus, CloudCandidate } from '../../../shared/types'
import { desk } from '../useDesk'

type Run = (fn: () => Promise<unknown>) => Promise<void>

function timeAgo(ms: number | null): string {
  if (!ms) return '尚未同步'
  const min = Math.floor((Date.now() - ms) / 60000)
  return min < 1 ? '剛剛同步' : `${min} 分鐘前同步`
}

/** 設定頁的「資料與跨電腦同步」區塊 */
export function SyncSettings({ status, run }: { status: AppStatus; run: Run }) {
  const [candidates, setCandidates] = useState<CloudCandidate[] | null>(null)
  // 雲端與這台電腦都有資料時，等使用者選擇合併或改用雲端
  const [pending, setPending] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const sync = status.sync

  useEffect(() => {
    if (!sync.enabled || !sync.available) desk.sync.candidates().then(setCandidates)
  }, [sync.enabled, sync.available])

  const enable = (folder: string, choice?: 'merge' | 'discard'): Promise<void> =>
    run(async () => {
      setBusy(true)
      try {
        const result = await desk.sync.enable(folder, choice)
        setPending(result === 'needsChoice' ? folder : null)
      } finally {
        setBusy(false)
      }
    })

  const pickOther = (): Promise<void> =>
    run(async () => {
      const folder = await desk.sync.pickFolder()
      if (folder) await enable(folder)
    })

  if (pending) {
    return (
      <section>
        <h3>資料與跨電腦同步</h3>
        <p>這個資料夾裡已經有其他電腦的研究資料，這台電腦也有自己的資料。要怎麼處理？</p>
        <div className="btn-row">
          <button className="btn btn-primary" disabled={busy} onClick={() => enable(pending, 'merge')}>
            合併兩邊的資料
          </button>
          <button className="btn" disabled={busy} onClick={() => enable(pending, 'discard')}>
            改用雲端的資料
          </button>
          <button className="btn" disabled={busy} onClick={() => setPending(null)}>
            取消
          </button>
        </div>
        <p className="muted">選「改用雲端的資料」時，這台電腦原本的資料會另存一份備份，不會直接刪除。</p>
      </section>
    )
  }

  const choices = (
    <>
      <div className="btn-row">
        {candidates?.map((c) => (
          <button key={c.path} className="btn" disabled={busy} onClick={() => enable(c.path)} title={c.path}>
            {c.label}
            {c.hasData && '（已有資料）'}
          </button>
        ))}
        <button className="btn" disabled={busy} onClick={pickOther}>
          其他資料夾…
        </button>
      </div>
      {candidates?.length === 0 && (
        <p className="muted">
          這台電腦上沒有找到 OneDrive、Google Drive 或 Dropbox。安裝其中一個的電腦版程式後，就能在這裡選擇。
        </p>
      )}
    </>
  )

  if (!sync.enabled) {
    return (
      <section>
        <h3>資料與跨電腦同步</h3>
        <p>資料目前只存在這台電腦。想在多台電腦使用同一份資料，可以存到你的雲端硬碟：</p>
        {choices}
        <button className="link-btn" onClick={() => desk.settings.openDataDir()}>
          開啟本機資料夾
        </button>
      </section>
    )
  }

  return (
    <section>
      <h3>資料與跨電腦同步</h3>
      <p className="path">{sync.dir}</p>
      {sync.available ? (
        <p className="muted">
          {timeAgo(sync.lastSyncAt)}
          {sync.otherDevices > 0 ? `・已和其他 ${sync.otherDevices} 台電腦共用` : '・還沒有其他電腦加入'}
        </p>
      ) : (
        <>
          <p>找不到這個資料夾，修改會先存在這台電腦。如果資料夾搬到別的地方，請重新指定：</p>
          {choices}
        </>
      )}
      <div className="btn-row">
        <button className="btn" onClick={() => desk.settings.openDataDir()}>
          開啟資料夾
        </button>
        <button className="btn" disabled={busy} onClick={() => run(() => desk.sync.disable())}>
          停止同步
        </button>
      </div>
      <p className="muted">
        其他電腦要加入時，在那台電腦的「設定」選同一個雲端硬碟即可。停止同步後，資料會複製一份留在這台電腦。
      </p>
    </section>
  )
}
