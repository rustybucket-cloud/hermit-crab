import { ELEMENT_LABELS, SCREENPLAY_ELEMENTS, type CurrentElement, type ScreenplayElement } from '../editor/fountain'

interface Props {
  element: CurrentElement
  onPick(type: ScreenplayElement): void
}

/** The screenplay element the caret is in, in the status bar; pick another to turn the line into it. */
export function ElementPicker({ element, onPick }: Props) {
  const listed = SCREENPLAY_ELEMENTS.some((e) => e.type === element.type)
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
        // Dialogue and parentheticals only follow a name.
        <option key={type} value={type} disabled={!element.speech && (type === 'dialogue' || type === 'parenthetical')}>
          {label}
        </option>
      ))}
    </select>
  )
}
