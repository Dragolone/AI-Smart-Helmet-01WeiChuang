// 列表页 / 详情页测试共用的桩与造数：fetch 桩按请求 URL 现造响应并留下每次的查询串，
// 行工厂只填 Contract 必有字段，用例按需覆盖。
import { fireEvent, screen } from '@testing-library/react'
import { vi } from 'vitest'
import type { AdminAccidentRow, AdminDeviceDetail, AdminDeviceRow, AdminEventRow, AdminUserRow } from '@helmet/shared'
import { jsonResponse } from './render'

export const ERROR_BANNER = '加载失败，当前显示的不是真实数据'

/** 桩 fetch：每次请求按 URL 现造响应（Response 体只能读一次），并记录请求 */
export const stubApi = (respond: (url: URL, call: number) => Response | Promise<Response>) => {
  const fetchMock = vi.fn((input: string) =>
    Promise.resolve(respond(new URL(input, 'http://admin.local'), fetchMock.mock.calls.length)),
  )
  vi.stubGlobal('fetch', fetchMock)
  return {
    fetchMock,
    count: () => fetchMock.mock.calls.length,
    /** 原样的请求路径（未经 URL 解析，看编码用） */
    rawLast: () => String(fetchMock.mock.calls.at(-1)?.[0] ?? ''),
    last: () => new URL(fetchMock.mock.calls.at(-1)?.[0] ?? '', 'http://admin.local'),
  }
}

export const page = <T>(items: T[], total = items.length) => jsonResponse(200, { items, total, page: 1, pageSize: 20 })

/** 永不返回的请求：停在「加载中」 */
export const pending = (): Promise<Response> => new Promise<Response>(() => undefined)

export const search = (placeholder: string, value: string) => {
  const input = screen.getByPlaceholderText(placeholder)
  fireEvent.change(input, { target: { value } })
  fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', keyCode: 13 })
  // antd 输入框对回车有按键锁（防长按连发），不松键第二次回车不会触发 onSearch
  fireEvent.keyUp(input, { key: 'Enter', code: 'Enter', keyCode: 13 })
}

// 按 role 属性直接选：getByRole 要给整棵 antd DOM 算可访问性树，一次就是一两秒
export const byRole = (role: string, root: ParentNode = document): HTMLElement => {
  const el = root.querySelector<HTMLElement>(`[role="${role}"]`)
  if (!el) throw new Error(`找不到 role=${role} 的元素`)
  return el
}

/** 取某一行各列的文本（按表头顺序） */
export const cellsOf = (rowText: string): string[] => {
  const row = screen.getByText(rowText).closest('tr')
  if (!row) throw new Error(`找不到含「${rowText}」的行`)
  return Array.from(row.querySelectorAll('td')).map((td) => td.textContent ?? '')
}

/** QueryError 横幅里的「重试」（antd 给两字按钮自动加空格） */
export const clickRetry = () => {
  const btn = screen.getByText(/^重\s?试$/).closest('button')
  if (!btn) throw new Error('找不到重试按钮')
  fireEvent.click(btn)
}

/** 表格空状态（区别于错误横幅） */
export const tablePlaceholder = () => document.querySelector('.ant-table-placeholder')

/** 表格是否处于加载遮罩下 */
export const tableSpinning = () => document.querySelector('.ant-table-wrapper .ant-spin-spinning') !== null

/** 分页里切每页条数（antd 在 total > 50 时才出现切换器） */
export const changePageSize = async (label: string) => {
  const changer = document.querySelector<HTMLElement>('.ant-pagination-options .ant-select')
  if (!changer) throw new Error('找不到每页条数切换器')
  fireEvent.mouseDown(byRole('combobox', changer))
  fireEvent.click(await screen.findByTitle(label))
}

export const user = (over: Partial<AdminUserRow>): AdminUserRow => ({
  id: 'u_1',
  phone: '13800001111',
  nickname: null,
  avatarUrl: null,
  createdAt: '2026-09-17T16:30:05.000Z',
  deletedAt: null,
  deviceCount: 0,
  ...over,
})

export const device = (over: Partial<AdminDeviceRow>): AdminDeviceRow => ({
  deviceId: 'helmet_001',
  online: false,
  lastSeenAt: null,
  battery: null,
  charging: null,
  signalLevel: null,
  sleeping: false,
  firmwareVersion: null,
  boundAt: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  bindUser: null,
  ...over,
})

export const deviceDetail = (over: Partial<AdminDeviceDetail>): AdminDeviceDetail => ({
  ...device({}),
  settings: {},
  recentEvents: [],
  ...over,
})

export const accident = (over: Partial<AdminAccidentRow>): AdminAccidentRow => ({
  sosId: 'sos_1',
  deviceId: 'helmet_001',
  triggerEventId: 'evt_1',
  triggerType: 'possible_fall',
  status: 'pending',
  deadline: '2026-09-17T16:31:05.000Z',
  createdAt: '2026-09-17T16:30:05.000Z',
  updatedAt: '2026-09-17T16:30:05.000Z',
  location: null,
  user: null,
  ...over,
})

export const event = (over: Partial<AdminEventRow>): AdminEventRow => ({
  eventId: 'evt_1',
  deviceId: 'helmet_001',
  eventType: 'device_status',
  timestamp: '2026-09-17T16:30:00.000Z',
  receivedAt: '2026-09-17T16:30:05.000Z',
  summary: '电量 80%',
  payload: { battery: 80 },
  source: 'app_relay',
  clockSkew: false,
  schemaVersion: 1,
  ...over,
})
