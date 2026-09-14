// 2026-09-13 全面审计（auth 领域）公共辅助：只补 hardening.ts / register.ts 没有的能力，
// 既有 helper 一律 import 复用，不改动。
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import * as jwt from 'jsonwebtoken';
import { mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { WebSocket } from 'ws';
import type { PrismaService } from '../../src/prisma/prisma.service';
import type { Http } from './hardening';
import { lastCodeFor, spyOnSms } from './register';

export const EVIDENCE_DIR = join(
  __dirname,
  '../../../docs/testing/2026-09-13/evidence/auth',
);

/** 追加一行证据到 evidence/auth/<file>（自动建目录）。手机号请先用 maskPhoneForLog 打码。 */
export const evidence = (file: string, line: string): void => {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  appendFileSync(
    join(EVIDENCE_DIR, file),
    `${new Date().toISOString()} ${line}\n`,
  );
};

export const maskPhoneForLog = (phone: string): string =>
  phone.length === 11 ? `${phone.slice(0, 3)}****${phone.slice(7)}` : '***';

/** 用应用自身的 JwtService（用户密钥）签任意 payload；expiresIn 可为 '1s'、'-1s' 等 */
export const signUserJwt = (
  app: INestApplication,
  payload: Record<string, unknown>,
  expiresIn: string | number = '15m',
): Promise<string> =>
  app
    .get(JwtService)
    .signAsync(payload, { expiresIn } as Parameters<
      JwtService['signAsync']
    >[1]);

/** 用任意密钥直接签（模拟 admin 密钥签用户 token、用户密钥伪造 typ=admin 等） */
export const signWithSecret = (
  secret: string,
  payload: Record<string, unknown>,
  expiresIn: string | number = '15m',
): string => jwt.sign(payload, secret, { expiresIn: expiresIn as never });

/** alg=none 伪造 token（签名段为空） */
export const noneAlgToken = (payload: Record<string, unknown>): string => {
  const b64 = (o: unknown): string =>
    Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({
    ...payload,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 900,
  })}.`;
};

export const sendCode = (
  http: Http,
  phone: string,
  purpose: 'register' | 'reset_password' | 'change_phone',
): request.Test =>
  request(http).post('/api/v1/auth/sms-code').send({ phone, purpose });

/** 发码并取回 Mock 通道里的验证码（断言 204） */
export const issueCode = async (
  app: INestApplication,
  http: Http,
  phone: string,
  purpose: 'register' | 'reset_password' | 'change_phone',
): Promise<string> => {
  spyOnSms(app);
  await sendCode(http, phone, purpose).expect(204);
  return lastCodeFor(app, phone);
};

/** 把该号该用途最新一条验证码的 createdAt 往前拨，绕过 60s 重发间隔（只动测试自己造的行） */
export const backdateLatestCode = async (
  prisma: PrismaService,
  phone: string,
  purpose: string,
  seconds: number,
): Promise<void> => {
  const latest = await prisma.smsCode.findFirst({
    where: { phone, purpose },
    orderBy: { createdAt: 'desc' },
    select: { id: true, createdAt: true },
  });
  if (!latest) throw new Error('没有可回拨的验证码记录');
  await prisma.smsCode.update({
    where: { id: latest.id },
    data: { createdAt: new Date(latest.createdAt.getTime() - seconds * 1000) },
  });
};

export interface AdminSession {
  id: string;
  username: string;
  token: string;
}

/** 建一个管理员（与 create-admin 脚本同机制）并登录拿 admin token */
export const createAdmin = async (
  prisma: PrismaService,
  http: Http,
  tag: string,
): Promise<AdminSession> => {
  const username = `audit_admin_${tag}`;
  const password = 'audit_admin_pw_1';
  const admin = await prisma.adminUser.create({
    data: { username, passwordHash: await bcrypt.hash(password, 4) },
  });
  const res = await request(http)
    .post('/api/v1/admin/auth/login')
    .send({ username, password })
    .expect(200);
  return { id: admin.id, username, token: res.body.accessToken as string };
};

export const waitOpen = (ws: WebSocket): Promise<void> =>
  new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

/** 等待关闭码；超时返回 null（用于“连接是否被踢”的观察型断言） */
export const waitCloseOrNull = (
  ws: WebSocket,
  timeoutMs: number,
): Promise<number | null> =>
  new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), timeoutMs);
    ws.once('close', (code) => {
      clearTimeout(t);
      resolve(code);
    });
  });

export const waitClose = async (
  ws: WebSocket,
  timeoutMs = 3000,
): Promise<number> => {
  const code = await waitCloseOrNull(ws, timeoutMs);
  if (code === null) throw new Error('等待 WS 关闭超时');
  return code;
};

/** 状态码直方图文本，写证据用 */
export const hist = (statuses: number[]): string =>
  JSON.stringify(
    statuses.reduce<Record<string, number>>((acc, s) => {
      acc[s] = (acc[s] ?? 0) + 1;
      return acc;
    }, {}),
  );
