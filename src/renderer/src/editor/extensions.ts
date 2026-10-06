import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search'
import { EditorSelection, EditorState, Prec, RangeSetBuilder, type Extension, type SelectionRange } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  drawSelection,
  EditorView,
  keymap,
  placeholder,
  ViewPlugin,
  type ViewUpdate,
  type Command
} from '@codemirror/view'
import { tags as t } from '@lezer/highlight'
import type { ContentFormat } from '../../../shared/types'
import { fountain } from './fountain'

// ── Look ────────────────────────────────────────────────────────────────────

/** Markdown syntax stays visible but recedes, so the prose is what you see. */
const markdownStyle = HighlightStyle.define([
  { tag: t.heading1, fontSize: '1.55em', fontWeight: '700', lineHeight: '1.3' },
  { tag: t.heading2, fontSize: '1.3em', fontWeight: '700', lineHeight: '1.35' },
  { tag: t.heading3, fontSize: '1.12em', fontWeight: '700' },
  { tag: [t.heading4, t.heading5, t.heading6], fontWeight: '700' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through', color: 'var(--text-muted)' },
  { tag: t.quote, color: 'var(--text-soft)', fontStyle: 'italic' },
  { tag: t.link, color: 'var(--accent)' },
  { tag: t.monospace, fontFamily: 'var(--font-mono)', fontSize: '0.88em', color: 'var(--code)' },
  { tag: [t.processingInstruction, t.contentSeparator, t.url, t.labelName, t.string], color: 'var(--md-mark)' },
  { tag: t.comment, color: 'var(--text-muted)', fontStyle: 'italic' },
  // Fenced code blocks with a language get light syntax colouring.
  { tag: [t.keyword, t.operatorKeyword, t.modifier], color: 'var(--syn-keyword)' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--syn-number)' },
  { tag: [t.function(t.variableName), t.definition(t.variableName), t.typeName, t.className], color: 'var(--syn-def)' }
])

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: 'var(--editor-size)', backgroundColor: 'transparent', color: 'var(--text)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--editor-font)', lineHeight: '1.7', overflowX: 'hidden' },
  '.cm-content': {
    maxWidth: 'var(--measure)',
    margin: '0 auto',
    padding: '48px 40px 40vh',
    caretColor: 'var(--accent)'
  },
  '.cm-line': { padding: '0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--selection) !important'
  },
  '.cm-placeholder': { color: 'var(--text-muted)', fontStyle: 'italic' },
  '.cm-dimmed': { opacity: '0.28', transition: 'opacity 160ms ease' },
  '.cm-searchMatch': { backgroundColor: 'var(--search-match)', borderRadius: '2px' },
  '.cm-searchMatch-selected': { backgroundColor: 'var(--search-match-active)' },
  '.cm-selectionMatch': { backgroundColor: 'var(--search-match)' },
  '.cm-panels': { backgroundColor: 'var(--bg-sheets)', color: 'var(--text)', borderColor: 'var(--border) !important' },
  '.cm-panels-bottom': { borderTop: '1px solid var(--border)' },
  '.cm-search': { fontFamily: 'var(--font-ui)', fontSize: '13px', padding: '8px 12px' },
  '.cm-search input, .cm-search button, .cm-search label': { fontSize: '12px' },
  '.cm-textfield': {
    border: '1px solid var(--border-strong)',
    borderRadius: '5px',
    background: 'var(--bg-editor)',
    color: 'var(--text)',
    padding: '3px 6px'
  },
  '.cm-button': {
    backgroundImage: 'none',
    background: 'var(--bg-hover)',
    border: '1px solid var(--border)',
    borderRadius: '5px',
    color: 'var(--text)'
  }
})

// ── Focus mode: dim everything but the current paragraph ───────────────────

const dimmed = Decoration.line({ class: 'cm-dimmed' })

