import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Full Rovai application shell for visual inspection: the production BusinessApp,
// production stylesheets and the repository's in-memory adapter. No Core, no Runtime.
export default defineConfig({
  root: resolve(import.meta.dirname, '../mission-board'),
  plugins: [react()],
  resolve: { alias: { '@contracts': resolve(import.meta.dirname, '../../../packages/contracts/src/index.ts') } },
  server: { host: '127.0.0.1', port: 54093, strictPort: true, fs: { allow: [resolve(import.meta.dirname, '../../..')] } }
})
