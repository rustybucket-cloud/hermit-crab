import { useState } from 'react'
import type { SheetSummary } from '../../../shared/types'
import { formatCount, formatDate } from '../format'
import { ComposeIcon, SearchIcon } from './Icons'
import { SHEET_DRAG_TYPE } from './LibraryPane'

interface Props {
  projectId: string | null
  projectName: string
  sheets: SheetSummary[]
  totalWords: number
  activeId: string | null
  query: string
  onQueryChange(query: string): void
  onSelect(id: string): void
  onCreate(): void
  onReorder(order: string[]): void
  onContextMenu(id: string): void
}

type Drop = { id: string; after: boolean }

export function SheetListPane(props: Props) {
  const { projectId, sheets, activeId, query } = props
  const [drop, setDrop] = useState<Drop | null>(null)
  const canReorder = !query

  const handleDrop = (dragged: string, target: Drop) => {
    if (dragged === target.id) return
    const order = sheets.map((s) => s.id).filter((id) => id !== dragged)
    const at = order.indexOf(target.id) + (target.after ? 1 : 0)
    order.splice(at, 0, dragged)
    props.onReorder(order)
  }

  return (
    <section className="pane sheets">
      <header className="pane-header">
        <div className="pane-title">
          <span className="pane-title-name">{props.projectName}</span>
          {projectId && <span className="pane-title-meta">{formatCount(props.totalWords, 'word')}</span>}
        </div>
        <button className="icon-button" onClick={props.onCreate} disabled={!projectId} title="New Sheet (⌘N)">
          <ComposeIcon />
        </button>
      </header>

      {projectId && (
        <label className="search-field">
          <SearchIcon />
          <input
            type="search"
            placeholder="Search sheets"
            value={query}
            onChange={(e) => props.onQueryChange(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && props.onQueryChange('')}
          />
        </label>
      )}

      <ul className="sheet-list" onDragLeave={(e) => e.currentTarget === e.target && setDrop(null)}>
        {sheets.map((sheet) => (
          <li
            key={sheet.id}
            className={[
              'sheet-item',
              sheet.id === activeId && 'active',
              drop?.id === sheet.id && (drop.after ? 'drop-after' : 'drop-before')
            ]
              .filter(Boolean)
              .join(' ')}
            draggable
            onClick={() => props.onSelect(sheet.id)}
            onContextMenu={(e) => {
              e.preventDefault()
              props.onContextMenu(sheet.id)
            }}
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = 'move'
              e.dataTransfer.setData(SHEET_DRAG_TYPE, JSON.stringify({ projectId, sheetId: sheet.id }))
            }}
            onDragOver={(e) => {
              if (!canReorder || !e.dataTransfer.types.includes(SHEET_DRAG_TYPE)) return
              e.preventDefault()
              const rect = e.currentTarget.getBoundingClientRect()
              const after = e.clientY > rect.top + rect.height / 2
              if (drop?.id !== sheet.id || drop.after !== after) setDrop({ id: sheet.id, after })
            }}
            onDrop={(e) => {
              const raw = e.dataTransfer.getData(SHEET_DRAG_TYPE)
              const target = drop
              setDrop(null)
              if (!raw || !target) return
              e.preventDefault()
              const data = JSON.parse(raw) as { projectId: string; sheetId: string }
              if (data.projectId === projectId) handleDrop(data.sheetId, target)
            }}
            onDragEnd={() => setDrop(null)}
          >
            <div className={`sheet-title${sheet.title ? '' : ' untitled'}`}>{sheet.title || 'Untitled'}</div>
            {sheet.excerpt && <div className="sheet-excerpt">{sheet.excerpt}</div>}
            <div className="sheet-meta">
              {formatDate(sheet.updatedAt)} · {formatCount(sheet.wordCount, 'word')}
            </div>
          </li>
        ))}
      </ul>

      {projectId && sheets.length === 0 && (
        <div className="empty-hint">
          {query ? (
            'No matching sheets'
          ) : (
            <button className="ghost-button" onClick={props.onCreate}>
              <ComposeIcon /> New Sheet
            </button>
          )}
        </div>
      )}
    </section>
  )
}
