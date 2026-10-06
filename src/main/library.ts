import { shell } from 'electron'
import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type {
  Outline,
  OutlineItem,
  OutlineTarget,
  ProjectSummary,
  Sheet,
  SheetPlace,
  SheetSummary
} from '../shared/types'
import { countWords, summarize } from '../shared/text'
import {
  canvasText,
  canvasTitle,
  CANVAS_EXT,
  EMPTY_CANVAS,
  isCanvasId,
  parseCanvas,
  relinkCanvas,
  serializeCanvas,
  sheetFile,
  summarizeCanvas
} from '../shared/canvas'

/**
 * A library is a plain folder. Every sub-folder is a project and every `.md`
 * file inside a project is a sheet, so everything stays readable outside the app.
 * Projects can be grouped into folders, which nest; a folder of projects is marked
 * by a hidden `.hermit-folder` file, and a project's id is its path in the library.
 *
 * A project has two sections. Its content lives at the top of the project folder
 * and its notes in a `Notes` folder. Any folder inside either is a subsection, and
 * subsections nest. A sheet's id is its path within the project without `.md`:
 * `Part One/<name>`, say, or `Notes/Characters/<name>`.
 *
 * The order of sheets and subsections lives in a small hidden `.hermit.json` per
 * project, as one list of sheet ids and folder paths (which end in `/`). Keeping
 * folders in the list also keeps empty subsections, which git drops, across a sync.
 *
 * Notes can also be canvases: `.canvas` files in the JSON Canvas format. A canvas is
 * named after its file, so its id keeps the extension: `Notes/Plot.canvas`. Images
 * placed on a canvas are copied into the project's `Attachments` folder.
 */

const META_FILE = '.hermit.json'
const FOLDER_MARKER = '.hermit-folder'
const NOTES_DIR = 'Notes'
const ATTACHMENTS_DIR = 'Attachments'
/** Folders at the top of a project that aren't content subsections. */
const RESERVED_DIRS = [NOTES_DIR, ATTACHMENTS_DIR]

interface ProjectMeta {
  order: string[]
}

function assertSafeName(name: string): void {
  if (!name || name.startsWith('.') || /[/\\]/.test(name) || name.includes('\0')) {
    throw new Error(`Invalid name: ${name}`)
  }
}

