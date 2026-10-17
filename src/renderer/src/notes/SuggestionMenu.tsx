import type { SuggestionKeyDownProps, SuggestionProps } from '@tiptap/suggestion'
import { useEffect, useRef, useState, type ReactNode } from 'react'

// 輸入「/」或「@」時跳出的選單。TipTap 的 suggestion 外掛呼叫 render()，
// 這裡把它接到 React 的狀態，選單本身由 <SuggestionMenu> 畫出來。

export interface MenuItem {
  key: string
  label: string
  hint?: string
  icon?: ReactNode
}

interface MenuState {
  items: MenuItem[]
  index: number
  rect: DOMRect | null
  pick: (item: MenuItem) => void
}

export interface MenuController {
  set: (s: MenuState | null) => void
  get: () => MenuState | null
}

/** 給 suggestion 設定用的 render()：所有選單共用一個畫面上的位置 */
export function suggestionRender(ctrl: MenuController) {
  return () => {
    const show = (props: SuggestionProps<MenuItem>): void =>
      ctrl.set({
        items: props.items,
        index: 0,
        rect: props.clientRect?.() ?? null,
        pick: (item) => props.command(item)
      })
    return {
      onStart: show,
      onUpdate: show,
      onKeyDown: ({ event }: SuggestionKeyDownProps): boolean => {
        const s = ctrl.get()
        if (!s || s.items.length === 0) return false
        if (event.isComposing) return false
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          const step = event.key === 'ArrowDown' ? 1 : -1
          ctrl.set({ ...s, index: (s.index + step + s.items.length) % s.items.length })
          return true
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          s.pick(s.items[s.index])
          return true
        }
        if (event.key === 'Escape') {
          ctrl.set(null)
          return true
        }
        return false
      },
      onExit: () => ctrl.set(null)
    }
  }
}

export function useMenuController(): [MenuState | null, MenuController] {
  const [state, setState] = useState<MenuState | null>(null)
  const ref = useRef<MenuState | null>(null)
  const ctrl = useRef<MenuController>({
    set: (s) => {
      ref.current = s
      setState(s)
    },
    get: () => ref.current
  })
  return [state, ctrl.current]
}

export function SuggestionMenu({ state, empty }: { state: MenuState | null; empty: string }) {
  const list = useRef<HTMLUListElement>(null)
  useEffect(() => {
    list.current?.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' })
  }, [state?.index])
  if (!state?.rect) return null
  const top = Math.min(state.rect.bottom + 4, window.innerHeight - 260)
  return (
    <ul ref={list} className="note-menu" role="listbox" style={{ left: state.rect.left, top }}>
      {state.items.length === 0 && <li className="note-menu-empty">{empty}</li>}
      {state.items.map((item, i) => (
        <li
          key={item.key}
          role="option"
          aria-selected={i === state.index}
          className={i === state.index ? 'is-active' : ''}
          // mousedown 才不會讓編輯器先失去焦點
          onMouseDown={(e) => {
            e.preventDefault()
            state.pick(item)
          }}
        >
          {item.icon && <span className="note-menu-icon">{item.icon}</span>}
          <span className="note-menu-label">{item.label}</span>
          {item.hint && <span className="note-menu-hint">{item.hint}</span>}
        </li>
      ))}
    </ul>
  )
}
