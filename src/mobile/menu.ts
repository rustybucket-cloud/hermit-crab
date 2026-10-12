import type { ContextMenuEntry } from '../shared/types'

/**
 * Menus for touch: an action sheet from the bottom of the screen on a phone, or a popover beside what was
 * touched on an iPad. They stand in for the desktop's native context menus and confirmation dialogs.
 */

export interface MenuOptions {
  title?: string
  message?: string
  /** Where to show a popover, in window coordinates. Without it, it shows where the screen was last touched. */
  at?: { x: number; y: number }
  /** Ids of items to show in red, for actions that destroy something. */
  destructive?: string[]
  /** The label of a phone sheet's Cancel button, such as Done when the sheet is mostly there to be read. */
  dismiss?: string
}

let lastPoint: { x: number; y: number } | null = null
let open: (() => void) | null = null

/** Remember where the screen was last touched, so a menu can show there. */
export function trackPointer(): void {
  const remember = (e: PointerEvent | MouseEvent) => {
    lastPoint = { x: e.clientX, y: e.clientY }
  }
  document.addEventListener('pointerdown', remember, true)
  document.addEventListener('contextmenu', remember, true)
}

/** Phones get sheets; anything wider gets popovers. */
const compact = () => window.matchMedia('(max-width: 700px)').matches

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) {
  const el = document.createElement(tag)
  el.className = className
  if (text) el.textContent = text
  return el
}

/** Resolves with the id of the chosen item, or null if the menu was dismissed. */
export function showMenu(entries: ContextMenuEntry[], options: MenuOptions = {}): Promise<string | null> {
  open?.()
  const asSheet = compact()
  return new Promise((resolve) => {
    const backdrop = element('div', `hc-menu-backdrop${asSheet ? ' sheet' : ''}`)
    const menu = element('div', `hc-menu ${asSheet ? 'sheet' : 'popover'}`)
    menu.setAttribute('role', 'menu')
    const panel = element('div', 'hc-menu-panel')

    if (options.title || options.message) {
      const header = element('div', 'hc-menu-header')
      if (options.title) header.append(element('div', 'hc-menu-title', options.title))
      if (options.message) header.append(element('div', 'hc-menu-message', options.message))
      panel.append(header)
    }

    let finished = false
    const finish = (choice: string | null) => {
      if (finished) return
      finished = true
      open = null
      document.removeEventListener('keydown', onKey, true)
      backdrop.classList.remove('shown')
      // Let the closing animation play, but answer straight away.
      window.setTimeout(() => backdrop.remove(), 200)
      resolve(choice)
    }

    let group = element('div', 'hc-menu-group')
    for (const entry of entries) {
      if ('type' in entry) {
        if (group.childElementCount) panel.append(group)
        group = element('div', 'hc-menu-group')
        continue
      }
      const item = element('button', 'hc-menu-item', entry.label)
      item.setAttribute('role', 'menuitem')
      if (options.destructive?.includes(entry.id)) item.classList.add('destructive')
      if (entry.enabled === false) item.disabled = true
      item.addEventListener('click', (e) => {
        e.stopPropagation()
        finish(entry.id)
      })
      group.append(item)
    }
    if (group.childElementCount) panel.append(group)
    menu.append(panel)

    if (asSheet) {
      const cancel = element('button', 'hc-menu-item hc-menu-cancel', options.dismiss ?? 'Cancel')
      cancel.addEventListener('click', (e) => {
        e.stopPropagation()
        finish(null)
      })
      menu.append(cancel)
    }

    backdrop.append(menu)
    // Touches on the backdrop dismiss the menu without reaching what's underneath.
    backdrop.addEventListener('pointerdown', (e) => {
      if (e.target === backdrop) {
        e.preventDefault()
        finish(null)
      }
    })
    backdrop.addEventListener('contextmenu', (e) => e.preventDefault())
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        finish(null)
      }
    }
    document.addEventListener('keydown', onKey, true)
    document.body.append(backdrop)

    if (!asSheet) place(menu, options.at ?? lastPoint)
    open = () => finish(null)
    requestAnimationFrame(() => backdrop.classList.add('shown'))
  })
}

/** Put a popover beside the point, kept inside the window. */
function place(menu: HTMLElement, at: { x: number; y: number } | null): void {
  const margin = 12
  const width = menu.offsetWidth
  const height = menu.offsetHeight
  const point = at ?? { x: window.innerWidth / 2 - width / 2, y: window.innerHeight / 2 - height / 2 }
  const x = Math.min(Math.max(margin, point.x), window.innerWidth - width - margin)
  // Below the point if it fits, otherwise above it.
  const below = point.y + 8
  const y = below + height + margin <= window.innerHeight ? below : Math.max(margin, point.y - height - 8)
  menu.style.left = `${x}px`
  menu.style.top = `${y}px`
}

/** Ask before doing something that can't be undone. Resolves with whether to go ahead. */
export async function confirmAction(title: string, message: string, action: string): Promise<boolean> {
  return (await showMenu([{ id: 'ok', label: action }], { title, message, destructive: ['ok'] })) === 'ok'
}
