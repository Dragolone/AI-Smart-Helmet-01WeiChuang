// 事故 / SOS 页边界：加载中 / 报错重试 / 断网 / 空列表、状态筛选的每个取值与清除、设备 ID 筛选、
// 坐标保留 5 位与极值、改每页条数、15 秒轮询（进行中的 SOS 盯得比别的页紧）。
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AdminAccidentRow } from '@helmet/shared'
import {
  ERROR_BANNER,
  accident,
  byRole,
  cellsOf,
  changePageSize,
  clickRetry,
  page,
  pending,
  search,
  stubApi,
  tablePlaceholder,
  tableSpinning,
} from '../test/fixtures'
import { renderWithProviders, textResponse } from '../test/render'
import AccidentsPage from './AccidentsPage'

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

describe('AccidentsPage：加载 / 错误 / 空', () => {
  it('加载中：表格转圈，不出错误横幅与分页总数', async () => {
    const apiStub = stubApi(() => pending())
    renderWithProviders(<AccidentsPage />)
    await waitFor(() => expect(apiStub.count()).toBe(1))
    expect(tableSpinning()).toBe(true)
    expect(screen.queryByText(ERROR_BANNER)).not.toBeInTheDocument()
    expect(screen.queryByText(/共 \d+ 条记录/)).not.toBeInTheDocument()
  })

  it('接口 502（网关 HTML）→ 横幅；点重试成功后出数据', async () => {
    const apiStub = stubApi((_url, call) =>
      call === 1 ? textResponse(502, '<html>Bad Gateway</html>') : page([accident({ deviceId: 'helmet_ok' })]),
    )
    renderWithProviders(<AccidentsPage />)
    expect(await screen.findByText('UNKNOWN_ERROR（HTTP 502）')).toBeInTheDocument()
    clickRetry()
    expect(await screen.findByText('helmet_ok')).toBeInTheDocument()
    expect(apiStub.count()).toBe(2)
    expect(screen.queryByText(ERROR_BANNER)).not.toBeInTheDocument()
  })

  it('断网 → 横幅显示原始错误信息', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    renderWithProviders(<AccidentsPage />)
    expect(await screen.findByText('Failed to fetch')).toBeInTheDocument()
  })

  it('空列表：空状态，不出错误横幅', async () => {
    const apiStub = stubApi(() => page<AdminAccidentRow>([], 0))
    renderWithProviders(<AccidentsPage />)
    await waitFor(() => expect(apiStub.count()).toBe(1))
    await waitFor(() => expect(tablePlaceholder()).toHaveTextContent('暂无数据'))
    expect(screen.queryByText(ERROR_BANNER)).not.toBeInTheDocument()
  })
})

describe('AccidentsPage：单元格', () => {
  it('坐标四舍五入到 5 位（约 1 米）；纬度 ±90、经度 ±180 极值照实；事件内嵌位置不带「轨迹回落」', async () => {
    stubApi(() =>
      page([
        accident({
          sosId: 's1',
          deviceId: 'helmet_a',
          location: {
            latitude: 22.543216789,
            longitude: 114.0579,
            coordinateSystem: 'gcj02',
            accuracy: null,
            source: 'event',
          },
        }),
        accident({
          sosId: 's2',
          deviceId: 'helmet_b',
          location: { latitude: 90, longitude: -180, coordinateSystem: 'wgs84', accuracy: 3.5, source: 'last_point' },
        }),
      ]),
    )
    renderWithProviders(<AccidentsPage />)
    await screen.findByText('helmet_a')
    expect(cellsOf('helmet_a')[5]).toBe('22.54322, 114.05790（gcj02）')
    expect(cellsOf('helmet_b')[5]).toBe('90.00000, -180.00000（wgs84·轨迹回落）')
  })

  it('64 字符 deviceId 与超长昵称整段显示', async () => {
    const longId = `helmet_${'c'.repeat(57)}`
    const nick = '骑'.repeat(30)
    stubApi(() => page([accident({ deviceId: longId, user: { id: 'u', phone: '13800001111', nickname: nick } })]))
    renderWithProviders(<AccidentsPage />)
    await screen.findByText(longId)
    expect(cellsOf(longId)[2]).toBe(`13800001111（${nick}）`)
  })
})

