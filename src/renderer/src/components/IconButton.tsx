import type { LucideIcon } from 'lucide-react'

/** 只有圖示的按鈕；滑鼠停留時顯示說明，螢幕閱讀器也讀得到 */
export function IconButton({
  icon: Icon,
  label,
  onClick,
  disabled,
  active,
  danger,
  type = 'button'
}: {
  icon: LucideIcon
  label: string
  onClick?: () => void
  disabled?: boolean
  active?: boolean
  danger?: boolean
  type?: 'button' | 'submit'
}) {
  return (
    <button
      type={type}
      className={`ibtn${active ? ' is-on' : ''}${danger ? ' is-danger' : ''}`}
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      aria-pressed={active}
    >
      <Icon size={18} strokeWidth={1.8} aria-hidden />
    </button>
  )
}
