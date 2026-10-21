// 统一 API 客户端：Bearer 注入、401 静默刷新（排队防并发轮换冲突）、错误规范化。
// Base URL 通过 EXPO_PUBLIC_API_URL 配置（默认本机后端）；Contract 见 docs/API.md。
import type { ApiErrorBody, AuthTokens } from "@helmet/shared";

import { API_BASE_URL as BASE_URL } from "@/constants/api";
import { noteServerDate } from "@/services/server-clock";

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
  /** 429 的 `Retry-After`（秒）：限频还要等多久（决策 #53）；没有或解析不了为 undefined */
  readonly retryAfterSec?: number;
  /**
   * 请求带着登录会话发出（auth: true）。同是 401 UNAUTHORIZED：登录接口的是「手机号或密码不正确」，
   * 带会话的接口是「登录状态没核对上」——文案要分开（error-messages）
   */
  readonly withSession: boolean;

  constructor(
    status: number,
    body: Partial<ApiErrorBody>,
    retryAfterSec?: number,
    withSession = false,
  ) {
    super(body.message ?? `HTTP ${status}`);
    this.code = body.code ?? "INTERNAL_ERROR";
    this.status = status;
    this.requestId = body.requestId;
    this.retryAfterSec = retryAfterSec;
    this.withSession = withSession;
  }
}

/**
 * 原请求 401、这次却没换成新 token（刷新遇到 429 / 5xx / 超时 / 断网，或刷新途中换了账号）：
 * 会话没有被否定，只是此刻核对不了——按「暂时失败、稍后再试」呈现。原来把原 401 抛出去，
 * 页面显示的是登录页那句「手机号或密码不正确」（10-17 评审）。status 仍是 401，按状态码分流的调用方行为不变
 */
export class SessionCheckUnavailableError extends Error {
  readonly status = 401;
  readonly code = "SESSION_CHECK_UNAVAILABLE";
  constructor() {
    super("session check unavailable");
    this.name = "SessionCheckUnavailableError";
  }
}

/** 服务端否定了 refresh token：本地会话已清，界面正被送回登录页（登录页顶部有说明，页面不必再弹提示） */
export class SessionEndedError extends Error {
  readonly status = 401;
  readonly code = "SESSION_ENDED";
  constructor() {
    super("session ended");
    this.name = "SessionEndedError";
  }
}

/** `Retry-After` 只认「秒数」写法（服务端限频守卫就这么发）；HTTP 日期写法与非法值都当没有 */
export function parseRetryAfter(
  header: string | null | undefined,
): number | undefined {
  if (!header) return undefined;
  const n = Number(header.trim());
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** 单次请求超时：后端挂起/黑洞网络时不能让页面永远转圈（审计 APP-03）；超时按网络错误呈现 */
export const REQUEST_TIMEOUT_MS = 15_000;

function fetchWithTimeout(
  input: string,
  init: RequestInit,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(input, { ...init, signal: controller.signal })
    .then((res) => {
      // 顺手学服务端时钟（倒计时与头盔对时都用它，见 services/server-clock）
      try {
        noteServerDate(res.headers?.get?.("date"));
      } catch {
        // 测试里的假 Response 没有 headers；真机上 fetch 的 Response 一定有
      }
      return res;
    })
    .finally(() => clearTimeout(timer));
}

/**
 * 刷新结果三态（审计 AUTH-09/10）：
 * - ok：已换到新 token，原请求可重试；
 * - invalid：服务端明确否定了 refresh token（401）——会话确实终结，清本地会话；
 * - stale：刷新期间用户已登出/换了账号，或刷新遇到 429/5xx/断网——会话并未被否定，
 *   不能清会话、更不能把旧账号的新 token 写回。
 */
type RefreshOutcome = "ok" | "invalid" | "stale";

const isTokenPair = (v: unknown): v is AuthTokens => {
  const t = v as Partial<AuthTokens> | null;
  return (
    typeof t?.accessToken === "string" &&
    t.accessToken !== "" &&
    typeof t.refreshToken === "string" &&
    t.refreshToken !== ""
  );
};

/** refresh 轮换制：并发 401 只允许一次刷新，其余请求等同一个 Promise，防止旧 token 复用被判盗用 */
let refreshing: Promise<RefreshOutcome> | null = null;

/**
 * 主动换一次 access token（WS 被判过期时用）。
 * 不能靠「随便发个请求等它 401」：WS 网关按 token 的 exp 主动断连，而同一个 token 在 REST 这边
 * 可能还没到判过期的那一刻——那样 me() 返回 200、不触发刷新，客户端就会拿着同一个 token
 * 反复重连（2026-09-23 iPhone 真机实测：每 8–30 秒断一次，reason=访问令牌已过期）。
 */
export async function forceRefreshTokens(): Promise<
  "ok" | "invalid" | "stale"
> {
  const outcome = await refreshTokens();
  // 与 api() 的 401 分支同口径：refresh 被明确否定=会话真的结束，清掉本地会话，
  // 否则 WS 会拿着一副死牌一直重连下去。stale（断网/429/5xx）保留会话等下次。
  if (outcome === "invalid") await session?.clearSession();
  return outcome;
}

async function refreshTokens(): Promise<RefreshOutcome> {
  refreshing ??= (async (): Promise<RefreshOutcome> => {
    const tokens = session?.getTokens();
    if (!tokens) return "invalid";
    const startedWith = tokens.refreshToken;
    let res: Response;
    try {
      res = await fetchWithTimeout(`${BASE_URL}/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: startedWith }),
      });
    } catch {
      return "stale";
    }
    // 401 否定的是「发起时那把」refresh token。刷新在途时若已登出并换了账号，被否定的不是现在这个会话，
    // 不能回 invalid 让调用方把新账号的会话清掉（200 分支早有这层核对，401 分支原来没有）
    if (res.status === 401)
      return session?.getTokens()?.refreshToken === startedWith
        ? "invalid"
        : "stale";
    if (!res.ok) return "stale";
    const next = (await res.json()) as unknown;
    // 200 却没带出一对 token（网关改写了响应体等）：当作这次没刷成。写进去的话后续请求会带着
    // `Bearer undefined`，而且会话再也清不掉
    if (!isTokenPair(next)) return "stale";
    // 刷新在途时用户已登出或换了账号：这份新 token 属于旧会话，丢弃并尽力在服务端作废
    if (session?.getTokens()?.refreshToken !== startedWith) {
      void fetch(`${BASE_URL}/auth/logout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: next.refreshToken }),
      }).catch(() => undefined);
      return "stale";
    }
    try {
      await session?.setTokens(next);
    } catch {
      // 落盘失败（钥匙串暂不可用）但内存里已经换上新 token：这次刷新是成的，原请求照常重试；
      // 内存里也没换上才算没刷成
      if (session?.getTokens()?.refreshToken !== next.refreshToken)
        return "stale";
    }
    return "ok";
  })().finally(() => {
    // 置空必须在 settle 后，让下一轮 401 能重新发起刷新
    refreshing = null;
  });
  return refreshing;
}

