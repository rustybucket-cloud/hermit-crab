import { insertNewline } from '@codemirror/commands'
import {
  EditorSelection,
  EditorState,
  Prec,
  StateField,
  type Extension,
  type Range,
  type TransactionSpec
} from '@codemirror/state'
import { Decoration, EditorView, keymap, type Command, type DecorationSet } from '@codemirror/view'
import {
  isBlank,
  isCharacterCue,
  parseFountain,
  SCENE,
  type FountainLine,
  type FountainLineType
} from '../../../shared/fountain'

// Screenplays are written in Fountain. Each line is styled as the element it is,
// indented the way it will print, while every character stays as typed.
//
// Writing one shouldn't need Fountain's rules, though. As in a screenwriting app,
// Tab changes what the current line is, Enter moves on to the element that usually
// comes next, and names and scene headings are capitalised as you type. Where a line
// needs a mark to be read as its element (`@` for a name in mixed case, say), the
// mark is written for you and hidden.

/** The elements you write a screenplay in, as offered by Tab, the menu and the status bar. */
export type ScreenplayElement = 'scene' | 'action' | 'character' | 'parenthetical' | 'dialogue' | 'transition'

export const SCREENPLAY_ELEMENTS: { type: ScreenplayElement; label: string; short: string; key: string }[] = [
  { type: 'scene', label: 'Scene Heading', short: 'Scene', key: 'Mod-Alt-1' },
  { type: 'action', label: 'Action', short: 'Action', key: 'Mod-Alt-2' },
  { type: 'character', label: 'Character', short: 'Character', key: 'Mod-Alt-3' },
  { type: 'parenthetical', label: 'Parenthetical', short: 'Paren', key: 'Mod-Alt-4' },
  { type: 'dialogue', label: 'Dialogue', short: 'Dialogue', key: 'Mod-Alt-5' },
  { type: 'transition', label: 'Transition', short: 'Transition', key: 'Mod-Alt-6' }
]

export const ELEMENT_LABELS: Record<FountainLineType, string> = {
  'title-page': 'Title Page',
  scene: 'Scene Heading',
  action: 'Action',
  character: 'Character',
  parenthetical: 'Parenthetical',
  dialogue: 'Dialogue',
  transition: 'Transition',
  centered: 'Centered',
  lyric: 'Lyric',
  section: 'Section',
  synopsis: 'Synopsis',
  note: 'Note',
  'page-break': 'Page Break',
  boneyard: 'Boneyard',
  blank: 'Action'
}

/** Lines that keep a speech going: the next line, if it isn't blank, is more of it. */
const SPEECH: FountainLineType[] = ['character', 'parenthetical', 'dialogue']
/** Marks that are only there to force an element; the line's styling shows what they do. */
const HIDDEN_MARKS: FountainLineType[] = ['scene', 'action', 'character', 'transition', 'lyric']
/** Lines that aren't written as an element, so can't be turned into one. */
const FIXED: FountainLineType[] = ['title-page', 'boneyard', 'note', 'page-break']

// ── Parsing ─────────────────────────────────────────────────────────────────

/**
 * Parse the script as it's being written. An empty line just after a name, with the caret
 * on it, is where the dialogue is about to go, so the name stays a name while it's empty.
 */
function parseScript(lines: string[], caret: number): FountainLine[] {
  const parsed = parseFountain(lines)
  if (caret < 1 || !isBlank(lines[caret]) || isBlank(lines[caret - 1]) || !isBlank(lines[caret + 1])) return parsed
  const writing = lines.slice()
  writing[caret] = 'x'
  const guess = parseFountain(writing)
  return guess[caret].type === 'dialogue' ? guess : parsed
}

interface Script {
  lines: string[]
  parsed: FountainLine[]
  /** The line the caret was on when parsed. */
  caret: number
  decorations: DecorationSet
  /** The forcing marks hidden from view, which the caret steps over. */
  hidden: DecorationSet
}

