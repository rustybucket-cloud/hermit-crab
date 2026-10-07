import { BrowserWindow, dialog } from 'electron'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { documentHtml, exportFileName } from '../shared/export'
import type { CompiledDocument } from '../shared/library'
import type { ExportFormat } from '../shared/types'

const FILTERS: Record<ExportFormat, Electron.FileFilter> = {
  md: { name: 'Markdown', extensions: ['md'] },
  fountain: { name: 'Fountain', extensions: ['fountain'] },
  html: { name: 'HTML', extensions: ['html'] },
  pdf: { name: 'PDF', extensions: ['pdf'] }
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
  const options: Electron.SaveDialogOptions = {
    title: 'Export',
    defaultPath: exportFileName(doc, format),
    filters: [FILTERS[format]]
  }
  const { canceled, filePath } = parent
    ? await dialog.showSaveDialog(parent, options)
    : await dialog.showSaveDialog(options)
  if (canceled || !filePath) return null

  if (format === 'md' || format === 'fountain') await fs.writeFile(filePath, doc.text, 'utf8')
  else if (format === 'html') await fs.writeFile(filePath, documentHtml(doc), 'utf8')
  else await fs.writeFile(filePath, await renderPdf(documentHtml(doc), doc.format === 'fountain'))
  return filePath
}
