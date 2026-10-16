// 10-17 后端评审鉴权一路的复现（真库 + 真 HTTP）：
// R1-1 登出 / 改密 / 重置作废的 token 过了补发窗口再出现，只该 401，不能当盗用把别的会话全撤掉；
// R1-2 登出 / 改密保留时带来的是轮换前的旧 token（refresh 应答丢了），要作用到这台设备现役的那张。
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createHash } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  buildApp,
  cleanupUsers,
  createUser,
  type Http,
  type TestUser,
} from './helpers/hardening';

jest.setTimeout(60_000);

const hash = (t: string) => createHash('sha256').update(t).digest('hex');

describe('会话吊销边界（10-17 评审 R1-1 / R1-2）', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  const users: TestUser[] = [];

  const login = async (u: TestUser, password = u.password) =>
    (
      await request(http)
        .post('/api/v1/auth/login')
        .send({ phone: u.phone, password })
        .expect(200)
    ).body as { accessToken: string; refreshToken: string };
  const refresh = (refreshToken: string) =>
    request(http).post('/api/v1/auth/refresh').send({ refreshToken });
  /** 把这张 token 的作废时间拨到 20 分钟前：过了 15 分钟补发窗口 */
  const ageRevocation = (refreshToken: string) =>
    prisma.refreshToken.update({
      where: { tokenHash: hash(refreshToken) },
      data: { revokedAt: new Date(Date.now() - 20 * 60_000) },
    });

  beforeAll(async () => {
    ({ app, http, prisma } = await buildApp());
  });
  afterAll(async () => {
    await cleanupUsers(prisma, users);
    await app.close();
  });

  const newUser = async () => {
    const u = await createUser(app, http);
    users.push(u);
    return u;
  };

  it('A 手机改密（保留本机）→ 被踢下线的 B 手机几小时后回来刷新：B 401，A 照常能刷新（原来 A 也被登出）', async () => {
    const u = await newUser();
    const a = { access: u.token, refresh: u.refreshToken };
    const b = await login(u);
    await request(http)
      .post('/api/v1/auth/change-password')
      .set('Authorization', `Bearer ${a.access}`)
      .send({
        oldPassword: u.password,
        newPassword: 'changed_pw_1017',
        refreshToken: a.refresh,
      })
      .expect(204);
    await ageRevocation(b.refreshToken);
    await refresh(b.refreshToken).expect(401);
    await refresh(a.refresh).expect(200);
  });

  it('B 手机登出后，它那张作废的 token 过后又被拿出来：只 401，A 不受影响', async () => {
    const u = await newUser();
    const b = await login(u);
    await request(http)
      .post('/api/v1/auth/logout')
      .send({ refreshToken: b.refreshToken })
      .expect(204);
    await ageRevocation(b.refreshToken);
    await refresh(b.refreshToken).expect(401);
    await refresh(u.refreshToken).expect(200);
  });

  it('真正的盗用（已轮换掉的旧 token 过了补发窗口再出现）仍撤销全部会话', async () => {
    const u = await newUser();
    const rotated = (await refresh(u.refreshToken).expect(200)).body as {
      refreshToken: string;
    };
    await ageRevocation(u.refreshToken);
    await refresh(u.refreshToken).expect(401);
    await refresh(rotated.refreshToken).expect(401);
  });

  it('refresh 应答丢了、App 拿着轮换前的旧 token 登出：现役的替代者一并作废，旧 token 也不能再补发（R1-2）', async () => {
    const u = await newUser();
    const t2 = (await refresh(u.refreshToken).expect(200)).body as {
      refreshToken: string;
    };
    await request(http)
      .post('/api/v1/auth/logout')
      .send({ refreshToken: u.refreshToken })
      .expect(204);
    await refresh(t2.refreshToken).expect(401);
    await refresh(u.refreshToken).expect(401);
  });

  it('refresh 应答丢了、App 拿着轮换前的旧 token 改密并要求保留本机：保留的是现役的替代者，本机不被登出（R1-2）', async () => {
    const u = await newUser();
    const other = await login(u);
    const t2 = (await refresh(u.refreshToken).expect(200)).body as {
      accessToken: string;
      refreshToken: string;
    };
    await request(http)
      .post('/api/v1/auth/change-password')
      .set('Authorization', `Bearer ${t2.accessToken}`)
      .send({
        oldPassword: u.password,
        newPassword: 'changed_pw_1017',
        refreshToken: u.refreshToken,
      })
      .expect(204);
    await refresh(t2.refreshToken).expect(200);
    await refresh(other.refreshToken).expect(401);
  });
});
