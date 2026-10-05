import { shell } from 'electron'
import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ProjectSummary, Sheet, SheetSummary } from '../shared/types'
import { countWords, summarize } from '../shared/text'

/**
 * A library is a plain folder. Every sub-folder is a project and every `.md`
 * file inside a project is a sheet, so everything stays readable outside the app.
 * Sheet ordering lives in a small hidden `.hermit.json` per project.
 */

const META_FILE = '.hermit.json'

interface ProjectMeta {
  order: string[]
}

function assertSafeName(name: string): void {
  if (!name || name.startsWith('.') || /[/\\]/.test(name) || name.includes('\0')) {
    throw new Error(`Invalid name: ${name}`)
  }
}

export function sanitizeProjectName(name: string): string {
  const clean = name
    .replace(/[/\\:*?"<>|\0]/g, '-')
    .replace(/^\.+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100)
  return clean || 'Untitled Project'
}

function newSheetId(): string {
  return `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
}

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
  const { title, excerpt } = summarize(content)
  return { id, title, excerpt, wordCount: countWords(content), updatedAt }
}

export class Library {
  constructor(public readonly root: string) {}

  async ensure(): Promise<boolean> {
    const existed = await exists(this.root)
    await fs.mkdir(this.root, { recursive: true })
    return existed
  }

  private projectDir(projectId: string): string {
    assertSafeName(projectId)
    return path.join(this.root, projectId)
  }

  private sheetPath(projectId: string, sheetId: string): string {
    assertSafeName(sheetId)
    return path.join(this.projectDir(projectId), `${sheetId}.md`)
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

  private async uniqueProjectId(name: string, except?: string): Promise<string> {
    const base = sanitizeProjectName(name)
    let candidate = base
    const isSelf = (c: string) => c.toLowerCase() === except?.toLowerCase()
    for (let n = 2; !isSelf(candidate) && (await exists(path.join(this.root, candidate))); n++) {
      candidate = `${base} ${n}`
    }
    return candidate
  }

  // ── Projects ──────────────────────────────────────────────────────────────

  async listProjects(): Promise<ProjectSummary[]> {
    const entries = await fs.readdir(this.root, { withFileTypes: true })
    const projects = await Promise.all(
      entries
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => this.projectSummary(e.name))
    )
    return projects.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
  }

  async projectSummary(projectId: string): Promise<ProjectSummary> {
    const sheets = await this.listSheets(projectId)
    const stat = await fs.stat(this.projectDir(projectId))
    return {
      id: projectId,
      name: projectId,
      sheetCount: sheets.length,
      wordCount: sheets.reduce((sum, s) => sum + s.wordCount, 0),
      updatedAt: Math.max(stat.mtimeMs, ...sheets.map((s) => s.updatedAt))
    }
  }

  async createProject(name: string): Promise<ProjectSummary> {
    const id = await this.uniqueProjectId(name)
    await fs.mkdir(this.projectDir(id))
    await this.writeMeta(id, { order: [] })
    return this.projectSummary(id)
  }

  async renameProject(projectId: string, name: string): Promise<ProjectSummary> {
    const id = await this.uniqueProjectId(name, projectId)
    if (id !== projectId) await fs.rename(this.projectDir(projectId), this.projectDir(id))
    return this.projectSummary(id)
  }

  async deleteProject(projectId: string): Promise<void> {
    await shell.trashItem(this.projectDir(projectId))
  }

  revealProject(projectId: string): void {
    shell.showItemInFolder(this.projectDir(projectId))
  }

  // ── Sheets ────────────────────────────────────────────────────────────────

  async listSheets(projectId: string): Promise<SheetSummary[]> {
    const dir = this.projectDir(projectId)
    const [entries, meta] = await Promise.all([fs.readdir(dir, { withFileTypes: true }), this.readMeta(projectId)])
    const files = entries.filter((e) => e.isFile() && e.name.endsWith('.md') && !e.name.startsWith('.'))

    const sheets = await Promise.all(
      files.map(async (e) => {
        const file = path.join(dir, e.name)
        const [content, stat] = await Promise.all([fs.readFile(file, 'utf8'), fs.stat(file)])
        return toSummary(e.name.slice(0, -3), content, stat.mtimeMs)
      })
    )

    // Explicitly ordered sheets first; files added outside the app go last, oldest first.
    const rank = new Map(meta.order.map((id, i) => [id, i]))
    return sheets.sort((a, b) => {
      const ra = rank.get(a.id) ?? Infinity
      const rb = rank.get(b.id) ?? Infinity
      return ra !== rb ? ra - rb : a.updatedAt - b.updatedAt
    })
  }

  async readSheet(projectId: string, sheetId: string): Promise<Sheet> {
    const file = this.sheetPath(projectId, sheetId)
    const [content, stat] = await Promise.all([fs.readFile(file, 'utf8'), fs.stat(file)])
    return { ...toSummary(sheetId, content, stat.mtimeMs), content }
  }

  async writeSheet(projectId: string, sheetId: string, content: string): Promise<SheetSummary> {
    await writeAtomic(this.sheetPath(projectId, sheetId), content)
    return toSummary(sheetId, content, Date.now())
  }

  async createSheet(projectId: string, content = '', afterId?: string): Promise<Sheet> {
    const id = newSheetId()
    await writeAtomic(this.sheetPath(projectId, id), content)
    const current = (await this.listSheets(projectId)).map((s) => s.id).filter((s) => s !== id)
    const at = afterId ? current.indexOf(afterId) : -1
    const order = at === -1 ? [...current, id] : [...current.slice(0, at + 1), id, ...current.slice(at + 1)]
    await this.writeMeta(projectId, { order })
    return this.readSheet(projectId, id)
  }

  async deleteSheet(projectId: string, sheetId: string): Promise<void> {
    await shell.trashItem(this.sheetPath(projectId, sheetId))
    const meta = await this.readMeta(projectId)
    await this.writeMeta(projectId, { order: meta.order.filter((id) => id !== sheetId) })
  }

  async reorderSheets(projectId: string, order: string[]): Promise<void> {
    order.forEach(assertSafeName)
    await this.writeMeta(projectId, { order })
  }

  async moveSheet(fromProject: string, sheetId: string, toProject: string): Promise<void> {
    if (fromProject === toProject) return
    let target = sheetId
    while (await exists(this.sheetPath(toProject, target))) target = newSheetId()
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
        const text = (await fs.readFile(this.sheetPath(projectId, s.id), 'utf8')).toLocaleLowerCase()
        return terms.every((t) => text.includes(t)) ? s.id : null
      })
    )
    return hits.filter((id): id is string => id !== null)
  }

  /** Glue sheets together in order, the way they'd read as one manuscript. */
  async compile(projectId: string, sheetIds?: string[]): Promise<{ title: string; markdown: string }> {
    const ids = sheetIds ?? (await this.listSheets(projectId)).map((s) => s.id)
    const parts = await Promise.all(ids.map((id) => fs.readFile(this.sheetPath(projectId, id), 'utf8')))
    const markdown = parts.map((p) => p.trim()).filter(Boolean).join('\n\n') + '\n'
    const title = sheetIds?.length === 1 ? summarize(parts[0]).title || 'Untitled' : projectId
    return { title, markdown }
  }
}
