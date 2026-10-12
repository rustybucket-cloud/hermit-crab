import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import { bundleVersion } from './scripts/bundle-version'

// The iOS app: the desktop's renderer, with src/mobile supplying `window.hermit`. Capacitor serves out/mobile.
export default defineConfig({
  root: resolve(__dirname, 'src/mobile'),
  base: './',
  plugins: [
    react(),
    {
      // Release builds name their version in index.html, for live updates (scripts/bundle-version.ts). Kept out of
      // the scripts, their file names only change with the code, so scripts/ios-update.sh can tell when nothing has.
      name: 'bundle-version',
      transformIndexHtml: () =>
        process.env.IOS_RELEASE
          ? [{ tag: 'meta', attrs: { name: 'bundle-version', content: bundleVersion(__dirname) }, injectTo: 'head' }]
          : []
    }
  ],
  // Pre-bundling moves Harper's code away from its .wasm file, which it finds by relative URL.
  optimizeDeps: { exclude: ['harper.js'] },
  build: {
    outDir: resolve(__dirname, 'out/mobile'),
    emptyOutDir: true,
    target: 'safari16'
  }
})
