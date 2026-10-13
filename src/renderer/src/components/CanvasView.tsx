import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from 'react'
import {
  canvasTitle,
  isCanvasId,
  isImageFile,
  parseCanvas,
  serializeCanvas,
  sheetFile,
  sheetIdOfFile,
  textAlign,
  withTextAlign,
  type CanvasColor,
  type CanvasData,
  type CanvasEdge,
  type CanvasNode,
  type CanvasSide,
  type FileNode,
  type TextAlign,
  type TextNode
} from '../../../shared/canvas'
import type { SheetSummary } from '../../../shared/types'
import {
  anchor,
  boundsOf,
  curve,
  edgeGeometry,
  facingSide,
  inside,
  intersects,
  nodeAt,
  rectFrom,
  SIDES,
  type Point,
  type Rect
} from '../canvas/geometry'
import { placeName } from '../sections'
import {
  AlignCenterIcon,
  AlignLeftIcon,
  AlignRightIcon,
  ArrowIcon,
  CardIcon,
  ComposeIcon,
  FitIcon,
  HeadingIcon,
  ImageIcon,
  MinusIcon,
  NoteLinkIcon,
  OpenIcon,
  PlusIcon,
  SearchIcon,
  TrashIcon
} from './Icons'
import { SHEET_DRAG_TYPE } from './LibraryPane'
import { renderMarkdown } from './Preview'
import { CardEditor } from './CardEditor'
import { touch } from '../device'

const hermit = window.hermit
const mac = hermit.platform === 'darwin'

const VIEWS_KEY = 'hermit:canvas-views'
const MIN_ZOOM = 0.1
const MAX_ZOOM = 2.5
const GRID = 20
const SNAP = 10
const MIN_SIZE = { width: 60, height: 40 }

/** Obsidian's preset colours, by number. */
const COLORS: [CanvasColor, string][] = [
  ['1', 'Red'],
  ['2', 'Orange'],
  ['3', 'Yellow'],
  ['4', 'Green'],
  ['5', 'Cyan'],
  ['6', 'Purple']
]

const ALIGNMENTS: [TextAlign, string, typeof AlignLeftIcon][] = [
  ['left', 'Align Left', AlignLeftIcon],
  ['center', 'Align Center', AlignCenterIcon],
  ['right', 'Align Right', AlignRightIcon]
]

interface View {
  x: number
  y: number
  zoom: number
}

type Gesture =
  | { kind: 'pan'; start: Point; view: View; moved: boolean }
  | { kind: 'select'; start: Point; client: Point; base: ReadonlySet<string>; moved: boolean }
  | { kind: 'move'; start: Point; origins: Map<string, Point>; lead: string; moved: boolean }
  | { kind: 'resize'; id: string; start: Point; origin: Rect }
  | { kind: 'connect'; from: string; side: CanvasSide }
  | { kind: 'pinch'; distance: number; middle: Point; view: View }

/** A connection being drawn: from a card's side to wherever the pointer is. */
interface Link {
  from: string
  side: CanvasSide
  point: Point
  target: string | null
}

interface Props {
  projectId: string
  sheetId: string
  content: string
  /** Every sheet in the project, for linked notes. */
  sheets: SheetSummary[]
  readOnly: boolean
  onChange(content: string): void
  onOpenSheet(sheetId: string): void
}

const snap = (v: number) => Math.round(v / SNAP) * SNAP
const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z))
const newId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 16)
const isHeading = (text: string) => /^#{1,6}\s+\S[^\n]*$/.test(text.trim())
/** Whether a click adds to the selection, or takes away from it, rather than replacing it. */
const adds = (e: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) =>
  e.shiftKey || e.metaKey || (e.ctrlKey && !mac)

const colorStyle = (color?: CanvasColor): CSSProperties =>
  (color ? { '--card': /^\d$/.test(color) ? `var(--canvas-${color})` : color } : {}) as CSSProperties

/** Where a project's file is served from, for images. */
const fileUrl = (projectId: string, file: string) => hermit.fileUrl(`${projectId}/${file}`)

function loadViews(): Record<string, View> {
  try {
    return JSON.parse(localStorage.getItem(VIEWS_KEY) ?? '{}') as Record<string, View>
  } catch {
    return {}
  }
}

/** An image's size on the canvas: as it is, but no wider than a large card. */
async function imageSize(url: string): Promise<{ width: number; height: number }> {
  const img = new Image()
  img.src = url
  try {
    await img.decode()
  } catch {
    return { width: 400, height: 300 }
  }
  const scale = Math.min(1, 400 / img.naturalWidth)
  return {
    width: Math.max(MIN_SIZE.width, Math.round(img.naturalWidth * scale)),
    height: Math.max(MIN_SIZE.height, Math.round(img.naturalHeight * scale))
  }
}

/** A rectangle of the given size, placed so its `side` sits on `p`. */
function rectWithSideAt(p: Point, side: CanvasSide, width: number, height: number): Rect {
  switch (side) {
    case 'left': return { x: p.x, y: p.y - height / 2, width, height }
    case 'right': return { x: p.x - width, y: p.y - height / 2, width, height }
    case 'top': return { x: p.x - width / 2, y: p.y, width, height }
    case 'bottom': return { x: p.x - width / 2, y: p.y - height, width, height }
  }
}

const Markdown = memo(function Markdown({ text, className }: { text: string; className: string }) {
  const html = useMemo(() => renderMarkdown(text), [text])
  return <div className={className} dangerouslySetInnerHTML={{ __html: html }} />
})

