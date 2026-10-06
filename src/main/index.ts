import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, net, protocol, shell } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type {
  ContextMenuEntry,
  ExportFormat,
  MenuAction,
  OutlineItem,
  OutlineTarget,
  ProjectSettings,
  SheetPlace,
  SyncSettings
} from '../shared/types'
import { exportDocument } from './export'
import { Library } from './library'
import { GitSync, normalizeSyncSettings } from './sync'
import { WELCOME_CANVAS, WELCOME_NOTES, WELCOME_PROJECT, WELCOME_SHEETS } from './welcome'

interface Settings {
  libraryPath?: string
  bounds?: Electron.Rectangle
  sync?: SyncSettings
}

const isMac = process.platform === 'darwin'
const appIcon = app.isPackaged
  ? path.join(process.resourcesPath, 'hermit-crab.png')
  : path.join(app.getAppPath(), 'assets/hermit-crab.png')
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json')

let settings: Settings = {}
let library: Library
let sync: GitSync
let mainWindow: BrowserWindow | null = null
let isQuitting = false
let closeReady = false
let closeTimer: NodeJS.Timeout | undefined

async function loadSettings(): Promise<void> {
  try {
    settings = JSON.parse(await fs.readFile(settingsFile(), 'utf8'))
  } catch {
    settings = {}
  }
}

async function saveSettings(): Promise<void> {
  await fs.mkdir(path.dirname(settingsFile()), { recursive: true })
  await fs.writeFile(settingsFile(), JSON.stringify(settings, null, 2))
}

async function openLibrary(root: string): Promise<void> {
  library = new Library(root)
  const existed = await library.ensure()
  if (!existed) {
    const project = await library.createProject(WELCOME_PROJECT)
    for (const content of WELCOME_SHEETS) await library.createSheet(project.id, content)
    const notes = { section: 'notes', subsection: null } as const
    const created = []
    for (const content of WELCOME_NOTES) created.push(await library.createSheet(project.id, content, undefined, notes))
    await library.createCanvas(project.id, notes, 'Planning Board', WELCOME_CANVAS(`${created[0].id}.md`))
  }
}

// ── Library files ───────────────────────────────────────────────────────────

// Canvases show images from the library as `hermit-file://library/<path in the library>`.
protocol.registerSchemesAsPrivileged([{ scheme: 'hermit-file', privileges: { standard: true, secure: true } }])

function registerFileProtocol(): void {
  protocol.handle('hermit-file', (request) => {
    const url = new URL(request.url)
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    const root = path.resolve(library.root)
    const file = path.resolve(root, ...parts)
    if (url.host !== 'library' || parts.some((p) => p.startsWith('.')) || !file.startsWith(root + path.sep)) {
      return new Response('Not found', { status: 404 })
    }
    return net.fetch(pathToFileURL(file).toString())
  })
}

function send(action: MenuAction): void {
  mainWindow?.webContents.send('menu', action)
}

// ── Sync ────────────────────────────────────────────────────────────────────

let flushSeq = 0
const flushWaiters = new Map<number, () => void>()

ipcMain.on('sync:flushed', (_e, id: number) => flushWaiters.get(id)?.())

/** Ask the renderer to save unsaved edits, so a commit or merge sees the latest text. */
function flushRenderer(): Promise<void> {
  const win = mainWindow
  if (!win || win.isDestroyed() || win.webContents.isLoading()) return Promise.resolve()
  const id = ++flushSeq
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      flushWaiters.delete(id)
      resolve()
    }
    const timer = setTimeout(done, 3000)
    flushWaiters.set(id, done)
    win.webContents.send('sync:flush', id)
  })
}

function createSync(): GitSync {
  const emit = (channel: string, payload: unknown) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
  }
  return new GitSync(library.root, normalizeSyncSettings(settings.sync), {
    flush: flushRenderer,
    emitState: (state) => emit('sync:state', state),
    emitChanged: (paths) => paths.length && emit('sync:changed', paths),
    emitAgentOutput: (chunk) => emit('sync:agent-output', chunk),
    saveSettings: async (next) => {
      settings.sync = next
      await saveSettings()
    }
  })
}