const lineDecorations = Object.fromEntries(
  (
    [
      'title-page',
      'scene',
      'character',
      'parenthetical',
      'dialogue',
      'transition',
      'centered',
      'lyric',
      'section',
      'synopsis',
      'note',
      'page-break',
      'boneyard'
    ] satisfies FountainLineType[]
  ).map((type) => [type, Decoration.line({ class: `cm-fountain-${type}` })])
) as Partial<Record<FountainLineType, Decoration>>

const syntaxMark = Decoration.mark({ class: 'cm-fountain-mark' })
const hiddenMark = Decoration.replace({})
const commentMark = Decoration.mark({ class: 'cm-fountain-comment' })
const emphasis: Record<string, Decoration> = {
  '*': Decoration.mark({ class: 'cm-fountain-italic' }),
  '**': Decoration.mark({ class: 'cm-fountain-bold' }),
  '***': Decoration.mark({ class: 'cm-fountain-bold cm-fountain-italic' }),
  _: Decoration.mark({ class: 'cm-fountain-underline' })
}

const EMPHASIS = /(?<!\\)(\*{1,3}|_)(?=\S)(.+?)(?<=[^\s\\])\1/g
const COMMENT = /\[\[.*?\]\]|\/\*.*?\*\//g

function readScript(state: EditorState): Script {
  const lines: string[] = []
  for (const line of state.doc.iterLines()) lines.push(line)
  const caret = state.doc.lineAt(state.selection.main.head).number - 1
  const parsed = parseScript(lines, caret)
  const ranges: Range<Decoration>[] = []
  const hidden: Range<Decoration>[] = []
  let from = 0
  parsed.forEach((p, i) => {
    const text = lines[i]
    const line = lineDecorations[p.type]
    if (line) ranges.push(line.range(from))
    if (p.mark) {
      const mark = (HIDDEN_MARKS.includes(p.type) ? hiddenMark : syntaxMark).range(from, from + p.mark)
      ranges.push(mark)
      if (HIDDEN_MARKS.includes(p.type)) hidden.push(mark)
    }
    if (p.type === 'centered') ranges.push(syntaxMark.range(from + text.lastIndexOf('<'), from + text.lastIndexOf('<') + 1))
    if (p.type !== 'boneyard' && p.type !== 'note') {
      for (const m of text.matchAll(COMMENT)) ranges.push(commentMark.range(from + m.index, from + m.index + m[0].length))
      for (const m of text.matchAll(EMPHASIS)) {
        const start = from + m.index
        const end = start + m[0].length
        const marker = m[1].length
        ranges.push(
          emphasis[m[1]].range(start, end),
          syntaxMark.range(start, start + marker),
          syntaxMark.range(end - marker, end)
        )
      }
    }
    from += text.length + 1
  })
  return { lines, parsed, caret, decorations: Decoration.set(ranges, true), hidden: Decoration.set(hidden, true) }
}

/** Whether the caret's line changes how the script reads, by being an empty line where dialogue goes. */
function caretMatters(state: EditorState, number: number): boolean {
  const { doc } = state
  const line = doc.line(number)
  return (
    number > 1 &&
    !line.text.trim() &&
    Boolean(doc.line(number - 1).text.trim()) &&
    (number === doc.lines || !doc.line(number + 1).text.trim())
  )
}

const script = StateField.define<Script>({
  create: readScript,
  update(value, tr) {
    // Whether a line is a character cue depends on the lines around it, so reread the whole sheet.
    if (tr.docChanged) return readScript(tr.state)
    const caret = tr.state.doc.lineAt(tr.state.selection.main.head).number - 1
    if (caret === value.caret) return value
    const matters = caretMatters(tr.state, value.caret + 1) || caretMatters(tr.state, caret + 1)
    return matters ? readScript(tr.state) : { ...value, caret }
  },
  provide: (field) => [
    EditorView.decorations.from(field, (s) => s.decorations),
    EditorView.atomicRanges.of((view) => view.state.field(field).hidden)
  ]
})

