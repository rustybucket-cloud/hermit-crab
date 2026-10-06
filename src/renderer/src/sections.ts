import type { Section, SheetPlace } from '../../shared/types'

export const SECTIONS: Section[] = ['content', 'notes']

/** What each section is called, and what one sheet in it is called. */
export const SECTION_NAMES: Record<Section, { label: string; item: string }> = {
  content: { label: 'Content', item: 'Sheet' },
  notes: { label: 'Notes', item: 'Note' }
}

export const otherSection = (section: Section): Section => (section === 'content' ? 'notes' : 'content')

export const samePlace = (a: SheetPlace, b: SheetPlace) => a.section === b.section && a.subsection === b.subsection

/** How a place reads in menus and labels: "Content", "Notes", "Notes › Characters › Minor". */
export const placeName = (place: SheetPlace) =>
  [SECTION_NAMES[place.section].label, ...(place.subsection?.split('/') ?? [])].join(' › ')

// Subsections are slash-separated paths within their section, like `Characters/Minor`.

export const subsectionName = (path: string) => path.slice(path.lastIndexOf('/') + 1)

export function parentSubsection(path: string): string | null {
  const i = path.lastIndexOf('/')
  return i === -1 ? null : path.slice(0, i)
}

/** How many subsections deep a place is. */
export const depthOf = (subsection: string | null) => (subsection ? subsection.split('/').length : 0)

/** Whether `subsection` is `folder` or inside it. */
export const isWithin = (subsection: string | null, folder: string) =>
  subsection === folder || Boolean(subsection?.startsWith(`${folder}/`))
