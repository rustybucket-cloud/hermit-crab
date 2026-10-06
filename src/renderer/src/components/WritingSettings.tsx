import { useState } from 'react'
import { clearIgnoredSuggestions, DIALECTS, type GrammarDialect } from '../editor/grammar'

export interface GrammarPrefs {
  grammar: boolean
  dialect: GrammarDialect
}

interface Props extends GrammarPrefs {
  onChange(patch: Partial<GrammarPrefs>): void
}

export function WritingSettings({ grammar, dialect, onChange }: Props) {
  const [cleared, setCleared] = useState(false)

  return (
    <section className="settings-section">
      <h2>Grammar</h2>
      <p className="settings-hint flush">
        Hermit Crab checks grammar, word choice and punctuation as you write, and underlines anything worth a second
        look. Hover over an underline to see suggestions. Checking happens entirely on this computer; nothing you write
        is sent anywhere.
      </p>

      <label className="toggle-row">
        <input type="checkbox" checked={grammar} onChange={(e) => onChange({ grammar: e.target.checked })} />
        <span>Check grammar while typing</span>
      </label>

      <div className="setting-rows">
        <label className="setting-row">
          <span>Dialect</span>
          <select
            className="select-field"
            value={dialect}
            disabled={!grammar}
            onChange={(e) => onChange({ dialect: e.target.value as GrammarDialect })}
          >
            {DIALECTS.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
        <div className="setting-row">
          <span>Suggestions you’ve ignored</span>
          <button
            className="ghost-button"
            disabled={cleared}
            onClick={() => {
              setCleared(true)
              clearIgnoredSuggestions()
            }}
          >
            {cleared ? 'Restored' : 'Restore All'}
          </button>
        </div>
      </div>
      <p className="settings-hint">
        Spelling is checked separately by your system’s dictionary. Right-click a misspelled word for suggestions.
      </p>
    </section>
  )
}
