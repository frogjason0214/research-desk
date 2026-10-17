import type { Milestone } from '../../../shared/types'
import { daysBetween, shortDate, todayStr } from '../dates'

/** 口試倒數 + 里程碑進度軌道 */
export function Countdown({ milestones, onSetDate }: { milestones: Milestone[]; onSetDate?: () => void }) {
  const defense = milestones.find((m) => m.is_defense)
  const days = defense?.due_date ? daysBetween(todayStr(), defense.due_date) : null
  const done = milestones.filter((m) => m.done).length
  const next = milestones.find((m) => !m.done)

  return (
    <section className="countdown" aria-label="論文進度">
      <p className="countdown-label">
        {days !== null && days < 0 ? `${defense?.title}已過` : `距離${defense?.title ?? '學位口試'}`}
      </p>
      {days !== null ? (
        <p className="countdown-number">
          <span className="num">{Math.abs(days)}</span>
          <span className="unit">天</span>
        </p>
      ) : (
        <button className="countdown-empty" onClick={onSetDate}>
          設定口試日期
        </button>
      )}
      {defense?.due_date && <p className="countdown-date">{shortDate(defense.due_date)}</p>}

      <ol className="track" aria-label={`已完成 ${done} 個里程碑，共 ${milestones.length} 個`}>
        {milestones.map((m) => (
          <li key={m.id} className={m.done ? 'done' : m === next ? 'next' : ''} title={m.title} />
        ))}
      </ol>
      <p className="track-caption">
        已完成 {done}／{milestones.length}
        <br />
        下一步：{next ? next.title : '全部完成'}
      </p>
    </section>
  )
}
