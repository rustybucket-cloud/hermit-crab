<img src="assets/icon.svg" width="64" height="64" alt="">

# Hermit Crab

A quiet, Markdown-based writing app for the desktop, in the spirit of Ulysses. Built with Electron, React and CodeMirror 6.

## Features

- **Projects and sheets.** The library sidebar holds your projects and the middle column lists the sheets in the selected project. A sheet's first line becomes its title, and the text after it becomes the excerpt.
- **Plain files on disk.** A library is just a folder (default `~/Documents/Hermit Crab`). Each project is a sub-folder and each sheet is a `.md` file. Sheet order is kept in a small hidden `.hermit.json`. Markdown files you drop into a project folder show up as sheets.
- **Markdown editor.** Syntax stays visible but fades into the background. Headings, emphasis, links, quotes and code are styled inline, and fenced code blocks get syntax highlighting.
- **Autosave.** Edits are written atomically shortly after you stop typing, and flushed before the window closes or the app quits.
- **Writing modes.** Focus mode dims everything except the current paragraph. Typewriter mode keeps the caret line centred.
- **Preview** of the rendered Markdown.
- **Organise.** Drag sheets to reorder them, or drop a sheet onto another project to move it there. Right-click projects and sheets for more options. Search a project by full text.
- **Export** a sheet or a whole project as Markdown, HTML or PDF. Sheets are joined in order.
- **Themes.** Follow the system's light or dark appearance, pick a preset (Sepia, Rosé, Midnight, Forest…), or build your own in **Settings** by choosing background and text colours from a palette or any custom colour. Colours you save are kept for reuse.
- **GitHub sync.** In **Settings → Sync**, connect the library to a GitHub repository. Hermit Crab commits and pushes shortly after you pause writing, pulls on a timer and whenever you return to the app, and reloads open sheets in place. It uses your own `git`, so any repository you can already push to works. When the same sheet changed in both places, a merge editor lets you pick a side per conflict or edit the result. Claude Code or Codex, running locally, can take a first pass, and you review its changes before they're synced.
- Live word count, character count and reading time; spellcheck with suggestions; adjustable editor font and size.

## Shortcuts

| Action | macOS |
| --- | --- |
| New sheet / project | ⌘N / ⇧⌘N |
| Bold / italic / code / link | ⌘B / ⌘I / ⌘E / ⌘K |
| Cycle heading / toggle quote | ⌥⌘H / ⌥⌘' |
| Find in sheet | ⌘F |
| Previous / next sheet | ⌥⌘↑ / ⌥⌘↓ |
| Toggle library / sheet list | ⌘1 / ⌘2 |
| Hide / show both sidebars | ⌘\ |
| Preview / focus / typewriter | ⇧⌘P / ⇧⌘F / ⇧⌘T |
| Text size | ⌘+ / ⌘- / ⌘0 |
| Export sheet | ⇧⌘E |
| Settings | ⌘, |
| Sync now | ⌥⌘S |

On Windows and Linux, use Ctrl in place of ⌘.

## Development

```sh
pnpm install
pnpm dev        # run with hot reload
pnpm typecheck
pnpm build      # production build into out/
pnpm package    # distributable via electron-builder into dist/
```

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
