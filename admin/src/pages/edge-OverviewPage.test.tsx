// 概览页边界：加载中、报错重试、进行中 SOS 标红的阈值、统计时间按北京时间、刷新失败后指标退回「—」、15 秒轮询
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AdminStatsOverview } from '@helmet/shared'
import { ERROR_BANNER, clickRetry, pending, stubApi } from '../test/fixtures'
import { jsonResponse, renderWithProviders, textResponse } from '../test/render'
import OverviewPage from './OverviewPage'

beforeAll(() => {
  vi.stubEnv('TZ', 'Asia/Shanghai')
})
afterAll(() => {
  vi.unstubAllEnvs()
})
afterEach(() => {
  vi.useRealTimers()
})

const stats = (over: Partial<AdminStatsOverview>): AdminStatsOverview => ({
  deviceTotal: 12,
  deviceOnline: 3,
  userTotal: 40,
  todayEvents: 7,
  activeSos: 0,
  generatedAt: '2026-09-18T01:00:00.000Z',
  ...over,
})

/** 某个指标卡的数值元素 */
const valueOf = (title: string): HTMLElement => {
  const card = screen.getByText(title).closest('.ant-statistic') as HTMLElement
  return card.querySelector('.ant-statistic-content') as HTMLElement
}

describe('OverviewPage：边界', () => {
  it('加载中：卡片骨架屏，不出错误横幅', async () => {
    const apiStub = stubApi(() => pending())
    renderWithProviders(<OverviewPage />)
    await waitFor(() => expect(apiStub.count()).toBe(1))
    expect(document.querySelector('.ant-card-loading, .ant-skeleton')).not.toBeNull()
    expect(screen.queryByText(ERROR_BANNER)).not.toBeInTheDocument()
  })

  it('接口 500 → 横幅；点重试成功后出真实数字', async () => {
    const apiStub = stubApi((_url, call) =>
      call === 1 ? jsonResponse(500, { code: 'INTERNAL_ERROR', message: 'x' }) : jsonResponse(200, stats({})),
    )
    renderWithProviders(<OverviewPage />)
    expect(await screen.findByText('INTERNAL_ERROR（HTTP 500）')).toBeInTheDocument()
    clickRetry()
    expect(await screen.findByText('12')).toBeInTheDocument()
    expect(apiStub.count()).toBe(2)
    expect(screen.queryByText(ERROR_BANNER)).not.toBeInTheDocument()
  })

  it('进行中 SOS 为 0 不标红；为 1 时标红（保命指标）', async () => {
    let activeSos = 0
    stubApi(() => jsonResponse(200, stats({ activeSos })))
    renderWithProviders(<OverviewPage />)
    await screen.findByText('12')
    expect(valueOf('进行中 SOS')).not.toHaveStyle({ color: '#cf1322' })

    activeSos = 1
    fireEvent(window, new Event('visibilitychange'))
    await waitFor(() => expect(valueOf('进行中 SOS')).toHaveStyle({ color: '#cf1322' }))
    expect(valueOf('进行中 SOS')).toHaveTextContent('1')
  })

  it('统计时间按北京时间显示，并注明「今日」的口径', async () => {
    stubApi(() => jsonResponse(200, stats({ generatedAt: '2026-09-30T16:00:00.000Z' })))
    renderWithProviders(<OverviewPage />)
    expect(await screen.findByText(/统计时间：2026-10-01 00:00:00/)).toHaveTextContent('「今日」按北京时间自然日计')
  })

  it('显示过数字后刷新失败 → 五个指标退回「—」、统计时间消失，不留旧数字', async () => {
    let healthy = true
    stubApi(() => (healthy ? jsonResponse(200, stats({})) : textResponse(502, 'Bad Gateway')))
    renderWithProviders(<OverviewPage />)
    await screen.findByText('12')
    healthy = false
    fireEvent(window, new Event('visibilitychange'))
    expect(await screen.findByText('UNKNOWN_ERROR（HTTP 502）')).toBeInTheDocument()
    expect(screen.getAllByText('—')).toHaveLength(5)
    expect(screen.queryByText('12')).not.toBeInTheDocument()
    expect(screen.queryByText(/统计时间：/)).not.toBeInTheDocument()
  })

  it('每 15 秒自动刷新一次', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const apiStub = stubApi(() => jsonResponse(200, stats({})))
    renderWithProviders(<OverviewPage />)
    await screen.findByText('12')
    expect(apiStub.count()).toBe(1)
    await vi.advanceTimersByTimeAsync(15_500)
    await waitFor(() => expect(apiStub.count()).toBe(2))
  })
})
