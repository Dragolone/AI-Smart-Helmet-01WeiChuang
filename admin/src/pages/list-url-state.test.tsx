// 列表页的页码 / 每页条数 / 筛选放在地址栏里（10-17 前端评审）：带参数打开就按参数查、搜索框里是原来的词；
// 改筛选写回地址栏并回到第 1 页；地址栏里的非法值回落默认，不往后端传。
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { Route, Routes, useLocation } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { device, deviceDetail, page, search, stubApi } from '../test/fixtures'
import { jsonResponse, renderWithProviders } from '../test/render'
import AccidentsPage from './AccidentsPage'
import DeviceDetailPage from './DeviceDetailPage'
import DevicesPage from './DevicesPage'
import EventsPage from './EventsPage'
import UsersPage from './UsersPage'

/** 把当前地址栏的查询串露出来给断言用 */
function Where() {
  const loc = useLocation()
  return <output data-testid="where">{loc.pathname + loc.search}</output>
}
const where = () => screen.getByTestId('where').textContent ?? ''

describe('设备列表：状态在地址栏里', () => {
  it('带参数打开：按第 3 页、50 条、关键词、离线去查，搜索框里是原来的词', async () => {
    const apiStub = stubApi(() => page([device({})], 200))
    renderWithProviders(
      <>
        <DevicesPage />
        <Where />
      </>,
      '/devices?page=3&pageSize=50&keyword=abc&online=false',
    )
    await waitFor(() => expect(apiStub.count()).toBeGreaterThan(0))
    const q = apiStub.last().searchParams
    expect(q.get('page')).toBe('3')
    expect(q.get('pageSize')).toBe('50')
    expect(q.get('keyword')).toBe('abc')
    expect(q.get('online')).toBe('false')
    expect(screen.getByPlaceholderText('按设备 ID / 绑定手机号搜索')).toHaveValue('abc')
  })

  it('搜索写回地址栏并回到第 1 页；默认值不写进地址栏', async () => {
    const apiStub = stubApi(() => page([device({})], 200))
    renderWithProviders(
      <>
        <DevicesPage />
        <Where />
      </>,
      '/devices?page=4',
    )
    await waitFor(() => expect(apiStub.count()).toBeGreaterThan(0))
    search('按设备 ID / 绑定手机号搜索', ' helmet_1 ')
    await waitFor(() => expect(where()).toBe('/devices?keyword=helmet_1'))
    await waitFor(() => expect(apiStub.last().searchParams.get('page')).toBe('1'))
  })

  it('地址栏里的非法值回落默认：页码 0、每页 7 条、在线写成 maybe 都不传给后端', async () => {
    const apiStub = stubApi(() => page([device({})]))
    renderWithProviders(<DevicesPage />, '/devices?page=0&pageSize=7&online=maybe')
    await waitFor(() => expect(apiStub.count()).toBeGreaterThan(0))
    const q = apiStub.last().searchParams
    expect(q.get('page')).toBe('1')
    expect(q.get('pageSize')).toBe('20')
    expect(q.has('online')).toBe(false)
  })

  it('筛选后点进详情、再点详情页的「返回」：还在原来那一页、原来的筛选', async () => {
    const apiStub = stubApi((url) =>
      url.pathname === '/api/v1/admin/devices'
        ? page([device({ deviceId: 'helmet_x' })], 200)
        : jsonResponse(200, deviceDetail({ deviceId: 'helmet_x' })),
    )
    renderWithProviders(
      <Routes>
        <Route
          path="/devices"
          element={
            <>
              <DevicesPage />
              <Where />
            </>
          }
        />
        <Route path="/devices/:deviceId" element={<DeviceDetailPage />} />
      </Routes>,
      '/devices?page=2',
    )
    // 列表上搜一下：写回地址栏（replace，这一条历史就带上了参数）
    search('按设备 ID / 绑定手机号搜索', 'helmet')
    await waitFor(() => expect(where()).toBe('/devices?keyword=helmet'))
    fireEvent.click((await screen.findByText('helmet_x')).closest('a') as HTMLElement)
    expect(await screen.findByText('设备详情：helmet_x')).toBeInTheDocument()
    fireEvent.click(screen.getByText('返回').closest('button') as HTMLElement)
    await waitFor(() => expect(where()).toBe('/devices?keyword=helmet'))
    await waitFor(() => expect(apiStub.last().searchParams.get('keyword')).toBe('helmet'))
    expect(screen.getByPlaceholderText('按设备 ID / 绑定手机号搜索')).toHaveValue('helmet')
  })
})

describe('其他三个列表页同样从地址栏取', () => {
  it('用户：关键词 + 含已注销', async () => {
    const apiStub = stubApi(() => page([]))
    renderWithProviders(<UsersPage />, '/users?keyword=139&includeDeleted=true&page=2')
    await waitFor(() => expect(apiStub.count()).toBeGreaterThan(0))
    const q = apiStub.last().searchParams
    expect([q.get('keyword'), q.get('includeDeleted'), q.get('page')]).toEqual([
      '139',
      'true',
      '2',
    ])
  })

  it('事件：只认清单里的类型，设备号、只看校验失败照传', async () => {
    const apiStub = stubApi(() => page([]))
    renderWithProviders(
      <EventsPage />,
      '/events?type=possible_fall,not_a_type,manual_sos&deviceId=helmet_1&invalid=true',
    )
    await waitFor(() => expect(apiStub.count()).toBeGreaterThan(0))
    const q = apiStub.last().searchParams
    expect(q.get('type')).toBe('possible_fall,manual_sos')
    expect(q.get('deviceId')).toBe('helmet_1')
    expect(q.get('invalid')).toBe('true')
  })

  it('事故：状态只认四种，别的不传', async () => {
    const apiStub = stubApi(() => page([]))
    renderWithProviders(<AccidentsPage />, '/accidents?status=notified&deviceId=helmet_2')
    await waitFor(() => expect(apiStub.count()).toBeGreaterThan(0))
    expect(apiStub.last().searchParams.get('status')).toBe('notified')
    expect(apiStub.last().searchParams.get('deviceId')).toBe('helmet_2')

    const stub2 = stubApi(() => page([]))
    renderWithProviders(<AccidentsPage />, '/accidents?status=whatever')
    await waitFor(() => expect(stub2.count()).toBeGreaterThan(0))
    expect(stub2.last().searchParams.has('status')).toBe(false)

    // 原型链上的名字也不算合法状态：原来 `in` 判断放行，发给后端报 400
    const stub3 = stubApi(() => page([]))
    renderWithProviders(<AccidentsPage />, '/accidents?status=toString')
    await waitFor(() => expect(stub3.count()).toBeGreaterThan(0))
    expect(stub3.last().searchParams.has('status')).toBe(false)
  })
})
