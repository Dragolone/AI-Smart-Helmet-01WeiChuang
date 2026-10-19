import { StyleProvider } from '@ant-design/cssinjs'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from '@testing-library/react'
import { App as AntdApp, ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'

/**
 * 与 main.tsx 同一套 Provider 栈；重试关掉让失败用例立刻落到 isError。
 * route 传数组时是一段浏览历史（停在最后一条），用来测「返回」这类依赖历史的行为。
 *
 * 最外层的 StyleProvider mock="server" 让 antd 的 cssinjs 不往 document.head 注样式表（cssinjs 自带的测试开关，
 * 生产构建不生效）。jsdom 算 getComputedStyle 时要拿文档里全部样式规则对元素逐条 matches，antd 一页注进来
 * 二十多张表、近千条规则后一次就要 20–90 ms：getByRole 对子树每个元素都算一次，antd Select 展开下拉给浮层对齐时
 * 也要算好几次，一条用例因此拖到 1–3 s，CI 的 4 核 runner 再慢 3–4 倍就撞上 vitest 默认的 5 s 超时
 * （2026-10-19 三条不碰 admin 的 PR 重跑 CI，admin 随机红的就是这些用例）。
 * 这里的测试只断言 DOM 结构、class 与文本，jsdom 也不排版，样式表不参与任何断言。
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
    <StyleProvider mock="server">
      <ConfigProvider locale={zhCN}>
        <AntdApp>
          <QueryClientProvider client={client}>
            <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
              {ui}
            </MemoryRouter>
          </QueryClientProvider>
        </AntdApp>
      </ConfigProvider>
    </StyleProvider>,
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
