// 2026-10-16 边界测试：设备绑定 / 改名 / 解绑 / 状态 / 电量历史（API.md §4）。
// 只补 devices / hardening-devices / audit-auth-binding 没覆盖到的组合；文档没写的按现状断言并注明。
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createHash } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  auth,
  bindDevice,
  buildApp,
  cleanupDevices,
  cleanupUsers,
  createUser,
  provisionDevice,
  type Http,
  type TestUser,
} from './helpers/hardening';

jest.setTimeout(120_000);

describe('边界：设备 (e2e)', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  const users: TestUser[] = [];
  const devices: string[] = [];
  const run = Date.now();
  let seq = 0;

  const newUser = async (): Promise<TestUser> => {
    const u = await createUser(app, http);
    users.push(u);
    return u;
  };
  const newDevice = async (): Promise<string> => {
    seq += 1;
    const id = `edge_dev_${run}_${seq}`;
    devices.push(id);
    await provisionDevice(prisma, id);
    return id;
  };
  const bind = (u: TestUser, body: unknown) =>
    request(http)
      .post('/api/v1/devices/bind')
      .set(auth(u.token))
      .send(body as object);
  const rename = (u: TestUser, deviceId: string, body: unknown) =>
    request(http)
      .patch(`/api/v1/devices/${deviceId}`)
      .set(auth(u.token))
      .send(body as object);

  beforeAll(async () => {
    ({ app, http, prisma } = await buildApp());
  });

  afterAll(async () => {
    await cleanupDevices(prisma, devices);
    await cleanupUsers(prisma, users);
    await app.close();
  });

  describe('绑定入参', () => {
    it('deviceId：64 字符合法（不存在 → 404 DEVICE_NOT_FOUND）；65 字符 / 空串 / 含空格 / 中文 / 点号 / 数字类型 → 400', async () => {
      const u = await newUser();
      const ok64 = await bind(u, {
        deviceId: 'a'.repeat(64),
        bindCode: '12345678',
      });
      expect(ok64.status).toBe(404);
      expect(ok64.body.code).toBe('DEVICE_NOT_FOUND');
      for (const deviceId of [
        'a'.repeat(65),
        '',
        'helmet 001',
        ' helmet_001',
        '头盔001',
        'helmet.001',
        12345678,
        null,
      ]) {
        const r = await bind(u, { deviceId, bindCode: '12345678' });
        expect(r.status).toBe(400);
        expect(r.body.code).toBe('VALIDATION_FAILED');
      }
    });

    it('bindCode：3 字符 / 65 字符 / 数字类型 / 缺失 → 400（形状先于设备存在性检查）', async () => {
      const u = await newUser();
      const d = await newDevice();
      for (const bindCode of ['123', 'x'.repeat(65), 12345678, undefined]) {
        const r = await bind(u, { deviceId: d, bindCode });
        expect(r.status).toBe(400);
      }
    });

    it('deviceId 敲成大写：查不到时按小写再查，绑上的是小写那台（出厂编号一律小写，10-16 夜测 N12）；大小写都对不上仍 404', async () => {
      const u = await newUser();
      const d = await newDevice();
      const r = await bind(u, {
        deviceId: d.toUpperCase(),
        bindCode: `bc_${d}`,
      });
      expect(r.status).toBe(200);
      expect(r.body.deviceId).toBe(d);
      const missing = await bind(u, {
        deviceId: `${d.toUpperCase()}_NOPE`,
        bindCode: `bc_${d}`,
      });
      expect(missing.status).toBe(404);
      expect(missing.body.code).toBe('DEVICE_NOT_FOUND');
    });

    it('设备库里 bindCode 为空（未签发）：任何码都 403 BIND_CODE_INVALID，不会被空码 / 「null」绑走', async () => {
      const u = await newUser();
      seq += 1;
      const d = `edge_dev_${run}_nocode_${seq}`;
      devices.push(d);
      await prisma.device.create({
        data: {
          deviceId: d,
          deviceSecretHash: createHash('sha256').update('edge').digest('hex'),
          bindCode: null,
        },
      });
      for (const bindCode of ['null', 'undefined', '0000', '        ']) {
        const r = await bind(u, { deviceId: d, bindCode });
        expect(r.status).toBe(403);
        expect(r.body.code).toBe('BIND_CODE_INVALID');
      }
    });

    it('已绑在自己名下、但这次码填错 → 403（码先于幂等判断），绑定不受影响', async () => {
      const u = await newUser();
      const d = await newDevice();
      await bindDevice(http, u.token, d);
      const r = await bind(u, { deviceId: d, bindCode: 'wrong_code' });
      expect(r.status).toBe(403);
      expect(r.body.code).toBe('BIND_CODE_INVALID');
      await request(http)
        .get(`/api/v1/devices/${d}`)
        .set(auth(u.token))
        .expect(200);
    });

    it('别人已绑、我拿错码 → 403（不是 409）：错码不泄露「已被绑定」', async () => {
      const u = await newUser();
      const v = await newUser();
      const d = await newDevice();
      await bindDevice(http, u.token, d);
      const r = await bind(v, { deviceId: d, bindCode: 'wrong_code' });
      expect(r.status).toBe(403);
      const right = await bind(v, { deviceId: d, bindCode: `bc_${d}` });
      expect(right.status).toBe(409);
      expect(right.body.code).toBe('DEVICE_ALREADY_BOUND');
    });

    it('同一用户并发绑同一台 6 次：至少一个 200、设备归本人、绑定区间只开 1 段（输家偶发 409，见 edge-findings B10，修复在 fix 分支）', async () => {
      const u = await newUser();
      const d = await newDevice();
      const rs = await Promise.all(
        Array.from({ length: 6 }, () =>
          bind(u, { deviceId: d, bindCode: `bc_${d}` }),
        ),
      );
      expect(rs.every((r) => r.status === 200 || r.status === 409)).toBe(true);
      expect(rs.some((r) => r.status === 200)).toBe(true);
      expect(
        (await prisma.device.findUniqueOrThrow({ where: { deviceId: d } }))
          .bindUserId,
      ).toBe(u.id);
      expect(await prisma.deviceBinding.count({ where: { deviceId: d } })).toBe(
        1,
      );
    });

    it('绑定响应带 bindCode / boundAt；初次绑定离线（无心跳）、电量等快照为 null', async () => {
      const u = await newUser();
      const d = await newDevice();
      const r = await bind(u, { deviceId: d, bindCode: `bc_${d}` }).expect(200);
      expect(r.body).toMatchObject({
        deviceId: d,
        bindCode: `bc_${d}`,
        online: false,
        lastSeenAt: null,
        battery: null,
        name: null,
      });
      expect(typeof r.body.boundAt).toBe('string');
    });
  });

  describe('解绑与再绑', () => {
    it('解绑后顺序再解绑 → 404 DEVICE_NOT_FOUND；详情 / 状态 / 电量历史都 404', async () => {
      const u = await newUser();
      const d = await newDevice();
      await bindDevice(http, u.token, d);
      await request(http)
        .delete(`/api/v1/devices/${d}/binding`)
        .set(auth(u.token))
        .expect(204);
      for (const path of [
        `/api/v1/devices/${d}`,
        `/api/v1/devices/${d}/status`,
        `/api/v1/devices/${d}/battery-history`,
      ]) {
        const r = await request(http).get(path).set(auth(u.token));
        expect(r.status).toBe(404);
        expect(r.body.code).toBe('DEVICE_NOT_FOUND');
      }
      const again = await request(http)
        .delete(`/api/v1/devices/${d}/binding`)
        .set(auth(u.token));
      expect(again.status).toBe(404);
    });

    it('并发解绑 5 次：全部 204（已不是自己的按幂等成功，文档未写，按现状）；绑定区间只关一次', async () => {
      const u = await newUser();
      const d = await newDevice();
      await bindDevice(http, u.token, d);
      const rs = await Promise.all(
        Array.from({ length: 5 }, () =>
          request(http)
            .delete(`/api/v1/devices/${d}/binding`)
            .set(auth(u.token)),
        ),
      );
      expect(rs.every((r) => r.status === 204 || r.status === 404)).toBe(true);
      expect(rs.some((r) => r.status === 204)).toBe(true);
      const bindings = await prisma.deviceBinding.findMany({
        where: { deviceId: d },
      });
      expect(bindings).toHaveLength(1);
      expect(bindings[0].unboundAt).not.toBeNull();
    });

    it('别人解绑不了我的设备（404），我的绑定原样', async () => {
      const u = await newUser();
      const v = await newUser();
      const d = await newDevice();
      await bindDevice(http, u.token, d);
      const r = await request(http)
        .delete(`/api/v1/devices/${d}/binding`)
        .set(auth(v.token));
      expect(r.status).toBe(404);
      expect(
        (await prisma.device.findUniqueOrThrow({ where: { deviceId: d } }))
          .bindUserId,
      ).toBe(u.id);
    });

    it('解绑清掉自定义名；同一人再绑回来是新的一段区间、名字仍为空、boundAt 更新；绑定码不变', async () => {
      const u = await newUser();
      const d = await newDevice();
      const first = await bind(u, { deviceId: d, bindCode: `bc_${d}` }).expect(
        200,
      );
      await rename(u, d, { name: '张三的头盔' }).expect(200);
      await request(http)
        .delete(`/api/v1/devices/${d}/binding`)
        .set(auth(u.token))
        .expect(204);
      await new Promise((r) => setTimeout(r, 20));
      const second = await bind(u, { deviceId: d, bindCode: `bc_${d}` }).expect(
        200,
      );
      expect(second.body.name).toBeNull();
      expect(new Date(second.body.boundAt).getTime()).toBeGreaterThan(
        new Date(first.body.boundAt).getTime(),
      );
      expect(second.body.bindCode).toBe(`bc_${d}`);
      const bindings = await prisma.deviceBinding.findMany({
        where: { deviceId: d },
        orderBy: { boundAt: 'asc' },
      });
      expect(bindings).toHaveLength(2);
      expect(bindings[0].unboundAt).not.toBeNull();
      expect(bindings[1].unboundAt).toBeNull();
    });

    it('A 解绑后 B 用同一个出厂码绑定成功；之后 A 再绑 → 409（码不随换绑轮换，文档未写，按现状）', async () => {
      const a = await newUser();
      const b = await newUser();
      const d = await newDevice();
      await bindDevice(http, a.token, d);
      await request(http)
        .delete(`/api/v1/devices/${d}/binding`)
        .set(auth(a.token))
        .expect(204);
      await bindDevice(http, b.token, d);
      const back = await bind(a, { deviceId: d, bindCode: `bc_${d}` });
      expect(back.status).toBe(409);
      expect(back.body.code).toBe('DEVICE_ALREADY_BOUND');
    });

    it('设备列表按绑定时间倒序：后绑的在前；解绑再绑的那台回到最前', async () => {
      const u = await newUser();
      const d1 = await newDevice();
      const d2 = await newDevice();
      await bindDevice(http, u.token, d1);
      await new Promise((r) => setTimeout(r, 15));
      await bindDevice(http, u.token, d2);
      const ids = async () =>
        (
          await request(http)
            .get('/api/v1/devices')
            .set(auth(u.token))
            .expect(200)
        ).body.map((x: { deviceId: string }) => x.deviceId) as string[];
      expect(await ids()).toEqual([d2, d1]);
      await request(http)
        .delete(`/api/v1/devices/${d1}/binding`)
        .set(auth(u.token))
        .expect(204);
      await new Promise((r) => setTimeout(r, 15));
      await bindDevice(http, u.token, d1);
      expect(await ids()).toEqual([d1, d2]);
    });
  });

  describe('改名', () => {
    it('20 字通过、21 字 400；20 个 emoji 通过；trim 后空串 → null', async () => {
      const u = await newUser();
      const d = await newDevice();
      await bindDevice(http, u.token, d);
      expect((await rename(u, d, { name: '盔'.repeat(20) })).status).toBe(200);
      expect((await rename(u, d, { name: '盔'.repeat(21) })).status).toBe(400);
      const emoji = await rename(u, d, { name: '🪖'.repeat(20) });
      expect(emoji.status).toBe(200);
      expect(emoji.body.name).toBe('🪖'.repeat(20));
      for (const name of ['', '   ', '\t\n', '\u3000']) {
        const r = await rename(u, d, { name });
        expect(r.status).toBe(200);
        expect(r.body.name).toBeNull();
      }
    });

    it('首尾空白存之前去掉；长度按整理后的名字算——20 字加首尾空格 200，21 字 400', async () => {
      const u = await newUser();
      const d = await newDevice();
      await bindDevice(http, u.token, d);
      const trimmed = await rename(u, d, { name: '  我的头盔  ' });
      expect(trimmed.body.name).toBe('我的头盔');
      const padded = await rename(u, d, { name: ` ${'盔'.repeat(20)} ` });
      expect(padded.status).toBe(200);
      expect(padded.body.name).toBe('盔'.repeat(20));
      expect((await rename(u, d, { name: '盔'.repeat(21) })).status).toBe(400);
    });

    it('不传 name（空对象）→ 不改名，原来会把自定义名清掉（10-16 边界测试 B7）', async () => {
      const u = await newUser();
      const d = await newDevice();
      await bindDevice(http, u.token, d);
      await rename(u, d, { name: '保留' }).expect(200);
      const r = await rename(u, d, {});
      expect(r.status).toBe(200);
      expect(r.body.name).toBe('保留');
    });

    it('name: null → 清空；非字符串（数字 / 数组）→ 400；只含零宽字符 / 换行 → 整理后为空，等于清除（10-16 夜测 N1）', async () => {
      const u = await newUser();
      const d = await newDevice();
      await bindDevice(http, u.token, d);
      await rename(u, d, { name: '有名' }).expect(200);
      const cleared = await rename(u, d, { name: null });
      expect(cleared.status).toBe(200);
      expect(cleared.body.name).toBeNull();
      for (const name of [123, ['a'], { a: 1 }]) {
        expect((await rename(u, d, { name })).status).toBe(400);
      }
      await rename(u, d, { name: '有名' }).expect(200);
      const zw = await rename(u, d, { name: '\u200b\n\u2060' });
      expect(zw.status).toBe(200);
      expect(zw.body.name).toBeNull();
      const multi = await rename(u, d, { name: '第一行\n第二行' });
      expect(multi.body.name).toBe('第一行 第二行');
    });

    it('改名只改 name：deviceId / bindCode / bindUserId 一并传入被丢弃', async () => {
      const u = await newUser();
      const v = await newUser();
      const d = await newDevice();
      await bindDevice(http, u.token, d);
      const r = await rename(u, d, {
        name: '只改名',
        deviceId: 'evil',
        bindCode: 'evil_code',
        bindUserId: v.id,
      });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({
        deviceId: d,
        bindCode: `bc_${d}`,
        name: '只改名',
      });
      const row = await prisma.device.findUniqueOrThrow({
        where: { deviceId: d },
      });
      expect(row.bindUserId).toBe(u.id);
    });

    it('别人的 / 未绑定的 / 不存在的设备改名 → 404 DEVICE_NOT_FOUND', async () => {
      const u = await newUser();
      const v = await newUser();
      const mine = await newDevice();
      const free = await newDevice();
      await bindDevice(http, u.token, mine);
      for (const [who, id] of [
        [v, mine],
        [u, free],
        [u, 'no_such_device'],
      ] as const) {
        const r = await rename(who, id, { name: 'x' });
        expect(r.status).toBe(404);
        expect(r.body.code).toBe('DEVICE_NOT_FOUND');
      }
    });
  });

  describe('电量历史参数', () => {
    it('hours：1 与 168 通过；0 / 169 / -1 / 1.5 / abc / 空串 → 400；1e2 被当作 100（Number 转换，按现状）', async () => {
      const u = await newUser();
      const d = await newDevice();
      await bindDevice(http, u.token, d);
      const get = (hours: string) =>
        request(http)
          .get(`/api/v1/devices/${d}/battery-history`)
          .query({ hours })
          .set(auth(u.token));
      for (const hours of ['1', '168', '1e2']) {
        const r = await get(hours);
        expect(r.status).toBe(200);
        expect(r.body.points).toEqual([]);
      }
      const r100 = await get('1e2');
      expect(
        new Date(r100.body.to).getTime() - new Date(r100.body.from).getTime(),
      ).toBe(100 * 3_600_000);
      for (const hours of ['0', '169', '-1', '1.5', 'abc', '']) {
        const r = await get(hours);
        expect(r.status).toBe(400);
        expect(r.body.code).toBe('VALIDATION_FAILED');
      }
    });

    it('重复的 hours 参数（hours=1&hours=2）→ 400，不 500', async () => {
      const u = await newUser();
      const d = await newDevice();
      await bindDevice(http, u.token, d);
      const r = await request(http)
        .get(`/api/v1/devices/${d}/battery-history?hours=1&hours=2`)
        .set(auth(u.token));
      expect(r.status).toBe(400);
    });
  });

  describe('路径参数', () => {
    it('deviceId 路径：编码斜杠 / 超长 / SQL 片段 / 不存在 → 404，不 500', async () => {
      const u = await newUser();
      for (const id of [
        encodeURIComponent('a/b'),
        'x'.repeat(3000),
        encodeURIComponent("1' OR '1'='1"),
        encodeURIComponent('😀'),
      ]) {
        const r = await request(http)
          .get(`/api/v1/devices/${id}`)
          .set(auth(u.token));
        expect(r.status).toBe(404);
      }
    });
  });
});
