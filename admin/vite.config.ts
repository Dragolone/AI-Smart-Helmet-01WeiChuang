import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // 本地联调：前端 5173 → 后端 3000，生产由反向代理承担同一职责
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
})
