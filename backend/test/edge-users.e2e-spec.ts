// 2026-10-16 边界测试：用户资料（PATCH /users/me）与注销（DELETE /users/me）。
// 断言 API.md §2 写明的行为；文档没写的按代码现状断言并注明「文档未写，按现状」。
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { registerUser } from './helpers/register';
import {
  auth,
  bindDevice,
  buildApp,
  cleanupDevices,
  cleanupUsers,
  createUser,
  histogram,
  provisionDevice,
  type Http,
  type TestUser,
} from './helpers/hardening';

jest.setTimeout(120_000);

const DATA_PREFIX = 'data:image/png;base64,';

describe('边界：用户资料与注销 (e2e)', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  const users: TestUser[] = [];
  const devices: string[] = [];
  let me: TestUser;

  const patchMe = (body: unknown, token = me.token) =>
    request(http)
      .patch('/api/v1/users/me')
      .set(auth(token))
      .send(body as object);

  beforeAll(async () => {
    ({ app, http, prisma } = await buildApp());
    me = await createUser(app, http);
    users.push(me);
  });

  afterAll(async () => {
    await cleanupDevices(prisma, devices);
    await cleanupUsers(prisma, users);
    await app.close();
  });

  describe('昵称', () => {
    it('30 字（汉字 / emoji）通过；31 字 400；ZWJ 组合 emoji 按码点计数（5 个「👨‍👩‍👧‍👦」= 35 > 30 → 400）', async () => {
      expect((await patchMe({ nickname: '骑'.repeat(30) })).status).toBe(200);
      expect((await patchMe({ nickname: '😀'.repeat(30) })).status).toBe(200);
      expect((await patchMe({ nickname: '骑'.repeat(31) })).status).toBe(400);
      expect((await patchMe({ nickname: '😀'.repeat(31) })).status).toBe(400);
      // 文档未写长度的计法，按现状（class-validator 按码点、ZWJ 也算一个）
      expect((await patchMe({ nickname: '👨‍👩‍👧‍👦'.repeat(4) })).status).toBe(200);
      expect((await patchMe({ nickname: '👨‍👩‍👧‍👦'.repeat(5) })).status).toBe(400);
    });

    it('空串 / 全空白原样保存，不 trim（文档未写，按现状）', async () => {
      const empty = await patchMe({ nickname: '' });
      expect(empty.status).toBe(200);
      expect(empty.body.nickname).toBe('');
      const blank = await patchMe({ nickname: '   ' });
      expect(blank.status).toBe(200);
      expect(blank.body.nickname).toBe('   ');
    });

    it('nickname: null → 清空为 null（文档未写，按现状）；不传 nickname 则不动', async () => {
      await patchMe({ nickname: '老张' }).expect(200);
      const keep = await patchMe({});
      expect(keep.status).toBe(200);
      expect(keep.body.nickname).toBe('老张');
      const cleared = await patchMe({ nickname: null });
      expect(cleared.status).toBe(200);
      expect(cleared.body.nickname).toBeNull();
    });

    it('RTL 覆盖符 / 零宽字符 / 换行 / HTML 原样保存与回传（转义是前端职责）', async () => {
      const weird = '\u202e<b>x</b>\u200b\n&amp;';
      const r = await patchMe({ nickname: weird });
      expect(r.status).toBe(200);
      expect(r.body.nickname).toBe(weird);
      const got = await request(http)
        .get('/api/v1/users/me')
        .set(auth(me.token))
        .expect(200);
      expect(got.body.nickname).toBe(weird);
    });

    it('非字符串（数字 / 布尔 / 数组 / 对象）→ 400，昵称不变', async () => {
      await patchMe({ nickname: '原名' }).expect(200);
      for (const nickname of [42, true, ['a'], { a: 1 }]) {
        const r = await patchMe({ nickname });
        expect(r.status).toBe(400);
        expect(r.body.code).toBe('VALIDATION_FAILED');
      }
      const got = await request(http)
        .get('/api/v1/users/me')
        .set(auth(me.token))
        .expect(200);
      expect(got.body.nickname).toBe('原名');
    });

    it('并发改昵称 10 次：全部 200，最终值是其中之一', async () => {
      const names = Array.from({ length: 10 }, (_, i) => `并发${i}`);
      const rs = await Promise.all(
        names.map((nickname) => patchMe({ nickname })),
      );
      expect(histogram(rs.map((r) => r.status))).toEqual({ '200': 10 });
      const got = await request(http)
        .get('/api/v1/users/me')
        .set(auth(me.token))
        .expect(200);
      expect(names).toContain(got.body.nickname);
    });
  });

  describe('头像 avatarUrl', () => {
    it('data URI 上限 90000 字符：恰好 90000 通过，90001 → 400；整个请求体超过 100KB → 413 PAYLOAD_TOO_LARGE', async () => {
      const exact = DATA_PREFIX + 'A'.repeat(90_000 - DATA_PREFIX.length);
      const r = await patchMe({ avatarUrl: exact });
      expect(r.status).toBe(200);
      expect(r.body.avatarUrl).toHaveLength(90_000);
      const over = await patchMe({ avatarUrl: `${exact}A` });
      expect(over.status).toBe(400);
      const huge = await patchMe({
        avatarUrl: DATA_PREFIX + 'A'.repeat(110_000),
      });
      expect(huge.status).toBe(413);
      expect(huge.body.code).toBe('PAYLOAD_TOO_LARGE');
    });

    it('只收 jpeg / png / webp 的 base64：gif / svg+xml / 大写 DATA: / 缺 base64 体 / 非 base64 字符 → 400', async () => {
      for (const avatarUrl of [
        'data:image/gif;base64,R0lGODlh',
        'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
        'DATA:IMAGE/PNG;BASE64,AAAA',
        DATA_PREFIX,
        `${DATA_PREFIX}AA AA`,
        `${DATA_PREFIX}AA-_`,
        'data:image/png,AAAA',
        'data:text/html;base64,PHNjcmlwdD4=',
      ]) {
        const r = await patchMe({ avatarUrl });
        expect(r.status).toBe(400);
        expect(r.body.code).toBe('VALIDATION_FAILED');
      }
      for (const avatarUrl of [
        'data:image/jpeg;base64,/9j/4AAQ',
        'data:image/webp;base64,UklGRg==',
      ]) {
        expect((await patchMe({ avatarUrl })).status).toBe(200);
      }
    });

    it('http(s) URL：路径 490 字符通过、491 → 400；含空格 / ftp / javascript: / 只有协议头 → 400', async () => {
      expect(
        (await patchMe({ avatarUrl: `https://${'a'.repeat(490)}` })).status,
      ).toBe(200);
      expect(
        (await patchMe({ avatarUrl: `https://${'a'.repeat(491)}` })).status,
      ).toBe(400);
      for (const avatarUrl of [
        'https://cdn.example.com/a b.png',
        'ftp://cdn.example.com/a.png',
        'javascript:alert(1)',
        'https://',
        'http://',
        '//cdn.example.com/a.png',
        'HTTPS://cdn.example.com/a.png',
      ]) {
        const r = await patchMe({ avatarUrl });
        expect(r.status).toBe(400);
      }
    });

    it('avatarUrl: null → 清空头像（文档未写，按现状）', async () => {
      await patchMe({ avatarUrl: 'https://cdn.example.com/a.png' }).expect(200);
      const r = await patchMe({ avatarUrl: null });
      expect(r.status).toBe(200);
      expect(r.body.avatarUrl).toBeNull();
    });
  });

  describe('白名单与请求体形状', () => {
    it('PATCH 只改昵称 / 头像：phone / id / createdAt / deletedAt 一并传入也被丢弃', async () => {
      const before = await request(http)
        .get('/api/v1/users/me')
        .set(auth(me.token))
        .expect(200);
      const r = await patchMe({
        nickname: '白名单',
        phone: '13900000000',
        id: 'evil',
        createdAt: '2000-01-01T00:00:00Z',
        deletedAt: '2000-01-01T00:00:00Z',
      });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({
        id: before.body.id,
        phone: before.body.phone,
        createdAt: before.body.createdAt,
        nickname: '白名单',
      });
      await request(http)
        .get('/api/v1/users/me')
        .set(auth(me.token))
        .expect(200);
    });

    it('请求体是 JSON 数组：200 且什么都不改（DTO 全选填，数组被当成无字段，文档未写，按现状）', async () => {
      await patchMe({ nickname: '数组前' }).expect(200);
      const r = await patchMe([{ nickname: '数组里' }]);
      expect(r.status).toBe(200);
      expect(r.body.nickname).toBe('数组前');
    });

    it('非 JSON Content-Type（text/plain）→ 被当作空体：200 不改资料', async () => {
      await patchMe({ nickname: '纯文本前' }).expect(200);
      const r = await request(http)
        .patch('/api/v1/users/me')
        .set(auth(me.token))
        .set('Content-Type', 'text/plain')
        .send('nickname=纯文本');
      expect(r.status).toBe(200);
      expect(r.body.nickname).toBe('纯文本前');
    });
  });

  describe('注销 DELETE /users/me', () => {
    it('缺密码 / 空密码 / 非字符串 → 400 VALIDATION_FAILED；错密码 400 PASSWORD_INCORRECT；账号原样', async () => {
      const u = await createUser(app, http);
      users.push(u);
      for (const body of [{}, { password: '' }, { password: 12345678 }]) {
        const r = await request(http)
          .delete('/api/v1/users/me')
          .set(auth(u.token))
          .send(body);
        expect(r.status).toBe(400);
        expect(r.body.code).toBe('VALIDATION_FAILED');
      }
      const wrong = await request(http)
        .delete('/api/v1/users/me')
        .set(auth(u.token))
        .send({ password: `${u.password}x` });
      expect(wrong.status).toBe(400);
      expect(wrong.body.code).toBe('PASSWORD_INCORRECT');
      await request(http)
        .get('/api/v1/users/me')
        .set(auth(u.token))
        .expect(200);
    });

    it('并发注销 5 次：无 5xx；最终软删除、手机号改写为 deleted:<id>、名下设备解绑且只关一段绑定区间', async () => {
      const u = await createUser(app, http);
      const deviceId = `edge_users_del_${Date.now()}`;
      devices.push(deviceId);
      await provisionDevice(prisma, deviceId);
      await bindDevice(http, u.token, deviceId);
      const rs = await Promise.all(
        Array.from({ length: 5 }, () =>
          request(http)
            .delete('/api/v1/users/me')
            .set(auth(u.token))
            .send({ password: u.password }),
        ),
      );
      expect(rs.every((r) => r.status < 500)).toBe(true);
      expect(rs.some((r) => r.status === 204)).toBe(true);
      const row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
      expect(row.deletedAt).not.toBeNull();
      expect(row.phone).toBe(`deleted:${u.id}`);
      const device = await prisma.device.findUniqueOrThrow({
        where: { deviceId },
      });
      expect(device.bindUserId).toBeNull();
      const bindings = await prisma.deviceBinding.findMany({
        where: { deviceId },
      });
      expect(bindings).toHaveLength(1);
      expect(bindings[0].unboundAt).not.toBeNull();
      users.push({ ...u, phone: `deleted:${u.id}` });
    });

    it('注销后：资料改不了（401）；昵称保留供后台事故归属（API.md §2）；原号可立即注册新账号', async () => {
      const u = await createUser(app, http);
      await patchMe({ nickname: '注销前昵称' }, u.token).expect(200);
      await request(http)
        .delete('/api/v1/users/me')
        .set(auth(u.token))
        .send({ password: u.password })
        .expect(204);
      const after = await patchMe({ nickname: '注销后' }, u.token);
      expect(after.status).toBe(401);
      const row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
      expect(row.nickname).toBe('注销前昵称');
      expect(row.avatarUrl).toBeNull();
      users.push({ ...u, phone: `deleted:${u.id}` });
      const fresh = await registerUser(app, http, {
        phone: u.phone,
        password: 'edge_users_pw_2',
      });
      users.push({ ...u, id: fresh.body.user.id as string });
      expect(fresh.body.user.id).not.toBe(u.id);
      expect(fresh.body.user.nickname).toBeNull();
    });
  });
});
