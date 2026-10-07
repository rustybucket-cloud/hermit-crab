import { redo, undo } from '@codemirror/commands'
import type { Command } from '@codemirror/view'
import type { ReactNode } from 'react'
import type { ContentFormat } from '../../../shared/types'
import { formatCommands, type FormatCommand } from '../editor/extensions'
import {
  BoldIcon,
  CodeIcon,
  HeadingIcon,
  ItalicIcon,
  KeyboardDownIcon,
  LinkIcon,
  QuoteIcon,
  RedoIcon,
  UnderlineIcon,
  UndoIcon
} from './Icons'

const BUTTONS: [FormatCommand, string, ReactNode][] = [
  ['heading', 'Heading', <HeadingIcon />],
  ['bold', 'Bold', <BoldIcon />],
  ['italic', 'Italic', <ItalicIcon />],
  ['underline', 'Underline', <UnderlineIcon />],
  ['link', 'Link', <LinkIcon />],
  ['quote', 'Quote', <QuoteIcon />],
  ['code', 'Code', <CodeIcon />]
]

interface Props {
  format: ContentFormat
  onRun(command: Command): void
  /** Put the keyboard away. */
  onDone(): void
}

/** Formatting above the on-screen keyboard, standing in for the desktop's Format menu. */
export function FormatBar({ format, onRun, onDone }: Props) {
  const commands = formatCommands[format]
  const button = (label: string, icon: ReactNode, run: () => void) => (
    <button key={label} className="icon-button" aria-label={label} onClick={run}>
      {icon}
    </button>
  )
  return (
    // Taps here mustn't take focus from the editor, or the keyboard would go away.
    <div className="format-bar" onPointerDown={(e) => e.preventDefault()} onMouseDown={(e) => e.preventDefault()}>
      <div className="format-bar-scroll">
        {BUTTONS.flatMap(([name, label, icon]) => {
          const command = commands[name]
          return command ? [button(label, icon, () => onRun(command))] : []
        })}
        <span className="format-bar-divider" />
        {button('Undo', <UndoIcon />, () => onRun(undo))}
        {button('Redo', <RedoIcon />, () => onRun(redo))}
      </div>
      {button('Hide Keyboard', <KeyboardDownIcon />, onDone)}
    </div>
  )
}
