import { useEffect, useRef, useState } from 'react'
import type { ProjectSummary } from '../../../shared/types'
import { FolderIcon, GearIcon, PlusIcon } from './Icons'

export const SHEET_DRAG_TYPE = 'application/x-hermit-sheet'

interface Props {
  projects: ProjectSummary[]
  activeId: string | null
  renamingId: string | null
  onSelect(id: string): void
  onCreate(): void
  onOpenSettings(): void
  onRename(id: string, name: string): void
  onRenameEnd(): void
  onStartRename(id: string): void
  onContextMenu(id: string): void
  onDropSheet(sheetId: string, fromProject: string, toProject: string): void
}

export function LibraryPane(props: Props) {
  const { projects, activeId, renamingId } = props
  const [dropTarget, setDropTarget] = useState<string | null>(null)

  return (
    <aside className="pane library">
      <header className="pane-header" />
      <div className="library-section-label">Projects</div>
      <nav className="project-list">
        {projects.map((p) => (
          <div
            key={p.id}
            className={`project-item${p.id === activeId ? ' active' : ''}${p.id === dropTarget ? ' drop-target' : ''}`}
            onClick={() => props.onSelect(p.id)}
            onDoubleClick={() => props.onStartRename(p.id)}
            onContextMenu={(e) => {
              e.preventDefault()
              props.onContextMenu(p.id)
            }}
            onDragOver={(e) => {
              if (!e.dataTransfer.types.includes(SHEET_DRAG_TYPE) || p.id === activeId) return
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
              setDropTarget(p.id)
            }}
            onDragLeave={() => setDropTarget((t) => (t === p.id ? null : t))}
            onDrop={(e) => {
              setDropTarget(null)
              const raw = e.dataTransfer.getData(SHEET_DRAG_TYPE)
              if (!raw) return
              e.preventDefault()
              const { projectId, sheetId } = JSON.parse(raw) as { projectId: string; sheetId: string }
              if (projectId !== p.id) props.onDropSheet(sheetId, projectId, p.id)
            }}
          >
            <FolderIcon className="project-icon" />
            {p.id === renamingId ? (
              <RenameField
                initial={p.name}
                onCommit={(name) => props.onRename(p.id, name)}
                onCancel={props.onRenameEnd}
              />
            ) : (
              <>
                <span className="project-name">{p.name}</span>
                <span className="project-count">{p.sheetCount}</span>
              </>
            )}
          </div>
        ))}
      </nav>
      <footer className="library-footer">
        <button className="ghost-button" onClick={props.onCreate} title="New Project (⇧⌘N)">
          <PlusIcon /> New Project
        </button>
        <button className="icon-button" onClick={props.onOpenSettings} title="Settings (⌘,)">
          <GearIcon />
        </button>
      </footer>
    </aside>
  )
}

function RenameField({
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
