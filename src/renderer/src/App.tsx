import type { Text } from '@codemirror/state'
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent
} from 'react'
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
import { ElementPicker } from './components/ElementPicker'
import { FormatBar } from './components/FormatBar'
import {
  BackIcon,
  CloseIcon,
  EyeIcon,
  FocusIcon,
  MoreIcon,
  PlusIcon,
  SheetsIcon,
  SidebarIcon,
  SplitDownIcon,
  SplitRightIcon,
  TypewriterIcon
} from './components/Icons'
import { LibraryPane } from './components/LibraryPane'
import { MergeEditor } from './components/MergeEditor'
import { Preview } from './components/Preview'
import { ProjectSettings } from './components/ProjectSettings'
import { SettingsOverlay, type SettingsTab } from './components/SettingsOverlay'
import { SheetListPane } from './components/SheetListPane'
import { touch, useCompact, useFocusWithin } from './device'
import { formatCommands, type FormatCommand } from './editor/extensions'
import { setScreenplayElement, type CurrentElement, type ScreenplayElement } from './editor/fountain'
import { defaultDialect, type GrammarDialect } from './editor/grammar'
import { formatCount } from './format'
import { isWithin, otherSection, placeName, samePlace, SECTION_NAMES } from './sections'
import { sheetPath, syncLabel, timeAgo, useSyncState } from './sync'
import { useThemedIcon } from './icon'
import { useTheme } from './theme'

const hermit = window.hermit

type EditorFont = 'sans' | 'serif' | 'mono'

/** How two panes share the editor: side by side, or one above the other. */
type SplitDirection = 'row' | 'column'

interface Prefs {
  showLibrary: boolean
  showSheets: boolean
  focus: boolean
  // Side panes as they were when focus mode began, restored on exit.
  panesBeforeFocus: { showLibrary: boolean; showSheets: boolean } | null
  typewriter: boolean
  grammar: boolean
  dialect: GrammarDialect
  font: EditorFont
  fontSize: number
  split: SplitDirection
  /** The first pane's share of the editor when it's split. */
  splitRatio: number
}

const DEFAULT_PREFS: Prefs = {
  // A narrow iPad has room for the sheet list beside the editor, but not the library too.
  showLibrary: !(touch && window.innerWidth < 1000),
  showSheets: true,
  focus: false,
  panesBeforeFocus: null,
  typewriter: false,
  grammar: true,
  dialect: defaultDialect(),
  font: 'sans',
  fontSize: 17,
  split: 'row',
  splitRatio: 0.5
}

const FONTS: Record<EditorFont, string> = {
  sans: 'var(--font-ui)',
  serif: 'var(--font-serif)',
  mono: 'var(--font-mono)'
}

const PREFS_KEY = 'hermit:prefs'
/** Where things were left: overall, and with the collection's name after a colon, in each collection. */
const LAST_KEY = 'hermit:last'

interface Last {
  /** Missing from before collections. */
  collection?: string
  /** The sheet in the pane last worked in. */
  projectId?: string
  sheetId?: string
  /** Every pane's sheet, in order, and which of them was last worked in. Missing from before split panes. */
  panes?: { projectId: string; sheetId: string; preview?: boolean }[]
  active?: number
}

/** Where things were left in a collection. */
function lastIn(collection: string): Last {
  const latest = loadJson<Last>(LAST_KEY, {})
  const fallback = !latest.collection || latest.collection === collection ? latest : {}
  return loadJson<Last>(`${LAST_KEY}:${collection}`, fallback)
}

/** On a phone the panes show one at a time, like screens. */
type Screen = 'library' | 'sheets' | 'editor'

/** There's no Trash on iOS, so things there are deleted outright. */
const TRASH_LABEL = touch ? 'Delete…' : 'Move to Trash…'

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

/** Unsaved text, waiting to be written. A canvas's edits arrive as its whole file. */
interface SaveJob {
  projectId: string
  sheetId: string
  doc: Text | string
}

/** What the status bar counts: words and characters, or for a canvas, its cards and connections. */
interface Stats {
  words: number
  chars: number
  canvas?: string
}

/** One side of the editor, when it's split; the whole of it otherwise. */
interface Pane {
  id: number
  open: OpenSheet | null
  preview: boolean
  stats: Stats
  /** The screenplay element the caret is in, or null outside a screenplay. */
  element: CurrentElement | null
}

