import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, shell } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ContextMenuEntry, ExportFormat, MenuAction } from '../shared/types'
import { exportDocument } from './export'
import { Library } from './library'
import { WELCOME_PROJECT, WELCOME_SHEETS } from './welcome'

interface Settings {
  libraryPath?: string
  bounds?: Electron.Rectangle
}

const isMac = process.platform === 'darwin'
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json')

let settings: Settings = {}
let library: Library
let mainWindow: BrowserWindow | null = null
let isQuitting = false
let closeReady = false

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
  }
}

function send(action: MenuAction): void {
  mainWindow?.webContents.send('menu', action)
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
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 18, y: 18 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1d1f' : '#fbfaf8',
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
    setTimeout(() => finishClose(win), 3000) // never hang if the renderer is unresponsive
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

ipcMain.on('app:close-ready', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (win) finishClose(win)
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
    ...(isMac ? [{ role: 'appMenu' } as MenuItemConstructorOptions] : []),
    {
      label: 'File',
      submenu: [
        item('New Sheet', 'new-sheet', 'CmdOrCtrl+N'),
        item('New Project', 'new-project', 'CmdOrCtrl+Shift+N'),
        { type: 'separator' },
        item('Export Sheet…', 'export-sheet', 'CmdOrCtrl+Shift+E'),
        item('Export Project…', 'export-project'),
        { type: 'separator' },
        { label: 'Show Library in Finder', click: () => shell.openPath(library.root) },
        { label: 'Change Library Location…', click: () => void chooseLibrary() },
        { type: 'separator' },
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
        { type: 'separator' },
        item('Toggle Preview', 'toggle-preview', 'CmdOrCtrl+Shift+P'),
        item('Focus Mode', 'toggle-focus', 'CmdOrCtrl+Shift+F'),
        item('Typewriter Mode', 'toggle-typewriter', 'CmdOrCtrl+Shift+T'),
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

async function chooseExportFormat(): Promise<ExportFormat | undefined> {
  const formats: ExportFormat[] = ['md', 'html', 'pdf']
  const options: Electron.MessageBoxOptions = {
    type: 'question',
    message: 'Export as…',
    buttons: ['Markdown', 'HTML', 'PDF', 'Cancel'],
    defaultId: 0,
    cancelId: 3
  }
  const { response } = mainWindow
    ? await dialog.showMessageBox(mainWindow, options)
    : await dialog.showMessageBox(options)
  return formats[response]
}

function registerIpc(): void {
  ipcMain.handle('projects:list', () => library.listProjects())
  ipcMain.handle('projects:create', (_e, name: string) => library.createProject(name))
  ipcMain.handle('projects:rename', (_e, id: string, name: string) => library.renameProject(id, name))
  ipcMain.handle('projects:reveal', (_e, id: string) => library.revealProject(id))
  ipcMain.handle('projects:delete', async (_e, id: string) => {
    const ok = await confirm(`Move “${id}” to the Trash?`, 'The project folder and all of its sheets will be moved to the Trash.', 'Move to Trash')
    if (ok) await library.deleteProject(id)
    return ok
  })

  ipcMain.handle('sheets:list', (_e, projectId: string) => library.listSheets(projectId))
  ipcMain.handle('sheets:read', (_e, projectId: string, id: string) => library.readSheet(projectId, id))
  ipcMain.handle('sheets:write', (_e, projectId: string, id: string, content: string) =>
    library.writeSheet(projectId, id, content)
  )
  ipcMain.handle('sheets:create', (_e, projectId: string, content?: string, afterId?: string) =>
    library.createSheet(projectId, content, afterId)
  )
  ipcMain.handle('sheets:delete', async (_e, projectId: string, id: string) => {
    const sheet = await library.readSheet(projectId, id)
    const ok = await confirm(`Move “${sheet.title || 'Untitled'}” to the Trash?`, 'You can restore it from the Trash later.', 'Move to Trash')
    if (ok) await library.deleteSheet(projectId, id)
    return ok
  })
  ipcMain.handle('sheets:reorder', (_e, projectId: string, order: string[]) => library.reorderSheets(projectId, order))
  ipcMain.handle('sheets:move', (_e, from: string, id: string, to: string) => library.moveSheet(from, id, to))
  ipcMain.handle('sheets:search', (_e, projectId: string, query: string) => library.searchSheets(projectId, query))

  ipcMain.handle('export', async (_e, projectId: string, sheetIds: string[] | null, format?: ExportFormat) => {
    format ??= await chooseExportFormat()
    if (!format) return null
    const doc = await library.compile(projectId, sheetIds ?? undefined)
    return exportDocument(mainWindow, doc, format)
  })

  ipcMain.handle('context-menu', (event, entries: ContextMenuEntry[]) => {
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
      menu.popup({ window: win, callback: () => setTimeout(() => resolve(null), 50) })
    })
  })
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

app.setName('Hermit Crab')

app.whenReady().then(async () => {
  await loadSettings()
  await openLibrary(
    process.env['HERMIT_LIBRARY'] ?? settings.libraryPath ?? path.join(app.getPath('documents'), 'Hermit Crab')
  )
  registerIpc()
  buildMenu()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  isQuitting = true
})

app.on('window-all-closed', () => {
  if (!isMac || isQuitting) app.quit()
})
