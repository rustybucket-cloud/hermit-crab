import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

// The iOS app: the desktop's renderer, with src/mobile supplying `window.hermit`. Capacitor serves out/mobile.
export default defineConfig({
  root: resolve(__dirname, 'src/mobile'),
  base: './',
  plugins: [react()],
  // Pre-bundling moves Harper's code away from its .wasm file, which it finds by relative URL.
  optimizeDeps: { exclude: ['harper.js'] },
  build: {
    outDir: resolve(__dirname, 'out/mobile'),
    emptyOutDir: true,
    target: 'safari16'
  }
})
