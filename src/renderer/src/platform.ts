// Mac 的快捷鍵用 ⌘，Windows 用 Ctrl
export const IS_MAC = navigator.userAgent.includes('Mac OS X')

/** 快捷鍵的顯示文字，例如 shortcut('Z') → Ctrl+Z／⌘Z */
export const shortcut = (key: string): string => (IS_MAC ? `⌘${key}` : `Ctrl+${key}`)