// ── Window ──────────────────────────────────────────────────────────────────

function createWindow(): void {
  const win = new BrowserWindow({
    width: settings.bounds?.width ?? 1280,
    height: settings.bounds?.height ?? 800,
    x: settings.bounds?.x,
    y: settings.bounds?.y,
    minWidth: 640,
    minHeight: 420,
    show: false,
    title: 'Hermit Crab',
    icon: appIcon,
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 18, y: 18 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#172131' : '#faf5ec',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true
    }
  })
  mainWindow = win
  closeReady = false

  win.once('ready-to-show', () => win.show())
  win.on('focus', () => sync.pullSoon())

  // Links (e.g. in preview) open in the user's browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:|^mailto:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) {
      event.preventDefault()
      if (/^https?:|^mailto:/.test(url)) shell.openExternal(url)
    }
  })

  // Spelling suggestions and basic editing for text fields.
  win.webContents.on('context-menu', (_event, params) => {
    if (!params.isEditable && !params.selectionText) return
    const template: MenuItemConstructorOptions[] = []
    if (params.misspelledWord) {
      for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
        template.push({ label: suggestion, click: () => win.webContents.replaceMisspelling(suggestion) })
      }
      if (!params.dictionarySuggestions.length) template.push({ label: 'No Guesses Found', enabled: false })
      template.push(
        {
          label: 'Learn Spelling',
          click: () => win.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord)
        },
        { type: 'separator' }
      )
    }
    if (params.isEditable) template.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' })
    else template.push({ role: 'copy' })
    Menu.buildFromTemplate(template).popup({ window: win })
  })

  // Give the renderer a chance to flush unsaved edits before the window goes away.
  win.on('close', (event) => {
    settings.bounds = win.getNormalBounds()
    void saveSettings()
    if (closeReady) return
    event.preventDefault()
    win.webContents.send('app:before-close')
    closeTimer = setTimeout(() => finishClose(win), 3000) // never hang if the renderer is unresponsive
  })
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

function finishClose(win: BrowserWindow): void {
  if (win.isDestroyed() || closeReady) return
  closeReady = true
  win.close()
  if (isQuitting) app.quit()
}

// The renderer redraws the icon in the current theme's colours.
ipcMain.on('app:set-icon', (_e, dataUrl: string) => {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')) return
  const icon = nativeImage.createFromDataURL(dataUrl)
  if (icon.isEmpty()) return
  if (isMac) app.dock?.setIcon(icon)
  else mainWindow?.setIcon(icon)
})

ipcMain.on('app:close-ready', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) return
  // Edits are on disk; give sync a few seconds to get them to GitHub too.
  clearTimeout(closeTimer)
  await Promise.race([sync.sync(), new Promise((resolve) => setTimeout(resolve, 5000))])
  finishClose(win)
})

// ── Menu ────────────────────────────────────────────────────────────────────

async function chooseLibrary(): Promise<void> {
  const options: Electron.OpenDialogOptions = {
    title: 'Choose Library Folder',
    properties: ['openDirectory', 'createDirectory']
  }
  const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options)
  if (result.canceled || !result.filePaths[0]) return
  settings.libraryPath = result.filePaths[0]
  await saveSettings()
  await openLibrary(settings.libraryPath)
  await sync.setRoot(library.root)
  send('library-changed')
}