let paneCount = 0
const newPane = (preview = false): Pane => ({
  id: ++paneCount,
  open: null,
  preview,
  stats: { words: 0, chars: 0 },
  element: null
})

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
  // The project the sheet list shows: the active pane's.
  const [projectId, setProjectId] = useState<string | null>(null)
  const projectIdRef = useRef<string | null>(null)
  // Every sheet in the project, both sections; the list shows the active section's.
  const [sheets, setSheets] = useState<SheetSummary[]>([])
  // Every sheet of each project loaded so far, for a canvas in a pane whose project the list isn't showing.
  const [sheetCache, setSheetCache] = useState<Record<string, SheetSummary[]>>({})
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
  // The editor's panes, in order: one, or two when it's split. The refs are always up to date; the state follows.
  const [panes, setPanes] = useState<Pane[]>(() => [newPane()])
  const panesRef = useRef(panes)
  // The pane the sheet list, toolbar and menus act on.
  const [activeId, setActiveId] = useState(panes[0].id)
  const activeRef = useRef(activeId)
  const [folders, setFolders] = useState<string[]>([])
  const [renamingProject, setRenamingProject] = useState<string | null>(null)
  const [renamingFolder, setRenamingFolder] = useState<string | null>(null)
  // Every collection in the library, and the open one, whose projects the library shows.
  const [collections, setCollections] = useState<string[]>([])
  const [collection, setCollection] = useState('')
  const collectionRef = useRef('')
  const [renamingCollection, setRenamingCollection] = useState(false)
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState<Set<string> | null>(null)
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
  const compact = useCompact()
  // Back where things were left: the sheet that was open, or the library.
  const [screen, setScreen] = useState<Screen>(() =>
    loadJson<{ sheetId?: string }>(LAST_KEY, {}).sheetId ? 'editor' : 'library'
  )
  const editorFocused = useFocusWithin('.editor-host')

  // Each text pane's editor, by pane.
  const editors = useRef(new Map<number, EditorHandle>())
  // Unsaved edits, by pane.
  const pending = useRef(new Map<number, SaveJob>())
  // Each pane's text as it stands, for previewing it.
  const liveDocs = useRef(new Map<number, Text | string>())
  const saveTimer = useRef<number | undefined>(undefined)
  const statsTimers = useRef(new Map<number, number>())
  const loadSeq = useRef(0)
  // The latest load into each pane, so a slower earlier one doesn't land on top of it.
  const paneLoads = useRef(new Map<number, number>())
  // The sheet last open in each project section and archive, for a new pane to open beside the one in another.
  const lastInSection = useRef(new Map<string, string>())

  useEffect(() => localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)), [prefs])

  // The pane being worked in, and what it shows.
  const activePane = panes.find((p) => p.id === activeId) ?? panes[0]
  const current = activePane.open
  const split = panes.length > 1 && !compact

  const setPaneList = (next: Pane[]) => {
    panesRef.current = next
    setPanes(next)
  }

  const updatePane = (id: number, patch: Partial<Pane> | ((pane: Pane) => Partial<Pane>)) =>
    setPaneList(
      panesRef.current.map((p) => (p.id === id ? { ...p, ...(typeof patch === 'function' ? patch(p) : patch) } : p))
    )

  const setActive = (id: number) => {
    activeRef.current = id
    setActiveId(id)
  }

  /** Note each pane's sheet, so the app, and its collection, open on them next time. */
  const remember = () => {
    const open = panesRef.current.flatMap((p) => (p.open ? [p] : []))
    const active = open.find((p) => p.id === activeRef.current)?.open
    if (!active) return
    const last: Last = {
      collection: collectionRef.current,
      projectId: active.projectId,
      sheetId: active.sheet.id,
      panes: open.map((p) => ({ projectId: p.open!.projectId, sheetId: p.open!.sheet.id, preview: p.preview })),
      active: open.findIndex((p) => p.id === activeRef.current)
    }
    localStorage.setItem(LAST_KEY, JSON.stringify(last))
    localStorage.setItem(`${LAST_KEY}:${collectionRef.current}`, JSON.stringify(last))
  }

  const layoutKey = JSON.stringify([activeId, panes.map((p) => [p.open?.projectId, p.open?.sheet.id, p.preview])])
  useEffect(() => {
    if (ready) remember()
  }, [layoutKey, ready])

  // ── Saving ────────────────────────────────────────────────────────────────

  const flush = useCallback(async () => {
    window.clearTimeout(saveTimer.current)
    const jobs = [...pending.current]
    if (!jobs.length) return
    pending.current.clear()
    setSaveState('saving')
    let failed = false
    for (const [paneId, job] of jobs) {
      try {
        const summary = await hermit.writeSheet(job.projectId, job.sheetId, job.doc.toString())
        const replace = (prev: SheetSummary[]) => prev.map((s) => (s.id === summary.id ? summary : s))
        setSheetCache((c) => (c[job.projectId] ? { ...c, [job.projectId]: replace(c[job.projectId]) } : c))
        if (job.projectId !== projectIdRef.current) continue
        if (summary.archived) setArchived(replace)
        else setSheets(replace)
      } catch (err) {
        console.error('Save failed', err)
        if (!pending.current.has(paneId)) pending.current.set(paneId, job)
        failed = true
      }
    }
    setSaveState(failed ? 'error' : pending.current.size ? 'unsaved' : 'saved')
  }, [])

  /** Forget unsaved edits for sheets that are about to disappear (deleted or moved). */
  const discardPending = (match: (p: SaveJob) => boolean) => {
    const jobs = pending.current
    const before = jobs.size
    for (const [paneId, job] of jobs) if (match(job)) jobs.delete(paneId)
    if (jobs.size === before) return
    if (!jobs.size) window.clearTimeout(saveTimer.current)
    setSaveState(jobs.size ? 'unsaved' : 'saved')
  }

  const handleChange = (paneId: number, open: OpenSheet, doc: Text | string) => {
    const sheetId = open.sheet.id
    pending.current.set(paneId, { projectId: open.projectId, sheetId, doc })
    liveDocs.current.set(paneId, doc)
    setSaveState('unsaved')
    window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(flush, 600)
    const timers = statsTimers.current
    window.clearTimeout(timers.get(paneId))
    timers.set(
      paneId,
      window.setTimeout(() => updatePane(paneId, { stats: statsOf(sheetId, doc.toString()) }), 150)
    )
  }

  // ── Loading ───────────────────────────────────────────────────────────────

  /** On failure, keeps the last lists and reports why instead of throwing. */
  const refreshProjects = useCallback(async () => {
    try {
      const { names, active } = await hermit.listCollections()
      collectionRef.current = active
      setCollections(names)
      setCollection(active)
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

  /** A project's sheets, for a pane showing it; the sheet list too, if it's the project there. */
  const refreshSheets = useCallback(async (pid: string) => {
    const result = await hermit.listOutline(pid)
    setSheetCache((c) => ({ ...c, [pid]: result.sheets }))
    if (pid !== projectIdRef.current) return result
    setSheets(result.sheets)
    setOutline(result.items)
    setArchived(result.archived)
    return result
  }, [])

  /** Show a project in the sheet list, without opening anything. */
  const showProject = useCallback(
    (pid: string | null) => {
      if (pid === projectIdRef.current) return
      projectIdRef.current = pid
      setProjectId(pid)
      setQuery('')
      if (pid) void refreshSheets(pid)
    },
    [refreshSheets]
  )

  /** Work in another pane: the sheet list moves to where its sheet lives. */
  const activatePane = useCallback(
    (id: number) => {
      if (id === activeRef.current) return
      setActive(id)
      const open = panesRef.current.find((p) => p.id === id)?.open
      if (!open) return
      showProject(open.projectId)
      setArchiveOpen(open.sheet.archived)
      if (!open.sheet.archived) setSection(open.sheet.section)
    },
    [showProject]
  )

  /** Open a sheet in a pane, the active one unless told otherwise. A sheet open in another pane is gone to there. */
  const openSheet = useCallback(
    async (pid: string, sheetId: string | null, paneId = activeRef.current) => {
      await flush()
      const seq = ++loadSeq.current
      paneLoads.current.set(paneId, seq)
      if (!sheetId) {
        updatePane(paneId, { open: null })
        return
      }
      const elsewhere = panesRef.current.find(
        (p) => p.id !== paneId && p.open?.projectId === pid && p.open.sheet.id === sheetId
      )
      if (elsewhere) {
        activatePane(elsewhere.id)
        return
      }
      const sheet = await hermit.readSheet(pid, sheetId)
      if (paneLoads.current.get(paneId) !== seq) return
      liveDocs.current.set(paneId, sheet.content)
      updatePane(paneId, {
        open: { projectId: pid, sheet, key: `${pid}/${sheetId}#${seq}` },
        stats: statsOf(sheet.id, sheet.content)
      })
      lastInSection.current.set(viewKey(pid, sheet), sheetId)
      if (paneId !== activeRef.current) return
      showProject(pid)
      setArchiveOpen(sheet.archived)
      if (!sheet.archived) setSection(sheet.section)
    },
    [flush, activatePane, showProject]
  )

  const openProject = useCallback(
    async (pid: string | null, preferredSheet?: string | null) => {
      await flush()
      projectIdRef.current = pid
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

  /** Open the panes last open in the collection, from its list of projects. */
  const resume = useCallback(
    async (list: ProjectSummary[]) => {
      const last = lastIn(collectionRef.current)
      const exists = (pid?: string) => list.some((p) => p.id === pid)
      const layout = (last.panes ?? []).filter((p) => exists(p.projectId))
      const index = Math.max(0, Math.min(last.active ?? 0, layout.length - 1))
      const fresh = layout.length > 1 ? layout.map((p) => newPane(p.preview)) : [newPane(layout[0]?.preview)]
      pending.current.clear()
      setPaneList(fresh)
      setActive(fresh[Math.min(index, fresh.length - 1)].id)
      await openProject(exists(last.projectId) ? last.projectId! : firstActive(list), last.sheetId)
      if (fresh.length < 2) return
      for (const [i, saved] of layout.entries()) {
        if (i === index) continue
        try {
          await openSheet(saved.projectId, saved.sheetId, fresh[i].id)
          if (saved.projectId !== projectIdRef.current) await refreshSheets(saved.projectId)
        } catch (err) {
          console.error('Reopening a pane failed', err)
        }
      }
      // A pane that couldn't be filled again goes.
      const filled = panesRef.current.filter((p) => p.open)
      if (!filled.length || filled.length === panesRef.current.length) return
      setPaneList(filled)
      if (!filled.some((p) => p.id === activeRef.current)) activatePane(filled[0].id)
    },
    [openProject, openSheet, refreshSheets, activatePane]
  )

  const init = useCallback(async () => {
    await resume(await refreshProjects())
    setReady(true)
  }, [resume, refreshProjects])

  useEffect(() => {
    void init()
  }, [init])

  // ── Sync ──────────────────────────────────────────────────────────────────

  /** A pull changed files on disk: refresh the lists and the open sheets. */
  const handleSyncChanged = async (paths: string[]) => {
    const was = collectionRef.current
    const list = await refreshProjects()
    // The open collection went, so another opened in its place.
    if (collectionRef.current !== was) {
      await resume(list)
      return
    }
    const exists = (pid: string) => list.some((p) => p.id === pid)
    dropPanes((pid) => !exists(pid))
    if (!projectIdRef.current || !exists(projectIdRef.current)) {
      await openProject(firstActive(list))
      return
    }
    const outlines = new Map<string, Awaited<ReturnType<typeof refreshSheets>>>()
    for (const pid of new Set([projectIdRef.current, ...panesRef.current.flatMap((p) => p.open?.projectId ?? [])])) {
      outlines.set(pid, await refreshSheets(pid))
    }
    for (const pane of [...panesRef.current]) {
      const open = pane.open
      if (!open || !paths.includes(sheetPath(collectionRef.current, open.projectId, open.sheet.id))) continue
      const { projectId: pid, sheet: stale } = open
      const { sheets: sheetList, archived: archivedList } = outlines.get(pid)!
      // Anything typed in the moment since sync saved this sheet would overwrite what was just pulled.
      discardPending((p) => p.projectId === pid && p.sheetId === stale.id)
      if (![...sheetList, ...archivedList].some((s) => s.id === stale.id)) {
        const taken = openElsewhere(pane.id, pid)
        const fallback = (stale.archived ? archivedList : sheetList.filter((s) => s.section === stale.section)).find(
          (s) => !taken.has(s.id)
        )
        await openSheet(pid, fallback?.id ?? null, pane.id)
        continue
      }
      const sheet = await hermit.readSheet(pid, stale.id)
      liveDocs.current.set(pane.id, sheet.content)
      updatePane(pane.id, { stats: statsOf(stale.id, sheet.content) })
      // A canvas starts over from the new file; the editor keeps its place in the text.
      if (isCanvasId(stale.id)) {
        updatePane(pane.id, { open: { projectId: pid, sheet, key: `${pid}/${stale.id}#${++loadSeq.current}` } })
      } else editors.current.get(pane.id)?.replaceContent(sheet.content)
    }
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

  const isConflicted = (open: OpenSheet | null) =>
    Boolean(open && sync?.conflicts.includes(sheetPath(collection, open.projectId, open.sheet.id)))
  const conflicted = isConflicted(current)
  const onCanvas = Boolean(current && isCanvasId(current.sheet.id))
  const preview = activePane.preview && Boolean(current) && !onCanvas

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
    setScreen('library')
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
    for (const job of pending.current.values()) job.projectId = remap(job.projectId)
    if (projectIdRef.current) {
      projectIdRef.current = remap(projectIdRef.current)
      setProjectId(projectIdRef.current)
    }
    setPaneList(panesRef.current.map((p) => (p.open ? { ...p, open: { ...p.open, projectId: remap(p.open.projectId) } } : p)))
  }

  /** Sheets open in panes other than this one, in a project. */
  const openElsewhere = (paneId: number, pid: string) =>
    new Set(panesRef.current.flatMap((p) => (p.id !== paneId && p.open?.projectId === pid ? [p.open.sheet.id] : [])))

  /** Close a pane, and work on in the one left. Anything typed in it still saves. */
  const closePane = (id: number) => {
    const rest = panesRef.current.filter((p) => p.id !== id)
    if (!rest.length) return
    liveDocs.current.delete(id)
    setPaneList(rest)
    if (activeRef.current === id) activatePane(rest[0].id)
  }

  /** Projects that are gone take their panes with them: closed if another's open, emptied if not. */
  const dropPanes = (gone: (pid: string) => boolean) => {
    for (const pane of [...panesRef.current]) {
      if (!pane.open || !gone(pane.open.projectId)) continue
      if (panesRef.current.length > 1) closePane(pane.id)
      else updatePane(pane.id, { open: null })
    }
  }

  /**
   * Split the editor, or turn the split the other way. The new pane opens beside the one being worked in with the
   * other side of the project: the notes beside the content, or the content beside the notes.
   */
  const splitEditor = async (direction: SplitDirection) => {
    setPrefs((p) => ({ ...p, split: direction }))
    if (compact || panesRef.current.length > 1) return
    await flush()
    const from = current?.sheet
    const pane = newPane()
    setPaneList([...panesRef.current, pane])
    setActive(pane.id)
    if (!projectId) return
    const to = from && !from.archived ? otherSection(from.section) : section
    const inSection = sheets.filter((s) => s.section === to && s.id !== from?.id)
    const last = lastInSection.current.get(`${projectId}:${to}`)
    const target = inSection.find((s) => s.id === last) ?? inSection[0]
    setArchiveOpen(false)
    setSection(to)
    if (target) await openSheet(projectId, target.id, pane.id)
  }

  /** Open a sheet in the other pane, splitting the editor first if it isn't. */
  const openBeside = async (pid: string, sheetId: string) => {
    if (compact) return
    await flush()
    let other = panesRef.current.find((p) => p.id !== activeRef.current)
    if (!other) {
      other = newPane()
      setPaneList([...panesRef.current, other])
    }
    setActive(other.id)
    await openSheet(pid, sheetId, other.id)
  }

  /** Move to the next pane along, and put the caret there. */
  const focusOtherPane = () => {
    const list = panesRef.current
    if (list.length < 2) return
    const next = list[(list.findIndex((p) => p.id === activeRef.current) + 1) % list.length]
    activatePane(next.id)
    if (!next.preview) editors.current.get(next.id)?.focus()
  }

  const createFolder = async (parent: string | null = null) => {
    const folder = await hermit.createFolder('New Folder', parent)
    await refreshProjects()
    setPrefs((p) => ({ ...p, showLibrary: true }))
    setScreen('library')
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
    dropPanes(inside)
    if (projectIdRef.current && inside(projectIdRef.current)) await openProject(firstActive(list))
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
    dropPanes((pid) => pid === id)
    if (projectIdRef.current === id) await openProject(firstActive(list))
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
    dropPanes((pid) => pid === id)
    if (projectIdRef.current === id) await openProject(firstActive(list))
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

  // ── Collections ───────────────────────────────────────────────────────────

  /** Open another collection, where it was left. */
  const switchCollection = async (name: string) => {
    if (name === collectionRef.current) return
    await flush()
    // Anything typed since belongs to the collection being left; resuming the next one forgets it.
    setRenamingProject(null)
    setRenamingFolder(null)
    try {
      await hermit.openCollection(name)
    } catch (err) {
      console.error('Opening the collection failed', err)
    }
    await resume(await refreshProjects())
  }

  /** A new collection opens straight away, with its name ready to type. */
  const createCollection = async () => {
    await flush()
    const name = await hermit.createCollection('New Collection')
    await switchCollection(name)
    setPrefs((p) => ({ ...p, showLibrary: true }))
    setScreen('library')
    setRenamingCollection(true)
  }

  const renameCollection = async (name: string) => {
    setRenamingCollection(false)
    const from = collectionRef.current
    await flush()
    try {
      const renamed = await hermit.renameCollection(from, name)
      const last = localStorage.getItem(`${LAST_KEY}:${from}`)
      if (last && renamed !== from) {
        localStorage.setItem(`${LAST_KEY}:${renamed}`, last)
        localStorage.removeItem(`${LAST_KEY}:${from}`)
      }
    } catch (err) {
      console.error('Rename failed', err)
    }
    await refreshProjects()
    remember()
  }

  const deleteCollection = async (name: string) => {
    await flush()
    if (!(await hermit.deleteCollection(name))) return
    localStorage.removeItem(`${LAST_KEY}:${name}`)
    if (name !== collectionRef.current) {
      await refreshProjects()
      return
    }
    await resume(await refreshProjects())
  }

  /** Move a project or folder to another collection. The open project, if it goes, makes way for another. */
  const moveToCollection = async (libraryPath: string, to: string) => {
    await flush()
    try {
      await hermit.moveToCollection(libraryPath, to)
    } catch (err) {
      console.error('Move failed', err)
      return
    }
    const inside = (id: string) => id === libraryPath || id.startsWith(`${libraryPath}/`)
    discardPending((p) => inside(p.projectId))
    const list = await refreshProjects()
    dropPanes(inside)
    if (projectIdRef.current && inside(projectIdRef.current)) await openProject(firstActive(list))
  }

  /** The switcher at the foot of the library: every collection, and what can be done with the open one. */
  const showCollectionMenu = async (at: { x: number; y: number }) => {
    const choice = await hermit.showContextMenu(
      [
        ...collections.map((name, i) => ({ id: `open:${i}`, label: `${name === collection ? '✓ ' : ''}${name}` })),
        { type: 'separator' },
        { id: 'new', label: 'New Collection' },
        { id: 'rename', label: 'Rename Collection' },
        {
          id: 'delete',
          label: touch ? 'Delete Collection…' : 'Move Collection to Trash…',
          enabled: collections.length > 1
        }
      ],
      at
    )
    if (choice?.startsWith('open:')) void switchCollection(collections[Number(choice.slice(5))])
    else if (choice === 'new') void createCollection()
    else if (choice === 'rename') setRenamingCollection(true)
    else if (choice === 'delete') void deleteCollection(collection)
  }

  /** Menu items to move a project or folder to each other collection, with ids `collection:<index>`. */
  const collectionItems = (): ContextMenuEntry[] => {
    const others = collections.filter((c) => c !== collection)
    if (!others.length) return []
    return [
      { type: 'separator' },
      ...others.map((name) => ({ id: `collection:${collections.indexOf(name)}`, label: `Move to “${name}”` }))
    ]
  }

  /** New sheets go after the open one, or at the end of `place` when given. */
  const createSheet = async (content = '', place?: SheetPlace) => {
    let pid = projectId
    if (!pid) {
      const project = await hermit.createProject('Untitled Project')
      await refreshProjects()
      pid = project.id
      projectIdRef.current = pid
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
    setScreen('editor')
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

  /** After sheets leave the list, each pane whose sheet went selects its neighbour in the same section or archive. */
  const selectNeighbour = async (pid: string, removedIds: string[], before: SheetSummary[]) => {
    const { sheets: list, archived: archivedList } = await refreshSheets(pid)
    await refreshProjects()
    for (const pane of [...panesRef.current]) {
      const from = pane.open?.projectId === pid ? pane.open.sheet : null
      if (!from || !removedIds.includes(from.id)) continue
      const taken = openElsewhere(pane.id, pid)
      const sameList = (s: SheetSummary) => s.archived === from.archived && (from.archived || s.section === from.section)
      const index = before.filter(sameList).findIndex((s) => s.id === from.id)
      const remaining = [...list, ...archivedList].filter((s) => sameList(s) && !taken.has(s.id))
      const next = remaining[Math.min(index, remaining.length - 1)]
      await openSheet(pid, next?.id ?? null, pane.id)
    }
  }

  const deleteSheet = async (id: string) => {
    if (!projectId) return
    await flush()
    if (!(await hermit.deleteSheet(projectId, id))) return
    discardPending((p) => p.projectId === projectId && p.sheetId === id)
    await selectNeighbour(projectId, [id], everySheet)
  }

  const moveSheet = async (sheetId: string, from: string, to: string) => {
    await flush()
    discardPending((p) => p.projectId === from && p.sheetId === sheetId)
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
    const following = current?.projectId === pid && current.sheet.id === id
    await retarget(pid, renamed, list)
    if (!following || !restored) return
    setArchiveOpen(false)
    setSection(restored.section)
  }

  /** Open sheets' files moved; keep editing them under their new ids without reloading. */
  const retarget = async (pid: string, renamed: Record<string, string>, list: SheetSummary[]) => {
    if (!Object.keys(renamed).length) return
    for (const pane of [...panesRef.current]) {
      const open = pane.open
      if (open?.projectId !== pid) continue
      const openId = renamed[open.sheet.id] ?? open.sheet.id
      if (isCanvasId(openId)) {
        // Moving sheets rewrites the links on canvases that show them, so open canvases reload.
        const sheet = await hermit.readSheet(pid, openId)
        updatePane(pane.id, { open: { projectId: pid, sheet, key: `${pid}/${openId}#${++loadSeq.current}` } })
        lastInSection.current.set(viewKey(pid, sheet), openId)
        continue
      }
      const moved = list.find((s) => s.id === renamed[open.sheet.id])
      if (!moved) continue
      const { id, section: movedTo, subsection, archived: isArchived } = moved
      updatePane(pane.id, {
        open: { ...open, sheet: { ...open.sheet, id, section: movedTo, subsection, archived: isArchived } }
      })
      lastInSection.current.set(viewKey(pid, moved), id)
    }
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
      await retarget(pid, renamed, [])
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
    const pid = projectId
    if (!(await hermit.deleteSubsection(pid, place))) return
    const inside = (open: OpenSheet | null) =>
      open?.projectId === pid &&
      !open.sheet.archived &&
      open.sheet.section === place.section &&
      isWithin(open.sheet.subsection, place.subsection!)
    const gone = panesRef.current.filter((p) => inside(p.open))
    discardPending((p) => gone.some((pane) => pane.open!.sheet.id === p.sheetId && p.projectId === pid))
    const { sheets: list } = await refreshSheets(pid)
    for (const pane of gone) {
      const taken = openElsewhere(pane.id, pid)
      await openSheet(pid, list.find((s) => s.section === place.section && !taken.has(s.id))?.id ?? null, pane.id)
    }
  }

  /** List a section's sheets. The open sheet stays open until another is chosen. */
  const switchSection = (to: Section) => {
    if (!projectId) return
    setArchiveOpen(false)
    setSection(to)
  }

  /** List the archive. The open sheet stays open until another is chosen. */
  const openArchive = () => {
    if (projectId) setArchiveOpen(true)
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

  /** The item before (-1) or after (1) this one among those in the same section or subsection, if there is one. */
  const neighbourOf = (item: OutlineItem, step: -1 | 1): OutlineItem | null => {
    const parentOf = (i: OutlineItem) =>
      i.kind === 'sheet' ? i.subsection : i.subsection.includes('/') ? i.subsection.slice(0, i.subsection.lastIndexOf('/')) : null
    const key = (i: OutlineItem) => (i.kind === 'sheet' ? i.id : `/${i.subsection}`)
    const siblings = outline.filter((i) => i.section === item.section && parentOf(i) === parentOf(item))
    return siblings[siblings.findIndex((i) => key(i) === key(item)) + step] ?? null
  }

  /**
   * Where a project or folder can be moved to, for touch, where there's no dragging: another folder, or the top
   * of the library. Asks which, then moves it.
   */
  const chooseFolderFor = async (libraryPath: string) => {
    const parent = libraryPath.includes('/') ? libraryPath.slice(0, libraryPath.lastIndexOf('/')) : null
    const targets = [null, ...folders].filter(
      (f) => f !== parent && f !== libraryPath && !f?.startsWith(`${libraryPath}/`)
    )
    const choice = await hermit.showContextMenu(
      targets.map((f, i) => ({ id: String(i), label: f === null ? 'Top of the Library' : f.split('/').join(' › ') }))
    )
    if (choice !== null) void moveInLibrary(libraryPath, targets[Number(choice)])
  }

  /** Whether a project or folder has somewhere else to go. */
  const canMoveInLibrary = (libraryPath: string) =>
    libraryPath.includes('/') || folders.some((f) => f !== libraryPath && !f.startsWith(`${libraryPath}/`))

  const showProjectMenu = async (id: string) => {
    const inArchive = projects.find((p) => p.id === id)?.archived
    const choice = await hermit.showContextMenu([
      inArchive ? { id: 'restore', label: 'Restore from Archive' } : { id: 'rename', label: 'Rename' },
      ...(touch ? [] : [{ id: 'reveal', label: 'Show in Finder' }]),
      ...(touch && !inArchive && canMoveInLibrary(id) ? [{ id: 'move', label: 'Move to Folder…' }] : []),
      { id: 'settings', label: 'Project Settings…' },
      { type: 'separator' },
      ...exportItems(formatOf(id)),
      ...(inArchive ? [] : collectionItems()),
      { type: 'separator' },
      ...(inArchive ? [] : [{ id: 'archive', label: 'Archive' }]),
      { id: 'delete', label: TRASH_LABEL }
    ])
    if (choice === 'rename') setRenamingProject(id)
    else if (choice?.startsWith('collection:')) void moveToCollection(id, collections[Number(choice.slice(11))])
    else if (choice === 'move') void chooseFolderFor(id)
    else if (choice === 'archive') void archiveProject(id)
    else if (choice === 'restore') void restoreProject(id)
    else if (choice === 'settings') setProjectSettingsFor(id)
    else if (choice === 'reveal') void hermit.revealProject(id)
    else if (choice === 'delete') void deleteProject(id)
    else if (choice?.startsWith('export-')) void exportSheets(id, null, choice.slice(7) as ExportFormat)
  }

  /** Opening a sheet in the other pane, for one that isn't open in either. */
  const besideItems = (id: string): ContextMenuEntry[] =>
    compact || panes.some((p) => p.open?.projectId === projectId && p.open.sheet.id === id)
      ? []
      : [{ id: 'beside', label: split ? 'Open in Other Pane' : 'Open in Split View' }]

  const showArchivedMenu = async (sheet: SheetSummary) => {
    if (!projectId) return
    const canvas = isCanvasId(sheet.id)
    const choice = await hermit.showContextMenu([
      ...besideItems(sheet.id),
      { id: 'restore', label: `Restore to ${placeName(sheet)}` },
      ...(canvas
        ? []
        : [{ type: 'separator' as const }, ...exportItems(sheet.section === 'content' ? formatOf(projectId) : 'markdown')]),
      { type: 'separator' },
      { id: 'delete', label: TRASH_LABEL }
    ])
    if (choice === 'beside') void openBeside(projectId, sheet.id)
    else if (choice === 'restore') void restoreSheet(sheet.id)
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
    const item: OutlineItem | null = sheet ? { kind: 'sheet', id, section: sheet.section, subsection: sheet.subsection } : null
    const [up, down] = item ? [neighbourOf(item, -1), neighbourOf(item, 1)] : [null, null]
    const choice = await hermit.showContextMenu([
      ...besideItems(id),
      ...(canvas ? [{ id: 'rename', label: 'Rename' }] : []),
      { id: 'duplicate', label: 'Duplicate' },
      ...(touch && up ? [{ id: 'up', label: 'Move Up' }] : []),
      ...(touch && down ? [{ id: 'down', label: 'Move Down' }] : []),
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
      { id: 'delete', label: TRASH_LABEL }
    ])
    if (choice === 'beside') void openBeside(projectId, id)
    else if (choice === 'rename') setRenamingSheet(id)
    else if (choice === 'up' && item && up) void moveItem(item, { before: up })
    else if (choice === 'down' && item && down) void moveItem(item, { after: down })
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
      ...(touch && canMoveInLibrary(folder) ? [{ id: 'move', label: 'Move to Folder…' }] : []),
      ...collectionItems(),
      { type: 'separator' },
      { id: 'delete', label: TRASH_LABEL }
    ])
    if (choice === 'new-project') void createProject(folder)
    else if (choice?.startsWith('collection:')) void moveToCollection(folder, collections[Number(choice.slice(11))])
    else if (choice === 'new-folder') void createFolder(folder)
    else if (choice === 'rename') setRenamingFolder(folder)
    else if (choice === 'move') void chooseFolderFor(folder)
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
      switchSection(to)
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
    const item: OutlineItem | null = place.subsection
      ? { kind: 'subsection', section: place.section, subsection: place.subsection }
      : null
    const [up, down] = item ? [neighbourOf(item, -1), neighbourOf(item, 1)] : [null, null]
    const choice = await hermit.showContextMenu([
      { id: 'new', label: `New ${SECTION_NAMES[place.section].item}` },
      ...(place.section === 'notes' ? [{ id: 'new-canvas', label: 'New Canvas' }] : []),
      { id: 'new-subsection', label: 'New Subsection' },
      { id: 'rename', label: 'Rename' },
      ...(touch && up ? [{ id: 'up', label: 'Move Up' }] : []),
      ...(touch && down ? [{ id: 'down', label: 'Move Down' }] : []),
      { type: 'separator' },
      { id: 'archive', label: 'Archive' },
      { id: 'delete', label: TRASH_LABEL }
    ])
    if (choice === 'up' && item && up) return void moveItem(item, { before: up })
    if (choice === 'down' && item && down) return void moveItem(item, { after: down })
    if (choice === 'new') void createSheet('', place)
    else if (choice === 'new-canvas') void createCanvas(place)
    else if (choice === 'new-subsection') void createSubsection(place)
    else if (choice === 'rename') setRenamingSubsection(place.subsection)
    else if (choice === 'archive' && place.subsection) {
      void archiveItem({ kind: 'subsection', section: place.section, subsection: place.subsection })
    }
    else if (choice === 'delete') void deleteSubsection(place)
  }

  const togglePref = (key: 'showLibrary' | 'showSheets' | 'typewriter' | 'grammar') =>
    setPrefs((p) => ({ ...p, [key]: !p[key] }))

  const togglePreview = () => {
    if (current && !onCanvas) updatePane(activeRef.current, (p) => ({ preview: !p.preview }))
  }

  /** Put the caret back in the pane being worked in, unless it's previewing. */
  const focusEditor = () => {
    if (!preview) editors.current.get(activeRef.current)?.focus()
  }

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
    focusEditor()
  }

  const openMerge = () => {
    setSettingsOpen(false)
    setMergeOpen(true)
  }

  const closeProjectSettings = () => {
    setProjectSettingsFor(null)
    focusEditor()
  }

  const closeMerge = () => {
    setMergeOpen(false)
    focusEditor()
  }

  /** The toolbar's split button: which way to split, or once split, which way it runs and closing a pane. */
  const showSplitMenu = async (at: { x: number; y: number }) => {
    const check = (on: boolean, label: string) => `${on ? '✓ ' : ''}${label}`
    const choice = await hermit.showContextMenu(
      split
        ? [
            { id: 'split-right', label: check(prefs.split === 'row', 'Side by Side') },
            { id: 'split-down', label: check(prefs.split === 'column', 'Top and Bottom') },
            { type: 'separator' },
            { id: 'close-pane', label: 'Close Pane' }
          ]
        : [
            { id: 'split-right', label: 'Split Side by Side' },
            { id: 'split-down', label: 'Split Top and Bottom' }
          ],
      at
    )
    if (choice) handleMenu(choice as MenuAction)
  }

  const syncStatusClick = () => {
    if (sync?.status === 'conflict' || sync?.status === 'resolving') openMerge()
    else openSettings('sync')
  }

  const saveLabel = saveState === 'saved' ? 'Saved' : saveState === 'error' ? 'Not saved — retrying on next edit' : 'Saving…'

  /** What a phone's status bar shouts about; anything else waits in its sheet. */
  const statusProblem =
    saveState === 'error'
      ? { label: 'Not saved', tone: 'error' }
      : sync?.status === 'conflict'
        ? { label: 'Sync conflict', tone: 'conflict' }
        : sync?.status === 'error'
          ? { label: 'Not synced', tone: 'error' }
          : null

  /** A phone's status bar has room for a word count; the rest of it is a tap away. */
  const showStatusSheet = async () => {
    const { stats } = activePane
    const counts =
      stats.canvas ??
      [formatCount(stats.words, 'word'), formatCount(stats.chars, 'character'), `${readingMinutes(stats.words)} min read`].join(
        ' · '
      )
    const synced = !syncLabel(sync)
      ? null
      : sync!.status === 'idle' && sync!.lastSyncedAt
        ? `Synced with GitHub ${timeAgo(sync!.lastSyncedAt)}`
        : (sync!.message ?? syncLabel(sync))
    const resolving = sync?.status === 'conflict' || sync?.status === 'resolving'
    const choice = await hermit.showContextMenu(
      [
        ...(sync?.remoteUrl && sync.settings.enabled ? [{ id: 'sync-now', label: 'Sync Now' }] : []),
        ...(syncLabel(sync) ? [{ id: 'sync', label: resolving ? 'Resolve Conflict…' : 'Sync Settings…' }] : [])
      ],
      undefined,
      { title: counts, message: [saveLabel, synced].filter(Boolean).join('\n'), dismiss: 'Done' }
    )
    if (choice === 'sync-now') handleMenu('sync-now')
    else if (choice === 'sync') syncStatusClick()
  }

  const handleMenu = (action: MenuAction) => {
    // The editor sits under the settings overlay; don't edit it blind.
    const editable = !preview && !settingsOpen && !projectSettingsFor && !mergeOpen && !conflicted && !onCanvas
    const editor = editors.current.get(activeRef.current)
    const run = (cmd: FormatCommand) => {
      const command = formatCommands[sheetFormat][cmd]
      if (editable && command) editor?.run(command)
    }
    const setElementTo = (type: ScreenplayElement) => {
      if (editable && sheetFormat === 'fountain') editor?.run(setScreenplayElement(type))
    }
    switch (action) {
      case 'new-sheet': return void createSheet()
      case 'new-canvas': return void createCanvas()
      case 'new-project': return void createProject()
      case 'export-sheet': return current && !onCanvas && void exportSheets(current.projectId, [current.sheet.id])
      case 'export-project': return projectId && void exportSheets(projectId, null)
      case 'project-settings': return projectId && setProjectSettingsFor(projectId)
      case 'toggle-library': return compact ? setScreen('library') : togglePref('showLibrary')
      case 'toggle-sheets': return compact ? setScreen('sheets') : togglePref('showSheets')
      case 'toggle-sidebars': return toggleSidebars()
      case 'toggle-section': return switchSection(archiveOpen ? section : otherSection(section))
      case 'toggle-preview': return togglePreview()
      case 'toggle-focus': return toggleFocus()
      case 'toggle-typewriter': return togglePref('typewriter')
      case 'toggle-grammar': return togglePref('grammar')
      case 'split-right': return void splitEditor('row')
      case 'split-down': return void splitEditor('column')
      case 'focus-other-pane': return focusOtherPane()
      case 'close-pane': return split && closePane(activeRef.current)
      case 'font-sans': return setPrefs((p) => ({ ...p, font: 'sans' }))
      case 'font-serif': return setPrefs((p) => ({ ...p, font: 'serif' }))
      case 'font-mono': return setPrefs((p) => ({ ...p, font: 'mono' }))
      case 'font-bigger': return setPrefs((p) => ({ ...p, fontSize: Math.min(30, p.fontSize + 1) }))
      case 'font-smaller': return setPrefs((p) => ({ ...p, fontSize: Math.max(12, p.fontSize - 1) }))
      case 'font-reset': return setPrefs((p) => ({ ...p, fontSize: DEFAULT_PREFS.fontSize }))
      case 'find': return editable && editor?.openSearch()
      case 'next-sheet': return stepSheet(1)
      case 'prev-sheet': return stepSheet(-1)
      case 'format-bold': return run('bold')
      case 'format-italic': return run('italic')
      case 'format-code': return run('code')
      case 'format-link': return run('link')
      case 'format-heading': return run('heading')
      case 'format-quote': return run('quote')
      case 'element-scene': return setElementTo('scene')
      case 'element-action': return setElementTo('action')
      case 'element-character': return setElementTo('character')
      case 'element-parenthetical': return setElementTo('parenthetical')
      case 'element-dialogue': return setElementTo('dialogue')
      case 'element-transition': return setElementTo('transition')
      case 'open-settings': return openSettings('appearance')
      case 'sync-now':
        if (sync?.status === 'conflict') return setMergeOpen(true)
        if (sync?.remoteUrl && sync.settings.enabled) return void hermit.syncNow()
        return openSettings('sync')
      case 'library-changed':
        return void init()
    }
  }

  /** The editor's ⋯ menu: on touch, what the desktop keeps in its menu bar. */
  const showEditorMenu = async (at: { x: number; y: number }) => {
    const check = (on: boolean, label: string) => `${on ? '✓ ' : ''}${label}`
    const choice = await hermit.showContextMenu(
      [
        ...(current && !onCanvas && !preview ? [{ id: 'find', label: 'Find…' }] : []),
        ...(compact
          ? [
              { id: 'toggle-focus', label: check(prefs.focus, 'Focus Mode') },
              { id: 'toggle-typewriter', label: check(prefs.typewriter, 'Typewriter Mode'), enabled: !onCanvas }
            ]
          : []),
        { type: 'separator' },
        { id: 'font-sans', label: check(prefs.font === 'sans', 'Sans Serif') },
        { id: 'font-serif', label: check(prefs.font === 'serif', 'Serif') },
        { id: 'font-mono', label: check(prefs.font === 'mono', 'Monospace') },
        { id: 'font-bigger', label: 'Bigger Text' },
        { id: 'font-smaller', label: 'Smaller Text' },
        { type: 'separator' },
        ...(current && !onCanvas ? [{ id: 'export-sheet', label: 'Export Sheet…' }] : []),
        ...(projectId
          ? [
              { id: 'export-project', label: 'Export Project…' },
              { id: 'project-settings', label: 'Project Settings…' }
            ]
          : []),
        { type: 'separator' },
        ...(sync?.remoteUrl && sync.settings.enabled ? [{ id: 'sync-now', label: 'Sync Now' }] : []),
        { id: 'open-settings', label: 'Settings…' }
      ],
      at
    )
    if (choice) handleMenu(choice as MenuAction)
  }

  // On a phone, the editor has nothing to show once no sheet is open; go back to the list.
  useEffect(() => {
    if (compact && ready && !current && screen === 'editor') setScreen(projectId ? 'sheets' : 'library')
  }, [compact, ready, current, screen, projectId])

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
  const { stats, element } = activePane
  // Formatting above the on-screen keyboard while writing.
  const formatBar = touch && editorFocused && Boolean(current) && !onCanvas && !preview && !conflicted
  const shortcutModifier = hermit.platform === 'darwin' ? '⌘' : 'Ctrl+'
  const activeEditor = () => editors.current.get(activePane.id)

  /** A project's sheets: the list's, or for a pane showing another project, as last loaded. */
  const sheetsOf = (pid: string) => (pid === projectId ? sheets : (sheetCache[pid] ?? []))

  /** What a split pane's header calls its sheet: its title as last saved. */
  const titleOf = (open: OpenSheet) => {
    const listed = open.projectId === projectId ? [...sheets, ...archived] : (sheetCache[open.projectId] ?? [])
    return (listed.find((s) => s.id === open.sheet.id)?.title ?? open.sheet.title) || 'Untitled'
  }

  /** Drag the line between the panes to share the editor out differently. */
  const resizeSplit = (e: ReactPointerEvent<HTMLDivElement>) => {
    const handle = e.currentTarget
    const box = handle.parentElement!.getBoundingClientRect()
    handle.setPointerCapture(e.pointerId)
    const move = (ev: PointerEvent) => {
      const ratio =
        prefs.split === 'row' ? (ev.clientX - box.left) / box.width : (ev.clientY - box.top) / box.height
      setPrefs((p) => ({ ...p, splitRatio: Math.min(0.8, Math.max(0.2, ratio)) }))
    }
    const end = () => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', end)
      handle.removeEventListener('pointercancel', end)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', end)
    handle.addEventListener('pointercancel', end)
  }

  const emptyEditor = ready && (
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

  const renderPane = (pane: Pane, index: number) => {
    const { open } = pane
    const active = pane.id === activePane.id
    const canvas = Boolean(open && isCanvasId(open.sheet.id))
    const readOnly = isConflicted(open)
    const previewing = pane.preview && Boolean(open) && !canvas
    const format: ContentFormat = open?.sheet.section === 'content' ? formatOf(open.projectId) : 'markdown'
    return (
      <section
        key={pane.id}
        className={`editor-pane${active ? ' active' : ''}`}
        style={split ? { flex: `${index === 0 ? prefs.splitRatio : 1 - prefs.splitRatio} 1 0` } : undefined}
        // Clicking or tabbing into a pane makes it the one worked in.
        onFocus={() => activatePane(pane.id)}
        onPointerDown={() => activatePane(pane.id)}
      >
        {split && (
          <div
            className="editor-pane-header"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              activatePane(pane.id)
              if (!previewing) editors.current.get(pane.id)?.focus()
            }}
          >
            <span className="editor-pane-title">{open ? titleOf(open) : 'Nothing open'}</span>
            {open && <span className="editor-pane-place">{open.sheet.archived ? 'Archive' : placeName(open.sheet)}</span>}
            <button
              className="icon-button"
              onClick={(e) => {
                e.stopPropagation()
                closePane(pane.id)
              }}
              aria-label="Close pane"
              title="Close Pane"
            >
              <CloseIcon />
            </button>
          </div>
        )}

        {open?.sheet.archived && (
          <div className="archive-banner">
            <span>Archived from {placeName(open.sheet)}.</span>
            <button className="ghost-button" onClick={() => void restoreSheet(open.sheet.id)}>
              Restore
            </button>
          </div>
        )}

        {readOnly && (
          <div className="conflict-banner">
            <span>This sheet changed here and on GitHub. It’s read-only until the conflict is resolved.</span>
            <button className="ghost-button" onClick={openMerge}>
              Resolve…
            </button>
          </div>
        )}

        <div className="editor-body">
          {open && canvas ? (
            <CanvasView
              key={open.key}
              projectId={open.projectId}
              sheetId={open.sheet.id}
              content={open.sheet.content}
              sheets={sheetsOf(open.projectId)}
              readOnly={readOnly}
              onChange={(doc) => handleChange(pane.id, open, doc)}
              // Split, a canvas's notes open beside it, so it stays in view.
              onOpenSheet={(id) => void (split ? openBeside(open.projectId, id) : openSheet(open.projectId, id, pane.id))}
            />
          ) : open ? (
            <>
              <Editor
                ref={(handle) => {
                  if (handle) editors.current.set(pane.id, handle)
                  else editors.current.delete(pane.id)
                }}
                docKey={open.key}
                content={open.sheet.content}
                format={format}
                focus={prefs.focus}
                typewriter={prefs.typewriter}
                grammar={prefs.grammar ? prefs.dialect : null}
                fontKey={`${prefs.font}:${prefs.fontSize}:${split ? prefs.split : ''}`}
                hidden={previewing}
                readOnly={readOnly}
                // On touch, the keyboard comes up only once the writer taps into the text.
                autoFocus={!touch && active}
                onChange={(doc) => handleChange(pane.id, open, doc)}
                onElementChange={(now) => updatePane(pane.id, { element: now })}
              />
              {previewing && <Preview text={(liveDocs.current.get(pane.id) ?? '').toString()} format={format} />}
            </>
          ) : active ? (
            emptyEditor
          ) : (
            <div className="editor-empty">
              <p>Nothing open here.</p>
            </div>
          )}
        </div>
      </section>
    )
  }

  const style = {
    '--editor-font': FONTS[prefs.font],
    '--editor-size': `${prefs.fontSize}px`
  } as CSSProperties

  return (
    <div className={`app platform-${hermit.platform}${compact ? ' compact' : ''}`} style={style}>
      {(compact ? screen === 'library' : prefs.showLibrary) && (
        <LibraryPane
          collection={collection}
          renamingCollection={renamingCollection}
          onCollectionMenu={(at) => void showCollectionMenu(at)}
          onRenameCollection={(name) => void renameCollection(name)}
          projects={projects.filter((p) => !p.archived)}
          archived={projects.filter((p) => p.archived)}
          folders={folders}
          activeId={projectId}
          renamingId={renamingProject}
          renamingFolder={renamingFolder}
          onSelect={(id) => {
            if (id !== projectId) void openProject(id)
            setScreen('sheets')
          }}
          onNewMenu={(at) => void showLibraryNewMenu(at)}
          onOpenSettings={() => openSettings('appearance')}
          onRename={(id, name) => void renameProject(id, name)}
          onRenameEnd={() => {
            setRenamingProject(null)
            setRenamingFolder(null)
            setRenamingCollection(false)
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

      {(compact ? screen === 'sheets' : prefs.showSheets) && (
        <SheetListPane
          onBack={compact ? () => setScreen('library') : undefined}
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
          onSectionChange={switchSection}
          onOpenArchive={openArchive}
          onArchive={(item) => void archiveItem(item)}
          onSelect={(id) => {
            if (projectId && id !== current?.sheet.id) void openSheet(projectId, id)
            setScreen('editor')
          }}
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

      {/* On a phone the editor stays put while hidden, so it keeps its place and its unsaved edits. */}
      <main
        className={`pane editor${prefs.focus ? ' focus-mode' : ''}${split ? ' split' : ''}`}
        hidden={compact && screen !== 'editor'}
      >
        {/* Toolbar clicks shouldn't pull focus out of the editor. */}
        <header className="pane-header editor-toolbar" onMouseDown={(e) => e.preventDefault()}>
          {compact ? (
            <button className="icon-button back-button" onClick={() => setScreen('sheets')} aria-label="Back to sheets">
              <BackIcon />
            </button>
          ) : (
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
          )}
          <div className="toolbar-spacer" />
          {/* Split, each pane says where its own sheet lives. */}
          {!split && (current?.sheet.section === 'notes' || current?.sheet.subsection) && (
            <span className="place-label">{placeName(current.sheet)}</span>
          )}
          <div className="toolbar-modes">
            {!compact && (
              <>
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
              </>
            )}
            <button
              className={`icon-button${preview ? ' on' : ''}`}
              onClick={togglePreview}
              disabled={!current || onCanvas}
              title="Preview (⇧⌘P)"
            >
              <EyeIcon />
            </button>
            {!compact && (
              <button
                className={`icon-button${split ? ' on' : ''}`}
                aria-label="Split editor"
                aria-haspopup="menu"
                title="Split Editor"
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect()
                  void showSplitMenu({ x: rect.left, y: rect.bottom + 4 })
                }}
              >
                {prefs.split === 'row' ? <SplitRightIcon /> : <SplitDownIcon />}
              </button>
            )}
            {touch && (
              <button
                className="icon-button"
                aria-label="More"
                aria-haspopup="menu"
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect()
                  void showEditorMenu({ x: rect.left, y: rect.bottom + 4 })
                }}
              >
                <MoreIcon />
              </button>
            )}
          </div>
        </header>

        <div className={`editor-split ${prefs.split}`}>
          {/* A phone shows one pane at a time: the one being worked in. */}
          {(compact ? [activePane] : panes).map((pane, i) => (
            <Fragment key={pane.id}>
              {i > 0 && (
                <div
                  className="split-divider"
                  role="separator"
                  aria-orientation={prefs.split === 'row' ? 'vertical' : 'horizontal'}
                  onPointerDown={resizeSplit}
                  onDoubleClick={() => setPrefs((p) => ({ ...p, splitRatio: 0.5 }))}
                />
              )}
              {renderPane(pane, i)}
            </Fragment>
          ))}
        </div>

        {formatBar && (
          <FormatBar
            format={sheetFormat}
            element={element}
            onRun={(command) => activeEditor()?.run(command)}
            onDone={() => activeEditor()?.blur()}
          />
        )}

        {current && !(compact && formatBar) && (
          <footer className="status-bar">
            {element && !onCanvas && !preview && !conflicted && (
              <ElementPicker
                element={element}
                compact={compact}
                onPick={(type) => {
                  activeEditor()?.run(setScreenplayElement(type))
                  activeEditor()?.focus()
                }}
              />
            )}
            {compact ? (
              <button className="status-summary" aria-haspopup="menu" onClick={() => void showStatusSheet()}>
                <span>{stats.canvas ?? formatCount(stats.words, 'word')}</span>
                {statusProblem && <span className={`status-problem ${statusProblem.tone}`}>{statusProblem.label}</span>}
              </button>
            ) : (
              <>
                {stats.canvas !== undefined ? (
                  <span>{stats.canvas}</span>
                ) : (
                  <>
                    <span>{formatCount(stats.words, 'word')}</span>
                    <span>{formatCount(stats.chars, 'character')}</span>
                    <span>{readingMinutes(stats.words)} min read</span>
                  </>
                )}
                <span className={`save-state ${saveState}`}>{saveLabel}</span>
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
              </>
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
