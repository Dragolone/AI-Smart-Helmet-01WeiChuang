// 10-17 第二轮评审 r1：
// ① 名字整理漏掉 BMP 以外的不可见字符（标签字符、补充变体选择符、乐谱格式符），只由它们组成的名字照样入库、显示成一片空白；
// ② 入频道限频按 IP 计，同一热点 / 运营商 NAT 下第 11 个人凭正确的码入群就 429——改按账号（决策 #57）。
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  auth,
  buildApp,
  cleanupUsers,
  createUser,
  randomPhone,
  type Http,
  type TestUser,
} from './helpers/hardening';

jest.setTimeout(120_000);

const repeat = (cp: number, n: number) => String.fromCodePoint(cp).repeat(n);

describe('BMP 以外的不可见字符 / 入频道限频按账号 (e2e)', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  let me: TestUser;
  const users: TestUser[] = [];
  const saved = process.env.RATE_LIMIT_DISABLED;

  beforeAll(async () => {
    ({ app, http, prisma } = await buildApp());
    me = await createUser(app, http);
    users.push(me);
  });
  afterAll(async () => {
    if (saved === undefined) delete process.env.RATE_LIMIT_DISABLED;
    else process.env.RATE_LIMIT_DISABLED = saved;
    await cleanupUsers(prisma, users);
    await app.close();
  });

  it.each([
    ['标签空格 U+E0020', 0xe0020],
    ['标签字母 U+E0041', 0xe0041],
    ['补充变体选择符 U+E0100', 0xe0100],
    ['乐谱格式符 U+1D173', 0x1d173],
  ])('联系人名只有 %s：400（整理后为空）', async (_label, cp) => {
    await request(http)
      .post('/api/v1/users/me/emergency-contacts')
      .set(auth(me.token))
      .send({ name: repeat(cp, 3), phone: randomPhone() })
      .expect(400);
  });

  it('频道名只有标签字符：400', async () => {
    await request(http)
      .post('/api/v1/voice/channels')
      .set(auth(me.token))
      .send({ name: repeat(0xe0020, 5) })
      .expect(400);
  });

  it('昵称只有标签字符：清成 null（同「只含零宽字符的昵称」口径）', async () => {
    const res = await request(http)
      .patch('/api/v1/users/me')
      .set(auth(me.token))
      .send({ nickname: repeat(0xe0020, 5) })
      .expect(200);
    expect(res.body.nickname).toBeNull();
  });

  it('同一 IP 下 12 个不同账号各凭正确邀请码入群一次：全部 200', async () => {
    const owner = await createUser(app, http);
    users.push(owner);
    const riders: TestUser[] = [];
    for (let i = 0; i < 12; i++) {
      const u = await createUser(app, http);
      users.push(u);
      riders.push(u);
    }
    const ch = await request(http)
      .post('/api/v1/voice/channels')
      .set(auth(owner.token))
      .send({ name: '周末骑行群' })
      .expect(201);

    // 造号期间限频关着（注册发码同 IP 5 条/分），只对入群打开
    delete process.env.RATE_LIMIT_DISABLED;
    const statuses: number[] = [];
    try {
      for (const u of riders) {
        const res = await request(http)
          .post('/api/v1/voice/channels/join')
          .set(auth(u.token))
          .send({ inviteCode: ch.body.inviteCode as string });
        statuses.push(res.status);
      }
    } finally {
      process.env.RATE_LIMIT_DISABLED = '1';
    }
    expect(statuses).toEqual(Array(12).fill(200));
  });

  it('同一账号 1 分钟内第 11 次尝试：429（按账号的上限仍在）', async () => {
    const u = await createUser(app, http);
    users.push(u);
    delete process.env.RATE_LIMIT_DISABLED;
    const statuses: number[] = [];
    try {
      for (let i = 0; i < 11; i++) {
        const res = await request(http)
          .post('/api/v1/voice/channels/join')
          .set(auth(u.token))
          .send({ inviteCode: 'ZZZZZ9' });
        statuses.push(res.status);
      }
    } finally {
      process.env.RATE_LIMIT_DISABLED = '1';
    }
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(404));
    expect(statuses[10]).toBe(429);
  });
});
