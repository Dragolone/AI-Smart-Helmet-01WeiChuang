// 登录页边界：空表单不发请求、登录中按钮转圈、5xx / 网关非 JSON 的提示、登录接口 401 不触发全局跳转
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { getToken } from '../api/client'
import { pending, stubApi } from '../test/fixtures'
import { jsonResponse, renderWithProviders, textResponse } from '../test/render'
import LoginPage from './LoginPage'

const renderLogin = () =>
  renderWithProviders(
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/overview" element={<div>概览页</div>} />
    </Routes>,
    '/login',
  )

const fill = (username: string, password: string) => {
  fireEvent.change(screen.getByPlaceholderText('用户名'), { target: { value: username } })
  fireEvent.change(screen.getByPlaceholderText('密码'), { target: { value: password } })
}

const submitButton = () => screen.getByText(/^登\s?录$/).closest('button') as HTMLElement

describe('LoginPage：边界', () => {
  it('什么都不填就点登录 → 两个必填提示，不发请求', async () => {
    const apiStub = stubApi(() => jsonResponse(200, {}))
    renderLogin()
    fireEvent.click(submitButton())
    expect(await screen.findByText('请输入用户名')).toBeInTheDocument()
    expect(screen.getByText('请输入密码')).toBeInTheDocument()
    expect(apiStub.count()).toBe(0)
  })

  it('只填用户名 → 只提示密码，不发请求', async () => {
    const apiStub = stubApi(() => jsonResponse(200, {}))
    renderLogin()
    fill('ops', '')
    fireEvent.click(submitButton())
    expect(await screen.findByText('请输入密码')).toBeInTheDocument()
    expect(screen.queryByText('请输入用户名')).not.toBeInTheDocument()
    expect(apiStub.count()).toBe(0)
  })

  it('请求在途时按钮转圈', async () => {
    const apiStub = stubApi(() => pending())
    renderLogin()
    fill('ops', 'pw')
    fireEvent.click(submitButton())
    await waitFor(() => expect(apiStub.count()).toBe(1))
    await waitFor(() => expect(submitButton()).toHaveClass('ant-btn-loading'))
  })

  it('后端 500 → 「登录失败：INTERNAL_ERROR（HTTP 500）」，不说成密码错误', async () => {
    stubApi(() => jsonResponse(500, { code: 'INTERNAL_ERROR', message: 'x' }))
    renderLogin()
    fill('ops', 'pw')
    fireEvent.click(submitButton())
    expect(await screen.findByText('登录失败：INTERNAL_ERROR（HTTP 500）')).toBeInTheDocument()
    expect(screen.queryByText('用户名或密码错误')).not.toBeInTheDocument()
  })

  it('网关回 502 HTML 页 → 「登录失败：UNKNOWN_ERROR（HTTP 502）」', async () => {
    stubApi(() => textResponse(502, '<html>Bad Gateway</html>'))
    renderLogin()
    fill('ops', 'pw')
    fireEvent.click(submitButton())
    expect(await screen.findByText('登录失败：UNKNOWN_ERROR（HTTP 502）')).toBeInTheDocument()
  })

  it('登录接口 401 只提示密码错误，不触发全局「清会话跳登录」（否则页面会整页刷新、提示一闪而过）', async () => {
    const assign = vi.fn()
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, assign } as unknown as Location)
    stubApi(() => jsonResponse(401, { code: 'UNAUTHORIZED', message: 'x' }))
    renderLogin()
    fill('ops', 'wrong')
    fireEvent.click(submitButton())
    expect(await screen.findByText('用户名或密码错误')).toBeInTheDocument()
    expect(assign).not.toHaveBeenCalled()
    expect(getToken()).toBeNull()
  })

  it('密码含空格与特殊字符 → 原样提交，不 trim 不转义', async () => {
    const apiStub = stubApi(() => jsonResponse(401, { code: 'UNAUTHORIZED', message: 'x' }))
    renderLogin()
    fill('ops', ' p@ss "w0rd" ')
    fireEvent.click(submitButton())
    await waitFor(() => expect(apiStub.count()).toBe(1))
    const init = apiStub.fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(String(init[1].body))).toEqual({ username: 'ops', password: ' p@ss "w0rd" ' })
  })
})
