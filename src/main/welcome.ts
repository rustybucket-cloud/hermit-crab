import { serializeCanvas } from '../shared/canvas'

export const WELCOME_PROJECT = 'Getting Started'

const mod = process.platform === 'darwin' ? '⌘' : 'Ctrl+'
const alt = process.platform === 'darwin' ? '⌥' : 'Alt+'

export const WELCOME_SHEETS = [
  `# Welcome to Hermit Crab

A quiet place to write. Everything you write is plain **Markdown**, saved automatically as \`.md\` files in your library folder — no export step needed to get your words back out.

## How it's organised

- **Projects** live in the left column. Each one is just a folder on disk. Group them into folders with the folder button at the bottom of the column, and drag projects onto a folder to file them there.
- **Sheets** live in the middle column. Each sheet is one Markdown file. Its first line becomes its title.
- Every project has two sections, switched at the top of the middle column. **Content** is the work itself. **Notes** hold everything behind it: plans, outlines, research, characters.
- The **editor** is on the right.

Either section can be organised into subsections — parts and chapters, say, or characters and research — and subsections can hold subsections. Drag sheets and subsections to reorder them, drop one onto a subsection to put it inside, or drop a sheet onto another project to move it there. Right-click projects, sheets and subsections for more options.
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
| Switch content / notes | ${mod}3 |
| Preview | ${mod}Shift+P |
| Focus mode | ${mod}Shift+F |
| Typewriter mode | ${mod}Shift+T |
| Text size | ${mod}+ / ${mod}- / ${mod}0 |

**Focus mode** dims everything except the paragraph you're writing. **Typewriter mode** keeps the line you're on in the middle of the screen.

When you're done, use **File → Export** to save a sheet or a whole project as Markdown, HTML or PDF. Exporting a project exports its content; notes stay behind.
`
]

export const WELCOME_NOTES = [
  `# Notes

This is a note. Notes sit beside the content but aren't part of it, so they're the place to plan and think out loud:

- An outline, or a list of scenes still to write
- Research, quotes and links
- Characters, places, timelines
- Ideas you're not ready to use yet

Group notes into subsections, such as *Characters* or *Research*, with the folder button at the top of the list, and nest subsections inside each other as deep as you like. Drag a note onto a subsection to file it there.

Notes can also be **canvases**: boards of cards you arrange freely and connect. Make one with the canvas button at the top of the notes list.

Right-click a sheet and choose **Move to Notes** to set it aside, or drag it onto the **Notes** tab. Notes move back to the content the same way.

On disk, notes are Markdown files in the project's \`Notes\` folder, and each subsection is a folder.
`
]

/** A small canvas that shows off cards, headings, connections and a linked note. */
export const WELCOME_CANVAS = (noteFile: string) =>
  serializeCanvas({
    nodes: [
      { id: 'heading', type: 'text', text: '# Planning Board', x: -400, y: -300, width: 420, height: 70 },
      {
        id: 'cards',
        type: 'text',
        text: '**Cards** hold Markdown. Double-click empty space to add one, and double-click a card to edit it.',
        x: -400,
        y: -200,
        width: 300,
        height: 120
      },
      {
        id: 'connect',
        type: 'text',
        text: 'Drag from the dot on any edge of a card to **connect** it to another. Drop on empty space to start a new card.',
        x: -400,
        y: 0,
        width: 300,
        height: 120,
        color: '5'
      },
      {
        id: 'more',
        type: 'text',
        text: 'Add **headings**, **linked notes** and **images** from the toolbar. Drag notes in from the list, or drop and paste images.',
        x: 0,
        y: -200,
        width: 300,
        height: 120,
        color: '4'
      },
      { id: 'note', type: 'file', file: noteFile, x: 0, y: 0, width: 380, height: 320 }
    ],
    edges: [
      { id: 'e1', fromNode: 'cards', fromSide: 'bottom', toNode: 'connect', toSide: 'top', toEnd: 'arrow' },
      { id: 'e2', fromNode: 'cards', fromSide: 'right', toNode: 'more', toSide: 'left', toEnd: 'arrow' },
      { id: 'e3', fromNode: 'more', fromSide: 'bottom', toNode: 'note', toSide: 'top', toEnd: 'arrow', label: 'a linked note' }
    ]
  })
