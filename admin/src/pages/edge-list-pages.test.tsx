// 四个列表页的边界：空值 / 0 值 / 未知枚举的单元格渲染、筛选参数的拼装与编码、
// 翻页与筛选的联动、时间按本地时区展示。接口用 fetch 桩，按请求 URL 断言实际发出去的查询串。
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AdminDeviceRow, AdminUserRow } from '@helmet/shared'
import { accident, byRole, cellsOf, device, event, page, search, stubApi, user } from '../test/fixtures'
import { renderWithProviders, textResponse } from '../test/render'
import AccidentsPage from './AccidentsPage'
import DevicesPage from './DevicesPage'
import EventsPage from './EventsPage'
import UsersPage from './UsersPage'

// 后台给国内运维用：固定成北京时间断言，CI（UTC）与开发机时区不同也得出同一结果
beforeAll(() => {
  vi.stubEnv('TZ', 'Asia/Shanghai')
})
afterAll(() => {
  vi.unstubAllEnvs()
})

describe('UsersPage：边界', () => {
  it('单元格：昵称为空显示「—」；已注销账号不露出改写后的 deleted:<id>；时间按北京时间跨日显示；绑定数 0 照实显示', async () => {
    stubApi(() =>
      page([
        user({ id: 'u_1', phone: '13800001111' }),
        user({ id: 'u_2', phone: 'deleted:u_2', nickname: '老王', deletedAt: '2026-09-30T16:00:00.000Z', deviceCount: 2 }),
      ]),
    )
    renderWithProviders(<UsersPage />)
    // UTC 16:30 = 北京时间次日 00:30
    expect(await screen.findByText('13800001111')).toBeInTheDocument()
    expect(cellsOf('13800001111')).toEqual(['13800001111', '—', '—', '0', '2026-09-18 00:30'])
    expect(cellsOf('老王')).toEqual(['已注销', '老王', '2026-10-01 00:00', '2', '2026-09-18 00:30'])
    expect(screen.queryByText(/deleted:/)).not.toBeInTheDocument()
    expect(screen.getByText('共 2 个用户')).toBeInTheDocument()
  })

  it('搜索词去首尾空格并整体编码成一个参数：`&` `=` `#` 不能拆出别的查询参数；纯空格等于没搜', async () => {
    const apiStub = stubApi(() => page<AdminUserRow>([]))
    renderWithProviders(<UsersPage />)
    await waitFor(() => expect(apiStub.count()).toBe(1))
    expect(Array.from(apiStub.last().searchParams.keys())).toEqual(['page', 'pageSize'])

    search('按手机号 / 昵称搜索', '  a&includeDeleted=true #1  ')
    await waitFor(() => expect(apiStub.count()).toBe(2))
    const params = apiStub.last().searchParams
    expect(Array.from(params.keys())).toEqual(['page', 'pageSize', 'keyword'])
    expect(params.get('keyword')).toBe('a&includeDeleted=true #1')
    expect(apiStub.last().hash).toBe('')

    search('按手机号 / 昵称搜索', '   ')
    await waitFor(() => expect(apiStub.count()).toBe(3))
    expect(apiStub.last().searchParams.has('keyword')).toBe(false)
  })

  it('翻到第 2 页后勾「含已注销」→ 带 includeDeleted=true 并回到第 1 页（否则可能停在不存在的页）', async () => {
    const apiStub = stubApi(() => page([user({})], 45))
    renderWithProviders(<UsersPage />)
    await screen.findByText('共 45 个用户')
    fireEvent.click(screen.getByTitle('2'))
    await waitFor(() => expect(apiStub.last().searchParams.get('page')).toBe('2'))
    expect(apiStub.last().searchParams.has('includeDeleted')).toBe(false)

    fireEvent.click(screen.getByLabelText('含已注销'))
    await waitFor(() => expect(apiStub.last().searchParams.get('includeDeleted')).toBe('true'))
    expect(apiStub.last().searchParams.get('page')).toBe('1')
    expect(apiStub.last().searchParams.get('pageSize')).toBe('20')
  })

  it('已有数据后刷新失败 → 错误横幅 + 清空表格与总数，不把旧数据当成当前数据继续显示', async () => {
    let healthy = true
    stubApi(() => (healthy ? page([user({})], 1) : textResponse(500, 'Internal Server Error')))
    renderWithProviders(<UsersPage />)
    expect(await screen.findByText('13800001111')).toBeInTheDocument()

    healthy = false
    // 切回标签页触发的聚焦刷新（main.tsx 保留了这个默认行为）
    fireEvent(window, new Event('visibilitychange'))
    expect(await screen.findByText('加载失败，当前显示的不是真实数据')).toBeInTheDocument()
    expect(screen.getByText('UNKNOWN_ERROR（HTTP 500）')).toBeInTheDocument()
    expect(screen.queryByText('13800001111')).not.toBeInTheDocument()
  })
})