export function CanvasView(props: Props) {
  const { projectId, sheetId, readOnly } = props
  const [initial] = useState(() => {
    try {
      return parseCanvas(props.content)
    } catch {
      return null
    }
  })
  const editable = !readOnly && initial !== null

  const [canvas, setCanvasState] = useState<CanvasData>(initial ?? { nodes: [], edges: [] })
  const [view, setViewState] = useState<View>({ x: 0, y: 0, zoom: 1 })
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [editingEdge, setEditingEdge] = useState<string | null>(null)
  const [marquee, setMarquee] = useState<Rect | null>(null)
  const [link, setLink] = useState<Link | null>(null)
  const [picker, setPicker] = useState(false)
  const [grab, setGrab] = useState(false)
  const [noteTexts, setNoteTexts] = useState(new Map<string, { version: number; content: string }>())

  const host = useRef<HTMLDivElement>(null)
  const imageInput = useRef<HTMLInputElement>(null)
  const canvasRef = useRef(canvas)
  const viewRef = useRef(view)
  const gesture = useRef<Gesture | null>(null)
  const linkRef = useRef(link)
  // Undo history, and the state before the change in progress.
  const past = useRef<CanvasData[]>([])
  const future = useRef<CanvasData[]>([])
  const before = useRef<CanvasData | null>(null)
  // A card made to be typed into; it's dropped again if left empty.
  const fresh = useRef<string | null>(null)
  // Fingers on the canvas, by pointer id, for pinching.
  const fingers = useRef(new Map<number, Point>())
  // The last tap, to tell a double-tap; and when a finger last touched, so the browser's own dblclick is ignored.
  const lastTap = useRef<{ at: number; point: Point; target: string } | null>(null)
  const lastTouch = useRef(0)
  // Space held down, so dragging pans.
  const space = useRef(false)

  const sheetsById = useMemo(() => new Map(props.sheets.map((s) => [s.id, s])), [props.sheets])
  const nodesById = useMemo(() => new Map(canvas.nodes.map((n) => [n.id, n])), [canvas.nodes])

  // ── Changes and history ───────────────────────────────────────────────────

  const setCanvas = (next: CanvasData, save = false) => {
    canvasRef.current = next
    setCanvasState(next)
    if (save) props.onChange(serializeCanvas(next))
  }

  /** Start a change that may take several steps, like a drag; it becomes one step of undo. */
  const begin = () => {
    before.current ??= canvasRef.current
  }

  const end = () => {
    const was = before.current
    before.current = null
    if (!was || was === canvasRef.current) return
    past.current = [...past.current.slice(-99), was]
    future.current = []
    props.onChange(serializeCanvas(canvasRef.current))
  }

  const commit = (next: CanvasData) => {
    if (!editable) return
    begin()
    setCanvas(next)
    end()
  }

  const travel = (from: typeof past, to: typeof past) => {
    const target = from.current.pop()
    if (!target) return
    to.current.push(canvasRef.current)
    setCanvas(target, true)
    setSelected((s) => new Set([...s].filter((id) => target.nodes.some((n) => n.id === id))))
    setSelectedEdge(null)
  }

  const patchNodes = (ids: ReadonlySet<string>, patch: (n: CanvasNode) => CanvasNode): CanvasData => ({
    ...canvasRef.current,
    nodes: canvasRef.current.nodes.map((n) => (ids.has(n.id) ? patch(n) : n))
  })

  const patchEdge = (id: string, patch: (e: CanvasEdge) => CanvasEdge): CanvasData => ({
    ...canvasRef.current,
    edges: canvasRef.current.edges.map((e) => (e.id === id ? patch(e) : e))
  })

  const withoutNodes = (ids: ReadonlySet<string>): CanvasData => ({
    nodes: canvasRef.current.nodes.filter((n) => !ids.has(n.id)),
    edges: canvasRef.current.edges.filter((e) => !ids.has(e.fromNode) && !ids.has(e.toNode))
  })

  // ── View ──────────────────────────────────────────────────────────────────

  const setView = (next: View) => {
    viewRef.current = next
    setViewState(next)
  }

  const toWorld = (clientX: number, clientY: number): Point => {
    const r = host.current!.getBoundingClientRect()
    const v = viewRef.current
    return { x: (clientX - r.left - v.x) / v.zoom, y: (clientY - r.top - v.y) / v.zoom }
  }

  const viewCenter = (): Point => {
    const r = host.current!.getBoundingClientRect()
    return toWorld(r.left + r.width / 2, r.top + r.height / 2)
  }

  /** Zoom keeping the point under the pointer (or the middle of the view) still. */
  const zoomTo = (zoom: number, clientX?: number, clientY?: number) => {
    const r = host.current!.getBoundingClientRect()
    const v = viewRef.current
    const z = clampZoom(zoom)
    const px = (clientX ?? r.left + r.width / 2) - r.left
    const py = (clientY ?? r.top + r.height / 2) - r.top
    setView({ zoom: z, x: px - ((px - v.x) * z) / v.zoom, y: py - ((py - v.y) * z) / v.zoom })
  }

  const fit = () => {
    const r = host.current!.getBoundingClientRect()
    const b = boundsOf(canvasRef.current.nodes)
    if (!b) return setView({ x: r.width / 2, y: r.height / 2, zoom: 1 })
    const pad = 120
    const zoom = clampZoom(Math.min(1, (r.width - pad) / b.width, (r.height - pad) / b.height))
    setView({ zoom, x: r.width / 2 - (b.x + b.width / 2) * zoom, y: r.height / 2 - (b.y + b.height / 2) * zoom })
  }

  const viewKey = `${projectId}/${sheetId}`
  useLayoutEffect(() => {
    const saved = loadViews()[viewKey]
    if (saved) setView(saved)
    else fit()
  }, []) // Only when the canvas first opens.

  useEffect(() => {
    const timer = window.setTimeout(() => {
      localStorage.setItem(VIEWS_KEY, JSON.stringify({ ...loadViews(), [viewKey]: view }))
    }, 400)
    return () => window.clearTimeout(timer)
  }, [view, viewKey])

  // ── Linked notes ──────────────────────────────────────────────────────────

  // Read each linked note, again whenever it changes.
  const linkedVersions = canvas.nodes
    .flatMap((n) => {
      const id = n.type === 'file' ? sheetIdOfFile(n.file) : null
      const sheet = id && !isCanvasId(id) ? sheetsById.get(id) : undefined
      return sheet ? [`${sheet.id}\n${sheet.updatedAt}`] : []
    })
    .sort()
    .join('\n\n')
  useEffect(() => {
    let live = true
    for (const entry of linkedVersions ? linkedVersions.split('\n\n') : []) {
      const [id, version] = entry.split('\n')
      if (noteTexts.get(id)?.version === Number(version)) continue
      void hermit
        .readSheet(projectId, id)
        .then((sheet) => {
          if (live) setNoteTexts((prev) => new Map(prev).set(id, { version: Number(version), content: sheet.content }))
        })
        .catch(() => {})
    }
    return () => {
      live = false
    }
  }, [linkedVersions, projectId])

  // ── Adding things ─────────────────────────────────────────────────────────

  /** A rectangle of the given size, centred on `p` and on the grid, stepped clear of anything placed exactly there. */
  const placeAt = (p: Point, width: number, height: number) => {
    let x = snap(p.x - width / 2)
    let y = snap(p.y - height / 2)
    while (canvasRef.current.nodes.some((n) => n.x === x && n.y === y)) {
      x += 30
      y += 30
    }
    return { x, y, width, height }
  }

  const addNodes = (nodes: CanvasNode[], edges: CanvasEdge[] = []) => {
    commit({ nodes: [...canvasRef.current.nodes, ...nodes], edges: [...canvasRef.current.edges, ...edges] })
    setSelected(new Set(nodes.map((n) => n.id)))
    setSelectedEdge(null)
  }

  const startEditing = (id: string) => {
    if (!editable) return
    begin()
    setSelected(new Set([id]))
    setEditing(id)
  }

  const addCard = (p = viewCenter(), text = '') => {
    const node: TextNode = { id: newId(), type: 'text', text, ...placeAt(p, 260, 120) }
    addNodes([node])
    if (!text) {
      fresh.current = node.id
      startEditing(node.id)
    }
  }

  const addHeading = (p = viewCenter()) => {
    const node: TextNode = { id: newId(), type: 'text', text: '# Heading', ...placeAt(p, 400, 70) }
    addNodes([node])
    startEditing(node.id)
  }

  const addNote = (id: string, p = viewCenter()) => {
    const node: FileNode = { id: newId(), type: 'file', file: sheetFile(id), ...placeAt(p, 400, isCanvasId(id) ? 120 : 400) }
    addNodes([node])
  }

  const addImages = async (files: File[], p = viewCenter()) => {
    const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14)
    const added: CanvasNode[] = []
    for (const [i, file] of files.filter((f) => f.type.startsWith('image/')).entries()) {
      const ext = file.type.split('/')[1]?.replace('jpeg', 'jpg').replace('svg+xml', 'svg') ?? 'png'
      const name = file.name || `Pasted image ${stamp}.${ext}`
      const path = await hermit.saveAttachment(projectId, name, new Uint8Array(await file.arrayBuffer()))
      const size = await imageSize(fileUrl(projectId, path))
      const at = { x: p.x + i * 30, y: p.y + i * 30 }
      added.push({ id: newId(), type: 'file', file: path, ...placeAt(at, size.width, size.height) })
    }
    if (added.length) addNodes(added)
  }

  // ── Editing and removing ──────────────────────────────────────────────────

  const finishEditing = () => {
    const id = editing
    if (!id) return
    setEditing(null)
    const node = canvasRef.current.nodes.find((n) => n.id === id)
    if (fresh.current === id && node?.type === 'text' && !node.text.trim()) {
      // Nothing was written: forget the card, and the step that made it.
      before.current = null
      past.current.pop()
      setCanvas(withoutNodes(new Set([id])), true)
      setSelected(new Set())
    } else {
      end()
    }
    fresh.current = null
  }

  const finishEditingEdge = () => {
    if (!editingEdge) return
    setEditingEdge(null)
    end()
  }

  const removeNodes = (ids: ReadonlySet<string>) => {
    if (ids.size) commit(withoutNodes(ids))
    setSelected(new Set())
  }

  const deleteSelection = () => {
    if (selectedEdge) commit({ ...canvasRef.current, edges: canvasRef.current.edges.filter((e) => e.id !== selectedEdge) })
    else removeNodes(selected)
    setSelectedEdge(null)
  }

  const duplicate = (selection: ReadonlySet<string>) => {
    if (!selection.size) return
    const ids = new Map([...selection].map((id) => [id, newId()]))
    const nodes = canvasRef.current.nodes
      .filter((n) => selection.has(n.id))
      .map((n) => ({ ...n, id: ids.get(n.id)!, x: n.x + 30, y: n.y + 30 }))
    const edges = canvasRef.current.edges
      .filter((e) => ids.has(e.fromNode) && ids.has(e.toNode))
      .map((e) => ({ ...e, id: newId(), fromNode: ids.get(e.fromNode)!, toNode: ids.get(e.toNode)! }))
    addNodes(nodes, edges)
  }

  const setColor = (color: CanvasColor | undefined) => {
    const paint = <T extends { color?: CanvasColor }>(item: T): T => {
      const { color: _, ...rest } = item
      return (color ? { ...rest, color } : rest) as T
    }
    if (selectedEdge) commit(patchEdge(selectedEdge, paint))
    else commit(patchNodes(selected, paint))
  }

  const setAlign = (align: TextAlign) =>
    commit(patchNodes(selected, (n) => (n.type === 'text' ? withTextAlign(n, align) : n)))

  /** Arrows go one way, both ways, then neither. */
  const cycleArrows = (id: string) =>
    commit(
      patchEdge(id, (e) => {
        const end = (e.toEnd ?? 'arrow') === 'arrow'
        const start = e.fromEnd === 'arrow'
        if (end && !start) return { ...e, fromEnd: 'arrow', toEnd: 'arrow' }
        if (end && start) return { ...e, fromEnd: 'none', toEnd: 'none' }
        return { ...e, fromEnd: 'none', toEnd: 'arrow' }
      })
    )

  const openFile = (node: CanvasNode) => {
    const id = node.type === 'file' ? sheetIdOfFile(node.file) : null
    if (id && sheetsById.has(id) && id !== sheetId) props.onOpenSheet(id)
    if (node.type === 'link') window.open(node.url)
  }

  // ── Pointer gestures ──────────────────────────────────────────────────────

  /** Track a finger. A second one turns whatever the first was doing into a pinch. Resolves with whether it did. */
  const fingerDown = (e: ReactPointerEvent): boolean => {
    if (e.pointerType !== 'touch') return false
    lastTouch.current = Date.now()
    fingers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (fingers.current.size !== 2) return false
    const g = gesture.current
    if (g?.kind === 'move' && g.moved) end()
    if (g?.kind === 'connect') {
      linkRef.current = null
      setLink(null)
    }
    setMarquee(null)
    const [a, b] = [...fingers.current.values()]
    const r = host.current!.getBoundingClientRect()
    gesture.current = {
      kind: 'pinch',
      distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
      middle: { x: (a.x + b.x) / 2 - r.left, y: (a.y + b.y) / 2 - r.top },
      view: viewRef.current
    }
    return true
  }

  /** Whether this tap follows another in the same place closely enough to count as a double-tap. */
  const isDoubleTap = (e: PointerEvent, target: string): boolean => {
    if (e.pointerType !== 'touch') return false
    const now = Date.now()
    const point = { x: e.clientX, y: e.clientY }
    const last = lastTap.current
    const double =
      last !== null && last.target === target && now - last.at < 350 && Math.hypot(point.x - last.point.x, point.y - last.point.y) < 30
    lastTap.current = double ? null : { at: now, point, target }
    return double
  }

  /** The browser's own double-click, unless it comes from a finger, whose double-taps are handled above. */
  const fromMouse = () => Date.now() - lastTouch.current > 800

  const startSelecting = (client: Point, base: ReadonlySet<string>) => {
    gesture.current = { kind: 'select', start: toWorld(client.x, client.y), client, base, moved: false }
  }

  const onBackgroundDown = (e: ReactPointerEvent) => {
    setPicker(false)
    if (fingerDown(e)) return
    const client = { x: e.clientX, y: e.clientY }
    // A finger pans, as does the middle button or dragging with Space held; otherwise a drag draws a selection.
    if (e.button === 1 || (e.button === 0 && (e.pointerType !== 'mouse' || space.current))) {
      gesture.current = { kind: 'pan', start: client, view: viewRef.current, moved: e.button === 1 }
    } else if (e.button === 0) {
      startSelecting(client, adds(e) ? selected : new Set())
    }
  }

  /** Touching and holding empty space, which stands in for a right-click, turns the pan into a selection. */
  const onBackgroundMenu = (e: MouseEvent) => {
    e.preventDefault()
    if (gesture.current?.kind === 'pan' && fingers.current.size === 1) startSelecting({ x: e.clientX, y: e.clientY }, new Set())
  }

  const onNodeDown = (e: ReactPointerEvent, node: CanvasNode) => {
    // With Space held, a drag pans wherever it starts.
    if (e.button !== 0 || (space.current && e.pointerType === 'mouse')) return
    e.stopPropagation()
    if (fingerDown(e)) return
    setPicker(false)
    setSelectedEdge(null)
    if (editing === node.id) return
    let next = selected
    if (adds(e)) {
      const toggled = new Set(selected)
      if (toggled.has(node.id)) toggled.delete(node.id)
      else toggled.add(node.id)
      next = toggled
    } else if (!selected.has(node.id)) {
      next = new Set([node.id])
    }
    setSelected(next)
    if (!editable || !next.has(node.id)) return
    // A group carries the cards inside it.
    const moving = new Set(next)
    for (const group of canvas.nodes.filter((n) => next.has(n.id) && n.type === 'group')) {
      for (const n of canvas.nodes) if (n.id !== group.id && inside(n, group)) moving.add(n.id)
    }
    const origins = new Map(canvas.nodes.filter((n) => moving.has(n.id)).map((n) => [n.id, { x: n.x, y: n.y }]))
    gesture.current = { kind: 'move', start: toWorld(e.clientX, e.clientY), origins, lead: node.id, moved: false }
  }

  const onResizeDown = (e: ReactPointerEvent, node: CanvasNode) => {
    if (e.button !== 0) return
    e.stopPropagation()
    gesture.current = { kind: 'resize', id: node.id, start: toWorld(e.clientX, e.clientY), origin: { ...node } }
  }

  const onHandleDown = (e: ReactPointerEvent, node: CanvasNode, side: CanvasSide) => {
    if (e.button !== 0) return
    e.stopPropagation()
    setSelected(new Set())
    setSelectedEdge(null)
    gesture.current = { kind: 'connect', from: node.id, side }
    linkRef.current = { from: node.id, side, point: anchor(node, side), target: null }
    setLink(linkRef.current)
  }

  const onPointerMove = (e: PointerEvent) => {
    if (fingers.current.has(e.pointerId)) fingers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const g = gesture.current
    if (!g) return
    if (g.kind === 'pinch') {
      if (fingers.current.size < 2) return
      const [a, b] = [...fingers.current.values()]
      const r = host.current!.getBoundingClientRect()
      const middle = { x: (a.x + b.x) / 2 - r.left, y: (a.y + b.y) / 2 - r.top }
      const zoom = clampZoom((g.view.zoom * Math.hypot(a.x - b.x, a.y - b.y)) / g.distance)
      // Keep the point that was between the fingers between them, wherever they go.
      const world = { x: (g.middle.x - g.view.x) / g.view.zoom, y: (g.middle.y - g.view.y) / g.view.zoom }
      setView({ zoom, x: middle.x - world.x * zoom, y: middle.y - world.y * zoom })
    } else if (g.kind === 'pan') {
      const dx = e.clientX - g.start.x
      const dy = e.clientY - g.start.y
      if (!g.moved && Math.hypot(dx, dy) < 3) return
      g.moved = true
      setView({ ...g.view, x: g.view.x + dx, y: g.view.y + dy })
    } else if (g.kind === 'select') {
      if (!g.moved && Math.hypot(e.clientX - g.client.x, e.clientY - g.client.y) < 3) return
      g.moved = true
      const area = rectFrom(g.start, toWorld(e.clientX, e.clientY))
      setMarquee(area)
      setSelectedEdge(null)
      // A group only counts once it's wholly inside, so a selection reaching into one doesn't carry all its cards.
      const hits = canvas.nodes.filter((n) => (n.type === 'group' ? inside(n, area) : intersects(n, area)))
      setSelected(new Set([...g.base, ...hits.map((n) => n.id)]))
    } else if (g.kind === 'move') {
      const p = toWorld(e.clientX, e.clientY)
      let dx = p.x - g.start.x
      let dy = p.y - g.start.y
      if (!g.moved && Math.hypot(dx, dy) * viewRef.current.zoom < 3) return
      g.moved = true
      // Snap the card that's being dragged, and move the rest with it. Hold Option for no snapping.
      const lead = g.origins.get(g.lead)!
      if (!e.altKey) {
        dx = snap(lead.x + dx) - lead.x
        dy = snap(lead.y + dy) - lead.y
      }
      begin()
      setCanvas(patchNodes(new Set(g.origins.keys()), (n) => {
        const o = g.origins.get(n.id)!
        return { ...n, x: o.x + dx, y: o.y + dy }
      }))
    } else if (g.kind === 'resize') {
      const p = toWorld(e.clientX, e.clientY)
      const width = Math.max(MIN_SIZE.width, g.origin.width + p.x - g.start.x)
      const height = Math.max(MIN_SIZE.height, g.origin.height + p.y - g.start.y)
      begin()
      setCanvas(patchNodes(new Set([g.id]), (n) => ({
        ...n,
        width: e.altKey ? width : Math.max(MIN_SIZE.width, snap(width)),
        height: e.altKey ? height : Math.max(MIN_SIZE.height, snap(height))
      })))
    } else if (g.kind === 'connect') {
      const p = toWorld(e.clientX, e.clientY)
      const target = nodeAt(canvas.nodes, p, 8 / viewRef.current.zoom)
      linkRef.current = { from: g.from, side: g.side, point: p, target: target && target.id !== g.from ? target.id : null }
      setLink(linkRef.current)
    }
  }

  const onPointerUp = (e: PointerEvent) => {
    fingers.current.delete(e.pointerId)
    const g = gesture.current
    // A pinch lasts until the last finger lifts, so the one left behind doesn't start a pan.
    if (g?.kind === 'pinch') {
      if (!fingers.current.size) gesture.current = null
      return
    }
    gesture.current = null
    if (!g) return
    if (g.kind === 'pan' && !g.moved) {
      // A click on empty space; tapped twice, a new card.
      setSelected(new Set())
      setSelectedEdge(null)
      if (isDoubleTap(e, '') && editable) addCard(toWorld(e.clientX, e.clientY))
    } else if (g.kind === 'select') {
      setMarquee(null)
      // Just a click on empty space.
      if (!g.moved) {
        setSelected(g.base)
        setSelectedEdge(null)
      }
    } else if (g.kind === 'move') {
      if (g.moved) end()
      else if (!adds(e) && selected.size > 1) setSelected(new Set([g.lead]))
      // Tapped twice, a card opens for editing, as a double-click does.
      if (!g.moved && isDoubleTap(e, g.lead)) {
        const node = nodesById.get(g.lead)
        if (node?.type === 'text') startEditing(node.id)
        else if (node) openFile(node)
      }
    } else if (g.kind === 'resize') {
      end()
    } else if (g.kind === 'connect') {
      finishConnecting(g.from, g.side)
    }
  }

  const finishConnecting = (fromId: string, fromSide: CanvasSide) => {
    const l = linkRef.current
    linkRef.current = null
    setLink(null)
    const from = nodesById.get(fromId)
    if (!l || !from || !editable) return
    const edge = { id: newId(), fromNode: fromId, fromSide, toEnd: 'arrow' as const }
    const target = l.target ? nodesById.get(l.target) : undefined
    if (target) {
      const toSide = facingSide(target, l.point)
      commit({ ...canvasRef.current, edges: [...canvasRef.current.edges, { ...edge, toNode: target.id, toSide }] })
      return
    }
    // Dropped on empty space: start a new card there, connected.
    const start = anchor(from, fromSide)
    if (Math.hypot(l.point.x - start.x, l.point.y - start.y) < 40) return
    const dx = start.x - l.point.x
    const dy = start.y - l.point.y
    const toSide: CanvasSide = Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : dy < 0 ? 'top' : 'bottom'
    const r = rectWithSideAt(l.point, toSide, 260, 120)
    const node: TextNode = { id: newId(), type: 'text', text: '', ...r, x: snap(r.x), y: snap(r.y) }
    addNodes([node], [{ ...edge, toNode: node.id, toSide }])
    fresh.current = node.id
    startEditing(node.id)
  }

  const onWheel = (e: WheelEvent) => {
    const zooming = e.ctrlKey || e.metaKey
    // A selected card's own scrolling content scrolls, rather than the canvas.
    const scroller = (e.target as Element).closest('.canvas-scroll')
    const owner = scroller?.closest<HTMLElement>('.canvas-node')?.dataset.id
    if (!zooming && scroller && owner && (selected.has(owner) || editing === owner)) {
      if (scroller.scrollHeight > scroller.clientHeight) return
    }
    e.preventDefault()
    const scale = e.deltaMode === 1 ? 16 : 1
    if (zooming) {
      const delta = Math.max(-50, Math.min(50, e.deltaY * scale))
      zoomTo(viewRef.current.zoom * Math.exp(-delta * 0.01), e.clientX, e.clientY)
    } else {
      const v = viewRef.current
      setView({ ...v, x: v.x - e.deltaX * scale, y: v.y - e.deltaY * scale })
    }
  }

  // Window listeners outlive renders; route them to this render's handlers.
  const handlers = useRef({ onPointerMove, onPointerUp, onWheel })
  handlers.current = { onPointerMove, onPointerUp, onWheel }
  useEffect(() => {
    const move = (e: PointerEvent) => handlers.current.onPointerMove(e)
    const up = (e: PointerEvent) => handlers.current.onPointerUp(e)
    const wheel = (e: WheelEvent) => handlers.current.onWheel(e)
    const release = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== ' ') return
      space.current = false
      setGrab(false)
    }
    const el = host.current!
    window.addEventListener('keyup', release)
    window.addEventListener('blur', release)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    el.addEventListener('wheel', wheel, { passive: false })
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      window.removeEventListener('keyup', release)
      window.removeEventListener('blur', release)
      el.removeEventListener('wheel', wheel)
    }
  }, [])

  // ── Keyboard, clipboard and drops ─────────────────────────────────────────

  const onKeyDown = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement
    if (target.closest('input, textarea, [contenteditable]')) return
    const mod = e.metaKey || e.ctrlKey
    const key = e.key.toLowerCase()
    const handled = () => {
      e.preventDefault()
      e.stopPropagation()
    }
    if (mod && key === 'z' && editable) {
      handled()
      if (e.shiftKey) travel(future, past)
      else travel(past, future)
    } else if (mod && key === 'y' && editable) {
      handled()
      travel(future, past)
    } else if (mod && key === 'a') {
      handled()
      setSelected(new Set(canvas.nodes.map((n) => n.id)))
    } else if (mod && key === 'd' && editable) {
      handled()
      duplicate(selected)
    } else if ((e.key === 'Backspace' || e.key === 'Delete') && editable) {
      handled()
      deleteSelection()
    } else if (e.key === ' ' && !mod) {
      handled()
      space.current = true
      setGrab(true)
    } else if (e.key === 'Escape') {
      handled()
      setPicker(false)
      setSelected(new Set())
      setSelectedEdge(null)
    } else if (e.key === 'Enter' && selected.size === 1) {
      const node = nodesById.get([...selected][0])
      if (node?.type === 'text') {
        handled()
        startEditing(node.id)
      } else if (node) {
        handled()
        openFile(node)
      }
    } else if (e.key.startsWith('Arrow') && selected.size && editable) {
      handled()
      const step = e.shiftKey ? GRID * 5 : SNAP
      const dx = key === 'arrowleft' ? -step : key === 'arrowright' ? step : 0
      const dy = key === 'arrowup' ? -step : key === 'arrowdown' ? step : 0
      commit(patchNodes(selected, (n) => ({ ...n, x: n.x + dx, y: n.y + dy })))
    }
  }

  const onPaste = (e: ClipboardEvent) => {
    if ((e.target as HTMLElement).closest('input, textarea, [contenteditable]') || !editable) return
    const files = [...e.clipboardData.files]
    const text = e.clipboardData.getData('text/plain')
    if (files.some((f) => f.type.startsWith('image/'))) {
      e.preventDefault()
      void addImages(files)
    } else if (text.trim()) {
      e.preventDefault()
      addCard(viewCenter(), text.trim())
    }
  }

  const canDrop = (e: DragEvent) =>
    editable && (e.dataTransfer.types.includes(SHEET_DRAG_TYPE) || e.dataTransfer.types.includes('Files'))

  const onDragOver = (e: DragEvent) => {
    if (!canDrop(e)) return
    e.preventDefault()
    // The sheet list only allows moves.
    e.dataTransfer.dropEffect = e.dataTransfer.types.includes(SHEET_DRAG_TYPE) ? 'move' : 'copy'
  }

  const onDrop = (e: DragEvent) => {
    if (!canDrop(e)) return
    e.preventDefault()
    const p = toWorld(e.clientX, e.clientY)
    const raw = e.dataTransfer.getData(SHEET_DRAG_TYPE)
    if (raw) {
      const dropped = JSON.parse(raw) as { projectId: string; sheetId: string }
      if (dropped.projectId === projectId && dropped.sheetId !== sheetId) addNote(dropped.sheetId, p)
      return
    }
    void addImages([...e.dataTransfer.files], p)
  }

  const showNodeMenu = async (e: MouseEvent, node: CanvasNode) => {
    e.preventDefault()
    e.stopPropagation()
    const ids = selected.has(node.id) ? selected : new Set([node.id])
    setSelected(ids)
    setSelectedEdge(null)
    if (!editable) return
    const opens = node.type === 'file' && sheetsById.has(sheetIdOfFile(node.file) ?? '')
    const choice = await hermit.showContextMenu([
      ...(node.type === 'text' ? [{ id: 'edit', label: 'Edit' }] : []),
      ...(opens ? [{ id: 'open', label: 'Open Note' }] : []),
      { id: 'duplicate', label: 'Duplicate' },
      { type: 'separator' },
      { id: 'delete', label: 'Remove from Canvas' }
    ])
    if (choice === 'edit') startEditing(node.id)
    else if (choice === 'open') openFile(node)
    else if (choice === 'duplicate') duplicate(ids)
    else if (choice === 'delete') removeNodes(ids)
  }

  // ── Render ────────────────────────────────────────────────────────────────

  if (initial === null) {
    return (
      <div className="editor-empty">
        <p>This canvas can’t be read.</p>
        <p className="canvas-hint">If it’s part of a sync conflict, resolve the conflict and it will open again.</p>
      </div>
    )
  }

  const renderFile = (node: FileNode): ReactNode => {
    if (isImageFile(node.file)) {
      return <img className="canvas-image" src={fileUrl(projectId, node.file)} alt="" draggable={false} />
    }
    const id = sheetIdOfFile(node.file)
    const sheet = id ? sheetsById.get(id) : undefined
    if (!sheet || !id) return <div className="canvas-missing">Can’t find “{node.file}”</div>
    if (isCanvasId(id)) {
      return (
        <div className="canvas-note-summary">
          <strong>{canvasTitle(id)}</strong>
          <span>{sheet.excerpt}</span>
        </div>
      )
    }
    const text = noteTexts.get(id)?.content
    return text === undefined ? null : <Markdown className="canvas-markdown canvas-scroll" text={text} />
  }

  const fileLabel = (node: FileNode) => {
    if (isImageFile(node.file)) return null
    const sheet = sheetsById.get(sheetIdOfFile(node.file) ?? '')
    return sheet ? sheet.title || 'Untitled' : null
  }

  const renderNode = (node: CanvasNode) => {
    const isSelected = selected.has(node.id)
    const isEditing = editing === node.id
    const heading = node.type === 'text' && isHeading(node.text)
    const align = node.type === 'text' ? textAlign(node) : 'left'
    const className = [
      'canvas-node',
      `type-${node.type}`,
      node.type === 'file' && isImageFile(node.file) && 'image',
      heading && 'heading',
      align !== 'left' && `align-${align}`,
      node.color && 'colored',
      isSelected && 'selected',
      isEditing && 'editing',
      link?.target === node.id && 'link-target'
    ]
      .filter(Boolean)
      .join(' ')
    const label = node.type === 'file' ? fileLabel(node) : node.type === 'group' ? node.label : null
    return (
      <div
        key={node.id}
        data-id={node.id}
        className={className}
        style={{ left: node.x, top: node.y, width: node.width, height: node.height, ...colorStyle(node.color) }}
        onPointerDown={(e) => onNodeDown(e, node)}
        onDoubleClick={(e) => {
          e.stopPropagation()
          if (!fromMouse()) return
          if (node.type === 'text') startEditing(node.id)
          else openFile(node)
        }}
        onContextMenu={(e) => void showNodeMenu(e, node)}
      >
        {label && <div className="canvas-node-label">{label}</div>}
        <div className="canvas-node-body">
          {node.type === 'text' &&
            (isEditing ? (
              <CardEditor
                text={node.text}
                // A new heading's placeholder is selected, ready to type over.
                select={node.text === '# Heading' ? { from: 2, to: node.text.length } : undefined}
                onChange={(text, scrollHeight) => {
                  // Grow the card to fit what's written.
                  const height = Math.max(node.height, scrollHeight + 2)
                  setCanvas(patchNodes(new Set([node.id]), (n) => ({ ...n, text, height }) as TextNode), true)
                }}
                onDone={finishEditing}
              />
            ) : (
              <Markdown className={`canvas-markdown${heading ? '' : ' canvas-scroll'}`} text={node.text} />
            ))}
          {node.type === 'file' && renderFile(node)}
          {node.type === 'link' && (
            <a className="canvas-link" href={node.url} target="_blank" rel="noreferrer">
              {node.url}
            </a>
          )}
        </div>
        {editable && !isEditing && node.type !== 'group' && (
          <>
            {SIDES.map((side) => (
              <div
                key={side}
                className={`canvas-handle ${side}`}
                onPointerDown={(e) => onHandleDown(e, node, side)}
              />
            ))}
          </>
        )}
        {editable && isSelected && selected.size === 1 && !isEditing && (
          <div className="canvas-resize" onPointerDown={(e) => onResizeDown(e, node)} />
        )}
      </div>
    )
  }

  const edgeShapes = canvas.edges.flatMap((edge) => {
    const from = nodesById.get(edge.fromNode)
    const to = nodesById.get(edge.toNode)
    return from && to ? [{ edge, geo: edgeGeometry(edge, from, to) }] : []
  })

  const linkShape = (() => {
    if (!link) return null
    const from = nodesById.get(link.from)
    const target = link.target ? nodesById.get(link.target) : undefined
    if (!from) return null
    if (target) {
      const toSide = facingSide(target, link.point)
      return curve(anchor(from, link.side), link.side, anchor(target, toSide), toSide, { start: false, end: true })
    }
    return curve(anchor(from, link.side), link.side, link.point, null, { start: false, end: true })
  })()

  // The edge layer only needs to cover the cards, and wherever a connection is being drawn to.
  const layer = boundsOf([...canvas.nodes, ...(link ? [{ ...link.point, width: 1, height: 1 }] : [])])
  const pad = 400
  const svgBox = layer && { x: layer.x - pad, y: layer.y - pad, width: layer.width + pad * 2, height: layer.height + pad * 2 }

  const groups = canvas.nodes.filter((n) => n.type === 'group')
  const cards = canvas.nodes.filter((n) => n.type !== 'group')

  // Where the floating toolbar goes: above the selection, or the selected connection's label.
  const toScreen = (p: Point) => ({ x: p.x * view.zoom + view.x, y: p.y * view.zoom + view.y })
  const selectedNodes = canvas.nodes.filter((n) => selected.has(n.id))
  const selectionBox = boundsOf(selectedNodes)
  const edgeShape = selectedEdge ? edgeShapes.find((s) => s.edge.id === selectedEdge) : undefined
  const toolbarAt =
    editing || editingEdge || link || marquee
      ? null
      : edgeShape
        ? toScreen({ x: edgeShape.geo.mid.x, y: edgeShape.geo.mid.y - 24 / view.zoom })
        : selectionBox && toScreen({ x: selectionBox.x + selectionBox.width / 2, y: selectionBox.y })
  const single = selectedNodes.length === 1 ? selectedNodes[0] : null
  // Shown as set only when everything selected agrees; null when it doesn't.
  const colors = new Set((edgeShape ? [edgeShape.edge] : selectedNodes).map((n) => n.color))
  const activeColor = colors.size === 1 ? [...colors][0] : null
  const selectedTexts = edgeShape ? [] : selectedNodes.filter((n) => n.type === 'text')
  // Shown as set only when every selected card agrees.
  const alignments = new Set(selectedTexts.map(textAlign))
  const activeAlign = alignments.size === 1 ? [...alignments][0] : null

  const gridSize = GRID * view.zoom * (view.zoom < 0.5 ? 5 : 1)
  const pickable = props.sheets.filter((s) => s.id !== sheetId)

  return (
    <div
      ref={host}
      className={`canvas-view${grab ? ' grab' : ''}`}
      tabIndex={0}
      style={{
        backgroundSize: `${gridSize}px ${gridSize}px`,
        backgroundPosition: `${view.x}px ${view.y}px`
      }}
      onPointerDown={onBackgroundDown}
      onDoubleClick={(e) => editable && fromMouse() && addCard(toWorld(e.clientX, e.clientY))}
      onContextMenu={onBackgroundMenu}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <div
        className="canvas-world"
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`, '--zoom': view.zoom } as CSSProperties}
      >
        {groups.map(renderNode)}
        {svgBox && (
          <svg
            className="canvas-edges"
            style={{ left: svgBox.x, top: svgBox.y, width: svgBox.width, height: svgBox.height }}
            viewBox={`${svgBox.x} ${svgBox.y} ${svgBox.width} ${svgBox.height}`}
          >
            {edgeShapes.map(({ edge, geo }) => (
              <g
                key={edge.id}
                className={`canvas-edge${edge.id === selectedEdge ? ' selected' : ''}`}
                style={colorStyle(edge.color)}
              >
                <path className="canvas-edge-line" d={geo.path} />
                {geo.arrows.map((points, i) => (
                  <polygon key={i} className="canvas-edge-arrow" points={points} />
                ))}
                <path
                  className="canvas-edge-hit"
                  d={geo.path}
                  onPointerDown={(e) => {
                    if (e.button !== 0) return
                    e.stopPropagation()
                    setSelected(new Set())
                    setSelectedEdge(edge.id)
                    setPicker(false)
                  }}
                  onDoubleClick={(e) => {
                    e.stopPropagation()
                    if (!editable) return
                    begin()
                    setEditingEdge(edge.id)
                  }}
                />
              </g>
            ))}
            {linkShape && (
              <g className="canvas-edge drawing">
                <path className="canvas-edge-line" d={linkShape.path} />
                {linkShape.arrows.map((points, i) => (
                  <polygon key={i} className="canvas-edge-arrow" points={points} />
                ))}
              </g>
            )}
          </svg>
        )}
        {cards.map(renderNode)}
        {edgeShapes.map(({ edge, geo }) =>
          edge.id === editingEdge ? (
            <input
              key={edge.id}
              className="canvas-edge-label editing"
              style={{ left: geo.mid.x, top: geo.mid.y }}
              value={edge.label ?? ''}
              placeholder="Label"
              autoFocus
              onPointerDown={(e) => e.stopPropagation()}
              onChange={(e) => {
                const label = e.target.value
                setCanvas(
                  patchEdge(edge.id, ({ label: _, ...rest }) => (label ? { ...rest, label } : rest)),
                  true
                )
              }}
              onBlur={finishEditingEdge}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === 'Escape') && e.currentTarget.blur()}
            />
          ) : (
            edge.label && (
              <div
                key={edge.id}
                className={`canvas-edge-label${edge.id === selectedEdge ? ' selected' : ''}`}
                style={{ left: geo.mid.x, top: geo.mid.y }}
                onPointerDown={(e) => {
                  e.stopPropagation()
                  setSelected(new Set())
                  setSelectedEdge(edge.id)
                }}
                onDoubleClick={(e) => {
                  e.stopPropagation()
                  if (!editable) return
                  begin()
                  setEditingEdge(edge.id)
                }}
              >
                {edge.label}
              </div>
            )
          )
        )}
        {marquee && (
          <div
            className="canvas-marquee"
            style={{ left: marquee.x, top: marquee.y, width: marquee.width, height: marquee.height }}
          />
        )}
      </div>

      {canvas.nodes.length === 0 && (
        <div className="canvas-empty">
          <p>An empty canvas.</p>
          <p className="canvas-hint">
            {touch
              ? 'Double-tap anywhere to add a card, or add notes and images from the toolbar.'
              : 'Double-click anywhere to add a card, or drag notes and images in.'}
          </p>
        </div>
      )}

      {editable && toolbarAt && (
        <div
          className="canvas-floating"
          style={{ left: toolbarAt.x, top: toolbarAt.y }}
          onPointerDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <button
            className={`canvas-swatch none${activeColor === undefined ? ' current' : ''}`}
            title="No Colour"
            onClick={() => setColor(undefined)}
          />
          {COLORS.map(([color, name]) => (
            <button
              key={color}
              className={`canvas-swatch${activeColor === color ? ' current' : ''}`}
              style={colorStyle(color)}
              title={name}
              onClick={() => setColor(color)}
            />
          ))}
          <span className="canvas-floating-divider" />
          {selectedTexts.length > 0 && (
            <>
              {ALIGNMENTS.map(([align, title, Icon]) => (
                <button
                  key={align}
                  className={`icon-button${activeAlign === align ? ' on' : ''}`}
                  title={title}
                  onClick={() => setAlign(align)}
                >
                  <Icon />
                </button>
              ))}
              <span className="canvas-floating-divider" />
            </>
          )}
          {edgeShape && (
            <>
              <button className="icon-button" title="Arrows" onClick={() => cycleArrows(edgeShape.edge.id)}>
                <ArrowIcon />
              </button>
              <button
                className="icon-button"
                title="Edit Label"
                onClick={() => {
                  begin()
                  setEditingEdge(edgeShape.edge.id)
                }}
              >
                <ComposeIcon />
              </button>
            </>
          )}
          {single?.type === 'text' && (
            <button className="icon-button" title="Edit" onClick={() => startEditing(single.id)}>
              <ComposeIcon />
            </button>
          )}
          {single?.type === 'file' && sheetsById.has(sheetIdOfFile(single.file) ?? '') && (
            <button className="icon-button" title="Open Note" onClick={() => openFile(single)}>
              <OpenIcon />
            </button>
          )}
          <button className="icon-button" title="Remove" onClick={deleteSelection}>
            <TrashIcon />
          </button>
        </div>
      )}

      <div
        className="canvas-toolbar"
        onPointerDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        {editable && (
          <>
            <button className="icon-button" title="Add Card" onClick={() => addCard()}>
              <CardIcon />
            </button>
            <button className="icon-button" title="Add Heading" onClick={() => addHeading()}>
              <HeadingIcon />
            </button>
            <button
              className={`icon-button${picker ? ' on' : ''}`}
              title="Add Linked Note"
              onClick={() => setPicker((p) => !p)}
            >
              <NoteLinkIcon />
            </button>
            <button className="icon-button" title="Add Image" onClick={() => imageInput.current?.click()}>
              <ImageIcon />
            </button>
            <span className="canvas-floating-divider" />
          </>
        )}
        <button className="icon-button" title="Zoom Out" onClick={() => zoomTo(view.zoom / 1.25)}>
          <MinusIcon />
        </button>
        <button className="canvas-zoom" title="Actual Size" onClick={() => zoomTo(1)}>
          {Math.round(view.zoom * 100)}%
        </button>
        <button className="icon-button" title="Zoom In" onClick={() => zoomTo(view.zoom * 1.25)}>
          <PlusIcon />
        </button>
        <button className="icon-button" title="Zoom to Fit" onClick={fit}>
          <FitIcon />
        </button>
        <input
          ref={imageInput}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            void addImages([...(e.target.files ?? [])])
            e.target.value = ''
          }}
        />
        {picker && (
          <NotePicker
            sheets={pickable}
            onPick={(id) => {
              setPicker(false)
              addNote(id)
              host.current?.focus()
            }}
            onClose={() => {
              setPicker(false)
              host.current?.focus()
            }}
          />
        )}
      </div>
    </div>
  )
}

function NotePicker({
  sheets,
  onPick,
  onClose
}: {
  sheets: SheetSummary[]
  onPick(id: string): void
  onClose(): void
}) {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean)
  const has = (text: string) => terms.every((t) => text.toLocaleLowerCase().includes(t))
  // Titles that match come before notes that only mention the words.
  const matches = [
    ...sheets.filter((s) => has(s.title)),
    ...sheets.filter((s) => !has(s.title) && has(s.excerpt))
  ]
  const active = Math.min(index, matches.length - 1)

  return (
    <div className="canvas-picker" onPointerDown={(e) => e.stopPropagation()}>
      <label className="search-field">
        <SearchIcon />
        <input
          autoFocus
          placeholder="Link a note or sheet"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setIndex(0)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose()
            else if (e.key === 'ArrowDown') setIndex(Math.min(matches.length - 1, active + 1))
            else if (e.key === 'ArrowUp') setIndex(Math.max(0, active - 1))
            else if (e.key === 'Enter' && matches[active]) onPick(matches[active].id)
            else return
            e.preventDefault()
          }}
        />
      </label>
      <ul className="canvas-picker-list">
        {matches.map((s, i) => (
          <li
            key={s.id}
            className={i === active ? 'active' : undefined}
            onMouseEnter={() => setIndex(i)}
            onClick={() => onPick(s.id)}
          >
            <span className="canvas-picker-title">{s.title || 'Untitled'}</span>
            <span className="canvas-picker-place">{placeName(s)}</span>
          </li>
        ))}
        {!matches.length && <li className="canvas-picker-empty">Nothing matches</li>}
      </ul>
    </div>
  )
}
