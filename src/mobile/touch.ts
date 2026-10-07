import { Haptics, ImpactStyle } from '@capacitor/haptics'
import type { MenuAction } from '../shared/types'

/**
 * Touching and holding stands in for a right-click: it sends the same `contextmenu` event, so the page's
 * context menus open the same way they do on the desktop. Text being edited keeps iOS's own long-press.
 */
export function installLongPress(): void {
  const HOLD = 450
  const SLOP = 10
  let timer = 0
  let start: { x: number; y: number } | null = null
  let fired = false

  const cancel = () => {
    window.clearTimeout(timer)
    timer = 0
    start = null
  }

  document.addEventListener(
    'touchstart',
    (e) => {
      fired = false
      cancel()
      if (e.touches.length !== 1) return
      const target = e.target as Element
      if (target.closest('input, textarea, select, [contenteditable="true"], .cm-editor, .hc-menu-backdrop')) return
      const touch = e.touches[0]
      const at = { x: touch.clientX, y: touch.clientY }
      start = at
      timer = window.setTimeout(() => {
        timer = 0
        fired = true
        void Haptics.impact({ style: ImpactStyle.Medium }).catch(() => {})
        target.dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: at.x, clientY: at.y, view: window })
        )
      }, HOLD)
    },
    { passive: true }
  )

  document.addEventListener(
    'touchmove',
    (e) => {
      const touch = e.touches[0]
      if (start && touch && Math.hypot(touch.clientX - start.x, touch.clientY - start.y) > SLOP) cancel()
    },
    { passive: true }
  )

  // A hold that opened a menu isn't also a tap.
  document.addEventListener(
    'touchend',
    (e) => {
      cancel()
      if (fired && e.cancelable) e.preventDefault()
      fired = false
    },
    { passive: false }
  )
  document.addEventListener('touchcancel', cancel)
}

/** The Mac's menu shortcuts, for an iPad with a keyboard. Formatting and find are the editor's own. */
const SHORTCUTS: [string, { shift?: boolean; alt?: boolean }, MenuAction][] = [
  ['KeyN', {}, 'new-sheet'],
  ['KeyN', { alt: true }, 'new-canvas'],
  ['KeyN', { shift: true }, 'new-project'],
  ['KeyE', { shift: true }, 'export-sheet'],
  ['Comma', {}, 'open-settings'],
  ['KeyS', { alt: true }, 'sync-now'],
  ['Digit1', {}, 'toggle-library'],
  ['Digit2', {}, 'toggle-sheets'],
  ['Digit3', {}, 'toggle-section'],
  ['Backslash', {}, 'toggle-sidebars'],
  ['KeyP', { shift: true }, 'toggle-preview'],
  ['KeyF', { shift: true }, 'toggle-focus'],
  ['KeyT', { shift: true }, 'toggle-typewriter'],
  ['Equal', {}, 'font-bigger'],
  ['Equal', { shift: true }, 'font-bigger'],
  ['Minus', {}, 'font-smaller'],
  ['Digit0', {}, 'font-reset'],
  ['ArrowUp', { alt: true }, 'prev-sheet'],
  ['ArrowDown', { alt: true }, 'next-sheet']
]

export function installShortcuts(emit: (action: MenuAction) => void): void {
  document.addEventListener('keydown', (e) => {
    if (!e.metaKey || e.ctrlKey) return
    // Outside the editor, ⌘F has nothing else to do, so it opens the editor's search.
    if (e.code === 'KeyF' && !e.shiftKey && !e.altKey && !(e.target as Element).closest?.('.cm-editor')) {
      e.preventDefault()
      return emit('find')
    }
    const match = SHORTCUTS.find(
      ([code, mods]) => code === e.code && Boolean(mods.shift) === e.shiftKey && Boolean(mods.alt) === e.altKey
    )
    if (!match) return
    e.preventDefault()
    emit(match[2])
  })
}
