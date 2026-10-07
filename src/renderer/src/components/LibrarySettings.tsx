import { useEffect, useState } from 'react'
import { touch } from '../device'

const hermit = window.hermit

export function LibrarySettings() {
  const [location, setLocation] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void hermit.getLibraryLocation().then(setLocation)
  }, [])

  const choose = async () => {
    setBusy(true)
    setError(null)
    try {
      const chosen = await hermit.chooseLibraryLocation()
      if (chosen) setLocation(chosen)
    } catch (err) {
      // Errors from the main process arrive wrapped: "Error invoking remote method '…': Error: …"
      setError(String(err instanceof Error ? err.message : err).replace(/^.*?Error: /, ''))
    } finally {
      setBusy(false)
    }
  }

  const reveal = hermit.platform === 'darwin' ? 'Show in Finder' : 'Show in Folder'

  return (
    <section className="settings-section">
      <h2>Library Location</h2>
      <p className="settings-hint flush">
        Your library is an ordinary folder: each project is a folder inside it and each sheet is a Markdown file, so you
        can open them with other apps too. Choosing a different folder opens the library there; nothing is moved.
      </p>
      {touch && (
        <p className="settings-hint">
          Keep it in the app, where the Files app shows it under Hermit Crab, or choose a folder in iCloud Drive to use
          the same library as Hermit Crab on your Mac.
        </p>
      )}

      <label className="field-label" htmlFor="library-location">
        Folder
      </label>
      <div className="field-row">
        {touch ? (
          // A place like “iCloud Drive › Writing” reads better whole than in a field.
          <span id="library-location" className="library-location">
            {location}
          </span>
        ) : (
          <input id="library-location" className="text-field" value={location ?? ''} readOnly spellCheck={false} />
        )}
        <button className="primary-button" disabled={busy} onClick={() => void choose()}>
          Change…
        </button>
        {!touch && (
          <button className="ghost-button" onClick={() => void hermit.revealLibrary()}>
            {reveal}
          </button>
        )}
      </div>
      {error && <p className="settings-error">{error}</p>}
    </section>
  )
}