describe('DevicesPage：边界', () => {
  it('单元格：电量 0 显示「0%」而不是「—」；null 才是「—」；充电中带 ⚡；未绑定 / 无昵称 / 空昵称；从未上线', async () => {
    stubApi(() =>
      page([
        device({ deviceId: 'helmet_zero', battery: 0, charging: false, online: true, firmwareVersion: '1.0.3', lastSeenAt: '2026-09-17T16:30:05.000Z' }),
        device({ deviceId: 'helmet_null' }),
        device({ deviceId: 'helmet_chg', battery: 100, charging: true, bindUser: { id: 'u', phone: '13800001111', nickname: '小李' } }),
        device({ deviceId: 'helmet_nonick', battery: 55, bindUser: { id: 'u', phone: '13900002222', nickname: null } }),
        device({ deviceId: 'helmet_emptynick', battery: 55, bindUser: { id: 'u', phone: '13700003333', nickname: '' } }),
      ]),
    )
    renderWithProviders(<DevicesPage />)
    expect(await screen.findByText('helmet_zero')).toBeInTheDocument()
    expect(cellsOf('helmet_zero')).toEqual(['helmet_zero', '未绑定', '在线', '0%', '1.0.3', '2026-09-18 00:30:05'])
    expect(cellsOf('helmet_null')).toEqual(['helmet_null', '未绑定', '离线', '—', '—', '—'])
    expect(cellsOf('helmet_chg').slice(1, 4)).toEqual(['13800001111（小李）', '离线', '100% ⚡'])
    expect(cellsOf('helmet_nonick')[1]).toBe('13900002222')
    expect(cellsOf('helmet_emptynick')[1]).toBe('13700003333')
    expect(screen.getByText('helmet_zero').closest('a')).toHaveAttribute('href', '/devices/helmet_zero')
  })

  it('在线筛选选「离线」→ 查询串带 online=false（字符串，不能因为是假值被丢掉）并回到第 1 页', async () => {
    const apiStub = stubApi(() => page([device({})], 45))
    renderWithProviders(<DevicesPage />)
    await screen.findByText('共 45 台设备')
    expect(apiStub.last().searchParams.has('online')).toBe(false)
    fireEvent.click(screen.getByTitle('3'))
    await waitFor(() => expect(apiStub.last().searchParams.get('page')).toBe('3'))

    fireEvent.mouseDown(byRole('combobox'))
    fireEvent.click(await screen.findByTitle('离线'))
    await waitFor(() => expect(apiStub.last().searchParams.get('online')).toBe('false'))
    expect(apiStub.last().searchParams.get('page')).toBe('1')
  })

  it('空列表（total 为 0）：显示空状态，不出错误横幅——「没有数据」与「加载失败」必须能区分', async () => {
    const apiStub = stubApi(() => page<AdminDeviceRow>([], 0))
    renderWithProviders(<DevicesPage />)
    await waitFor(() => expect(apiStub.count()).toBe(1))
    await waitFor(() => expect(document.querySelector('.ant-table-placeholder')).toHaveTextContent('暂无数据'))
    expect(screen.queryByText('加载失败，当前显示的不是真实数据')).not.toBeInTheDocument()
  })
})

describe('AccidentsPage：边界', () => {
  it('单元格：无位置 / 轨迹回落 / 南半球西半球负坐标 / 恰好 (0,0)；无归属用户；两种触发方式与三种状态', async () => {
    stubApi(() =>
      page([
        accident({ sosId: 's1', deviceId: 'helmet_a', status: 'pending', triggerType: 'possible_fall' }),
        accident({
          sosId: 's2',
          deviceId: 'helmet_b',
          status: 'notified',
          triggerType: 'manual_sos',
          user: { id: 'u', phone: '13800001111', nickname: null },
          location: { latitude: -33.8688249, longitude: -151.2092951, coordinateSystem: 'wgs84', accuracy: null, source: 'last_point' },
        }),
        accident({
          sosId: 's3',
          deviceId: 'helmet_c',
          status: 'cancelled',
          user: { id: 'u', phone: '13900002222', nickname: '小李' },
          location: { latitude: 0, longitude: 0, coordinateSystem: 'gcj02', accuracy: 5, source: 'event' },
        }),
        // 事故后注销：事故按 userId 留档，phone 已被改写成 deleted:<id>
        accident({ sosId: 's4', deviceId: 'helmet_d', status: 'notified', user: { id: 'u_4', phone: 'deleted:u_4', nickname: '老王' } }),
      ]),
    )
    renderWithProviders(<AccidentsPage />)
    expect(await screen.findByText('helmet_a')).toBeInTheDocument()
    expect(cellsOf('helmet_a')).toEqual(['2026-09-18 00:30:05', 'helmet_a', '—', '疑似摔倒', '倒计时中', '无位置'])
    expect(cellsOf('helmet_b').slice(2)).toEqual(['13800001111', '手动求救', '已通知', '-33.86882, -151.20930（wgs84·轨迹回落）'])
    expect(cellsOf('helmet_c').slice(2)).toEqual(['13900002222（小李）', '疑似摔倒', '已取消', '0.00000, 0.00000（gcj02）'])
    expect(cellsOf('helmet_d')[2]).toBe('已注销（老王）')
    expect(screen.queryByText(/deleted:/)).not.toBeInTheDocument()
  })

  it('设备 ID 筛选去空格后带上 deviceId；清空后参数消失；筛选时回到第 1 页', async () => {
    const apiStub = stubApi(() => page([accident({})], 45))
    renderWithProviders(<AccidentsPage />)
    await screen.findByText('共 45 条记录')
    fireEvent.click(screen.getByTitle('2'))
    await waitFor(() => expect(apiStub.last().searchParams.get('page')).toBe('2'))

    search('按设备 ID 精确筛选', '  helmet_001 ')
    await waitFor(() => expect(apiStub.last().searchParams.get('deviceId')).toBe('helmet_001'))
    expect(apiStub.last().searchParams.get('page')).toBe('1')
    expect(apiStub.last().searchParams.has('status')).toBe(false)

    search('按设备 ID 精确筛选', '')
    await waitFor(() => expect(apiStub.last().searchParams.has('deviceId')).toBe(false))
  })
})

