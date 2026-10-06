import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { isCanvasId } from '../../../shared/canvas'
import type { OutlineItem, OutlineTarget, Section, SheetPlace, SheetSummary } from '../../../shared/types'
import { formatCount, formatDate } from '../format'
import { depthOf, isWithin, parentSubsection, placeName, SECTION_NAMES, SECTIONS, subsectionName } from '../sections'
import { CanvasIcon, ChevronIcon, ComposeIcon, PlusIcon, SearchIcon, SlidersIcon } from './Icons'
import { blankContextMenu, RenameField, SHEET_DRAG_TYPE } from './LibraryPane'

const SUBSECTION_DRAG_TYPE = 'application/x-hermit-subsection'
const COLLAPSED_KEY = 'hermit:collapsed-subsections'
const INDENT = 14

interface Props {
  projectId: string | null
  projectName: string
  section: Section
  /** Whether the list shows the archive instead of the section. */
  archiveOpen: boolean
  /** How many sheets each section and the archive show, after search. */
  counts: Record<Section | 'archive', number>
  /** The section's outline: sheets and subsection headings in reading order. */
  items: OutlineItem[]
  /** The section's sheets, or the archive's, that match the search. */
  sheets: SheetSummary[]
  totalWords: number
  activeId: string | null
  query: string
  /** Path of the subsection being renamed in this section. */
  renamingSubsection: string | null
  /** The canvas being renamed; canvases are named by their file, not their first line. */
  renamingSheet: string | null
  onQueryChange(query: string): void
  onSectionChange(section: Section): void
  onOpenArchive(): void
  /** Move a sheet or subsection into the archive. */
  onArchive(item: OutlineItem): void
  onSelect(id: string): void
  onCreate(place?: SheetPlace): void
  /** The new-item menu, shown below the header's add button. */
  onNewMenu(at: { x: number; y: number }): void
  onCreateCanvas(): void
  onStartRenameSubsection(subsection: string): void
  onRenameSubsection(place: SheetPlace, name: string): void
  onRenameSubsectionEnd(): void
  onStartRenameSheet(id: string): void
  onRenameSheet(id: string, name: string): void
  onRenameSheetEnd(): void
  onSubsectionMenu(place: SheetPlace): void
  /** Right-click on a section's tab or the list's blank space. */
  onSectionMenu(section: Section): void
  onMove(item: OutlineItem, target: OutlineTarget): void
  onContextMenu(id: string): void
  onOpenProjectSettings(): void
}

type Where = 'before' | 'after' | 'into'
/** Where a dragged item would land: a row's key, or `end` for the space below the list. */
type DropAt = { row: string; where: Where }

const rowKey = (item: OutlineItem) => (item.kind === 'sheet' ? item.id : `/${item.subsection}`)
/** The subsection an item sits in. */
const parentOf = (item: OutlineItem) => (item.kind === 'sheet' ? item.subsection : parentSubsection(item.subsection))

function useCollapsed(projectId: string | null, section: Section) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]') as string[])
    } catch {
      return new Set()
    }
  })
  useEffect(() => localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed])), [collapsed])

  const key = (subsection: string) => `${projectId}/${section}:${subsection}`
  const set = (subsection: string, value: boolean) =>
    setCollapsed((prev) => {
      if (prev.has(key(subsection)) === value) return prev
      const next = new Set(prev)
      if (value) next.add(key(subsection))
      else next.delete(key(subsection))
      return next
    })
  const isCollapsed = (subsection: string) => collapsed.has(key(subsection))
  /** Whether a subsection, or any above it, is collapsed. */
  const isHidden = (subsection: string | null) => {
    for (let p = subsection; p; p = parentSubsection(p)) if (isCollapsed(p)) return true
    return false
  }
  /** Open a subsection and everything above it. */
  const reveal = (subsection: string | null) => {
    for (let p = subsection; p; p = parentSubsection(p)) set(p, false)
  }
  return { isCollapsed, isHidden, set, reveal }
}

