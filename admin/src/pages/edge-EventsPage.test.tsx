// 事件历史页边界：加载中 / 报错重试 / 断网 / 空列表、类型标签配色的每个分支、跨设备同号事件、
// 设备 ID 筛选的空格与编码、类型筛选清除、只看留档与类型筛选的叠加、改每页条数、30 秒轮询。
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AdminEventRow } from '@helmet/shared'
import {
  ERROR_BANNER,
  byRole,
  cellsOf,
  changePageSize,
  clickRetry,
  event,
  page,
  pending,
  search,
  stubApi,
  tablePlaceholder,
  tableSpinning,
} from '../test/fixtures'
import { jsonResponse, renderWithProviders } from '../test/render'
import EventsPage from './EventsPage'

const PLACEHOLDER = '按设备 ID 精确筛选'

beforeAll(() => {
  vi.stubEnv('TZ', 'Asia/Shanghai')
})
afterAll(() => {
  vi.unstubAllEnvs()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('EventsPage：加载 / 错误 / 空', () => {
  it('加载中：表格转圈，不出错误横幅与分页总数', async () => {
    const apiStub = stubApi(() => pending())
    renderWithProviders(<EventsPage />)
    await waitFor(() => expect(apiStub.count()).toBe(1))
    expect(tableSpinning()).toBe(true)
    expect(screen.queryByText(ERROR_BANNER)).not.toBeInTheDocument()
    expect(screen.queryByText(/共 \d+ 条事件/)).not.toBeInTheDocument()
  })

  it('接口 500 → 横幅；点重试成功后出数据', async () => {
    const apiStub = stubApi((_url, call) =>
      call === 1
        ? jsonResponse(500, { code: 'INTERNAL_ERROR', message: 'x' })
        : page([event({ deviceId: 'helmet_ok' })]),
    )
    renderWithProviders(<EventsPage />)
    expect(await screen.findByText('INTERNAL_ERROR（HTTP 500）')).toBeInTheDocument()
    clickRetry()
    expect(await screen.findByText('helmet_ok')).toBeInTheDocument()
    expect(apiStub.count()).toBe(2)
    expect(screen.queryByText(ERROR_BANNER)).not.toBeInTheDocument()
  })

  it('断网 → 横幅显示原始错误信息', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    renderWithProviders(<EventsPage />)
    expect(await screen.findByText('Failed to fetch')).toBeInTheDocument()
  })

  it('后端拒绝未知类型（400 VALIDATION_FAILED）→ 横幅照实显示 code，不当成没有事件', async () => {
    stubApi(() => jsonResponse(400, { code: 'VALIDATION_FAILED', message: '未知事件类型：x' }))
    renderWithProviders(<EventsPage />)
    expect(await screen.findByText('VALIDATION_FAILED（HTTP 400）')).toBeInTheDocument()
  })

  it('空列表：空状态，不出错误横幅', async () => {
    const apiStub = stubApi(() => page<AdminEventRow>([], 0))
    renderWithProviders(<EventsPage />)
    await waitFor(() => expect(apiStub.count()).toBe(1))
    await waitFor(() => expect(tablePlaceholder()).toHaveTextContent('暂无数据'))
    expect(screen.queryByText(ERROR_BANNER)).not.toBeInTheDocument()
  })
})

describe('EventsPage：单元格', () => {
  it('类型标签配色：碰撞 / 障碍红、摔倒 / 求救火山橙、风险解除绿、校验失败品红、其余默认色', async () => {
    const types: [string, string | null][] = [
      ['collision_risk', 'red'],
      ['obstacle_risk', 'red'],
      ['possible_fall', 'volcano'],
      ['manual_sos', 'volcano'],
      ['risk_cleared', 'green'],
      ['_invalid', 'magenta'],
      ['device_status', null],
      ['video_ready', null],
    ]
    stubApi(() => page(types.map(([t], i) => event({ eventId: `e${i}`, deviceId: `helmet_${i}`, eventType: t }))))
    renderWithProviders(<EventsPage />)
    await screen.findByText('helmet_0')
    for (const [t, color] of types) {
      const tag = screen.getByText(t).closest('.ant-tag') as HTMLElement
      const colorClass = Array.from(tag.classList).find((c) =>
        /^ant-tag-(red|volcano|green|magenta|orange|gold)$/.test(c),
      )
      expect(colorClass ?? null, t).toBe(color ? `ant-tag-${color}` : null)
    }
  })

  it('两台设备上报了同一个 eventId（设备内唯一，决策 #54）→ 两行都在，展开各看各的 payload', async () => {
    stubApi(() =>
      page([
        event({ eventId: 'evt_same', deviceId: 'helmet_a', payload: { from: 'a' } }),
        event({ eventId: 'evt_same', deviceId: 'helmet_b', payload: { from: 'b' } }),
      ]),
    )
    renderWithProviders(<EventsPage />)
    const rowB = (await screen.findByText('helmet_b')).closest('tr') as HTMLElement
    expect(screen.getByText('helmet_a')).toBeInTheDocument()
    fireEvent.click(rowB.querySelector('button.ant-table-row-expand-icon') as HTMLElement)
    expect(JSON.parse(document.querySelector('pre')?.textContent ?? '')).toEqual({ from: 'b' })
  })

  it('超长摘要与 64 字符 deviceId 整段显示；接收时间按北京时间跨日', async () => {
    const longId = `helmet_${'b'.repeat(57)}`
    const longSummary = '摘要'.repeat(200)
    stubApi(() => page([event({ deviceId: longId, summary: longSummary, receivedAt: '2026-12-31T16:00:00.000Z' })]))
    renderWithProviders(<EventsPage />)
    await screen.findByText(longId)
    expect(cellsOf(longId).slice(1, 5)).toEqual(['2027-01-01 00:00:00', longId, 'device_status', longSummary])
  })
})

describe('EventsPage：筛选', () => {
  it('设备 ID：首尾空格去掉、中间空格保留；只有空格等于清空；特殊字符整段一个参数', async () => {
    const apiStub = stubApi(() => page<AdminEventRow>([]))
    renderWithProviders(<EventsPage />)
    await waitFor(() => expect(apiStub.count()).toBe(1))

    search(PLACEHOLDER, '  helmet 001 ')
    await waitFor(() => expect(apiStub.last().searchParams.get('deviceId')).toBe('helmet 001'))

    search(PLACEHOLDER, 'a&invalid=true#x')
    await waitFor(() => expect(apiStub.last().searchParams.get('deviceId')).toBe('a&invalid=true#x'))
    expect(apiStub.last().searchParams.has('invalid')).toBe(false)

    search(PLACEHOLDER, '   ')
    await waitFor(() => expect(apiStub.last().searchParams.has('deviceId')).toBe(false))
  })

  it('停在第 2 页时按设备筛选 → 回到第 1 页', async () => {
    const apiStub = stubApi(() => page([event({})], 45))
    renderWithProviders(<EventsPage />)
    await screen.findByText('共 45 条事件')
    fireEvent.click(screen.getByTitle('2'))
    await waitFor(() => expect(apiStub.last().searchParams.get('page')).toBe('2'))
    search(PLACEHOLDER, 'helmet_001')
    await waitFor(() => expect(apiStub.last().searchParams.get('deviceId')).toBe('helmet_001'))
    expect(apiStub.last().searchParams.get('page')).toBe('1')
  })

  it('类型多选后点清除 → type 参数消失', async () => {
    const apiStub = stubApi(() => page([event({})], 1))
    renderWithProviders(<EventsPage />)
    await screen.findByText('共 1 条事件')
    fireEvent.mouseDown(byRole('combobox'))
    fireEvent.click(await screen.findByTitle('collision_risk'))
    await waitFor(() => expect(apiStub.last().searchParams.get('type')).toBe('collision_risk'))

    await screen.findByText('共 1 条事件')
    const select = byRole('combobox').closest('.ant-select') as HTMLElement
    fireEvent.mouseEnter(select)
    fireEvent.mouseDown(select.querySelector('.ant-select-clear') as HTMLElement)
    fireEvent.click(select.querySelector('.ant-select-clear') as HTMLElement)
    await waitFor(() => expect(apiStub.last().searchParams.has('type')).toBe(false))
  })

  it('已选类型后打开「只看校验失败留档」→ 类型框禁用但保留所选，type 与 invalid=true 一起发（后端在 invalid=true 时忽略 type）', async () => {
    const apiStub = stubApi(() => page([event({})], 1))
    renderWithProviders(<EventsPage />)
    await screen.findByText('共 1 条事件')
    fireEvent.mouseDown(byRole('combobox'))
    fireEvent.click(await screen.findByTitle('possible_fall'))
    await waitFor(() => expect(apiStub.last().searchParams.get('type')).toBe('possible_fall'))

    await screen.findByText('共 1 条事件')
    fireEvent.click(byRole('switch'))
    await waitFor(() => expect(apiStub.last().searchParams.get('invalid')).toBe('true'))
    expect(apiStub.last().searchParams.get('type')).toBe('possible_fall')
    expect(byRole('combobox')).toBeDisabled()

    // 关掉后类型筛选原样恢复生效
    await screen.findByText('共 1 条事件')
    fireEvent.click(byRole('switch'))
    await waitFor(() => expect(apiStub.last().searchParams.has('invalid')).toBe(false))
    expect(apiStub.last().searchParams.get('type')).toBe('possible_fall')
  })
})

describe('EventsPage：数据变少后的页码', () => {
  it('停在第 3 页、刷新拿回的总数只够 2 页 → 拉回第 2 页', async () => {
    let total = 45
    const apiStub = stubApi((url) =>
      Number(url.searchParams.get('page')) > Math.ceil(total / 20)
        ? page<AdminEventRow>([], total)
        : page([event({ deviceId: `helmet_p${url.searchParams.get('page')}` })], total),
    )
    renderWithProviders(<EventsPage />)
    await screen.findByText('共 45 条事件')
    fireEvent.click(screen.getByTitle('3'))
    expect(await screen.findByText('helmet_p3')).toBeInTheDocument()

    total = 25
    fireEvent(window, new Event('visibilitychange'))
    expect(await screen.findByText('helmet_p2')).toBeInTheDocument()
    expect(apiStub.last().searchParams.get('page')).toBe('2')
  })
})

describe('EventsPage：分页与轮询', () => {
  it('停在第 3 页时改成 100 条/页（后端上限）→ 回第 1 页', async () => {
    const apiStub = stubApi(() => page([event({})], 500))
    renderWithProviders(<EventsPage />)
    await screen.findByText('共 500 条事件')
    fireEvent.click(screen.getByTitle('3'))
    await waitFor(() => expect(apiStub.last().searchParams.get('page')).toBe('3'))
    await screen.findByText('共 500 条事件')
    await changePageSize('100 条/页')
    await waitFor(() => expect(apiStub.last().searchParams.get('pageSize')).toBe('100'))
    expect(apiStub.last().searchParams.get('page')).toBe('1')
  })

  it('停留在页面上每 30 秒自动刷新一次', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const apiStub = stubApi(() => page([event({})], 1))
    renderWithProviders(<EventsPage />)
    await screen.findByText('共 1 条事件')
    expect(apiStub.count()).toBe(1)
    await vi.advanceTimersByTimeAsync(30_500)
    await waitFor(() => expect(apiStub.count()).toBe(2))
  })
})
