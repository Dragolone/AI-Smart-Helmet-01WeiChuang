// 设备列表页的状态与交互边界：加载中 / 报错重试 / 断网 / 空列表、搜索词编码、在线筛选的清除、
// 改每页条数回第 1 页、单元格的 0 / null / 100 / 充电分支、30 秒轮询。
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { Route, Routes } from 'react-router-dom'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AdminDeviceRow } from '@helmet/shared'
import { getToken, saveSession } from '../api/client'
import {
  ERROR_BANNER,
  byRole,
  cellsOf,
  changePageSize,
  clickRetry,
  device,
  deviceDetail,
  page,
  pending,
  search,
  stubApi,
  tablePlaceholder,
  tableSpinning,
} from '../test/fixtures'
import { jsonResponse, renderWithProviders, textResponse } from '../test/render'
import DeviceDetailPage from './DeviceDetailPage'
import DevicesPage from './DevicesPage'

const PLACEHOLDER = '按设备 ID / 绑定手机号搜索'

beforeAll(() => {
  vi.stubEnv('TZ', 'Asia/Shanghai')
})
afterAll(() => {
  vi.unstubAllEnvs()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('DevicesPage：加载 / 错误 / 空', () => {
  it('加载中：表格转圈，不出错误横幅，也不出「共 0 台设备」', async () => {
    const apiStub = stubApi(() => pending())
    renderWithProviders(<DevicesPage />)
    await waitFor(() => expect(apiStub.count()).toBe(1))
    expect(tableSpinning()).toBe(true)
    expect(screen.queryByText(ERROR_BANNER)).not.toBeInTheDocument()
    expect(screen.queryByText(/共 \d+ 台设备/)).not.toBeInTheDocument()
  })

  it('接口 500 → 横幅带 code 与状态码、表格不出行；点重试成功后横幅消失、出数据', async () => {
    const apiStub = stubApi((_url, call) =>
      call === 1
        ? jsonResponse(500, { code: 'INTERNAL_ERROR', message: 'boom', requestId: 'req_1' })
        : page([device({ deviceId: 'helmet_ok' })]),
    )
    renderWithProviders(<DevicesPage />)
    expect(await screen.findByText(ERROR_BANNER)).toBeInTheDocument()
    expect(screen.getByText('INTERNAL_ERROR（HTTP 500）')).toBeInTheDocument()
    expect(document.querySelectorAll('.ant-table-row')).toHaveLength(0)

    clickRetry()
    expect(await screen.findByText('helmet_ok')).toBeInTheDocument()
    expect(apiStub.count()).toBe(2)
    expect(screen.queryByText(ERROR_BANNER)).not.toBeInTheDocument()
  })

  it('断网（fetch 抛 TypeError）→ 横幅显示原始错误信息，会话不动', async () => {
    saveSession('tok_keep', 'ops')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    renderWithProviders(<DevicesPage />)
    expect(await screen.findByText(ERROR_BANNER)).toBeInTheDocument()
    expect(screen.getByText('Failed to fetch')).toBeInTheDocument()
    expect(getToken()).toBe('tok_keep')
  })

  it('网关回 502 HTML 页 → 横幅显示 UNKNOWN_ERROR（HTTP 502），不是 JSON 解析异常', async () => {
    stubApi(() => textResponse(502, '<html>Bad Gateway</html>'))
    renderWithProviders(<DevicesPage />)
    expect(await screen.findByText('UNKNOWN_ERROR（HTTP 502）')).toBeInTheDocument()
  })

  it('令牌过期（401）→ 清会话并跳登录页', async () => {
    const assign = vi.fn()
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, assign } as unknown as Location)
    saveSession('tok_expired', 'ops')
    stubApi(() => jsonResponse(401, { code: 'UNAUTHORIZED', message: 'token 过期' }))
    renderWithProviders(<DevicesPage />)
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/login'))
    expect(getToken()).toBeNull()
  })

  it('空列表：空状态 + 不出分页总数', async () => {
    const apiStub = stubApi(() => page<AdminDeviceRow>([], 0))
    renderWithProviders(<DevicesPage />)
    await waitFor(() => expect(apiStub.count()).toBe(1))
    await waitFor(() => expect(tablePlaceholder()).toHaveTextContent('暂无数据'))
    expect(screen.queryByText(/共 \d+ 台设备/)).not.toBeInTheDocument()
  })
})

