import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { App as AntdApp, ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App.tsx'
import './index.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      // 保持默认的窗口聚焦自动刷新：设备在线状态等切回页面即取最新，
      // 且 30s 轮询在标签页失焦时会暂停，聚焦刷新是它的补位
    },
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ConfigProvider locale={zhCN}>
      <AntdApp>
        <QueryClientProvider client={queryClient}>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </QueryClientProvider>
      </AntdApp>
    </ConfigProvider>
  </StrictMode>,
)