function buildFocusDecorations(view: EditorView): DecorationSet {
  const { doc, selection } = view.state
  const current = doc.lineAt(selection.main.head).number
  let start = current
  let end = current
  if (doc.line(current).text.trim()) {
    while (start > 1 && doc.line(start - 1).text.trim()) start--
    while (end < doc.lines && doc.line(end + 1).text.trim()) end++
  }

  const builder = new RangeSetBuilder<Decoration>()
  let last = 0
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = doc.lineAt(pos)
      if (line.number > last && (line.number < start || line.number > end)) builder.add(line.from, line.from, dimmed)
      last = line.number
      pos = line.to + 1
    }
  }
  return builder.finish()
}

export const focusMode: Extension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = buildFocusDecorations(view)
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = buildFocusDecorations(update.view)
      }
    }
  },
  { decorations: (v) => v.decorations }
)

// ── Typewriter mode: keep the caret line vertically centred ─────────────────

export const typewriterMode: Extension = [
  EditorState.transactionExtender.of((tr) => {
    const typed = tr.isUserEvent('input') || tr.isUserEvent('delete') || tr.isUserEvent('undo') || tr.isUserEvent('redo')
    const moved = tr.isUserEvent('select') && !tr.isUserEvent('select.pointer')
    if (!typed && !moved) return null
    return { effects: EditorView.scrollIntoView(tr.newSelection.main.head, { y: 'center' }) }
  }),
  EditorView.theme({ '.cm-content': { paddingTop: '45vh', paddingBottom: '45vh' } })
]

// ── Formatting commands ─────────────────────────────────────────────────────

/** Wrap the selection (or the word under the caret) in `marker`, or unwrap it if already wrapped. */
export const toggleWrap =
  (marker: string): Command =>
  (view) => {
    const { state } = view
    const len = marker.length
    const tr = state.changeByRange((original) => {
      let range: SelectionRange = original
      if (range.empty) range = state.wordAt(range.head) ?? range

      const before = state.sliceDoc(range.from - len, range.from)
      const after = state.sliceDoc(range.to, range.to + len)
      if (before === marker && after === marker) {
        return {
          changes: [
            { from: range.from - len, to: range.from },
            { from: range.to, to: range.to + len }
          ],
          range: EditorSelection.range(range.from - len, range.to - len)
        }
      }

      const inner = state.sliceDoc(range.from, range.to)
      if (inner.length >= len * 2 && inner.startsWith(marker) && inner.endsWith(marker)) {
        return {
          changes: [
            { from: range.from, to: range.from + len },
            { from: range.to - len, to: range.to }
          ],
          range: EditorSelection.range(range.from, range.to - len * 2)
        }
      }

      return {
        changes: [
          { from: range.from, insert: marker },
          { from: range.to, insert: marker }
        ],
        range: EditorSelection.range(range.from + len, range.to + len)
      }
    })
    view.dispatch(state.update(tr, { scrollIntoView: true, userEvent: 'input.format' }))
    return true
  }

export const insertLink: Command = (view) => {
  const { state } = view
  const tr = state.changeByRange((range) => {
    const text = state.sliceDoc(range.from, range.to)
    if (/^https?:\/\/\S+$/.test(text)) {
      return {
        changes: { from: range.from, to: range.to, insert: `[](${text})` },
        range: EditorSelection.cursor(range.from + 1)
      }
    }
    const insert = `[${text}]()`
    const cursor = range.from + insert.length - 1
    return {
      changes: { from: range.from, to: range.to, insert },
      range: text ? EditorSelection.cursor(cursor) : EditorSelection.cursor(range.from + 1)
    }
  })
  view.dispatch(state.update(tr, { scrollIntoView: true, userEvent: 'input.format' }))
  return true
}

