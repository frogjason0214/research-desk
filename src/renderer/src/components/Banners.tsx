import type { AppStatus } from '../../../shared/types'

/** 雲端資料夾找不到時的提示；資料照常存在這台電腦，恢復後自動同步 */
export function SyncBanner({ status, onRetry }: { status: AppStatus; onRetry: () => void }) {
  if (!status.sync.enabled || status.sync.available) return null
  return (
    <div className="banner banner-warn" role="status">
      <p>找不到雲端資料夾，修改會先存在這台電腦，資料夾恢復後自動同步。可以到「設定」重新指定資料夾。</p>
      <button className="btn" onClick={onRetry}>
        重新檢查
      </button>
    </div>
  )
}

/** Google 登入過期（測試模式約 7 天一次）時提示重新登入 */
export function GoogleBanner({ status, onSignIn }: { status: AppStatus; onSignIn: () => void }) {
  if (status.google.state !== 'expired') return null
  return (
    <div className="banner banner-warn" role="status">
      <p>Google 登入已過期，待辦暫時不會同步到行事曆。</p>
      <button className="btn" onClick={onSignIn}>
        重新登入
      </button>
    </div>
  )
}

export function ErrorBanner({ error, onClose }: { error: string | null; onClose: () => void }) {
  if (!error) return null
  return (
    <div className="banner banner-error" role="alert">
      <p>{error}</p>
      <button className="icon-btn" onClick={onClose} aria-label="關閉訊息">
        ✕
      </button>
    </div>
  )
}
