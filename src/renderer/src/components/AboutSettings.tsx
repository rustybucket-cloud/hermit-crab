import { useEffect, useState } from 'react'
import type { AppInfo, UpdateState } from '../../../shared/types'
import { renderIcon } from '../icon'
import { timeAgo } from '../sync'

const hermit = window.hermit

const REPO = 'https://github.com/rustybucket-cloud/hermit-crab'

/** The update states as the sync status dot's colours. */
const DOT: Record<UpdateState['status'], string> = {
  unavailable: '',
  idle: 'idle',
  checking: 'syncing',
  downloading: 'syncing',
  ready: 'conflict',
  error: 'error'
}

interface Props {
  /** The theme's sheet-list colour, which the app icon's tile is drawn in. */
  iconBackground: string
}

export function AboutSettings({ iconBackground }: Props) {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [update, setUpdate] = useState<UpdateState | null>(null)
  const [icon, setIcon] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void hermit.getAppInfo().then(setInfo)
    void hermit.getUpdateState().then(setUpdate)
    return hermit.onUpdateState(setUpdate)
  }, [])

  useEffect(() => {
    let cancelled = false
    renderIcon(iconBackground)
      .then((url) => !cancelled && setIcon(url))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [iconBackground])

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await work()
    } finally {
      setBusy(false)
    }
  }

  const check = () => void run(async () => setUpdate(await hermit.checkForUpdates()))

  const statusLine = (() => {
    switch (update?.status) {
      case undefined: return null
      case 'unavailable': return update.message
      case 'idle': return update.checkedAt ? `Up to date. Checked ${timeAgo(update.checkedAt)}.` : 'Checks for updates every few hours.'
      case 'checking': return 'Checking for updates…'
      case 'downloading': return `Downloading version ${update.version}…${update.percent === null ? '' : ` ${update.percent}%`}`
      case 'ready': return `Version ${update.version} is ready. It installs when you restart.`
      case 'error': return null
    }
  })()

  return (
    <>
      <section className="settings-section about">
        {icon && <img className="about-icon" src={icon} alt="" />}
        <div>
          <h2>{info?.name ?? 'Hermit Crab'}</h2>
          <p className="about-version">
            {info && `Version ${info.version}${info.build && info.build !== info.version ? ` (${info.build})` : ''}`}
          </p>
          <p className="settings-hint flush">A calm, Markdown-based writing app with projects.</p>
        </div>
      </section>

      <section className="settings-section">
        <h3>Updates</h3>
        {update && (
          <div className="sync-status">
            {update.status !== 'unavailable' && <span className={`sync-dot ${DOT[update.status]}`} />}
            <span className="sync-status-text">
              {update.status === 'error' ? (
                <span className="settings-error">Couldn’t check for updates: {update.message}</span>
              ) : (
                statusLine
              )}
            </span>
            {update.status === 'ready' ? (
              <button className="primary-button" disabled={busy} onClick={() => void run(() => hermit.installUpdate())}>
                Restart to Update
              </button>
            ) : (
              update.status !== 'unavailable' && (
                <button
                  className="ghost-button"
                  disabled={busy || update.status === 'checking' || update.status === 'downloading'}
                  onClick={check}
                >
                  Check for Updates
                </button>
              )
            )}
          </div>
        )}
      </section>

      <section className="settings-section">
        <h3>Links</h3>
        <div className="about-links">
          <a href={`${REPO}/releases`} target="_blank" rel="noreferrer">
            Release Notes
          </a>
          <a href={REPO} target="_blank" rel="noreferrer">
            Source on GitHub
          </a>
          <a href={`${REPO}/issues`} target="_blank" rel="noreferrer">
            Report a Problem
          </a>
        </div>
      </section>
    </>
  )
}
