export interface ProjectSummary {
  /** Path of the project's folder within the library, such as `Fiction/My Novel`. */
  id: string
  /** The last part of the path. */
  name: string
  /** Path of the folder of projects it's in, or null at the top of the library. */
  folder: string | null
  /** Counts cover the content only. */
  sheetCount: number
  wordCount: number
  updatedAt: number
  settings: ProjectSettings
}

/** How a project's content is written: prose in Markdown, or a screenplay in Fountain. Notes are always Markdown. */
export type ContentFormat = 'markdown' | 'fountain'

/** Settings that belong to a project, kept in its folder so they sync with it. */
export interface ProjectSettings {
  format: ContentFormat
}

/** The content is the work itself, the part that gets exported; notes are the planning and research behind it. */
export type Section = 'content' | 'notes'

/** Where a sheet lives in its project: a section, and perhaps a subsection of it. */
export interface SheetPlace {
  section: Section
  /** Path of the subsection within its section, such as `Part One` or `Characters/Minor`; null at the top level. */
  subsection: string | null
}

export interface SheetSummary extends SheetPlace {
  /**
   * Path within the project without the `.md` extension, such as `<name>` or `Part One/<name>`.
   * Notes live in a `Notes` folder, so their ids are `Notes/<name>`, or `Notes/Characters/<name>`.
   * Canvases, which are always notes, keep their extension: `Notes/<name>.canvas`.
   */
  id: string
  title: string
  excerpt: string
  wordCount: number
  updatedAt: number
}

export interface Sheet extends SheetSummary {
  /** Markdown, or for a canvas, its JSON. */
  content: string
}

/** One row of a project's outline: a sheet, or the heading of a subsection. */
export type OutlineItem =
  | ({ kind: 'sheet'; id: string } & SheetPlace)
  | { kind: 'subsection'; section: Section; subsection: string }

/** Where to move an outline item: next to another one, or to the end of a section or subsection. */
export type OutlineTarget = { before: OutlineItem } | { after: OutlineItem } | { into: SheetPlace }

export interface Outline {
  /** Every sheet, content then notes, in reading order. */
  sheets: SheetSummary[]
  /** Sheets and subsections in reading order; each subsection's heading comes before what's in it. */
  items: OutlineItem[]
}

/** `md` and `fountain` save the text as written; which one fits depends on the project. */
export type ExportFormat = 'md' | 'fountain' | 'html' | 'pdf'

export interface ContextMenuItem {
  id: string
  label: string
  enabled?: boolean
}

export type ContextMenuEntry = ContextMenuItem | { type: 'separator' }

export type MenuAction =
  | 'new-sheet'
  | 'new-canvas'
  | 'new-project'
  | 'export-sheet'
  | 'export-project'
  | 'project-settings'
  | 'toggle-library'
  | 'toggle-sheets'
  | 'toggle-sidebars'
  | 'toggle-section'
  | 'toggle-preview'
  | 'toggle-focus'
  | 'toggle-typewriter'
  | 'toggle-grammar'
  | 'font-sans'
  | 'font-serif'
  | 'font-mono'
  | 'font-bigger'
  | 'font-smaller'
  | 'font-reset'
  | 'find'
  | 'next-sheet'
  | 'prev-sheet'
  | 'format-bold'
  | 'format-italic'
  | 'format-code'
  | 'format-link'
  | 'format-heading'
  | 'format-quote'
  | 'open-settings'
  | 'sync-now'
  | 'library-changed'

export type SyncAgent = 'claude' | 'codex'

/** How the library syncs with its GitHub remote. Lives in the main process settings file. */
export interface SyncSettings {
  enabled: boolean
  branch: string
  /** Seconds of quiet after an edit before changes are committed and pushed. */
  commitDelay: number
  /** Minutes between checks for changes on GitHub. */
  pullInterval: number
  agent: SyncAgent
  /** Hand new conflicts straight to the agent, then open the merge editor to review. */
  autoResolve: boolean
}

export type SyncStatus = 'off' | 'idle' | 'syncing' | 'conflict' | 'resolving' | 'error'

export interface SyncState {
  settings: SyncSettings
  gitAvailable: boolean
  /** Which conflict helpers are installed on this machine. */
  agents: Record<SyncAgent, boolean>
  remoteUrl: string | null
  status: SyncStatus
  message?: string
  lastSyncedAt?: number
  /** Library-relative paths with unresolved conflicts. */
  conflicts: string[]
}

export interface ConflictFile {
  /** Library-relative path, always with forward slashes. */
  path: string
  /** A readable name: the sheet title and its project. */
  label: string
  /** This Mac's version, or null if it was deleted here. */
  ours: string | null
  /** GitHub's version, or null if it was deleted there. */
  theirs: string | null
  /** The file as it is on disk, with conflict markers. */
  content: string
}

