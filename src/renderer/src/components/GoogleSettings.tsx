import type { AppStatus } from '../../../shared/types'
import { desk } from '../useDesk'

type Run = (fn: () => Promise<unknown>) => Promise<void>

/** 設定頁的「Google 行事曆」區塊 */
export function GoogleSettings({ status, run }: { status: AppStatus; run: Run }) {
  const g = status.google
  return (
    <section>
      <h3>Google 行事曆</h3>
      {!g.configured ? (
        <p className="muted">這個版本還沒有設定 Google 用戶端。</p>
      ) : g.state === 'signedOut' ? (
        <>
          <p>登入後，有截止日的待辦會自動同步到 Google 的「研究任務」行事曆，也能在「行事曆」頁查看與編輯行程。</p>
          <button className="btn btn-primary" onClick={() => run(() => desk.google.signIn())}>
            登入 Google
          </button>
        </>
      ) : (
        <>
          <p>
            {g.state === 'expired' ? '登入已過期：' : '已登入：'}
            {g.email}
          </p>
          {g.taskSyncError && g.state === 'signedIn' && (
            <p className="muted">待辦同步暫時失敗，稍後會自動重試（{g.taskSyncError}）</p>
          )}
          <div className="btn-row">
            {g.state === 'expired' && (
              <button className="btn btn-primary" onClick={() => run(() => desk.google.signIn())}>
                重新登入
              </button>
            )}
            <button className="btn" onClick={() => run(() => desk.google.signOut())}>
              登出
            </button>
          </div>
          <p className="muted">登入資訊只存在這台電腦。每台電腦需要各自登入一次。</p>
        </>
      )}
    </section>
  )
}
