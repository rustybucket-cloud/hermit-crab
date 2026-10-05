/// <reference types="vite/client" />
import type { HermitApi } from '../../shared/types'

declare global {
  interface Window {
    hermit: HermitApi
  }
}
