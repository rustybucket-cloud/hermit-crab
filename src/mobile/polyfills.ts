import { Buffer } from 'buffer'

// isomorphic-git expects Node's Buffer.
;(globalThis as { Buffer?: typeof Buffer }).Buffer ??= Buffer
