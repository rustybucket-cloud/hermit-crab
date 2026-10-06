<img src="assets/hermit-crab.png" width="64" height="64" alt="Orange hermit crab with a blue shell">

# Hermit Crab

A quiet, Markdown-based writing app for the desktop, in the spirit of Ulysses. Built with Electron, React and CodeMirror 6.

## Features

- **Projects and sheets.** The library sidebar holds your projects, which you can group into folders nested as deep as you like. The middle column lists the sheets in the selected project. A sheet's first line becomes its title, and the text after it becomes the excerpt.
- **Content and notes.** Each project has two sections. The content is the work itself: it's what gets exported and counted. Notes are for planning, outlines and research. Switch between the sections at the top of the sheet list; each remembers the sheet you last had open.
- **Canvases.** Notes can also be canvases: open boards, like Obsidian's, for planning visually. Add Markdown cards (double-click anywhere), headings, linked notes and sheets that show their text, and images (from the toolbar, by dropping files, or by pasting). Drag from the dot on a card's edge to connect it to another, or onto empty space to start a new connected card. Colour cards and connections, label connections, and pan (drag or scroll) and zoom (⌘-scroll or pinch). Drag notes in from the sheet list to link them. Canvases are saved in the open [JSON Canvas](https://jsoncanvas.org) format, so other apps can read them too.
- **Subsections.** Either section can be organised into subsections, such as parts and chapters, or characters and research. Subsections nest as deep as you like, and sit in order among the sheets around them.
- **Plain files on disk.** A library is just a folder (default `~/Documents/Hermit Crab`). Each project is a sub-folder and each sheet is a `.md` file. A folder of projects is a sub-folder marked by a hidden `.hermit-folder` file. Notes go in the project's `Notes` sub-folder, and each subsection is a folder. A canvas is a `.canvas` file named after the canvas. Its links point at files by their path within the project, and images placed on a canvas are copied into the project's `Attachments` folder. Sheet and subsection order is kept in a small hidden `.hermit.json`. Markdown files and folders you add to a project folder show up as sheets and subsections.
- **Markdown editor.** Syntax stays visible but fades into the background. Headings, emphasis, links, quotes and code are styled inline, and fenced code blocks get syntax highlighting.
- **Autosave.** Edits are written atomically shortly after you stop typing, and flushed before the window closes or the app quits.
- **Writing modes.** Focus mode dims everything except the current paragraph. Typewriter mode keeps the caret line centred.
- **Preview** of the rendered Markdown.
- **Organise.** Drag sheets and subsections to reorder them, or drop one onto a subsection to put it inside, or onto the other section's tab to move it between content and notes. Drop a sheet onto another project to move it there, and drag projects and folders in the sidebar onto a folder to file them inside. Right-click projects and sheets for more options. Search a project by full text.
- **Export** a sheet or a whole project as Markdown, HTML or PDF. A project exports its content, with sheets joined in order.
- **Themes.** Follow the system's light or dark appearance, pick a preset (Sepia, Rosé, Midnight, Forest…), or build your own in **Settings** by choosing background and text colours from a palette or any custom colour. Colours you save are kept for reuse.
- **GitHub sync.** In **Settings → Sync**, connect the library to a GitHub repository. Hermit Crab commits and pushes shortly after you pause writing, pulls on a timer and whenever you return to the app, and reloads open sheets in place. It uses your own `git`, so any repository you can already push to works. When the same sheet changed in both places, a merge editor lets you pick a side per conflict or edit the result. Claude Code or Codex, running locally, can take a first pass, and you review its changes before they're synced.
- **Grammar checking.** Grammar, word choice and punctuation are checked as you type by [Harper](https://writewithharper.com), which runs entirely on your computer. Hover over an underline for suggestions, or ignore it. Pick your English dialect or turn checking off in **Settings → Writing**.
- Live word count, character count and reading time; spellcheck with suggestions; adjustable editor font and size.

## Shortcuts

| Action | macOS |
| --- | --- |
| New sheet / canvas / project | ⌘N / ⌥⌘N / ⇧⌘N |
| Bold / italic / code / link | ⌘B / ⌘I / ⌘E / ⌘K |
| Cycle heading / toggle quote | ⌥⌘H / ⌥⌘' |
| Find in sheet | ⌘F |
| Next grammar issue / list all issues | F8 / ⇧⌘M |
| Previous / next sheet | ⌥⌘↑ / ⌥⌘↓ |
| Toggle library / sheet list | ⌘1 / ⌘2 |
| Switch content / notes | ⌘3 |
| Hide / show both sidebars | ⌘\ |
| Preview / focus / typewriter | ⇧⌘P / ⇧⌘F / ⇧⌘T |
| Text size | ⌘+ / ⌘- / ⌘0 |
| Export sheet | ⇧⌘E |
| Settings | ⌘, |
| Sync now | ⌥⌘S |

On Windows and Linux, use Ctrl in place of ⌘.

## Development

Use pnpm 12.8.1, the version pinned in `package.json`. See the [pnpm installation instructions](https://pnpm.io/installation) if it is not installed.

```sh
pnpm install
pnpm dev        # run with hot reload
pnpm typecheck
pnpm build      # production build into out/
pnpm package    # distributable via electron-builder into dist/
```

Dependencies use a hoisted layout, configured in `pnpm-workspace.yaml`, for Electron packaging compatibility. Commit changes to `pnpm-lock.yaml` when adding or updating dependencies; use `pnpm install --frozen-lockfile` for reproducible installs.

The `dev` and `preview` commands download the Electron executable if it is missing. The first run may take longer; later runs reuse the installed executable.

Set `HERMIT_LIBRARY=/some/folder` to point the app at a different library (handy for testing). You can also change the library from **File → Change Library Location…**.

### Layout

```
src/
  main/       Electron main process: window, menus, IPC, library (filesystem), export and git sync
  preload/    contextBridge API exposed to the renderer as window.hermit
  renderer/   React UI and CodeMirror editor
  shared/     Types and text helpers used by both sides
```
