import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Focus, Source } from '../../../shared/types'

// AI 回覆的 Markdown；[S1]、[P2] 這類來源標記變成可點的小標籤，點了跳到該文獻

const MARK = /\[([PS]\d+(?:\s*[,，、]\s*[PS]\d+)*)\]/g

function linkSources(text: string): string {
  return text.replace(MARK, (_, keys: string) =>
    keys
      .split(/\s*[,，、]\s*/)
      .map((k) => `[${k}](#src-${k})`)
      .join('')
  )
}

export function AiMarkdown({
  text,
  sources,
  onNavigate
}: {
  text: string
  sources: Source[]
  onNavigate: (f: Focus) => void
}) {
  const byKey = new Map(sources.map((s) => [s.key, s]))
  return (
    <div className="ai-md">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => {
            if (href?.startsWith('#src-')) {
              const src = byKey.get(href.slice(5))
              return (
                <button
                  className="src-chip"
                  disabled={!src}
                  title={src ? `${src.title}（${src.year || '無年份'}）${src.page ? `第 ${src.page} 頁` : ''}` : '來源還在整理中'}
                  onClick={() => src && onNavigate({ page: 'literature', paperId: src.paperId })}
                >
                  {children}
                </button>
              )
            }
            return (
              <a href={href} target="_blank" rel="noreferrer">
                {children}
              </a>
            )
          }
        }}
      >
        {linkSources(text)}
      </Markdown>
    </div>
  )
}

/** 回覆下方列出引用到的文獻 */
export function SourceList({ sources, onNavigate }: { sources: Source[]; onNavigate: (f: Focus) => void }) {
  if (sources.length === 0) return null
  return (
    <ul className="src-list">
      {sources.map((s) => (
        <li key={s.key}>
          <button className="link-btn" onClick={() => onNavigate({ page: 'literature', paperId: s.paperId })}>
            <span className="src-key">{s.key}</span> {s.title}（{s.year || '無年份'}）{s.page ? `，第 ${s.page} 頁` : ''}
          </button>
        </li>
      ))}
    </ul>
  )
}
