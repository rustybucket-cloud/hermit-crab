import { app, dialog } from 'electron'
import { autoUpdater } from 'electron-updater'

const CHECK_EVERY = 4 * 60 * 60 * 1000

let closeWindows: () => Promise<void>
/** The version waiting to install, once it's downloaded. */
let downloaded: string | null = null
/** The version the user was last asked about, so a periodic check doesn't ask again. */
let offered: string | null = null
let installing = false

/**
 * Checks GitHub Releases for a newer version on launch and every few hours, downloads it
 * in the background, and offers to restart into it. Declined updates install on quit.
 * `close` closes the windows, saving their edits, before the app restarts.
 */
export function startUpdater(close: () => Promise<void>): void {
  if (!app.isPackaged) return
  closeWindows = close
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('update-downloaded', (info) => {
    downloaded = info.version
    if (offered !== info.version) void offerRestart()
  })
  autoUpdater.on('error', (err) => console.error('Update failed', err))
  const check = () => autoUpdater.checkForUpdates().catch(() => {}) // the error event logs it
  setTimeout(check, 10_000)
  setInterval(check, CHECK_EVERY)
}

/** Whether the app is quitting to install an update, so closing the last window mustn't quit it first. */
export function isInstallingUpdate(): boolean {
  return installing
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
  if (response !== 0) return
  installing = true
  await closeWindows()
  autoUpdater.quitAndInstall()
}
