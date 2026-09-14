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

/** 单次请求超时：后端挂起/黑洞网络时不能让页面永远转圈（审计 APP-03）；超时按网络错误呈现 */
const REQUEST_TIMEOUT_MS = 15_000;

function fetchWithTimeout(input: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  return fetch(input, { ...init, signal: controller.signal }).finally(() =>
    clearTimeout(timer),
  );
}

/**
 * 刷新结果三态（审计 AUTH-09/10）：
 * - ok：已换到新 token，原请求可重试；
 * - invalid：服务端明确否定了 refresh token（401）——会话确实终结，清本地会话；
 * - stale：刷新期间用户已登出/换了账号，或刷新遇到 429/5xx/断网——会话并未被否定，
 *   不能清会话、更不能把旧账号的新 token 写回。
 */
type RefreshOutcome = 'ok' | 'invalid' | 'stale';

/** refresh 轮换制：并发 401 只允许一次刷新，其余请求等同一个 Promise，防止旧 token 复用被判盗用 */
let refreshing: Promise<RefreshOutcome> | null = null;

async function refreshTokens(): Promise<RefreshOutcome> {
  refreshing ??= (async (): Promise<RefreshOutcome> => {
    const tokens = session?.getTokens();
    if (!tokens) return 'invalid';
    const startedWith = tokens.refreshToken;
    let res: Response;
    try {
      res = await fetchWithTimeout(`${BASE_URL}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: startedWith }),
      });
    } catch {
      return 'stale';
    }
    if (res.status === 401) return 'invalid';
    if (!res.ok) return 'stale';
    const next = (await res.json()) as AuthTokens;
    // 刷新在途时用户已登出或换了账号：这份新 token 属于旧会话，丢弃并尽力在服务端作废
    if (session?.getTokens()?.refreshToken !== startedWith) {
      void fetch(`${BASE_URL}/auth/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: next.refreshToken }),
      }).catch(() => undefined);
      return 'stale';
    }
    await session?.setTokens(next);
    return 'ok';
  })().finally(() => {
    // 置空必须在 settle 后，让下一轮 401 能重新发起刷新
    refreshing = null;
  });
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
    return fetchWithTimeout(`${BASE_URL}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  };

  let res = await doFetch();

  // access 过期（15min）→ 静默刷新一次并重试；只有服务端明确否定 refresh token 才算会话终结
  if (res.status === 401 && auth) {
    const outcome = await refreshTokens();
    if (outcome === 'ok') {
      res = await doFetch();
    } else if (outcome === 'invalid') {
      await session?.clearSession();
    }
    // stale：保留会话，把原 401 交给调用方（下一次请求会再刷新）
  }

  if (!res.ok) throw await parseError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
