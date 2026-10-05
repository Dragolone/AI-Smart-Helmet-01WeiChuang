import { fireEvent, screen, waitFor } from '@testing-library/react'
import { Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { getToken, getUsername } from '../api/client'
import { jsonResponse, renderWithProviders } from '../test/render'
import LoginPage from './LoginPage'

const submit = (username = 'ops', password = 'secret_pw') => {
  fireEvent.change(screen.getByPlaceholderText('用户名'), { target: { value: username } })
  fireEvent.change(screen.getByPlaceholderText('密码'), { target: { value: password } })
  fireEvent.click(screen.getByRole('button', { name: '登 录' }))
}

const renderLogin = () =>
  renderWithProviders(
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/overview" element={<div>概览页</div>} />
      <Route path="/users" element={<div>用户列表页</div>} />
    </Routes>,
    '/login',
  )

describe('LoginPage', () => {
  it('凭证错误（401）→ 提示「用户名或密码错误」，不进后台', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(401, { code: 'UNAUTHORIZED', message: 'x' })),
    )
    renderLogin()
    submit()
    expect(await screen.findByText('用户名或密码错误')).toBeInTheDocument()
    expect(getToken()).toBeNull()
  })

  it('后端不可达（fetch 抛错）→ 提示「无法连接服务器」而不是密码错误（审计 ADMIN-03）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    renderLogin()
    submit()
    expect(await screen.findByText('无法连接服务器，请检查网络或稍后再试')).toBeInTheDocument()
    expect(screen.queryByText('用户名或密码错误')).not.toBeInTheDocument()
  })

  it('其他 HTTP 错误（如 429 限频）→ 显示 code 与状态码', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(429, { code: 'RATE_LIMITED', message: 'x' })),
    )
    renderLogin()
    submit()
    expect(await screen.findByText('登录失败：RATE_LIMITED（HTTP 429）')).toBeInTheDocument()
  })

  it('登录成功 → 保存 token 与用户名并进概览页（后台首页），不是用户列表', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, { admin: { id: 'a1', username: 'ops' }, accessToken: 'tok_ok' }),
    )
    vi.stubGlobal('fetch', fetchMock)
    renderLogin()
    submit('ops', 'secret_pw')
    expect(await screen.findByText('概览页')).toBeInTheDocument()
    expect(screen.queryByText('用户列表页')).not.toBeInTheDocument()
    expect(getToken()).toBe('tok_ok')
    expect(getUsername()).toBe('ops')
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/v1/admin/auth/login')
    expect(JSON.parse(String(init.body))).toEqual({ username: 'ops', password: 'secret_pw' })
  })

  it('已登录时访问 /login 直接进后台', async () => {
    localStorage.setItem('admin_token', 'tok_existing')
    renderLogin()
    await waitFor(() => expect(screen.getByText('概览页')).toBeInTheDocument())
  })
})
