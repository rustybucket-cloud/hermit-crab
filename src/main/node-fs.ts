import { shell } from 'electron'
import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { LibraryFs } from '../shared/library'

/** Turn a permission error into one that says how to fix it; macOS privacy settings can block the library. */
function explainAccess(err: unknown, dir: string): unknown {
  const code = (err as NodeJS.ErrnoException).code
  if (code !== 'EPERM' && code !== 'EACCES') return err
  const fix =
    process.platform === 'darwin'
      ? 'Allow it under System Settings → Privacy & Security → Files & Folders, then reopen the app.'
      : "Check the folder's permissions."
  return new Error(`Hermit Crab isn't allowed to read “${dir}”. ${fix}`)
}

/** Write via a temp file + rename so a crash never leaves a half-written sheet. */
async function writeAtomic(file: string, content: string): Promise<void> {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(4).toString('hex')}.tmp`)
  await fs.writeFile(tmp, content, 'utf8')
  await fs.rename(tmp, file)
}

export const nodeFs: LibraryFs = {
  readText: (file) => fs.readFile(file, 'utf8'),
  writeText: writeAtomic,
  writeBytes: (file, data) => fs.writeFile(file, data),
  async readdir(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch((err) => {
      throw explainAccess(err, dir)
    })
    return entries.map((e) => ({ name: e.name, isFile: e.isFile(), isDirectory: e.isDirectory() }))
  },
  mtime: async (file) => (await fs.stat(file)).mtimeMs,
  async exists(file) {
    try {
      await fs.access(file)
      return true
    } catch {
      return false
    }
  },
  mkdir: async (dir, recursive = false) => void (await fs.mkdir(dir, { recursive })),
  rename: (from, to) => fs.rename(from, to),
  remove: (file) => fs.rm(file, { recursive: true, force: true }),
  trash: (file) => shell.trashItem(file)
}
