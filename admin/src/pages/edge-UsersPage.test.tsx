// 用户列表页边界：加载中 / 报错重试 / 断网 / 空列表、关键字编码、「含已注销」开关来回、改每页条数、
// 超长昵称 / 大绑定数、不轮询（用户数据不随心跳变化）。
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AdminUserRow } from '@helmet/shared'
import {
  ERROR_BANNER,
  cellsOf,
  changePageSize,
  clickRetry,
  page,
  pending,
  search,
  stubApi,
  tablePlaceholder,
  tableSpinning,
  user,
} from '../test/fixtures'
import { jsonResponse, renderWithProviders } from '../test/render'
import UsersPage from './UsersPage'

const PLACEHOLDER = '按手机号 / 昵称搜索'

beforeAll(() => {
  vi.stubEnv('TZ', 'Asia/Shanghai')
})
afterAll(() => {
  vi.unstubAllEnvs()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('UsersPage：加载 / 错误 / 空', () => {
  it('加载中：表格转圈，不出错误横幅与分页总数', async () => {
    const apiStub = stubApi(() => pending())
    renderWithProviders(<UsersPage />)
    await waitFor(() => expect(apiStub.count()).toBe(1))
    expect(tableSpinning()).toBe(true)
    expect(screen.queryByText(ERROR_BANNER)).not.toBeInTheDocument()
    expect(screen.queryByText(/共 \d+ 个用户/)).not.toBeInTheDocument()
  })

  it('接口 500 → 横幅；点重试成功后出数据', async () => {
    const apiStub = stubApi((_url, call) =>
      call === 1 ? jsonResponse(500, { code: 'INTERNAL_ERROR', message: 'x' }) : page([user({ phone: '13900009999' })]),
    )
    renderWithProviders(<UsersPage />)
    expect(await screen.findByText('INTERNAL_ERROR（HTTP 500）')).toBeInTheDocument()
    clickRetry()
    expect(await screen.findByText('13900009999')).toBeInTheDocument()
    expect(apiStub.count()).toBe(2)
    expect(screen.queryByText(ERROR_BANNER)).not.toBeInTheDocument()
  })

  it('断网 → 横幅显示原始错误信息', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    renderWithProviders(<UsersPage />)
    expect(await screen.findByText('Failed to fetch')).toBeInTheDocument()
  })

  it('空列表：空状态，不出错误横幅', async () => {
    const apiStub = stubApi(() => page<AdminUserRow>([], 0))
    renderWithProviders(<UsersPage />)
    await waitFor(() => expect(apiStub.count()).toBe(1))
    await waitFor(() => expect(tablePlaceholder()).toHaveTextContent('暂无数据'))
    expect(screen.queryByText(ERROR_BANNER)).not.toBeInTheDocument()
  })
})

describe('UsersPage：单元格', () => {
  it('30 字昵称整段显示；绑定数 9999 照实；注销 / 注册时间精确到分钟', async () => {
    const nick = '骑'.repeat(30)
    stubApi(() =>
      page([
        user({
          id: 'u_1',
          phone: 'deleted:u_1',
          nickname: nick,
          deviceCount: 9999,
          deletedAt: '2026-10-15T15:59:59.000Z',
          createdAt: '2026-01-01T00:00:00.000Z',
        }),
      ]),
    )
    renderWithProviders(<UsersPage />)
    await screen.findByText(nick)
    expect(cellsOf(nick)).toEqual(['已注销', nick, '2026-10-15 23:59', '9999', '2026-01-01 08:00'])
  })
})

describe('UsersPage：搜索与筛选', () => {
  it('中文昵称、LIKE 通配符 `%` `_`、emoji、带 + 的手机号都整段作为一个 keyword 发出', async () => {
    const apiStub = stubApi(() => page<AdminUserRow>([]))
    renderWithProviders(<UsersPage />)
    await waitFor(() => expect(apiStub.count()).toBe(1))
    for (const kw of ['老王', '100%_', '🛵骑手', '+8613800001111']) {
      search(PLACEHOLDER, kw)
      await waitFor(() => expect(apiStub.last().searchParams.get('keyword')).toBe(kw))
    }
    expect(apiStub.rawLast()).toContain('keyword=%2B8613800001111')
  })

  it('「含已注销」勾上 → includeDeleted=true；再取消 → 参数消失（不是发 false）', async () => {
    const apiStub = stubApi(() => page([user({})], 1))
    renderWithProviders(<UsersPage />)
    await screen.findByText('共 1 个用户')
    fireEvent.click(screen.getByLabelText('含已注销'))
    await waitFor(() => expect(apiStub.last().searchParams.get('includeDeleted')).toBe('true'))
    await screen.findByText('共 1 个用户')
    fireEvent.click(screen.getByLabelText('含已注销'))
    await waitFor(() => expect(apiStub.last().searchParams.has('includeDeleted')).toBe(false))
  })

  it('关键字与「含已注销」叠加：两个参数同时在', async () => {
    const apiStub = stubApi(() => page([user({})], 1))
    renderWithProviders(<UsersPage />)
    await screen.findByText('共 1 个用户')
    fireEvent.click(screen.getByLabelText('含已注销'))
    await waitFor(() => expect(apiStub.last().searchParams.get('includeDeleted')).toBe('true'))
    search(PLACEHOLDER, '138')
    await waitFor(() => expect(apiStub.last().searchParams.get('keyword')).toBe('138'))
    expect(apiStub.last().searchParams.get('includeDeleted')).toBe('true')
  })
})

describe('UsersPage：数据变少后的页码', () => {
  it('停在第 3 页，期间有账号注销、总数降到 41 → 自动回到末页（第 3 页仍在）；再降到 30 → 回第 2 页', async () => {
    let total = 45
    const apiStub = stubApi((url) =>
      Number(url.searchParams.get('page')) > Math.ceil(total / 20)
        ? page<AdminUserRow>([], total)
        : page([user({ phone: `1380000000${url.searchParams.get('page')}` })], total),
    )
    renderWithProviders(<UsersPage />)
    await screen.findByText('共 45 个用户')
    fireEvent.click(screen.getByTitle('3'))
    expect(await screen.findByText('13800000003')).toBeInTheDocument()

    total = 41
    fireEvent(window, new Event('visibilitychange'))
    expect(await screen.findByText('共 41 个用户')).toBeInTheDocument()
    expect(apiStub.last().searchParams.get('page')).toBe('3')

    total = 30
    fireEvent(window, new Event('visibilitychange'))
    expect(await screen.findByText('13800000002')).toBeInTheDocument()
    expect(apiStub.last().searchParams.get('page')).toBe('2')
  })
})

describe('UsersPage：分页与刷新', () => {
  it('停在第 2 页时改成 50 条/页 → 回第 1 页', async () => {
    const apiStub = stubApi(() => page([user({})], 80))
    renderWithProviders(<UsersPage />)
    await screen.findByText('共 80 个用户')
    fireEvent.click(screen.getByTitle('2'))
    await waitFor(() => expect(apiStub.last().searchParams.get('page')).toBe('2'))
    await screen.findByText('共 80 个用户')
    await changePageSize('50 条/页')
    await waitFor(() => expect(apiStub.last().searchParams.get('pageSize')).toBe('50'))
    expect(apiStub.last().searchParams.get('page')).toBe('1')
  })

  it('用户列表不轮询：停留 60 秒不发第二次请求', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const apiStub = stubApi(() => page([user({})], 1))
    renderWithProviders(<UsersPage />)
    await screen.findByText('共 1 个用户')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(apiStub.count()).toBe(1)
  })
})
