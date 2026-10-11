import { ELEMENT_LABELS, SCREENPLAY_ELEMENTS, type CurrentElement, type ScreenplayElement } from '../editor/fountain'

interface Props {
  element: CurrentElement
  onPick(type: ScreenplayElement): void
  /** On a phone, a button that brings up a sheet of the elements, in place of a native menu. */
  compact?: boolean
}

/** The screenplay element the caret is in, in the status bar; pick another to turn the line into it. */
export function ElementPicker({ element, onPick, compact }: Props) {
  const listed = SCREENPLAY_ELEMENTS.some((e) => e.type === element.type)
  // Dialogue and parentheticals only follow a name.
  const allowed = (type: ScreenplayElement) => element.speech || (type !== 'dialogue' && type !== 'parenthetical')

  if (compact) {
    const pick = async () => {
      const choice = await window.hermit.showContextMenu(
        SCREENPLAY_ELEMENTS.map(({ type, label }) => ({
          id: type,
          label: `${element.type === type ? '✓ ' : ''}${label}`,
          enabled: allowed(type)
        })),
        undefined,
        { title: 'Screenplay Element' }
      )
      if (choice) onPick(choice as ScreenplayElement)
    }
    return (
      <button className="element-picker" aria-label="Screenplay element" onClick={() => void pick()}>
        {ELEMENT_LABELS[element.type]}
      </button>
    )
  }

  return (
    <select
      className="element-picker"
      aria-label="Screenplay element"
      title="Screenplay element (Tab to change)"
      value={element.type}
      onChange={(e) => onPick(e.target.value as ScreenplayElement)}
    >
      {/* Sections, notes and the like show what they are, but lines aren't turned into them from here. */}
      {!listed && (
        <option value={element.type} disabled>
          {ELEMENT_LABELS[element.type]}
        </option>
      )}
      {SCREENPLAY_ELEMENTS.map(({ type, label }) => (
        <option key={type} value={type} disabled={!allowed(type)}>
          {label}
        </option>
      ))}
    </select>
  )
}
