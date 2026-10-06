import { useEffect } from 'react'
import crabUrl from '../../../assets/hermit-crab-foreground.png'
import { resolveColors, useSystemDark, type ThemeSettings } from './theme'

// Layout of assets/hermit-crab.png on its 1024 canvas. The foreground is that icon with the tile keyed out,
// so it already sits in place and keeps its cream spiral.
const CANVAS = 1024
const TILE = { inset: 100, size: 824, exponent: 5 }
const SHADOW = { offsetY: 12, blur: 28, color: 'rgba(0, 0, 0, 0.3)' }
/** Rendered size; the dock never shows the icon larger than this. */
const OUTPUT = 512

let crab: Promise<HTMLImageElement> | null = null

function loadCrab(): Promise<HTMLImageElement> {
  crab ??= new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = crabUrl
  })
  return crab
}

/** The macOS-style superellipse tile, centred on the canvas. */
function tilePath(): Path2D {
  const path = new Path2D()
  const r = TILE.size / 2
  const c = TILE.inset + r
  const e = 2 / TILE.exponent
  const steps = 256
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * Math.PI * 2
    const cos = Math.cos(t)
    const sin = Math.sin(t)
    const x = c + r * Math.sign(cos) * Math.abs(cos) ** e
    const y = c + r * Math.sign(sin) * Math.abs(sin) ** e
    if (i === 0) path.moveTo(x, y)
    else path.lineTo(x, y)
  }
  path.closePath()
  return path
}

/** The app icon as a PNG data URL, with the tile filled in `background`. */
async function renderIcon(background: string): Promise<string> {
  const img = await loadCrab()
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = OUTPUT
  const ctx = canvas.getContext('2d')!
  const scale = OUTPUT / CANVAS
  ctx.scale(scale, scale)

  ctx.save()
  // Canvas shadows ignore the transform, so scale them by hand.
  ctx.shadowOffsetY = SHADOW.offsetY * scale
  ctx.shadowBlur = SHADOW.blur * scale
  ctx.shadowColor = SHADOW.color
  ctx.fillStyle = background
  ctx.fill(tilePath())
  ctx.restore()

  ctx.drawImage(img, 0, 0, CANVAS, CANVAS)
  return canvas.toDataURL('image/png')
}

/** Keeps the dock / window icon's tile in the theme's sheet-list colour. */
export function useThemedIcon(theme: ThemeSettings): void {
  const systemDark = useSystemDark()
  const background = resolveColors(theme, systemDark).sheets

  useEffect(() => {
    let cancelled = false
    // Debounced so dragging a colour picker doesn't re-render the icon on every step.
    const timer = window.setTimeout(() => {
      renderIcon(background)
        .then((url) => !cancelled && window.hermit.setAppIcon(url))
        .catch(() => {})
    }, 150)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [background])
}
