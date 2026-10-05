import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    // marked is ESM-only; bundle it rather than require() it at runtime.
    build: { externalizeDeps: { exclude: ['marked'] } }
  },
  preload: {},
  renderer: {
    plugins: [react()]
  }
})
