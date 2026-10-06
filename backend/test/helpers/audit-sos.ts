// 2026-09-13 全面审计（§4 SOS 与数据可靠性）专用辅助：在 hardening.ts 之上补
// Provider mock 装配、联系人/事件/SOS 便捷调用、WS 收集器与轮询等待。
// 只读审计：不改任何业务源码；故障注入一律走 Provider 覆盖或对 Prisma 委托方法的一次性 spy。
import 'dotenv/config';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import * as bcrypt from 'bcrypt';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { PrismaService } from '../../src/prisma/prisma.service';
import {
  PUSH_PROVIDER,
  type PushOptions,
} from '../../src/providers/push.provider';
import {
  SMS_PROVIDER,
  type SmsMessage,
} from '../../src/providers/sms.provider';
import { buildApp, envelope, type Http } from './hardening';

export type SmsSend = jest.Mock<Promise<void>, [string, SmsMessage]>;
export type PushSend = jest.Mock<
  Promise<void>,
  [string, string, string, Record<string, string>?, PushOptions?]
>;
export interface ProviderMocks {
  sms: { send: SmsSend };
  push: { send: PushSend };
}

export const makeProviderMocks = (): ProviderMocks => ({
  sms: { send: jest.fn<Promise<void>, [string, SmsMessage]>() },
  push: {
    send: jest.fn<
      Promise<void>,
      [string, string, string, Record<string, string>?]
    >(),
  },
});

/** 两个 mock 恢复为「成功」默认实现（注册取验证码也靠 sms.send 是 jest.fn） */
export const resetMocks = (m: ProviderMocks): void => {
  m.sms.send.mockReset().mockResolvedValue(undefined);
  m.push.send.mockReset().mockResolvedValue(undefined);
};

export interface SosEnv {
  /** null = 删除环境变量，走产品默认 60s */
  countdownSeconds: string | null;
  scanIntervalMs: string;
  maxAttempts?: string;
}

/** 环境变量必须在 app 初始化前就位（scanIntervalMs 在 onModuleInit 读取；countdown 每次建单时读取） */
export const applySosEnv = (env: SosEnv): void => {
  if (env.countdownSeconds === null) delete process.env.SOS_COUNTDOWN_SECONDS;
  else process.env.SOS_COUNTDOWN_SECONDS = env.countdownSeconds;
  process.env.SOS_SCAN_INTERVAL_MS = env.scanIntervalMs;
  if (env.maxAttempts) process.env.SOS_NOTIFY_MAX_ATTEMPTS = env.maxAttempts;
  // 这些套件用手动 tick 逐轮驱动重试，不等真实退避（退避节奏本身在 sos-reliability 套件里测）
  process.env.SOS_NOTIFY_RETRY_DELAYS_SECONDS = '0';
};

export async function buildSosApp(
  env: SosEnv,
  mocks: ProviderMocks,
): Promise<{ app: INestApplication; http: Http; prisma: PrismaService }> {
  applySosEnv(env);
  resetMocks(mocks);
  return buildApp((b) =>
    b
      .overrideProvider(SMS_PROVIDER)
      .useValue(mocks.sms)
      .overrideProvider(PUSH_PROVIDER)
      .useValue(mocks.push),
  );
}

export const auth = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
});

export const addContact = (
  http: Http,
  token: string,
  name: string,
  phone: string,
): request.Test =>
  request(http)
    .post('/api/v1/users/me/emergency-contacts')
    .set(auth(token))
    .send({ name, phone })
    .expect(201);

export const auditLocation = (i = 0): Record<string, unknown> => ({
  // 合成坐标（非真实位置）
  latitude: 30.5 + i * 0.001,
  longitude: 114.3 + i * 0.001,
  coordinateSystem: 'gcj02',
  accuracy: 8,
});

export const fallEnvelope = (
  deviceId: string,
  payload: Record<string, unknown> = {},
  overrides: Record<string, unknown> = {},
): Record<string, unknown> =>
  envelope(
    deviceId,
    'possible_fall',
    { confidence: 0.9, algorithmVersion: 'audit-v1', ...payload },
    overrides,
  );

export const manualEnvelope = (
  deviceId: string,
  payload: Record<string, unknown> = {},
): Record<string, unknown> => envelope(deviceId, 'manual_sos', payload);

export const activeOf = (
  http: Http,
  token: string,
  deviceId: string,
): request.Test =>
  request(http).get(`/api/v1/devices/${deviceId}/sos/active`).set(auth(token));

export const cancelSos = (
  http: Http,
  token: string,
  sosId: string,
): request.Test =>
  request(http).post(`/api/v1/sos/${sosId}/cancel`).set(auth(token));

