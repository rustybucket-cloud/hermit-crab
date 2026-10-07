import { StatusBar, Style } from '@capacitor/status-bar'
import { createMobileApi, menuActions } from './api'
import { trackPointer } from './menu'
import { installLongPress, installShortcuts } from './touch'

window.hermit = createMobileApi()
trackPointer()
installLongPress()
installShortcuts(menuActions.emit)
followTheme()

/** Keep the status bar's text readable on the theme's background, light or dark. */
function followTheme(): void {
  let last: Style | null = null
  const update = () => {
    const [r, g, b] = (getComputedStyle(document.body).backgroundColor.match(/[\d.]+/g) ?? ['255', '255', '255']).map(Number)
    const style = 0.299 * r + 0.587 * g + 0.114 * b < 140 ? Style.Dark : Style.Light
    if (style === last) return
    last = style
    void StatusBar.setStyle({ style }).catch(() => {})
  }
  // Themes set their colours on the root element.
  new MutationObserver(update).observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] })
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => window.setTimeout(update))
  window.addEventListener('DOMContentLoaded', update)
}
