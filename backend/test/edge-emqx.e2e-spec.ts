// 2026-10-16 边界测试：EMQX 内部回调（DEVICE_PROTOCOL §3 / §4）。
// 内部令牌 header 与 query 的优先级、认证字段的类型混淆与书写变体、授权 Topic 的书写变体。
// 核心不变式：任何畸形输入都不能得到 allow。
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createHash } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { deviceAcl } from '../src/emqx/emqx-hook.service';
import { buildApp, cleanupDevices, type Http } from './helpers/hardening';

jest.setTimeout(60_000);

const SECRET = 'edge_emqx_secret_1';
const TOKEN = process.env.EMQX_INTERNAL_TOKEN ?? 'edge_internal_token_for_test';

describe('边界：EMQX 内部回调 (e2e)', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  const dev = `edge_emqx_${Date.now()}`;

  const authn = (body: unknown, token: string | null = TOKEN) => {
    const r = request(http).post('/api/v1/internal/emqx/authenticate');
    return (token === null ? r : r.set('X-Internal-Token', token)).send(
      body as object,
    );
  };
  const authz = (body: Record<string, unknown>) =>
    request(http)
      .post('/api/v1/internal/emqx/authorize')
      .set('X-Internal-Token', TOKEN)
      .send(body);

  beforeAll(async () => {
    if (!process.env.EMQX_INTERNAL_TOKEN)
      process.env.EMQX_INTERNAL_TOKEN = TOKEN;
    ({ app, http, prisma } = await buildApp());
    await prisma.device.create({
      data: {
        deviceId: dev,
        deviceSecretHash: createHash('sha256').update(SECRET).digest('hex'),
        bindCode: `bc_${dev}`,
      },
    });
  });

  afterAll(async () => {
    await cleanupDevices(prisma, [dev]);
    await app.close();
  });

  describe('内部令牌', () => {
    it('query 携带（?token=）可用；header 存在时以 header 为准——header 错、query 对 → 401；header 空串也算「有」→ 401', async () => {
      const ok = await request(http)
        .post(
          `/api/v1/internal/emqx/authenticate?token=${encodeURIComponent(TOKEN)}`,
        )
        .send({ username: dev, password: SECRET });
      expect(ok.status).toBe(200);
      expect(ok.body).toEqual({ result: 'allow', acl: deviceAcl(dev) });
      const headerWins = await request(http)
        .post(
          `/api/v1/internal/emqx/authenticate?token=${encodeURIComponent(TOKEN)}`,
        )
        .set('X-Internal-Token', 'wrong')
        .send({ username: dev, password: SECRET });
      expect(headerWins.status).toBe(401);
      const emptyHeader = await request(http)
        .post(
          `/api/v1/internal/emqx/authenticate?token=${encodeURIComponent(TOKEN)}`,
        )
        .set('X-Internal-Token', '')
        .send({ username: dev, password: SECRET });
      expect(emptyHeader.status).toBe(401);
    });

    it('query 里重复的 token 参数 / 大小写不同 / 首尾空格 → 401', async () => {
      const qs = [
        `token=${encodeURIComponent(TOKEN)}&token=${encodeURIComponent(TOKEN)}`,
        `token=${encodeURIComponent(` ${TOKEN}`)}`,
      ];
      if (TOKEN.toUpperCase() !== TOKEN) {
        qs.push(`token=${encodeURIComponent(TOKEN.toUpperCase())}`);
      }
      for (const q of qs) {
        const r = await request(http)
          .post(`/api/v1/internal/emqx/authenticate?${q}`)
          .send({ username: dev, password: SECRET });
        expect(r.status).toBe(401);
      }
    });
  });

  describe('认证 authenticate', () => {
    it('基线：正确 deviceId + 密钥 → allow', async () => {
      const r = await authn({
        username: dev,
        password: SECRET,
        clientid: dev,
      }).expect(200);
      expect(r.body).toEqual({ result: 'allow', acl: deviceAcl(dev) });
    });

    it('书写变体一律 deny：deviceId 大小写 / 首尾空格；密钥带换行 / 首尾空格 / 大小写；空串', async () => {
      for (const body of [
        { username: dev.toUpperCase(), password: SECRET },
        { username: ` ${dev}`, password: SECRET },
        { username: `${dev} `, password: SECRET },
        { username: dev, password: `${SECRET}\n` },
        { username: dev, password: ` ${SECRET}` },
        { username: dev, password: SECRET.toUpperCase() },
        { username: '', password: SECRET },
        { username: dev, password: '' },
      ]) {
        const r = await authn(body).expect(200);
        expect(r.body).toEqual({ result: 'deny' });
      }
    });

    it('类型混淆（数字 / 数组 / 对象 / 布尔）：永远拿不到 allow（可能 deny 或 5xx，见 edge-findings 观察项）', async () => {
      for (const body of [
        { username: [dev], password: SECRET },
        { username: { equals: dev }, password: SECRET },
        { username: dev, password: [SECRET] },
        { username: dev, password: 12345 },
        { username: true, password: true },
        { username: dev, password: { toString: SECRET } },
      ]) {
        const r = await authn(body);
        expect(r.body?.result).not.toBe('allow');
      }
      // 之后正常请求不受影响
      expect((await authn({ username: dev, password: SECRET })).body).toEqual({
        result: 'allow',
        acl: deviceAcl(dev),
      });
    });
  });

  describe('授权 authorize', () => {
    it('基线：publish 自己的 event → allow；subscribe 自己的 cmd → allow', async () => {
      expect(
        (
          await authz({
            username: dev,
            topic: `helmet/${dev}/event`,
            action: 'publish',
          })
        ).body,
      ).toEqual({ result: 'allow' });
      expect(
        (
          await authz({
            username: dev,
            topic: `helmet/${dev}/cmd`,
            action: 'subscribe',
          })
        ).body,
      ).toEqual({ result: 'allow' });
    });

    it('Topic 书写变体一律 deny：尾斜杠 / 前斜杠 / 双斜杠 / 大写 Helmet / 叶子大小写 / 带空格 / 叶子后缀', async () => {
      for (const topic of [
        `helmet/${dev}/event/`,
        `/helmet/${dev}/event`,
        `helmet//${dev}/event`,
        `Helmet/${dev}/event`,
        `helmet/${dev}/Event`,
        `helmet/${dev}/event `,
        `helmet/${dev}/events`,
        `helmet/${dev.toUpperCase()}/event`,
      ]) {
        const r = await authz({ username: dev, topic, action: 'publish' });
        expect([topic, r.body.result]).toEqual([topic, 'deny']);
      }
    });

    it('action 大小写 / 未知值 / 类型混淆 → deny（EMQX 只发小写 publish / subscribe，按现状严格匹配）', async () => {
      for (const action of [
        'PUBLISH',
        'Publish',
        'pub',
        'all',
        1,
        ['publish'],
      ]) {
        const r = await authz({
          username: dev,
          topic: `helmet/${dev}/event`,
          action,
        });
        expect(r.body.result).toBe('deny');
      }
    });

    it('topic / username 为数字或数组 → deny，不 5xx（单元素数组的 topic 会被转成同一个字符串，等价于原 topic，不构成越权）', async () => {
      for (const body of [
        { username: dev, topic: 123, action: 'publish' },
        {
          username: dev,
          topic: [`helmet/${dev}/event`, 'helmet/other_device/event'],
          action: 'publish',
        },
        {
          username: dev,
          topic: ['helmet/other_device/event'],
          action: 'publish',
        },
        { username: [dev], topic: `helmet/${dev}/event`, action: 'publish' },
      ]) {
        const r = await authz(body);
        expect(r.status).toBe(200);
        expect(r.body.result).toBe('deny');
      }
    });
  });
});
