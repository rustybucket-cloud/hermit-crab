import { RangeSetBuilder, type Extension } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import { parseConflicts } from '../../../shared/conflicts'

// Tints the two sides of each conflict block so they're easy to tell apart in the merge editor.

const marker = Decoration.line({ class: 'cm-conflict-marker' })
const ours = Decoration.line({ class: 'cm-conflict-ours' })
const base = Decoration.line({ class: 'cm-conflict-base' })
const theirs = Decoration.line({ class: 'cm-conflict-theirs' })

function build(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const doc = view.state.doc
  for (const hunk of parseConflicts(doc.toString())) {
    let part: 'ours' | 'base' | 'theirs' = 'ours'
    for (let pos = hunk.from; pos < hunk.to && pos <= doc.length; ) {
      const line = doc.lineAt(pos)
      let deco = part === 'ours' ? ours : part === 'base' ? base : theirs
      if (line.text.startsWith('<<<<<<<') || (part === 'theirs' && line.text.startsWith('>>>>>>>'))) {
        deco = marker
      } else if (part === 'ours' && line.text.startsWith('|||||||')) {
        part = 'base'
        deco = marker
      } else if (part !== 'theirs' && line.text === '=======') {
        part = 'theirs'
        deco = marker
      }
      builder.add(line.from, line.from, deco)
      pos = line.to + 1
    }
  }
  return builder.finish()
}

export const conflictHighlight: Extension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = build(view)
    }
    update(update: ViewUpdate) {
      if (update.docChanged) this.decorations = build(update.view)
    }
  },
  { decorations: (v) => v.decorations }
)
