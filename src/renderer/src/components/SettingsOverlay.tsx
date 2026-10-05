import { useEffect, useRef, useState } from 'react'
import {
  normalizeHex,
  PALETTE,
  PRESETS,
  resolveColors,
  SLOTS,
  useSystemDark,
  type ColorSlot,
  type PresetId,
  type ThemeColors,
  type ThemeId,
  type ThemeSettings
} from '../theme'
import { CloseIcon, PlusIcon } from './Icons'

const hermit = window.hermit

interface Props {
  theme: ThemeSettings
  onChange(theme: ThemeSettings): void
  onClose(): void
}

export function SettingsOverlay({ theme, onChange, onClose }: Props) {
  const systemDark = useSystemDark()
  const colors = resolveColors(theme, systemDark)
  const [editing, setEditing] = useState<ColorSlot | null>(null)
  const dialog = useRef<HTMLDivElement>(null)

  useEffect(() => dialog.current?.focus(), [])

  // Listen on the window: closing the picker can drop focus to <body>, outside the dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      if (editing) setEditing(null)
      else onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [editing, onClose])

  // Changing any colour turns the current theme into the user's custom theme.
  const setColor = (slot: ColorSlot, value: string) =>
    onChange({ ...theme, id: 'custom', custom: { ...colors, [slot]: value } })

  const addSwatch = (hex: string) =>
    !theme.swatches.includes(hex) && onChange({ ...theme, swatches: [...theme.swatches, hex] })

  const removeSwatch = async (hex: string) => {
    const choice = await hermit.showContextMenu([{ id: 'remove', label: 'Remove Colour' }])
    if (choice === 'remove') onChange({ ...theme, swatches: theme.swatches.filter((s) => s !== hex) })
  }

  const cards: { id: ThemeId; name: string; colors: ThemeColors | [ThemeColors, ThemeColors] }[] = [
    { id: 'system', name: 'System', colors: [PRESETS.light.colors, PRESETS.dark.colors] },
    ...(Object.keys(PRESETS) as PresetId[]).map((id) => ({ id, name: PRESETS[id].name, colors: PRESETS[id].colors })),
    { id: 'custom', name: 'Custom', colors: theme.custom }
  ]

  return (
    <div
      className="settings-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="settings" role="dialog" aria-label="Settings" tabIndex={-1} ref={dialog}>
        <header className="settings-header">
          <h1>Settings</h1>
          <button className="icon-button" onClick={onClose} title="Close (Esc)">
            <CloseIcon />
          </button>
        </header>

        <div className="settings-body">
          <section className="settings-section">
            <h2>Theme</h2>
            <div className="theme-grid">
              {cards.map((card) => (
                <button
                  key={card.id}
                  className={`theme-card${theme.id === card.id ? ' selected' : ''}`}
                  onClick={() => onChange({ ...theme, id: card.id })}
                >
                  {Array.isArray(card.colors) ? (
                    <span className="theme-thumb split">
                      <ThemeThumb colors={card.colors[0]} />
                      <ThemeThumb colors={card.colors[1]} />
                    </span>
                  ) : (
                    <span className="theme-thumb">
                      <ThemeThumb colors={card.colors} />
                    </span>
                  )}
                  <span className="theme-name">{card.name}</span>
                </button>
              ))}
            </div>
            <p className="settings-hint">
              {theme.id === 'system'
                ? `Following your system’s ${systemDark ? 'dark' : 'light'} appearance. Change any colour below to make it your own.`
                : theme.id === 'custom'
                  ? 'Your custom theme. Pick colours from the palette, or add your own.'
                  : `Change any colour below to start a custom theme from ${PRESETS[theme.id].name}.`}
            </p>
          </section>

          {SLOTS.map(({ group, slots }) => (
            <section className="settings-section" key={group}>
              <h3>{group}</h3>
              <div className="color-rows">
                {slots.map(({ key, label }) => (
                  <div key={key} className={`color-row${editing === key ? ' open' : ''}`}>
                    <button className="color-row-button" onClick={() => setEditing(editing === key ? null : key)}>
                      <span className="swatch" style={{ background: colors[key] }} />
                      <span className="color-label">{label}</span>
                      <span className="color-hex">{colors[key]}</span>
                    </button>
                    {editing === key && (
                      <ColorPicker
                        value={colors[key]}
                        swatches={theme.swatches}
                        onPick={(hex) => setColor(key, hex)}
                        onAddSwatch={addSwatch}
                        onRemoveSwatch={(hex) => void removeSwatch(hex)}
                      />
                    )}
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}

/** A miniature of the three panes with a few lines of "text". */
function ThemeThumb({ colors: c }: { colors: ThemeColors }) {
  return (
    <span className="thumb">
      <span className="thumb-library" style={{ background: c.library }}>
        <i style={{ background: c.accent }} />
      </span>
      <span className="thumb-sheets" style={{ background: c.sheets }}>
        <i style={{ background: c.textSoft }} />
        <i style={{ background: c.textMuted }} />
      </span>
      <span className="thumb-editor" style={{ background: c.editor }}>
        <i style={{ background: c.text }} />
        <i style={{ background: c.text }} />
        <i style={{ background: c.textMuted }} />
      </span>
    </span>
  )
}

interface PickerProps {
  value: string
  swatches: string[]
  onPick(hex: string): void
  onAddSwatch(hex: string): void
  onRemoveSwatch(hex: string): void
}

function ColorPicker({ value, swatches, onPick, onAddSwatch, onRemoveSwatch }: PickerProps) {
  const [draft, setDraft] = useState(value)
  const field = useRef<HTMLInputElement>(null)

  // Don't overwrite what the user is typing.
  useEffect(() => {
    if (document.activeElement !== field.current) setDraft(value)
  }, [value])

  const commitDraft = () => {
    const hex = normalizeHex(draft)
    if (hex) onPick(hex)
    setDraft(hex ?? value)
  }

  const swatch = (hex: string, onContextMenu?: () => void) => (
    <button
      key={hex}
      className={`swatch-button${hex === value ? ' selected' : ''}`}
      style={{ background: hex }}
      title={hex}
      onClick={() => onPick(hex)}
      onContextMenu={
        onContextMenu &&
        ((e) => {
          e.preventDefault()
          onContextMenu()
        })
      }
    />
  )

  return (
    <div className="color-picker">
      <div className="palette">{PALETTE.map((row) => row.map((hex) => swatch(hex)))}</div>

      <div className="picker-label">Your Colours</div>
      <div className="palette">
        {swatches.map((hex) => swatch(hex, () => onRemoveSwatch(hex)))}
        <button
          className="swatch-button add"
          onClick={() => onAddSwatch(value)}
          disabled={swatches.includes(value)}
          title={swatches.includes(value) ? 'Already saved' : `Save ${value} to your colours`}
        >
          <PlusIcon width={12} height={12} />
        </button>
      </div>

      <div className="custom-color">
        <input
          type="color"
          className="native-color"
          value={value}
          onChange={(e) => onPick(e.target.value)}
          title="Choose any colour"
        />
        <input
          ref={field}
          className="hex-field"
          value={draft}
          spellCheck={false}
          onChange={(e) => {
            setDraft(e.target.value)
            // Apply complete six-digit values as they're typed; shorthand waits for Enter or blur.
            const hex = /^#?[0-9a-f]{6}$/i.test(e.target.value.trim()) ? normalizeHex(e.target.value) : null
            if (hex) onPick(hex)
          }}
          onBlur={commitDraft}
          onKeyDown={(e) => e.key === 'Enter' && commitDraft()}
        />
        <span className="picker-note">Right-click a saved colour to remove it.</span>
      </div>
    </div>
  )
}
