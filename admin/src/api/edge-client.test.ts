import { describe, expect, it, vi } from 'vitest'
import { jsonResponse, textResponse } from '../test/render'
import { ApiError, api, clearSession, getToken, getUsername, saveSession } from './client'

// jsdom 不实现导航：换掉 location 只为观察 assign 有没有被调用
const spyOnAssign = () => {
  const assign = vi.fn()
  vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, assign } as unknown as Location)
  return assign
}

const stubFetch = (make: () => Response) => {
  const fetchMock = vi.fn((_url: string, _init?: RequestInit) => Promise.resolve(make()))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('admin api 客户端：边界', () => {
  it('未登录（无 token / token 为空串）不带 Authorization 头', async () => {
    const fetchMock = stubFetch(() => jsonResponse(200, {}))
    await api('/admin/stats/overview')
    saveSession('', 'ops')
    await api('/admin/stats/overview')
    for (const [, init] of fetchMock.mock.calls) {
      expect(new Headers(init?.headers).has('authorization')).toBe(false)
    }
  })

  it('调用方的 method / 自定义头原样透传；有 body 时 Content-Type 统一成 JSON', async () => {
    const fetchMock = stubFetch(() => jsonResponse(200, {}))
    await api('/admin/auth/login', {
      method: 'POST',
      headers: { 'X-Request-Id': 'req_1', 'Content-Type': 'text/plain' },
      body: '{}',
    })
    const [, init] = fetchMock.mock.calls[0]
    const headers = new Headers(init?.headers)
    expect(init?.method).toBe('POST')
    expect(headers.get('x-request-id')).toBe('req_1')
    expect(headers.get('content-type')).toBe('application/json')
  })

  it.each([
    ['null', null],
    ['数组', ['boom']],
    ['字符串', 'boom'],
    ['数字', 502],
  ])('错误响应体是合法 JSON 但不是对象（%s）→ 仍归一成 ApiError(UNKNOWN_ERROR)，不抛 TypeError', async (_name, body) => {
    stubFetch(() => jsonResponse(502, body))
    const err = await api('/admin/users').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ code: 'UNKNOWN_ERROR', status: 502, message: '请求失败（HTTP 502）' })
  })

  it('错误体缺 code（如框架默认的 { statusCode, message, error }）→ code 兜底为 UNKNOWN_ERROR，message 保留', async () => {
    stubFetch(() => jsonResponse(404, { statusCode: 404, message: 'Cannot GET /api/v1/admin/nope', error: 'Not Found' }))
    const err = await api('/admin/nope').catch((e: unknown) => e)
    expect(err).toMatchObject({ code: 'UNKNOWN_ERROR', status: 404, message: 'Cannot GET /api/v1/admin/nope' })
  })

  it('错误体只有 code 没有 message → message 兜底带上 HTTP 状态码', async () => {
    stubFetch(() => jsonResponse(429, { code: 'RATE_LIMITED' }))
    const err = await api('/admin/users').catch((e: unknown) => e)
    expect(err).toMatchObject({ code: 'RATE_LIMITED', status: 429, message: '请求失败（HTTP 429）' })
  })

  it('401 且响应体不是 JSON（网关直接拦的 401）→ 照样清会话并跳登录', async () => {
    stubFetch(() => textResponse(401, '<html>401 Authorization Required</html>'))
    const assign = spyOnAssign()
    saveSession('tok_expired', 'ops')
    await expect(api('/admin/devices')).rejects.toMatchObject({ code: 'UNKNOWN_ERROR', status: 401 })
    expect(getToken()).toBeNull()
    expect(getUsername()).toBeNull()
    expect(assign).toHaveBeenCalledWith('/login')
  })

  it.each([403, 404, 409, 429, 500, 503])('HTTP %i 不是登录失效：保留会话、不跳转', async (status) => {
    stubFetch(() => jsonResponse(status, { code: 'SOME_ERROR', message: 'x' }))
    const assign = spyOnAssign()
    saveSession('tok_keep', 'ops')
    await expect(api('/admin/users')).rejects.toMatchObject({ code: 'SOME_ERROR', status })
    expect(getToken()).toBe('tok_keep')
    expect(assign).not.toHaveBeenCalled()
  })

  it('fetch 自身抛错（断网 / 后端没起）→ 原样抛出而不是 ApiError，会话不动——页面据此区分「没应答」与「应答了错误」', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    const assign = spyOnAssign()
    saveSession('tok_keep', 'ops')
    const err = await api('/admin/users').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TypeError)
    expect(err).not.toBeInstanceOf(ApiError)
    expect(getToken()).toBe('tok_keep')
    expect(assign).not.toHaveBeenCalled()
  })

  it('200 但响应体不是 JSON（反代把 SPA 的 index.html 回给了 API 路径）→ 报错，不把垃圾当数据返回', async () => {
    stubFetch(() => textResponse(200, '<!doctype html><html></html>'))
    await expect(api('/admin/users')).rejects.toBeInstanceOf(Error)
  })

  it('令牌每次请求现读：过期后重新登录换了 token，下一次请求就用新的', async () => {
    const fetchMock = stubFetch(() => jsonResponse(200, {}))
    saveSession('tok_old', 'ops')
    await api('/admin/users')
    saveSession('tok_new', 'ops')
    await api('/admin/users')
    const auths = fetchMock.mock.calls.map(([, init]) => new Headers(init?.headers).get('authorization'))
    expect(auths).toEqual(['Bearer tok_old', 'Bearer tok_new'])
  })

  it('调用方传 Headers 实例或二维数组形式的头 → 照样合并，不丢', async () => {
    const fetchMock = stubFetch(() => jsonResponse(200, {}))
    saveSession('tok_1', 'ops')
    await api('/admin/users', { headers: new Headers({ 'X-Trace': 'a' }) })
    await api('/admin/users', { headers: [['X-Trace', 'b']] })
    const got = fetchMock.mock.calls.map(([, init]) => {
      const h = new Headers(init?.headers)
      return [h.get('x-trace'), h.get('authorization')]
    })
    expect(got).toEqual([
      ['a', 'Bearer tok_1'],
      ['b', 'Bearer tok_1'],
    ])
  })

  it('路径原样拼接、客户端不替调用方编码：`#` 之后会被 fetch 当成片段丢掉，编码是调用处的责任', async () => {
    const fetchMock = stubFetch(() => jsonResponse(200, {}))
    await api('/admin/devices/a%23b')
    await api('/admin/devices/a#b')
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/v1/admin/devices/a%23b',
      '/api/v1/admin/devices/a#b',
    ])
  })

  it('两个请求同时 401（列表轮询与详情同时过期）→ 都抛 ApiError、会话清空、跳登录不报错', async () => {
    stubFetch(() => jsonResponse(401, { code: 'UNAUTHORIZED', message: 'jwt expired' }))
    const assign = spyOnAssign()
    saveSession('tok_expired', 'ops')
    const results = await Promise.allSettled([api('/admin/devices'), api('/admin/stats/overview')])
    for (const r of results) {
      expect(r.status).toBe('rejected')
      expect((r as PromiseRejectedResult).reason).toMatchObject({ code: 'UNAUTHORIZED', status: 401 })
    }
    expect(getToken()).toBeNull()
    expect(assign).toHaveBeenCalledWith('/login')
  })

  it('错误体的 message 是数组（框架默认的校验错误格式）→ 拼成字符串放进 Error，不抛异常', async () => {
    stubFetch(() =>
      jsonResponse(400, {
        code: 'VALIDATION_FAILED',
        message: ['keyword must be shorter than or equal to 64 characters'],
      }),
    )
    const err = await api('/admin/users?keyword=x').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ code: 'VALIDATION_FAILED', status: 400 })
    expect((err as ApiError).message).toBe('keyword must be shorter than or equal to 64 characters')
  })

  it('200 但响应体为空（如 204 风格的空体）→ 抛 JSON 解析错误而不是返回 undefined（后台现有接口都带体）', async () => {
    stubFetch(() => new Response('', { status: 200 }))
    await expect(api('/admin/users')).rejects.toBeInstanceOf(SyntaxError)
  })

  it('200 且体为 JSON null → 原样返回 null，由调用处兜底', async () => {
    stubFetch(() => jsonResponse(200, null))
    await expect(api('/admin/users')).resolves.toBeNull()
  })

  it('body 为空串也算「有 body」→ 照样设 JSON Content-Type；不传 body 的 GET 不设', async () => {
    const fetchMock = stubFetch(() => jsonResponse(200, {}))
    await api('/admin/auth/login', { method: 'POST', body: '' })
    await api('/admin/users', { method: 'GET' })
    const types = fetchMock.mock.calls.map(([, init]) => new Headers(init?.headers).get('content-type'))
    expect(types).toEqual(['application/json', null])
  })

  it('会话存取：保存后可读回，clearSession 把 token 与用户名一起清掉', () => {
    expect(getToken()).toBeNull()
    expect(getUsername()).toBeNull()
    saveSession('tok_1', '运维-小王')
    expect(getToken()).toBe('tok_1')
    expect(getUsername()).toBe('运维-小王')
    clearSession()
    expect(getToken()).toBeNull()
    expect(getUsername()).toBeNull()
  })
})
