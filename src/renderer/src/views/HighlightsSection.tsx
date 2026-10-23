import { Copy, FilePlus2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { Focus, Paper } from '../../../shared/types'
import { errorText } from '../importing'
import { addHighlightsToNote, highlightsAsText } from '../notes/fromHighlight'
import { PagePicker } from '../notes/PagePicker'
import { cropArea, loadHighlights, type HighlightItem, type OpenedPdf } from '../reader/highlightText'

// 文獻頁的「重點」區：這篇 PDF 的所有重點與註解，可以跳回閱讀器、勾選加到筆記、複製

const rgbCss = (rgb: [number, number, number]): string => `rgb(${rgb.map((v) => Math.round(v * 255)).join(' ')})`

export function HighlightsSection({
  paper,
  onRead,
  onNavigate
}: {
  paper: Paper
  /** 打開閱讀器並跳到這個重點 */
  onRead: (annotKey: string) => void
  onNavigate: (f: Focus) => void
}) {
  const [data, setData] = useState<{ items: HighlightItem[]; opened: OpenedPdf } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [picking, setPicking] = useState(false)
  const [message, setMessage] = useState<{ text: string; pageId?: string } | null>(null)

  useEffect(() => {
    let cancelled = false
    setData(null)
    setError(null)
    setChecked(new Set())
    loadHighlights(paper)
      .then((d) => !cancelled && setData(d))
      .catch((err) => !cancelled && setError(errorText(err)))
    return () => {
      cancelled = true
    }
    // 書目欄位更新（例如同步）時不要重讀、清掉勾選
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paper.id])

  const items = data?.items ?? []
  const chosen = items.filter((i) => checked.has(i.annot.key))
  const toggle = (key: string): void =>
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const add = async (page: { id: string; title: string }): Promise<void> => {
    setPicking(false)
    if (!data) return
    try {
      await addHighlightsToNote(paper, data.opened, chosen.map((i) => i.annot), page.id)
      setMessage({ text: `已把 ${chosen.length} 個重點加到「${page.title}」`, pageId: page.id })
      setChecked(new Set())
    } catch (err) {
      setError(errorText(err))
    }
  }

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(highlightsAsText(paper, chosen))
      setMessage({ text: `已複製 ${chosen.length} 個重點` })
    } catch (err) {
      setError(errorText(err))
    }
  }

  return (
    <section className="paper-section hl-section">
      <div className="section-head">
        <h3>重點{data ? `（${items.length}）` : ''}</h3>
        {items.length > 0 && (
          <span className="hl-tools">
            <label className="check">
              <input
                type="checkbox"
                checked={chosen.length === items.length}
                onChange={(e) => setChecked(e.target.checked ? new Set(items.map((i) => i.annot.key)) : new Set())}
              />
              全選
            </label>
            <button className="btn btn-icon" disabled={!chosen.length} onClick={() => setPicking(true)}>
              <FilePlus2 size={16} aria-hidden /> 加到筆記{chosen.length ? `（${chosen.length}）` : ''}
            </button>
            <button className="btn btn-icon" disabled={!chosen.length} onClick={() => void copy()}>
              <Copy size={16} aria-hidden /> 複製
            </button>
          </span>
        )}
      </div>
      {picking && (
        <div className="hl-picker">
          <PagePicker
            projectId={paper.project_id}
            newTitle={`${paper.title || '文獻'} 重點`}
            onPick={(page) => void add(page)}
            onClose={() => setPicking(false)}
          />
        </div>
      )}
      {message && (
        <p className="banner banner-info" role="status">
          {message.text}
          {message.pageId && (
            <button className="link-btn" onClick={() => onNavigate({ page: 'notes', noteId: message.pageId! })}>
              打開
            </button>
          )}
          <button className="link-btn" onClick={() => setMessage(null)}>
            關閉
          </button>
        </p>
      )}
      {error && <p className="banner banner-warn">{error}</p>}
      {!data && !error && <p className="muted">讀取中…</p>}
      {data && !items.length && <p className="muted">還沒有重點，按「閱讀」開始畫。</p>}
      {items.length > 0 && (
        <ul className="hl-list">
          {items.map((item) => (
            <li key={item.annot.key} className="hl-item">
              <input type="checkbox" aria-label="選這個重點" checked={checked.has(item.annot.key)} onChange={() => toggle(item.annot.key)} />
              <button className="hl-body" onClick={() => onRead(item.annot.key)} title="在閱讀器打開這個重點">
                <span className="hl-meta">
                  <span className="hl-dot" style={{ background: rgbCss(item.annot.rgb) }} aria-hidden />
                  {item.locator}
                  {!item.annot.mine && <span className="badge">其他程式</span>}
                </span>
                {item.annot.kind === 'area' ? (
                  <AreaThumb opened={data!.opened} item={item} />
                ) : item.text ? (
                  <span className="hl-text">{item.text}</span>
                ) : item.annot.kind === 'note' ? null : (
                  <span className="muted">（讀不出文字）</span>
                )}
                {item.annot.contents.trim() && <span className="hl-comment">{item.annot.contents}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** 框選重點的縮圖 */
function AreaThumb({ opened, item }: { opened: OpenedPdf; item: HighlightItem }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    let made: string | null = null
    void (async () => {
      try {
        const page = await opened.pdf.getPage(item.annot.page + 1)
        const png = await cropArea(page, item.annot.rect, 1)
        if (cancelled) return
        made = URL.createObjectURL(new Blob([png], { type: 'image/png' }))
        setUrl(made)
      } catch {
        /* 縮圖失敗就不顯示 */
      }
    })()
    return () => {
      cancelled = true
      if (made) URL.revokeObjectURL(made)
    }
  }, [opened, item])
  return url ? <img className="hl-thumb" src={url} alt={`框選的區域（${item.locator}）`} /> : <span className="muted">〔框選的區域〕</span>
}
