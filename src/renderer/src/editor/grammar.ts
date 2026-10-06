import { forceLinting, linter, lintKeymap, type Action, type Diagnostic } from '@codemirror/lint'
import { StateEffect, type Extension } from '@codemirror/state'
import { EditorView, keymap, ViewPlugin } from '@codemirror/view'
import type { Lint, Linter, Suggestion } from 'harper.js'

/**
 * Grammar checking with Harper, which runs entirely on this computer in a web worker.
 * Nothing you write is sent anywhere.
 */

export type GrammarDialect = 'American' | 'British' | 'Australian' | 'Canadian' | 'Indian'

export const DIALECTS: { id: GrammarDialect; label: string }[] = [
  { id: 'American', label: 'American English' },
  { id: 'British', label: 'British English' },
  { id: 'Australian', label: 'Australian English' },
  { id: 'Canadian', label: 'Canadian English' },
  { id: 'Indian', label: 'Indian English' }
]

/** A best guess from the system language, used until the user picks a dialect. */
export function defaultDialect(): GrammarDialect {
  const region = navigator.language.split('-')[1]?.toUpperCase()
  switch (region) {
    case 'GB': case 'IE': return 'British'
    case 'AU': case 'NZ': return 'Australian'
    case 'CA': return 'Canadian'
    case 'IN': return 'Indian'
    default: return 'American'
  }
}

/**
 * Rules switched off: Chromium's spellchecker already underlines misspellings (and can learn
 * words), and sentence-case headings are a style choice, not a mistake.
 */
const DISABLED_RULES = ['SpellCheck', 'UseTitleCase']

const IGNORED_KEY = 'hermit:grammar-ignored'

// ── The linter ──────────────────────────────────────────────────────────────

type Harper = typeof import('harper.js')

let loading: Promise<{ harper: Harper; linter: Linter }> | null = null
let configured: { dialect: GrammarDialect; ready: Promise<void> } | null = null

/** Load Harper on first use; its dictionary and rules are a sizeable download to compile. */
function load() {
  loading ??= (async () => {
    const [harper, { binary }] = await Promise.all([import('harper.js'), import('harper.js/binary')])
    return { harper, linter: new harper.WorkerLinter({ binary }) }
  })()
  return loading
}

async function configure({ harper, linter }: { harper: Harper; linter: Linter }, dialect: GrammarDialect) {
  await linter.setDialect(harper.Dialect[dialect])
  // Changing dialect resets the rules, so switch ours off again afterwards.
  const config = await linter.getLintConfig()
  for (const rule of DISABLED_RULES) config[rule] = false
  await linter.setLintConfig(config)
}

async function getLinter(dialect: GrammarDialect) {
  const loaded = await load()
  if (configured?.dialect !== dialect) configured = { dialect, ready: configure(loaded, dialect) }
  await configured.ready
  return loaded
}

// Open editors, so changes to the ignore list show up without waiting for the next keystroke.
const views = new Set<EditorView>()
const recheck = StateEffect.define<null>()

const recheckAll = () =>
  views.forEach((view) => {
    // forceLinting only hurries a pending run, so mark one as needed first.
    view.dispatch({ effects: recheck.of(null) })
    forceLinting(view)
  })

const trackView = ViewPlugin.define((view) => {
  views.add(view)
  return { destroy: () => views.delete(view) }
})

// ── Ignoring ────────────────────────────────────────────────────────────────

const ignored = new Set<string>(
  (() => {
    try {
      return JSON.parse(localStorage.getItem(IGNORED_KEY) ?? '[]')
    } catch {
      return []
    }
  })()
)

/**
 * An ignored issue is remembered by its rule, the flagged words and a little text either side, so it
 * stays ignored as the rest of the sheet changes. Only a hash is kept, not the text itself.
 */
