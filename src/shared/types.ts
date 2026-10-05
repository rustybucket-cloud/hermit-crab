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
  | 'library-changed'

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
  onMenu(listener: (action: MenuAction) => void): () => void
  onBeforeClose(listener: () => Promise<void>): () => void
}
