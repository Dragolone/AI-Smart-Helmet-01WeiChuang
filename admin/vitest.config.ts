import { defineConfig, mergeConfig } from 'vitest/config'
import viteConfig from './vite.config'

// 复用 vite.config（@helmet/shared 的 CJS 预打包配置同样适用于测试）；jsdom 跑组件级测试
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'jsdom',
      setupFiles: ['./src/test/setup.ts'],
      include: ['src/**/*.test.{ts,tsx}'],
      css: false,
    },
  }),
)
