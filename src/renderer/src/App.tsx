import type { Text } from '@codemirror/state'
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { isCanvasId, summarizeCanvas } from '../../shared/canvas'
import { countWords, readingMinutes } from '../../shared/text'
import type {
  ContentFormat,
  ContextMenuEntry,
  ExportFormat,
  MenuAction,
  OutlineItem,
  OutlineTarget,
  ProjectSettings as ProjectSettingsPatch,
  ProjectSummary,
  Section,
  Sheet,
  SheetPlace,
  SheetSummary
} from '../../shared/types'
import { CanvasView } from './components/CanvasView'
import { Editor, type EditorHandle } from './components/Editor'
import { EyeIcon, FocusIcon, PlusIcon, SheetsIcon, SidebarIcon, TypewriterIcon } from './components/Icons'
import { LibraryPane } from './components/LibraryPane'
import { MergeEditor } from './components/MergeEditor'
import { Preview } from './components/Preview'
import { ProjectSettings } from './components/ProjectSettings'
import { SettingsOverlay, type SettingsTab } from './components/SettingsOverlay'
import { SheetListPane } from './components/SheetListPane'
import { formatCommands, type FormatCommand } from './editor/extensions'
import { defaultDialect, type GrammarDialect } from './editor/grammar'
import { formatCount } from './format'
import { isWithin, otherSection, placeName, samePlace, SECTION_NAMES } from './sections'
import { sheetPath, syncLabel, timeAgo, useSyncState } from './sync'
import { useThemedIcon } from './icon'
import { useTheme } from './theme'

const hermit = window.hermit

type EditorFont = 'sans' | 'serif' | 'mono'

interface Prefs {
  showLibrary: boolean
  showSheets: boolean
  preview: boolean
  focus: boolean
  // Side panes as they were when focus mode began, restored on exit.
  panesBeforeFocus: { showLibrary: boolean; showSheets: boolean } | null
  typewriter: boolean
  grammar: boolean
  dialect: GrammarDialect
  font: EditorFont
  fontSize: number
}

const DEFAULT_PREFS: Prefs = {
  showLibrary: true,
  showSheets: true,
  preview: false,
  focus: false,
  panesBeforeFocus: null,
  typewriter: false,
  grammar: true,
  dialect: defaultDialect(),
  font: 'sans',
  fontSize: 17
}

const FONTS: Record<EditorFont, string> = {
  sans: 'var(--font-ui)',
  serif: 'var(--font-serif)',
  mono: 'var(--font-mono)'
}

const PREFS_KEY = 'hermit:prefs'
const LAST_KEY = 'hermit:last'

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback
  } catch {
    return fallback
  }
}

interface OpenSheet {
  projectId: string
  sheet: Sheet
  /** Identity of this load, so the editor knows when to swap documents. */
  key: string
}

type SaveState = 'saved' | 'unsaved' | 'saving' | 'error'

/** What the status bar counts: words and characters, or for a canvas, its cards and connections. */
interface Stats {
  words: number
  chars: number
  canvas?: string
}

/** The project to fall back on: the first that isn't archived. */
const firstActive = (list: ProjectSummary[]) => list.find((p) => !p.archived)?.id ?? null

/** Where a sheet is listed: its section, or the archive. Switching back to one returns to the sheet last open there. */
const viewKey = (projectId: string, sheet: SheetSummary) => `${projectId}:${sheet.archived ? 'archive' : sheet.section}`

function statsOf(sheetId: string, text: string): Stats {
  if (!isCanvasId(sheetId)) return { words: countWords(text), chars: text.length }
  const { excerpt, wordCount } = summarizeCanvas(text)
  return { words: wordCount, chars: text.length, canvas: excerpt }
}

