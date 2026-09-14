// 审计（2026-09-13）Admin 专用辅助：建/删管理员、登录取 token、按需签发过期/畸形 admin token、
// UTC+8 自然日起点（与 AdminService.statsOverview 同算法，用于 SQL 交叉核对）。
import type { INestApplication } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import * as jwt from 'jsonwebtoken';
import request from 'supertest';
import type { PrismaService } from '../../src/prisma/prisma.service';
import type { Http } from './hardening';

export interface TestAdmin {
  id: string;
  username: string;
  password: string;
  token: string;
}

export async function createAdmin(
  prisma: PrismaService,
  http: Http,
  username = `audit_admin_${Date.now()}`,
  password = 'audit_admin_pw_1',
): Promise<TestAdmin> {
  const created = await prisma.adminUser.create({
    data: { username, passwordHash: await bcrypt.hash(password, 10) },
  });
  const login = await request(http)
    .post('/api/v1/admin/auth/login')
    .send({ username, password })
    .expect(200);
  return {
    id: created.id,
    username,
    password,
    token: login.body.accessToken as string,
  };
}

export async function cleanupAdmins(
  prisma: PrismaService,
  usernames: string[],
): Promise<void> {
  if (usernames.length === 0) return;
  await prisma.adminUser
    .deleteMany({ where: { username: { in: usernames } } })
    .catch(() => undefined);
}

/** 用真实 ADMIN_JWT_SECRET 签 token，可指定过期秒数（负数=已过期）或去掉 typ */
export function signAdminToken(
  sub: string,
  opts: { expiresInSec?: number; typ?: string | null; secret?: string } = {},
): string {
  const secret = opts.secret ?? process.env.ADMIN_JWT_SECRET;
  if (!secret) throw new Error('ADMIN_JWT_SECRET 未设置');
  const now = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = { sub, iat: now };
  if (opts.typ !== null) payload.typ = opts.typ ?? 'admin';
  payload.exp = now + (opts.expiresInSec ?? 3600);
  return jwt.sign(payload, secret, { algorithm: 'HS256' });
}

/** 「今日」起点：固定 UTC+8 自然日（AdminService.statsOverview 同算法） */
export function utc8TodayStart(now = Date.now()): Date {
  const utc8 = new Date(now + 8 * 3600_000);
  utc8.setUTCHours(0, 0, 0, 0);
  return new Date(utc8.getTime() - 8 * 3600_000);
}

export const adminGet = (
  http: Http,
  token: string,
  path: string,
  query: Record<string, string | number> = {},
): request.Test =>
  request(http)
    .get(`/api/v1/admin${path}`)
    .query(query)
    .set('Authorization', `Bearer ${token}`);

/** supertest 无法在 .query 里表达重复键，这里手拼 query string */
export const adminGetRaw = (
  http: Http,
  token: string,
  pathWithQuery: string,
): request.Test =>
  request(http)
    .get(`/api/v1/admin${pathWithQuery}`)
    .set('Authorization', `Bearer ${token}`);

export const countOf = (rows: Array<{ n: bigint | number }>): number =>
  Number(rows[0]?.n ?? 0);

export type { INestApplication };
