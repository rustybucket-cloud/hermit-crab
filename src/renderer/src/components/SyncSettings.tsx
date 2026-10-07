import { useEffect, useState } from 'react'
import type { SyncAgent, SyncSettings as Settings, SyncState } from '../../../shared/types'
import { timeAgo } from '../sync'

const hermit = window.hermit

const AGENTS: { id: SyncAgent; name: string }[] = [
  { id: 'claude', name: 'Claude Code' },
  { id: 'codex', name: 'Codex' }
]

const COMMIT_DELAYS = [
  [10, '10 seconds'],
  [30, '30 seconds'],
  [60, '1 minute'],
  [300, '5 minutes']
] as const

const PULL_INTERVALS = [
  [1, 'minute'],
  [5, '5 minutes'],
  [15, '15 minutes'],
  [60, 'hour']
] as const

interface Props {
  sync: SyncState | null
  onOpenMerge(): void
}

export function SyncSettings({ sync, onOpenMerge }: Props) {
  const [url, setUrl] = useState(sync?.remoteUrl ?? '')
  const [branch, setBranch] = useState(sync?.settings.branch ?? 'main')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => setUrl(sync?.remoteUrl ?? ''), [sync?.remoteUrl])
  useEffect(() => setBranch(sync?.settings.branch ?? 'main'), [sync?.settings.branch])

  if (!sync) return null
  const { settings } = sync
  const connected = Boolean(sync.remoteUrl)
  // On iOS there's no git of the computer's to sign in with, so sync uses an access token.
  const usesToken = sync.credentials === 'token'
  const agentName = AGENTS.find((a) => a.id === settings.agent)!.name

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await work()
    } catch (err) {
      // Errors from the main process arrive wrapped: "Error invoking remote method '…': Error: …"
      setError(String(err instanceof Error ? err.message : err).replace(/^.*?Error: /, ''))
    } finally {
      setBusy(false)
    }
  }

  const update = (patch: Partial<Settings>) => void run(() => hermit.updateSyncSettings(patch))
  const connect = () => void run(() => hermit.connectSync(url))
  const saveToken = (value: string | null) =>
    void run(async () => {
      await hermit.setSyncToken?.(value)
      setToken('')
    })

  const statusLine = (() => {
    switch (sync.status) {
      case 'off': return connected ? 'Sync is paused.' : null
      case 'idle': return sync.lastSyncedAt ? `Synced ${timeAgo(sync.lastSyncedAt)}.` : 'Up to date.'
      case 'syncing': return 'Syncing…'
      case 'resolving': return sync.message ?? 'Resolving conflicts…'
      case 'conflict': return sync.message ?? 'Some files changed both here and on GitHub.'
      case 'error': return null
    }
  })()

  return (
    <>
      <section className="settings-section">
        <h2>GitHub Sync</h2>
        {usesToken ? (
          <p className="settings-hint flush">
            Hermit Crab commits your library to a Git repository while you write, pushes it to GitHub, and pulls in
            changes made elsewhere, such as in Hermit Crab on your Mac.
          </p>
        ) : (
          <p className="settings-hint flush">
            Hermit Crab commits your library to a Git repository while you write, pushes it to GitHub, and pulls in
            changes made elsewhere. It uses your computer’s own <code>git</code>, so it works with any repository you can
            already push to.
          </p>
        )}

        {!sync.gitAvailable ? (
          <p className="settings-error">{sync.message}</p>
        ) : (
          <>
            {usesToken && (
              <>
                <label className="field-label" htmlFor="sync-token">
                  Access Token
                </label>
                {sync.hasToken ? (
                  <div className="field-row">
                    <span className="sync-token-saved">A token is saved in the keychain.</span>
                    <button className="ghost-button" disabled={busy} onClick={() => saveToken(null)}>
                      Remove
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="field-row">
                      <input
                        id="sync-token"
                        className="text-field"
                        type="password"
                        value={token}
                        placeholder="github_pat_…"
                        autoComplete="off"
                        autoCapitalize="off"
                        spellCheck={false}
                        onChange={(e) => setToken(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && token.trim() && saveToken(token)}
                      />
                      <button className="primary-button" disabled={busy || !token.trim()} onClick={() => saveToken(token)}>
                        Save
                      </button>
                    </div>
                    <p className="settings-hint">
                      On GitHub, under Settings › Developer settings › Personal access tokens, create a fine-grained
                      token for the repository with read and write access to its contents, and paste it here.
                    </p>
                  </>
                )}
              </>
            )}

            <label className="field-label" htmlFor="sync-url">
              Repository
            </label>
            <div className="field-row">
              <input
                id="sync-url"
                className="text-field"
                value={url}
                placeholder={usesToken ? 'https://github.com/you/writing' : 'git@github.com:you/writing.git'}
                spellCheck={false}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && url.trim() && connect()}
              />
              <button
                className="primary-button"
                disabled={
                  busy || !url.trim() || (connected && url.trim() === sync.remoteUrl) || (usesToken && !sync.hasToken)
                }
                onClick={connect}
              >
                {connected ? 'Change' : 'Connect'}
              </button>
            </div>
            {!connected && (
              <p className="settings-hint">
                Create an empty private repository on GitHub and paste its URL. If the repository already has writing in
                it, the two will be merged.
              </p>
            )}

            {connected && (
              <>
                <label className="toggle-row">
                  <input
                    type="checkbox"
                    checked={settings.enabled}
                    onChange={(e) => update({ enabled: e.target.checked })}
                  />
                  <span>Sync automatically</span>
                </label>

                <div className="sync-status">
                  <span className={`sync-dot ${sync.status}`} />
                  <span className="sync-status-text">
                    {sync.status === 'error' ? <span className="settings-error">{sync.message}</span> : statusLine}
                  </span>
                  {sync.status === 'conflict' || sync.status === 'resolving' ? (
                    <button className="ghost-button" onClick={onOpenMerge}>
                      {sync.conflicts.length ? 'Resolve…' : 'Finish Merge…'}
                    </button>
                  ) : (
                    <button
                      className="ghost-button"
                      disabled={busy || !settings.enabled || sync.status === 'syncing'}
                      onClick={() => void run(() => hermit.syncNow())}
                    >
                      Sync Now
                    </button>
                  )}
                </div>
              </>
            )}
            {error && <p className="settings-error">{error}</p>}
          </>
        )}
      </section>

      {connected && (
        <>
          <section className="settings-section">
            <h3>Timing</h3>
            <div className="setting-rows">
              <label className="setting-row">
                <span>Commit and push after a pause of</span>
                <select
                  className="select-field"
                  value={settings.commitDelay}
                  onChange={(e) => update({ commitDelay: Number(e.target.value) })}
                >
                  {COMMIT_DELAYS.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="setting-row">
                <span>Check GitHub for changes every</span>
                <select
                  className="select-field"
                  value={settings.pullInterval}
                  onChange={(e) => update({ pullInterval: Number(e.target.value) })}
                >
                  {PULL_INTERVALS.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="setting-row">
                <span>Branch</span>
                <input
                  className="text-field short"
                  value={branch}
                  spellCheck={false}
                  onChange={(e) => setBranch(e.target.value)}
                  onBlur={() => branch.trim() !== settings.branch && update({ branch })}
                  onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                />
              </label>
            </div>
            <p className="settings-hint">
              While you keep typing, changes are still committed at least every five minutes. GitHub is also checked
              whenever you switch back to Hermit Crab.
            </p>
          </section>

          {usesToken ? (
            <section className="settings-section">
              <h3>Merge Conflicts</h3>
              <p className="settings-hint flush">
                When the same sheet changes here and on GitHub, the merge editor opens so you can choose what to keep.
              </p>
            </section>
          ) : (
            <section className="settings-section">
              <h3>Merge Conflicts</h3>
              <p className="settings-hint flush">
                When the same sheet changes here and on GitHub, the merge editor opens so you can choose what to keep. A
                coding agent on this computer can do a first pass for you.
              </p>
              <div className="segmented" role="radiogroup" aria-label="Conflict helper">
                {AGENTS.map((agent) => (
                  <button
                    key={agent.id}
                    role="radio"
                    aria-checked={settings.agent === agent.id}
                    className={settings.agent === agent.id ? 'selected' : ''}
                    onClick={() => update({ agent: agent.id })}
                  >
                    {agent.name}
                    {!sync.agents[agent.id] && <span className="muted"> · not installed</span>}
                  </button>
                ))}
              </div>
              <label className="toggle-row">
                <input
                  type="checkbox"
                  checked={settings.autoResolve}
                  disabled={!sync.agents[settings.agent]}
                  onChange={(e) => update({ autoResolve: e.target.checked })}
                />
                <span>Send conflicts to {agentName} automatically</span>
              </label>
              <p className="settings-hint">
                {sync.agents[settings.agent]
                  ? `${agentName} runs locally in your library folder and only edits the conflicted files. Nothing is synced until you review its changes in the merge editor.`
                  : `Install the ${agentName} command-line tool to use it here.`}
              </p>
            </section>
          )}
        </>
      )}
    </>
  )
}