/** Keep the caret after a hidden mark, not before it, so what you type lands in the line's text. */
const stepOverMarks = EditorState.transactionFilter.of((tr) => {
  if (!tr.selection && !tr.docChanged) return tr
  const { hidden } = tr.state.field(script)
  const selection = tr.state.selection
  let moved = false
  const ranges = selection.ranges.map((range) => {
    if (!range.empty) return range
    let to = -1
    hidden.between(range.head, range.head, (from, end) => {
      if (from === range.head) to = end
    })
    if (to < 0) return range
    moved = true
    return EditorSelection.cursor(to)
  })
  return moved ? [tr, { selection: EditorSelection.create(ranges, selection.mainIndex), sequential: true }] : tr
})

/** Left from just after a hidden mark goes on to the line before, as the mark takes up no room. */
const leftOverMark: Command = (view) => {
  const { selection } = view.state
  const head = selection.main.head
  if (!selection.main.empty || selection.ranges.length > 1) return false
  let from = -1
  view.state.field(script).hidden.between(head, head, (start, end) => {
    if (end === head) from = start
  })
  if (from <= 0) return false
  view.dispatch({ selection: EditorSelection.cursor(from - 1), scrollIntoView: true, userEvent: 'select' })
  return true
}

// ── Elements ────────────────────────────────────────────────────────────────

export interface CurrentElement {
  type: FountainLineType
  /** Whether the line follows a name or dialogue, so can be dialogue or a parenthetical. */
  speech: boolean
}

function inSpeech(s: Script, i: number): boolean {
  return i > 0 && !isBlank(s.lines[i - 1]) && SPEECH.includes(s.parsed[i - 1].type)
}

/** What the caret's line is, for the status bar and format bar; null outside a screenplay. */
export function currentElement(state: EditorState): CurrentElement | null {
  const s = state.field(script, false)
  if (!s) return null
  const i = state.doc.lineAt(state.selection.main.head).number - 1
  const { type } = s.parsed[i]
  return { type: type === 'blank' ? 'action' : type, speech: inSpeech(s, i) }
}

/** The words of a line, without the marks and brackets that make it its element. */
function bodyOf(text: string, { type, mark }: FountainLine): { start: number; body: string } {
  let start = mark
  let end = text.length
  while (start < end && /\s/.test(text[start])) start++
  while (end > start && /\s/.test(text[end - 1])) end--
  if (type === 'parenthetical' && text[start] === '(') {
    start++
    if (text[end - 1] === ')') end--
  }
  if (type === 'centered' && text[end - 1] === '<') end--
  return { start, body: text.slice(start, end).trim() }
}

/** Ways to write `body` as `element`, plainest first; the first that reads as it is used. */
function spellings(element: ScreenplayElement, body: string): string[] {
  const upper = body.toUpperCase()
  switch (element) {
    case 'scene':
      return [upper, `.${upper}`]
    case 'action':
      return [body, `!${body}`]
    case 'character':
      return [upper, `@${upper}`]
    case 'transition':
      return [upper, `>${upper}`]
    case 'parenthetical':
      return [`(${body})`]
    case 'dialogue':
      return [body]
  }
}

/** Turn the caret's line into `element`, keeping its words and the caret's place among them. */
function convert(state: EditorState, element: ScreenplayElement): TransactionSpec | null {
  const s = state.field(script, false)
  if (!s || state.readOnly) return null
  const head = state.selection.main.head
  const line = state.doc.lineAt(head)
  const i = line.number - 1
  const current = s.parsed[i]
  if (FIXED.includes(current.type)) return null
  const speech = inSpeech(s, i)
  const speaking = element === 'dialogue' || element === 'parenthetical'
  if (speaking && !speech) return null

  // Everything but action within a scene needs a blank line before it, and action can't follow a speech without one.
  const breakBefore = i > 0 && !isBlank(s.lines[i - 1]) && !speaking && (speech || element !== 'action') ? '\n' : ''
  const at = i + breakBefore.length
  const lines = s.lines.slice()
  if (breakBefore) lines.splice(i, 0, '')
  const reads = (text: string) => {
    lines[at] = text
    const { type } = parseScript(lines, at)[at]
    return type === element || (type === 'blank' && (element === 'action' || element === 'dialogue'))
  }
  const { start, body } = bodyOf(line.text, current)
  const options = spellings(element, body)
  const text = options.find(reads) ?? options.at(-1)!
  if (!breakBefore && text === line.text) return null
  const lead = element === 'parenthetical' ? 1 : text.length - body.length
  const offset = Math.max(0, Math.min(body.length, head - line.from - start))
  return {
    changes: { from: line.from, to: line.to, insert: breakBefore + text },
    selection: EditorSelection.cursor(line.from + breakBefore.length + lead + offset),
    scrollIntoView: true,
    userEvent: 'input.format'
  }
}

