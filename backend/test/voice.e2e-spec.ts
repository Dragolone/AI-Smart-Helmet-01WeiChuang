// 对讲后端集成测试（API.md §13）：建/加/退频道、邀请码与满员边界、成员脱敏、
// 进房凭证签发与回环校验、未配置 503、非成员 404。
import 'dotenv/config';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { WsAdapter } from '@nestjs/platform-ws';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { UnifiedExceptionFilter } from '../src/common/http-exception.filter';
import { requestIdMiddleware } from '../src/common/request-id.middleware';
import { PrismaService } from '../src/prisma/prisma.service';
import { verifyUserSig } from '../src/voice/trtc-sig';
import { registerUser } from './helpers/register';

jest.setTimeout(30000);

const randomPhone = (): string =>
  `19${Math.floor(Math.random() * 1e9)
    .toString()
    .padStart(9, '0')}`;

const BASE = '/api/v1/voice/channels';
const TEST_SDK_APP_ID = 1400000042;
const TEST_SECRET = 'e2e_trtc_secret';

describe('网络对讲后端 (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let prisma: PrismaService;

  let ownerToken: string;
  let ownerId: string;
  let memberToken: string;
  let strangerToken: string;
  const userIds: string[] = [];

  let channelId: string;
  let inviteCode: string;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    process.env.TRTC_SDK_APP_ID = String(TEST_SDK_APP_ID);
    process.env.TRTC_SECRET_KEY = TEST_SECRET;
    process.env.TRTC_SIG_EXPIRE_SECONDS = '3600';
    process.env.VOICE_CHANNEL_MEMBER_LIMIT = '3';

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(requestIdMiddleware);
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    app.useGlobalFilters(new UnifiedExceptionFilter());
    app.useWebSocketAdapter(new WsAdapter(app));
    await app.init();
    http = app.getHttpServer();
    prisma = app.get(PrismaService);

    const register = async (): Promise<{ token: string; id: string }> => {
      const res = await registerUser(app, http, {
        phone: randomPhone(),
        password: 'e2e_password_1',
      });
      userIds.push(res.body.user.id as string);
      return {
        token: res.body.accessToken as string,
        id: res.body.user.id as string,
      };
    };
    const owner = await register();
    ownerToken = owner.token;
    ownerId = owner.id;
    memberToken = (await register()).token;
    strangerToken = (await register()).token;
  });

  afterAll(async () => {
    await prisma.voiceChannelMember
      .deleteMany({ where: { userId: { in: userIds } } })
      .catch(() => undefined);
    await prisma.voiceChannel
      .deleteMany({ where: { ownerId: { in: userIds } } })
      .catch(() => undefined);
    await app.close();
  });

  it('建频道：创建者自动入频道、6 位邀请码、数字 roomId；列表可见', async () => {
    const res = await request(http)
      .post(BASE)
      .set(auth(ownerToken))
      .send({ name: '滑雪一队' })
      .expect(201);
    channelId = res.body.channelId as string;
    inviteCode = res.body.inviteCode as string;
    expect(res.body.name).toBe('滑雪一队');
    expect(res.body.ownerId).toBe(ownerId);
    expect(res.body.memberCount).toBe(1);
    // 6 位字母 / 数字，没有 0/1/O/I/L（决策 #57）
    expect(inviteCode).toMatch(/^[2-9A-HJKMNP-Z]{6}$/);
    expect(Number.isInteger(res.body.roomId)).toBe(true);
    // 房间号随机 10 位（决策 #56）：不再是从 1 起的自增号
    expect(res.body.roomId).toBeGreaterThanOrEqual(1_000_000_000);
    expect(res.body.roomId).toBeLessThan(2_147_483_647);

    const list = await request(http)
      .get(BASE)
      .set(auth(ownerToken))
      .expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].channelId).toBe(channelId);
  });

  it('凭码加入：成功、重复加入幂等；错误码 404、格式非法 400', async () => {
    const joined = await request(http)
      .post(`${BASE}/join`)
      .set(auth(memberToken))
      .send({ inviteCode })
      .expect(200);
    expect(joined.body.memberCount).toBe(2);

    const again = await request(http)
      .post(`${BASE}/join`)
      .set(auth(memberToken))
      .send({ inviteCode })
      .expect(200);
    expect(again.body.memberCount).toBe(2); // 幂等不重复计数

    await request(http)
      .post(`${BASE}/join`)
      .set(auth(strangerToken))
      .send({ inviteCode: '000000' })
      .expect(404);
    const bad = await request(http)
      .post(`${BASE}/join`)
      .set(auth(strangerToken))
      // 字母合法了（决策 #57），形状非法改用带符号的
      .send({ inviteCode: 'abc-12' })
      .expect(400);
    expect(bad.body.code).toBe('VALIDATION_FAILED');
  });

  it('满员 → 409 CHANNEL_FULL（上限 env=3）', async () => {
    await request(http)
      .post(`${BASE}/join`)
      .set(auth(strangerToken))
      .send({ inviteCode })
      .expect(200); // 第 3 人

    const fourth = await registerUser(app, http, {
      phone: randomPhone(),
      password: 'e2e_password_1',
    });
    userIds.push(fourth.body.user.id as string);
    const res = await request(http)
      .post(`${BASE}/join`)
      .set(auth(fourth.body.accessToken as string))
      .send({ inviteCode })
      .expect(409);
    expect(res.body.code).toBe('CHANNEL_FULL');
  });

  it('成员列表：仅成员可见、手机号脱敏、入频道先后排序', async () => {
    const res = await request(http)
      .get(`${BASE}/${channelId}/members`)
      .set(auth(memberToken))
      .expect(200);
    expect(res.body).toHaveLength(3);
    expect(res.body[0].userId).toBe(ownerId);
    for (const m of res.body as Array<{ phone: string }>) {
      expect(m.phone).toMatch(/^\d{3}\*{4}\d{4}$/);
    }
  });

  it('进房凭证：字段齐全、UserSig 回环校验通过、expiresAt 匹配时效', async () => {
    const before = Date.now();
    const res = await request(http)
      .post(`${BASE}/${channelId}/token`)
      .set(auth(memberToken))
      .expect(200);
    expect(res.body.sdkAppId).toBe(TEST_SDK_APP_ID);
    expect(typeof res.body.roomId).toBe('number');

    // 回环校验：解开 userSig 重算 HMAC——证明签发实现符合 TLS-Sig-API-v2 规范
    const decoded = verifyUserSig(
      {
        sdkAppId: TEST_SDK_APP_ID,
        secretKey: TEST_SECRET,
        expireSeconds: 3600,
      },
      res.body.userSig as string,
    );
    expect(decoded.identifier).toBe(res.body.userId);
    expect(decoded.expire).toBe(3600);

    const expiresAt = new Date(res.body.expiresAt as string).getTime();
    expect(expiresAt).toBeGreaterThan(before + 3590_000);
    expect(expiresAt).toBeLessThan(before + 3610_000);

    // 房间权限钥匙（决策 #56）：绑这个房间、默认 10 分钟、全权限
    const key = verifyUserSig(
      { sdkAppId: TEST_SDK_APP_ID, secretKey: TEST_SECRET, expireSeconds: 600 },
      res.body.privateMapKey as string,
    );
    expect(key.identifier).toBe(res.body.userId);
    expect(key.room).toMatchObject({
      roomId: res.body.roomId,
      privilegeMap: 255,
    });
    expect(key.room!.expireAt * 1000).toBeGreaterThan(before + 590_000);
    expect(key.room!.expireAt * 1000).toBeLessThan(before + 610_000);
  });

  it('TRTC 未配置 → 503 TRTC_NOT_CONFIGURED（频道功能不受影响）', async () => {
    const saved = process.env.TRTC_SECRET_KEY;
    delete process.env.TRTC_SECRET_KEY;
    const res = await request(http)
      .post(`${BASE}/${channelId}/token`)
      .set(auth(memberToken))
      .expect(503);
    expect(res.body.code).toBe('TRTC_NOT_CONFIGURED');
    process.env.TRTC_SECRET_KEY = saved;

    await request(http)
      .get(`${BASE}/${channelId}/members`)
      .set(auth(memberToken))
      .expect(200);
  });

  it('退出频道：成员数下降、再退 404；退出后取凭证/看成员一律 404', async () => {
    await request(http)
      .delete(`${BASE}/${channelId}/membership`)
      .set(auth(strangerToken))
      .expect(204);
    await request(http)
      .delete(`${BASE}/${channelId}/membership`)
      .set(auth(strangerToken))
      .expect(404);
    await request(http)
      .post(`${BASE}/${channelId}/token`)
      .set(auth(strangerToken))
      .expect(404);
    await request(http)
      .get(`${BASE}/${channelId}/members`)
      .set(auth(strangerToken))
      .expect(404);
  });

  it('非成员与未登录：token/members 404 或 401；建频道入参校验', async () => {
    await request(http).get(BASE).expect(401);
    const res = await request(http)
      .post(BASE)
      .set(auth(ownerToken))
      .send({ name: '' })
      .expect(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
  });
});
