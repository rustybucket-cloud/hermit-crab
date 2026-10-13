import { EditorSelection, EditorState, Prec } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { useEffect, useRef } from 'react'
import { cardExtensions } from '../editor/extensions'

interface Props {
  text: string
  /** What to select when editing starts. The caret goes to the end otherwise. */
  select?: { from: number; to: number }
  /** The new text, and the height the card needs to show all of it. */
  onChange(text: string, height: number): void
  /** Called when the editor loses focus, or Escape is pressed. */
  onDone(): void
}

/** A canvas card's text while it's being edited, with its Markdown styled as it's typed. */
export function CardEditor({ text, select, onChange, onDone }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const handlers = useRef({ onChange, onDone })

  useEffect(() => {
    handlers.current = { onChange, onDone }
  })

  useEffect(() => {
    // Removing the editor can blur it; by then editing has already finished.
    let open = true
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: text,
        selection: select ? EditorSelection.single(select.from, select.to) : EditorSelection.cursor(text.length),
        extensions: [
          cardExtensions(),
          Prec.highest(
            keymap.of([
              {
                key: 'Escape',
                run: (v) => {
                  v.contentDOM.blur()
                  return true
                }
              }
            ])
          ),
          EditorView.domEventHandlers({
            blur: () => {
              if (open) handlers.current.onDone()
            }
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              handlers.current.onChange(update.state.doc.toString(), update.view.scrollDOM.scrollHeight)
            }
          })
        ]
      })
    })
    view.focus()
    return () => {
      open = false
      view.destroy()
    }
    // The editor owns the text from here on; changes flow out through onChange.
  }, [])

  return <div className="canvas-card-editor" ref={host} />
}
