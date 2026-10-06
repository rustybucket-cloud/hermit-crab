import { useEffect, useRef, useState, type DragEvent, type MouseEvent, type ReactNode } from 'react'
import type { ProjectSummary } from '../../../shared/types'
import { ChevronIcon, FolderIcon, FolderPlusIcon, GearIcon, PlusIcon } from './Icons'

export const SHEET_DRAG_TYPE = 'application/x-hermit-sheet'
const LIBRARY_DRAG_TYPE = 'application/x-hermit-library-item'
const COLLAPSED_KEY = 'hermit:collapsed-folders'
const INDENT = 14

interface Props {
  projects: ProjectSummary[]
  /** Folders of projects, by path within the library. */
  folders: string[]
  activeId: string | null
  renamingId: string | null
  renamingFolder: string | null
  onSelect(id: string): void
  onCreate(): void
  onCreateFolder(): void
  onOpenSettings(): void
  onRename(id: string, name: string): void
  onRenameEnd(): void
  onStartRename(id: string): void
  onRenameFolder(folder: string, name: string): void
  onStartRenameFolder(folder: string): void
  onContextMenu(id: string): void
  onFolderMenu(folder: string): void
  /** Right-click on the library's blank space. */
  onLibraryMenu(): void
  onDropSheet(sheetId: string, fromProject: string, toProject: string): void
  /** Move a project or folder into a folder, or to the top of the library with null. */
  onMove(libraryPath: string, folder: string | null): void
}

const folderName = (folder: string) => folder.slice(folder.lastIndexOf('/') + 1)

function parentFolder(libraryPath: string): string | null {
  const i = libraryPath.lastIndexOf('/')
  return i === -1 ? null : libraryPath.slice(0, i)
}

const isWithin = (libraryPath: string | null, folder: string) =>
  libraryPath === folder || Boolean(libraryPath?.startsWith(`${folder}/`))

function useCollapsedFolders() {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]') as string[])
    } catch {
      return new Set()
    }
  })
  useEffect(() => localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed])), [collapsed])
  const set = (folder: string, value: boolean) =>
    setCollapsed((prev) => {
      if (prev.has(folder) === value) return prev
      const next = new Set(prev)
      if (value) next.add(folder)
      else next.delete(folder)
      return next
    })
  /** Open a folder and every folder above it. */
  const reveal = (folder: string | null) => {
    for (let f = folder; f; f = parentFolder(f)) set(f, false)
  }
  return { isCollapsed: (folder: string) => collapsed.has(folder), set, reveal }
}

