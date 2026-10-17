/// <reference types="vite/client" />
import type { DeskApi } from '../../shared/types'

declare global {
  interface Window {
    desk: DeskApi
  }
}
