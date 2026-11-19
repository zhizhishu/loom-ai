import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  resolve: {
    alias: {
      '@contracts': fileURLToPath(new URL('../../../packages/contracts/src/index.ts', import.meta.url)),
    },
  },
})