describe('EventsPage：边界', () => {
  it('单元格：校验失败留档 `_invalid` 与清单外的未来事件类型都照实显示类型名；时钟偏移只在为真时打标', async () => {
    stubApi(() =>
      page([
        event({ eventId: 'e1', deviceId: 'helmet_a', eventType: '_invalid', summary: '校验失败', clockSkew: true, source: 'mqtt' }),
        event({ eventId: 'e2', deviceId: 'helmet_b', eventType: 'tire_pressure_low', summary: '' }),
      ]),
    )
    renderWithProviders(<EventsPage />)
    expect(await screen.findByText('helmet_a')).toBeInTheDocument()
    // 第 0 列是展开按钮
    expect(cellsOf('helmet_a').slice(1)).toEqual(['2026-09-18 00:30:05', 'helmet_a', '_invalid', '校验失败', 'mqtt', '偏移'])
    expect(cellsOf('helmet_b').slice(1)).toEqual(['2026-09-18 00:30:05', 'helmet_b', 'tire_pressure_low', '', 'app_relay', '—'])
  })

  it('展开一行 → 原样显示 payload（含嵌套与 null），供排查', async () => {
    stubApi(() => page([event({ payload: { reason: 'schema', raw: { battery: null, nested: [1, { a: 0 }] } } })]))
    renderWithProviders(<EventsPage />)
    const row = (await screen.findByText('helmet_001')).closest('tr') as HTMLElement
    fireEvent.click(row.querySelector('button.ant-table-row-expand-icon') as HTMLElement)
    const pre = document.querySelector('pre')
    expect(JSON.parse(pre?.textContent ?? '')).toEqual({ reason: 'schema', raw: { battery: null, nested: [1, { a: 0 }] } })
  })

  it('打开「只看校验失败留档」→ 带 invalid=true 并回到第 1 页，类型筛选同时禁用；关掉后参数消失', async () => {
    const apiStub = stubApi(() => page([event({})], 45))
    renderWithProviders(<EventsPage />)
    await screen.findByText('共 45 条事件')
    expect(apiStub.last().searchParams.has('invalid')).toBe(false)
    fireEvent.click(screen.getByTitle('2'))
    await waitFor(() => expect(apiStub.last().searchParams.get('page')).toBe('2'))

    fireEvent.click(byRole('switch'))
    await waitFor(() => expect(apiStub.last().searchParams.get('invalid')).toBe('true'))
    expect(apiStub.last().searchParams.get('page')).toBe('1')
    expect(byRole('combobox')).toBeDisabled()

    fireEvent.click(byRole('switch'))
    await waitFor(() => expect(apiStub.last().searchParams.has('invalid')).toBe(false))
  })

  it('多选事件类型 → 逗号拼成一个 type 参数（后端按逗号拆）', async () => {
    const apiStub = stubApi(() => page([event({})], 1))
    renderWithProviders(<EventsPage />)
    await screen.findByText('共 1 条事件')
    fireEvent.mouseDown(byRole('combobox'))
    fireEvent.click(await screen.findByTitle('possible_fall'))
    fireEvent.click(await screen.findByTitle('manual_sos'))
    await waitFor(() => expect(apiStub.last().searchParams.get('type')).toBe('possible_fall,manual_sos'))
    expect(apiStub.last().search).toContain('type=possible_fall%2Cmanual_sos')
  })
})
