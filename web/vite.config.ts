import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The API runs on :4000 (server/); the dev server proxies /api and /health there so the
// browser never needs CORS and VITE_API_BASE can stay the relative "/api".
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:4000',
      '/health': 'http://localhost:4000',
    },
  },
})
