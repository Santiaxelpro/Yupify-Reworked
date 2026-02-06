import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        // En desarrollo apuntar al backend local
        target: process.env.VITE_API_URL ? process.env.VITE_API_URL : 'http://localhost:3000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, '/api'),
        secure: false
      },
      '/health': {
        target: process.env.VITE_API_URL ? process.env.VITE_API_URL : 'http://localhost:3000',
        changeOrigin: true,
        secure: false
      }
    }
  }
})
