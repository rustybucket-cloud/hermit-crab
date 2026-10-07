import { diff3Merge } from 'node-diff3'

/** Text split into lines, each keeping its line break. */
const lines = (text: string) => text.split(/(?<=\n)/).filter(Boolean)

/** A side of a conflict, ending in a line break so the marker after it starts a line. */
const block = (part: string[]) => {
  const text = part.join('')
  return text && !text.endsWith('\n') ? `${text}\n` : text
}

/**
 * Merge two edits of the same text line by line, the way git does. Where both changed the same lines
 * differently, the result has diff3-style conflict markers, which the merge editor reads.
 */
export function mergeText(base: string, ours: string, theirs: string): { text: string; conflicts: number } {
  const regions = diff3Merge(lines(ours), lines(base), lines(theirs), { excludeFalseConflicts: true })
  let text = ''
  let conflicts = 0
  for (const region of regions) {
    if (region.ok) {
      text += region.ok.join('')
    } else if (region.conflict) {
      conflicts++
      const { a, o, b } = region.conflict
      text += `<<<<<<< This device\n${block(a)}||||||| Original\n${block(o)}=======\n${block(b)}>>>>>>> GitHub\n`
    }
  }
  return { text, conflicts }
}