export default function App() {
  const [prefs, setPrefs] = useState<Prefs>(() => loadJson(PREFS_KEY, DEFAULT_PREFS))
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [projectId, setProjectId] = useState<string | null>(null)
  // Every sheet in the project, both sections; the list shows the active section's.
  const [sheets, setSheets] = useState<SheetSummary[]>([])
  const [section, setSection] = useState<Section>('content')
  // Archived sheets of both sections, most recently archived first.
  const [archived, setArchived] = useState<SheetSummary[]>([])
  // Whether the sheet list shows the archive instead of the section.
  const [archiveOpen, setArchiveOpen] = useState(false)
  // Sheets and subsections of both sections, in reading order.
  const [outline, setOutline] = useState<OutlineItem[]>([])
  // Path of the subsection being named, in the active section.
  const [renamingSubsection, setRenamingSubsection] = useState<string | null>(null)
  // The canvas being named in the list.
  const [renamingSheet, setRenamingSheet] = useState<string | null>(null)
  const [current, setCurrent] = useState<OpenSheet | null>(null)
  const [folders, setFolders] = useState<string[]>([])
  const [renamingProject, setRenamingProject] = useState<string | null>(null)
  const [renamingFolder, setRenamingFolder] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState<Set<string> | null>(null)
  const [stats, setStats] = useState<Stats>({ words: 0, chars: 0 })
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const [ready, setReady] = useState(false)
  const [libraryError, setLibraryError] = useState<string | null>(null)
  const [theme, setTheme] = useTheme()
  useThemedIcon(theme)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('appearance')
  const sync = useSyncState()
  const [mergeOpen, setMergeOpen] = useState(false)
  // The project whose settings are open.
  const [projectSettingsFor, setProjectSettingsFor] = useState<string | null>(null)

  const editor = useRef<EditorHandle>(null)
  // A canvas's edits arrive as its whole file.
  const pending = useRef<{ projectId: string; sheetId: string; doc: Text | string } | null>(null)
  const liveDoc = useRef<Text | string>('')
  const saveTimer = useRef<number | undefined>(undefined)
  const statsTimer = useRef<number | undefined>(undefined)
  const loadSeq = useRef(0)
  // The sheet last open in each project section and archive, so switching back returns to it.
  const lastInSection = useRef(new Map<string, string>())

  useEffect(() => localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)), [prefs])

  // ── Saving ────────────────────────────────────────────────────────────────

  const flush = useCallback(async () => {
    window.clearTimeout(saveTimer.current)
    const job = pending.current
    if (!job) return
    pending.current = null
    setSaveState('saving')
    try {
      const summary = await hermit.writeSheet(job.projectId, job.sheetId, job.doc.toString())
      const replace = (prev: SheetSummary[]) => prev.map((s) => (s.id === summary.id ? summary : s))
      if (summary.archived) setArchived(replace)
      else setSheets(replace)
      setSaveState(pending.current ? 'unsaved' : 'saved')
    } catch (err) {
      console.error('Save failed', err)
      pending.current ??= job
      setSaveState('error')
    }
  }, [])

  /** Forget unsaved edits for sheets that are about to disappear (deleted or moved). */
  const discardPending = (match: (p: { projectId: string; sheetId: string }) => boolean) => {
    if (pending.current && match(pending.current)) {
      window.clearTimeout(saveTimer.current)
      pending.current = null
      setSaveState('saved')
    }
  }

  const handleChange = (doc: Text | string) => {
    if (!current) return
    const sheetId = current.sheet.id
    pending.current = { projectId: current.projectId, sheetId, doc }
    liveDoc.current = doc
    setSaveState('unsaved')
    window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(flush, 600)
    window.clearTimeout(statsTimer.current)
    statsTimer.current = window.setTimeout(() => setStats(statsOf(sheetId, doc.toString())), 150)
  }

  // ── Loading ───────────────────────────────────────────────────────────────

  /** On failure, keeps the last lists and reports why instead of throwing. */
  const refreshProjects = useCallback(async () => {
    try {
      const [list, folderList] = await Promise.all([hermit.listProjects(), hermit.listFolders()])
      setProjects(list)
      setFolders(folderList)
      setLibraryError(null)
      return list
    } catch (err) {
      console.error('Reading the library failed', err)
      // IPC wraps the main process's error: "Error invoking remote method 'x': Error: <message>"
      const message = err instanceof Error ? err.message : String(err)
      setLibraryError(message.replace(/^Error invoking remote method '[^']*': (Error: )?/, ''))
      return []
    }
  }, [])

  const refreshSheets = useCallback(async (pid: string) => {
    const result = await hermit.listOutline(pid)
    setSheets(result.sheets)
    setOutline(result.items)
    setArchived(result.archived)
    return result
  }, [])

  const openSheet = useCallback(
    async (pid: string, sheetId: string | null) => {
      await flush()
      const seq = ++loadSeq.current
      if (!sheetId) {
        setCurrent(null)
        return
      }
      const sheet = await hermit.readSheet(pid, sheetId)
      if (seq !== loadSeq.current) return
      liveDoc.current = sheet.content
      setStats(statsOf(sheet.id, sheet.content))
      setCurrent({ projectId: pid, sheet, key: `${pid}/${sheetId}#${seq}` })
      setArchiveOpen(sheet.archived)
      if (!sheet.archived) setSection(sheet.section)
      lastInSection.current.set(viewKey(pid, sheet), sheetId)
      localStorage.setItem(LAST_KEY, JSON.stringify({ projectId: pid, sheetId }))
    },
    [flush]
  )

  const openProject = useCallback(
    async (pid: string | null, preferredSheet?: string | null) => {
      await flush()
      setProjectId(pid)
      setQuery('')
      setArchiveOpen(false)
      if (!pid) {
        setSheets([])
        setArchived([])
        await openSheet('', null)
        return
      }
      const { sheets: list, archived: archivedList } = await refreshSheets(pid)
      const target =
        [...list, ...archivedList].find((s) => s.id === preferredSheet) ?? list.find((s) => s.section === 'content')
      setSection(target?.section ?? 'content')
      await openSheet(pid, target?.id ?? null)
    },
    [flush, openSheet, refreshSheets]
  )

  const init = useCallback(async () => {
    const list = await refreshProjects()
    const last = loadJson<{ projectId?: string; sheetId?: string }>(LAST_KEY, {})
    await openProject(list.find((p) => p.id === last.projectId)?.id ?? firstActive(list), last.sheetId)
    setReady(true)
  }, [openProject, refreshProjects])

  useEffect(() => {
    void init()
  }, [init])

  // ── Sync ──────────────────────────────────────────────────────────────────

  /** A pull changed files on disk: refresh the lists and the open sheet. */
  const handleSyncChanged = async (paths: string[]) => {
    const list = await refreshProjects()
    if (!projectId || !list.some((p) => p.id === projectId)) {
      await openProject(firstActive(list))
      return
    }
    const { sheets: sheetList, archived: archivedList } = await refreshSheets(projectId)
    if (!current || current.projectId !== projectId) return
    const id = current.sheet.id
    if (!paths.includes(sheetPath(projectId, id))) return

    // Anything typed in the moment since sync saved this sheet would overwrite what was just pulled.
    discardPending((p) => p.projectId === projectId && p.sheetId === id)
    if (![...sheetList, ...archivedList].some((s) => s.id === id)) {
      const fallback = archiveOpen ? archivedList[0] : sheetList.find((s) => s.section === section)
      await openSheet(projectId, fallback?.id ?? null)
      return
    }
    const sheet = await hermit.readSheet(projectId, id)
    liveDoc.current = sheet.content
    setStats(statsOf(id, sheet.content))
    // A canvas starts over from the new file; the editor keeps its place in the text.
    if (isCanvasId(id)) setCurrent({ projectId, sheet, key: `${projectId}/${id}#${++loadSeq.current}` })
    else editor.current?.replaceContent(sheet.content)
  }

  const syncChangedHandler = useRef(handleSyncChanged)
  useEffect(() => {
    syncChangedHandler.current = handleSyncChanged
  })
  useEffect(() => hermit.onSyncChanged((paths) => void syncChangedHandler.current(paths)), [])
  useEffect(() => hermit.onSyncFlush(flush), [flush])

  // Open the merge editor as soon as a pull runs into conflicts.
  const lastSyncStatus = useRef(sync?.status)
  useEffect(() => {
    const was = lastSyncStatus.current
    lastSyncStatus.current = sync?.status
    if (was === 'syncing' && sync?.status === 'conflict') {
      setSettingsOpen(false)
      setMergeOpen(true)
    }
  }, [sync?.status])

  const conflicted = Boolean(current && sync?.conflicts.includes(sheetPath(current.projectId, current.sheet.id)))
  const onCanvas = Boolean(current && isCanvasId(current.sheet.id))

  // ── Search ────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!query.trim() || !projectId) {
      setMatches(null)
      return
    }
    const timer = window.setTimeout(async () => {
      await flush()
      setMatches(new Set(await hermit.searchSheets(projectId, query)))
    }, 180)
    return () => window.clearTimeout(timer)
  }, [query, projectId, flush])

  const matchingSheets = useMemo(
    () => (matches ? sheets.filter((s) => matches.has(s.id)) : sheets),
    [sheets, matches]
  )
  const matchingArchived = useMemo(
    () => (matches ? archived.filter((s) => matches.has(s.id)) : archived),
    [archived, matches]
  )
  // The list shows the section's sheets, or the archive's.
  const visibleSheets = useMemo(
    () => (archiveOpen ? matchingArchived : matchingSheets.filter((s) => s.section === section)),
    [archiveOpen, matchingArchived, matchingSheets, section]
  )
  const sectionOutline = useMemo(() => outline.filter((i) => i.section === section), [outline, section])
  const sectionCounts = {
    content: matchingSheets.filter((s) => s.section === 'content').length,
    notes: matchingSheets.filter((s) => s.section === 'notes').length,
    archive: matchingArchived.length
  }
  // Both sections and the archive, for finding a neighbour once a sheet leaves its list.
  const everySheet = [...sheets, ...archived]

  // ── Actions ───────────────────────────────────────────────────────────────

  /** New projects go in the same folder as the open one, unless that one's archived. */
  const createProject = async (folder = projects.find((p) => p.id === projectId && !p.archived)?.folder ?? null) => {
    await flush()
    const project = await hermit.createProject('Untitled Project', folder)
    await refreshProjects()
    setPrefs((p) => ({ ...p, showLibrary: true }))
    await openProject(project.id)
    setRenamingProject(project.id)
  }

  const renameProject = async (id: string, name: string) => {
    setRenamingProject(null)
    await flush()
    try {
      const renamed = await hermit.renameProject(id, name)
      projectsMoved(id, renamed.id)
      await refreshProjects()
    } catch (err) {
      console.error('Rename failed', err)
    }
  }

  /** Projects at or under `from` now live under `to`. Keep the open one open without reloading it. */
  const projectsMoved = (from: string, to: string) => {
    if (from === to) return
    const remap = (id: string) => (id === from || id.startsWith(`${from}/`) ? to + id.slice(from.length) : id)
    if (pending.current) pending.current = { ...pending.current, projectId: remap(pending.current.projectId) }
    if (projectId) setProjectId(remap(projectId))
    setCurrent((c) => (c ? { ...c, projectId: remap(c.projectId) } : c))
    if (current) {
      localStorage.setItem(LAST_KEY, JSON.stringify({ projectId: remap(current.projectId), sheetId: current.sheet.id }))
    }
  }

  const createFolder = async (parent: string | null = null) => {
    const folder = await hermit.createFolder('New Folder', parent)
    await refreshProjects()
    setPrefs((p) => ({ ...p, showLibrary: true }))
    setRenamingFolder(folder)
  }

  const renameFolder = async (folder: string, name: string) => {
    setRenamingFolder(null)
    await flush()
    try {
      projectsMoved(folder, await hermit.renameFolder(folder, name))
    } catch (err) {
      console.error('Rename failed', err)
    }
    await refreshProjects()
  }

  const deleteFolder = async (folder: string) => {
    await flush()
    if (!(await hermit.deleteFolder(folder))) return
    const inside = (id: string) => id.startsWith(`${folder}/`)
    discardPending((p) => inside(p.projectId))
    const list = await refreshProjects()
    if (projectId && inside(projectId)) await openProject(firstActive(list))
  }

  /** Move a project or folder into a folder, or to the top of the library with null. */
  const moveInLibrary = async (libraryPath: string, folder: string | null) => {
    await flush()
    try {
      projectsMoved(libraryPath, await hermit.moveInLibrary(libraryPath, folder))
    } catch (err) {
      console.error('Move failed', err)
    }
    await refreshProjects()
  }

  const deleteProject = async (id: string) => {
    await flush()
    if (!(await hermit.deleteProject(id))) return
    discardPending((p) => p.projectId === id)
    const list = await refreshProjects()
    if (projectId === id) await openProject(firstActive(list))
  }

  /** Archiving the open project moves on to another, as moving it to the Trash does. */
  const archiveProject = async (id: string) => {
    await flush()
    try {
      await hermit.archiveProject(id)
    } catch (err) {
      console.error('Archive failed', err)
      return
    }
    discardPending((p) => p.projectId === id)
    const list = await refreshProjects()
    if (projectId === id) await openProject(firstActive(list))
  }

  const restoreProject = async (id: string) => {
    await flush()
    try {
      projectsMoved(id, await hermit.restoreProject(id))
    } catch (err) {
      console.error('Restore failed', err)
    }
    await refreshProjects()
  }

  /** New sheets go after the open one, or at the end of `place` when given. */
  const createSheet = async (content = '', place?: SheetPlace) => {
    let pid = projectId
    if (!pid) {
      const project = await hermit.createProject('Untitled Project')
      await refreshProjects()
      pid = project.id
      setProjectId(pid)
    }
    await flush()
    setQuery('')
    const here =
      current?.projectId === pid && !current.sheet.archived && current.sheet.section === section ? current.sheet : null
    const target = place ?? { section, subsection: here?.subsection ?? null }
    const afterId = here && samePlace(here, target) ? here.id : undefined
    const sheet = await hermit.createSheet(pid, content, afterId, target)
    await Promise.all([refreshSheets(pid), refreshProjects()])
    await openSheet(pid, sheet.id)
  }

  /** New canvases go in the notes: after the open note, or at the end of `place` when given. */
  const createCanvas = async (place?: SheetPlace) => {
    if (!projectId) return
    const pid = projectId
    await flush()
    setQuery('')
    const here = current?.projectId === pid && !current.sheet.archived && current.sheet.section === 'notes' ? current.sheet : null
    const target = place ?? { section: 'notes' as const, subsection: here?.subsection ?? null }
    const afterId = here && samePlace(here, target) ? here.id : undefined
    const canvas = await hermit.createCanvas(pid, target, 'Untitled Canvas', undefined, afterId)
    await refreshSheets(pid)
    await openSheet(pid, canvas.id)
    setPrefs((p) => ({ ...p, showSheets: true }))
    setRenamingSheet(canvas.id)
  }

  const renameCanvas = async (id: string, name: string) => {
    setRenamingSheet(null)
    if (!projectId) return
    const pid = projectId
    await flush()
    try {
      const renamed = await hermit.renameCanvas(pid, id, name)
      discardPending((p) => p.projectId === pid && p.sheetId in renamed)
      await retarget(pid, renamed, (await refreshSheets(pid)).sheets)
    } catch (err) {
      console.error('Rename failed', err)
    }
  }

  const duplicateSheet = async (id: string) => {
    if (!projectId) return
    await flush()
    const source = await hermit.readSheet(projectId, id)
    const copy = isCanvasId(id)
      ? await hermit.createCanvas(projectId, source, `${source.title} Copy`, source.content, id)
      : await hermit.createSheet(projectId, source.content, id, source)
    await Promise.all([refreshSheets(projectId), refreshProjects()])
    await openSheet(projectId, copy.id)
  }

  /** After sheets leave the list, if the open one went, select its neighbour in the same section or archive. */
  const selectNeighbour = async (pid: string, removedIds: string[], before: SheetSummary[]) => {
    const { sheets: list, archived: archivedList } = await refreshSheets(pid)
    await refreshProjects()
    if (!current || !removedIds.includes(current.sheet.id)) return
    const from = current.sheet
    const sameList = (s: SheetSummary) => s.archived === from.archived && (from.archived || s.section === from.section)
    const index = before.filter(sameList).findIndex((s) => s.id === from.id)
    const remaining = [...list, ...archivedList].filter(sameList)
    const next = remaining[Math.min(index, remaining.length - 1)]
    await openSheet(pid, next?.id ?? null)
  }

  const deleteSheet = async (id: string) => {
    if (!projectId) return
    await flush()
    if (!(await hermit.deleteSheet(projectId, id))) return
    discardPending((p) => p.sheetId === id)
    await selectNeighbour(projectId, [id], everySheet)
  }

  const moveSheet = async (sheetId: string, from: string, to: string) => {
    await flush()
    discardPending((p) => p.sheetId === sheetId)
    await hermit.moveSheet(from, sheetId, to)
    if (from === projectId) await selectNeighbour(from, [sheetId], everySheet)
    else await refreshProjects()
  }

  /** Move a sheet, or a subsection and everything in it, into the archive. */
  const archiveItem = async (item: OutlineItem) => {
    if (!projectId) return
    const pid = projectId
    await flush()
    try {
      const renamed = await hermit.archiveInOutline(pid, item)
      discardPending((p) => p.projectId === pid && p.sheetId in renamed)
      await selectNeighbour(pid, Object.keys(renamed), everySheet)
    } catch (err) {
      console.error('Archive failed', err)
    }
  }

  /** Put an archived sheet back where it came from. If it's the one open, follow it there. */
  const restoreSheet = async (id: string) => {
    if (!projectId) return
    const pid = projectId
    await flush()
    let renamed: Record<string, string>
    try {
      renamed = await hermit.restoreSheet(pid, id)
    } catch (err) {
      console.error('Restore failed', err)
      return
    }
    discardPending((p) => p.projectId === pid && p.sheetId in renamed)
    const { sheets: list } = await refreshSheets(pid)
    await refreshProjects()
    const restored = list.find((s) => s.id === renamed[id])
    if (current?.projectId !== pid || current.sheet.id !== id || !restored) return
    await retarget(pid, renamed, list)
    setArchiveOpen(false)
    setSection(restored.section)
  }

  /** The open sheet's file moved; keep editing it under its new id without reloading. */
  const retarget = async (pid: string, renamed: Record<string, string>, list: SheetSummary[]) => {
    if (current?.projectId !== pid || !Object.keys(renamed).length) return
    const openId = renamed[current.sheet.id] ?? current.sheet.id
    if (isCanvasId(openId)) {
      // Moving sheets rewrites the links on canvases that show them, so the open canvas reloads.
      const sheet = await hermit.readSheet(pid, openId)
      setCurrent({ projectId: pid, sheet, key: `${pid}/${openId}#${++loadSeq.current}` })
      lastInSection.current.set(viewKey(pid, sheet), openId)
      localStorage.setItem(LAST_KEY, JSON.stringify({ projectId: pid, sheetId: openId }))
      return
    }
    const moved = list.find((s) => s.id === renamed[current.sheet.id])
    if (!moved) return
    const { id, section: movedTo, subsection, archived: isArchived } = moved
    setCurrent({ ...current, sheet: { ...current.sheet, id, section: movedTo, subsection, archived: isArchived } })
    lastInSection.current.set(viewKey(pid, moved), id)
    localStorage.setItem(LAST_KEY, JSON.stringify({ projectId: pid, sheetId: id }))
  }

  /** Reorder or refile a sheet or subsection. */
  const moveItem = async (item: OutlineItem, target: OutlineTarget) => {
    if (!projectId) return
    const pid = projectId
    await flush()
    let renamed: Record<string, string>
    try {
      renamed = await hermit.moveInOutline(pid, item, target)
    } catch (err) {
      console.error('Move failed', err)
      return
    }
    // Anything typed since the flush belongs to a path that's gone.
    discardPending((p) => p.projectId === pid && p.sheetId in renamed)
    const toSection = 'into' in target ? target.into.section : ('before' in target ? target.before : target.after).section
    if (item.kind === 'sheet' && toSection !== item.section) {
      await selectNeighbour(pid, [item.id], everySheet)
      if (current?.sheet.id !== item.id) await retarget(pid, renamed, [])
      return
    }
    await retarget(pid, renamed, (await refreshSheets(pid)).sheets)
  }

  const createSubsection = async (parent: SheetPlace = { section, subsection: null }) => {
    if (!projectId) return
    const place = await hermit.createSubsection(projectId, parent, 'New Subsection')
    await refreshSheets(projectId)
    setRenamingSubsection(place.subsection)
  }

  const renameSubsection = async (place: SheetPlace, name: string) => {
    setRenamingSubsection(null)
    if (!projectId) return
    const pid = projectId
    await flush()
    const renamed = await hermit.renameSubsection(pid, place, name)
    discardPending((p) => p.projectId === pid && p.sheetId in renamed)
    await retarget(pid, renamed, (await refreshSheets(pid)).sheets)
  }

  const deleteSubsection = async (place: SheetPlace) => {
    if (!projectId || !place.subsection) return
    await flush()
    if (!(await hermit.deleteSubsection(projectId, place))) return
    const wasOpen =
      current?.projectId === projectId &&
      current.sheet.section === place.section &&
      isWithin(current.sheet.subsection, place.subsection)
    if (wasOpen) discardPending((p) => p.projectId === projectId && p.sheetId === current.sheet.id)
    const { sheets: list } = await refreshSheets(projectId)
    if (wasOpen) await openSheet(projectId, list.find((s) => s.section === place.section)?.id ?? null)
  }

  /** Show a section, picking up where you left off in it. */
  const switchSection = async (to: Section) => {
    if (!projectId || (to === section && !archiveOpen)) return
    setArchiveOpen(false)
    setSection(to)
    const inSection = sheets.filter((s) => s.section === to)
    const last = lastInSection.current.get(`${projectId}:${to}`)
    const target = inSection.find((s) => s.id === last) ?? inSection[0]
    await openSheet(projectId, target?.id ?? null)
  }

  /** Show the archive, picking up where you left off in it. */
  const openArchive = async () => {
    if (!projectId || archiveOpen) return
    setArchiveOpen(true)
    const last = lastInSection.current.get(`${projectId}:archive`)
    const target = archived.find((s) => s.id === last) ?? archived[0]
    await openSheet(projectId, target?.id ?? null)
  }

  const exportSheets = async (pid: string, ids: string[] | null, format?: ExportFormat) => {
    await flush()
    await hermit.exportSheets(pid, ids, format)
  }

  /** A screenplay's content exports as Fountain; everything else as Markdown. */
  const exportItems = (format: ContentFormat): ContextMenuEntry[] => [
    format === 'fountain'
      ? { id: 'export-fountain', label: 'Export as Fountain…' }
      : { id: 'export-md', label: 'Export as Markdown…' },
    { id: 'export-html', label: 'Export as HTML…' },
    { id: 'export-pdf', label: 'Export as PDF…' }
  ]

  const formatOf = (pid: string | null | undefined): ContentFormat =>
    projects.find((p) => p.id === pid)?.settings.format ?? 'markdown'

  // Notes are always Markdown; content is written in the project's format.
  const sheetFormat: ContentFormat = current?.sheet.section === 'content' ? formatOf(current.projectId) : 'markdown'

  const updateProjectSettings = async (id: string, patch: Partial<ProjectSettingsPatch>) => {
    await flush()
    try {
      await hermit.updateProjectSettings(id, patch)
    } catch (err) {
      console.error('Saving project settings failed', err)
    }
    // Sheet titles and excerpts read differently in another format.
    await Promise.all([refreshProjects(), id === projectId && refreshSheets(id)])
  }

  const stepSheet = (delta: number) => {
    if (!projectId || !visibleSheets.length) return
    const index = visibleSheets.findIndex((s) => s.id === current?.sheet.id)
    const next = visibleSheets[Math.max(0, Math.min(visibleSheets.length - 1, index + delta))]
    if (next && next.id !== current?.sheet.id) void openSheet(projectId, next.id)
  }

  const showProjectMenu = async (id: string) => {
    const inArchive = projects.find((p) => p.id === id)?.archived
    const choice = await hermit.showContextMenu([
      inArchive ? { id: 'restore', label: 'Restore from Archive' } : { id: 'rename', label: 'Rename' },
      { id: 'reveal', label: 'Show in Finder' },
      { id: 'settings', label: 'Project Settings…' },
      { type: 'separator' },
      ...exportItems(formatOf(id)),
      { type: 'separator' },
      ...(inArchive ? [] : [{ id: 'archive', label: 'Archive' }]),
      { id: 'delete', label: 'Move to Trash…' }
    ])
    if (choice === 'rename') setRenamingProject(id)
    else if (choice === 'archive') void archiveProject(id)
    else if (choice === 'restore') void restoreProject(id)
    else if (choice === 'settings') setProjectSettingsFor(id)
    else if (choice === 'reveal') void hermit.revealProject(id)
    else if (choice === 'delete') void deleteProject(id)
    else if (choice?.startsWith('export-')) void exportSheets(id, null, choice.slice(7) as ExportFormat)
  }

  const showArchivedMenu = async (sheet: SheetSummary) => {
    if (!projectId) return
    const canvas = isCanvasId(sheet.id)
    const choice = await hermit.showContextMenu([
      { id: 'restore', label: `Restore to ${placeName(sheet)}` },
      ...(canvas
        ? []
        : [{ type: 'separator' as const }, ...exportItems(sheet.section === 'content' ? formatOf(projectId) : 'markdown')]),
      { type: 'separator' },
      { id: 'delete', label: 'Move to Trash…' }
    ])
    if (choice === 'restore') void restoreSheet(sheet.id)
    else if (choice === 'delete') void deleteSheet(sheet.id)
    else if (choice?.startsWith('export-')) void exportSheets(projectId, [sheet.id], choice.slice(7) as ExportFormat)
  }

  const showSheetMenu = async (id: string) => {
    if (!projectId) return
    const archivedSheet = archived.find((s) => s.id === id)
    if (archivedSheet) return showArchivedMenu(archivedSheet)
    const others = projects.filter((p) => p.id !== projectId && !p.archived)
    const sheet = sheets.find((s) => s.id === id)
    // Every section and subsection, in outline order.
    const allPlaces: SheetPlace[] = (['content', 'notes'] as const).flatMap((s) => [
      { section: s, subsection: null },
      ...outline.flatMap((i) => (i.kind === 'subsection' && i.section === s ? [{ section: s, subsection: i.subsection }] : []))
    ])
    const canvas = isCanvasId(id)
    // Canvases stay in the notes, and only export as themselves, from Finder.
    const places = allPlaces.filter((place) => (!sheet || !samePlace(sheet, place)) && (!canvas || place.section === 'notes'))
    const choice = await hermit.showContextMenu([
      ...(canvas ? [{ id: 'rename', label: 'Rename' }] : []),
      { id: 'duplicate', label: 'Duplicate' },
      ...places.map((place, i) => ({ id: `place:${i}`, label: `Move to ${placeName(place)}` })),
      ...(canvas
        ? []
        : [{ type: 'separator' as const }, ...exportItems(sheet?.section === 'content' ? formatOf(projectId) : 'markdown')]),
      ...(others.length
        ? [
            { type: 'separator' as const },
            ...others.map((p) => ({ id: `move:${p.id}`, label: `Move to “${p.id.split('/').join(' › ')}”` }))
          ]
        : []),
      { type: 'separator' },
      { id: 'archive', label: 'Archive' },
      { id: 'delete', label: 'Move to Trash…' }
    ])
    const item: OutlineItem | null = sheet ? { kind: 'sheet', id, section: sheet.section, subsection: sheet.subsection } : null
    if (choice === 'rename') setRenamingSheet(id)
    else if (choice === 'duplicate') void duplicateSheet(id)
    else if (choice?.startsWith('place:') && item) void moveItem(item, { into: places[Number(choice.slice(6))] })
    else if (choice === 'archive' && item) void archiveItem(item)
    else if (choice === 'delete') void deleteSheet(id)
    else if (choice?.startsWith('export-')) void exportSheets(projectId, [id], choice.slice(7) as ExportFormat)
    else if (choice?.startsWith('move:')) void moveSheet(id, projectId, choice.slice(5))
  }

  const showFolderMenu = async (folder: string) => {
    const choice = await hermit.showContextMenu([
      { id: 'new-project', label: 'New Project' },
      { id: 'new-folder', label: 'New Folder' },
      { id: 'rename', label: 'Rename' },
      { type: 'separator' },
      { id: 'delete', label: 'Move to Trash…' }
    ])
    if (choice === 'new-project') void createProject(folder)
    else if (choice === 'new-folder') void createFolder(folder)
    else if (choice === 'rename') setRenamingFolder(folder)
    else if (choice === 'delete') void deleteFolder(folder)
  }

  const showLibraryMenu = async () => {
    const choice = await hermit.showContextMenu([
      { id: 'new-project', label: 'New Project' },
      { id: 'new-folder', label: 'New Folder' }
    ])
    if (choice === 'new-project') void createProject(null)
    else if (choice === 'new-folder') void createFolder(null)
  }

  /** The library's add button: a project in the open project's folder, or a folder at the top. */
  const showLibraryNewMenu = async (at: { x: number; y: number }) => {
    const choice = await hermit.showContextMenu(
      [
        { id: 'new-project', label: 'New Project' },
        { id: 'new-folder', label: 'New Folder' }
      ],
      at
    )
    if (choice === 'new-project') void createProject()
    else if (choice === 'new-folder') void createFolder()
  }

  /** New sheets and subsections at the top level of a section, switching to it first so they show. */
  const showSectionMenu = async (to: Section) => {
    const choice = await hermit.showContextMenu([
      { id: 'new', label: `New ${SECTION_NAMES[to].item}` },
      ...(to === 'notes' ? [{ id: 'new-canvas', label: 'New Canvas' }] : []),
      { id: 'new-subsection', label: 'New Subsection' }
    ])
    if (!choice) return
    const place: SheetPlace = { section: to, subsection: null }
    if (choice === 'new') void createSheet('', place)
    else if (choice === 'new-canvas') void createCanvas(place)
    else if (choice === 'new-subsection') {
      await switchSection(to)
      void createSubsection(place)
    }
  }

  /** The sheet list's add button: a sheet after the open one, a canvas, or a subsection, in the current section. */
  const showNewMenu = async (at: { x: number; y: number }) => {
    const choice = await hermit.showContextMenu(
      [
        { id: 'new', label: `New ${SECTION_NAMES[section].item}` },
        ...(section === 'notes' ? [{ id: 'new-canvas', label: 'New Canvas' }] : []),
        { id: 'new-subsection', label: 'New Subsection' }
      ],
      at
    )
    if (choice === 'new') void createSheet()
    else if (choice === 'new-canvas') void createCanvas()
    else if (choice === 'new-subsection') void createSubsection()
  }

  const showSubsectionMenu = async (place: SheetPlace) => {
    const choice = await hermit.showContextMenu([
      { id: 'new', label: `New ${SECTION_NAMES[place.section].item}` },
      ...(place.section === 'notes' ? [{ id: 'new-canvas', label: 'New Canvas' }] : []),
      { id: 'new-subsection', label: 'New Subsection' },
      { id: 'rename', label: 'Rename' },
      { type: 'separator' },
      { id: 'archive', label: 'Archive' },
      { id: 'delete', label: 'Move to Trash…' }
    ])
    if (choice === 'new') void createSheet('', place)
    else if (choice === 'new-canvas') void createCanvas(place)
    else if (choice === 'new-subsection') void createSubsection(place)
    else if (choice === 'rename') setRenamingSubsection(place.subsection)
    else if (choice === 'archive' && place.subsection) {
      void archiveItem({ kind: 'subsection', section: place.section, subsection: place.subsection })
    }
    else if (choice === 'delete') void deleteSubsection(place)
  }

  const togglePref = (key: 'showLibrary' | 'showSheets' | 'preview' | 'typewriter' | 'grammar') =>
    setPrefs((p) => ({ ...p, [key]: !p[key] }))

  // Hide both side panes if either is showing; otherwise bring both back.
  const toggleSidebars = () =>
    setPrefs((p) => {
      const show = !p.showLibrary && !p.showSheets
      return { ...p, showLibrary: show, showSheets: show }
    })

  // Entering focus mode clears the side panes away; leaving it brings back whatever was open before.
  const toggleFocus = () =>
    setPrefs((p) =>
      p.focus
        ? { ...p, ...p.panesBeforeFocus, focus: false, panesBeforeFocus: null }
        : {
            ...p,
            focus: true,
            panesBeforeFocus: { showLibrary: p.showLibrary, showSheets: p.showSheets },
            showLibrary: false,
            showSheets: false
          }
    )

  // ── Menu + lifecycle wiring ───────────────────────────────────────────────

  const openSettings = (tab: SettingsTab) => {
    setSettingsTab(tab)
    setSettingsOpen(true)
  }

  const closeSettings = () => {
    setSettingsOpen(false)
    if (!prefs.preview) editor.current?.focus()
  }

  const openMerge = () => {
    setSettingsOpen(false)
    setMergeOpen(true)
  }

  const closeProjectSettings = () => {
    setProjectSettingsFor(null)
    if (!prefs.preview) editor.current?.focus()
  }

  const closeMerge = () => {
    setMergeOpen(false)
    if (!prefs.preview) editor.current?.focus()
  }

  const syncStatusClick = () => {
    if (sync?.status === 'conflict' || sync?.status === 'resolving') openMerge()
    else openSettings('sync')
  }

  const handleMenu = (action: MenuAction) => {
    // The editor sits under the settings overlay; don't edit it blind.
    const editable = !prefs.preview && !settingsOpen && !projectSettingsFor && !mergeOpen && !conflicted && !onCanvas
    const run = (cmd: FormatCommand) => {
      const command = formatCommands[sheetFormat][cmd]
      if (editable && command) editor.current?.run(command)
    }
    switch (action) {
      case 'new-sheet': return void createSheet()
      case 'new-canvas': return void createCanvas()
      case 'new-project': return void createProject()
      case 'export-sheet': return current && !onCanvas && void exportSheets(current.projectId, [current.sheet.id])
      case 'export-project': return projectId && void exportSheets(projectId, null)
      case 'project-settings': return projectId && setProjectSettingsFor(projectId)
      case 'toggle-library': return togglePref('showLibrary')
      case 'toggle-sheets': return togglePref('showSheets')
      case 'toggle-sidebars': return toggleSidebars()
      case 'toggle-section': return void switchSection(archiveOpen ? section : otherSection(section))
      case 'toggle-preview': return current && !onCanvas && togglePref('preview')
      case 'toggle-focus': return toggleFocus()
      case 'toggle-typewriter': return togglePref('typewriter')
      case 'toggle-grammar': return togglePref('grammar')
      case 'font-sans': return setPrefs((p) => ({ ...p, font: 'sans' }))
      case 'font-serif': return setPrefs((p) => ({ ...p, font: 'serif' }))
      case 'font-mono': return setPrefs((p) => ({ ...p, font: 'mono' }))
      case 'font-bigger': return setPrefs((p) => ({ ...p, fontSize: Math.min(30, p.fontSize + 1) }))
      case 'font-smaller': return setPrefs((p) => ({ ...p, fontSize: Math.max(12, p.fontSize - 1) }))
      case 'font-reset': return setPrefs((p) => ({ ...p, fontSize: DEFAULT_PREFS.fontSize }))
      case 'find': return editable && editor.current?.openSearch()
      case 'next-sheet': return stepSheet(1)
      case 'prev-sheet': return stepSheet(-1)
      case 'format-bold': return run('bold')
      case 'format-italic': return run('italic')
      case 'format-code': return run('code')
      case 'format-link': return run('link')
      case 'format-heading': return run('heading')
      case 'format-quote': return run('quote')
      case 'open-settings': return openSettings('appearance')
      case 'sync-now':
        if (sync?.status === 'conflict') return setMergeOpen(true)
        if (sync?.remoteUrl && sync.settings.enabled) return void hermit.syncNow()
        return openSettings('sync')
      case 'library-changed':
        pending.current = null
        return void init()
    }
  }

  const menuHandler = useRef(handleMenu)
  useEffect(() => {
    menuHandler.current = handleMenu
  })
  useEffect(() => hermit.onMenu((action) => menuHandler.current(action)), [])
  useEffect(() => hermit.onBeforeClose(flush), [flush])

  // ── Render ────────────────────────────────────────────────────────────────

  const project = projects.find((p) => p.id === projectId)
  const settingsProject = projects.find((p) => p.id === projectSettingsFor)
  const totalWords = (archiveOpen ? archived : sheets.filter((s) => s.section === section)).reduce(
    (sum, s) => sum + s.wordCount,
    0
  )
  const previewSource = prefs.preview && current ? liveDoc.current.toString() : ''
  const shortcutModifier = hermit.platform === 'darwin' ? '⌘' : 'Ctrl+'

  const style = {
    '--editor-font': FONTS[prefs.font],
    '--editor-size': `${prefs.fontSize}px`
  } as CSSProperties

  return (
    <div className={`app platform-${hermit.platform}`} style={style}>
      {prefs.showLibrary && (
        <LibraryPane
          projects={projects.filter((p) => !p.archived)}
          archived={projects.filter((p) => p.archived)}
          folders={folders}
          activeId={projectId}
          renamingId={renamingProject}
          renamingFolder={renamingFolder}
          onSelect={(id) => id !== projectId && void openProject(id)}
          onNewMenu={(at) => void showLibraryNewMenu(at)}
          onOpenSettings={() => openSettings('appearance')}
          onRename={(id, name) => void renameProject(id, name)}
          onRenameEnd={() => {
            setRenamingProject(null)
            setRenamingFolder(null)
          }}
          onStartRename={setRenamingProject}
          onRenameFolder={(folder, name) => void renameFolder(folder, name)}
          onStartRenameFolder={setRenamingFolder}
          onContextMenu={(id) => void showProjectMenu(id)}
          onFolderMenu={(folder) => void showFolderMenu(folder)}
          onLibraryMenu={() => void showLibraryMenu()}
          onDropSheet={(sheetId, from, to) => void moveSheet(sheetId, from, to)}
          onMove={(libraryPath, folder) => void moveInLibrary(libraryPath, folder)}
          onArchive={(id) => void archiveProject(id)}
        />
      )}

      {prefs.showSheets && (
        <SheetListPane
          projectId={projectId}
          projectName={project?.name ?? 'No Project'}
          section={section}
          archiveOpen={archiveOpen}
          counts={sectionCounts}
          sheets={visibleSheets}
          items={sectionOutline}
          renamingSubsection={renamingSubsection}
          renamingSheet={renamingSheet}
          totalWords={totalWords}
          activeId={current?.sheet.id ?? null}
          query={query}
          onQueryChange={setQuery}
          onSectionChange={(s) => void switchSection(s)}
          onOpenArchive={() => void openArchive()}
          onArchive={(item) => void archiveItem(item)}
          onSelect={(id) => projectId && id !== current?.sheet.id && void openSheet(projectId, id)}
          onCreate={(place) => void createSheet('', place)}
          onNewMenu={(at) => void showNewMenu(at)}
          onCreateCanvas={() => void createCanvas()}
          onStartRenameSubsection={setRenamingSubsection}
          onRenameSubsection={(from, name) => void renameSubsection(from, name)}
          onRenameSubsectionEnd={() => setRenamingSubsection(null)}
          onStartRenameSheet={setRenamingSheet}
          onRenameSheet={(id, name) => void renameCanvas(id, name)}
          onRenameSheetEnd={() => setRenamingSheet(null)}
          onSubsectionMenu={(name) => void showSubsectionMenu(name)}
          onSectionMenu={(s) => void showSectionMenu(s)}
          onMove={(item, target) => void moveItem(item, target)}
          onContextMenu={(id) => void showSheetMenu(id)}
          onOpenProjectSettings={() => projectId && setProjectSettingsFor(projectId)}
        />
      )}

      <main className={`pane editor${prefs.focus ? ' focus-mode' : ''}`}>
        {/* Toolbar clicks shouldn't pull focus out of the editor. */}
        <header className="pane-header editor-toolbar" onMouseDown={(e) => e.preventDefault()}>
          <div className="pane-toggles" role="group" aria-label="Navigation panes">
            <button
              className={`icon-button${prefs.showLibrary ? ' on' : ''}`}
              onClick={() => togglePref('showLibrary')}
              aria-label={`${prefs.showLibrary ? 'Hide' : 'Show'} projects sidebar`}
              aria-pressed={prefs.showLibrary}
              title={`${prefs.showLibrary ? 'Hide' : 'Show'} projects sidebar (${shortcutModifier}1)`}
            >
              <SidebarIcon />
            </button>
            <button
              className={`icon-button${prefs.showSheets ? ' on' : ''}`}
              onClick={() => togglePref('showSheets')}
              aria-label={`${prefs.showSheets ? 'Hide' : 'Show'} sheets list`}
              aria-pressed={prefs.showSheets}
              title={`${prefs.showSheets ? 'Hide' : 'Show'} sheets list (${shortcutModifier}2)`}
            >
              <SheetsIcon />
            </button>
          </div>
          <div className="toolbar-spacer" />
          {(current?.sheet.section === 'notes' || current?.sheet.subsection) && (
            <span className="place-label">{placeName(current.sheet)}</span>
          )}
          <div className="toolbar-modes">
            <button
              className={`icon-button${prefs.focus ? ' on' : ''}`}
              onClick={toggleFocus}
              title="Focus Mode (⇧⌘F)"
            >
              <FocusIcon />
            </button>
            <button
              className={`icon-button${prefs.typewriter ? ' on' : ''}`}
              onClick={() => togglePref('typewriter')}
              disabled={onCanvas}
              title="Typewriter Mode (⇧⌘T)"
            >
              <TypewriterIcon />
            </button>
            <button
              className={`icon-button${prefs.preview ? ' on' : ''}`}
              onClick={() => togglePref('preview')}
              disabled={!current || onCanvas}
              title="Preview (⇧⌘P)"
            >
              <EyeIcon />
            </button>
          </div>
        </header>

        {current?.sheet.archived && (
          <div className="archive-banner">
            <span>Archived from {placeName(current.sheet)}.</span>
            <button className="ghost-button" onClick={() => void restoreSheet(current.sheet.id)}>
              Restore
            </button>
          </div>
        )}

        {conflicted && (
          <div className="conflict-banner">
            <span>This sheet changed here and on GitHub. It’s read-only until the conflict is resolved.</span>
            <button className="ghost-button" onClick={openMerge}>
              Resolve…
            </button>
          </div>
        )}

        <div className="editor-body">
          {current && onCanvas ? (
            <CanvasView
              key={current.key}
              projectId={current.projectId}
              sheetId={current.sheet.id}
              content={current.sheet.content}
              sheets={sheets}
              readOnly={conflicted}
              onChange={handleChange}
              onOpenSheet={(id) => void openSheet(current.projectId, id)}
            />
          ) : current ? (
            <>
              <Editor
                ref={editor}
                docKey={current.key}
                content={current.sheet.content}
                format={sheetFormat}
                focus={prefs.focus}
                typewriter={prefs.typewriter}
                grammar={prefs.grammar ? prefs.dialect : null}
                fontKey={`${prefs.font}:${prefs.fontSize}`}
                hidden={prefs.preview}
                readOnly={conflicted}
                onChange={handleChange}
              />
              {prefs.preview && <Preview text={previewSource} format={sheetFormat} />}
            </>
          ) : (
            ready && (
              <div className="editor-empty">
                {libraryError && projects.length === 0 ? (
                  <>
                    <p className="editor-empty-error">{libraryError}</p>
                    <div className="field-row">
                      <button className="primary-button" onClick={() => void init()}>
                        Try Again
                      </button>
                      <button className="ghost-button" onClick={() => openSettings('library')}>
                        Change Location…
                      </button>
                    </div>
                  </>
                ) : projects.length === 0 ? (
                  <>
                    <p>Your library is empty.</p>
                    <button className="primary-button" onClick={() => void createProject()}>
                      <PlusIcon /> New Project
                    </button>
                  </>
                ) : archiveOpen ? (
                  <p>Nothing from the archive is open.</p>
                ) : (
                  <>
                    <p>{section === 'notes' ? 'No note selected.' : 'No sheet selected.'}</p>
                    <button className="primary-button" onClick={() => void createSheet()}>
                      <PlusIcon /> New {SECTION_NAMES[section].item}
                    </button>
                  </>
                )}
              </div>
            )
          )}
        </div>

        {current && (
          <footer className="status-bar">
            {stats.canvas !== undefined ? (
              <span>{stats.canvas}</span>
            ) : (
              <>
                <span>{formatCount(stats.words, 'word')}</span>
                <span>{formatCount(stats.chars, 'character')}</span>
                <span>{readingMinutes(stats.words)} min read</span>
              </>
            )}
            <span className={`save-state ${saveState}`}>
              {saveState === 'saved' ? 'Saved' : saveState === 'error' ? 'Not saved — retrying on next edit' : 'Saving…'}
            </span>
            {syncLabel(sync) && (
              <button
                className={`sync-state ${sync!.status}`}
                onClick={syncStatusClick}
                title={
                  sync!.status === 'idle' && sync!.lastSyncedAt
                    ? `Synced with GitHub ${timeAgo(sync!.lastSyncedAt)}`
                    : (sync!.message ?? 'GitHub sync')
                }
              >
                {syncLabel(sync)}
              </button>
            )}
          </footer>
        )}
      </main>

      {settingsOpen && (
        <SettingsOverlay
          tab={settingsTab}
          onTabChange={setSettingsTab}
          theme={theme}
          onChange={setTheme}
          grammar={{ grammar: prefs.grammar, dialect: prefs.dialect }}
          onGrammarChange={(patch) => setPrefs((p) => ({ ...p, ...patch }))}
          sync={sync}
          onOpenMerge={openMerge}
          onClose={closeSettings}
        />
      )}
      {settingsProject && (
        <ProjectSettings
          project={settingsProject}
          onChange={(patch) => void updateProjectSettings(settingsProject.id, patch)}
          onClose={closeProjectSettings}
        />
      )}
      {mergeOpen && sync && <MergeEditor sync={sync} onClose={closeMerge} />}
    </div>
  )
}
