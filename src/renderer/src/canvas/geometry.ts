import type { CanvasEdge, CanvasNode, CanvasSide } from '../../../shared/canvas'

export interface Point {
  x: number
  y: number
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export const SIDES: CanvasSide[] = ['top', 'right', 'bottom', 'left']

const NORMALS: Record<CanvasSide, Point> = {
  top: { x: 0, y: -1 },
  right: { x: 1, y: 0 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 }
}

/** The middle of one side of a rectangle, where connections attach. */
export function anchor(r: Rect, side: CanvasSide): Point {
  switch (side) {
    case 'top': return { x: r.x + r.width / 2, y: r.y }
    case 'right': return { x: r.x + r.width, y: r.y + r.height / 2 }
    case 'bottom': return { x: r.x + r.width / 2, y: r.y + r.height }
    case 'left': return { x: r.x, y: r.y + r.height / 2 }
  }
}

export const center = (r: Rect): Point => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 })

/** The side of `r` that faces `p`. */
export function facingSide(r: Rect, p: Point): CanvasSide {
  const c = center(r)
  // Compare in units of the rectangle's own size, so wide cards don't favour their ends.
  const dx = (p.x - c.x) / Math.max(1, r.width)
  const dy = (p.y - c.y) / Math.max(1, r.height)
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 'right' : 'left'
  return dy > 0 ? 'bottom' : 'top'
}

export const contains = (r: Rect, p: Point, margin = 0) =>
  p.x >= r.x - margin && p.x <= r.x + r.width + margin && p.y >= r.y - margin && p.y <= r.y + r.height + margin

export const intersects = (a: Rect, b: Rect) =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y

export const inside = (inner: Rect, outer: Rect) =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.width <= outer.x + outer.width &&
  inner.y + inner.height <= outer.y + outer.height

/** A rectangle from two corners, in any order. */
export function rectFrom(a: Point, b: Point): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) }
}

export function boundsOf(rects: Rect[]): Rect | null {
  if (!rects.length) return null
  const minX = Math.min(...rects.map((r) => r.x))
  const minY = Math.min(...rects.map((r) => r.y))
  const maxX = Math.max(...rects.map((r) => r.x + r.width))
  const maxY = Math.max(...rects.map((r) => r.y + r.height))
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

/** The topmost card under a point; groups only count where no card is. */
export function nodeAt(nodes: CanvasNode[], p: Point, margin = 0): CanvasNode | undefined {
  const hit = (n: CanvasNode) => contains(n, p, margin)
  return [...nodes].reverse().find((n) => n.type !== 'group' && hit(n)) ?? [...nodes].reverse().find(hit)
}

export interface EdgeGeometry {
  path: string
  /** Halfway along the curve, for the label. */
  mid: Point
  /** Where it arrives, at its `to` end. */
  end: Point
  /** Triangles for the arrowheads, as SVG polygon points. */
  arrows: string[]
}

function arrowhead(tip: Point, from: Point, size: number): string {
  const angle = Math.atan2(tip.y - from.y, tip.x - from.x)
  const spread = Math.PI / 7
  const corner = (a: number) => `${tip.x - size * Math.cos(a)},${tip.y - size * Math.sin(a)}`
  return `${tip.x},${tip.y} ${corner(angle - spread)} ${corner(angle + spread)}`
}

/** A curve leaving `from` straight out of `fromSide` and arriving at `to` straight into `toSide`. */
export function curve(
  from: Point,
  fromSide: CanvasSide,
  to: Point,
  toSide: CanvasSide | null,
  ends: { start: boolean; end: boolean }
): EdgeGeometry {
  const distance = Math.hypot(to.x - from.x, to.y - from.y)
  const reach = Math.min(160, Math.max(36, distance / 2))
  const n1 = NORMALS[fromSide]
  const c1 = { x: from.x + n1.x * reach, y: from.y + n1.y * reach }
  // A loose end, still being dragged, just follows the pointer.
  const n2 = toSide ? NORMALS[toSide] : { x: 0, y: 0 }
  const c2 = { x: to.x + n2.x * reach, y: to.y + n2.y * reach }
  const mid = {
    x: (from.x + 3 * c1.x + 3 * c2.x + to.x) / 8,
    y: (from.y + 3 * c1.y + 3 * c2.y + to.y) / 8
  }
  const arrows: string[] = []
  if (ends.end) arrows.push(arrowhead(to, toSide ? c2 : c1, 12))
  if (ends.start) arrows.push(arrowhead(from, c1, 12))
  return { path: `M ${from.x} ${from.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${to.x} ${to.y}`, mid, end: to, arrows }
}

/** Where a connection between two cards runs, choosing sides for whichever end doesn't name one. */
export function edgeGeometry(edge: CanvasEdge, from: Rect, to: Rect): EdgeGeometry {
  const fromSide = edge.fromSide ?? facingSide(from, center(to))
  const toSide = edge.toSide ?? facingSide(to, center(from))
  return curve(anchor(from, fromSide), fromSide, anchor(to, toSide), toSide, {
    start: edge.fromEnd === 'arrow',
    end: (edge.toEnd ?? 'arrow') === 'arrow'
  })
}
