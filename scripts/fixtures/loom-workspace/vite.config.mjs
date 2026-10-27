import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Browser-only inspection of the production LOOM component; no Core or Runtime.
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@contracts': resolve(import.meta.dirname, '../../../packages/contracts/src/index.ts') } },
  server: { host: '127.0.0.1', port: 54092, strictPort: true }
})
