import { applyUpdate, startUpdater } from './updates'

// A live update takes over before the app starts, so the page never reloads under someone's writing.
await applyUpdate()
await import('./app')
startUpdater()
