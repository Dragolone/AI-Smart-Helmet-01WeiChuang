// 2026-10-16 边界测试：紧急联系人（API.md §3）。
// 联系人名与号码原样进 SOS 短信，所以重点是入参规范化与名额 / 归属；文档没写的按现状断言并注明。
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  auth,
  buildApp,
  cleanupUsers,
  createUser,
  histogram,
  type Http,
  type TestUser,
} from './helpers/hardening';

jest.setTimeout(120_000);

const BASE = '/api/v1/users/me/emergency-contacts';

describe('边界：紧急联系人 (e2e)', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  const users: TestUser[] = [];

  const newUser = async (): Promise<TestUser> => {
    const u = await createUser(app, http);
    users.push(u);
    return u;
  };
  const create = (u: TestUser, body: unknown) =>
    request(http)
      .post(BASE)
      .set(auth(u.token))
      .send(body as object);
  const patch = (u: TestUser, id: string, body: unknown) =>
    request(http)
      .patch(`${BASE}/${encodeURIComponent(id)}`)
      .set(auth(u.token))
      .send(body as object);
  const list = async (u: TestUser) =>
    (await request(http).get(BASE).set(auth(u.token)).expect(200))
      .body as Array<{
      id: string;
      name: string;
      phone: string;
      relation: string | null;
    }>;

  beforeAll(async () => {
    ({ app, http, prisma } = await buildApp());
  });

  afterAll(async () => {
    await cleanupUsers(prisma, users);
    await app.close();
  });

  it('号码写法变体（+86 / 空格分组 / 横线 / 全角 / 首尾空格 / 零宽字符 / 座机）一律 400：与注册同口径，服务端不归一化', async () => {
    const u = await newUser();
    for (const phone of [
      '+8613800001111',
      '8613800001111',
      '138 0000 1111',
      '138-0000-1111',
      '１３８００００１１１１',
      ' 13800001111',
      '13800001111 ',
      '138\u200b00001111',
      '01088886666',
      '1380000111',
      '138000011112',
      '12800001111',
    ]) {
      const r = await create(u, { name: '家人', phone });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('VALIDATION_FAILED');
    }
    expect(await list(u)).toHaveLength(0);
  });

  it('姓名首尾空白被 trim；全空白（空格 / 制表 / 换行 / 全角空格）→ 400', async () => {
    const u = await newUser();
    const r = await create(u, { name: '  \t张三 \n', phone: '13800001111' });
    expect(r.status).toBe(201);
    expect(r.body.name).toBe('张三');
    for (const name of ['   ', '\t\n', '\u3000\u3000', '']) {
      const bad = await create(u, { name, phone: '13800001112' });
      expect(bad.status).toBe(400);
    }
  });

  it('姓名只有零宽空格（\\u200b 不算空白）：201 原样入库（文档未写，按现状——短信里会是空名）', async () => {
    const u = await newUser();
    const r = await create(u, { name: '\u200b', phone: '13800001113' });
    expect(r.status).toBe(201);
    expect(r.body.name).toBe('\u200b');
  });

  it('姓名长度：trim 后 30 字通过、31 字 400；首尾空白不计入（先 trim 再验）；30 个 emoji 通过', async () => {
    const u = await newUser();
    expect(
      (await create(u, { name: '名'.repeat(30), phone: '13800001114' })).status,
    ).toBe(201);
    expect(
      (await create(u, { name: '名'.repeat(31), phone: '13800001114' })).status,
    ).toBe(400);
    const padded = await create(u, {
      name: `   ${'名'.repeat(30)}   `,
      phone: '13800001114',
    });
    expect(padded.status).toBe(201);
    expect(padded.body.name).toBe('名'.repeat(30));
    expect(
      (await create(u, { name: '😀'.repeat(30), phone: '13800001114' })).status,
    ).toBe(201);
  });

  it('关系 relation：20 字通过、21 字 400；不 trim；空串原样；null / 缺省为 null；非字符串 400', async () => {
    const u = await newUser();
    const r20 = await create(u, {
      name: 'a',
      phone: '13800001115',
      relation: '关'.repeat(20),
    });
    expect(r20.status).toBe(201);
    expect(
      (
        await create(u, {
          name: 'b',
          phone: '13800001115',
          relation: '关'.repeat(21),
        })
      ).status,
    ).toBe(400);
    const spaced = await create(u, {
      name: 'c',
      phone: '13800001115',
      relation: ' 父亲 ',
    });
    expect(spaced.body.relation).toBe(' 父亲 ');
    const empty = await create(u, {
      name: 'd',
      phone: '13800001115',
      relation: '',
    });
    expect(empty.body.relation).toBe('');
    const nul = await create(u, {
      name: 'e',
      phone: '13800001115',
      relation: null,
    });
    expect(nul.status).toBe(201);
    expect(nul.body.relation).toBeNull();
    // 已经 5 个了，下面只验校验失败的路径（400 先于名额检查）
    expect(
      (await create(u, { name: 'f', phone: '13800001115', relation: 42 }))
        .status,
    ).toBe(400);
  });

  it('同一号码可存多个联系人、也可填本人号码（文档未写，按现状；SOS 发送时同号去重已有用例）', async () => {
    const u = await newUser();
    await create(u, { name: '甲', phone: '13800002222' }).expect(201);
    await create(u, { name: '乙', phone: '13800002222' }).expect(201);
    const self = await create(u, { name: '我自己', phone: u.phone });
    expect(self.status).toBe(201);
    expect((await list(u)).map((c) => c.phone)).toEqual([
      '13800002222',
      '13800002222',
      u.phone,
    ]);
  });

  it('PATCH：name / phone 传 null → 400（必填列）；relation: null → 清空；{} → 200 不变；全空白名 → 400', async () => {
    const u = await newUser();
    const c = (
      await create(u, { name: '原名', phone: '13800003333', relation: '朋友' })
    ).body as { id: string };
    expect((await patch(u, c.id, { name: null })).status).toBe(400);
    expect((await patch(u, c.id, { phone: null })).status).toBe(400);
    expect((await patch(u, c.id, { name: '   ' })).status).toBe(400);
    expect((await patch(u, c.id, { phone: '+8613800003333' })).status).toBe(
      400,
    );
    const same = await patch(u, c.id, {});
    expect(same.status).toBe(200);
    expect(same.body).toMatchObject({
      name: '原名',
      phone: '13800003333',
      relation: '朋友',
    });
    const cleared = await patch(u, c.id, { relation: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.relation).toBeNull();
    const renamed = await patch(u, c.id, { name: '  新名  ' });
    expect(renamed.body.name).toBe('新名');
  });

  it('PATCH 不能借道改归属 / 主键：userId / id / deletedAt 字段被丢弃', async () => {
    const u = await newUser();
    const v = await newUser();
    const c = (await create(u, { name: 'x', phone: '13800004444' })).body as {
      id: string;
    };
    const r = await patch(u, c.id, {
      userId: v.id,
      id: 'hijack',
      deletedAt: new Date().toISOString(),
      name: 'y',
    });
    expect(r.status).toBe(200);
    expect(r.body.id).toBe(c.id);
    expect((await list(u)).map((x) => x.id)).toEqual([c.id]);
    expect(await list(v)).toHaveLength(0);
  });

  it('不存在 / 超长 / 含特殊字符的 contactId：PATCH 与 DELETE 一律 404 NOT_FOUND', async () => {
    const u = await newUser();
    for (const id of [
      'nope',
      'x'.repeat(2000),
      "1' OR '1'='1",
      '../../users/me',
      '😀',
    ]) {
      const p = await patch(u, id, { name: 'z' });
      expect(p.status).toBe(404);
      expect(p.body.code).toBe('NOT_FOUND');
      const d = await request(http)
        .delete(`${BASE}/${encodeURIComponent(id)}`)
        .set(auth(u.token));
      expect(d.status).toBe(404);
    }
  });

  it('顺序删除两次：第二次 404；已删联系人 PATCH 404；删除后名额释放', async () => {
    const u = await newUser();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(
        (await create(u, { name: `c${i}`, phone: `1380000500${i}` })).body
          .id as string,
      );
    }
    const full = await create(u, { name: 'c5', phone: '13800005005' });
    expect(full.status).toBe(409);
    expect(full.body.code).toBe('EMERGENCY_CONTACT_LIMIT_REACHED');
    await request(http)
      .delete(`${BASE}/${ids[0]}`)
      .set(auth(u.token))
      .expect(204);
    await request(http)
      .delete(`${BASE}/${ids[0]}`)
      .set(auth(u.token))
      .expect(404);
    expect((await patch(u, ids[0], { name: '复活' })).status).toBe(404);
    await create(u, { name: 'c5', phone: '13800005005' }).expect(201);
  });

  it('并发删除同一个联系人 5 次：无 5xx，至少一个 204，最终只少一个（并发下其余也可能 204——检查与更新非原子，按现状）', async () => {
    const u = await newUser();
    const keep = (await create(u, { name: '留', phone: '13800006000' })).body
      .id as string;
    const del = (await create(u, { name: '删', phone: '13800006001' })).body
      .id as string;
    const rs = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(http).delete(`${BASE}/${del}`).set(auth(u.token)),
      ),
    );
    expect(rs.every((r) => r.status === 204 || r.status === 404)).toBe(true);
    expect(rs.some((r) => r.status === 204)).toBe(true);
    expect((await list(u)).map((c) => c.id)).toEqual([keep]);
  });

  it('并发 PATCH 同一联系人 10 次：全部 200，最终值是其中之一', async () => {
    const u = await newUser();
    const id = (await create(u, { name: 'p', phone: '13800007000' })).body
      .id as string;
    const names = Array.from({ length: 10 }, (_, i) => `并发${i}`);
    const rs = await Promise.all(names.map((name) => patch(u, id, { name })));
    expect(histogram(rs.map((r) => r.status))).toEqual({ '200': 10 });
    expect(names).toContain((await list(u))[0].name);
  });

  it('名额满后并发「删 1 + 建 3」：活跃数始终不超过 5', async () => {
    const u = await newUser();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(
        (await create(u, { name: `m${i}`, phone: `1380000800${i}` })).body
          .id as string,
      );
    }
    await Promise.all([
      request(http).delete(`${BASE}/${ids[2]}`).set(auth(u.token)),
      create(u, { name: 'n1', phone: '13800008101' }),
      create(u, { name: 'n2', phone: '13800008102' }),
      create(u, { name: 'n3', phone: '13800008103' }),
    ]);
    const active = await prisma.emergencyContact.count({
      where: { userId: u.id, deletedAt: null },
    });
    expect(active).toBeLessThanOrEqual(5);
    expect(active).toBeGreaterThanOrEqual(4);
  });

  it('请求体是数组 / 字符串 → 400，不建联系人', async () => {
    const u = await newUser();
    const arr = await create(u, [{ name: 'x', phone: '13800009000' }]);
    expect(arr.status).toBe(400);
    const str = await request(http)
      .post(BASE)
      .set(auth(u.token))
      .set('Content-Type', 'application/json')
      .send('"13800009000"');
    expect(str.status).toBe(400);
    expect(await list(u)).toHaveLength(0);
  });
});
