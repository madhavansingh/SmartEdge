import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,           // bind to 0.0.0.0 so phone on same Wi-Fi can connect
    port: 5173,
    allowedHosts: 'all',  // allow ngrok / any tunnel URL (*.ngrok-free.app, etc.)
    proxy: {
      // All /api/* requests are forwarded to the FastAPI backend.
      // Vite forwards server-side so the phone never needs to reach :8000 directly.
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
})