function ignoreKey(source: string, lint: Lint): string {
  const { start, end } = lint.span()
  const key = `${lint.lint_kind()}\0${source.slice(Math.max(0, start - 24), end + 24)}`
  // cyrb53: a quick 53-bit string hash.
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 2654435761)
    h2 = Math.imul(h2 ^ c, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

function ignore(source: string, lint: Lint): void {
  ignored.add(ignoreKey(source, lint))
  localStorage.setItem(IGNORED_KEY, JSON.stringify([...ignored]))
  recheckAll()
}

/** Bring back every suggestion the user chose to ignore. */
export function clearIgnoredSuggestions(): void {
  ignored.clear()
  localStorage.removeItem(IGNORED_KEY)
  recheckAll()
}

// ── Diagnostics ─────────────────────────────────────────────────────────────

function suggestionAction(harper: Harper, suggestion: Suggestion): Action {
  const kind = suggestion.kind()
  const text = suggestion.get_replacement_text()
  const { Remove, InsertAfter } = harper.SuggestionKind
  return {
    name: kind === Remove ? 'Remove' : kind === InsertAfter ? `Add “${text}”` : text || 'Remove',
    apply(view, from, to) {
      const changes = kind === InsertAfter ? { from: to, insert: text } : { from, to, insert: kind === Remove ? '' : text }
      view.dispatch({ changes, userEvent: 'input.grammar' })
    }
  }
}

/** Harper's category names, made readable: "BoundaryError" → "Boundary error". */
const readableKind = (kind: string) => kind.replace(/(?<=[a-z])(?=[A-Z])/g, ' ').replace(/ [A-Z]/g, (m) => m.toLowerCase())

/** The rule's category, then its message with `quoted` words set in bold. */
function renderMessage(kind: string, message: string): Node {
  const root = document.createElement('div')
  const label = root.appendChild(document.createElement('div'))
  label.className = 'cm-grammarKind'
  label.textContent = kind
  const body = root.appendChild(document.createElement('div'))
  message.split('`').forEach((part, i) => {
    if (i % 2) body.appendChild(document.createElement('strong')).textContent = part
    else body.append(part)
  })
  return root
}

function toDiagnostic(harper: Harper, source: string, lint: Lint): Diagnostic {
  const { start, end } = lint.span()
  const kind = readableKind(lint.lint_kind())
  const message = lint.message()
  return {
    from: start,
    to: end,
    severity: 'info',
    message,
    renderMessage: () => renderMessage(kind, message),
    actions: [
      ...lint.suggestions().slice(0, 4).map((s) => suggestionAction(harper, s)),
      { name: 'Ignore', markClass: 'cm-diagnosticAction-ignore', apply: () => ignore(source, lint) }
    ]
  }
}

// ── Look ────────────────────────────────────────────────────────────────────

const grammarTheme = EditorView.theme({
  '.cm-lintRange-info': {
    backgroundImage: 'none',
    textDecoration: 'underline wavy color-mix(in srgb, var(--accent) 75%, transparent)',
    textDecorationThickness: '1px',
    textDecorationSkipInk: 'none',
    textUnderlineOffset: '4px'
  },
  '.cm-tooltip.cm-tooltip-hover, .cm-tooltip.cm-tooltip-lint': {
    backgroundColor: 'var(--bg-sheets)',
    color: 'var(--text)',
    border: '1px solid var(--border-strong)',
    borderRadius: '8px',
    boxShadow: '0 8px 24px rgba(0, 0, 0, 0.14)',
    overflow: 'hidden'
  },
  '.cm-tooltip-lint': { maxWidth: '340px' },
  '.cm-diagnostic, .cm-diagnostic-info': {
    fontFamily: 'var(--font-ui)',
    fontSize: '13px',
    lineHeight: '1.45',
    padding: '10px 12px',
    marginLeft: '0',
    border: 'none',
    whiteSpace: 'normal'
  },
  '.cm-diagnostic + .cm-diagnostic': { borderTop: '1px solid var(--border)' },
  '.cm-diagnosticText': { display: 'block', marginBottom: '8px', userSelect: 'text' },
  '.cm-grammarKind': {
    fontSize: '11px',
    fontWeight: '600',
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    color: 'var(--text-muted)',
    marginBottom: '3px'
  },
  '.cm-diagnosticAction': {
    font: 'inherit',
    fontWeight: '500',
    margin: '0 6px 4px 0',
    padding: '2px 9px',
    borderRadius: '5px',
    backgroundColor: 'var(--accent)',
    color: 'var(--accent-text)'
  },
  '.cm-diagnosticAction.cm-diagnosticAction-ignore': {
    backgroundColor: 'transparent',
    color: 'var(--text-soft)',
    boxShadow: 'inset 0 0 0 1px var(--border-strong)'
  },
  '.cm-diagnosticAction.cm-diagnosticAction-ignore:hover': { backgroundColor: 'var(--bg-hover)' },
  // Every issue in the sheet, opened with ⇧⌘M.
  '.cm-panel.cm-panel-lint': { fontFamily: 'var(--font-ui)' },
  '.cm-panel.cm-panel-lint ul': { maxHeight: '180px' },
  '.cm-panel.cm-panel-lint ul [aria-selected], .cm-panel.cm-panel-lint ul:focus [aria-selected]': {
    backgroundColor: 'var(--bg-active)',
    color: 'var(--text)'
  },
  '.cm-panel.cm-panel-lint [name=close]': { color: 'var(--text-muted)', fontSize: '16px', padding: '4px 8px' }
})

// ── Assembly ────────────────────────────────────────────────────────────────

export function grammarChecker(dialect: GrammarDialect): Extension {
  return [
    linter(
      async (view) => {
        const source = view.state.doc.toString()
        const { harper, linter } = await getLinter(dialect)
        const lints = await linter.lint(source, { language: 'markdown' })
        return (
          lints
            .filter((lint) => !ignored.has(ignoreKey(source, lint)))
            .map((lint) => toDiagnostic(harper, source, lint))
            // Spans are UTF-16 offsets, like CodeMirror's; drop any that don't fit rather than throw.
            .filter((d) => d.to <= source.length)
        )
      },
      { delay: 600, needsRefresh: (update) => update.transactions.some((tr) => tr.effects.some((e) => e.is(recheck))) }
    ),
    keymap.of(lintKeymap),
    trackView,
    grammarTheme
  ]
}