export const confirmSos = (
  http: Http,
  token: string,
  sosId: string,
): request.Test =>
  request(http).post(`/api/v1/sos/${sosId}/confirm`).set(auth(token));

export const sosByEvent = (prisma: PrismaService, eventId: string) =>
  prisma.sosCase.findUnique({ where: { triggerEventId: eventId } });

/** 与投递顺序同口径（sms 先于 push）；只按 createdAt 排会因同事务同时间戳而顺序不定 */
export const notificationsOf = (prisma: PrismaService, sosId: string) =>
  prisma.sosNotification.findMany({
    where: { sosId },
    orderBy: [{ channel: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
  });

/** 只数 sos_alert 模板（注册取码也走同一 mock） */
export const sosSmsCalls = (m: ProviderMocks): Array<[string, SmsMessage]> =>
  m.sms.send.mock.calls.filter(([, msg]) => msg.template === 'sos_alert');

export const pushCallsTitled = (
  m: ProviderMocks,
  title: string,
): Array<[string, string, string, Record<string, string>?, PushOptions?]> =>
  m.push.send.mock.calls.filter(([, t]) => t === title);

export const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** 轮询直到断言函数返回真值；超时抛错并带上最后一次观察值 */
export async function waitUntil<T>(
  probe: () => Promise<T>,
  ok: (v: T) => boolean,
  timeoutMs: number,
  stepMs = 200,
): Promise<T> {
  const started = Date.now();
  let last: T = await probe();
  while (!ok(last)) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(
        `waitUntil 超时 ${timeoutMs}ms，最后观察：${JSON.stringify(last)}`,
      );
    }
    await sleep(stepMs);
    last = await probe();
  }
  return last;
}

export interface WsMsg {
  type: string;
  data: Record<string, unknown>;
  sentAt: string;
}

/** 用户 WS 收集器：连 /ws?token=，累积所有消息，支持按谓词等待 */
export class WsCollector {
  readonly messages: WsMsg[] = [];
  private constructor(private readonly ws: WebSocket) {}

  static async connect(
    app: INestApplication,
    token: string,
  ): Promise<WsCollector> {
    const { port } = app.getHttpServer().address() as AddressInfo;
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`,
    );
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    const c = new WsCollector(ws);
    ws.on('message', (raw) => {
      c.messages.push(JSON.parse((raw as Buffer).toString('utf-8')) as WsMsg);
    });
    return c;
  }

  sosUpdates(sosId: string): WsMsg[] {
    return this.messages.filter(
      (m) => m.type === 'sos_update' && m.data.sosId === sosId,
    );
  }

  async waitForSos(
    sosId: string,
    status: string,
    timeoutMs = 3000,
  ): Promise<WsMsg> {
    const found = await waitUntil(
      () =>
        Promise.resolve(
          this.sosUpdates(sosId).find((m) => m.data.status === status),
        ),
      (v) => v !== undefined,
      timeoutMs,
      50,
    );
    return found as WsMsg;
  }

  close(): void {
    this.ws.close();
  }
}

/** 造 Admin 账号并登录，返回 admin token 与用户名（清理用） */
export async function createAdmin(
  prisma: PrismaService,
  http: Http,
  tag: string,
): Promise<{ username: string; token: string }> {
  const username = `audit_sos_admin_${tag}`;
  const password = 'audit_admin_pw_1';
  await prisma.adminUser.create({
    data: { username, passwordHash: await bcrypt.hash(password, 10) },
  });
  const res = await request(http)
    .post('/api/v1/admin/auth/login')
    .send({ username, password })
    .expect(200);
  return { username, token: res.body.accessToken as string };
}

/** 一次性故障注入：把 Prisma 委托方法替换为「第一次调用抛错，之后恢复原实现」 */
export function failOnce<T extends object, K extends keyof T>(
  target: T,
  method: K,
  error: Error,
  opts?: { when?: (...args: unknown[]) => boolean },
): { calls: number; restore: () => void } {
  const original = target[method] as unknown as (...a: unknown[]) => unknown;
  const state = { calls: 0, fired: false, restore: () => undefined as void };
  const patched = function (this: unknown, ...args: unknown[]) {
    state.calls += 1;
    if (!state.fired && (!opts?.when || opts.when(...args))) {
      state.fired = true;
      return Promise.reject(error);
    }
    return original.apply(target, args);
  };
  (target as Record<K, unknown>)[method] = patched;
  state.restore = () => {
    (target as Record<K, unknown>)[method] = original;
  };
  return state;
}
