import { describe, expect, it, vi } from 'vitest'
import { jsonResponse, textResponse } from '../test/render'
import { ApiError, api, clearSession, getToken, saveSession } from './client'

const lastRequest = (fetchMock: ReturnType<typeof vi.fn>) => {
  const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit]
  return { url, headers: new Headers(init.headers) }
}

describe('admin api 客户端', () => {
  it('带 token 时加 Authorization；有 body 才设 JSON Content-Type；路径拼 /api/v1 前缀', async () => {
    // 每次调用都造新的 Response：body 只能读一次
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(200, { ok: true })))
    vi.stubGlobal('fetch', fetchMock)
    saveSession('tok_1', 'ops')

    await api('/admin/users?page=1')
    let req = lastRequest(fetchMock)
    expect(req.url).toBe('/api/v1/admin/users?page=1')
    expect(req.headers.get('authorization')).toBe('Bearer tok_1')
    expect(req.headers.get('content-type')).toBeNull()

    await api('/admin/auth/login', { method: 'POST', body: JSON.stringify({}) })
    req = lastRequest(fetchMock)
    expect(req.headers.get('content-type')).toBe('application/json')
  })

  it('非 JSON 错误响应（如网关 502 页面）→ ApiError(UNKNOWN_ERROR, 502)，不抛 JSON 解析异常', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(textResponse(502, '<html>Bad Gateway</html>')))
    const err = await api('/admin/stats/overview').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ code: 'UNKNOWN_ERROR', status: 502 })
    expect((err as ApiError).message).toContain('502')
  })

  it('业务接口 401 → 清会话（token 过期回登录页）；登录接口自身的 401 交给页面提示、不清会话', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(jsonResponse(401, { code: 'UNAUTHORIZED', message: 'token 无效' })),
    )
    vi.stubGlobal('fetch', fetchMock)
    // jsdom 不实现导航：只断言会话被清、跳转被调用
    const assign = vi.fn()
    vi.spyOn(window, 'location', 'get').mockReturnValue({
      ...window.location,
      assign,
    } as unknown as Location)

    saveSession('tok_expired', 'ops')
    await expect(api('/admin/users')).rejects.toMatchObject({ code: 'UNAUTHORIZED', status: 401 })
    expect(getToken()).toBeNull()
    expect(assign).toHaveBeenCalledWith('/login')

    assign.mockClear()
    saveSession('tok_keep', 'ops')
    await expect(api('/admin/auth/login', { method: 'POST', body: '{}' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    })
    expect(getToken()).toBe('tok_keep')
    expect(assign).not.toHaveBeenCalled()
    clearSession()
  })
})
