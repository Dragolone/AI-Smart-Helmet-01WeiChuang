// 2026-09-13 交付审计（ingest 领域）专用辅助：WS 等待、webhook 调用、原始 socket 发包、_invalid 留档查询。
// 只在 audit-*.e2e-spec.ts 中使用；不改动既有 helpers。
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { connect as netConnect } from 'node:net';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import type { PrismaService } from '../../src/prisma/prisma.service';
import type { Http } from './hardening';

export const WEBHOOK_KEY = (): string => {
  // CI 环境不配置该 key（webhook 未启用）；guard 每次请求读 env，测试自备一个即可
  process.env.INGEST_WEBHOOK_API_KEY ??= 'audit_ci_webhook_key';
  const k = process.env.INGEST_WEBHOOK_API_KEY;
  return k;
};

export const webhook = (http: Http, body: unknown): request.Test =>
  request(http)
    .post('/api/v1/ingest/webhook')
    .set('X-Api-Key', WEBHOOK_KEY())
    .send(body as object);

/** 原始文本请求体（可含非法 JSON、原始 NUL 字节） */
export const webhookRaw = (
  http: Http,
  rawBody: string | Buffer,
  contentType = 'application/json',
): request.Test =>
  request(http)
    .post('/api/v1/ingest/webhook')
    .set('X-Api-Key', WEBHOOK_KEY())
    .set('Content-Type', contentType)
    .send(rawBody);

export const relayRaw = (
  http: Http,
  token: string,
  rawBody: string | Buffer,
  contentType = 'application/json',
): request.Test =>
  request(http)
    .post('/api/v1/ingest/app-relay')
    .set('Authorization', `Bearer ${token}`)
    .set('Content-Type', contentType)
    .send(rawBody);

export interface InvalidRecord {
  reason: string;
  raw: string;
  source: string | null;
}

/** 按 raw 中的标记（一般是 eventId）找 `_invalid` 留档记录 */
export async function findInvalidByMarker(
  prisma: PrismaService,
  deviceId: string,
  marker: string,
): Promise<InvalidRecord | null> {
  const rows = await prisma.rawEvent.findMany({
    where: {
      deviceId,
      eventType: '_invalid',
      payload: { path: ['raw'], string_contains: marker },
    },
    select: { payload: true, source: true },
  });
  if (rows.length === 0) return null;
  const p = rows[0].payload as { reason: string; raw: string };
  return { reason: p.reason, raw: p.raw, source: rows[0].source };
}

export const waitOpen = (ws: WebSocket): Promise<void> =>
  new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

export const waitClose = (ws: WebSocket, timeoutMs = 5000): Promise<number> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error('等待 WS 关闭超时')),
      timeoutMs,
    );
    ws.once('close', (code) => {
      clearTimeout(t);
      resolve(code);
    });
  });

/** 收集 WS 消息（按 type 过滤），返回停止函数与消息数组 */
export function collectWs<T = unknown>(
  ws: WebSocket,
  type?: string,
): { messages: Array<{ type: string; data: T; sentAt: string }> } {
  const messages: Array<{ type: string; data: T; sentAt: string }> = [];
  ws.on('message', (buf) => {
    try {
      const text = Buffer.isBuffer(buf)
        ? buf.toString('utf-8')
        : Array.isArray(buf)
          ? Buffer.concat(buf).toString('utf-8')
          : Buffer.from(buf).toString('utf-8');
      const m = JSON.parse(text) as {
        type: string;
        data: T;
        sentAt: string;
      };
      if (!type || m.type === type) messages.push(m);
    } catch {
      /* 非 JSON 忽略 */
    }
  });
  return { messages };
}

export const waitFor = async (
  cond: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  stepMs = 50,
): Promise<void> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error(`waitFor 超时 ${timeoutMs}ms`);
};

export const wsUrlOf = (app: INestApplication, token: string): string => {
  const { port } = app.getHttpServer().address() as AddressInfo;
  return `ws://127.0.0.1:${port}/ws?token=${token}`;
};

/**
 * 用原始 TCP socket 发 HTTP POST，写完 `bodyBytesToSend` 字节后 `delayMs` 毫秒销毁连接，
 * 模拟 App 在服务端处理途中断网（supertest 无法做到）。不等响应。
 */
export function abortedPost(
  app: INestApplication,
  path: string,
  headers: Record<string, string>,
  body: string,
  bodyBytesToSend: number,
  delayMs: number,
): Promise<void> {
  const { port } = app.getHttpServer().address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const sock = netConnect({ host: '127.0.0.1', port }, () => {
      const full = Buffer.from(body, 'utf-8');
      const head =
        `POST ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
        `Content-Type: application/json\r\nContent-Length: ${full.length}\r\n` +
        Object.entries(headers)
          .map(([k, v]) => `${k}: ${v}\r\n`)
          .join('') +
        '\r\n';
      sock.write(head);
      sock.write(full.subarray(0, Math.min(bodyBytesToSend, full.length)));
      setTimeout(() => {
        sock.destroy();
        resolve();
      }, delayMs);
    });
    sock.on('error', (e: NodeJS.ErrnoException) => {
      // 对端已关闭属预期（服务端可能先回包）
      if (e.code === 'ECONNRESET' || e.code === 'EPIPE') return;
      reject(e);
    });
  });
}
