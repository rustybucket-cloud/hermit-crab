// Fountain is plain-text markup for screenplays (https://fountain.io), the way Markdown
// is for prose. These helpers sort each line into a screenplay element, so the editor
// can lay a script out as you type, and render it as a formatted screenplay.

export type FountainLineType =
  | 'title-page'
  | 'scene'
  | 'action'
  | 'character'
  | 'parenthetical'
  | 'dialogue'
  | 'transition'
  | 'centered'
  | 'lyric'
  | 'section'
  | 'synopsis'
  | 'note'
  | 'page-break'
  | 'boneyard'
  | 'blank'

export interface FountainLine {
  type: FountainLineType
  /** Length of the mark that forces the line's type, such as `.` or `@`, with any indent before it. It isn't printed. */
  mark: number
}

const TITLE_KEY = /^(title|credit|authors?|source|draft date|date|contact|copyright|notes|revision)\s*:/i
const SCENE = /^(int|ext|est|int\.?\/ext|i\/e)[. ]/i
const TRANSITION = /^[^\p{Ll}]*TO:$/u
const PAGE_BREAK = /^\s*={3,}\s*$/
const NOTE_LINE = /^\s*\[\[.*\]\]\s*$/
const PARENTHETICAL = /^\s*\(.*\)\s*$/

const isBlank = (line: string | undefined) => line === undefined || line.trim() === ''

/** All capitals, with at least one letter, once an extension like (V.O.) and a dual-dialogue caret are set aside. */
function isCharacterCue(line: string): boolean {
  const name = line.trim().replace(/\^$/, '').replace(/\(.*\)\s*$/, '').trim()
  return /\p{L}/u.test(name) && !/\p{Ll}/u.test(name)
}

/** Whether a boneyard comment opens on this line and runs past its end. */
const opensBoneyard = (line: string) => line.lastIndexOf('/*') > line.lastIndexOf('*/')

/** Sort every line of a script into the element it belongs to. */
export function parseFountain(lines: string[]): FountainLine[] {
  const out: FountainLine[] = []
  let i = 0

  // A title page is key: value pairs at the very top, up to the first blank line.
  if (TITLE_KEY.test(lines[0] ?? '')) {
    for (; i < lines.length && !isBlank(lines[i]); i++) out.push({ type: 'title-page', mark: 0 })
  }

  let inBoneyard = false
  let inDialogue = false
  for (; i < lines.length; i++) {
    const line = lines[i]
    const lead = line.length - line.trimStart().length
    const text = line.trim()
    const first = text[0]
    const afterBlank = isBlank(lines[i - 1])
    const beforeBlank = isBlank(lines[i + 1])
    const push = (type: FountainLineType, mark = 0) => out.push({ type, mark: mark && lead + mark })

    if (inBoneyard || text.startsWith('/*')) {
      push('boneyard')
      inBoneyard = inBoneyard ? !line.includes('*/') : opensBoneyard(line)
      continue
    }
    inBoneyard = opensBoneyard(line)

    if (!text) {
      // A line of exactly two spaces keeps dialogue going across a gap.
      if (inDialogue && line === '  ') {
        push('dialogue')
      } else {
        inDialogue = false
        push('blank')
      }
    } else if (NOTE_LINE.test(line)) {
      push('note')
    } else if (inDialogue) {
      push(PARENTHETICAL.test(line) ? 'parenthetical' : 'dialogue')
    } else if (PAGE_BREAK.test(line)) {
      push('page-break')
    } else if (first === '#') {
      push('section', /^#+/.exec(text)![0].length)
    } else if (first === '=') {
      push('synopsis', 1)
    } else if (first === '~') {
      push('lyric', 1)
    } else if (first === '>') {
      push(text.endsWith('<') ? 'centered' : 'transition', 1)
    } else if (first === '!') {
      push('action', 1)
    } else if (afterBlank && /^\.[^.]/.test(text)) {
      push('scene', 1)
    } else if (afterBlank && SCENE.test(text)) {
      push('scene')
    } else if (first === '@') {
      push('character', 1)
      inDialogue = !beforeBlank
    } else if (afterBlank && !beforeBlank && isCharacterCue(text)) {
      push('character')
      inDialogue = true
    } else if (afterBlank && beforeBlank && TRANSITION.test(text)) {
      push('transition')
    } else {
      push('action')
    }
  }
  return out
}

// ── Rendering ───────────────────────────────────────────────────────────────

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/** Notes and boneyard aren't printed. */
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\[\[[\s\S]*?\]\]/g, '')

