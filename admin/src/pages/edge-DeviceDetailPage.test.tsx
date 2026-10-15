// 设备详情页边界：加载中 / 404 / 报错重试 / 刷新失败、各描述项的 null / 0 / 100 / 充电 / 未绑定 / 已注销分支、
// 最近事件为空与展开 payload、返回按钮、30 秒轮询。
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { Route, Routes } from 'react-router-dom'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { getToken, saveSession } from '../api/client'
import { ERROR_BANNER, clickRetry, deviceDetail, event, pending, stubApi, tablePlaceholder } from '../test/fixtures'
import { jsonResponse, renderWithProviders, textResponse } from '../test/render'
import DeviceDetailPage from './DeviceDetailPage'

beforeAll(() => {
  vi.stubEnv('TZ', 'Asia/Shanghai')
})
afterAll(() => {
  vi.unstubAllEnvs()
})
afterEach(() => {
  vi.useRealTimers()
})

const renderDetail = (history: string | string[]) =>
  renderWithProviders(
    <Routes>
      <Route path="/devices" element={<div>设备列表页</div>} />
      <Route path="/devices/:deviceId" element={<DeviceDetailPage />} />
    </Routes>,
    history,
  )

/** 描述列表里某一项的内容文本 */
const descItem = (label: string): string | null | undefined => {
  const th = Array.from(document.querySelectorAll('.ant-descriptions-item-label')).find(
    (el) => el.textContent === label,
  )
  if (!th) throw new Error(`找不到描述项「${label}」`)
  return th.nextElementSibling?.textContent
}

describe('DeviceDetailPage：加载 / 错误', () => {
  it('加载中：卡片骨架屏，不出标题与错误横幅；请求路径带 /api/v1 前缀', async () => {
    const apiStub = stubApi(() => pending())
    renderDetail('/devices/helmet_001')
    await waitFor(() => expect(apiStub.count()).toBe(1))
    expect(apiStub.rawLast()).toBe('/api/v1/admin/devices/helmet_001')
    expect(document.querySelector('.ant-card-loading, .ant-skeleton')).not.toBeNull()
    expect(screen.queryByText(/设备详情：/)).not.toBeInTheDocument()
    expect(screen.queryByText(ERROR_BANNER)).not.toBeInTheDocument()
  })

  it('设备不存在（404 NOT_FOUND）→ 横幅带 code，标题仍显示所查的 ID，不出描述项；会话不动', async () => {
    saveSession('tok_keep', 'ops')
    stubApi(() => jsonResponse(404, { code: 'NOT_FOUND', message: '设备不存在', requestId: 'req_1' }))
    renderDetail('/devices/helmet_404')
    expect(await screen.findByText('NOT_FOUND（HTTP 404）')).toBeInTheDocument()
    expect(screen.getByText('设备详情：helmet_404')).toBeInTheDocument()
    expect(document.querySelector('.ant-descriptions')).toBeNull()
    expect(getToken()).toBe('tok_keep')
  })

  it('接口 500 → 横幅；点重试成功后横幅消失、出详情', async () => {
    const apiStub = stubApi((_url, call) =>
      call === 1 ? textResponse(500, 'Internal Server Error') : jsonResponse(200, deviceDetail({ online: true })),
    )
    renderDetail('/devices/helmet_001')
    expect(await screen.findByText('UNKNOWN_ERROR（HTTP 500）')).toBeInTheDocument()
    clickRetry()
    await waitFor(() => expect(document.querySelector('.ant-descriptions')).not.toBeNull())
    expect(apiStub.count()).toBe(2)
    expect(screen.queryByText(ERROR_BANNER)).not.toBeInTheDocument()
    expect(descItem('状态')).toBe('在线')
  })

  it('断网 → 横幅显示原始错误信息', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    renderDetail('/devices/helmet_001')
    expect(await screen.findByText('Failed to fetch')).toBeInTheDocument()
    expect(screen.getByText(ERROR_BANNER)).toBeInTheDocument()
  })

  it('已显示详情后刷新失败 → 横幅 + 隐藏旧详情，不把旧数据当成当前状态', async () => {
    let healthy = true
    stubApi(() => (healthy ? jsonResponse(200, deviceDetail({ online: true })) : textResponse(503, 'busy')))
    renderDetail('/devices/helmet_001')
    await waitFor(() => expect(document.querySelector('.ant-descriptions')).not.toBeNull())

    healthy = false
    fireEvent(window, new Event('visibilitychange'))
    expect(await screen.findByText('UNKNOWN_ERROR（HTTP 503）')).toBeInTheDocument()
    expect(document.querySelector('.ant-descriptions')).toBeNull()
    expect(screen.queryByText('在线')).not.toBeInTheDocument()
  })
})