describe('AccidentsPage：筛选', () => {
  it.each([
    ['倒计时中', 'pending'],
    ['已通知', 'notified'],
    ['已取消', 'cancelled'],
  ])('状态选「%s」→ status=%s 并回到第 1 页', async (label, value) => {
    const apiStub = stubApi(() => page([accident({})], 45))
    renderWithProviders(<AccidentsPage />)
    await screen.findByText('共 45 条记录')
    fireEvent.click(screen.getByTitle('2'))
    await waitFor(() => expect(apiStub.last().searchParams.get('page')).toBe('2'))
    await screen.findByText('共 45 条记录')

    fireEvent.mouseDown(byRole('combobox'))
    fireEvent.click(await screen.findByTitle(label))
    await waitFor(() => expect(apiStub.last().searchParams.get('status')).toBe(value))
    expect(apiStub.last().searchParams.get('page')).toBe('1')
  })

  it('状态筛选清除 → status 参数消失', async () => {
    const apiStub = stubApi(() => page([accident({})], 1))
    renderWithProviders(<AccidentsPage />)
    await screen.findByText('共 1 条记录')
    fireEvent.mouseDown(byRole('combobox'))
    fireEvent.click(await screen.findByTitle('已通知'))
    await waitFor(() => expect(apiStub.last().searchParams.get('status')).toBe('notified'))

    await screen.findByText('共 1 条记录')
    const select = byRole('combobox').closest('.ant-select') as HTMLElement
    fireEvent.mouseEnter(select)
    fireEvent.mouseDown(select.querySelector('.ant-select-clear') as HTMLElement)
    fireEvent.click(select.querySelector('.ant-select-clear') as HTMLElement)
    await waitFor(() => expect(apiStub.last().searchParams.has('status')).toBe(false))
  })

  it('设备 ID 中间空格保留；`%`、`+`、中文整段一个参数；与状态筛选可叠加', async () => {
    const apiStub = stubApi(() => page([accident({})], 1))
    renderWithProviders(<AccidentsPage />)
    await screen.findByText('共 1 条记录')
    fireEvent.mouseDown(byRole('combobox'))
    fireEvent.click(await screen.findByTitle('倒计时中'))
    await waitFor(() => expect(apiStub.last().searchParams.get('status')).toBe('pending'))

    search(PLACEHOLDER, ' helmet 1%+头盔 ')
    await waitFor(() => expect(apiStub.last().searchParams.get('deviceId')).toBe('helmet 1%+头盔'))
    expect(apiStub.last().searchParams.get('status')).toBe('pending')
  })
})

describe('AccidentsPage：分页与轮询', () => {
  it('停在第 4 页时改成 10 条/页 → 回第 1 页', async () => {
    const apiStub = stubApi(() => page([accident({})], 120))
    renderWithProviders(<AccidentsPage />)
    await screen.findByText('共 120 条记录')
    fireEvent.click(screen.getByTitle('4'))
    await waitFor(() => expect(apiStub.last().searchParams.get('page')).toBe('4'))
    await screen.findByText('共 120 条记录')
    await changePageSize('10 条/页')
    await waitFor(() => expect(apiStub.last().searchParams.get('pageSize')).toBe('10'))
    expect(apiStub.last().searchParams.get('page')).toBe('1')
  })

  it('每 15 秒自动刷新一次（倒计时 / 取消随时变化），14 秒时还没刷', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const apiStub = stubApi(() => page([accident({})], 1))
    renderWithProviders(<AccidentsPage />)
    await screen.findByText('共 1 条记录')
    expect(apiStub.count()).toBe(1)
    await vi.advanceTimersByTimeAsync(14_000)
    expect(apiStub.count()).toBe(1)
    await vi.advanceTimersByTimeAsync(1_500)
    await waitFor(() => expect(apiStub.count()).toBe(2))
  })
})
