import { App } from '@capacitor/app'
import { Capacitor } from '@capacitor/core'
import { Preferences } from '@capacitor/preferences'
import { Collections, FIRST_COLLECTION, Library } from '../shared/library'
import { normalizeSyncSettings } from '../shared/sync'
import type { CollectionList, ExportFormat, HermitApi, MenuAction, SyncSettings, SyncState } from '../shared/types'
import { createWelcomeProject } from '../shared/welcome'
import { exportDocument } from './export'
import { nativeFs } from './fs'
import { confirmAction, showMenu } from './menu'
import { native } from './native'
import { MobileSync, type Author } from './sync'

/**
 * `window.hermit` for the iOS app. The desktop's main process does this work over IPC; here it all runs in the
 * page, with the native plugin for files and the rest. The library and its files are the same as on the desktop.
 */

/** Where the library lives: the app's own folder, or one the user picked (such as in iCloud Drive). */
type Location = { kind: 'app' } | { kind: 'folder'; id: string }

const KEYS = {
  location: 'libraryLocation',
  /** The collection open on this device. */
  collection: 'collection',
  sync: 'syncSettings',
  author: 'syncAuthor',
  welcomed: 'welcomed',
  /**
   * The welcome project as it was made, so it can be told apart from one that's been written in. Its `path` is
   * within the library; from before collections, its `project` is within the first collection.
   */
  welcome: 'welcomeProject'
}

interface Welcome {
  path?: string
  project?: string
  print: string
}

/** iPads and iPhones share the app; some wording names the device. */
const device: 'iPad' | 'iPhone' =
  /iPad/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1)
    ? 'iPad'
    : 'iPhone'

function channel<T>() {
  const listeners = new Set<(payload: T) => void>()
  return {
    emit: (payload: T) => listeners.forEach((listener) => listener(payload)),
    on(listener: (payload: T) => void) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    }
  }
}

/** Menu actions, which on the iPad also come from keyboard shortcuts. */
export const menuActions = channel<MenuAction>()

async function loadJson<T>(key: string): Promise<T | null> {
  try {
    const { value } = await Preferences.get({ key })
    return value ? (JSON.parse(value) as T) : null
  } catch {
    return null
  }
}

const saveJson = (key: string, value: unknown) => Preferences.set({ key, value: JSON.stringify(value) })

/** A folder's path as people know it: “iCloud Drive › Writing” rather than where iOS keeps it. */
function describeFolder(path: string): string {
  const icloud = /\/Mobile Documents\/com~apple~CloudDocs\/?(.*)$/.exec(path)
  if (icloud) return ['iCloud Drive', ...icloud[1].split('/').filter(Boolean)].join(' › ')
  const local = /\/File Provider Storage\/?(.*)$/.exec(path)
  if (local) return [`On My ${device}`, ...local[1].split('/').filter(Boolean)].join(' › ')
  return path
}

const lastSegment = (p: string) => p.slice(p.lastIndexOf('/') + 1)

/** A short fingerprint of every file in a folder, paths and contents, to tell whether any has changed. */
async function fingerprint(dir: string): Promise<string> {
  const lines: string[] = []
  const visit = async (folder: string, prefix: string): Promise<void> => {
    for (const entry of await nativeFs.readdir(folder)) {
      const path = `${folder}/${entry.name}`
      if (entry.isDirectory) await visit(path, `${prefix}${entry.name}/`)
      else if (entry.isFile) lines.push(`${prefix}${entry.name}\n${await nativeFs.readText(path)}`)
    }
  }
  await visit(dir, '')
  // FNV-1a, which is plenty to notice an edit.
  let hash = 0x811c9dc5
  for (const char of lines.sort().join('\0')) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193)
  return `${lines.length}:${(hash >>> 0).toString(16)}`
}
const plural = (n: number, noun: string) => (n === 1 ? `the ${noun}` : `the ${n} ${noun}s`)