export function LibraryPane(props: Props) {
  const { projects, folders, activeId, renamingId, renamingFolder } = props
  // A project a sheet is over, a folder, or '' for the top of the library.
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const dragging = useRef<string | null>(null)
  const collapsed = useCollapsedFolders()

  // Never hide the open project, or a folder being named, inside a collapsed folder.
  const activeFolder = activeId ? parentFolder(activeId) : null
  useEffect(() => collapsed.reveal(activeFolder), [activeFolder])
  useEffect(() => collapsed.reveal(renamingFolder && parentFolder(renamingFolder)), [renamingFolder])

  /** Drag handlers for a place a project or folder can be dropped into. */
  const folderDrop = (folder: string | null) => ({
    onDragOver: (e: DragEvent) => {
      const dragged = dragging.current
      if (!dragged || isWithin(folder, dragged) || parentFolder(dragged) === folder) return
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = 'move'
      setDropTarget(folder ?? '')
    },
    onDrop: (e: DragEvent) => {
      const dragged = dragging.current
      setDropTarget(null)
      if (!dragged) return
      e.preventDefault()
      e.stopPropagation()
      props.onMove(dragged, folder)
    }
  })

  const startDrag = (e: DragEvent, libraryPath: string) => {
    dragging.current = libraryPath
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData(LIBRARY_DRAG_TYPE, libraryPath)
  }

  const endDrag = () => {
    dragging.current = null
    setDropTarget(null)
  }

  const renderProject = (p: ProjectSummary, depth: number) => (
    <div
      key={p.id}
      className={`project-item${p.id === activeId ? ' active' : ''}${p.id === dropTarget ? ' drop-target' : ''}`}
      style={{ marginLeft: depth * INDENT }}
      draggable={p.id !== renamingId}
      onClick={() => props.onSelect(p.id)}
      onDoubleClick={() => props.onStartRename(p.id)}
      onContextMenu={(e) => {
        e.preventDefault()
        props.onContextMenu(p.id)
      }}
      onDragStart={(e) => startDrag(e, p.id)}
      onDragEnd={endDrag}
      onDragOver={(e) => {
        // A project or folder dropped here joins this project's folder.
        if (dragging.current) return folderDrop(p.folder).onDragOver(e)
        // Sheets dropped on a project move there.
        if (!e.dataTransfer.types.includes(SHEET_DRAG_TYPE) || p.id === activeId) return
        e.preventDefault()
        e.stopPropagation()
        e.dataTransfer.dropEffect = 'move'
        setDropTarget(p.id)
      }}
      onDragLeave={() => setDropTarget((t) => (t === p.id ? null : t))}
      onDrop={(e) => {
        if (dragging.current) return folderDrop(p.folder).onDrop(e)
        setDropTarget(null)
        const raw = e.dataTransfer.getData(SHEET_DRAG_TYPE)
        if (!raw) return
        e.preventDefault()
        e.stopPropagation()
        const { projectId, sheetId } = JSON.parse(raw) as { projectId: string; sheetId: string }
        if (projectId !== p.id) props.onDropSheet(sheetId, projectId, p.id)
      }}
    >
      <FolderIcon className="project-icon" />
      {p.id === renamingId ? (
        <RenameField initial={p.name} onCommit={(name) => props.onRename(p.id, name)} onCancel={props.onRenameEnd} />
      ) : (
        <>
          <span className="project-name">{p.name}</span>
          <span className="project-count">{p.sheetCount}</span>
        </>
      )}
    </div>
  )

  const renderFolder = (folder: string, depth: number): ReactNode[] => {
    const open = !collapsed.isCollapsed(folder)
    const children = open ? renderLevel(folder, depth + 1) : []
    const count = projects.filter((p) => isWithin(p.id, folder)).length
    return [
      <div
        key={`folder:${folder}`}
        className={['library-folder', open && 'open', dropTarget === folder && 'drop-target'].filter(Boolean).join(' ')}
        style={{ marginLeft: depth * INDENT }}
        draggable={folder !== renamingFolder}
        onClick={() => collapsed.set(folder, open)}
        onDoubleClick={() => props.onStartRenameFolder(folder)}
        onContextMenu={(e) => {
          e.preventDefault()
          props.onFolderMenu(folder)
        }}
        onDragStart={(e) => startDrag(e, folder)}
        onDragEnd={endDrag}
        onDragLeave={() => setDropTarget((t) => (t === folder ? null : t))}
        {...folderDrop(folder)}
      >
        <ChevronIcon className="library-folder-chevron" />
        {folder === renamingFolder ? (
          <RenameField
            initial={folderName(folder)}
            onCommit={(name) => props.onRenameFolder(folder, name)}
            onCancel={props.onRenameEnd}
          />
        ) : (
          <>
            <span className="library-folder-name">{folderName(folder)}</span>
            <span className="project-count">{count}</span>
          </>
        )}
      </div>,
      ...children,
      ...(open && !children.length
        ? [
            <div
              key={`empty:${folder}`}
              className="library-empty"
              style={{ marginLeft: (depth + 1) * INDENT }}
              onContextMenu={(e) => {
                e.preventDefault()
                props.onFolderMenu(folder)
              }}
              {...folderDrop(folder)}
            >
              Empty
            </div>
          ]
        : [])
    ]
  }

  /** Folders first, then projects; both lists arrive sorted by name. */
  const renderLevel = (folder: string | null, depth: number): ReactNode[] => [
    ...folders.filter((f) => parentFolder(f) === folder).flatMap((f) => renderFolder(f, depth)),
    ...projects.filter((p) => p.folder === folder).map((p) => renderProject(p, depth))
  ]

  return (
    <aside className="pane library" onContextMenu={blankContextMenu(props.onLibraryMenu)}>
      <header className="pane-header" />
      <div className="library-section-label">Projects</div>
      <nav
        className={`project-list${dropTarget === '' ? ' drop-target' : ''}`}
        // Anywhere outside a folder means the top of the library.
        onDragLeave={(e) => e.currentTarget === e.target && setDropTarget((t) => (t === '' ? null : t))}
        {...folderDrop(null)}
      >
        {renderLevel(null, 0)}
      </nav>
      <footer className="library-footer">
        <button className="ghost-button" onClick={props.onCreate} title="New Project (⇧⌘N)">
          <PlusIcon /> New Project
        </button>
        <div className="library-footer-actions">
          <button className="icon-button" onClick={props.onCreateFolder} title="New Folder">
            <FolderPlusIcon />
          </button>
          <button className="icon-button" onClick={props.onOpenSettings} title="Settings (⌘,)">
            <GearIcon />
          </button>
        </div>
      </footer>
    </aside>
  )
}

/** Right-clicks on a pane's blank space. Rows show their own menus, and text fields keep the edit menu. */
export const blankContextMenu = (show: () => void) => (e: MouseEvent) => {
  if (e.defaultPrevented || (e.target as Element).closest('input, textarea')) return
  e.preventDefault()
  show()
}

export function RenameField({
  initial,
  onCommit,
  onCancel
}: {
  initial: string
  onCommit(name: string): void
  onCancel(): void
}) {
  const input = useRef<HTMLInputElement>(null)
  const done = useRef(false)

  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])

  const commit = () => {
    if (done.current) return
    done.current = true
    const name = input.current?.value.trim() ?? ''
    if (name && name !== initial) onCommit(name)
    else onCancel()
  }

  return (
    <input
      ref={input}
      className="rename-field"
      defaultValue={initial}
      onClick={(e) => e.stopPropagation()}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
        if (e.key === 'Escape') {
          done.current = true
          onCancel()
        }
      }}
    />
  )
}
