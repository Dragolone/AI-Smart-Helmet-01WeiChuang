import { screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { jsonResponse, renderWithProviders, textResponse } from '../test/render'
import OverviewPage from './OverviewPage'

describe('OverviewPage（审计 ADMIN-01：故障不能显示成全 0）', () => {
  it('接口 500 → 错误横幅 + 五个指标显示「—」', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(textResponse(500, 'Internal Server Error')))
    renderWithProviders(<OverviewPage />)
    expect(await screen.findByText('加载失败，当前显示的不是真实数据')).toBeInTheDocument()
    expect(screen.getAllByText('—')).toHaveLength(5)
    expect(screen.queryByText('0')).not.toBeInTheDocument()
  })

  it('接口正常 → 显示真实数字与统计时间', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          deviceTotal: 12,
          deviceOnline: 3,
          userTotal: 40,
          todayEvents: 0,
          activeSos: 1,
          generatedAt: '2026-09-18T01:00:00.000Z',
        }),
      ),
    )
    renderWithProviders(<OverviewPage />)
    expect(await screen.findByText('12')).toBeInTheDocument()
    expect(screen.getByText('3')).toBeInTheDocument()
    expect(screen.getByText('40')).toBeInTheDocument()
    expect(screen.getByText('0')).toBeInTheDocument() // 0 是合法业务值，只有故障才显示「—」
    expect(screen.queryByText('—')).not.toBeInTheDocument()
    expect(screen.getByText(/统计时间：/)).toBeInTheDocument()
  })
})
