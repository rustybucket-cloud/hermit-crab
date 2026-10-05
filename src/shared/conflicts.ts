// Git conflict markers, parsed so the merge editor can offer a choice per conflict.

export interface ConflictHunk {
  /** Offset of the `<<<<<<<` line. */
  from: number
  /** Offset just past the `>>>>>>>` line (including its newline). */
  to: number
  ours: string
  /** The common ancestor, when git wrote diff3-style markers. */
  base: string | null
  theirs: string
}

export type HunkChoice = 'ours' | 'theirs' | 'both'

/** Returns every complete conflict block in the text, in order. */
export function parseConflicts(text: string): ConflictHunk[] {
  const hunks: ConflictHunk[] = []
  const lines = text.split(/(?<=\n)/)
  let offset = 0
  let open: { from: number; part: 'ours' | 'base' | 'theirs'; ours: string; base: string | null; theirs: string } | null =
    null

  for (const line of lines) {
    const bare = line.replace(/\r?\n$/, '')
    if (!open) {
      if (bare.startsWith('<<<<<<<')) open = { from: offset, part: 'ours', ours: '', base: null, theirs: '' }
    } else if (bare.startsWith('<<<<<<<')) {
      // A stray opener: start over from here.
      open = { from: offset, part: 'ours', ours: '', base: null, theirs: '' }
    } else if (open.part === 'ours' && bare.startsWith('|||||||')) {
      open.part = 'base'
      open.base = ''
    } else if (open.part !== 'theirs' && bare === '=======') {
      open.part = 'theirs'
    } else if (open.part === 'theirs' && bare.startsWith('>>>>>>>')) {
      hunks.push({ from: open.from, to: offset + line.length, ours: open.ours, base: open.base, theirs: open.theirs })
      open = null
    } else if (open.part === 'base') {
      open.base += line
    } else {
      open[open.part] += line
    }
    offset += line.length
  }
  return hunks
}

export function hasConflictMarkers(text: string): boolean {
  return parseConflicts(text).length > 0
}

/** Replace one conflict block with the chosen side. */
export function resolveHunk(text: string, hunk: ConflictHunk, choice: HunkChoice): string {
  const ours = hunk.ours
  const theirs = hunk.theirs
  const both = ours && !ours.endsWith('\n') ? `${ours}\n${theirs}` : ours + theirs
  const replacement = choice === 'ours' ? ours : choice === 'theirs' ? theirs : both
  return text.slice(0, hunk.from) + replacement + text.slice(hunk.to)
}