describe('DevicesPage：搜索与筛选', () => {
  it('关键字中间的空格保留、首尾去掉；只有空格等于清空；`+` 编码成 %2B 不被后端读成空格', async () => {
    const apiStub = stubApi(() => page<AdminDeviceRow>([]))
    renderWithProviders(<DevicesPage />)
    await waitFor(() => expect(apiStub.count()).toBe(1))

    search(PLACEHOLDER, '  helmet 001  ')
    await waitFor(() => expect(apiStub.last().searchParams.get('keyword')).toBe('helmet 001'))

    search(PLACEHOLDER, '+86 138')
    await waitFor(() => expect(apiStub.last().searchParams.get('keyword')).toBe('+86 138'))
    expect(apiStub.rawLast()).toContain('keyword=%2B86+138')

    search(PLACEHOLDER, '   ')
    await waitFor(() => expect(apiStub.last().searchParams.has('keyword')).toBe(false))
  })

  it('LIKE 通配符与反斜杠、引号、尖括号、中文、emoji 原样作为一个参数发出（转义归后端）', async () => {
    const apiStub = stubApi(() => page<AdminDeviceRow>([]))
    renderWithProviders(<DevicesPage />)
    await waitFor(() => expect(apiStub.count()).toBe(1))
    const kw = `%_\\'"<script>头盔🪖`
    search(PLACEHOLDER, kw)
    await waitFor(() => expect(apiStub.last().searchParams.get('keyword')).toBe(kw))
    expect(Array.from(apiStub.last().searchParams.keys())).toEqual(['page', 'pageSize', 'keyword'])
  })

  it('64 字（后端上限）的关键字整段发出，不截断', async () => {
    const apiStub = stubApi(() => page<AdminDeviceRow>([]))
    renderWithProviders(<DevicesPage />)
    await waitFor(() => expect(apiStub.count()).toBe(1))
    const kw = 'h'.repeat(64)
    search(PLACEHOLDER, kw)
    await waitFor(() => expect(apiStub.last().searchParams.get('keyword')).toBe(kw))
  })

  it('点放大镜按钮与回车等价；点清除图标 → 关键字参数消失并回到第 1 页', async () => {
    const apiStub = stubApi(() => page([device({})], 45))
    renderWithProviders(<DevicesPage />)
    await screen.findByText('共 45 台设备')

    const input = screen.getByPlaceholderText(PLACEHOLDER)
    fireEvent.change(input, { target: { value: 'helmet' } })
    const searchBtn = document.querySelector('.ant-input-search [aria-label="search"]')?.closest('button')
    fireEvent.click(searchBtn as HTMLElement)
    await waitFor(() => expect(apiStub.last().searchParams.get('keyword')).toBe('helmet'))

    await screen.findByText('共 45 台设备')
    fireEvent.click(screen.getByTitle('2'))
    await waitFor(() => expect(apiStub.last().searchParams.get('page')).toBe('2'))

    fireEvent.click(document.querySelector('.ant-input-clear-icon') as HTMLElement)
    await waitFor(() => expect(apiStub.last().searchParams.has('keyword')).toBe(false))
    expect(apiStub.last().searchParams.get('page')).toBe('1')
  })

  it('在线筛选选「在线」→ online=true；再清除 → online 参数消失', async () => {
    const apiStub = stubApi(() => page([device({})], 1))
    renderWithProviders(<DevicesPage />)
    await screen.findByText('共 1 台设备')
    fireEvent.mouseDown(byRole('combobox'))
    fireEvent.click(await screen.findByTitle('在线'))
    await waitFor(() => expect(apiStub.last().searchParams.get('online')).toBe('true'))

    await screen.findByText('共 1 台设备')
    const select = byRole('combobox').closest('.ant-select') as HTMLElement
    fireEvent.mouseEnter(select)
    fireEvent.mouseDown(select.querySelector('.ant-select-clear') as HTMLElement)
    fireEvent.click(select.querySelector('.ant-select-clear') as HTMLElement)
    await waitFor(() => expect(apiStub.last().searchParams.has('online')).toBe(false))
  })
})

describe('DevicesPage：分页', () => {
  it('停在第 3 页时改成 50 条/页 → 回第 1 页；之后翻页保留新的条数', async () => {
    const apiStub = stubApi(() => page([device({})], 200))
    renderWithProviders(<DevicesPage />)
    await screen.findByText('共 200 台设备')
    fireEvent.click(screen.getByTitle('3'))
    await waitFor(() => expect(apiStub.last().searchParams.get('page')).toBe('3'))
    await screen.findByText('共 200 台设备')

    await changePageSize('50 条/页')
    await waitFor(() => expect(apiStub.last().searchParams.get('pageSize')).toBe('50'))
    expect(apiStub.last().searchParams.get('page')).toBe('1')

    await screen.findByText('共 200 台设备')
    fireEvent.click(screen.getByTitle('2'))
    await waitFor(() => expect(apiStub.last().searchParams.get('page')).toBe('2'))
    expect(apiStub.last().searchParams.get('pageSize')).toBe('50')
  })
})

