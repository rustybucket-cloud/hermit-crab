import { useEffect, useRef, useState, type DragEvent, type MouseEvent, type ReactNode } from 'react'
import type { ProjectSummary } from '../../../shared/types'
import { touch } from '../device'
import { ChevronIcon, ChevronsUpDownIcon, FolderIcon, GearIcon, PlusIcon } from './Icons'

export const SHEET_DRAG_TYPE = 'application/x-hermit-sheet'
const LIBRARY_DRAG_TYPE = 'application/x-hermit-library-item'
const COLLAPSED_KEY = 'hermit:collapsed-folders'
const ARCHIVE_OPEN_KEY = 'hermit:archive-open'
const INDENT = 14

interface Props {
  /** The open collection, whose projects these are. */
  collection: string
  renamingCollection: boolean
  projects: ProjectSummary[]
  /** Projects in the archive, sorted by name. */
  archived: ProjectSummary[]
  /** Folders of projects, by path within the library. */
  folders: string[]
  activeId: string | null
  renamingId: string | null
  renamingFolder: string | null
  onSelect(id: string): void
  /** The collection switcher's menu, shown over it. */
  onCollectionMenu(at: { x: number; y: number }): void
  onRenameCollection(name: string): void
  /** The new-item menu, shown over the footer's add button. */
  onNewMenu(at: { x: number; y: number }): void
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
  /** Move a project into the archive. */
  onArchive(projectId: string): void
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
  const { projects, archived, folders, activeId, renamingId, renamingFolder } = props
  // A project a sheet is over, a folder, or '' for the top of the library.
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  // Whether a project being dragged is over the archive.
  const [archiveDrop, setArchiveDrop] = useState(false)
  const dragging = useRef<string | null>(null)
  const collapsed = useCollapsedFolders()
  const [archiveOpen, setArchiveOpen] = useState(() => localStorage.getItem(ARCHIVE_OPEN_KEY) === 'true')
  useEffect(() => localStorage.setItem(ARCHIVE_OPEN_KEY, String(archiveOpen)), [archiveOpen])

  // Never hide the open project, or a folder being named, inside a collapsed folder or the archive.
  const activeFolder = activeId ? parentFolder(activeId) : null
  useEffect(() => collapsed.reveal(activeFolder), [activeFolder])
  useEffect(() => collapsed.reveal(renamingFolder && parentFolder(renamingFolder)), [renamingFolder])
  const activeArchived = archived.some((p) => p.id === activeId)
  useEffect(() => {
    if (activeArchived) setArchiveOpen(true)
  }, [activeArchived])

  /** Drag handlers for the archive, which takes projects but not folders. */
  const isProject = (libraryPath: string | null) => projects.some((p) => p.id === libraryPath)
  const archiveDropHandlers = {
    onDragOver: (e: DragEvent) => {
      // Stop here either way, so the list behind doesn't take it as a move to the top of the library.
      e.stopPropagation()
      if (!isProject(dragging.current)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      setArchiveDrop(true)
    },
    onDragLeave: (e: DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setArchiveDrop(false)
    },
    onDrop: (e: DragEvent) => {
      const dragged = dragging.current
      setArchiveDrop(false)
      if (!dragged || !isProject(dragged)) return
      e.preventDefault()
      e.stopPropagation()
      props.onArchive(dragged)
    }
  }

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
    setArchiveDrop(false)
  }

  const renderProject = (p: ProjectSummary, depth: number) => (
    <div
      key={p.id}
      className={`project-item${p.id === activeId ? ' active' : ''}${p.id === dropTarget ? ' drop-target' : ''}`}
      style={{ marginLeft: depth * INDENT }}
      draggable={!touch && p.id !== renamingId}
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
        draggable={!touch && folder !== renamingFolder}
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

  /** An archived project, by name, with the folder it came from in its tooltip. */
  const renderArchived = (p: ProjectSummary) => (
    <div
      key={p.id}
      className={`project-item archived${p.id === activeId ? ' active' : ''}`}
      title={p.folder ? `From ${p.folder.split('/').join(' › ')}` : undefined}
      onClick={() => props.onSelect(p.id)}
      onContextMenu={(e) => {
        e.preventDefault()
        props.onContextMenu(p.id)
      }}
    >
      <FolderIcon className="project-icon" />
      <span className="project-name">{p.name}</span>
      <span className="project-count">{p.sheetCount}</span>
    </div>
  )

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
        {archived.length > 0 && (
          <div className={`library-archive${archiveDrop ? ' drop-target' : ''}`} {...archiveDropHandlers}>
            <div
              className={`library-archive-label${archiveOpen ? ' open' : ''}`}
              onClick={() => setArchiveOpen(!archiveOpen)}
              onContextMenu={(e) => e.preventDefault()}
            >
              <ChevronIcon className="library-folder-chevron" />
              <span className="library-folder-name">Archive</span>
              <span className="project-count">{archived.length}</span>
            </div>
            {archiveOpen && archived.map(renderArchived)}
          </div>
        )}
      </nav>
      <footer className="library-footer">
        {props.renamingCollection ? (
          <RenameField initial={props.collection} onCommit={props.onRenameCollection} onCancel={props.onRenameEnd} />
        ) : (
          <button
            className="ghost-button collection-switcher"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect()
              props.onCollectionMenu({ x: rect.left, y: rect.top })
            }}
            title="Switch Collection"
            aria-haspopup="menu"
          >
            <span className="collection-name">{props.collection}</span>
            <ChevronsUpDownIcon className="collection-chevrons" />
          </button>
        )}
        <button
          className="icon-button"
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect()
            props.onNewMenu({ x: rect.left, y: rect.top })
          }}
          title="New…"
          aria-haspopup="menu"
        >
          <PlusIcon />
        </button>
        <button className="icon-button" onClick={props.onOpenSettings} title="Settings (⌘,)">
          <GearIcon />
        </button>
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
