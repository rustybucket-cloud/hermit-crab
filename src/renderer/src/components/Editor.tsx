import { openSearchPanel } from '@codemirror/search'
import { Compartment, EditorSelection, EditorState, Transaction, type Text } from '@codemirror/state'
import { EditorView, type Command } from '@codemirror/view'
import { useEffect, useImperativeHandle, useRef, type Ref } from 'react'
import { baseExtensions, focusMode, typewriterMode } from '../editor/extensions'

export interface EditorHandle {
  focus(): void
  run(command: Command): void
  openSearch(): void
  /** Swap in new text (e.g. pulled from GitHub) without moving the caret more than needed. */
  replaceContent(text: string): void
}

interface Props {
  /** Changes whenever a different sheet is loaded. */
  docKey: string
  content: string
  focus: boolean
  typewriter: boolean
  /** Font settings — passed so the editor can re-measure when they change. */
  fontKey: string
  hidden?: boolean
  readOnly?: boolean
  onChange(doc: Text): void
  ref?: Ref<EditorHandle>
}

/** Caret and scroll position per sheet, so switching back lands where you left off. */
const positions = new Map<string, { anchor: number; head: number; scrollTop: number }>()

export function Editor({ docKey, content, focus, typewriter, fontKey, hidden, readOnly = false, onChange, ref }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const loadedKey = useRef<string | null>(null)
  const onChangeRef = useRef(onChange)
  const focusSlot = useRef(new Compartment())
  const typewriterSlot = useRef(new Compartment())
  const readOnlySlot = useRef(new Compartment())
  const modes = useRef({ focus, typewriter, readOnly })

  useEffect(() => {
    onChangeRef.current = onChange
    modes.current = { focus, typewriter, readOnly }
  })

  useImperativeHandle(ref, () => ({
    focus: () => view.current?.focus(),
    run: (command) => {
      if (view.current) command(view.current)
    },
    openSearch: () => {
      if (view.current) openSearchPanel(view.current)
    },
    replaceContent: (text) => {
      const v = view.current
      if (!v) return
      // Replace only the span that differs, so the selection maps through naturally.
      const old = v.state.doc.toString()
      let start = 0
      while (start < old.length && start < text.length && old[start] === text[start]) start++
      let endOld = old.length
      let endNew = text.length
      while (endOld > start && endNew > start && old[endOld - 1] === text[endNew - 1]) {
        endOld--
        endNew--
      }
      if (start === endOld && start === endNew) return
      v.dispatch({
        changes: { from: start, to: endOld, insert: text.slice(start, endNew) },
        annotations: [Transaction.remote.of(true), Transaction.addToHistory.of(false)]
      })
    }
  }))

  // Load a sheet: a fresh EditorState per sheet keeps undo history separate.
  useEffect(() => {
    if (loadedKey.current === docKey) return
    const previous = loadedKey.current
    if (previous && view.current) {
      const { anchor, head } = view.current.state.selection.main
      positions.set(previous, { anchor, head, scrollTop: view.current.scrollDOM.scrollTop })
    }
    loadedKey.current = docKey

    const state = EditorState.create({
      doc: content,
      extensions: [
        baseExtensions(),
        focusSlot.current.of(modes.current.focus ? focusMode : []),
        typewriterSlot.current.of(modes.current.typewriter ? typewriterMode : []),
        readOnlySlot.current.of(EditorState.readOnly.of(modes.current.readOnly)),
        EditorView.updateListener.of((update) => {
          // Remote changes are already on disk; don't save them back.
          const local = update.transactions.some((tr) => tr.docChanged && !tr.annotation(Transaction.remote))
          if (local) onChangeRef.current(update.state.doc)
        })
      ]
    })

    if (!view.current) view.current = new EditorView({ state, parent: host.current! })
    else view.current.setState(state)

    const v = view.current
    const saved = positions.get(docKey)
    const length = v.state.doc.length
    v.dispatch({
      selection: saved
        ? EditorSelection.single(Math.min(saved.anchor, length), Math.min(saved.head, length))
        : EditorSelection.cursor(0)
    })
    requestAnimationFrame(() => {
      v.scrollDOM.scrollTop = saved?.scrollTop ?? 0
      if (!saved) v.dispatch({ effects: EditorView.scrollIntoView(v.state.selection.main.head, { yMargin: 80 }) })
      v.focus()
    })
  }, [docKey, content])

  useEffect(() => {
    view.current?.dispatch({ effects: focusSlot.current.reconfigure(focus ? focusMode : []) })
  }, [focus])

  useEffect(() => {
    const v = view.current
    if (!v) return
    v.dispatch({
      effects: [
        typewriterSlot.current.reconfigure(typewriter ? typewriterMode : []),
        ...(typewriter ? [EditorView.scrollIntoView(v.state.selection.main.head, { y: 'center' })] : [])
      ]
    })
  }, [typewriter])

  useEffect(() => {
    view.current?.dispatch({ effects: readOnlySlot.current.reconfigure(EditorState.readOnly.of(readOnly)) })
  }, [readOnly])

  useEffect(() => {
    view.current?.requestMeasure()
  }, [fontKey, hidden])

  useEffect(() => () => view.current?.destroy(), [])

  return <div className="editor-host" ref={host} hidden={hidden} />
}