/** Make the caret's line a scene heading, action, a name and so on. */
export const setScreenplayElement =
  (element: ScreenplayElement): Command =>
  (view) => {
    const spec = convert(view.state, element)
    if (spec) view.dispatch(spec)
    return Boolean(spec) || currentElement(view.state)?.type === element
  }

/** Tab steps through the elements a line can be: within a speech, dialogue and parentheticals; otherwise the rest. */
const cycleElement =
  (step: 1 | -1): Command =>
  (view) => {
    const now = currentElement(view.state)
    if (!now) return false
    const order: ScreenplayElement[] = now.speech
      ? ['dialogue', 'parenthetical']
      : ['action', 'character', 'transition', 'scene']
    const at = order.indexOf(now.type as ScreenplayElement)
    // Sections, lyrics and the like aren't in the cycle; Tab indents them as usual.
    if (at < 0) return false
    return setScreenplayElement(order[(at + step + order.length) % order.length])(view)
  }

/** What Enter starts after each element, as screenwriting apps do. */
const FOLLOWS: Partial<Record<FountainLineType, string>> = {
  scene: '\n\n',
  action: '\n\n',
  character: '\n',
  parenthetical: '\n',
  dialogue: '\n\n',
  // A transition leads into the next scene.
  transition: '\n\n.'
}

/**
 * Enter at the end of a line moves on to the element that comes next: a name to its
 * dialogue, dialogue back to action, and so on. On an element with nothing written in
 * it yet, Enter takes the element away instead. Shift-Enter is a plain line break.
 */
const nextElement: Command = (view) => {
  const { state } = view
  const s = state.field(script, false)
  const { main } = state.selection
  if (!s || state.readOnly || !main.empty || state.selection.ranges.length > 1) return false
  const line = state.doc.lineAt(main.head)
  const i = line.number - 1
  // Mid-line, Enter just breaks the line. A closing bracket after the caret still counts as the end.
  if (!/^\)?\s*$/.test(line.text.slice(main.head - line.from))) return false
  let parsed = s.parsed[i]
  let text = line.text

  if (!bodyOf(text, parsed).body) {
    if (!text.trim() || !(HIDDEN_MARKS.includes(parsed.type) || parsed.type === 'parenthetical')) return false
    view.dispatch({
      changes: { from: line.from, to: line.to },
      selection: EditorSelection.cursor(line.from),
      userEvent: 'delete'
    })
    return true
  }

  // Close a parenthetical that was opened but not closed.
  if (parsed.type === 'dialogue' && text.trimStart().startsWith('(') && !text.includes(')')) {
    text = `${text.trimEnd()})`
    parsed = { type: 'parenthetical', mark: 0 }
  }
  let follows = FOLLOWS[parsed.type]
  // A name typed in capitals on its own line is a character, whose dialogue comes next.
  if (parsed.type === 'action' && !parsed.mark && isBlank(s.lines[i - 1]) && isCharacterCue(text)) follows = '\n'
  if (follows === undefined) return false

  // Drop a mark the line no longer needs now that what follows it is known.
  const added = follows.split('\n').slice(1)
  const lines = s.lines.slice()
  lines.splice(i, 1, text, ...added)
  const caret = i + added.length
  if (parsed.mark && HIDDEN_MARKS.includes(parsed.type) && parsed.type !== 'lyric') {
    const plain = text.slice(parsed.mark)
    lines[i] = plain
    if (parseScript(lines, caret)[i].type === parsed.type) text = plain
  }

  const insert = text + follows
  view.dispatch({
    changes: { from: line.from, to: line.to, insert },
    selection: EditorSelection.cursor(line.from + insert.length),
    scrollIntoView: true,
    userEvent: 'input'
  })
  return true
}

