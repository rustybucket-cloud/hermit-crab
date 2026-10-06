import { StateField, type EditorState, type Extension, type Range } from '@codemirror/state'
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view'
import { parseFountain, type FountainLineType } from '../../../shared/fountain'

// Screenplays are written in Fountain. Each line is styled as the element it is,
// indented the way it will print, while every character stays as typed.

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
const commentMark = Decoration.mark({ class: 'cm-fountain-comment' })
const emphasis: Record<string, Decoration> = {
  '*': Decoration.mark({ class: 'cm-fountain-italic' }),
  '**': Decoration.mark({ class: 'cm-fountain-bold' }),
  '***': Decoration.mark({ class: 'cm-fountain-bold cm-fountain-italic' }),
  _: Decoration.mark({ class: 'cm-fountain-underline' })
}

const EMPHASIS = /(?<!\\)(\*{1,3}|_)(?=\S)(.+?)(?<=[^\s\\])\1/g
const COMMENT = /\[\[.*?\]\]|\/\*.*?\*\//g

function buildDecorations(state: EditorState): DecorationSet {
  const lines: string[] = []
  for (const line of state.doc.iterLines()) lines.push(line)
  const ranges: Range<Decoration>[] = []
  let from = 0
  parseFountain(lines).forEach((parsed, i) => {
    const text = lines[i]
    const line = lineDecorations[parsed.type]
    if (line) ranges.push(line.range(from))
    if (parsed.mark) ranges.push(syntaxMark.range(from, from + parsed.mark))
    if (parsed.type === 'centered') ranges.push(syntaxMark.range(from + text.lastIndexOf('<'), from + text.lastIndexOf('<') + 1))
    if (parsed.type !== 'boneyard' && parsed.type !== 'note') {
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
  return Decoration.set(ranges, true)
}

const fountainDecorations = StateField.define<DecorationSet>({
  create: buildDecorations,
  // Whether a line is a character cue depends on the lines around it, so restyle the whole sheet.
  update: (decorations, tr) => (tr.docChanged ? buildDecorations(tr.state) : decorations),
  provide: (field) => EditorView.decorations.from(field)
})

/** Screenplays print in 12pt Courier, sixty characters to the line; indents follow the printed page. */
const screenplayTheme = EditorView.theme({
  // Outrank the base theme's font and measure.
  '&.cm-editor .cm-scroller': { fontFamily: 'var(--font-screenplay)' },
  '&.cm-editor .cm-content': { maxWidth: 'calc(60ch + 80px)' },
  '.cm-line.cm-fountain-scene': { fontWeight: '700' },
  '.cm-line.cm-fountain-character': { paddingLeft: '22ch' },
  '.cm-line.cm-fountain-parenthetical': { paddingLeft: '16ch', paddingRight: '19ch' },
  '.cm-line.cm-fountain-dialogue': { paddingLeft: '10ch', paddingRight: '15ch' },
  '.cm-line.cm-fountain-transition': { textAlign: 'right' },
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

export const fountain: Extension = [fountainDecorations, screenplayTheme]
