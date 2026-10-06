import { BrowserWindow, dialog } from 'electron'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { marked } from 'marked'
import { fountainToHtml } from '../shared/fountain'
import type { ExportFormat } from '../shared/types'
import type { CompiledDocument } from './library'

const FILTERS: Record<ExportFormat, Electron.FileFilter> = {
  md: { name: 'Markdown', extensions: ['md'] },
  fountain: { name: 'Fountain', extensions: ['fountain'] },
  html: { name: 'HTML', extensions: ['html'] },
  pdf: { name: 'PDF', extensions: ['pdf'] }
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

function toHtml(doc: CompiledDocument): string {
  return doc.format === 'fountain' ? screenplayHtml(doc) : proseHtml(doc)
}

function proseHtml({ title, text }: CompiledDocument): string {
  const body = marked.parse(text, { async: false, gfm: true })
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

/**
 * Industry layout: 12pt Courier on US Letter, 1.5in left margin and 1in elsewhere.
 * Indents are measured from the left margin, at ten characters to the inch.
 */
function screenplayHtml({ title, text }: CompiledDocument): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light; }
  @page { size: letter; margin: 1in 1in 1in 1.5in; }
  body { font: 12pt/1 "Courier Prime", "Courier New", Courier, monospace; color: #000; margin: 0; }
  .screenplay { width: 6in; margin: 1in auto; }
  p, h3 { margin: 12pt 0 0; font: inherit; }
  .scene { text-transform: uppercase; break-after: avoid; display: flex; justify-content: space-between; }
  .scene-number { padding-left: 2em; }
  .dialogue-block { break-inside: avoid; }
  .character { margin-left: 2.2in; break-after: avoid; }
  .parenthetical { margin: 0 0 0 1.6in; width: 2in; }
  .dialogue { margin: 0 0 0 1in; width: 3.5in; }
  .transition { text-align: right; text-transform: uppercase; }
  .centered { text-align: center; }
  .lyric { font-style: italic; }
  .page-break { border: none; margin: 0; break-after: page; }
  .title-page { height: 9in; display: flex; flex-direction: column; justify-content: space-between; break-after: page; }
  .title-page-main { margin-top: 3in; text-align: center; }
  .title-page-main .title { text-transform: uppercase; text-decoration: underline; }
  .title-page-extra p { margin-top: 0; }
  @media print { .screenplay { margin: 0; } }
</style>
</head>
<body>
<div class="screenplay">
${fountainToHtml(text)}
</div>
</body>
</html>
`
}

async function renderPdf(html: string, screenplay: boolean): Promise<Buffer> {
  const tmp = path.join(os.tmpdir(), `hermit-crab-export-${process.pid}-${Date.now()}.html`)
  await fs.writeFile(tmp, html, 'utf8')
  const win = new BrowserWindow({
    show: false,
    webPreferences: { javascript: false, sandbox: true, contextIsolation: true }
  })
  try {
    await win.loadFile(tmp)
    return await win.webContents.printToPDF(
      screenplay
        ? { pageSize: 'Letter', printBackground: true, margins: { top: 1, bottom: 1, left: 1.5, right: 1 } }
        : { printBackground: true, margins: { top: 0.8, bottom: 0.8, left: 0.8, right: 0.8 } }
    )
  } finally {
    win.destroy()
    await fs.rm(tmp, { force: true })
  }
}

export async function exportDocument(
  parent: BrowserWindow | null,
  doc: CompiledDocument,
  format: ExportFormat
): Promise<string | null> {
  // Text exports keep the document's own format, whichever was asked for.
  if (format === 'md' || format === 'fountain') format = doc.format === 'fountain' ? 'fountain' : 'md'
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

  if (format === 'md' || format === 'fountain') await fs.writeFile(filePath, doc.text, 'utf8')
  else if (format === 'html') await fs.writeFile(filePath, toHtml(doc), 'utf8')
  else await fs.writeFile(filePath, await renderPdf(toHtml(doc), doc.format === 'fountain'))
  return filePath
}
