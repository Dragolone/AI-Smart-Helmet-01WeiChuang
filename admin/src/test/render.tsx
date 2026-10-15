import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from '@testing-library/react'
import { App as AntdApp, ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'

/**
 * 与 main.tsx 同一套 Provider 栈；重试关掉让失败用例立刻落到 isError。
 * route 传数组时是一段浏览历史（停在最后一条），用来测「返回」这类依赖历史的行为
 */
export function renderWithProviders(ui: ReactElement, route: string | string[] = '/') {
  const entries = Array.isArray(route) ? route : [route]
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  })
  return render(
    <ConfigProvider locale={zhCN}>
      <AntdApp>
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
            {ui}
          </MemoryRouter>
        </QueryClientProvider>
      </AntdApp>
    </ConfigProvider>,
  )
}

/** 造一个 fetch 响应：JSON 体或纯文本（模拟网关 502 之类的非 JSON 错误） */
export const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

export const textResponse = (status: number, body: string): Response =>
  new Response(body, { status, headers: { 'content-type': 'text/html' } })
