// 2026-09-13 全面审计 §9 对讲后端：频道生命周期、邀请码边界、并发名额（旧报告 #8 复验）、
// 成员资料脱敏与互见、拥有者离开后频道归宿、权限口径、UserSig 独立解码回环、未配置 503。
// 全部为进程内 e2e（integration）；不触达腾讯 TRTC 云端。
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import type { PrismaService } from '../src/prisma/prisma.service';
import {
  auth,
  buildApp,
  cleanupUsers,
  createUser,
  histogram,
  type Http,
  type TestUser,
} from './helpers/hardening';
import {
  VOICE_BASE as BASE,
  cleanupChannels,
  decodeUserSigIndependently,
} from './helpers/audit-voice';

jest.setTimeout(60_000);

const TEST_SDK_APP_ID = 1400009913;
const TEST_SECRET = 'audit_0913_trtc_secret_not_real';
const SIG_EXPIRE = 7200;
const MEMBER_LIMIT = 2;

describe('audit-voice：频道与进房凭证 (e2e)', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  const users: TestUser[] = [];

  const newUser = async (): Promise<TestUser> => {
    const u = await createUser(app, http);
    users.push(u);
    return u;
  };

  beforeAll(async () => {
    process.env.TRTC_SDK_APP_ID = String(TEST_SDK_APP_ID);
    process.env.TRTC_SECRET_KEY = TEST_SECRET;
    process.env.TRTC_SIG_EXPIRE_SECONDS = String(SIG_EXPIRE);
    process.env.VOICE_CHANNEL_MEMBER_LIMIT = String(MEMBER_LIMIT);
    ({ app, http, prisma } = await buildApp());
  });

  afterAll(async () => {
    await cleanupChannels(
      prisma,
      users.map((u) => u.id),
    );
    await cleanupUsers(prisma, users);
    await app.close();
  });

  describe('邀请码输入边界（DTO 正则 ^\\d{6}$，ValidationPipe 不做 trim）', () => {
    let owner: TestUser;
    let inviteCode: string;
    beforeAll(async () => {
      owner = await newUser();
      const res = await request(http)
        .post(BASE)
        .set(auth(owner.token))
        .send({ name: 'audit-边界' })
        .expect(201);
      inviteCode = res.body.inviteCode as string;
    });

    it.each([
      ['前后空格', (c: string) => ` ${c} `],
      ['5 位', (c: string) => c.slice(0, 5)],
      ['7 位', (c: string) => `${c}0`],
      ['小写字母混入', (c: string) => `${c.slice(0, 5)}a`],
      ['大写字母混入', (c: string) => `${c.slice(0, 5)}A`],
      ['全角数字', () => '１２３４５６'],
      ['换行结尾', (c: string) => `${c}\n`],
    ])('%s → 400 VALIDATION_FAILED', async (_label, mutate) => {
      const joiner = await newUser();
      const res = await request(http)
        .post(`${BASE}/join`)
        .set(auth(joiner.token))
        .send({ inviteCode: mutate(inviteCode) })
        .expect(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    });

    it('数字类型（非字符串）123456 → 400；缺字段 → 400；不存在的 6 位码 → 404 NOT_FOUND', async () => {
      const joiner = await newUser();
      await request(http)
        .post(`${BASE}/join`)
        .set(auth(joiner.token))
        .send({ inviteCode: 123456 })
        .expect(400);
      await request(http)
        .post(`${BASE}/join`)
        .set(auth(joiner.token))
        .send({})
        .expect(400);
      // 找一个库里不存在的 6 位码
      let missing = '000000';
      for (let i = 0; i < 10; i++) {
        const candidate = String(100000 + Math.floor(Math.random() * 900000));
        const hit = await prisma.voiceChannel.findUnique({
          where: { inviteCode: candidate },
        });
        if (!hit) {
          missing = candidate;
          break;
        }
      }
      const res = await request(http)
        .post(`${BASE}/join`)
        .set(auth(joiner.token))
        .send({ inviteCode: missing })
        .expect(404);
      expect(res.body.code).toBe('NOT_FOUND');
    });

    it('建频道 name 边界：30 字通过、31 字 400、非字符串 400', async () => {
      await request(http)
        .post(BASE)
        .set(auth(owner.token))
        .send({ name: '一'.repeat(30) })
        .expect(201);
      await request(http)
        .post(BASE)
        .set(auth(owner.token))
        .send({ name: '一'.repeat(31) })
        .expect(400);
      await request(http)
        .post(BASE)
        .set(auth(owner.token))
        .send({ name: 123 })
        .expect(400);
    });
  });

  describe('并发名额上限（旧报告 #8 复验，VOICE_CHANNEL_MEMBER_LIMIT=2）', () => {
    it('创建者已占 1 席；5 人同时加入只有 1 人 200，其余 409 CHANNEL_FULL，成员数恰为 2', async () => {
      const owner = await newUser();
      const created = await request(http)
        .post(BASE)
        .set(auth(owner.token))
        .send({ name: 'audit-并发' })
        .expect(201);
      const inviteCode = created.body.inviteCode as string;
      const channelId = created.body.channelId as string;

      const joiners = await Promise.all(
        Array.from({ length: 5 }, () => newUser()),
      );
      const results = await Promise.all(
        joiners.map((j) =>
          request(http)
            .post(`${BASE}/join`)
            .set(auth(j.token))
            .send({ inviteCode }),
        ),
      );
      const statuses = results.map((r) => r.status);

      console.log('[audit-voice] 并发加入状态码直方图', histogram(statuses));
      expect(statuses.filter((s) => s === 200)).toHaveLength(MEMBER_LIMIT - 1);
      expect(statuses.filter((s) => s === 409)).toHaveLength(
        5 - (MEMBER_LIMIT - 1),
      );
      for (const r of results.filter((r) => r.status === 409)) {
        expect(r.body.code).toBe('CHANNEL_FULL');
      }
      const count = await prisma.voiceChannelMember.count({
        where: { channelId },
      });
      expect(count).toBe(MEMBER_LIMIT);

      // 名额释放后可再进一人
      const winner = results.find((r) => r.status === 200)!;
      const winnerUser = joiners[results.indexOf(winner)];
      await request(http)
        .delete(`${BASE}/${channelId}/membership`)
        .set(auth(winnerUser.token))
        .expect(204);
      const loser = joiners[results.findIndex((r) => r.status === 409)];
      await request(http)
        .post(`${BASE}/join`)
        .set(auth(loser.token))
        .send({ inviteCode })
        .expect(200);
    });
  });

  describe('成员资料、拥有者离开、重进、多频道列表', () => {
    let owner: TestUser;
    let member: TestUser;
    let stranger: TestUser;
    let channelId: string;
    let inviteCode: string;

    beforeAll(async () => {
      owner = await newUser();
      member = await newUser();
      stranger = await newUser();
      await request(http)
        .patch('/api/v1/users/me')
        .set(auth(member.token))
        .send({
          nickname: '成员甲',
          avatarUrl: 'data:image/png;base64,iVBORw0KGgo=',
        })
        .expect(200);
      const created = await request(http)
        .post(BASE)
        .set(auth(owner.token))
        .send({ name: 'audit-资料' })
        .expect(201);
      channelId = created.body.channelId as string;
      inviteCode = created.body.inviteCode as string;
      await request(http)
        .post(`${BASE}/join`)
        .set(auth(member.token))
        .send({ inviteCode })
        .expect(200);
    });

    it('成员列表：手机号打码 1xx****xxxx、不含完整号；昵称/头像互见；不多带敏感字段', async () => {
      const res = await request(http)
        .get(`${BASE}/${channelId}/members`)
        .set(auth(owner.token))
        .expect(200);
      const rows = res.body as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(2);
      const memberRow = rows.find((r) => r.userId === member.id)!;
      expect(memberRow.phone).toBe(
        `${member.phone.slice(0, 3)}****${member.phone.slice(-4)}`,
      );
      expect(memberRow.nickname).toBe('成员甲');
      expect(memberRow.avatarUrl).toBe('data:image/png;base64,iVBORw0KGgo=');
      expect(Object.keys(memberRow).sort()).toEqual(
        ['avatarUrl', 'joinedAt', 'nickname', 'phone', 'userId'].sort(),
      );
      expect(JSON.stringify(rows)).not.toContain(member.phone);
      expect(JSON.stringify(rows)).not.toContain(owner.phone);
    });

    it('非成员：members/token 404；不存在的 channelId 404；leave 非成员 404；未登录 401', async () => {
      const r1 = await request(http)
        .get(`${BASE}/${channelId}/members`)
        .set(auth(stranger.token))
        .expect(404);
      expect(r1.body.code).toBe('NOT_FOUND');
      await request(http)
        .post(`${BASE}/${channelId}/token`)
        .set(auth(stranger.token))
        .expect(404);
      await request(http)
        .get(`${BASE}/does-not-exist/members`)
        .set(auth(owner.token))
        .expect(404);
      await request(http)
        .delete(`${BASE}/${channelId}/membership`)
        .set(auth(stranger.token))
        .expect(404);
      await request(http).post(`${BASE}/${channelId}/token`).expect(401);
      await request(http).delete(`${BASE}/${channelId}/membership`).expect(401);
    });

    it('拥有者离开：频道保留、ownerId 不变、剩余成员照常取凭证；拥有者列表不再显示；凭码可重进', async () => {
      await request(http)
        .delete(`${BASE}/${channelId}/membership`)
        .set(auth(owner.token))
        .expect(204);
      const channel = await prisma.voiceChannel.findUniqueOrThrow({
        where: { id: channelId },
      });
      expect(channel.ownerId).toBe(owner.id); // 拥有权不转移（MVP 口径：频道保留、不回收）
      const mine = await request(http)
        .get(BASE)
        .set(auth(owner.token))
        .expect(200);
      expect(
        (mine.body as Array<{ channelId: string }>).some(
          (c) => c.channelId === channelId,
        ),
      ).toBe(false);
      await request(http)
        .post(`${BASE}/${channelId}/token`)
        .set(auth(owner.token))
        .expect(404);
      const memberToken = await request(http)
        .post(`${BASE}/${channelId}/token`)
        .set(auth(member.token))
        .expect(200);
      expect(memberToken.body.roomId).toBe(channel.roomId);

      // 重进
      const rejoined = await request(http)
        .post(`${BASE}/join`)
        .set(auth(owner.token))
        .send({ inviteCode })
        .expect(200);
      expect(rejoined.body.memberCount).toBe(2);
      const members = await request(http)
        .get(`${BASE}/${channelId}/members`)
        .set(auth(owner.token))
        .expect(200);
      // 重进后 joinedAt 变新，排序落到成员之后
      expect(
        (members.body as Array<{ userId: string }>).map((m) => m.userId),
      ).toEqual([member.id, owner.id]);
    });

    it('多频道：列表按 joinedAt 倒序；App 当前只取 data[0]（静态：多频道 UI 未实现）', async () => {
      const second = await request(http)
        .post(BASE)
        .set(auth(owner.token))
        .send({ name: 'audit-第二频道' })
        .expect(201);
      const mine = await request(http)
        .get(BASE)
        .set(auth(owner.token))
        .expect(200);
      const ids = (mine.body as Array<{ channelId: string }>).map(
        (c) => c.channelId,
      );
      expect(ids.indexOf(second.body.channelId as string)).toBeLessThan(
        ids.indexOf(channelId),
      );
    });
  });

  describe('UserSig（独立解码回环——不等于腾讯云服务商兼容验证）', () => {
    let owner: TestUser;
    let channelId: string;
    beforeAll(async () => {
      owner = await newUser();
      const created = await request(http)
        .post(BASE)
        .set(auth(owner.token))
        .send({ name: 'audit-sig' })
        .expect(201);
      channelId = created.body.channelId as string;
    });

    it('字段/HMAC/expire/expiresAt 全部对得上；无 base64 保留字符', async () => {
      const before = Math.floor(Date.now() / 1000);
      const res = await request(http)
        .post(`${BASE}/${channelId}/token`)
        .set(auth(owner.token))
        .expect(200);
      expect(Object.keys(res.body).sort()).toEqual(
        [
          'expiresAt',
          'privateMapKey',
          'roomId',
          'sdkAppId',
          'userId',
          'userSig',
        ].sort(),
      );
      expect(res.body.sdkAppId).toBe(TEST_SDK_APP_ID);
      expect(res.body.userId).toBe(owner.id);
      const sig = res.body.userSig as string;
      expect(sig).not.toMatch(/[+/=]/);
      const decoded = decodeUserSigIndependently(sig, TEST_SECRET);
      expect(decoded.ver).toBe('2.0');
      expect(decoded.identifier).toBe(owner.id);
      expect(decoded.sdkAppId).toBe(TEST_SDK_APP_ID);
      expect(decoded.expire).toBe(SIG_EXPIRE);
      expect(decoded.time).toBeGreaterThanOrEqual(before - 1);
      expect(decoded.time).toBeLessThanOrEqual(before + 5);
      expect(decoded.hmacMatches).toBe(true);
      const expiresAt = Math.floor(
        new Date(res.body.expiresAt as string).getTime() / 1000,
      );
      expect(
        Math.abs(expiresAt - (decoded.time + SIG_EXPIRE)),
      ).toBeLessThanOrEqual(2);
      // 错密钥必须不匹配（证明回环不是恒真）
      expect(decodeUserSigIndependently(sig, 'wrong').hmacMatches).toBe(false);
    });

    it('TRTC_SIG_EXPIRE_SECONDS 非法值（abc / 0 / -1）回落默认 86400', async () => {
      for (const bad of ['abc', '0', '-1', '1.5']) {
        process.env.TRTC_SIG_EXPIRE_SECONDS = bad;
        const res = await request(http)
          .post(`${BASE}/${channelId}/token`)
          .set(auth(owner.token))
          .expect(200);
        expect(
          decodeUserSigIndependently(res.body.userSig as string, TEST_SECRET)
            .expire,
        ).toBe(86400);
      }
      process.env.TRTC_SIG_EXPIRE_SECONDS = String(SIG_EXPIRE);
    });

    it.each([
      ['缺 TRTC_SECRET_KEY', () => delete process.env.TRTC_SECRET_KEY],
      ['缺 TRTC_SDK_APP_ID', () => delete process.env.TRTC_SDK_APP_ID],
      [
        'TRTC_SDK_APP_ID=abc',
        () => {
          process.env.TRTC_SDK_APP_ID = 'abc';
        },
      ],
      [
        'TRTC_SDK_APP_ID=0',
        () => {
          process.env.TRTC_SDK_APP_ID = '0';
        },
      ],
      [
        'TRTC_SECRET_KEY 为空串',
        () => {
          process.env.TRTC_SECRET_KEY = '';
        },
      ],
    ])(
      '%s → 503 TRTC_NOT_CONFIGURED，频道接口不受影响',
      async (_label, mutate) => {
        const savedId = process.env.TRTC_SDK_APP_ID;
        const savedKey = process.env.TRTC_SECRET_KEY;
        mutate();
        try {
          const res = await request(http)
            .post(`${BASE}/${channelId}/token`)
            .set(auth(owner.token))
            .expect(503);
          expect(res.body.code).toBe('TRTC_NOT_CONFIGURED');
          expect(JSON.stringify(res.body)).not.toContain(TEST_SECRET);
          await request(http)
            .get(`${BASE}/${channelId}/members`)
            .set(auth(owner.token))
            .expect(200);
        } finally {
          process.env.TRTC_SDK_APP_ID = savedId;
          process.env.TRTC_SECRET_KEY = savedKey;
        }
      },
    );

    it('凭证签发用的 userId 与成员列表 userId 一致（TRTC 内 userId=后端用户 id）', async () => {
      const res = await request(http)
        .post(`${BASE}/${channelId}/token`)
        .set(auth(owner.token))
        .expect(200);
      const members = await request(http)
        .get(`${BASE}/${channelId}/members`)
        .set(auth(owner.token))
        .expect(200);
      expect((members.body as Array<{ userId: string }>)[0].userId).toBe(
        res.body.userId,
      );
    });
  });
});