export function SheetListPane(props: Props) {
  const { projectId, section, items, sheets, activeId, query } = props
  const [dropAt, setDropAt] = useState<DropAt | null>(null)
  const [tabDrop, setTabDrop] = useState<Section | 'archive' | null>(null)
  const dragging = useRef<OutlineItem | null>(null)
  const collapsed = useCollapsed(projectId, section)
  const { archiveOpen } = props
  // The archive is a plain list, most recently archived first.
  const canReorder = !query && !archiveOpen
  const item = SECTION_NAMES[section].item
  /** Canvases only belong in the notes, so neither they nor subsections holding them can go to the content. */
  const holdsCanvas = (dragged: OutlineItem) =>
    dragged.kind === 'sheet'
      ? isCanvasId(dragged.id)
      : items.some((i) => i.kind === 'sheet' && isCanvasId(i.id) && isWithin(i.subsection, dragged.subsection))
  const visible = new Map(sheets.map((s) => [s.id, s]))

  // Never hide the open sheet, or a subsection being named, inside a collapsed one.
  const activeSubsection = items.find((i) => i.kind === 'sheet' && i.id === activeId)?.subsection ?? null
  useEffect(() => collapsed.reveal(activeSubsection), [activeId, activeSubsection])
  const renaming = props.renamingSubsection
  useEffect(() => collapsed.reveal(renaming && parentSubsection(renaming)), [renaming])

  /** Where `item` would land if dropped on this part of `row`, or null if it can't go there. */
  const dropZone = (e: DragEvent, row: OutlineItem): Where | null => {
    const dragged = dragging.current
    if (!canReorder || !dragged || rowKey(dragged) === rowKey(row)) return null
    // A subsection can't go inside itself.
    if (dragged.kind === 'subsection' && isWithin(row.subsection, dragged.subsection)) return null
    const rect = e.currentTarget.getBoundingClientRect()
    const y = (e.clientY - rect.top) / rect.height
    if (row.kind === 'sheet') return y < 0.5 ? 'before' : 'after'
    // Open subsections show their contents right below, so their lower part means "inside".
    if (y < 0.3) return 'before'
    return y > 0.75 && collapsed.isCollapsed(row.subsection) ? 'after' : 'into'
  }

  const dragHandlers = (row: OutlineItem, into?: SheetPlace) => ({
    onDragOver: (e: DragEvent) => {
      const dragged = dragging.current
      const where = into
        ? canReorder && dragged && !(dragged.kind === 'subsection' && isWithin(into.subsection, dragged.subsection))
          ? 'into'
          : null
        : dropZone(e, row)
      if (!where) return
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = 'move'
      const key = into ? `empty${rowKey(row)}` : rowKey(row)
      if (dropAt?.row !== key || dropAt.where !== where) setDropAt({ row: key, where })
    },
    onDrop: (e: DragEvent) => {
      const dragged = dragging.current
      const at = dropAt
      setDropAt(null)
      if (!dragged || !at) return
      e.preventDefault()
      e.stopPropagation()
      if (into) return props.onMove(dragged, { into })
      if (at.where === 'into' && row.kind === 'subsection') {
        props.onMove(dragged, { into: { section: row.section, subsection: row.subsection } })
      } else {
        props.onMove(dragged, at.where === 'before' ? { before: row } : { after: row })
      }
    }
  })

  const startDrag = (e: DragEvent, row: OutlineItem) => {
    dragging.current = row
    e.stopPropagation()
    e.dataTransfer.effectAllowed = 'move'
    // Sheets can also be dropped on another project in the library.
    if (row.kind === 'sheet') e.dataTransfer.setData(SHEET_DRAG_TYPE, JSON.stringify({ projectId, sheetId: row.id }))
    else e.dataTransfer.setData(SUBSECTION_DRAG_TYPE, row.subsection)
  }

  const endDrag = () => {
    dragging.current = null
    setDropAt(null)
    setTabDrop(null)
  }

  const dropClass = (key: string) =>
    dropAt?.row === key ? (dropAt.where === 'into' ? 'drop-target' : `drop-${dropAt.where}`) : null

  /** A sheet in the outline, or without a `row`, one in the archive. */
  const renderSheet = (sheet: SheetSummary, row: (OutlineItem & { kind: 'sheet' }) | null) => {
    const canvas = isCanvasId(sheet.id)
    const renaming = sheet.id === props.renamingSheet
    return (
      <li
        key={sheet.id}
        className={['sheet-item', sheet.id === activeId && 'active', row && dropClass(rowKey(row))].filter(Boolean).join(' ')}
        style={{ marginLeft: row ? depthOf(sheet.subsection) * INDENT : 0 }}
        draggable={Boolean(row) && !renaming}
        onClick={() => props.onSelect(sheet.id)}
        onDoubleClick={() => row && canvas && props.onStartRenameSheet(sheet.id)}
        onContextMenu={(e) => {
          e.preventDefault()
          props.onContextMenu(sheet.id)
        }}
        {...(row && { onDragStart: (e: DragEvent) => startDrag(e, row), onDragEnd: endDrag, ...dragHandlers(row) })}
      >
        <div className={`sheet-title${sheet.title ? '' : ' untitled'}`}>
          {canvas && <CanvasIcon className="sheet-kind" />}
          {renaming ? (
            <RenameField
              initial={sheet.title}
              onCommit={(name) => props.onRenameSheet(sheet.id, name)}
              onCancel={props.onRenameSheetEnd}
            />
          ) : (
            sheet.title || 'Untitled'
          )}
        </div>
        {sheet.excerpt && <div className="sheet-excerpt">{sheet.excerpt}</div>}
        <div className="sheet-meta">
          {sheet.archived && `${placeName(sheet)} · `}
          {formatDate(sheet.updatedAt)} · {formatCount(sheet.wordCount, 'word')}
        </div>
      </li>
    )
  }

  const renderSubsection = (row: OutlineItem & { kind: 'subsection' }, empty: boolean): ReactNode[] => {
    const path = row.subsection
    const place: SheetPlace = { section: row.section, subsection: path }
    const name = subsectionName(path)
    const open = Boolean(query) || !collapsed.isCollapsed(path)
    const count = sheets.filter((s) => isWithin(s.subsection, path)).length
    const indent = (depthOf(path) - 1) * INDENT
    const nodes: ReactNode[] = [
      <li
        key={rowKey(row)}
        className={['subsection-header', open && 'open', dropClass(rowKey(row))].filter(Boolean).join(' ')}
        style={{ marginLeft: indent }}
        draggable={path !== renaming}
        onClick={() => collapsed.set(path, open)}
        onDoubleClick={() => props.onStartRenameSubsection(path)}
        onContextMenu={(e) => {
          e.preventDefault()
          props.onSubsectionMenu(place)
        }}
        onDragStart={(e) => startDrag(e, row)}
        onDragEnd={endDrag}
        {...dragHandlers(row)}
      >
        <ChevronIcon className="subsection-chevron" />
        {path === renaming ? (
          <RenameField
            initial={name}
            onCommit={(next) => props.onRenameSubsection(place, next)}
            onCancel={props.onRenameSubsectionEnd}
          />
        ) : (
          <>
            <span className="subsection-name">{name}</span>
            <span className="subsection-count">{count}</span>
            <button
              className="icon-button subsection-add"
              title={`New ${item.toLowerCase()} in “${name}”`}
              onClick={(e) => {
                e.stopPropagation()
                props.onCreate(place)
              }}
            >
              <PlusIcon />
            </button>
          </>
        )}
      </li>
    ]
    if (open && empty && !query) {
      nodes.push(
        <li
          key={`empty${rowKey(row)}`}
          className={['subsection-empty', dropClass(`empty${rowKey(row)}`)].filter(Boolean).join(' ')}
          style={{ marginLeft: indent + INDENT }}
          onContextMenu={(e) => {
            e.preventDefault()
            props.onSubsectionMenu(place)
          }}
          {...dragHandlers(row, place)}
        >
          Empty
        </li>
      )
    }
    return nodes
  }

  const outlineRows = () =>
    items.flatMap((row, i): ReactNode[] => {
      if (!query && collapsed.isHidden(parentOf(row))) return []
      if (row.kind === 'sheet') {
        const sheet = visible.get(row.id)
        return sheet ? [renderSheet(sheet, row)] : []
      }
      if (query && !sheets.some((s) => isWithin(s.subsection, row.subsection))) return []
      const next = items[i + 1]
      const empty = !next || !isWithin(parentOf(next), row.subsection)
      return renderSubsection(row, empty)
    })

  const rows = archiveOpen ? sheets.map((sheet) => renderSheet(sheet, null)) : outlineRows()

  const empty = query || archiveOpen ? sheets.length === 0 : items.length === 0

  return (
    <section
      className="pane sheets"
      onContextMenu={projectId && !archiveOpen ? blankContextMenu(() => props.onSectionMenu(section)) : undefined}
    >
      <header className="pane-header">
        <div className="pane-title">
          <span className="pane-title-name">{props.projectName}</span>
          {projectId && <span className="pane-title-meta">{formatCount(props.totalWords, 'word')}</span>}
        </div>
        <button
          className="icon-button"
          onClick={props.onOpenProjectSettings}
          disabled={!projectId}
          title="Project Settings"
          aria-label="Project Settings"
        >
          <SlidersIcon />
        </button>
        <button
          className="icon-button"
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect()
            props.onNewMenu({ x: rect.left, y: rect.bottom + 4 })
          }}
          disabled={!projectId}
          title="New…"
          aria-label="New…"
          aria-haspopup="menu"
        >
          <PlusIcon />
        </button>
      </header>

      {projectId && (
        <div className="section-tabs" role="tablist" aria-label="Project sections">
          {SECTIONS.map((s) => (
            <button
              key={s}
              role="tab"
              aria-selected={s === section && !archiveOpen}
              className={['section-tab', s === section && !archiveOpen && 'active', s === tabDrop && 'drop-target']
                .filter(Boolean)
                .join(' ')}
              onClick={() => props.onSectionChange(s)}
              onContextMenu={(e) => {
                e.preventDefault()
                props.onSectionMenu(s)
              }}
              title={`${SECTION_NAMES[s].label} (⌘3)`}
              // Drop a sheet or subsection on the other section's tab to move it there.
              onDragOver={(e) => {
                if (s === section || !dragging.current || (s === 'content' && holdsCanvas(dragging.current))) return
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                setTabDrop(s)
              }}
              onDragLeave={() => setTabDrop((t) => (t === s ? null : t))}
              onDrop={(e) => {
                const dragged = dragging.current
                setTabDrop(null)
                if (!dragged) return
                e.preventDefault()
                props.onMove(dragged, { into: { section: s, subsection: null } })
              }}
            >
              {SECTION_NAMES[s].label}
              <span className="section-count">{props.counts[s]}</span>
            </button>
          ))}
          <button
            role="tab"
            aria-selected={archiveOpen}
            className={['section-tab', archiveOpen && 'active', tabDrop === 'archive' && 'drop-target']
              .filter(Boolean)
              .join(' ')}
            onClick={props.onOpenArchive}
            title="Archived sheets and notes"
            // Drop a sheet or subsection here to archive it.
            onDragOver={(e) => {
              if (!dragging.current) return
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
              setTabDrop('archive')
            }}
            onDragLeave={() => setTabDrop((t) => (t === 'archive' ? null : t))}
            onDrop={(e) => {
              const dragged = dragging.current
              setTabDrop(null)
              if (!dragged) return
              e.preventDefault()
              props.onArchive(dragged)
            }}
          >
            Archive
            <span className="section-count">{props.counts.archive}</span>
          </button>
        </div>
      )}

      {projectId && (
        <label className="search-field">
          <SearchIcon />
          <input
            type="search"
            placeholder={`Search ${archiveOpen ? 'archive' : SECTION_NAMES[section].label.toLowerCase()}`}
            value={query}
            onChange={(e) => props.onQueryChange(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && props.onQueryChange('')}
          />
        </label>
      )}

      <ul
        className={`sheet-list${dropAt?.row === 'end' ? ' drop-end' : ''}`}
        // The space below the last row means the end of the section.
        onDragOver={(e) => {
          if (!canReorder || !dragging.current || e.target !== e.currentTarget) return
          e.preventDefault()
          if (dropAt?.row !== 'end') setDropAt({ row: 'end', where: 'into' })
        }}
        onDragLeave={(e) => e.currentTarget === e.target && setDropAt(null)}
        onDrop={(e) => {
          const dragged = dragging.current
          setDropAt(null)
          if (!dragged) return
          e.preventDefault()
          props.onMove(dragged, { into: { section, subsection: null } })
        }}
      >
        {rows}
      </ul>

      {projectId && empty && (
        <div className="empty-hint">
          {query ? (
            `No matching ${archiveOpen ? 'sheets or notes' : `${item.toLowerCase()}s`}`
          ) : archiveOpen ? (
            <p>Sheets and notes you archive wait here, out of the way, until you restore them.</p>
          ) : (
            <>
              {section === 'notes' && <p>Plans, outlines, research — anything that supports the content.</p>}
              <button className="ghost-button" onClick={() => props.onCreate()}>
                <ComposeIcon /> New {item}
              </button>
              {section === 'notes' && (
                <button className="ghost-button" onClick={props.onCreateCanvas}>
                  <CanvasIcon /> New Canvas
                </button>
              )}
            </>
          )}
        </div>
      )}
    </section>
  )
}