export function createMobileApi(): HermitApi {
  let collections!: Collections
  /** The open collection. */
  let library!: Library
  let collection = FIRST_COLLECTION
  let location: Location = { kind: 'app' }
  /** Why the library can't be opened, if it can't. */
  let problem: string | null = null
  let paths!: { documents: string; support: string }
  let sync!: MobileSync

  const syncStates = channel<SyncState>()
  const syncChanged = channel<string[]>()
  const flushers = new Set<() => Promise<void>>()
  const closers = new Set<() => Promise<void>>()
  const runAll = (set: Set<() => Promise<void>>) => Promise.all([...set].map((f) => f().catch(() => {}))).then(() => {})

  const gitdirFor = (where: Location) => `${paths.support}/Sync/${where.kind === 'app' ? 'library' : where.id}`

  async function openLibrary(where: Location): Promise<void> {
    location = where
    problem = null
    let root = paths.documents
    if (where.kind === 'folder') {
      const { path } = await native.restoreFolder()
      if (path) {
        root = path
        // Have iCloud bring everything down, so the library reads quickly and works offline.
        void native.downloadFolder({ path })
      } else {
        problem = `Hermit Crab can no longer open the library folder you chose. Choose it again, or keep the library on this ${device}.`
      }
    }
    collections = new Collections(root, nativeFs)
    library = collections.open(collection)
    if (problem) return
    await collections.ensure()
    await collections.tidy(await loadJson<string>(KEYS.collection))
    await openCollection(await loadJson<string>(KEYS.collection))
    // The app's own folder starts with a project that shows how things work.
    if (where.kind === 'app' && !(await loadJson<boolean>(KEYS.welcomed))) {
      const entries = await nativeFs.readdir(library.root)
      if (!entries.some((e) => !e.name.startsWith('.'))) {
        const project = await createWelcomeProject(library, 'ios')
        const welcome: Welcome = { path: `${collection}/${project}`, print: await fingerprint(library.libraryDir(project)) }
        await saveJson(KEYS.welcome, welcome)
      }
      await saveJson(KEYS.welcomed, true)
    }
  }

  /** Open `wanted`, or another collection if it's gone. */
  async function openCollection(wanted?: string | null): Promise<CollectionList> {
    const list = await collections.pick(wanted)
    library = collections.open(list.active)
    if (list.active !== collection) {
      collection = list.active
      await saveJson(KEYS.collection, collection)
    }
    return list
  }

  let tidying: Promise<void> | null = null

  /** Gather projects an older copy of the app synced in to the top of the library into a collection. */
  function tidyLibrary(): Promise<void> {
    tidying ??= (async () => {
      if (problem) return
      const moved = await collections.tidy(collection)
      if (!moved.length) return
      sync.noteChange()
      syncChanged.emit(moved)
    })()
      .catch((err) => console.error('Tidying the library failed', err))
      .finally(() => (tidying = null))
    return tidying
  }

  const ready = (async () => {
    const [documents, support] = await Promise.all([native.documentsPath(), native.supportPath()])
    paths = { documents: documents.path, support: support.path }
    await openLibrary((await loadJson<Location>(KEYS.location)) ?? { kind: 'app' })

    const settings = normalizeSyncSettings((await loadJson<Partial<SyncSettings>>(KEYS.sync)) ?? undefined)
    sync = new MobileSync(
      collections.root,
      gitdirFor(location),
      settings,
      await loadJson<Author>(KEYS.author),
      {
        flush: () => runAll(flushers),
        emitState: (state) => {
          syncStates.emit(state)
          // Once git's done with the files, anything it brought in loose can move into a collection.
          if (state.status === 'idle') void tidyLibrary()
        },
        emitChanged: (changed) => changed.length && syncChanged.emit(changed),
        saveSettings: (next) => saveJson(KEYS.sync, next).then(() => {}),
        beforeJoining: leaveWelcomeBehind
      },
      (author) => saveJson(KEYS.author, author).then(() => {})
    )
    // Starting reads the repository's state; the first sync then runs on its own.
    await sync.start()

    // Save as soon as the app is put aside, then give sync a little time in the background to send it.
    void App.addListener('appStateChange', ({ isActive }) => {
      if (isActive) sync.pullSoon()
      else void runAll(closers)
    })
    void App.addListener('pause', async () => {
      const { id } = await native.beginBackgroundTask()
      try {
        await runAll(closers)
        await Promise.race([sync.sync(), new Promise((resolve) => setTimeout(resolve, 20_000))])
      } finally {
        await native.endBackgroundTask({ id })
      }
    })
  })()

  /**
   * The welcome project doesn't belong in a library someone already writes in elsewhere. When the app first
   * joins a repository that has writing in it, the welcome project goes, unless it's been written in.
   */
  async function leaveWelcomeBehind(): Promise<void> {
    const welcome = await loadJson<Welcome>(KEYS.welcome)
    if (!welcome || location.kind !== 'app') return
    await Preferences.remove({ key: KEYS.welcome })
    const path = welcome.path ?? `${FIRST_COLLECTION}/${welcome.project}`
    const dir = `${collections.root}/${path}`
    if (!(await nativeFs.exists(dir)) || (await fingerprint(dir)) !== welcome.print) return
    await runAll(flushers)
    await nativeFs.remove(dir)
    syncChanged.emit([path])
  }

  /** The library, once it's open; or why it can't be. */
  const lib = async () => {
    await ready
    if (problem) throw new Error(problem)
    return library
  }

  /** Run a library change, then let sync know there's something to commit. */
  const changed = async <T>(work: (library: Library) => Promise<T>): Promise<T> => {
    const result = await work(await lib())
    sync.noteChange()
    return result
  }

  const describeLocation = () =>
    location.kind === 'app' ? `On My ${device} › Hermit Crab` : describeFolder(collections.root)

  const switchLibrary = async (where: Location) => {
    // Save edits into the library they belong to before switching.
    await runAll(flushers)
    await saveJson(KEYS.location, where)
    await openLibrary(where)
    await sync.setRoot(collections.root, gitdirFor(where), normalizeSyncSettings((await loadJson(KEYS.sync)) ?? undefined))
    menuActions.emit('library-changed')
  }

  return {
    platform: 'ios',

    getLibraryLocation: async () => {
      await ready
      return describeLocation()
    },

    async chooseLibraryLocation() {
      await ready
      const choice = await showMenu(
        [
          { id: 'folder', label: 'Choose a Folder…' },
          { id: 'app', label: `Keep on This ${device}`, enabled: location.kind !== 'app' }
        ],
        { title: 'Library Location' }
      )
      if (choice === 'folder') {
        const { path } = await native.pickFolder()
        if (!path) return null
        await switchLibrary({ kind: 'folder', id: Date.now().toString(36) })
      } else if (choice === 'app') {
        await native.forgetFolder()
        await switchLibrary({ kind: 'app' })
      } else {
        return null
      }
      return describeLocation()
    },

    revealLibrary: async () => {},
    revealProject: async () => {},
    setAppIcon: () => {},

    fileUrl: (libraryPath) =>
      Capacitor.convertFileSrc(`${library?.root ?? ''}/${libraryPath}`.split('/').map(encodeURIComponent).join('/')),

    listCollections: async () => {
      await lib()
      return openCollection(collection)
    },
    openCollection: async (name) => {
      await lib()
      return openCollection(name)
    },
    createCollection: async (name) => {
      await lib()
      const created = await collections.create(name)
      sync.noteChange()
      return created
    },
    async renameCollection(name, next) {
      await lib()
      const renamed = await collections.rename(name, next)
      sync.noteChange()
      if (name === collection) await openCollection(renamed)
      return renamed
    },
    async deleteCollection(name) {
      await lib()
      if ((await collections.list()).length < 2) return false
      const inside = (await collections.open(name).listProjects()).length
      const ok = await confirmAction(
        `Delete “${name}”?`,
        inside ? `${plural(inside, 'project')} in it will be deleted too. This can’t be undone.` : 'It has no projects in it.',
        'Delete Collection'
      )
      if (!ok) return false
      await collections.remove(name)
      sync.noteChange()
      if (name === collection) await openCollection()
      return true
    },
    moveToCollection: (libraryPath, to) => changed(() => collections.move(collection, libraryPath, to)),

    listProjects: async () => (await lib()).listProjects(),
    listFolders: async () => (await lib()).listFolders(),
    createProject: (name, folder) => changed((l) => l.createProject(name, folder)),
    renameProject: (id, name) => changed((l) => l.renameProject(id, name)),
    updateProjectSettings: (id, patch) => changed((l) => l.updateProjectSettings(id, patch)),
    archiveProject: (id) => changed((l) => l.archiveProject(id)),
    restoreProject: (id) => changed((l) => l.restoreProject(id)),

    async deleteProject(id) {
      const ok = await confirmAction(
        `Delete “${lastSegment(id)}”?`,
        'The project and all of its sheets will be deleted. This can’t be undone.',
        'Delete Project'
      )
      if (ok) await changed((l) => l.deleteProject(id))
      return ok
    },

    createFolder: (name, parent) => changed((l) => l.createFolder(name, parent)),
    renameFolder: (folder, name) => changed((l) => l.renameFolder(folder, name)),
    async deleteFolder(folder) {
      const inside = (await (await lib()).listProjects()).filter((p) => p.id.startsWith(`${folder}/`)).length
      const ok = await confirmAction(
        `Delete “${lastSegment(folder)}”?`,
        inside ? `${plural(inside, 'project')} in it will be deleted too. This can’t be undone.` : 'It has no projects in it.',
        'Delete Folder'
      )
      if (ok) await changed((l) => l.deleteFolder(folder))
      return ok
    },
    moveInLibrary: (libraryPath, folder) => changed((l) => l.moveInLibrary(libraryPath, folder)),

    listOutline: async (projectId) => (await lib()).listOutline(projectId),
    readSheet: async (projectId, sheetId) => (await lib()).readSheet(projectId, sheetId),
    writeSheet: (projectId, sheetId, content) => changed((l) => l.writeSheet(projectId, sheetId, content)),
    createSheet: (projectId, content, afterId, place) => changed((l) => l.createSheet(projectId, content, afterId, place)),
    createCanvas: (projectId, place, name, content, afterId) =>
      changed((l) => l.createCanvas(projectId, place, name, content, afterId)),
    renameCanvas: (projectId, sheetId, name) => changed((l) => l.renameCanvas(projectId, sheetId, name)),
    saveAttachment: (projectId, name, data) => changed((l) => l.saveAttachment(projectId, name, data)),

    async deleteSheet(projectId, sheetId) {
      const sheet = await (await lib()).readSheet(projectId, sheetId)
      const ok = await confirmAction(`Delete “${sheet.title || 'Untitled'}”?`, 'This can’t be undone.', 'Delete')
      if (ok) await changed((l) => l.deleteSheet(projectId, sheetId))
      return ok
    },

    moveSheet: (from, sheetId, to) => changed((l) => l.moveSheet(from, sheetId, to)),
    moveInOutline: (projectId, item, target) => changed((l) => l.moveInOutline(projectId, item, target)),
    createSubsection: (projectId, parent, name) => changed((l) => l.createSubsection(projectId, parent, name)),
    renameSubsection: (projectId, place, name) => changed((l) => l.renameSubsection(projectId, place, name)),

    async deleteSubsection(projectId, place) {
      const sub = place.subsection ?? ''
      const inside = (await (await lib()).listSheets(projectId)).filter(
        (s) => s.section === place.section && (s.subsection === sub || s.subsection?.startsWith(`${sub}/`))
      ).length
      const noun = place.section === 'notes' ? 'note' : 'sheet'
      const ok = await confirmAction(
        `Delete “${lastSegment(sub)}”?`,
        inside ? `${plural(inside, noun)} in it will be deleted too. This can’t be undone.` : `It has no ${noun}s in it.`,
        'Delete Subsection'
      )
      if (ok) await changed((l) => l.deleteSubsection(projectId, place))
      return ok
    },

    archiveInOutline: (projectId, item) => changed((l) => l.archiveInOutline(projectId, item)),
    restoreSheet: (projectId, sheetId) => changed((l) => l.restoreSheet(projectId, sheetId)),
    searchSheets: async (projectId, query) => (await lib()).searchSheets(projectId, query),

    async exportSheets(projectId, sheetIds, format) {
      const doc = await (await lib()).compile(projectId, sheetIds ?? undefined)
      if (!format) {
        const screenplay = doc.format === 'fountain'
        const choice = await showMenu(
          [
            { id: screenplay ? 'fountain' : 'md', label: screenplay ? 'Fountain' : 'Markdown' },
            { id: 'html', label: 'HTML' },
            { id: 'pdf', label: 'PDF' }
          ],
          { title: 'Export as' }
        )
        if (!choice) return null
        format = choice as ExportFormat
      }
      return exportDocument(doc, format, `${paths.support}/Exports`)
    },

    showContextMenu: (items, at) => showMenu(items, { at }),

    getSyncState: async () => {
      await ready
      return sync.getState()
    },
    updateSyncSettings: async (patch) => {
      await ready
      return sync.updateSettings(patch)
    },
    setSyncToken: async (token) => {
      await ready
      return sync.setToken(token)
    },
    connectSync: async (url) => {
      await lib()
      return sync.connect(url)
    },
    syncNow: async () => {
      await lib()
      await sync.sync()
      return sync.getState()
    },
    listConflicts: async () => {
      await ready
      return sync.listConflicts()
    },
    resolveConflict: async (path, content) => {
      await ready
      return sync.resolveConflict(path, content)
    },
    finishMerge: async () => {
      await ready
      return sync.finishMerge()
    },
    resolveWithAgent: async () => {
      throw new Error('Conflict helpers run on a computer, not on iOS.')
    },
    cancelAgent: async () => {},

    onSyncState: (listener) => syncStates.on(listener),
    onSyncChanged: (listener) => syncChanged.on(listener),
    onSyncFlush(listener) {
      flushers.add(listener)
      return () => void flushers.delete(listener)
    },
    onAgentOutput: () => () => {},
    onMenu: (listener) => menuActions.on(listener),
    onBeforeClose(listener) {
      closers.add(listener)
      return () => void closers.delete(listener)
    }
  }
}