describe('DeviceDetailPage：描述项', () => {
  it('全空的新设备：离线 / 电量 — / 固件 — / 未绑定 / 最后在线 — / 绑定时间 — / 全部出厂默认 / 最近事件空状态', async () => {
    stubApi(() => jsonResponse(200, deviceDetail({})))
    renderDetail('/devices/helmet_001')
    await waitFor(() => expect(document.querySelector('.ant-descriptions')).not.toBeNull())
    expect(descItem('状态')).toBe('离线')
    expect(descItem('电量')).toBe('—')
    expect(descItem('固件版本')).toBe('—')
    expect(descItem('绑定用户')).toBe('未绑定')
    expect(descItem('最后在线')).toBe('—')
    expect(descItem('绑定时间')).toBe('—')
    expect(descItem('当前生效设置')).toBe('全部为出厂默认')
    expect(tablePlaceholder()).toHaveTextContent('暂无数据')
  })

  it('电量 0 + 充电 →「0% ⚡」（0 不是空值）；电量 100 未充电 →「100%」', async () => {
    let battery = 0
    let charging = true
    stubApi(() => jsonResponse(200, deviceDetail({ battery, charging })))
    renderDetail('/devices/helmet_001')
    await waitFor(() => expect(descItem('电量')).toBe('0% ⚡'))
    battery = 100
    charging = false
    fireEvent(window, new Event('visibilitychange'))
    await waitFor(() => expect(descItem('电量')).toBe('100%'))
  })

  it('绑定账号已注销 →「已注销（昵称）」；时间按北京时间；改过的设置列出中文名', async () => {
    stubApi(() =>
      jsonResponse(
        200,
        deviceDetail({
          online: true,
          firmwareVersion: '2.0.0-rc.1',
          lastSeenAt: '2026-09-30T16:00:00.000Z',
          boundAt: '2026-09-01T00:00:00.000Z',
          bindUser: { id: 'u_9', phone: 'deleted:u_9', nickname: '老王' },
          settings: { volume: 70 },
        }),
      ),
    )
    renderDetail('/devices/helmet_001')
    await waitFor(() => expect(document.querySelector('.ant-descriptions')).not.toBeNull())
    expect(descItem('固件版本')).toBe('2.0.0-rc.1')
    expect(descItem('绑定用户')).toBe('已注销（老王）')
    expect(descItem('最后在线')).toBe('2026-10-01 00:00:00')
    expect(descItem('绑定时间')).toBe('2026-09-01 08:00:00')
    expect(descItem('当前生效设置')).toBe('蜂鸣音量 70%其余 13 项为出厂默认')
    expect(screen.queryByText(/deleted:/)).not.toBeInTheDocument()
  })

  it('绑定用户无昵称 → 只显示手机号', async () => {
    stubApi(() => jsonResponse(200, deviceDetail({ bindUser: { id: 'u_1', phone: '13800001111', nickname: null } })))
    renderDetail('/devices/helmet_001')
    await waitFor(() => expect(descItem('绑定用户')).toBe('13800001111'))
  })

  it('settings 为 null（老设备从未下发）→ 当作全部出厂默认，不白屏', async () => {
    stubApi(() => jsonResponse(200, { ...deviceDetail({}), settings: null }))
    renderDetail('/devices/helmet_001')
    await waitFor(() => expect(descItem('当前生效设置')).toBe('全部为出厂默认'))
  })

  it('64 字符的 deviceId 在标题里整段显示', async () => {
    const longId = `helmet_${'f'.repeat(57)}`
    stubApi(() => jsonResponse(200, deviceDetail({ deviceId: longId })))
    renderDetail(`/devices/${longId}`)
    expect(await screen.findByText(`设备详情：${longId}`)).toBeInTheDocument()
  })
})

describe('DeviceDetailPage：最近事件', () => {
  it('事件行显示接收时间（北京时间）/ 类型 / 摘要 / 来源；含校验失败留档；展开看原样 payload', async () => {
    stubApi(() =>
      jsonResponse(
        200,
        deviceDetail({
          recentEvents: [
            event({
              eventId: 'e2',
              eventType: '_invalid',
              summary: '校验失败',
              source: 'mqtt',
              payload: { reason: 'schema', raw: null },
            }),
            event({ eventId: 'e1', receivedAt: '2026-09-30T16:00:00.000Z', payload: {} }),
          ],
        }),
      ),
    )
    renderDetail('/devices/helmet_001')
    const invalidRow = (await screen.findByText('_invalid')).closest('tr') as HTMLElement
    const cells = Array.from(invalidRow.querySelectorAll('td')).map((td) => td.textContent)
    // 第 0 列是展开按钮
    expect(cells.slice(1)).toEqual(['2026-09-18 00:30:05', '_invalid', '校验失败', 'mqtt'])

    fireEvent.click(invalidRow.querySelector('button.ant-table-row-expand-icon') as HTMLElement)
    expect(JSON.parse(document.querySelector('pre')?.textContent ?? '')).toEqual({ reason: 'schema', raw: null })

    const emptyRow = screen.getByText('2026-10-01 00:00:00').closest('tr') as HTMLElement
    fireEvent.click(emptyRow.querySelector('button.ant-table-row-expand-icon') as HTMLElement)
    const pres = Array.from(document.querySelectorAll('pre')).map((p) => p.textContent)
    expect(pres).toContain('{}')
  })
})

describe('DeviceDetailPage：导航与轮询', () => {
  it('从列表点进来 → 「返回」回到列表', async () => {
    stubApi(() => jsonResponse(200, deviceDetail({})))
    renderDetail(['/devices', '/devices/helmet_001'])
    await screen.findByText('设备详情：helmet_001')
    fireEvent.click(screen.getByText(/返\s?回/).closest('button') as HTMLElement)
    expect(await screen.findByText('设备列表页')).toBeInTheDocument()
  })

  it('路由里没有 deviceId → 不发请求（查询被禁用），只剩空标题', async () => {
    const apiStub = stubApi(() => jsonResponse(200, deviceDetail({})))
    renderWithProviders(<DeviceDetailPage />, '/devices')
    expect(await screen.findByText('设备详情：')).toBeInTheDocument()
    expect(apiStub.count()).toBe(0)
  })

  it('停留在详情页每 30 秒自动刷新一次', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const apiStub = stubApi(() => jsonResponse(200, deviceDetail({})))
    renderDetail('/devices/helmet_001')
    await screen.findByText('设备详情：helmet_001')
    expect(apiStub.count()).toBe(1)
    await vi.advanceTimersByTimeAsync(30_500)
    await waitFor(() => expect(apiStub.count()).toBe(2))
  })
})