/** Apply `transform` to the text of every line touched by the selection. */
function mapSelectedLines(view: EditorView, transform: (text: string, lines: string[]) => string): boolean {
  const { state } = view
  const seen = new Set<number>()
  const changes: { from: number; to: number; insert: string }[] = []
  const lines = []
  for (const range of state.selection.ranges) {
    for (let n = state.doc.lineAt(range.from).number; n <= state.doc.lineAt(range.to).number; n++) {
      if (!seen.has(n)) {
        seen.add(n)
        lines.push(state.doc.line(n))
      }
    }
  }
  const texts = lines.map((l) => l.text)
  for (const line of lines) {
    const insert = transform(line.text, texts)
    if (insert !== line.text) changes.push({ from: line.from, to: line.to, insert })
  }
  if (changes.length) view.dispatch({ changes, scrollIntoView: true, userEvent: 'input.format' })
  return true
}

/** Cycle the current line through paragraph → # → ## → ### → paragraph. */
export const cycleHeading: Command = (view) =>
  mapSelectedLines(view, (text) => {
    const level = /^(#{1,6})\s/.exec(text)?.[1].length ?? 0
    const body = text.replace(/^#{1,6}\s+/, '')
    return level >= 3 ? body : `${'#'.repeat(level + 1)} ${body}`
  })

export const toggleQuote: Command = (view) =>
  mapSelectedLines(view, (text, all) => {
    const allQuoted = all.every((l) => !l.trim() || /^\s*>/.test(l))
    return allQuoted ? text.replace(/^(\s*)>\s?/, '$1') : `> ${text}`
  })

export type FormatCommand = 'bold' | 'italic' | 'underline' | 'code' | 'link' | 'heading' | 'quote'

/** What each format offers. Fountain has emphasis but no code, links, headings or quotes. */
export const formatCommands: Record<ContentFormat, Partial<Record<FormatCommand, Command>>> = {
  markdown: {
    bold: toggleWrap('**'),
    italic: toggleWrap('_'),
    code: toggleWrap('`'),
    link: insertLink,
    heading: cycleHeading,
    quote: toggleQuote
  },
  fountain: {
    bold: toggleWrap('**'),
    italic: toggleWrap('*'),
    underline: toggleWrap('_')
  }
}

const FORMAT_KEYS: Record<FormatCommand, string> = {
  bold: 'Mod-b',
  italic: 'Mod-i',
  underline: 'Mod-u',
  code: 'Mod-e',
  link: 'Mod-k',
  heading: 'Mod-Alt-h',
  quote: "Mod-Alt-'"
}

// ── Assembly ────────────────────────────────────────────────────────────────

/** Styling and formatting keys for the sheet's format. Swapped in place if a project changes format. */
export function formatExtensions(format: ContentFormat): Extension[] {
  const commands = Object.entries(formatCommands[format]) as [FormatCommand, Command][]
  return [
    format === 'fountain'
      ? fountain
      : [markdown({ base: markdownLanguage, codeLanguages: languages }), syntaxHighlighting(markdownStyle)],
    Prec.high(keymap.of(commands.map(([name, run]) => ({ key: FORMAT_KEYS[name], run }))))
  ]
}

export function baseExtensions(): Extension[] {
  return [
    history(),
    drawSelection(),
    EditorView.lineWrapping,
    EditorState.allowMultipleSelections.of(true),
    EditorView.contentAttributes.of({ spellcheck: 'true', autocorrect: 'on', autocapitalize: 'sentences' }),
    search({ top: false }),
    highlightSelectionMatches(),
    placeholder('Start writing…'),
    theme,
    keymap.of([
      ...searchKeymap,
      ...historyKeymap,
      ...defaultKeymap,
      indentWithTab
    ])
  ]
}

/**
 * For the merge editor's result pane: the same look without Markdown styling,
 * since conflict markers would otherwise parse as setext headings and quotes.
 */
export function plainExtensions(): Extension[] {
  return [
    history(),
    drawSelection(),
    EditorView.lineWrapping,
    EditorView.contentAttributes.of({ spellcheck: 'true' }),
    search({ top: false }),
    theme,
    keymap.of([...searchKeymap, ...historyKeymap, ...defaultKeymap, indentWithTab])
  ]
}
