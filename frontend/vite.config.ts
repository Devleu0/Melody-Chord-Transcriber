import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  // Backend address for the dev proxy (override with YTAMT_BACKEND, e.g. to run a second instance)
  const backend = loadEnv(mode, '.', '').YTAMT_BACKEND || 'http://127.0.0.1:8000'
  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        '/api': backend,
        '/files': backend,
      },
    },
  }
})
