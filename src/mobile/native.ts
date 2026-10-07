import { registerPlugin } from '@capacitor/core'

/** One entry in a folder, as `lstat` sees it. Times are in milliseconds. */
export interface NativeEntry {
  name: string
  type: 'file' | 'directory' | 'other'
  size: number
  mtime: number
  ctime: number
}

/**
 * The app's own native plugin (ios/App/App/HermitNativePlugin.swift). File calls take absolute paths and
 * fail with POSIX-style codes such as `ENOENT`, so the library and git code can treat them like Node's.
 */
export interface HermitNativePlugin {
  readFile(options: { path: string; encoding?: 'utf8' }): Promise<{ data: string }>
  /** Without an encoding, `data` is base64. Writes go through a temporary file, so they're atomic. */
  writeFile(options: { path: string; data: string; encoding?: 'utf8' }): Promise<void>
  readdir(options: { path: string }): Promise<{ entries: NativeEntry[] }>
  stat(options: { path: string }): Promise<NativeEntry>
  mkdir(options: { path: string; recursive?: boolean }): Promise<void>
  /** POSIX rename: replaces a file already at `to`. */
  rename(options: { from: string; to: string }): Promise<void>
  unlink(options: { path: string }): Promise<void>
  rmdir(options: { path: string }): Promise<void>
  /** Remove a file or folder and everything in it; nothing happens if it's not there. */
  remove(options: { path: string }): Promise<void>

  /** The app's Documents folder, which the Files app shows as “On My iPhone › Hermit Crab”. */
  documentsPath(): Promise<{ path: string }>
  /** Somewhere private to the app, for things like the sync repository. */
  supportPath(): Promise<{ path: string }>
  /** Ask the user for a folder, such as one in iCloud Drive, and keep access to it. */
  pickFolder(): Promise<{ path: string | null }>
  /** The folder chosen last time, if there is one and it can still be opened. */
  restoreFolder(): Promise<{ path: string | null }>
  forgetFolder(): Promise<void>
  /** Ask iCloud to download everything in a folder, so it's there to read offline. */
  downloadFolder(options: { path: string }): Promise<void>

  getSecret(options: { key: string }): Promise<{ value: string | null }>
  setSecret(options: { key: string; value: string }): Promise<void>
  deleteSecret(options: { key: string }): Promise<void>

  /** Lay out an HTML page on paper and save it as a PDF. Margins are in inches. Resolves with the file's path. */
  printPdf(options: {
    html: string
    paper: 'letter' | 'auto'
    margins: { top: number; right: number; bottom: number; left: number }
  }): Promise<{ path: string }>

  /** Ask for a little time to finish work, such as a sync, after the app goes into the background. */
  beginBackgroundTask(): Promise<{ id: number }>
  endBackgroundTask(options: { id: number }): Promise<void>
}

export const native = registerPlugin<HermitNativePlugin>('HermitNative')

/** The code a native call failed with, such as `ENOENT`. */
export const errorCode = (err: unknown): string | undefined => (err as { code?: string } | null)?.code