/** The API the preload script exposes to the renderer as `window.hermit`. */
export interface HermitApi {
  platform: string
  listProjects(): Promise<ProjectSummary[]>
  createProject(name: string, folder?: string | null): Promise<ProjectSummary>
  renameProject(projectId: string, name: string): Promise<ProjectSummary>
  deleteProject(projectId: string): Promise<boolean>
  revealProject(projectId: string): Promise<void>
  updateProjectSettings(projectId: string, patch: Partial<ProjectSettings>): Promise<ProjectSummary>
  /** Folders of projects, by path within the library, such as `Fiction` and `Fiction/Novels`. */
  listFolders(): Promise<string[]>
  /** Resolves with the new folder's path; its name may differ to avoid a clash. */
  createFolder(name: string, parent?: string | null): Promise<string>
  /** Resolves with the folder's new path. */
  renameFolder(folder: string, name: string): Promise<string>
  deleteFolder(folder: string): Promise<boolean>
  /** Move a project or folder into a folder, or to the top of the library with null. Resolves with its new path. */
  moveInLibrary(libraryPath: string, folder: string | null): Promise<string>
  listOutline(projectId: string): Promise<Outline>
  readSheet(projectId: string, sheetId: string): Promise<Sheet>
  writeSheet(projectId: string, sheetId: string, content: string): Promise<SheetSummary>
  createSheet(projectId: string, content?: string, afterId?: string, place?: SheetPlace): Promise<Sheet>
  /** `place` must be in the notes. The canvas's name may differ to avoid a clash. */
  createCanvas(projectId: string, place: SheetPlace, name?: string, content?: string, afterId?: string): Promise<Sheet>
  /** Resolves with the ids that changed, old to new. */
  renameCanvas(projectId: string, sheetId: string, name: string): Promise<Record<string, string>>
  /** Copy an image into the project. Resolves with its path within the project. */
  saveAttachment(projectId: string, name: string, data: Uint8Array): Promise<string>
  deleteSheet(projectId: string, sheetId: string): Promise<boolean>
  moveSheet(fromProject: string, sheetId: string, toProject: string): Promise<void>
  /** Reorder or refile a sheet or subsection. Resolves with the sheet ids that changed, old to new. */
  moveInOutline(projectId: string, item: OutlineItem, target: OutlineTarget): Promise<Record<string, string>>
  /** Resolves with where it was made; its name may differ to avoid a clash. */
  createSubsection(projectId: string, parent: SheetPlace, name: string): Promise<SheetPlace>
  /** Resolves with the sheet ids that changed, old to new. */
  renameSubsection(projectId: string, place: SheetPlace, name: string): Promise<Record<string, string>>
  deleteSubsection(projectId: string, place: SheetPlace): Promise<boolean>
  searchSheets(projectId: string, query: string): Promise<string[]>
  /** Without ids, exports the project's content. Without a format, the user is asked to pick one. */
  exportSheets(projectId: string, sheetIds: string[] | null, format?: ExportFormat): Promise<string | null>
  /** Shows at the pointer, or at `at` in window coordinates, such as below a button. */
  showContextMenu(items: ContextMenuEntry[], at?: { x: number; y: number }): Promise<string | null>
  getSyncState(): Promise<SyncState>
  updateSyncSettings(patch: Partial<SyncSettings>): Promise<SyncState>
  /** Point the library at a GitHub repository and run a first sync. */
  connectSync(remoteUrl: string): Promise<SyncState>
  syncNow(): Promise<SyncState>
  listConflicts(): Promise<ConflictFile[]>
  /** Write a resolved file (or delete it, with null) and mark it resolved. */
  resolveConflict(path: string, content: string | null): Promise<SyncState>
  /** Commit the merge once every file is resolved, then push. */
  finishMerge(): Promise<SyncState>
  /** Ask Claude Code or Codex to resolve the conflict markers on disk. Resolves with the agent's output. */
  resolveWithAgent(): Promise<{ ok: boolean; output: string }>
  cancelAgent(): Promise<void>
  onSyncState(listener: (state: SyncState) => void): () => void
  /** Files a pull changed on disk, so open sheets can reload. */
  onSyncChanged(listener: (paths: string[]) => void): () => void
  /** Main asks the renderer to save unsaved edits before it commits or merges. */
  onSyncFlush(listener: () => Promise<void>): () => void
  onAgentOutput(listener: (chunk: string) => void): () => void
  onMenu(listener: (action: MenuAction) => void): () => void
  onBeforeClose(listener: () => Promise<void>): () => void
}
