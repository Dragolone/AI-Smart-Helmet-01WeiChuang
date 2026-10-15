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

describe('AccidentsPage：清单外的状态与触发方式', () => {
  const tagOf = (deviceId: string, col: number) => {
    const row = screen.getByText(deviceId).closest('tr') as HTMLElement
    const tag = row.querySelectorAll('td')[col].querySelector('.ant-tag') as HTMLElement
    const color = Array.from(tag.classList).find((c) => /^ant-tag-(orange|red|gold|volcano)$/.test(c)) ?? null
    return [tag.textContent, color]
  }

  it('已知取值的中文名与配色不变：倒计时中橙 / 已通知红 / 已取消默认；疑似摔倒金 / 手动求救火山橙', async () => {
    stubApi(() =>
      page([
        accident({ sosId: 's1', deviceId: 'helmet_a', status: 'pending', triggerType: 'possible_fall' }),
        accident({ sosId: 's2', deviceId: 'helmet_b', status: 'notified', triggerType: 'manual_sos' }),
        accident({ sosId: 's3', deviceId: 'helmet_c', status: 'cancelled' }),
      ]),
    )
    renderWithProviders(<AccidentsPage />)
    await screen.findByText('helmet_a')
    expect([tagOf('helmet_a', 4), tagOf('helmet_a', 3)]).toEqual([
      ['倒计时中', 'ant-tag-orange'],
      ['疑似摔倒', 'ant-tag-gold'],
    ])
    expect([tagOf('helmet_b', 4), tagOf('helmet_b', 3)]).toEqual([
      ['已通知', 'ant-tag-red'],
      ['手动求救', 'ant-tag-volcano'],
    ])
    expect(tagOf('helmet_c', 4)).toEqual(['已取消', null])
  })

  it('库里出现清单外的状态（如以后加的 escalated）→ 照实显示原值，整页不白屏', async () => {
    stubApi(() =>
      page([
        accident({ sosId: 's1', deviceId: 'helmet_a', status: 'escalated' as never }),
        accident({ sosId: 's2', deviceId: 'helmet_b', status: 'notified' }),
      ]),
    )
    renderWithProviders(<AccidentsPage />)
    expect(await screen.findByText('helmet_a')).toBeInTheDocument()
    expect(tagOf('helmet_a', 4)).toEqual(['escalated', null])
    expect(tagOf('helmet_b', 4)).toEqual(['已通知', 'ant-tag-red'])
  })

  it('清单外的触发方式照实显示原值，不再一律标成「疑似摔倒」', async () => {
    stubApi(() => page([accident({ deviceId: 'helmet_a', triggerType: 'remote_sos' as never })]))
    renderWithProviders(<AccidentsPage />)
    await screen.findByText('helmet_a')
    expect(tagOf('helmet_a', 3)).toEqual(['remote_sos', null])
    expect(screen.queryByText('疑似摔倒')).not.toBeInTheDocument()
  })

  it('取值撞上原型键（toString / constructor）→ 也按清单外原值显示，不出空标签', async () => {
    stubApi(() =>
      page([accident({ deviceId: 'helmet_a', status: 'toString' as never, triggerType: 'constructor' as never })]),
    )
    renderWithProviders(<AccidentsPage />)
    await screen.findByText('helmet_a')
    expect(tagOf('helmet_a', 4)).toEqual(['toString', null])
    expect(tagOf('helmet_a', 3)).toEqual(['constructor', null])
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

describe('AccidentsPage：数据变少后的页码', () => {
  it('停在第 2 页时总数变成 0（如库被清理）→ 回第 1 页显示空状态，而不是停在不存在的页', async () => {
    let total = 45
    const apiStub = stubApi((url) =>
      total === 0
        ? page<AdminAccidentRow>([], 0)
        : page([accident({ deviceId: `helmet_p${url.searchParams.get('page')}` })], total),
    )
    renderWithProviders(<AccidentsPage />)
    await screen.findByText('共 45 条记录')
    fireEvent.click(screen.getByTitle('2'))
    expect(await screen.findByText('helmet_p2')).toBeInTheDocument()

    total = 0
    fireEvent(window, new Event('visibilitychange'))
    await waitFor(() => expect(apiStub.last().searchParams.get('page')).toBe('1'))
    await waitFor(() => expect(tablePlaceholder()).toHaveTextContent('暂无数据'))
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
