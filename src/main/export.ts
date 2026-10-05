import { BrowserWindow, dialog } from 'electron'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { marked } from 'marked'
import type { ExportFormat } from '../shared/types'

const FILTERS: Record<ExportFormat, Electron.FileFilter> = {
  md: { name: 'Markdown', extensions: ['md'] },
  html: { name: 'HTML', extensions: ['html'] },
  pdf: { name: 'PDF', extensions: ['pdf'] }
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

function toHtml(title: string, markdown: string): string {
  const body = marked.parse(markdown, { async: false, gfm: true })
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light; }
  body {
    font: 17px/1.65 "Iowan Old Style", Charter, Georgia, serif;
    color: #1d1d1f; max-width: 38em; margin: 3em auto; padding: 0 1.5em;
  }
  h1, h2, h3, h4, h5, h6 { font-family: -apple-system, "Segoe UI", system-ui, sans-serif; line-height: 1.25; margin: 1.8em 0 .6em; }
  h1 { font-size: 2em; } h2 { font-size: 1.5em; } h3 { font-size: 1.2em; }
  a { color: #0e7490; }
  blockquote { margin: 1.2em 0; padding-left: 1em; border-left: 3px solid #cbd5e1; color: #475569; font-style: italic; }
  code { font: .88em "SF Mono", ui-monospace, Menlo, monospace; background: #f1f5f9; padding: .1em .3em; border-radius: 4px; }
  pre { background: #f1f5f9; padding: 1em; border-radius: 6px; overflow-x: auto; }
  pre code { background: none; padding: 0; }
  hr { border: none; text-align: center; margin: 2.5em 0; }
  hr::after { content: "⁂"; color: #94a3b8; }
  img { max-width: 100%; }
  table { border-collapse: collapse; } td, th { border: 1px solid #e2e8f0; padding: .35em .7em; }
  @media print { body { margin: 0; max-width: none; } a { color: inherit; } }
</style>
</head>
<body>
${body}
</body>
</html>
`
}

async function renderPdf(html: string): Promise<Buffer> {
  const tmp = path.join(os.tmpdir(), `hermit-crab-export-${process.pid}-${Date.now()}.html`)
  await fs.writeFile(tmp, html, 'utf8')
  const win = new BrowserWindow({
    show: false,
    webPreferences: { javascript: false, sandbox: true, contextIsolation: true }
  })
  try {
    await win.loadFile(tmp)
    return await win.webContents.printToPDF({
      printBackground: true,
      margins: { top: 0.8, bottom: 0.8, left: 0.8, right: 0.8 }
    })
  } finally {
    win.destroy()
    await fs.rm(tmp, { force: true })
  }
}

export async function exportDocument(
  parent: BrowserWindow | null,
  doc: { title: string; markdown: string },
  format: ExportFormat
): Promise<string | null> {
  const safeTitle = doc.title.replace(/[/\\:*?"<>|]/g, '-').slice(0, 80) || 'Untitled'
  const options: Electron.SaveDialogOptions = {
    title: 'Export',
    defaultPath: `${safeTitle}.${format}`,
    filters: [FILTERS[format]]
  }
  const { canceled, filePath } = parent
    ? await dialog.showSaveDialog(parent, options)
    : await dialog.showSaveDialog(options)
  if (canceled || !filePath) return null

  if (format === 'md') await fs.writeFile(filePath, doc.markdown, 'utf8')
  else if (format === 'html') await fs.writeFile(filePath, toHtml(doc.title, doc.markdown), 'utf8')
  else await fs.writeFile(filePath, await renderPdf(toHtml(doc.title, doc.markdown)))
  return filePath
}
