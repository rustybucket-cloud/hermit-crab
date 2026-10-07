// Builds the iOS app icons from assets/hermit-crab-foreground.png: the crab as big on the icon as it is on the
// macOS tile, on the sand colour, and on nothing for iOS's dark icons. Run with: npx electron scripts/ios-icons.cjs
const { app, BrowserWindow } = require('electron')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const assets = path.join(__dirname, '../assets')
const iconSet = path.join(__dirname, '../ios/App/App/Assets.xcassets/AppIcon.appiconset')

function compose(background) {
  const W = 1024
  // The foreground sits on an 824px tile in a 1024 canvas; iOS icons are all tile.
  const scale = 1024 / 824
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = W
  const ctx = canvas.getContext('2d')
  if (background) {
    ctx.fillStyle = background
    ctx.fillRect(0, 0, W, W)
  }
  ctx.translate(W / 2, W / 2)
  ctx.scale(scale, scale)
  ctx.drawImage(document.querySelector('img'), -W / 2, -W / 2, W, W)
  return canvas.toDataURL('image/png')
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false })
  const src = `data:image/png;base64,${fs.readFileSync(path.join(assets, 'hermit-crab-foreground.png')).toString('base64')}`
  await win.loadURL(`data:text/html,<img src="${src}">`)
  for (const [file, background] of [
    ['AppIcon-512@2x.png', '#F3E6D0'],
    ['AppIcon-dark.png', null]
  ]) {
    const url = await win.webContents.executeJavaScript(
      `document.querySelector('img').decode().then(() => (${compose})(${JSON.stringify(background)}))`
    )
    const out = path.join(iconSet, file)
    fs.writeFileSync(out, Buffer.from(url.split(',')[1], 'base64'))
    // The App Store turns down an app icon with an alpha channel, even an opaque one; a trip through JPEG drops it.
    if (background) {
      const jpeg = `${out}.jpg`
      execFileSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '100', out, '--out', jpeg])
      execFileSync('sips', ['-s', 'format', 'png', jpeg, '--out', out])
      fs.rmSync(jpeg)
    }
  }
  app.quit()
})
