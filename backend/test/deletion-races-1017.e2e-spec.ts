// 注销（DELETE /users/me）与同一账号其他写操作的竞态（10-17 第二轮评审 r1）：请求在注销提交前通过了 JWT 守卫，
// 注销提交后才落库，数据就写进了已注销账号。设备绑定 #223 已修，这里覆盖其余写路径（common/live-user.ts）。
// 用数据库锁把请求卡在「过了守卫、还没写」的位置，等注销提交后再放行，确定性复现。
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { issueCode } from './helpers/audit-auth';
import {
  auth,
  buildApp,
  cleanupUsers,
  createUser,
  randomPhone,
  sleep,
  type Http,
  type TestUser,
} from './helpers/hardening';

jest.setTimeout(120_000);

describe('注销与并发写竞态 (e2e)', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  const users: Array<{ id: string; phone: string }> = [];

  const newUser = async (): Promise<TestUser> => {
    const u = await createUser(app, http);
    users.push(u);
    return u;
  };

  /** 另开一个事务执行 lockSql 并一直持有，直到调用 release() */
  const holdLock = async (
    lock: (tx: PrismaService) => Promise<unknown>,
  ): Promise<{ release: () => Promise<void> }> => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let acquired!: () => void;
    const ready = new Promise<void>((r) => (acquired = r));
    const done = prisma.$transaction(
      async (tx) => {
        await lock(tx as unknown as PrismaService);
        acquired();
        await gate;
      },
      { timeout: 60_000, maxWait: 10_000 },
    );
    await ready;
    return {
      release: async () => {
        release();
        await done;
      },
    };
  };

  /** 等到至少一个会话在等锁（请求已过守卫、卡在写库那一步） */
  const waitForLockWaiter = async (): Promise<void> => {
    for (let i = 0; i < 200; i++) {
      const [row] = await prisma.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted`;
      if (row.n > 0) return;
      await sleep(25);
    }
    throw new Error('请求没有卡在锁上');
  };

  const deleteAccount = (u: TestUser) =>
    request(http)
      .delete('/api/v1/users/me')
      .set(auth(u.token))
      .send({ password: u.password })
      .expect(204);

  beforeAll(async () => {
    ({ app, http, prisma } = await buildApp());
  });
  afterAll(async () => {
    await cleanupUsers(prisma, users);
    await app.close();
  });

  it('换绑手机号与注销竞态：换号 401，已注销账号不占新号，新号照常能注册', async () => {
    const u = await newUser();
    const newPhone = randomPhone();
    const code = await issueCode(app, http, newPhone, 'change_phone');

    // 卡住换号请求的「核销验证码」那一步（新号的验证码行），注销不碰这一行
    const lock = await holdLock(
      (tx) =>
        tx.$queryRaw`SELECT id FROM sms_codes WHERE phone = ${newPhone} FOR UPDATE`,
    );
    const changeP = request(http)
      .post('/api/v1/auth/change-phone')
      .set(auth(u.token))
      .send({ newPhone, code, password: u.password })
      .then((r) => r);
    await waitForLockWaiter();
    await deleteAccount(u);
    await lock.release();
    const change = await changeP;
    users.push({ id: u.id, phone: newPhone });

    const row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    // 新号的主人想注册：发码 409 PHONE_ALREADY_REGISTERED，登录也进不去（账号已注销）
    const reg = await request(http)
      .post('/api/v1/auth/sms-code')
      .send({ phone: newPhone, purpose: 'register' });
    expect(change.status).toBe(401);
    expect(row.deletedAt).not.toBeNull();
    expect(row.phone).toBe(`deleted:${u.id}`);
    expect(reg.status).toBe(204);
  });

  it('建紧急联系人与注销竞态：建联系人 401，注销后没有活跃联系人', async () => {
    const u = await newUser();
    const lock = await holdLock(
      (tx) =>
        tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`contacts:${u.id}`}))`,
    );
    const createP = request(http)
      .post('/api/v1/users/me/emergency-contacts')
      .set(auth(u.token))
      .send({ name: '妈妈', phone: randomPhone() })
      .then((r) => r);
    await waitForLockWaiter();
    await deleteAccount(u);
    await lock.release();
    const created = await createP;

    const active = await prisma.emergencyContact.count({
      where: { userId: u.id, deletedAt: null },
    });
    expect(created.status).toBe(401);
    expect(active).toBe(0);
  });

  it('凭码入频道与注销竞态：入频道 401，已注销账号不留在成员里占名额', async () => {
    const owner = await newUser();
    const ghost = await newUser();
    const ch = await request(http)
      .post('/api/v1/voice/channels')
      .set(auth(owner.token))
      .send({ name: 'r1 竞态' })
      .expect(201);
    const channelId = ch.body.channelId as string;

    const lock = await holdLock(
      (tx) =>
        tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`voice:${channelId}`}))`,
    );
    const joinP = request(http)
      .post('/api/v1/voice/channels/join')
      .set(auth(ghost.token))
      .send({ inviteCode: ch.body.inviteCode })
      .then((r) => r);
    await waitForLockWaiter();
    await deleteAccount(ghost);
    await lock.release();
    const joined = await joinP;

    const members = await request(http)
      .get(`/api/v1/voice/channels/${channelId}/members`)
      .set(auth(owner.token))
      .expect(200);
    const ids = (members.body as Array<{ userId: string; phone: string }>).map(
      (m) => m.userId,
    );
    expect(joined.status).toBe(401);
    expect(ids).not.toContain(ghost.id);
  });

  it('建频道与注销竞态：建频道 401，已注销账号不在任何频道', async () => {
    const u = await newUser();
    const lock = await holdLock(
      (tx) => tx.$executeRaw`LOCK TABLE voice_channels IN SHARE MODE`,
    );
    const createP = request(http)
      .post('/api/v1/voice/channels')
      .set(auth(u.token))
      .send({ name: 'r1 竞态建' })
      .then((r) => r);
    await waitForLockWaiter();
    await deleteAccount(u);
    await lock.release();
    const created = await createP;

    const memberships = await prisma.voiceChannelMember.count({
      where: { userId: u.id },
    });
    expect(created.status).toBe(401);
    expect(memberships).toBe(0);
  });

  it('改头像与注销竞态（注入窗口）：PATCH 401，注销清掉的头像不会被写回', async () => {
    const u = await newUser();
    const avatar = 'data:image/png;base64,iVBORw0KGgo=';
    const originalUpdate = prisma.user.updateMany.bind(prisma.user);
    // 模拟「PATCH 已过守卫、还没写库」时注销提交
    const spy = jest
      .spyOn(prisma.user, 'updateMany')
      .mockImplementationOnce((async (args: unknown) => {
        await deleteAccount(u);
        return originalUpdate(args as never);
      }) as never);
    const patched = await request(http)
      .patch('/api/v1/users/me')
      .set(auth(u.token))
      .send({ avatarUrl: avatar });
    spy.mockRestore();
    const row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(patched.status).toBe(401);
    expect(row.deletedAt).not.toBeNull();
    expect(row.avatarUrl).toBeNull();
  });
});
