import { useEffect, useRef } from 'react'
import type { ContentFormat, ProjectSettings as Settings, ProjectSummary } from '../../../shared/types'
import { CloseIcon } from './Icons'

const FORMATS: { id: ContentFormat; label: string }[] = [
  { id: 'markdown', label: 'Prose (Markdown)' },
  { id: 'fountain', label: 'Screenplay (Fountain)' }
]

interface Props {
  project: ProjectSummary
  onChange(patch: Partial<Settings>): void
  onClose(): void
}

export function ProjectSettings({ project, onChange, onClose }: Props) {
  const dialog = useRef<HTMLDivElement>(null)

  useEffect(() => dialog.current?.focus(), [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="settings-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="settings" role="dialog" aria-label="Project Settings" tabIndex={-1} ref={dialog}>
        <header className="settings-header">
          <h1>
            Project Settings <span className="muted">· {project.name}</span>
          </h1>
          <button className="icon-button" onClick={onClose} title="Close (Esc)">
            <CloseIcon />
          </button>
        </header>

        <div className="settings-body">
          <section className="settings-section">
            <h2>Content</h2>
            <div className="setting-rows">
              <label className="setting-row">
                <span>Content type</span>
                <select
                  className="select-field"
                  value={project.settings.format}
                  onChange={(e) => onChange({ format: e.target.value as ContentFormat })}
                >
                  {FORMATS.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
