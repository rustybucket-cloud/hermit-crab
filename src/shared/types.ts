export interface ProjectSummary {
  /** Folder name inside the library. Doubles as the display name. */
  id: string
  name: string
  sheetCount: number
  wordCount: number
  updatedAt: number
}

export interface SheetSummary {
  /** File name without the `.md` extension. */
  id: string
  title: string
  excerpt: string
  wordCount: number
  updatedAt: number
}

export interface Sheet extends SheetSummary {
  content: string
}

export type ExportFormat = 'md' | 'html' | 'pdf'

export interface ContextMenuItem {
  id: string
  label: string
  enabled?: boolean
}

export type ContextMenuEntry = ContextMenuItem | { type: 'separator' }

export type MenuAction =
  | 'new-sheet'
  | 'new-project'
  | 'export-sheet'
  | 'export-project'
  | 'toggle-library'
  | 'toggle-sheets'
  | 'toggle-sidebars'
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
  createProject(name: string): Promise<ProjectSummary>
  renameProject(projectId: string, name: string): Promise<ProjectSummary>
  deleteProject(projectId: string): Promise<boolean>
  revealProject(projectId: string): Promise<void>
  listSheets(projectId: string): Promise<SheetSummary[]>
  readSheet(projectId: string, sheetId: string): Promise<Sheet>
  writeSheet(projectId: string, sheetId: string, content: string): Promise<SheetSummary>
  createSheet(projectId: string, content?: string, afterId?: string): Promise<Sheet>
  deleteSheet(projectId: string, sheetId: string): Promise<boolean>
  reorderSheets(projectId: string, order: string[]): Promise<void>
  moveSheet(fromProject: string, sheetId: string, toProject: string): Promise<void>
  searchSheets(projectId: string, query: string): Promise<string[]>
  /** Without a format, the user is asked to pick one. */
  exportSheets(projectId: string, sheetIds: string[] | null, format?: ExportFormat): Promise<string | null>
  showContextMenu(items: ContextMenuEntry[]): Promise<string | null>
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
