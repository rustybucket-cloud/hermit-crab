import type { CapacitorConfig } from '@capacitor/cli'

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
    }
  }
}

export default config
