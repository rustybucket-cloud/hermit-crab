import { useEffect, useState } from 'react'

/** On iPhone and iPad the app is used by touch, with no menu bar, right-click or hover. */
export const touch = window.hermit.platform === 'ios'

const COMPACT = '(max-width: 700px)'

/** Whether the window is phone-sized, so the panes show one at a time. */
export function useCompact(): boolean {
  const [compact, setCompact] = useState(() => touch && window.matchMedia(COMPACT).matches)
  useEffect(() => {
    if (!touch) return
    const query = window.matchMedia(COMPACT)
    const update = () => setCompact(query.matches)
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  return compact
}

/** Whether something inside `selector` has focus, such as the editor while the keyboard is up. */
export function useFocusWithin(selector: string): boolean {
  const [focused, setFocused] = useState(false)
  useEffect(() => {
    if (!touch) return
    const update = () => setFocused(Boolean(document.activeElement?.closest(selector)))
    // Focus has only moved on once focusout is over.
    const later = () => window.setTimeout(update)
    document.addEventListener('focusin', update)
    document.addEventListener('focusout', later)
    return () => {
      document.removeEventListener('focusin', update)
      document.removeEventListener('focusout', later)
    }
  }, [selector])
  return focused
}
