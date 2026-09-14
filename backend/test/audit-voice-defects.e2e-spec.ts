// 2026-09-13 全面审计 voice 领域——【预期失败】缺陷复现用例（按审计规则保留失败测试作证据，不改业务源码）。
// VOICE-01：同一用户并发重复加入、且自己的加入恰好把频道填满时，后续同请求返回 409 CHANNEL_FULL，
//           违反 API.md §13「重复加入幂等返回频道」。
// VOICE-02：注销账号（DELETE /users/me）后频道成员关系残留：仍占名额、成员列表仍返回该用户
//           （phone 显示为 "del****<id 尾 4 位>"，nickname 仍可见）。
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
import { VOICE_BASE as BASE, cleanupChannels } from './helpers/audit-voice';

jest.setTimeout(60_000);

describe('audit-voice-defects：预期失败的缺陷复现 (e2e)', () => {
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
    process.env.VOICE_CHANNEL_MEMBER_LIMIT = '2';
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

  it('VOICE-01 同一人 5 次并发加入（其加入恰好填满频道）：契约应全部 200，实际 1×200 + 4×409', async () => {
    const owner = await newUser();
    const created = await request(http)
      .post(BASE)
      .set(auth(owner.token))
      .send({ name: 'audit-幂等缺陷' })
      .expect(201);
    const inviteCode = created.body.inviteCode as string;
    const channelId = created.body.channelId as string;
    const joiner = await newUser();
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(http)
          .post(`${BASE}/join`)
          .set(auth(joiner.token))
          .send({ inviteCode }),
      ),
    );

    console.log(
      '[VOICE-01] 状态码直方图',
      histogram(results.map((r) => r.status)),
      '409 body:',
      results.find((r) => r.status === 409)?.body,
    );
    const count = await prisma.voiceChannelMember.count({
      where: { channelId, userId: joiner.id },
    });
    expect(count).toBe(1); // 数据层幂等成立（唯一约束兜底）
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]); // 接口层幂等不成立
  });

  it('VOICE-02 注销账号后应退出全部频道：成员列表不应再含该用户、名额应释放', async () => {
    const owner = await newUser();
    const leaver = await newUser();
    await request(http)
      .patch('/api/v1/users/me')
      .set(auth(leaver.token))
      .send({ nickname: '将注销者' })
      .expect(200);
    const created = await request(http)
      .post(BASE)
      .set(auth(owner.token))
      .send({ name: 'audit-注销残留' })
      .expect(201);
    const channelId = created.body.channelId as string;
    const inviteCode = created.body.inviteCode as string;
    await request(http)
      .post(`${BASE}/join`)
      .set(auth(leaver.token))
      .send({ inviteCode })
      .expect(200);

    await request(http)
      .delete('/api/v1/users/me')
      .set(auth(leaver.token))
      .send({ password: leaver.password })
      .expect(204);
    // 注销后原 token 应失效（旧报告 #61 修复口径）
    await request(http)
      .get(`${BASE}/${channelId}/members`)
      .set(auth(leaver.token))
      .expect(401);

    const members = await request(http)
      .get(`${BASE}/${channelId}/members`)
      .set(auth(owner.token))
      .expect(200);

    console.log('[VOICE-02] 注销后成员列表', JSON.stringify(members.body));
    const remaining = await prisma.voiceChannelMember.count({
      where: { channelId },
    });
    const third = await newUser();
    const joinAfter = await request(http)
      .post(`${BASE}/join`)
      .set(auth(third.token))
      .send({ inviteCode });

    console.log('[VOICE-02] 第三人加入状态', joinAfter.status, joinAfter.body);

    expect(
      (members.body as Array<{ userId: string }>).some(
        (m) => m.userId === leaver.id,
      ),
    ).toBe(false);
    expect(remaining).toBe(1);
    expect(joinAfter.status).toBe(200);
  });
});
