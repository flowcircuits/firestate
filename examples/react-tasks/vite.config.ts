import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@hvakr/firestate': new URL('../../src/index.ts', import.meta.url).pathname,
    },
  },
})
