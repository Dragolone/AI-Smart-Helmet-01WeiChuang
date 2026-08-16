import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // @helmet/shared 是 workspace 链接包且编译为 CommonJS（后端 Nest 要求 CJS）：
  // Vite dev 默认不预打包链接包、把 CJS 原样喂给浏览器 → 运行时白屏。
  // 官方配方：强制预打包（dev） + 让 Rollup 的 CJS 转换覆盖它（build）。
  // 只导入类型时不会触发（编译期抹除），首个运行时值导入（如 EVENT_TYPES）就会踩中。
  optimizeDeps: {
    include: ['@helmet/shared'],
  },
  build: {
    commonjsOptions: {
      include: [/packages\/shared/, /node_modules/],
    },
  },
  server: {
    // 本地联调：前端 5173 → 后端 3000，生产由反向代理承担同一职责
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
})
