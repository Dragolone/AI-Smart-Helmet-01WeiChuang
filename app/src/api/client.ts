// 统一 API 客户端：Bearer 注入、401 静默刷新（排队防并发轮换冲突）、错误规范化。
// Base URL 通过 EXPO_PUBLIC_API_URL 配置（默认本机后端）；Contract 见 docs/API.md。
import type { ApiErrorBody, AuthTokens } from '@helmet/shared';

const BASE_URL =
  process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000/api/v1';

/** 会话操作由 auth-store 注入，避免 api 层与 store 层循环依赖 */
type SessionHooks = {
  getTokens: () => AuthTokens | null;
  setTokens: (tokens: AuthTokens) => Promise<void>;
  clearSession: () => Promise<void>;
};

let session: SessionHooks | null = null;

export function attachSession(hooks: SessionHooks): void {
  session = hooks;
}

export class ApiRequestError extends Error {
  readonly code: string;
  readonly status: number;
  readonly requestId?: string;

  constructor(status: number, body: Partial<ApiErrorBody>) {
    super(body.message ?? `HTTP ${status}`);
    this.code = body.code ?? 'INTERNAL_ERROR';
    this.status = status;
    this.requestId = body.requestId;
  }
}

/** refresh 轮换制：并发 401 只允许一次刷新，其余请求等同一个 Promise，防止旧 token 复用被判盗用 */
let refreshing: Promise<boolean> | null = null;

async function refreshTokens(): Promise<boolean> {
  refreshing ??= (async () => {
    const tokens = session?.getTokens();
    if (!tokens) return false;
    try {
      const res = await fetch(`${BASE_URL}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: tokens.refreshToken }),
      });
      if (!res.ok) return false;
      const next = (await res.json()) as AuthTokens;
      await session?.setTokens(next);
      return true;
    } catch {
      return false;
    } finally {
      // 置空必须在 settle 后，让下一轮 401 能重新发起刷新
      refreshing = null;
    }
  })();
  return refreshing;
}

async function parseError(res: Response): Promise<ApiRequestError> {
  try {
    const body = (await res.json()) as Partial<ApiErrorBody>;
    return new ApiRequestError(res.status, body);
  } catch {
    return new ApiRequestError(res.status, {});
  }
}

export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown; auth?: boolean } = {},
): Promise<T> {
  const { method = 'GET', body, auth = true } = options;

  const doFetch = async (): Promise<Response> => {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (auth) {
      const tokens = session?.getTokens();
      if (tokens) headers.Authorization = `Bearer ${tokens.accessToken}`;
    }
    return fetch(`${BASE_URL}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  };

  let res = await doFetch();

  // access 过期（15min）→ 静默刷新一次并重试；刷新失败 = 会话终结，登出
  if (res.status === 401 && auth) {
    const refreshed = await refreshTokens();
    if (refreshed) {
      res = await doFetch();
    } else {
      await session?.clearSession();
    }
  }

  if (!res.ok) throw await parseError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