function buildMenu(): void {
  const item = (label: string, action: MenuAction, accelerator?: string, handledByEditor = false) =>
    ({
      label,
      accelerator,
      registerAccelerator: !handledByEditor,
      click: () => send(action)
    }) satisfies MenuItemConstructorOptions

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              item('Settings…', 'open-settings', 'Cmd+,'),
              item('Sync Now', 'sync-now', 'Cmd+Alt+S'),
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' }
            ]
          } satisfies MenuItemConstructorOptions
        ]
      : []),
    {
      label: 'File',
      submenu: [
        item('New Sheet', 'new-sheet', 'CmdOrCtrl+N'),
        item('New Canvas', 'new-canvas', 'CmdOrCtrl+Alt+N'),
        item('New Project', 'new-project', 'CmdOrCtrl+Shift+N'),
        { type: 'separator' },
        item('Export Sheet…', 'export-sheet', 'CmdOrCtrl+Shift+E'),
        item('Export Project…', 'export-project'),
        { type: 'separator' },
        item('Project Settings…', 'project-settings'),
        { type: 'separator' },
        { label: 'Show Library in Finder', click: () => shell.openPath(library.root) },
        { label: 'Change Library Location…', click: () => void chooseLibrary() },
        { type: 'separator' },
        ...(isMac
          ? []
          : [item('Settings…', 'open-settings', 'Ctrl+,'), item('Sync Now', 'sync-now', 'Ctrl+Alt+S'), { type: 'separator' } as const]),
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'selectAll' },
        { type: 'separator' },
        item('Find…', 'find', 'CmdOrCtrl+F', true)
      ]
    },
    {
      label: 'Format',
      submenu: [
        item('Bold', 'format-bold', 'CmdOrCtrl+B', true),
        item('Italic', 'format-italic', 'CmdOrCtrl+I', true),
        item('Code', 'format-code', 'CmdOrCtrl+E', true),
        item('Link', 'format-link', 'CmdOrCtrl+K', true),
        { type: 'separator' },
        item('Heading', 'format-heading', 'CmdOrCtrl+Alt+H', true),
        item('Quote', 'format-quote', "CmdOrCtrl+Alt+'", true)
      ]
    },
    {
      label: 'View',
      submenu: [
        item('Toggle Library', 'toggle-library', 'CmdOrCtrl+1'),
        item('Toggle Sheet List', 'toggle-sheets', 'CmdOrCtrl+2'),
        item('Toggle Sidebars', 'toggle-sidebars', 'CmdOrCtrl+\\'),
        item('Switch Content / Notes', 'toggle-section', 'CmdOrCtrl+3'),
        { type: 'separator' },
        item('Toggle Preview', 'toggle-preview', 'CmdOrCtrl+Shift+P'),
        item('Focus Mode', 'toggle-focus', 'CmdOrCtrl+Shift+F'),
        item('Typewriter Mode', 'toggle-typewriter', 'CmdOrCtrl+Shift+T'),
        item('Check Grammar', 'toggle-grammar'),
        { type: 'separator' },
        item('Previous Sheet', 'prev-sheet', 'CmdOrCtrl+Alt+Up'),
        item('Next Sheet', 'next-sheet', 'CmdOrCtrl+Alt+Down'),
        { type: 'separator' },
        {
          label: 'Editor Font',
          submenu: [item('Sans Serif', 'font-sans'), item('Serif', 'font-serif'), item('Monospace', 'font-mono')]
        },
        item('Bigger Text', 'font-bigger', 'CmdOrCtrl+='),
        item('Smaller Text', 'font-smaller', 'CmdOrCtrl+-'),
        item('Actual Size', 'font-reset', 'CmdOrCtrl+0'),
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' } as MenuItemConstructorOptions])
      ]
    },
    { role: 'windowMenu' }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ── IPC ─────────────────────────────────────────────────────────────────────

async function confirm(message: string, detail: string, action: string): Promise<boolean> {
  const options: Electron.MessageBoxOptions = {
    type: 'warning',
    message,
    detail,
    buttons: [action, 'Cancel'],
    defaultId: 1,
    cancelId: 1
  }
  const { response } = mainWindow
    ? await dialog.showMessageBox(mainWindow, options)
    : await dialog.showMessageBox(options)
  return response === 0
}

async function chooseExportFormat(screenplay: boolean): Promise<ExportFormat | undefined> {
  const formats: ExportFormat[] = [screenplay ? 'fountain' : 'md', 'html', 'pdf']
  const options: Electron.MessageBoxOptions = {
    type: 'question',
    message: 'Export as…',
    buttons: [screenplay ? 'Fountain' : 'Markdown', 'HTML', 'PDF', 'Cancel'],
    defaultId: 0,
    cancelId: 3
  }
  const { response } = mainWindow
    ? await dialog.showMessageBox(mainWindow, options)
    : await dialog.showMessageBox(options)
  return formats[response]
}

