import { normalizeProjectSettings } from './library'
import { summarize } from './text'
import type { SyncSettings } from './types'

/** What the desktop and iOS apps' syncs have in common. */

export const DEFAULT_SYNC: SyncSettings = {
  enabled: false,
  branch: 'main',
  commitDelay: 30,
  pullInterval: 5,
  agent: 'claude',
  autoResolve: false
}

/** Files that never belong in the repository. */
export const IGNORED = ['.DS_Store', '.*.tmp', 'Thumbs.db']

/** Even while typing non-stop, commit at least this often. */
export const MAX_COMMIT_WAIT = 5 * 60_000

export function normalizeSyncSettings(raw: Partial<SyncSettings> | undefined): SyncSettings {
  const s = { ...DEFAULT_SYNC, ...raw }
  const clamp = (n: unknown, min: number, max: number, fallback: number) =>
    typeof n === 'number' && Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback
  return {
    enabled: Boolean(s.enabled),
    branch: typeof s.branch === 'string' && s.branch.trim() ? s.branch.trim() : DEFAULT_SYNC.branch,
    commitDelay: clamp(s.commitDelay, 5, 3600, DEFAULT_SYNC.commitDelay),
    pullInterval: clamp(s.pullInterval, 1, 240, DEFAULT_SYNC.pullInterval),
    agent: s.agent === 'codex' ? 'codex' : 'claude',
    autoResolve: Boolean(s.autoResolve)
  }
}

/** The `.gitignore` with every pattern in IGNORED, or null if `existing` already has them all. */
export function withIgnored(existing: string): string | null {
  const lines = existing.split(/\r?\n/)
  const missing = IGNORED.filter((p) => !lines.includes(p))
  if (!missing.length) return null
  const sep = existing && !existing.endsWith('\n') ? '\n' : ''
  return existing + sep + missing.join('\n') + '\n'
}

/** A commit message describing what changed. `read` gives a file's text, or null if it's gone. */
export async function commitMessage(files: string[], read: (file: string) => Promise<string | null>): Promise<string> {
  const sheets = files.filter((f) => f.endsWith('.md'))
  const projects = [...new Set(files.map((f) => f.split('/')[0]))]
  const where = projects.length === 1 ? ` in ${projects[0]}` : ''
  if (sheets.length === 1) {
    const content = await read(sheets[0])
    if (content === null) return `Remove a sheet${where}`
    const title = summarize(content).title || 'Untitled'
    return `Update “${title.slice(0, 60)}”${where}`
  }
  if (sheets.length > 1) return `Update ${sheets.length} sheets${where}`
  return `Update library${where}`
}

export const isMetaFile = (file: string) => file === '.hermit.json' || file.endsWith('/.hermit.json')

/**
 * Project meta files are easy to merge mechanically: keep our order, then add anything new from the other side.
 * Settings changed on both sides keep ours.
 */
export function mergeMeta(ours: string | null, theirs: string | null): string {
  const read = (raw: string | null): { order: string[]; settings?: unknown } | null => {
    if (raw === null) return null
    try {
      const { order, settings } = JSON.parse(raw)
      return {
        order: Array.isArray(order) ? order.filter((x: unknown): x is string => typeof x === 'string') : [],
        settings
      }
    } catch {
      return { order: [] }
    }
  }
  const [a, b] = [read(ours), read(theirs)]
  const order = [...(a?.order ?? []), ...(b?.order ?? []).filter((id) => !a?.order.includes(id))]
  const settings = normalizeProjectSettings(a?.settings ?? b?.settings)
  return JSON.stringify({ settings, order }, null, 2)
}

/** A readable name for a conflicted file: the sheet's title and its project. */
export function conflictLabel(file: string, ours: string | null, theirs: string | null): string {
  const slash = file.lastIndexOf('/')
  const project = slash === -1 ? '.' : file.slice(0, slash)
  const title = file.endsWith('.md') ? summarize(ours ?? theirs ?? '').title || 'Untitled' : file.slice(slash + 1)
  return project === '.' ? title : `${title} — ${project}`
}
