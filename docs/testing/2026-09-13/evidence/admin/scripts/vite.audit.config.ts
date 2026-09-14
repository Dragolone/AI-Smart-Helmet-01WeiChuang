// 审计专用 Vite 配置：复用 admin/vite.config.ts，仅把 /api 代理指到审计后端端口（本机 3000 被其他项目容器占用）
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: '/Users/dravenzhong/Desktop/AI-Smart-Helmet-01WeiChuang/admin',
  plugins: [react()],
  optimizeDeps: { include: ['@helmet/shared'] },
  build: { commonjsOptions: { include: [/packages\/shared/, /node_modules/] } },
  server: {
    host: '127.0.0.1',
    proxy: { '/api': 'http://127.0.0.1:3010' },
  },
})
