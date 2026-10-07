import { Share } from '@capacitor/share'
import { documentHtml, exportFileName } from '../shared/export'
import type { CompiledDocument } from '../shared/library'
import type { ExportFormat } from '../shared/types'
import { native } from './native'

/**
 * Write the export to a file of the app's own, then offer it to the share sheet, from which it can be saved to
 * Files, sent, or opened in another app. Resolves with the file's path, or null if sharing was cancelled.
 */
export async function exportDocument(doc: CompiledDocument, format: ExportFormat, folder: string): Promise<string | null> {
  // Text exports keep the document's own format, whichever was asked for.
  if (format === 'md' || format === 'fountain') format = doc.format === 'fountain' ? 'fountain' : 'md'
  // One export at a time: clear out the last one.
  await native.remove({ path: folder })
  await native.mkdir({ path: folder, recursive: true })
  const file = `${folder}/${exportFileName(doc, format)}`

  if (format === 'md' || format === 'fountain') {
    await native.writeFile({ path: file, data: doc.text, encoding: 'utf8' })
  } else if (format === 'html') {
    await native.writeFile({ path: file, data: documentHtml(doc), encoding: 'utf8' })
  } else {
    const screenplay = doc.format === 'fountain'
    const { path } = await native.printPdf({
      html: documentHtml(doc),
      // Screenplays are always on US Letter, with the industry's margins.
      paper: screenplay ? 'letter' : 'auto',
      margins: screenplay ? { top: 1, right: 1, bottom: 1, left: 1.5 } : { top: 0.8, right: 0.8, bottom: 0.8, left: 0.8 }
    })
    await native.rename({ from: path, to: file })
  }

  try {
    await Share.share({ title: doc.title, files: [`file://${file.split('/').map(encodeURIComponent).join('/')}`] })
  } catch {
    // Dismissing the share sheet rejects; that's not a failure.
    return null
  }
  return file
}
