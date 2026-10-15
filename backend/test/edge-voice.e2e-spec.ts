// 2026-10-16 边界测试：对讲频道（API.md §13，决策 #27⑤ / #56 / #57）。
// 默认成员上限 20（不改 env）满员与释放、最后一人退出后频道的去留、邀请码 / 房间号的形状、
// 入参变体与并发。文档没写的按现状断言并注明。
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { INVITE_CODE_ALPHABET } from '../src/voice/invite-code';
import {
  auth,
  buildApp,
  cleanupUsers,
  createUser,
  histogram,
  type Http,
  type TestUser,
} from './helpers/hardening';

jest.setTimeout(180_000);

const BASE = '/api/v1/voice/channels';

interface Channel {
  channelId: string;
  name: string;
  roomId: number;
  inviteCode: string;
  ownerId: string;
  memberCount: number;
}

describe('边界：对讲频道 (e2e)', () => {
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
  const join = (u: TestUser, inviteCode: unknown) =>
    request(http).post(`${BASE}/join`).set(auth(u.token)).send({ inviteCode });
  const leave = (u: TestUser, channelId: string) =>
    request(http)
      .delete(`${BASE}/${encodeURIComponent(channelId)}/membership`)
      .set(auth(u.token));
  const members = (u: TestUser, channelId: string) =>
    request(http)
      .get(`${BASE}/${encodeURIComponent(channelId)}/members`)
      .set(auth(u.token));

  beforeAll(async () => {
    // 用产品默认值（20）；别的套件把它调小过，这里显式去掉
    delete process.env.VOICE_CHANNEL_MEMBER_LIMIT;
    ({ app, http, prisma } = await buildApp());
  });

  afterAll(async () => {
    await cleanupUsers(prisma, users);
    await app.close();
  });

  describe('建频道', () => {
    it('频道名：30 字 / 30 个 emoji 通过；31 字、空串、非字符串、缺失 → 400', async () => {
      const u = await newUser();
      expect((await create(u, { name: '队'.repeat(30) })).status).toBe(201);
      expect((await create(u, { name: '🏍'.repeat(30) })).status).toBe(201);
      for (const body of [
        { name: '队'.repeat(31) },
        { name: '' },
        { name: 42 },
        { name: ['a'] },
        {},
      ]) {
        const r = await create(u, body);
        expect(r.status).toBe(400);
        expect(r.body.code).toBe('VALIDATION_FAILED');
      }
    });

    it('全空白频道名 201 原样保存、首尾空白不 trim（文档未写，按现状——与联系人名 / 设备名会 trim 不一致）', async () => {
      const u = await newUser();
      const blank = await create(u, { name: '   ' });
      expect(blank.status).toBe(201);
      expect(blank.body.name).toBe('   ');
      const padded = await create(u, { name: '  周末骑行  ' });
      expect(padded.body.name).toBe('  周末骑行  ');
    });

    it('邀请码 6 位、只用 2–9 与去掉 I/L/O 的大写字母；roomId 是 [1e9, 2^31) 的整数；30 个频道两两不同', async () => {
      const u = await newUser();
      const chans: Channel[] = [];
      for (let i = 0; i < 30; i++) {
        chans.push(
          (await create(u, { name: `c${i}` }).expect(201)).body as Channel,
        );
      }
      for (const c of chans) {
        expect(c.inviteCode).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/);
        expect(
          [...c.inviteCode].every((ch) => INVITE_CODE_ALPHABET.includes(ch)),
        ).toBe(true);
        expect(Number.isInteger(c.roomId)).toBe(true);
        expect(c.roomId).toBeGreaterThanOrEqual(1_000_000_000);
        expect(c.roomId).toBeLessThan(2_147_483_648);
        expect(c.memberCount).toBe(1);
        expect(c.ownerId).toBe(u.id);
      }
      expect(new Set(chans.map((c) => c.inviteCode)).size).toBe(30);
      expect(new Set(chans.map((c) => c.roomId)).size).toBe(30);
    });

    it('同一用户并发建 10 个频道：全部 201、各不相同；我的列表按加入时间倒序含这 10 个', async () => {
      const u = await newUser();
      const rs = await Promise.all(
        Array.from({ length: 10 }, (_, i) => create(u, { name: `并发${i}` })),
      );
      expect(histogram(rs.map((r) => r.status))).toEqual({ '201': 10 });
      const ids = new Set(rs.map((r) => (r.body as Channel).channelId));
      expect(ids.size).toBe(10);
      const mine = await request(http).get(BASE).set(auth(u.token)).expect(200);
      expect(mine.body).toHaveLength(10);
      expect(new Set(mine.body.map((c: Channel) => c.channelId))).toEqual(ids);
    });
  });

  describe('加入', () => {
    it('邀请码形状：首尾空格 / 5 位 / 7 位 / 带横线 / 全角 / 空串 / 数字类型 / 缺失 → 400（不 trim、不当成 404）', async () => {
      const owner = await newUser();
      const u = await newUser();
      const c = (await create(owner, { name: '形状' })).body as Channel;
      for (const code of [
        ` ${c.inviteCode}`,
        `${c.inviteCode} `,
        c.inviteCode.slice(0, 5),
        `${c.inviteCode}2`,
        `${c.inviteCode.slice(0, 3)}-${c.inviteCode.slice(3, 5)}`,
        c.inviteCode.replace(/[A-Z0-9]/g, (ch) =>
          String.fromCharCode(ch.charCodeAt(0) + 0xfee0),
        ),
        '',
        123456,
        undefined,
      ]) {
        const r = await join(u, code);
        expect(r.status).toBe(400);
        expect(r.body.code).toBe('VALIDATION_FAILED');
      }
      expect((await members(owner, c.channelId).expect(200)).body).toHaveLength(
        1,
      );
    });

    it('自己建的频道再凭码加入：200 幂等，成员数不变', async () => {
      const u = await newUser();
      const c = (await create(u, { name: '自加' })).body as Channel;
      const r = await join(u, c.inviteCode);
      expect(r.status).toBe(200);
      expect(r.body.memberCount).toBe(1);
      expect(r.body.channelId).toBe(c.channelId);
    });

    it('默认上限 20：建者 + 19 人满员，第 21 人 409 CHANNEL_FULL；有人退出后第 21 人能进；满员时已在里面的人再加入仍 200', async () => {
      const owner = await newUser();
      const c = (await create(owner, { name: '满员' })).body as Channel;
      const joiners: TestUser[] = [];
      for (let i = 0; i < 19; i++) joiners.push(await newUser());
      for (const j of joiners) await join(j, c.inviteCode).expect(200);
      const last = await newUser();
      const full = await join(last, c.inviteCode);
      expect(full.status).toBe(409);
      expect(full.body.code).toBe('CHANNEL_FULL');
      // 满员时成员重复加入：幂等 200，不报满
      const again = await join(joiners[0], c.inviteCode);
      expect(again.status).toBe(200);
      expect(again.body.memberCount).toBe(20);
      await leave(joiners[5], c.channelId).expect(204);
      const now = await join(last, c.inviteCode);
      expect(now.status).toBe(200);
      expect(now.body.memberCount).toBe(20);
      expect(
        await prisma.voiceChannelMember.count({
          where: { channelId: c.channelId },
        }),
      ).toBe(20);
    });

    it('满员前最后一席被 5 个新人并发抢：恰好 1 个 200，其余 409，成员数 = 20', async () => {
      const owner = await newUser();
      const c = (await create(owner, { name: '抢最后一席' })).body as Channel;
      for (let i = 0; i < 18; i++) {
        await join(await newUser(), c.inviteCode).expect(200);
      }
      const racers = await Promise.all(
        Array.from({ length: 5 }, () => newUser()),
      );
      const rs = await Promise.all(racers.map((r) => join(r, c.inviteCode)));
      expect(histogram(rs.map((r) => r.status))).toEqual({
        '200': 1,
        '409': 4,
      });
      expect(
        await prisma.voiceChannelMember.count({
          where: { channelId: c.channelId },
        }),
      ).toBe(20);
    });
  });

  describe('退出', () => {
    it('最后一人退出：频道保留（memberCount 0、无人可见）；之后凭码重进，成员只剩重进的人，ownerId 不变', async () => {
      const owner = await newUser();
      const u = await newUser();
      const c = (await create(owner, { name: '空频道' })).body as Channel;
      await leave(owner, c.channelId).expect(204);
      const row = await prisma.voiceChannel.findUnique({
        where: { id: c.channelId },
      });
      expect(row).not.toBeNull();
      expect(
        await prisma.voiceChannelMember.count({
          where: { channelId: c.channelId },
        }),
      ).toBe(0);
      const r = await join(u, c.inviteCode);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ memberCount: 1, ownerId: owner.id });
      const m = await members(u, c.channelId).expect(200);
      expect(m.body.map((x: { userId: string }) => x.userId)).toEqual([u.id]);
    });

    it('顺序退两次：第二次 404；并发退 5 次：恰好 1 个 204、其余 404', async () => {
      const owner = await newUser();
      const a = await newUser();
      const b = await newUser();
      const c = (await create(owner, { name: '退出' })).body as Channel;
      await join(a, c.inviteCode).expect(200);
      await join(b, c.inviteCode).expect(200);
      await leave(a, c.channelId).expect(204);
      const twice = await leave(a, c.channelId);
      expect(twice.status).toBe(404);
      expect(twice.body.code).toBe('NOT_FOUND');
      const rs = await Promise.all(
        Array.from({ length: 5 }, () => leave(b, c.channelId)),
      );
      expect(histogram(rs.map((r) => r.status))).toEqual({
        '204': 1,
        '404': 4,
      });
    });

    it('不存在 / 超长 / 特殊字符的 channelId：退出、成员、凭证一律 404', async () => {
      const u = await newUser();
      for (const id of ['nope', 'x'.repeat(3000), "1' OR '1'='1", '😀']) {
        expect((await leave(u, id)).status).toBe(404);
        expect((await members(u, id)).status).toBe(404);
        const t = await request(http)
          .post(`${BASE}/${encodeURIComponent(id)}/token`)
          .set(auth(u.token));
        expect(t.status).toBe(404);
      }
    });
  });

  describe('成员档案', () => {
    it('成员按加入先后；昵称为 null / 空串 / RTL 原样；手机号脱敏不含完整号；头像互见', async () => {
      const owner = await newUser();
      const a = await newUser();
      await request(http)
        .patch('/api/v1/users/me')
        .set(auth(a.token))
        .send({ nickname: '‮骑手', avatarUrl: 'https://cdn.example.com/a.png' })
        .expect(200);
      const c = (await create(owner, { name: '档案' })).body as Channel;
      await join(a, c.inviteCode).expect(200);
      const m = await members(owner, c.channelId).expect(200);
      expect(m.body.map((x: { userId: string }) => x.userId)).toEqual([
        owner.id,
        a.id,
      ]);
      expect(m.body[0].nickname).toBeNull();
      expect(m.body[1]).toMatchObject({
        nickname: '‮骑手',
        avatarUrl: 'https://cdn.example.com/a.png',
        phone: `${a.phone.slice(0, 3)}****${a.phone.slice(7)}`,
      });
      expect(JSON.stringify(m.body)).not.toContain(a.phone);
      expect(JSON.stringify(m.body)).not.toContain(owner.phone);
    });
  });
});