async function parseError(
  res: Response,
  withSession: boolean,
): Promise<ApiRequestError> {
  const retryAfter = parseRetryAfter(res.headers?.get?.("retry-after"));
  try {
    const body = (await res.json()) as Partial<ApiErrorBody>;
    return new ApiRequestError(res.status, body, retryAfter, withSession);
  } catch {
    return new ApiRequestError(res.status, {}, retryAfter, withSession);
  }
}

/** 此刻的 refresh token（请求体里要带它的接口用，配合函数形式的 body 在重试时重取） */
export function currentRefreshToken(): string {
  return session?.getTokens()?.refreshToken ?? "";
}

/**
 * `body` 可以是函数：每次真正发请求时现算。请求体里带着 token 的接口必须这样传——
 * 401 静默刷新后的重试若原样重发提交时定死的 body，带出去的是已被轮换掉的旧 refresh token。
 * `timeoutMs`：这一个请求的单次超时，不传是全局的 15 s。只管这个接口自己的那次（401 后重试的那次也按它），
 * 中间的 refresh 照旧 15 s——刷新是全账号共用的一次，不能被某个急着要结果的接口提前掐掉
 */
export async function api<T>(
  path: string,
  options: {
    method?: string;
    body?: unknown | (() => unknown);
    auth?: boolean;
    timeoutMs?: number;
  } = {},
): Promise<T> {
  const { method = "GET", body: bodyOrFn, auth = true, timeoutMs } = options;

  const doFetch = async (): Promise<Response> => {
    const body =
      typeof bodyOrFn === "function" ? (bodyOrFn as () => unknown)() : bodyOrFn;
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (auth) {
      const tokens = session?.getTokens();
      if (tokens) headers.Authorization = `Bearer ${tokens.accessToken}`;
    }
    return fetchWithTimeout(
      `${BASE_URL}${path}`,
      {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      },
      timeoutMs,
    );
  };

  let res = await doFetch();

  // access 过期（15min）→ 静默刷新一次并重试；只有服务端明确否定 refresh token 才算会话终结
  if (res.status === 401 && auth) {
    const outcome = await refreshTokens();
    if (outcome === "ok") {
      res = await doFetch();
    } else if (outcome === "invalid") {
      await session?.clearSession();
      throw new SessionEndedError();
    } else {
      // stale：保留会话（下一次请求会再刷新），告诉调用方「暂时核对不了」而不是原 401
      throw new SessionCheckUnavailableError();
    }
  }

  if (!res.ok) throw await parseError(res, auth);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