/** Scene headings, names and transitions are in capitals, so type them that way. */
const capitals = EditorView.inputHandler.of((view, from, to, text) => {
  const s = view.state.field(script, false)
  const line = view.state.doc.lineAt(from)
  if (!s || view.composing || to > line.to) return false
  const i = line.number - 1
  const { type } = s.parsed[i]
  const lower = /\p{Ll}/u
  if (type === 'scene' || type === 'character' || type === 'transition') {
    if (!lower.test(text)) return false
    const insert = text.toUpperCase()
    view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length }, userEvent: 'input.type' })
    return true
  }
  // Typing `int.` or `ext.` starts a scene heading; capitalise what's already there too.
  const before = line.text.slice(0, from - line.from) + text
  const typed = before + line.text.slice(to - line.from)
  if (
    (type === 'action' || type === 'blank') &&
    isBlank(s.lines[i - 1]) &&
    SCENE.test(typed.trimStart()) &&
    lower.test(typed)
  ) {
    view.dispatch({
      changes: { from: line.from, to: line.to, insert: typed.toUpperCase() },
      selection: { anchor: line.from + before.toUpperCase().length },
      userEvent: 'input.type'
    })
    return true
  }
  return false
})

const screenplayKeys = Prec.high(
  keymap.of([
    { key: 'Enter', run: nextElement },
    { key: 'Shift-Enter', run: insertNewline },
    { key: 'ArrowLeft', run: leftOverMark },
    { key: 'Tab', run: cycleElement(1), shift: cycleElement(-1) },
    ...SCREENPLAY_ELEMENTS.map(({ type, key }) => ({ key, run: setScreenplayElement(type) }))
  ])
)

/** Screenplays print in 12pt Courier, sixty characters to the line; indents follow the printed page. */
const screenplayTheme = EditorView.theme({
  // Outrank the base theme's font and measure.
  '&.cm-editor .cm-scroller': { fontFamily: 'var(--font-screenplay)' },
  '&.cm-editor .cm-content': { maxWidth: 'calc(60ch + 80px)' },
  '.cm-line.cm-fountain-scene': { fontWeight: '700', textTransform: 'uppercase' },
  '.cm-line.cm-fountain-character': { paddingLeft: '22ch' },
  '.cm-line.cm-fountain-parenthetical': { paddingLeft: '16ch', paddingRight: '19ch' },
  '.cm-line.cm-fountain-dialogue': { paddingLeft: '10ch', paddingRight: '15ch' },
  '.cm-line.cm-fountain-transition': { textAlign: 'right', textTransform: 'uppercase' },
  '.cm-line.cm-fountain-centered': { textAlign: 'center' },
  '.cm-line.cm-fountain-lyric': { fontStyle: 'italic' },
  '.cm-line.cm-fountain-section': { color: 'var(--text-soft)', fontWeight: '700' },
  '.cm-line.cm-fountain-synopsis': { color: 'var(--text-muted)', fontStyle: 'italic' },
  '.cm-line.cm-fountain-title-page': { color: 'var(--text-soft)' },
  '.cm-line.cm-fountain-note, .cm-line.cm-fountain-boneyard, .cm-line.cm-fountain-page-break, .cm-fountain-comment': {
    color: 'var(--text-muted)'
  },
  '.cm-fountain-mark': { color: 'var(--md-mark)' },
  '.cm-fountain-bold': { fontWeight: '700' },
  '.cm-fountain-italic': { fontStyle: 'italic' },
  '.cm-fountain-underline': { textDecoration: 'underline' }
})

export const fountain: Extension = [script, stepOverMarks, screenplayKeys, capitals, screenplayTheme]
