import { app, dialog } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateState } from '../shared/types'

const CHECK_EVERY = 4 * 60 * 60 * 1000

let closeWindows: () => Promise<void>
let emitState: (state: UpdateState) => void = () => {}
let state: UpdateState = app.isPackaged
  ? { status: 'idle', checkedAt: null }
  : { status: 'unavailable', message: 'Updates are only checked in the packaged app.' }
/** The version waiting to install, once it's downloaded. */
let downloaded: string | null = null
/** The version the user was last asked about, so a periodic check doesn't ask again. */
let offered: string | null = null
let installing = false

function setState(next: UpdateState): void {
  state = next
  emitState(state)
}

/**
 * Checks GitHub Releases for a newer version on launch and every few hours, downloads it
 * in the background, and offers to restart into it. Declined updates install on quit.
 * `close` closes the windows, saving their edits, before the app restarts; `emit` tells
 * them how updating is going.
 */
export function startUpdater(close: () => Promise<void>, emit: (state: UpdateState) => void): void {
  if (!app.isPackaged) return
  closeWindows = close
  emitState = emit
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('checking-for-update', () => setState({ status: 'checking' }))
  autoUpdater.on('update-not-available', () => setState({ status: 'idle', checkedAt: Date.now() }))
  autoUpdater.on('update-available', (info) => setState({ status: 'downloading', version: info.version, percent: null }))
  autoUpdater.on('download-progress', (progress) => {
    if (state.status === 'downloading') setState({ ...state, percent: Math.round(progress.percent) })
  })
  autoUpdater.on('update-downloaded', (info) => {
    downloaded = info.version
    setState({ status: 'ready', version: info.version })
    if (offered !== info.version) void offerRestart()
  })
  autoUpdater.on('error', (err) => {
    console.error('Update failed', err)
    setState({ status: 'error', message: err.message })
  })
  // Once an update's waiting it installs on quit, so there's no need to keep looking.
  const check = () => !downloaded && autoUpdater.checkForUpdates().catch(() => {}) // the error event reports it
  setTimeout(check, 10_000)
  setInterval(check, CHECK_EVERY)
}

/** Whether the app is quitting to install an update, so closing the last window mustn't quit it first. */
export function isInstallingUpdate(): boolean {
  return installing
}

export function getUpdateState(): UpdateState {
  return state
}

/** Settings' Check for Updates, which shows what it found there rather than in a dialog. */
export async function checkForUpdates(): Promise<UpdateState> {
  if (app.isPackaged && !downloaded) await autoUpdater.checkForUpdates().catch(() => {}) // the error event reports it
  return state
}

/** The menu's Check for Updates…, which reports what it found. */
export async function checkForUpdatesNow(): Promise<void> {
  if (!app.isPackaged) {
    await dialog.showMessageBox({ message: 'Updates are only checked in the packaged app.' })
    return
  }
  if (downloaded) return offerRestart()
  try {
    const result = await autoUpdater.checkForUpdates()
    await dialog.showMessageBox(
      result?.isUpdateAvailable
        ? {
            message: `Downloading HermitCrab Writing ${result.updateInfo.version}…`,
            detail: 'You’ll be asked to restart when it’s ready.'
          }
        : { message: 'HermitCrab Writing is up to date.', detail: `You have version ${app.getVersion()}.` }
    )
  } catch (err) {
    await dialog.showMessageBox({
      type: 'error',
      message: 'Couldn’t check for updates.',
      detail: err instanceof Error ? err.message : String(err)
    })
  }
}

async function offerRestart(): Promise<void> {
  if (!downloaded || installing) return
  offered = downloaded
  const { response } = await dialog.showMessageBox({
    message: `HermitCrab Writing ${downloaded} is ready to install.`,
    detail: 'Restart now to update, or it will install the next time you quit.',
    buttons: ['Restart Now', 'Later'],
    defaultId: 0,
    cancelId: 1
  })
  if (response === 0) await installUpdate()
}

/** Close the windows, saving their edits, and restart into the downloaded update. */
export async function installUpdate(): Promise<void> {
  if (!downloaded || installing) return
  installing = true
  await closeWindows()
  autoUpdater.quitAndInstall()
}
