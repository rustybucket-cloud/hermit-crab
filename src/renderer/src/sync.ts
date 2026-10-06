import { useEffect, useState } from 'react'
import { sheetFile } from '../../shared/canvas'
import type { SyncState } from '../../shared/types'

const hermit = window.hermit

/** The main process owns sync; this mirrors its state. */
export function useSyncState(): SyncState | null {
  const [state, setState] = useState<SyncState | null>(null)
  useEffect(() => {
    let live = true
    const off = hermit.onSyncState(setState)
    void hermit.getSyncState().then((s) => live && setState((prev) => prev ?? s))
    return () => {
      live = false
      off()
    }
  }, [])
  return state
}

export function sheetPath(projectId: string, sheetId: string): string {
  return `${projectId}/${sheetFile(sheetId)}`
}

export function timeAgo(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000)
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} hr ago`
  return new Date(ts).toLocaleDateString()
}

/** A short label for the status bar, or null when sync is off. */
export function syncLabel(state: SyncState | null): string | null {
  switch (state?.status) {
    case 'idle': return 'Synced'
    case 'syncing': return 'Syncing…'
    case 'conflict': return state.conflicts.length ? 'Sync conflict — Resolve…' : 'Finish merge…'
    case 'resolving': return 'Resolving conflicts…'
    case 'error': return 'Not synced'
    default: return null
  }
}
