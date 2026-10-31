// 统一 API 客户端：带 token、统一错误格式（依赖 code 不依赖 message）、401 全局跳登录

const TOKEN_KEY = 'admin_token'
const USERNAME_KEY = 'admin_username'

export const getToken = (): string | null => localStorage.getItem(TOKEN_KEY)

export const getUsername = (): string | null =>
  localStorage.getItem(USERNAME_KEY)

export const saveSession = (token: string, username: string): void => {
  localStorage.setItem(TOKEN_KEY, token)
  localStorage.setItem(USERNAME_KEY, username)
}

export const clearSession = (): void => {
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(USERNAME_KEY)
}

export class ApiError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status: number) {
    super(message)
    this.code = code
    this.status = status
  }
}

/** 后端或数据库卡死但不断连接时，请求不结束、轮询也不再发，旧数字一直留着还没有提示 */
const REQUEST_TIMEOUT_MS = 20_000

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(), REQUEST_TIMEOUT_MS)
  try {
    return await request<T>(path, {
      ...init,
      signal: init?.signal
        ? AbortSignal.any([init.signal, timeout.signal])
        : timeout.signal,
    })
  } catch (err) {
    if (timeout.signal.aborted) {
      throw new ApiError('REQUEST_TIMEOUT', '服务器没有响应，请稍后重试', 0)
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

async function request<T>(path: string, init: RequestInit): Promise<T> {
  const headers = new Headers(init.headers)
  if (init.body !== undefined) {
    headers.set('Content-Type', 'application/json')
  }
  const token = getToken()
  if (token) headers.set('Authorization', `Bearer ${token}`)

  const res = await fetch(`/api/v1${path}`, { ...init, headers })

  if (!res.ok) {
    let body: { code?: string; message?: string } = {}
    try {
      // 合法 JSON 不一定是对象：体为 null 时直接取 .code 会抛 TypeError，绕过下面的统一错误格式
      const parsed: unknown = await res.json()
      if (parsed !== null && typeof parsed === 'object') body = parsed as typeof body
    } catch {
      // 非 JSON 错误响应（如网关 502）走兜底
    }
    // token 过期/无效：清会话回登录页；登录接口本身的 401 交给页面提示
    if (res.status === 401 && !path.startsWith('/admin/auth/')) {
      clearSession()
      window.location.assign('/login')
    }
    throw new ApiError(
      body.code ?? 'UNKNOWN_ERROR',
      body.message ?? `请求失败（HTTP ${res.status}）`,
      res.status,
    )
  }
  return (await res.json()) as T
}
