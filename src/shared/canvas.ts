// Canvases are saved in the JSON Canvas format (jsoncanvas.org), the one Obsidian uses,
// so a canvas stays readable, and editable, outside the app.

import { countWords } from './text'

export const CANVAS_EXT = '.canvas'

/** A preset colour, `1` to `6` (red, orange, yellow, green, cyan, purple), or a hex colour. */
export type CanvasColor = string

export type CanvasSide = 'top' | 'right' | 'bottom' | 'left'

interface NodeBase {
  id: string
  x: number
  y: number
  width: number
  height: number
  color?: CanvasColor
}

export type TextAlign = 'left' | 'center' | 'right'

/** A card of Markdown. A card that's only a heading shows as a heading, without a card around it. */
export interface TextNode extends NodeBase {
  type: 'text'
  text: string
  /** Kept where Obsidian's Advanced Canvas plugin keeps it, so cards line up the same there. Left if unset. */
  styleAttributes?: { textAlign?: TextAlign; [key: string]: unknown }
}

/** A note, sheet or image from the project, by its path within the project, such as `Notes/<name>.md`. */
export interface FileNode extends NodeBase {
  type: 'file'
  file: string
  subpath?: string
}

export interface LinkNode extends NodeBase {
  type: 'link'
  url: string
}

export interface GroupNode extends NodeBase {
  type: 'group'
  label?: string
}

export type CanvasNode = TextNode | FileNode | LinkNode | GroupNode

export interface CanvasEdge {
  id: string
  fromNode: string
  fromSide?: CanvasSide
  fromEnd?: 'none' | 'arrow'
  toNode: string
  toSide?: CanvasSide
  toEnd?: 'none' | 'arrow'
  color?: CanvasColor
  label?: string
}

export interface CanvasData {
  nodes: CanvasNode[]
  edges: CanvasEdge[]
}

export const isCanvasId = (sheetId: string) => sheetId.endsWith(CANVAS_EXT)

/** A sheet's file name within its project: canvas ids keep their extension, Markdown ids drop `.md`. */
export const sheetFile = (sheetId: string) => (isCanvasId(sheetId) ? sheetId : `${sheetId}.md`)

/** The sheet id a project-relative file path points at, or null if it isn't a sheet. */
export function sheetIdOfFile(file: string): string | null {
  if (isCanvasId(file)) return file
  return file.endsWith('.md') ? file.slice(0, -3) : null
}

/** A canvas's title is its file name. */
export const canvasTitle = (sheetId: string) => sheetId.slice(sheetId.lastIndexOf('/') + 1, -CANVAS_EXT.length)

const IMAGE = /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i
export const isImageFile = (file: string) => IMAGE.test(file)

const SIDES: CanvasSide[] = ['top', 'right', 'bottom', 'left']

/** How a card's text lines up. */
export const textAlign = (node: TextNode): TextAlign => {
  const align = node.styleAttributes?.textAlign
  return align === 'center' || align === 'right' ? align : 'left'
}

/** A card with its text lined up a new way, dropping the setting when it's back to left. */
export function withTextAlign(node: TextNode, align: TextAlign): TextNode {
  const { textAlign: _, ...attributes } = node.styleAttributes ?? {}
  const styleAttributes = align === 'left' ? attributes : { ...attributes, textAlign: align }
  const { styleAttributes: __, ...rest } = node
  return Object.keys(styleAttributes).length ? { ...rest, styleAttributes } : rest
}

/** Read a canvas file, dropping anything too broken to show. Throws if it isn't JSON at all. */
export function parseCanvas(raw: string): CanvasData {
  if (!raw.trim()) return { nodes: [], edges: [] }
  const data = JSON.parse(raw) as Partial<CanvasData>
  const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
  const nodes = (Array.isArray(data.nodes) ? data.nodes : []).flatMap((n): CanvasNode[] => {
    if (!n || typeof n.id !== 'string') return []
    // Keep fields we don't know about, so saving never loses what another app wrote.
    const node = {
      ...n,
      x: num(n.x, 0),
      y: num(n.y, 0),
      width: Math.max(20, num(n.width, 250)),
      height: Math.max(20, num(n.height, 60))
    } as CanvasNode
    if (node.type === 'text') return [{ ...node, text: typeof node.text === 'string' ? node.text : '' }]
    if (node.type === 'file') return typeof node.file === 'string' ? [node] : []
    if (node.type === 'link') return typeof node.url === 'string' ? [node] : []
    if (node.type === 'group') return [node]
    return []
  })
  const ids = new Set(nodes.map((n) => n.id))
  const side = (s: unknown) => (SIDES.includes(s as CanvasSide) ? (s as CanvasSide) : undefined)
  const edges = (Array.isArray(data.edges) ? data.edges : []).flatMap((e): CanvasEdge[] => {
    if (!e || typeof e.id !== 'string' || !ids.has(e.fromNode) || !ids.has(e.toNode)) return []
    return [{ ...e, fromSide: side(e.fromSide), toSide: side(e.toSide) }]
  })
  return { nodes, edges }
}

export function serializeCanvas(canvas: CanvasData): string {
  return `${JSON.stringify(canvas, null, '\t')}\n`
}

/** The words on a canvas, for search and counts: its cards, group names and connection labels. */
export function canvasText(canvas: CanvasData): string {
  return [
    ...canvas.nodes.map((n) => (n.type === 'text' ? n.text : n.type === 'group' ? (n.label ?? '') : '')),
    ...canvas.edges.map((e) => e.label ?? '')
  ]
    .filter(Boolean)
    .join('\n')
}

export function summarizeCanvas(raw: string): { excerpt: string; wordCount: number } {
  let canvas: CanvasData
  try {
    canvas = parseCanvas(raw)
  } catch {
    return { excerpt: 'Can’t be read', wordCount: 0 }
  }
  const cards = canvas.nodes.filter((n) => n.type !== 'group').length
  const connections = canvas.edges.length
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`
  const excerpt = cards ? `${plural(cards, 'card')} · ${plural(connections, 'connection')}` : 'Empty canvas'
  return { excerpt, wordCount: countWords(canvasText(canvas)) }
}

/** Point file cards at sheets' new paths after they move. `renamed` maps old sheet ids to new ones. */
export function relinkCanvas(canvas: CanvasData, renamed: Record<string, string>): CanvasData | null {
  const files = new Map(Object.entries(renamed).map(([from, to]) => [sheetFile(from), sheetFile(to)]))
  let changed = false
  const nodes = canvas.nodes.map((n) => {
    const to = n.type === 'file' ? files.get(n.file) : undefined
    if (!to || n.type !== 'file') return n
    changed = true
    return { ...n, file: to }
  })
  return changed ? { ...canvas, nodes } : null
}

export const EMPTY_CANVAS = serializeCanvas({ nodes: [], edges: [] })
