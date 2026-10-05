// Pure text helpers shared by the main process (summaries) and renderer (live counts).

const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu

/** Strip inline markdown so titles and excerpts read as plain prose. */
export function stripInline(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|~~|==)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])[*_](\S(?:.*?\S)?)[*_](?![\w*])/g, '$1$2')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/<[^>]+>/g, '')
    .trim()
}

/** Strip block-level markers from a single line (headings, quotes, list bullets). */
function stripBlock(line: string): string {
  if (/^\s*\|/.test(line)) {
    line = line
      .trim()
      .replace(/^\||\|$/g, '')
      .split('|')
      .map((cell) => cell.trim())
      .filter(Boolean)
      .join(' · ')
  }
  return line
    .replace(/^\s{0,3}#{1,6}\s+/, '')
    .replace(/^\s*(>\s?)+/, '')
    .replace(/^\s*([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/, '')
}

const isFence = (line: string) => /^\s{0,3}(```|~~~)/.test(line)
const isRule = (line: string) =>
  /^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line) || /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(line)

export function countWords(markdown: string): number {
  return markdown.match(WORD)?.length ?? 0
}

export function readingMinutes(words: number): number {
  return Math.max(1, Math.round(words / 230))
}

/** Title is the first line of prose; excerpt is what follows. */
export function summarize(markdown: string): { title: string; excerpt: string } {
  const lines = markdown.split('\n')
  let title = ''
  let i = 0
  let inFence = false
  for (; i < lines.length; i++) {
    if (isFence(lines[i])) {
      inFence = !inFence
      continue
    }
    if (inFence || isRule(lines[i])) continue
    const text = stripInline(stripBlock(lines[i]))
    if (text) {
      title = text
      i++
      break
    }
  }

  const rest: string[] = []
  let length = 0
  for (; i < lines.length && length < 240; i++) {
    if (isFence(lines[i]) || isRule(lines[i])) continue
    const text = stripInline(stripBlock(lines[i]))
    if (text) {
      rest.push(text)
      length += text.length + 1
    }
  }

  return { title: title.slice(0, 160), excerpt: rest.join(' ').slice(0, 240) }
}
