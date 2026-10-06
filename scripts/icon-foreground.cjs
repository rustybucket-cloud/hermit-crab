// Builds assets/hermit-crab-foreground.png: assets/hermit-crab.png with its sand tile keyed out, so the
// renderer can redraw the tile in the theme's colour. Run with: npx electron scripts/icon-foreground.cjs
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const assets = path.join(__dirname, '../assets')

function keyOutTile() {
  const W = 1024
  // A sand point on the tile, and the edge of the shell where the spiral groove runs out into the tile.
  // The flood can't cross that segment, so the groove keeps its cream colour.
  const START = [200, 800]
  const SEAL = [
    [302, 341],
    [282, 357]
  ]
  const TOLERANCE = 24

  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = W
  const ctx = canvas.getContext('2d')
  ctx.drawImage(document.querySelector('img'), 0, 0)
  const d = ctx.getImageData(0, 0, W, W).data
  const at = (x, y) => (y * W + x) * 4
  const bgColor = [...d.subarray(at(...START), at(...START) + 3)]

  const nearSeal = (x, y) => {
    const [[ax, ay], [bx, by]] = SEAL
    const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)))
    return Math.hypot(x - (ax + t * (bx - ax)), y - (ay + t * (by - ay))) < 1.5
  }
  const isSand = (p) =>
    d[p * 4 + 3] >= 250 && Math.max(...bgColor.map((b, ch) => Math.abs(d[p * 4 + ch] - b))) <= TOLERANCE

  const bg = new Uint8Array(W * W)
  const stack = [START[1] * W + START[0]]
  bg[stack[0]] = 1
  while (stack.length) {
    const p = stack.pop()
    const x = p % W
    for (const q of [p - 1, p + 1, p - W, p + W]) {
      if (q < 0 || q >= W * W || Math.abs((q % W) - x) > 1 || bg[q]) continue
      if (isSand(q) && !nearSeal(q % W, (q / W) | 0)) {
        bg[q] = 1
        stack.push(q)
      }
    }
  }

  const nearBg = (p) => {
    const x = p % W
    const y = (p / W) | 0
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (bg[(y + dy) * W + x + dx]) return true
    return false
  }

  // Keep the crab as is; un-mix the sand out of its anti-aliased edge so it sits cleanly on any colour.
  const out = new Uint8ClampedArray(d.length)
  for (let p = 0; p < W * W; p++) {
    if (d[p * 4 + 3] < 250) continue // outside the tile
    if (!bg[p] && !nearBg(p)) {
      out.set(d.subarray(p * 4, p * 4 + 4), p * 4)
      continue
    }
    let a = 0
    for (let ch = 0; ch < 3; ch++) {
      const v = d[p * 4 + ch]
      const b = bgColor[ch]
      a = Math.max(a, v > b ? (v - b) / (255 - b) : (b - v) / b)
    }
    if (!bg[p] && a > 0.9) a = 1
    if (a < 0.04) continue
    for (let ch = 0; ch < 3; ch++) out[p * 4 + ch] = (d[p * 4 + ch] - (1 - a) * bgColor[ch]) / a
    out[p * 4 + 3] = a * 255
  }
  ctx.putImageData(new ImageData(out, W, W), 0, 0)
  return canvas.toDataURL('image/png')
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false })
  const src = `data:image/png;base64,${fs.readFileSync(path.join(assets, 'hermit-crab.png')).toString('base64')}`
  await win.loadURL(`data:text/html,<img src="${src}">`)
  const url = await win.webContents.executeJavaScript(
    `document.querySelector('img').decode().then(() => (${keyOutTile})())`
  )
  fs.writeFileSync(path.join(assets, 'hermit-crab-foreground.png'), Buffer.from(url.split(',')[1], 'base64'))
  app.quit()
})