export function sanitizeName(name: string, fallback = 'Untitled Project'): string {
  const clean = name
    .replace(/[/\\:*?"<>|\0]/g, '-')
    .replace(/^\.+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100)
  return clean || fallback
}

const join = (...parts: (string | null)[]) => parts.filter(Boolean).join('/')

/** The parent of a slash-separated path, or null at the top. */
function parentPath(p: string): string | null {
  const i = p.lastIndexOf('/')
  return i === -1 ? null : p.slice(0, i)
}

const lastSegment = (p: string) => p.slice(p.lastIndexOf('/') + 1)

/** A folder's path within the project: '' for the content, `Notes` for the notes, or a subsection's folder. */
function folderOf(place: SheetPlace): string {
  return join(place.section === 'notes' ? NOTES_DIR : null, place.subsection)
}

function placeOfFolder(folder: string): SheetPlace {
  const parts = folder ? folder.split('/') : []
  parts.forEach(assertSafeName)
  if (parts[0] === NOTES_DIR) return { section: 'notes', subsection: parts.slice(1).join('/') || null }
  return { section: 'content', subsection: folder || null }
}

/** Where a sheet lives, and its file name without `.md`. */
function locate(sheetId: string): SheetPlace & { name: string } {
  const name = lastSegment(sheetId)
  assertSafeName(name)
  return { ...placeOfFolder(parentPath(sheetId) ?? ''), name }
}

const sheetIdIn = (place: SheetPlace, name: string) => join(folderOf(place), name)

function newSheetId(place: SheetPlace): string {
  return sheetIdIn(place, `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`)
}

const isNotesFolder = (folder: string) => folder.split('/')[0] === NOTES_DIR

const samePlace = (a: SheetPlace, b: SheetPlace) => a.section === b.section && a.subsection === b.subsection

/** An item's entry in the project's order list. Folders end in `/` so they never clash with sheets. */
const keyOf = (item: OutlineItem) => (item.kind === 'sheet' ? item.id : `${folderOf(item)}/`)

/** The section or subsection an item sits in. */
function parentOf(item: OutlineItem): SheetPlace {
  if (item.kind === 'sheet') return locate(item.id)
  return { section: item.section, subsection: parentPath(item.subsection) }
}

/** Whether `place` is the subsection `folder`, or inside it. */
const within = (place: SheetPlace, folder: SheetPlace) =>
  place.section === folder.section &&
  folder.subsection !== null &&
  (place.subsection === folder.subsection || Boolean(place.subsection?.startsWith(`${folder.subsection}/`)))

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

/** Write via a temp file + rename so a crash never leaves a half-written sheet. */
async function writeAtomic(file: string, content: string): Promise<void> {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(4).toString('hex')}.tmp`)
  await fs.writeFile(tmp, content, 'utf8')
  await fs.rename(tmp, file)
}

function toSummary(id: string, content: string, updatedAt: number): SheetSummary {
  const { section, subsection } = locate(id)
  if (isCanvasId(id)) return { id, section, subsection, title: canvasTitle(id), ...summarizeCanvas(content), updatedAt }
  const { title, excerpt } = summarize(content)
  return { id, section, subsection, title, excerpt, wordCount: countWords(content), updatedAt }
}

/** The text search looks through: a canvas's cards, or a sheet's Markdown. */
function searchableText(id: string, content: string): string {
  if (!isCanvasId(id)) return content
  try {
    return `${canvasTitle(id)}\n${canvasText(parseCanvas(content))}`
  } catch {
    return content
  }
}

interface Folder {
  path: string
  sheets: SheetSummary[]
  folders: Folder[]
}

/** An outline, plus its order list: every sheet id and folder key, in reading order. */
type ScannedOutline = Outline & { keys: string[] }

export class Library {
  constructor(public readonly root: string) {}

  async ensure(): Promise<boolean> {
    const existed = await exists(this.root)
    await fs.mkdir(this.root, { recursive: true })
    return existed
  }

  /** A project's or folder's directory, from its path in the library. */
  private libraryDir(libraryPath: string): string {
    const parts = libraryPath.split('/')
    parts.forEach(assertSafeName)
    return path.join(this.root, ...parts)
  }

  private projectDir(projectId: string): string {
    return this.libraryDir(projectId)
  }

  private folderDir(projectId: string, folder: string): string {
    return path.join(this.projectDir(projectId), ...(folder ? folder.split('/') : []))
  }

  private placeDir(projectId: string, place: SheetPlace): string {
    const folder = folderOf(place)
    // A content subsection called Notes would be the notes folder.
    if (place.section === 'content' && RESERVED_DIRS.includes(folder.split('/')[0])) {
      throw new Error(`Invalid subsection: ${folder}`)
    }
    placeOfFolder(folder)
    return this.folderDir(projectId, folder)
  }

  private sheetPath(projectId: string, sheetId: string): string {
    locate(sheetId)
    return path.join(this.projectDir(projectId), sheetFile(sheetId))
  }

  /** An id like `sheetId`, in `place`, that no file is using. Canvases keep their name, numbered. */
  private async freeSheetId(projectId: string, place: SheetPlace, sheetId: string): Promise<string> {
    const name = locate(sheetId).name
    let target = sheetIdIn(place, name)
    if (!isCanvasId(sheetId)) {
      while (await exists(this.sheetPath(projectId, target))) target = newSheetId(place)
      return target
    }
    const base = name.slice(0, -CANVAS_EXT.length)
    for (let n = 2; await exists(this.sheetPath(projectId, target)); n++) target = sheetIdIn(place, `${base} ${n}${CANVAS_EXT}`)
    return target
  }

  private async readMeta(projectId: string): Promise<ProjectMeta> {
    try {
      const raw = await fs.readFile(path.join(this.projectDir(projectId), META_FILE), 'utf8')
      const meta = JSON.parse(raw) as Partial<ProjectMeta>
      return { order: Array.isArray(meta.order) ? meta.order.filter((x) => typeof x === 'string') : [] }
    } catch {
      return { order: [] }
    }
  }

  private async writeMeta(projectId: string, meta: ProjectMeta): Promise<void> {
    await writeAtomic(path.join(this.projectDir(projectId), META_FILE), JSON.stringify(meta, null, 2))
  }

  /** A path for `name` inside `folder` that nothing else is using. `except` is the item's own current name. */
  private async uniqueLibraryPath(folder: string | null, name: string, fallback: string, except?: string): Promise<string> {
    const base = sanitizeName(name, fallback)
    let candidate = base
    const isSelf = (c: string) => c.toLowerCase() === except?.toLowerCase()
    for (let n = 2; !isSelf(candidate) && (await exists(this.libraryDir(join(folder, candidate)))); n++) {
      candidate = `${base} ${n}`
    }
    return join(folder, candidate)
  }

  // ── Projects and folders ──────────────────────────────────────────────────

  /** Every project and folder of projects, by path. */
  private async scanLibrary(): Promise<{ projects: string[]; folders: string[] }> {
    const found = { projects: [] as string[], folders: [] as string[] }
    const visit = async (folder: string | null): Promise<void> => {
      const dir = folder ? this.libraryDir(folder) : this.root
      const entries = await fs.readdir(dir, { withFileTypes: true })
      await Promise.all(
        entries
          .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
          .map(async (e) => {
            const child = join(folder, e.name)
            if (await exists(path.join(dir, e.name, FOLDER_MARKER))) {
              found.folders.push(child)
              await visit(child)
            } else {
              found.projects.push(child)
            }
          })
      )
    }
    await visit(null)
    return found
  }

  async listProjects(): Promise<ProjectSummary[]> {
    const projects = await Promise.all((await this.scanLibrary()).projects.map((id) => this.projectSummary(id)))
    return projects.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
  }

  async listFolders(): Promise<string[]> {
    return (await this.scanLibrary()).folders.sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
    )
  }

  async projectSummary(projectId: string): Promise<ProjectSummary> {
    const sheets = await this.listSheets(projectId)
    const content = sheets.filter((s) => s.section === 'content')
    const stat = await fs.stat(this.projectDir(projectId))
    return {
      id: projectId,
      name: lastSegment(projectId),
      folder: parentPath(projectId),
      sheetCount: content.length,
      wordCount: content.reduce((sum, s) => sum + s.wordCount, 0),
      updatedAt: Math.max(stat.mtimeMs, ...sheets.map((s) => s.updatedAt))
    }
  }

  async createProject(name: string, folder: string | null = null): Promise<ProjectSummary> {
    const id = await this.uniqueLibraryPath(folder, name, 'Untitled Project')
    await fs.mkdir(this.projectDir(id))
    await this.writeMeta(id, { order: [] })
    return this.projectSummary(id)
  }

  async renameProject(projectId: string, name: string): Promise<ProjectSummary> {
    const id = await this.uniqueLibraryPath(parentPath(projectId), name, 'Untitled Project', lastSegment(projectId))
    if (id !== projectId) await fs.rename(this.projectDir(projectId), this.projectDir(id))
    return this.projectSummary(id)
  }

  async createFolder(name: string, parent: string | null = null): Promise<string> {
    const folder = await this.uniqueLibraryPath(parent, name, 'Untitled Folder')
    await fs.mkdir(this.libraryDir(folder))
    await fs.writeFile(path.join(this.libraryDir(folder), FOLDER_MARKER), '')
    return folder
  }

  /** Rename a folder, which changes the ids of every project in it. Returns its new path. */
  async renameFolder(folder: string, name: string): Promise<string> {
    const next = await this.uniqueLibraryPath(parentPath(folder), name, 'Untitled Folder', lastSegment(folder))
    if (next !== folder) await fs.rename(this.libraryDir(folder), this.libraryDir(next))
    return next
  }

  /** Moves the folder and every project in it to the trash. */
  async deleteFolder(folder: string): Promise<void> {
    await shell.trashItem(this.libraryDir(folder))
  }

  /** Move a project or folder into another folder, or to the top of the library with null. Returns its new path. */
  async moveInLibrary(libraryPath: string, folder: string | null): Promise<string> {
    if (folder === libraryPath || folder?.startsWith(`${libraryPath}/`)) throw new Error('A folder can’t go inside itself.')
    if (parentPath(libraryPath) === folder) return libraryPath
    const name = lastSegment(libraryPath)
    const target = await this.uniqueLibraryPath(folder, name, name)
    await fs.rename(this.libraryDir(libraryPath), this.libraryDir(target))
    return target
  }

  async deleteProject(projectId: string): Promise<void> {
    await shell.trashItem(this.projectDir(projectId))
  }

  revealProject(projectId: string): void {
    shell.showItemInFolder(this.projectDir(projectId))
  }

  // ── Outline ───────────────────────────────────────────────────────────────

  /** Read a folder and every subsection below it. */
  private async readFolder(projectId: string, folder: string, found: Map<string, Folder>): Promise<Folder> {
    const node: Folder = { path: folder, sheets: [], folders: [] }
    found.set(folder, node)
    const dir = this.folderDir(projectId, folder)
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch((err: NodeJS.ErrnoException) => {
      // The notes folder appears only once something is put in it.
      if (err.code === 'ENOENT' && folder) return []
      throw err
    })
    // Canvases belong with the notes; the content is only Markdown.
    const isSheet = (name: string) => name.endsWith('.md') || (isNotesFolder(folder) && name.endsWith(CANVAS_EXT))
    const files = entries.filter((e) => e.isFile() && isSheet(e.name) && !e.name.startsWith('.'))
    const dirs = entries.filter(
      (e) => e.isDirectory() && !e.name.startsWith('.') && (folder || !RESERVED_DIRS.includes(e.name))
    )
    ;[node.sheets, node.folders] = await Promise.all([
      Promise.all(
        files.map(async (e) => {
          const file = path.join(dir, e.name)
          const [content, stat] = await Promise.all([fs.readFile(file, 'utf8'), fs.stat(file)])
          const name = e.name.endsWith('.md') ? e.name.slice(0, -3) : e.name
          return toSummary(join(folder, name), content, stat.mtimeMs)
        })
      ),
      Promise.all(dirs.map((e) => this.readFolder(projectId, join(folder, e.name), found)))
    ])
    return node
  }

  /** Both sections, every sheet and subsection, in reading order. */
  private async scan(projectId: string): Promise<ScannedOutline> {
    const found = new Map<string, Folder>()
    const [content, notes, meta] = await Promise.all([
      this.readFolder(projectId, '', found),
      this.readFolder(projectId, NOTES_DIR, found),
      this.readMeta(projectId)
    ])

    // Subsections listed in the order but missing on disk are empty ones a sync dropped.
    const ensure = (folder: string): Folder => {
      const known = found.get(folder)
      if (known) return known
      const node: Folder = { path: folder, sheets: [], folders: [] }
      ensure(parentPath(folder) ?? '').folders.push(node)
      found.set(folder, node)
      return node
    }
    for (const key of meta.order.filter((k) => k.endsWith('/'))) {
      try {
        if (folderOf(placeOfFolder(key.slice(0, -1))) === key.slice(0, -1)) ensure(key.slice(0, -1))
      } catch {
        // Not a usable folder name; ignore it.
      }
    }

    // Ordered items first; anything added outside the app goes last: sheets oldest first, then folders by name.
    const rank = new Map(meta.order.map((key, i) => [key, i]))
    const outline: ScannedOutline = { sheets: [], items: [], keys: [] }
    const visit = (folder: Folder) => {
      const children = [
        ...folder.sheets.map((sheet) => ({ key: sheet.id, sheet, folder: undefined })),
        ...folder.folders.map((sub) => ({ key: `${sub.path}/`, sheet: undefined, folder: sub }))
      ].sort((a, b) => {
        const ra = rank.get(a.key) ?? Infinity
        const rb = rank.get(b.key) ?? Infinity
        if (ra !== rb) return ra - rb
        if (a.sheet && b.sheet) return a.sheet.updatedAt - b.sheet.updatedAt
        if (a.sheet || b.sheet) return a.sheet ? -1 : 1
        return a.key.localeCompare(b.key, undefined, { numeric: true, sensitivity: 'base' })
      })
      for (const child of children) {
        outline.keys.push(child.key)
        if (child.sheet) {
          outline.sheets.push(child.sheet)
          const { id, section, subsection } = child.sheet
          outline.items.push({ kind: 'sheet', id, section, subsection })
        } else if (child.folder) {
          const place = placeOfFolder(child.folder.path)
          outline.items.push({ kind: 'subsection', section: place.section, subsection: place.subsection! })
          visit(child.folder)
        }
      }
    }
    visit(content)
    visit(notes)
    return outline
  }

  async listOutline(projectId: string): Promise<Outline> {
    const { sheets, items } = await this.scan(projectId)
    return { sheets, items }
  }

  /** Every sheet in the project, content then notes, in reading order. */
  async listSheets(projectId: string): Promise<SheetSummary[]> {
    return (await this.scan(projectId)).sheets
  }

  /** Move a sheet's file to another section or subsection. Returns its new id. */
  private async relocateSheet(projectId: string, sheetId: string, to: SheetPlace): Promise<string> {
    const from = locate(sheetId)
    if (samePlace(from, to)) return sheetId
    if (isCanvasId(sheetId) && to.section !== 'notes') throw new Error('Canvases live in the notes.')
    const target = await this.freeSheetId(projectId, to, sheetId)
    await fs.mkdir(this.placeDir(projectId, to), { recursive: true })
    await fs.rename(this.sheetPath(projectId, sheetId), this.sheetPath(projectId, target))
    return target
  }

  /** Move or rename a subsection's folder, rewriting the order list to match. */
  private async relocateFolder(
    projectId: string,
    from: SheetPlace,
    to: SheetPlace,
    keys: string[]
  ): Promise<{ keys: string[]; renamed: Record<string, string> }> {
    const fromDir = this.placeDir(projectId, from)
    const toDir = this.placeDir(projectId, to)
    if (await exists(fromDir)) {
      await fs.mkdir(path.dirname(toDir), { recursive: true })
      await fs.rename(fromDir, toDir)
    } else {
      await fs.mkdir(toDir, { recursive: true })
    }
    const fromPrefix = `${folderOf(from)}/`
    const toPrefix = `${folderOf(to)}/`
    const renamed: Record<string, string> = {}
    const moved = keys.map((key) => {
      if (!key.startsWith(fromPrefix)) return key
      const next = toPrefix + key.slice(fromPrefix.length)
      if (!key.endsWith('/')) renamed[key] = next
      return next
    })
    return { keys: moved, renamed }
  }

  /** A name for a subsection that no sibling already has. */
  private async uniqueSubsection(projectId: string, parent: SheetPlace, name: string, except?: string): Promise<string> {
    const base = sanitizeName(name, 'Untitled')
    const { items } = await this.scan(projectId)
    const taken = items.flatMap((i) =>
      i.kind === 'subsection' && samePlace(parentOf(i), parent) ? [lastSegment(i.subsection).toLowerCase()] : []
    )
    if (parent.section === 'content' && !parent.subsection) taken.push(...RESERVED_DIRS.map((d) => d.toLowerCase()))
    let candidate = base
    for (let n = 2; candidate.toLowerCase() !== except?.toLowerCase() && taken.includes(candidate.toLowerCase()); n++) {
      candidate = `${base} ${n}`
    }
    return candidate
  }

  /**
   * Move a sheet or subsection: next to another item, or to the end of a section or subsection.
   * Moving changes paths on disk, so this returns the sheet ids that changed, old to new.
   */
  async moveInOutline(projectId: string, item: OutlineItem, target: OutlineTarget): Promise<Record<string, string>> {
    const anchor = 'into' in target ? null : 'before' in target ? target.before : target.after
    const parent = anchor ? parentOf(anchor) : (target as { into: SheetPlace }).into
    if (anchor && keyOf(anchor) === keyOf(item)) return {}
    if (item.kind === 'subsection' && within(parent, item)) throw new Error('A subsection can’t go inside itself.')

    let { keys } = await this.scan(projectId)
    let renamed: Record<string, string> = {}
    let key = keyOf(item)
    if (!samePlace(parentOf(item), parent)) {
      if (item.kind === 'sheet') {
        key = await this.relocateSheet(projectId, item.id, parent)
        renamed = { [item.id]: key }
        keys = keys.map((k) => (k === item.id ? key : k))
      } else {
        const prefix = `${folderOf(item)}/`
        if (parent.section !== 'notes' && keys.some((k) => k.startsWith(prefix) && isCanvasId(k))) {
          throw new Error('Canvases live in the notes.')
        }
        const name = await this.uniqueSubsection(projectId, parent, lastSegment(item.subsection))
        const to = { section: parent.section, subsection: join(parent.subsection, name) }
        ;({ keys, renamed } = await this.relocateFolder(projectId, item, to, keys))
        key = `${folderOf(to)}/`
      }
    }

    // Siblings sort by their position in the list, so only this item's own entry needs to move.
    keys = keys.filter((k) => k !== key)
    if (!anchor) {
      keys.push(key)
    } else {
      const anchorKey = keyOf(anchor)
      let at = keys.indexOf(anchorKey)
      if ('after' in target) {
        // After a subsection means after everything in it.
        while (anchorKey.endsWith('/') && at + 1 < keys.length && keys[at + 1].startsWith(anchorKey)) at++
        at++
      }
      keys.splice(at, 0, key)
    }
    await this.writeMeta(projectId, { order: keys })
    await this.relinkCanvases(projectId, renamed)
    return renamed
  }

  // ── Sheets ────────────────────────────────────────────────────────────────

  async readSheet(projectId: string, sheetId: string): Promise<Sheet> {
    const file = this.sheetPath(projectId, sheetId)
    const [content, stat] = await Promise.all([fs.readFile(file, 'utf8'), fs.stat(file)])
    return { ...toSummary(sheetId, content, stat.mtimeMs), content }
  }

  async writeSheet(projectId: string, sheetId: string, content: string): Promise<SheetSummary> {
    await writeAtomic(this.sheetPath(projectId, sheetId), content)
    return toSummary(sheetId, content, Date.now())
  }

  /** Creates the sheet after `afterId`, or at the end of `place`. */
  async createSheet(
    projectId: string,
    content = '',
    afterId?: string,
    place: SheetPlace = { section: 'content', subsection: null }
  ): Promise<Sheet> {
    const id = newSheetId(place)
    await fs.mkdir(this.placeDir(projectId, place), { recursive: true })
    await writeAtomic(this.sheetPath(projectId, id), content)
    const keys = (await this.scan(projectId)).keys.filter((k) => k !== id)
    const at = afterId ? keys.indexOf(afterId) : -1
    const order = at === -1 ? [...keys, id] : [...keys.slice(0, at + 1), id, ...keys.slice(at + 1)]
    await this.writeMeta(projectId, { order })
    return this.readSheet(projectId, id)
  }

  async deleteSheet(projectId: string, sheetId: string): Promise<void> {
    await shell.trashItem(this.sheetPath(projectId, sheetId))
    const meta = await this.readMeta(projectId)
    await this.writeMeta(projectId, { order: meta.order.filter((id) => id !== sheetId) })
  }

  /** Move a sheet to another project, into the same section and subsection there. */
  async moveSheet(fromProject: string, sheetId: string, toProject: string): Promise<void> {
    if (fromProject === toProject) return
    const place = locate(sheetId)
    const target = await this.freeSheetId(toProject, place, sheetId)
    await fs.mkdir(this.placeDir(toProject, place), { recursive: true })
    await fs.rename(this.sheetPath(fromProject, sheetId), this.sheetPath(toProject, target))

    const from = await this.readMeta(fromProject)
    await this.writeMeta(fromProject, { order: from.order.filter((id) => id !== sheetId) })
    const to = await this.readMeta(toProject)
    await this.writeMeta(toProject, { order: [...to.order.filter((id) => id !== target), target] })
  }

  /** Returns ids of sheets whose content contains every word of the query. */
  async searchSheets(projectId: string, query: string): Promise<string[]> {
    const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean)
    if (!terms.length) return []
    const sheets = await this.listSheets(projectId)
    const hits = await Promise.all(
      sheets.map(async (s) => {
        const content = await fs.readFile(this.sheetPath(projectId, s.id), 'utf8')
        const text = searchableText(s.id, content).toLocaleLowerCase()
        return terms.every((t) => text.includes(t)) ? s.id : null
      })
    )
    return hits.filter((id): id is string => id !== null)
  }

  // ── Subsections ───────────────────────────────────────────────────────────

  /** Creates a subsection at the end of `parent`. Resolves with where it ended up. */
  async createSubsection(projectId: string, parent: SheetPlace, name: string): Promise<SheetPlace> {
    const unique = await this.uniqueSubsection(projectId, parent, name)
    const place = { section: parent.section, subsection: join(parent.subsection, unique) }
    await fs.mkdir(this.placeDir(projectId, place), { recursive: true })
    const { keys } = await this.scan(projectId)
    const key = `${folderOf(place)}/`
    await this.writeMeta(projectId, { order: [...keys.filter((k) => k !== key), key] })
    return place
  }

  /** Renaming changes the ids of the sheets inside; returns those that changed, old to new. */
  async renameSubsection(projectId: string, place: SheetPlace, name: string): Promise<Record<string, string>> {
    if (!place.subsection) throw new Error('Not a subsection.')
    const parent = { section: place.section, subsection: parentPath(place.subsection) }
    const current = lastSegment(place.subsection)
    const next = await this.uniqueSubsection(projectId, parent, name, current)
    if (next === current) return {}
    const to = { section: place.section, subsection: join(parent.subsection, next) }
    const { keys, renamed } = await this.relocateFolder(projectId, place, to, (await this.scan(projectId)).keys)
    await this.writeMeta(projectId, { order: keys })
    await this.relinkCanvases(projectId, renamed)
    return renamed
  }

  /** Moves the subsection, and everything in it, to the trash. */
  async deleteSubsection(projectId: string, place: SheetPlace): Promise<void> {
    if (!place.subsection) throw new Error('Not a subsection.')
    const dir = this.placeDir(projectId, place)
    if (await exists(dir)) await shell.trashItem(dir)
    const prefix = `${folderOf(place)}/`
    const meta = await this.readMeta(projectId)
    await this.writeMeta(projectId, { order: meta.order.filter((key) => !key.startsWith(prefix)) })
  }

  // ── Canvases ──────────────────────────────────────────────────────────────

  /** Creates a canvas after `afterId`, or at the end of `place`, which must be in the notes. */
  async createCanvas(
    projectId: string,
    place: SheetPlace,
    name = 'Untitled Canvas',
    content = EMPTY_CANVAS,
    afterId?: string
  ): Promise<Sheet> {
    if (place.section !== 'notes') throw new Error('Canvases live in the notes.')
    const id = await this.freeSheetId(projectId, place, sheetIdIn(place, `${sanitizeName(name, 'Untitled Canvas')}${CANVAS_EXT}`))
    await fs.mkdir(this.placeDir(projectId, place), { recursive: true })
    await writeAtomic(this.sheetPath(projectId, id), content)
    const keys = (await this.scan(projectId)).keys.filter((k) => k !== id)
    const at = afterId ? keys.indexOf(afterId) : -1
    const order = at === -1 ? [...keys, id] : [...keys.slice(0, at + 1), id, ...keys.slice(at + 1)]
    await this.writeMeta(projectId, { order })
    return this.readSheet(projectId, id)
  }

  /** A canvas is named by its file, so renaming changes its id. Returns the ids that changed, old to new. */
  async renameCanvas(projectId: string, sheetId: string, name: string): Promise<Record<string, string>> {
    if (!isCanvasId(sheetId)) throw new Error('Not a canvas.')
    const place = locate(sheetId)
    const wanted = sheetIdIn(place, `${sanitizeName(name, 'Untitled Canvas')}${CANVAS_EXT}`)
    if (wanted === sheetId) return {}
    // Renaming only the case of a name mustn't count the canvas as clashing with itself.
    const target =
      wanted.toLowerCase() === sheetId.toLowerCase() ? wanted : await this.freeSheetId(projectId, place, wanted)
    await fs.rename(this.sheetPath(projectId, sheetId), this.sheetPath(projectId, target))
    const meta = await this.readMeta(projectId)
    await this.writeMeta(projectId, { order: meta.order.map((k) => (k === sheetId ? target : k)) })
    const renamed = { [sheetId]: target }
    await this.relinkCanvases(projectId, renamed)
    return renamed
  }

  /** Keep the project's canvases pointing at sheets that moved. */
  private async relinkCanvases(projectId: string, renamed: Record<string, string>): Promise<void> {
    if (!Object.keys(renamed).length) return
    const canvases = (await this.listSheets(projectId)).filter((s) => isCanvasId(s.id))
    await Promise.all(
      canvases.map(async ({ id }) => {
        const file = this.sheetPath(projectId, id)
        try {
          const relinked = relinkCanvas(parseCanvas(await fs.readFile(file, 'utf8')), renamed)
          if (relinked) await writeAtomic(file, serializeCanvas(relinked))
        } catch {
          // A canvas that can't be read (mid-merge, say) is left as it is.
        }
      })
    )
  }

  /** Copy an image into the project's attachments. Returns its path within the project. */
  async saveAttachment(projectId: string, name: string, data: Uint8Array): Promise<string> {
    const dir = path.join(this.projectDir(projectId), ATTACHMENTS_DIR)
    await fs.mkdir(dir, { recursive: true })
    const clean = sanitizeName(name, 'Image')
    const dot = clean.lastIndexOf('.')
    const [base, ext] = dot > 0 ? [clean.slice(0, dot), clean.slice(dot)] : [clean, '']
    let file = clean
    for (let n = 2; await exists(path.join(dir, file)); n++) file = `${base} ${n}${ext}`
    await fs.writeFile(path.join(dir, file), data)
    return `${ATTACHMENTS_DIR}/${file}`
  }

  /** Glue sheets together in order, the way they'd read as one manuscript. Without ids, that's the project's content. */
  async compile(projectId: string, sheetIds?: string[]): Promise<{ title: string; markdown: string }> {
    const ids = sheetIds ?? (await this.listSheets(projectId)).filter((s) => s.section === 'content').map((s) => s.id)
    const parts = await Promise.all(ids.map((id) => fs.readFile(this.sheetPath(projectId, id), 'utf8')))
    const markdown = parts.map((p) => p.trim()).filter(Boolean).join('\n\n') + '\n'
    const title = sheetIds?.length === 1 ? summarize(parts[0]).title || 'Untitled' : lastSegment(projectId)
    return { title, markdown }
  }
}
