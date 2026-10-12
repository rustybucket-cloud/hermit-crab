import { App } from '@capacitor/app'
import { Capacitor, CapacitorHttp } from '@capacitor/core'
import { Preferences } from '@capacitor/preferences'
import { CapacitorUpdater } from '@capgo/capacitor-updater'

/** This bundle's version (scripts/bundle-version.ts). Development builds don't have one. */
const BUNDLE_VERSION = document.querySelector<HTMLMetaElement>('meta[name="bundle-version"]')?.content ?? null

/** Published by scripts/ios-update.sh. */
const MANIFEST_URL = 'https://github.com/rustybucket-cloud/hermit-crab/releases/download/ios-web/ios-web.json'
const CHECK_EVERY = 4 * 60 * 60 * 1000
const KEYS = {
  /** A downloaded bundle's id, to switch to when the app next starts. */
  next: 'update.next',
  /** The version last switched to, so one that failed to start isn't downloaded again. */
  tried: 'update.tried'
}

interface Manifest {
  version: string
  url: string
  /** The zip's SHA-256, in hex. */
  sha256: string
}

/** A version's commit time, which orders versions, and the native code it was built for. */
function parse(version: string | null | undefined): { time: string; native: string } | null {
  const match = version?.match(/^(\d{14})-[0-9a-f]+-([0-9a-f]{12})$/)
  return match ? { time: match[1], native: match[2] } : null
}

/** What's left to do once the page has started reloading into another bundle. */
const reloading = () => new Promise<never>(() => {})

/**
 * Runs before the app starts. Switches to the update downloaded last time, if there is one; or back to the bundle
 * built into the app if that's newer than the downloaded one running, as after a development build. Both reload
 * the page.
 */
export async function applyUpdate(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return
  try {
    const { value: next } = await Preferences.get({ key: KEYS.next })
    if (next) {
      await Preferences.remove({ key: KEYS.next })
      const bundle = (await CapacitorUpdater.list()).bundles.find((b) => b.id === next)
      if (bundle) {
        await Preferences.set({ key: KEYS.tried, value: bundle.version })
        // If it doesn't reach startUpdater, Capgo goes back to this bundle.
        await CapacitorUpdater.set({ id: bundle.id })
        return reloading()
      }
    }
    const { bundle } = await CapacitorUpdater.current()
    if (bundle.id === 'builtin') return
    const builtin = parse((await CapacitorUpdater.getBuiltinVersion()).version)
    const self = parse(BUNDLE_VERSION)
    if (!builtin || !self || builtin.native !== self.native || builtin.time >= self.time) {
      await CapacitorUpdater.reset()
      return reloading()
    }
  } catch (err) {
    console.error('Couldn’t apply the update', err)
  }
}

/**
 * Runs once the app has started. Tells Capgo this bundle works, so it's kept, then checks for updates a little
 * after launch and when the app comes back after a few hours.
 */
export function startUpdater(): void {
  if (!Capacitor.isNativePlatform()) return
  void CapacitorUpdater.notifyAppReady()
  let last = 0
  const check = () => {
    if (Date.now() - last < CHECK_EVERY) return
    last = Date.now()
    downloadUpdate().catch((err) => console.error('Update failed', err))
  }
  setTimeout(check, 10_000)
  void App.addListener('appStateChange', ({ isActive }) => isActive && check())
}

/** Downloads a newer bundle, if one's been published for this app's native code, for the app's next start. */
async function downloadUpdate(): Promise<void> {
  const builtin = parse((await CapacitorUpdater.getBuiltinVersion()).version)
  const self = parse(BUNDLE_VERSION)
  if (!builtin || !self) return

  const response = await CapacitorHttp.get({ url: MANIFEST_URL, headers: { 'Cache-Control': 'no-cache' } })
  if (response.status !== 200) throw new Error(`The update manifest responded ${response.status}`)
  // GitHub serves release files as binary, so the response may not have been read as JSON.
  const manifest: Manifest = typeof response.data === 'string' ? JSON.parse(response.data) : response.data
  const update = parse(manifest.version)
  if (!update || update.native !== builtin.native || update.time <= self.time) return
  const { value: tried } = await Preferences.get({ key: KEYS.tried })
  if (tried === manifest.version) return

  const { bundles } = await CapacitorUpdater.list()
  const bundle =
    bundles.find((b) => b.version === manifest.version && (b.status === 'pending' || b.status === 'success')) ??
    // Capgo throws away a zip that doesn't match the checksum.
    (await CapacitorUpdater.download({ url: manifest.url, version: manifest.version, checksum: manifest.sha256 }))
  // Keep only the bundle running and the one to run next.
  const { bundle: current } = await CapacitorUpdater.current()
  for (const old of bundles) {
    if (old.id !== bundle.id && old.id !== current.id && old.id !== 'builtin') {
      await CapacitorUpdater.delete({ id: old.id }).catch(() => {})
    }
  }
  await Preferences.set({ key: KEYS.next, value: bundle.id })
}