describe('DevicesPage：单元格', () => {
  it('电量：0 且充电 →「0% ⚡」；100 未充电 →「100%」；null 即使充电也是「—」；charging 为 null 不画 ⚡', async () => {
    stubApi(() =>
      page([
        device({ deviceId: 'helmet_a', battery: 0, charging: true }),
        device({ deviceId: 'helmet_b', battery: 100, charging: false }),
        device({ deviceId: 'helmet_c', battery: null, charging: true }),
        device({ deviceId: 'helmet_d', battery: 37, charging: null }),
      ]),
    )
    renderWithProviders(<DevicesPage />)
    expect(await screen.findByText('helmet_a')).toBeInTheDocument()
    expect(cellsOf('helmet_a')[3]).toBe('0% ⚡')
    expect(cellsOf('helmet_b')[3]).toBe('100%')
    expect(cellsOf('helmet_c')[3]).toBe('—')
    expect(cellsOf('helmet_d')[3]).toBe('37%')
  })

  it('64 字符的 deviceId 整段显示并作为详情链接；绑定的是已注销账号 → 「已注销（昵称）」', async () => {
    const longId = `helmet_${'a'.repeat(57)}`
    stubApi(() =>
      page([
        device({ deviceId: longId, online: true, bindUser: { id: 'u_9', phone: 'deleted:u_9', nickname: '老王' } }),
      ]),
    )
    renderWithProviders(<DevicesPage />)
    const link = await screen.findByText(longId)
    expect(link.closest('a')).toHaveAttribute('href', `/devices/${longId}`)
    expect(cellsOf(longId).slice(1, 3)).toEqual(['已注销（老王）', '在线'])
    expect(screen.queryByText(/deleted:/)).not.toBeInTheDocument()
  })
})

describe('DevicesPage：数据变少后的页码', () => {
  it('「在线」筛选停在第 3 页，刷新时设备掉线只剩 5 台 → 自动回第 1 页出数据，不停在空白页', async () => {
    let total = 45
    const apiStub = stubApi((url) =>
      Number(url.searchParams.get('page')) > Math.ceil(total / 20)
        ? page<AdminDeviceRow>([], total)
        : page([device({ deviceId: `helmet_p${url.searchParams.get('page')}`, online: true })], total),
    )
    renderWithProviders(<DevicesPage />)
    await screen.findByText('共 45 台设备')
    fireEvent.click(screen.getByTitle('3'))
    expect(await screen.findByText('helmet_p3')).toBeInTheDocument()

    total = 5
    fireEvent(window, new Event('visibilitychange'))
    expect(await screen.findByText('helmet_p1')).toBeInTheDocument()
    expect(apiStub.last().searchParams.get('page')).toBe('1')
    expect(screen.getByText('共 5 台设备')).toBeInTheDocument()
  })
})

describe('DevicesPage：轮询', () => {
  it('停留在页面上每 30 秒自动刷新一次（在线状态基于 90 秒心跳窗口）', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const apiStub = stubApi(() => page([device({})], 1))
    renderWithProviders(<DevicesPage />)
    await screen.findByText('共 1 台设备')
    expect(apiStub.count()).toBe(1)
    await vi.advanceTimersByTimeAsync(29_000)
    expect(apiStub.count()).toBe(1)
    await vi.advanceTimersByTimeAsync(1_500)
    await waitFor(() => expect(apiStub.count()).toBe(2))
  })
})

describe('DevicesPage：详情链接编码', () => {
  it('deviceId 含 `#` `?` → 链接编码；点进去详情页请求的仍是同一台设备', async () => {
    const apiStub = stubApi((url) =>
      url.pathname === '/api/v1/admin/devices'
        ? page([device({ deviceId: 'a#b?c' })])
        : jsonResponse(200, deviceDetail({ deviceId: 'a#b?c' })),
    )
    renderWithProviders(
      <Routes>
        <Route path="/devices" element={<DevicesPage />} />
        <Route path="/devices/:deviceId" element={<DeviceDetailPage />} />
      </Routes>,
      '/devices',
    )
    const link = (await screen.findByText('a#b?c')).closest('a') as HTMLElement
    expect(link).toHaveAttribute('href', '/devices/a%23b%3Fc')
    fireEvent.click(link)
    expect(await screen.findByText('设备详情：a#b?c')).toBeInTheDocument()
    await waitFor(() => expect(apiStub.rawLast()).toBe('/api/v1/admin/devices/a%23b%3Fc'))
  })
})
