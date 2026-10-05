export const WELCOME_PROJECT = 'Getting Started'

const mod = process.platform === 'darwin' ? '⌘' : 'Ctrl+'
const alt = process.platform === 'darwin' ? '⌥' : 'Alt+'

export const WELCOME_SHEETS = [
  `# Welcome to Hermit Crab

A quiet place to write. Everything you write is plain **Markdown**, saved automatically as \`.md\` files in your library folder — no export step needed to get your words back out.

## How it's organised

- **Projects** live in the left column. Each one is just a folder on disk.
- **Sheets** live in the middle column. Each sheet is one Markdown file. Its first line becomes its title.
- The **editor** is on the right.

Drag sheets to reorder them, or drop a sheet onto another project to move it there. Right-click projects and sheets for more options.
`,
  `# Writing in Markdown

Markdown is a few characters that turn into formatting. The characters stay visible but fade into the background so they don't get in the way.

## Inline

Wrap words in *single asterisks* for emphasis, **double asterisks** for strong, \`backticks\` for code, and ~~tildes~~ to strike through. Links look like [this](https://commonmark.org/help/).

## Blocks

> Start a line with \`>\` for a quotation.

- Dashes make a list.
- Press Return to continue it.

1. Numbers make an ordered list.

Three dashes make a section break:

---

Use **Preview** (${mod}Shift+P) to see the rendered result.
`,
  `# Shortcuts

| Action | Shortcut |
| --- | --- |
| New sheet | ${mod}N |
| New project | ${mod}Shift+N |
| Bold / Italic | ${mod}B / ${mod}I |
| Inline code | ${mod}E |
| Insert link | ${mod}K |
| Find in sheet | ${mod}F |
| Previous / next sheet | ${mod}${alt}↑ / ${mod}${alt}↓ |
| Show / hide library | ${mod}1 |
| Show / hide sheet list | ${mod}2 |
| Preview | ${mod}Shift+P |
| Focus mode | ${mod}Shift+F |
| Typewriter mode | ${mod}Shift+T |
| Text size | ${mod}+ / ${mod}- / ${mod}0 |

**Focus mode** dims everything except the paragraph you're writing. **Typewriter mode** keeps the line you're on in the middle of the screen.

When you're done, use **File → Export** to save a sheet or a whole project as Markdown, HTML or PDF.
`
]