/** Escape a line and turn Fountain emphasis into HTML. A backslash keeps a `*` or `_` literal. */
function inline(text: string): string {
  return escapeHtml(text)
    .replace(/\\([*_])/g, (_, c: string) => (c === '*' ? '&#42;' : '&#95;'))
    .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/_(.+?)_/g, '<u>$1</u>')
}

/** A line's printed text: without its forcing mark, or the closing `<` of a centred line. */
function printed(line: string, parsed: FountainLine): string {
  let text = line.slice(parsed.mark).trim()
  if (parsed.type === 'centered') text = text.replace(/<$/, '').trim()
  if (parsed.type === 'character') text = text.replace(/\s*\^$/, '')
  return text
}

const TITLE_TOP = ['title', 'credit', 'author', 'authors', 'source']

function titlePageHtml(lines: string[]): string {
  const fields: { key: string; values: string[] }[] = []
  for (const line of lines) {
    const match = /^([^:]+):\s*(.*)$/.exec(line)
    if (match && !/^\s/.test(line)) fields.push({ key: match[1].trim().toLowerCase(), values: match[2] ? [match[2]] : [] })
    else fields.at(-1)?.values.push(line.trim())
  }
  const render = (f: { key: string; values: string[] }) =>
    `<p class="${f.key === 'title' ? 'title' : escapeHtml(f.key.replace(/\s+/g, '-'))}">${f.values.map(inline).join('<br>')}</p>`
  const top = fields.filter((f) => TITLE_TOP.includes(f.key))
  const bottom = fields.filter((f) => !TITLE_TOP.includes(f.key))
  return `<div class="title-page"><div class="title-page-main">${top.map(render).join('')}</div><div class="title-page-extra">${bottom.map(render).join('')}</div></div>`
}

/** Render a script as HTML, laid out by the `.screenplay` styles that preview and export supply. */
export function fountainToHtml(source: string): string {
  const lines = stripComments(source.replace(/\r\n?/g, '\n')).split('\n')
  const parsed = parseFountain(lines)
  const html: string[] = []
  let action: string[] = []
  let dialogue: string[] | null = null

  const endBlocks = () => {
    if (action.length) html.push(`<p class="action">${action.join('<br>')}</p>`)
    if (dialogue) html.push(`<div class="dialogue-block">${dialogue.join('')}</div>`)
    action = []
    dialogue = null
  }

  const titleLines = lines.filter((_, i) => parsed[i].type === 'title-page')
  if (titleLines.length) html.push(titlePageHtml(titleLines))

  parsed.forEach((p, i) => {
    const text = printed(lines[i], p)
    switch (p.type) {
      case 'action':
        if (dialogue) endBlocks()
        // Keep the writer's indentation inside action.
        action.push(inline(lines[i].slice(p.mark).replace(/^\s+/, (ws) => ' '.repeat(ws.length))))
        return
      case 'character':
        endBlocks()
        dialogue = [`<p class="character">${inline(text)}</p>`]
        return
      case 'parenthetical':
      case 'dialogue':
        dialogue?.push(`<p class="${p.type}">${inline(text)}</p>`)
        return
      case 'scene': {
        endBlocks()
        const number = /\s*#([\w.-]+)#$/.exec(text)
        const heading = number ? text.slice(0, number.index) : text
        html.push(
          `<h3 class="scene">${inline(heading)}${number ? `<span class="scene-number">${escapeHtml(number[1])}</span>` : ''}</h3>`
        )
        return
      }
      case 'transition':
      case 'centered':
      case 'lyric':
        endBlocks()
        html.push(`<p class="${p.type}">${inline(text)}</p>`)
        return
      case 'page-break':
        endBlocks()
        html.push('<hr class="page-break">')
        return
      case 'blank':
        endBlocks()
        return
      // Sections, synopses, notes and the boneyard shape the draft but aren't printed.
    }
  })
  endBlocks()
  return html.join('\n')
}

/** The script as plain lines for titles and excerpts: no forcing marks, comments or emphasis markers. */
export function fountainPlainText(source: string): string {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  return parseFountain(lines)
    .map((p, i) => {
      if (p.type === 'boneyard' || p.type === 'note' || p.type === 'page-break') return ''
      if (p.type === 'title-page') return lines[i].replace(/^[^:\s][^:]*:\s*/, '')
      return printed(lines[i], p)
    })
    .map((line) => line.replace(/\[\[.*?\]\]|\/\*.*?\*\//g, '').trim())
    .join('\n')
}