/** Run a library change, then let sync know there's something to commit. */
async function changed<T>(work: Promise<T>): Promise<T> {
  const result = await work
  sync.noteChange()
  return result
}

function registerIpc(): void {
  ipcMain.handle('projects:list', () => library.listProjects())
  ipcMain.handle('projects:create', (_e, name: string, folder?: string | null) =>
    changed(library.createProject(name, folder))
  )
  ipcMain.handle('projects:rename', (_e, id: string, name: string) => changed(library.renameProject(id, name)))
  ipcMain.handle('projects:update-settings', (_e, id: string, patch: Partial<ProjectSettings>) =>
    changed(library.updateProjectSettings(id, patch))
  )
  ipcMain.handle('projects:reveal', (_e, id: string) => library.revealProject(id))
  ipcMain.handle('projects:delete', async (_e, id: string) => {
    const name = id.slice(id.lastIndexOf('/') + 1)
    const ok = await confirm(`Move “${name}” to the Trash?`, 'The project folder and all of its sheets will be moved to the Trash.', 'Move to Trash')
    if (ok) await changed(library.deleteProject(id))
    return ok
  })

  ipcMain.handle('folders:list', () => library.listFolders())
  ipcMain.handle('folders:create', (_e, name: string, parent?: string | null) =>
    changed(library.createFolder(name, parent))
  )
  ipcMain.handle('folders:rename', (_e, folder: string, name: string) => changed(library.renameFolder(folder, name)))
  ipcMain.handle('folders:delete', async (_e, folder: string) => {
    const inside = (await library.listProjects()).filter((p) => p.id.startsWith(`${folder}/`)).length
    const ok = await confirm(
      `Move “${folder.slice(folder.lastIndexOf('/') + 1)}” to the Trash?`,
      inside
        ? `The ${inside === 1 ? 'project' : `${inside} projects`} in it will be moved to the Trash too.`
        : 'It has no projects in it.',
      'Move to Trash'
    )
    if (ok) await changed(library.deleteFolder(folder))
    return ok
  })
  ipcMain.handle('library:move', (_e, libraryPath: string, folder: string | null) =>
    changed(library.moveInLibrary(libraryPath, folder))
  )

  ipcMain.handle('outline:list', (_e, projectId: string) => library.listOutline(projectId))
  ipcMain.handle('sheets:read', (_e, projectId: string, id: string) => library.readSheet(projectId, id))
  ipcMain.handle('sheets:write', (_e, projectId: string, id: string, content: string) =>
    changed(library.writeSheet(projectId, id, content))
  )
  ipcMain.handle('sheets:create', (_e, projectId: string, content?: string, afterId?: string, place?: SheetPlace) =>
    changed(library.createSheet(projectId, content, afterId, place))
  )
  ipcMain.handle(
    'canvases:create',
    (_e, projectId: string, place: SheetPlace, name?: string, content?: string, afterId?: string) =>
      changed(library.createCanvas(projectId, place, name, content, afterId))
  )
  ipcMain.handle('canvases:rename', (_e, projectId: string, id: string, name: string) =>
    changed(library.renameCanvas(projectId, id, name))
  )
  ipcMain.handle('attachments:save', (_e, projectId: string, name: string, data: Uint8Array) =>
    changed(library.saveAttachment(projectId, name, data))
  )
  ipcMain.handle('sheets:delete', async (_e, projectId: string, id: string) => {
    const sheet = await library.readSheet(projectId, id)
    const ok = await confirm(`Move “${sheet.title || 'Untitled'}” to the Trash?`, 'You can restore it from the Trash later.', 'Move to Trash')
    if (ok) await changed(library.deleteSheet(projectId, id))
    return ok
  })
  ipcMain.handle('sheets:move', (_e, from: string, id: string, to: string) => changed(library.moveSheet(from, id, to)))
  ipcMain.handle('outline:move', (_e, projectId: string, item: OutlineItem, target: OutlineTarget) =>
    changed(library.moveInOutline(projectId, item, target))
  )
  ipcMain.handle('subsections:create', (_e, projectId: string, parent: SheetPlace, name: string) =>
    changed(library.createSubsection(projectId, parent, name))
  )
  ipcMain.handle('subsections:rename', (_e, projectId: string, place: SheetPlace, name: string) =>
    changed(library.renameSubsection(projectId, place, name))
  )
  ipcMain.handle('subsections:delete', async (_e, projectId: string, place: SheetPlace) => {
    const sub = place.subsection ?? ''
    const inside = (await library.listSheets(projectId)).filter(
      (s) => s.section === place.section && (s.subsection === sub || s.subsection?.startsWith(`${sub}/`))
    ).length
    const noun = place.section === 'notes' ? 'note' : 'sheet'
    const ok = await confirm(
      `Move “${sub.slice(sub.lastIndexOf('/') + 1)}” to the Trash?`,
      inside
        ? `The ${inside === 1 ? noun : `${inside} ${noun}s`} in it will be moved to the Trash too.`
        : `It has no ${noun}s in it.`,
      'Move to Trash'
    )
    if (ok) await changed(library.deleteSubsection(projectId, place))
    return ok
  })
  ipcMain.handle('sheets:search', (_e, projectId: string, query: string) => library.searchSheets(projectId, query))

  ipcMain.handle('export', async (_e, projectId: string, sheetIds: string[] | null, format?: ExportFormat) => {
    const doc = await library.compile(projectId, sheetIds ?? undefined)
    format ??= await chooseExportFormat(doc.format === 'fountain')
    if (!format) return null
    return exportDocument(mainWindow, doc, format)
  })

  ipcMain.handle('sync:state', () => sync.getState())
  ipcMain.handle('sync:update-settings', (_e, patch: Partial<SyncSettings>) => sync.updateSettings(patch))
  ipcMain.handle('sync:connect', (_e, url: string) => sync.connect(url))
  ipcMain.handle('sync:now', async () => {
    await sync.sync()
    return sync.getState()
  })
  ipcMain.handle('sync:conflicts', () => sync.listConflicts())
  ipcMain.handle('sync:resolve', (_e, file: string, content: string | null) => sync.resolveConflict(file, content))
  ipcMain.handle('sync:finish-merge', () => sync.finishMerge())
  ipcMain.handle('sync:agent', () => sync.resolveWithAgent())
  ipcMain.handle('sync:cancel-agent', () => sync.cancelAgent())

  ipcMain.handle('context-menu', (event, entries: ContextMenuEntry[], at?: { x: number; y: number }) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
    return new Promise<string | null>((resolve) => {
      const menu = Menu.buildFromTemplate(
        entries.map((entry) =>
          'type' in entry
            ? { type: 'separator' as const }
            : { label: entry.label, enabled: entry.enabled ?? true, click: () => resolve(entry.id) }
        )
      )
      // The close callback can fire before the click handler; give the click a moment to win.
      const position = at && { x: Math.round(at.x), y: Math.round(at.y) }
      menu.popup({ window: win, ...position, callback: () => setTimeout(() => resolve(null), 50) })
    })
  })
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

app.setName('Hermit Crab')

app.whenReady().then(async () => {
  if (isMac) app.dock?.setIcon(appIcon)
  await loadSettings()
  await openLibrary(
    process.env['HERMIT_LIBRARY'] ?? settings.libraryPath ?? path.join(app.getPath('documents'), 'Hermit Crab')
  )
  sync = createSync()
  registerFileProtocol()
  registerIpc()
  buildMenu()
  createWindow()
  void sync.start()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  isQuitting = true
})

app.on('will-quit', () => sync?.stop())

app.on('window-all-closed', () => {
  if (!isMac || isQuitting) app.quit()
})
