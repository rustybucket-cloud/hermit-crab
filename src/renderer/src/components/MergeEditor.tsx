import { Compartment, EditorState, Transaction } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { parseConflicts, resolveHunk, type ConflictHunk, type HunkChoice } from '../../../shared/conflicts'
import type { ConflictFile, SyncState } from '../../../shared/types'
import { conflictHighlight } from '../editor/conflicts'
import { plainExtensions } from '../editor/extensions'
import { CloseIcon } from './Icons'

const hermit = window.hermit

const AGENT_NAMES = { claude: 'Claude Code', codex: 'Codex' } as const

interface Props {
  sync: SyncState
  onClose(): void
}

/**
 * Lists every file that changed both here and on GitHub. For each conflict the
 * writer picks a side (or both), or edits the result directly; a local coding
 * agent can take a first pass at all of them.
 */
export function MergeEditor({ sync, onClose }: Props) {
  const [files, setFiles] = useState<ConflictFile[]>([])
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [selected, setSelected] = useState<string | null>(null)
  const [log, setLog] = useState('')
  const [showLog, setShowLog] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dialog = useRef<HTMLDivElement>(null)

  const agentName = AGENT_NAMES[sync.settings.agent]
  const agentInstalled = sync.agents[sync.settings.agent]
  const resolving = sync.status === 'resolving'
  const isResolved = (path: string) => !sync.conflicts.includes(path)

  /** Read conflicted files from disk. Files resolved earlier stay listed, marked as done. */
  const load = useCallback(async () => {
    const list = await hermit.listConflicts()
    setFiles((prev) => {
      const byPath = new Map(prev.map((f) => [f.path, f]))
      for (const f of list) byPath.set(f.path, f)
      return [...byPath.values()]
    })
    setDrafts((prev) => ({ ...prev, ...Object.fromEntries(list.map((f) => [f.path, f.content])) }))
    setSelected((sel) => sel ?? list[0]?.path ?? null)
  }, [])

  useEffect(() => {
    dialog.current?.focus()
    void load()
  }, [load])

  // When the agent finishes, show what it wrote.
  const lastStatus = useRef(sync.status)
  useEffect(() => {
    if (lastStatus.current === 'resolving' && sync.status !== 'resolving') void load()
    lastStatus.current = sync.status
  }, [sync.status, load])

  useEffect(() => hermit.onAgentOutput((chunk) => setLog((l) => (l + chunk).slice(-50_000))), [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const file = files.find((f) => f.path === selected) ?? null
  const draft = file ? (drafts[file.path] ?? '') : ''
  const hunks = useMemo(() => parseConflicts(draft), [draft])
  const remaining = files.filter((f) => !isResolved(f.path)).length

  /** Run an IPC call, showing its error in the footer. Resolves with undefined on failure. */
  const run = async <T,>(work: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true)
    setError(null)
    try {
      return await work()
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err).replace(/^.*?Error: /, ''))
      return undefined
    } finally {
      setBusy(false)
    }
  }

  const setDraft = (text: string) => file && setDrafts((d) => ({ ...d, [file.path]: text }))
  const choose = (hunk: ConflictHunk, choice: HunkChoice) => setDraft(resolveHunk(draft, hunk, choice))

  const markResolved = async (content: string | null) => {
    if (!file) return
    const state = await run(() => hermit.resolveConflict(file.path, content))
    if (state) setSelected(files.find((f) => state.conflicts.includes(f.path))?.path ?? file.path)
  }

  const askAgent = async () => {
    setLog('')
    setShowLog(true)
    await run(() => hermit.resolveWithAgent())
  }

  const finish = async () => {
    if (await run(() => hermit.finishMerge())) onClose()
  }

  return (
    <div className="settings-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="merge" role="dialog" aria-label="Resolve Sync Conflicts" tabIndex={-1} ref={dialog}>
        <header className="settings-header">
          <h1>Resolve Sync Conflicts</h1>
          <div className="merge-header-actions">
            {resolving ? (
              <button className="ghost-button" onClick={() => void hermit.cancelAgent()}>
                Stop {agentName}
              </button>
            ) : (
              <button
                className="ghost-button"
                disabled={!agentInstalled || busy || remaining === 0}
                title={agentInstalled ? `Let ${agentName} merge the conflicts; you review the result` : `${agentName} isn’t installed`}
                onClick={() => void askAgent()}
              >
                Resolve with {agentName}
              </button>
            )}
            {log && (
              <button className="ghost-button" onClick={() => setShowLog((s) => !s)}>
                {showLog ? 'Hide Log' : 'Show Log'}
              </button>
            )}
            <button className="icon-button" onClick={onClose} title="Close (Esc)">
              <CloseIcon />
            </button>
          </div>
        </header>

        <div className="merge-body">
          <aside className="merge-files">
            {files.map((f) => (
              <button
                key={f.path}
                className={`merge-file${f.path === selected ? ' selected' : ''}${isResolved(f.path) ? ' resolved' : ''}`}
                onClick={() => setSelected(f.path)}
                title={f.path}
              >
                <span className="merge-file-state">{isResolved(f.path) ? '✓' : '●'}</span>
                <span className="merge-file-label">{f.label}</span>
              </button>
            ))}
          </aside>

          <section className="merge-main">
            {resolving && (
              <div className="merge-banner">{agentName} is working through the conflicts. You can review each file when it’s done.</div>
            )}
            {!file ? (
              <div className="merge-empty">{files.length ? 'Choose a file.' : 'Loading…'}</div>
            ) : isResolved(file.path) ? (
              <div className="merge-empty">
                Resolved. It will be synced when you finish the merge.
              </div>
            ) : file.ours === null || file.theirs === null ? (
              <div className="merge-deleted">
                <p>
                  {file.ours === null
                    ? 'You deleted this sheet here, but it was edited on GitHub.'
                    : 'This sheet was deleted on GitHub, but you edited it here.'}
                </p>
                <pre className="merge-preview">{file.ours ?? file.theirs}</pre>
                <div className="merge-deleted-actions">
                  <button className="primary-button" disabled={busy || resolving} onClick={() => void markResolved(file.ours ?? file.theirs)}>
                    Keep the Sheet
                  </button>
                  <button className="ghost-button" disabled={busy || resolving} onClick={() => void markResolved(null)}>
                    Delete It
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div className="merge-toolbar">
                  <span className="merge-count">
                    {hunks.length ? `${hunks.length} ${hunks.length === 1 ? 'conflict' : 'conflicts'}` : 'No conflicts left'}
                  </span>
                  <div className="toolbar-spacer" />
                  <button className="ghost-button" disabled={resolving} onClick={() => setDraft(file.ours ?? '')}>
                    Keep All Mine
                  </button>
                  <button className="ghost-button" disabled={resolving} onClick={() => setDraft(file.theirs ?? '')}>
                    Take All from GitHub
                  </button>
                  <button className="ghost-button" disabled={resolving || draft === file.content} onClick={() => setDraft(file.content)}>
                    Start Over
                  </button>
                </div>
                <div className="merge-panes">
                  {hunks.length > 0 && (
                    <div className="merge-hunks">
                      {hunks.map((hunk, i) => (
                        <div className="hunk" key={`${i}:${hunk.from}`}>
                          <div className="hunk-title">Conflict {i + 1}</div>
                          <div className="hunk-sides">
                            <HunkSide label="This computer" side="ours" text={hunk.ours} onUse={() => choose(hunk, 'ours')} disabled={resolving} />
                            <HunkSide label="GitHub" side="theirs" text={hunk.theirs} onUse={() => choose(hunk, 'theirs')} disabled={resolving} />
                          </div>
                          <button className="ghost-button" disabled={resolving} onClick={() => choose(hunk, 'both')}>
                            Use Both
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="merge-result">
                    <div className="merge-result-label">Result · edit freely</div>
                    <ResultEditor key={file.path} value={draft} readOnly={resolving} onChange={setDraft} />
                  </div>
                </div>
              </>
            )}
          </section>
        </div>

        {showLog && <pre className="agent-log">{log || 'Starting…'}</pre>}

        <footer className="merge-footer">
          <span className={error ? 'settings-error' : 'merge-footer-note'}>
            {error ?? (remaining ? `${remaining} of ${files.length} ${files.length === 1 ? 'file needs' : 'files need'} attention` : 'All conflicts resolved.')}
          </span>
          <div className="toolbar-spacer" />
          {file && !isResolved(file.path) && file.ours !== null && file.theirs !== null && (
            <button
              className="ghost-button"
              disabled={busy || resolving || hunks.length > 0}
              title={hunks.length ? 'Resolve every conflict first' : undefined}
              onClick={() => void markResolved(draft)}
            >
              Mark as Resolved
            </button>
          )}
          <button className="primary-button" disabled={busy || resolving || sync.conflicts.length > 0} onClick={() => void finish()}>
            Finish Merge &amp; Sync
          </button>
        </footer>
      </div>
    </div>
  )
}

function HunkSide(props: { label: string; side: 'ours' | 'theirs'; text: string; disabled: boolean; onUse(): void }) {
  return (
    <div className={`hunk-side ${props.side}`}>
      <div className="hunk-label">{props.label}</div>
      <pre className="hunk-text">{props.text || <em>Nothing here</em>}</pre>
      <button className="ghost-button" disabled={props.disabled} onClick={props.onUse}>
        Use This
      </button>
    </div>
  )
}

/** The merged file, editable. Conflict blocks are tinted until they're gone. */
function ResultEditor({ value, readOnly, onChange }: { value: string; readOnly: boolean; onChange(text: string): void }) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  const initial = useRef({ value, readOnly })
  const editable = useRef(new Compartment())

  useEffect(() => {
    onChangeRef.current = onChange
  })

  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: initial.current.value,
        extensions: [
          plainExtensions(),
          conflictHighlight,
          editable.current.of(EditorView.editable.of(!initial.current.readOnly)),
          EditorView.updateListener.of((update) => {
            const local = update.transactions.some((tr) => tr.docChanged && !tr.annotation(Transaction.remote))
            if (local) onChangeRef.current(update.state.doc.toString())
          })
        ]
      })
    })
    view.current = v
    return () => v.destroy()
  }, [])

  // Choices made with the buttons arrive as a new value; they're still undoable here.
  useEffect(() => {
    const v = view.current
    if (v && v.state.doc.toString() !== value) {
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value }, annotations: Transaction.remote.of(true) })
    }
  }, [value])

  useEffect(() => {
    view.current?.dispatch({ effects: editable.current.reconfigure(EditorView.editable.of(!readOnly)) })
  }, [readOnly])

  return <div className="merge-result-editor" ref={host} />
}
