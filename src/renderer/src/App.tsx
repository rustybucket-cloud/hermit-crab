import type { Text } from '@codemirror/state'
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { countWords, readingMinutes } from '../../shared/text'
import type { ExportFormat, MenuAction, ProjectSummary, Sheet, SheetSummary } from '../../shared/types'
import { Editor, type EditorHandle } from './components/Editor'
import { EyeIcon, FocusIcon, PlusIcon, SheetsIcon, SidebarIcon, TypewriterIcon } from './components/Icons'
import { LibraryPane } from './components/LibraryPane'
import { MergeEditor } from './components/MergeEditor'
import { Preview } from './components/Preview'
import { SettingsOverlay, type SettingsTab } from './components/SettingsOverlay'
import { SheetListPane } from './components/SheetListPane'
import { formatCommands } from './editor/extensions'
import { formatCount } from './format'
import { sheetPath, syncLabel, timeAgo, useSyncState } from './sync'
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

export default function App() {
  const [prefs, setPrefs] = useState<Prefs>(() => loadJson(PREFS_KEY, DEFAULT_PREFS))
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [projectId, setProjectId] = useState<string | null>(null)
  const [sheets, setSheets] = useState<SheetSummary[]>([])
  const [current, setCurrent] = useState<OpenSheet | null>(null)
  const [renamingProject, setRenamingProject] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState<Set<string> | null>(null)
  const [stats, setStats] = useState({ words: 0, chars: 0 })
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const [ready, setReady] = useState(false)
  const [theme, setTheme] = useTheme()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('appearance')
  const sync = useSyncState()
  const [mergeOpen, setMergeOpen] = useState(false)

  const editor = useRef<EditorHandle>(null)
  const pending = useRef<{ projectId: string; sheetId: string; doc: Text } | null>(null)
  const liveDoc = useRef<Text | string>('')
  const saveTimer = useRef<number | undefined>(undefined)
  const statsTimer = useRef<number | undefined>(undefined)
  const loadSeq = useRef(0)

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
      setSheets((prev) => prev.map((s) => (s.id === summary.id ? summary : s)))
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

  const handleChange = (doc: Text) => {
    if (!current) return
    pending.current = { projectId: current.projectId, sheetId: current.sheet.id, doc }
    liveDoc.current = doc
    setSaveState('unsaved')
    window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(flush, 600)
    window.clearTimeout(statsTimer.current)
    statsTimer.current = window.setTimeout(() => {
      const text = doc.toString()
      setStats({ words: countWords(text), chars: text.length })
    }, 150)
  }

  // ── Loading ───────────────────────────────────────────────────────────────

  const refreshProjects = useCallback(async () => {
    const list = await hermit.listProjects()
    setProjects(list)
    return list
  }, [])

  const refreshSheets = useCallback(async (pid: string) => {
    const list = await hermit.listSheets(pid)
    setSheets(list)
    return list
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
      setStats({ words: sheet.wordCount, chars: sheet.content.length })
      setCurrent({ projectId: pid, sheet, key: `${pid}/${sheetId}#${seq}` })
      localStorage.setItem(LAST_KEY, JSON.stringify({ projectId: pid, sheetId }))
    },
    [flush]
  )

  const openProject = useCallback(
    async (pid: string | null, preferredSheet?: string | null) => {
      await flush()
      setProjectId(pid)
      setQuery('')
      if (!pid) {
        setSheets([])
        await openSheet('', null)
        return
      }
      const list = await refreshSheets(pid)
      const target = list.find((s) => s.id === preferredSheet) ?? list[0]
      await openSheet(pid, target?.id ?? null)
    },
    [flush, openSheet, refreshSheets]
  )

  const init = useCallback(async () => {
    const list = await refreshProjects()
    const last = loadJson<{ projectId?: string; sheetId?: string }>(LAST_KEY, {})
    const project = list.find((p) => p.id === last.projectId) ?? list[0]
    await openProject(project?.id ?? null, last.sheetId)
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
      await openProject(list[0]?.id ?? null)
      return
    }
    const sheetList = await refreshSheets(projectId)
    if (!current || current.projectId !== projectId) return
    const id = current.sheet.id
    if (!paths.includes(sheetPath(projectId, id))) return

    // Anything typed in the moment since sync saved this sheet would overwrite what was just pulled.
    discardPending((p) => p.projectId === projectId && p.sheetId === id)
    if (!sheetList.some((s) => s.id === id)) {
      await openSheet(projectId, sheetList[0]?.id ?? null)
      return
    }
    const sheet = await hermit.readSheet(projectId, id)
    editor.current?.replaceContent(sheet.content)
    liveDoc.current = sheet.content
    setStats({ words: sheet.wordCount, chars: sheet.content.length })
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

  const visibleSheets = useMemo(
    () => (matches ? sheets.filter((s) => matches.has(s.id)) : sheets),
    [sheets, matches]
  )

  // ── Actions ───────────────────────────────────────────────────────────────

  const createProject = async () => {
    await flush()
    const project = await hermit.createProject('Untitled Project')
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
      await refreshProjects()
      if (projectId === id) {
        setProjectId(renamed.id)
        setCurrent((c) => (c && c.projectId === id ? { ...c, projectId: renamed.id } : c))
        if (current) localStorage.setItem(LAST_KEY, JSON.stringify({ projectId: renamed.id, sheetId: current.sheet.id }))
      }
    } catch (err) {
      console.error('Rename failed', err)
    }
  }

  const deleteProject = async (id: string) => {
    await flush()
    if (!(await hermit.deleteProject(id))) return
    discardPending((p) => p.projectId === id)
    const list = await refreshProjects()
    if (projectId === id) await openProject(list[0]?.id ?? null)
  }

  const createSheet = async (content = '') => {
    let pid = projectId
    if (!pid) {
      const project = await hermit.createProject('Untitled Project')
      await refreshProjects()
      pid = project.id
      setProjectId(pid)
    }
    await flush()
    setQuery('')
    const afterId = current?.projectId === pid ? current.sheet.id : undefined
    const sheet = await hermit.createSheet(pid, content, afterId)
    await Promise.all([refreshSheets(pid), refreshProjects()])
    await openSheet(pid, sheet.id)
  }

  const duplicateSheet = async (id: string) => {
    if (!projectId) return
    await flush()
    const source = await hermit.readSheet(projectId, id)
    const copy = await hermit.createSheet(projectId, source.content, id)
    await Promise.all([refreshSheets(projectId), refreshProjects()])
    await openSheet(projectId, copy.id)
  }

  /** After a sheet leaves the list, select its neighbour. */
  const selectNeighbour = async (pid: string, removedId: string, before: SheetSummary[]) => {
    const list = await refreshSheets(pid)
    await refreshProjects()
    if (current?.sheet.id !== removedId) return
    const index = before.findIndex((s) => s.id === removedId)
    const next = list[Math.min(index, list.length - 1)]
    await openSheet(pid, next?.id ?? null)
  }

  const deleteSheet = async (id: string) => {
    if (!projectId) return
    await flush()
    if (!(await hermit.deleteSheet(projectId, id))) return
    discardPending((p) => p.sheetId === id)
    await selectNeighbour(projectId, id, sheets)
  }

  const moveSheet = async (sheetId: string, from: string, to: string) => {
    await flush()
    discardPending((p) => p.sheetId === sheetId)
    await hermit.moveSheet(from, sheetId, to)
    if (from === projectId) await selectNeighbour(from, sheetId, sheets)
    else await refreshProjects()
  }

  const reorderSheets = async (order: string[]) => {
    if (!projectId) return
    const byId = new Map(sheets.map((s) => [s.id, s]))
    setSheets(order.map((id) => byId.get(id)!).filter(Boolean))
    await hermit.reorderSheets(projectId, order)
  }

  const exportSheets = async (pid: string, ids: string[] | null, format?: ExportFormat) => {
    await flush()
    await hermit.exportSheets(pid, ids, format)
  }

  const stepSheet = (delta: number) => {
    if (!projectId || !visibleSheets.length) return
    const index = visibleSheets.findIndex((s) => s.id === current?.sheet.id)
    const next = visibleSheets[Math.max(0, Math.min(visibleSheets.length - 1, index + delta))]
    if (next && next.id !== current?.sheet.id) void openSheet(projectId, next.id)
  }

  const showProjectMenu = async (id: string) => {
    const choice = await hermit.showContextMenu([
      { id: 'rename', label: 'Rename' },
      { id: 'reveal', label: 'Show in Finder' },
      { type: 'separator' },
      { id: 'export-md', label: 'Export as Markdown…' },
      { id: 'export-html', label: 'Export as HTML…' },
      { id: 'export-pdf', label: 'Export as PDF…' },
      { type: 'separator' },
      { id: 'delete', label: 'Move to Trash…' }
    ])
    if (choice === 'rename') setRenamingProject(id)
    else if (choice === 'reveal') void hermit.revealProject(id)
    else if (choice === 'delete') void deleteProject(id)
    else if (choice?.startsWith('export-')) void exportSheets(id, null, choice.slice(7) as ExportFormat)
  }

  const showSheetMenu = async (id: string) => {
    if (!projectId) return
    const others = projects.filter((p) => p.id !== projectId)
    const choice = await hermit.showContextMenu([
      { id: 'duplicate', label: 'Duplicate' },
      { type: 'separator' },
      { id: 'export-md', label: 'Export as Markdown…' },
      { id: 'export-html', label: 'Export as HTML…' },
      { id: 'export-pdf', label: 'Export as PDF…' },
      ...(others.length
        ? [{ type: 'separator' as const }, ...others.map((p) => ({ id: `move:${p.id}`, label: `Move to “${p.name}”` }))]
        : []),
      { type: 'separator' },
      { id: 'delete', label: 'Move to Trash…' }
    ])
    if (choice === 'duplicate') void duplicateSheet(id)
    else if (choice === 'delete') void deleteSheet(id)
    else if (choice?.startsWith('export-')) void exportSheets(projectId, [id], choice.slice(7) as ExportFormat)
    else if (choice?.startsWith('move:')) void moveSheet(id, projectId, choice.slice(5))
  }

  const togglePref = (key: 'showLibrary' | 'showSheets' | 'preview' | 'typewriter') =>
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
    const editable = !prefs.preview && !settingsOpen && !mergeOpen && !conflicted
    const run = (cmd: keyof typeof formatCommands) => editable && editor.current?.run(formatCommands[cmd])
    switch (action) {
      case 'new-sheet': return void createSheet()
      case 'new-project': return void createProject()
      case 'export-sheet': return current && void exportSheets(current.projectId, [current.sheet.id])
      case 'export-project': return projectId && void exportSheets(projectId, null)
      case 'toggle-library': return togglePref('showLibrary')
      case 'toggle-sheets': return togglePref('showSheets')
      case 'toggle-sidebars': return toggleSidebars()
      case 'toggle-preview': return current && togglePref('preview')
      case 'toggle-focus': return toggleFocus()
      case 'toggle-typewriter': return togglePref('typewriter')
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
  const totalWords = sheets.reduce((sum, s) => sum + s.wordCount, 0)
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
          projects={projects}
          activeId={projectId}
          renamingId={renamingProject}
          onSelect={(id) => id !== projectId && void openProject(id)}
          onCreate={() => void createProject()}
          onOpenSettings={() => openSettings('appearance')}
          onRename={(id, name) => void renameProject(id, name)}
          onRenameEnd={() => setRenamingProject(null)}
          onStartRename={setRenamingProject}
          onContextMenu={(id) => void showProjectMenu(id)}
          onDropSheet={(sheetId, from, to) => void moveSheet(sheetId, from, to)}
        />
      )}

      {prefs.showSheets && (
        <SheetListPane
          projectId={projectId}
          projectName={project?.name ?? 'No Project'}
          sheets={visibleSheets}
          totalWords={totalWords}
          activeId={current?.sheet.id ?? null}
          query={query}
          onQueryChange={setQuery}
          onSelect={(id) => projectId && id !== current?.sheet.id && void openSheet(projectId, id)}
          onCreate={() => void createSheet()}
          onReorder={(order) => void reorderSheets(order)}
          onContextMenu={(id) => void showSheetMenu(id)}
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
              title="Typewriter Mode (⇧⌘T)"
            >
              <TypewriterIcon />
            </button>
            <button
              className={`icon-button${prefs.preview ? ' on' : ''}`}
              onClick={() => togglePref('preview')}
              disabled={!current}
              title="Preview (⇧⌘P)"
            >
              <EyeIcon />
            </button>
          </div>
        </header>

        {conflicted && (
          <div className="conflict-banner">
            <span>This sheet changed here and on GitHub. It’s read-only until the conflict is resolved.</span>
            <button className="ghost-button" onClick={openMerge}>
              Resolve…
            </button>
          </div>
        )}

        <div className="editor-body">
          {current ? (
            <>
              <Editor
                ref={editor}
                docKey={current.key}
                content={current.sheet.content}
                focus={prefs.focus}
                typewriter={prefs.typewriter}
                fontKey={`${prefs.font}:${prefs.fontSize}`}
                hidden={prefs.preview}
                readOnly={conflicted}
                onChange={handleChange}
              />
              {prefs.preview && <Preview markdown={previewSource} />}
            </>
          ) : (
            ready && (
              <div className="editor-empty">
                {projects.length === 0 ? (
                  <>
                    <p>Your library is empty.</p>
                    <button className="primary-button" onClick={() => void createProject()}>
                      <PlusIcon /> New Project
                    </button>
                  </>
                ) : (
                  <>
                    <p>No sheet selected.</p>
                    <button className="primary-button" onClick={() => void createSheet()}>
                      <PlusIcon /> New Sheet
                    </button>
                  </>
                )}
              </div>
            )
          )}
        </div>

        {current && (
          <footer className="status-bar">
            <span>{formatCount(stats.words, 'word')}</span>
            <span>{formatCount(stats.chars, 'character')}</span>
            <span>{readingMinutes(stats.words)} min read</span>
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
          sync={sync}
          onOpenMerge={openMerge}
          onClose={closeSettings}
        />
      )}
      {mergeOpen && sync && <MergeEditor sync={sync} onClose={closeMerge} />}
    </div>
  )
}
