import type { CapacitorConfig } from '@capacitor/cli'
import { bundleVersion } from './scripts/bundle-version'

const config: CapacitorConfig = {
  appId: 'com.rustybucket.hermitcrab',
  appName: 'HermitCrab Writing',
  webDir: 'out/mobile',
  // Bridge logging prints every file the app reads and writes, which slows the app down a lot.
  loggingBehavior: 'none',
  ios: {
    // The page runs under the status bar and home indicator, and pads itself with the safe-area insets.
    contentInset: 'never'
  },
  plugins: {
    Keyboard: {
      // Shrink the page above the keyboard, so the editor and its formatting bar stay in view.
      resize: 'native',
      resizeOnFullScreen: true
    },
    // Live updates of the web bundle. The app finds and applies them itself (src/mobile/updates.ts),
    // so nothing goes to Capgo's servers.
    CapacitorUpdater: {
      autoUpdate: false,
      statsUrl: '',
      // A downloaded bundle that doesn't start in this long is rolled back. Cold starts can be slow.
      appReadyTimeout: 30_000,
      // On iOS this limits the whole download, not just the wait for it to start.
      responseTimeout: 120,
      // Release builds name the bundle built into the app, so a downloaded one can tell whether it's newer and was
      // built for this native code. Development builds don't, so they never take live updates.
      ...(process.env.IOS_RELEASE ? { version: bundleVersion(__dirname) } : {})
    }
  }
}

export default config
