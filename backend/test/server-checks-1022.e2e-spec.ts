// 10-22 夜测补的几处服务端校验（上线清单 B 线 23，API.md §1 / §3 / §13）：
// 每账号频道数上限（建 / 加入都算，退出释放）、满员错误带上限值、联系人本人号 / 同号拒绝（已删的不算）、名额错误带上限值。
import 'dotenv/config';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { WsAdapter } from '@nestjs/platform-ws';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { UnifiedExceptionFilter } from '../src/common/http-exception.filter';
import { requestIdMiddleware } from '../src/common/request-id.middleware';
import { PrismaService } from '../src/prisma/prisma.service';
import { registerUser } from './helpers/register';

jest.setTimeout(60000);

const randomPhone = (): string =>
  `19${Math.floor(Math.random() * 1e9)
    .toString()
    .padStart(9, '0')}`;

const CHANNELS = '/api/v1/voice/channels';
const CONTACTS = '/api/v1/users/me/emergency-contacts';

interface User {
  id: string;
  phone: string;
  token: string;
}

describe('服务端校验：频道数上限 / 满员上限值 / 联系人本人号与同号 (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let prisma: PrismaService;
  const userIds: string[] = [];
  const savedEnv: Record<string, string | undefined> = {};

  let a: User;
  let b: User;
  let c: User;
  let d: User;

  const auth = (u: User) => ({ Authorization: `Bearer ${u.token}` });

  beforeAll(async () => {
    for (const k of [
      'VOICE_CHANNELS_PER_USER_LIMIT',
      'VOICE_CHANNEL_MEMBER_LIMIT',
    ]) {
      savedEnv[k] = process.env[k];
    }
    process.env.VOICE_CHANNELS_PER_USER_LIMIT = '2';
    process.env.VOICE_CHANNEL_MEMBER_LIMIT = '2';

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

    const register = async (): Promise<User> => {
      const phone = randomPhone();
      const res = await registerUser(app, http, {
        phone,
        password: 'e2e_password_1',
      });
      userIds.push(res.body.user.id as string);
      return {
        id: res.body.user.id as string,
        phone,
        token: res.body.accessToken as string,
      };
    };
    a = await register();
    b = await register();
    c = await register();
    d = await register();
  });

  afterAll(async () => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await prisma.voiceChannelMember
      .deleteMany({ where: { userId: { in: userIds } } })
      .catch(() => undefined);
    await prisma.voiceChannel
      .deleteMany({ where: { ownerId: { in: userIds } } })
      .catch(() => undefined);
    await prisma.emergencyContact
      .deleteMany({ where: { userId: { in: userIds } } })
      .catch(() => undefined);
    await app.close();
  });

  describe('对讲：每账号频道数上限（env 调成 2）与满员上限值', () => {
    let secondOfA: string;
    let inviteOfB: string;

    it('建两个成功，第三个 409 CHANNEL_LIMIT_REACHED 带 details.limit', async () => {
      await request(http)
        .post(CHANNELS)
        .set(auth(a))
        .send({ name: 'A 一队' })
        .expect(201);
      const second = await request(http)
        .post(CHANNELS)
        .set(auth(a))
        .send({ name: 'A 二队' })
        .expect(201);
      secondOfA = second.body.channelId as string;
      const third = await request(http)
        .post(CHANNELS)
        .set(auth(a))
        .send({ name: 'A 三队' })
        .expect(409);
      expect(third.body.code).toBe('CHANNEL_LIMIT_REACHED');
      expect(third.body.details).toEqual({ limit: 2 });
      expect(third.body.requestId).toMatch(/^req_/);
    });

    it('到上限的账号凭邀请码加入也 409；退出一个后能加入', async () => {
      const chB = await request(http)
        .post(CHANNELS)
        .set(auth(b))
        .send({ name: 'B 队' })
        .expect(201);
      inviteOfB = chB.body.inviteCode as string;
      const blocked = await request(http)
        .post(`${CHANNELS}/join`)
        .set(auth(a))
        .send({ inviteCode: inviteOfB })
        .expect(409);
      expect(blocked.body.code).toBe('CHANNEL_LIMIT_REACHED');
      expect(blocked.body.details).toEqual({ limit: 2 });

      await request(http)
        .delete(`${CHANNELS}/${secondOfA}/membership`)
        .set(auth(a))
        .expect(204);
      const joined = await request(http)
        .post(`${CHANNELS}/join`)
        .set(auth(a))
        .send({ inviteCode: inviteOfB })
        .expect(200);
      expect(joined.body.memberCount).toBe(2);
    });

    it('频道满员（成员上限 env 调成 2）：409 CHANNEL_FULL 带 details.limit', async () => {
      const full = await request(http)
        .post(`${CHANNELS}/join`)
        .set(auth(c))
        .send({ inviteCode: inviteOfB })
        .expect(409);
      expect(full.body.code).toBe('CHANNEL_FULL');
      expect(full.body.details).toEqual({ limit: 2 });
    });
  });

  describe('紧急联系人：本人号、同号、名额上限值', () => {
    let first: string;
    let second: string;

    it('本人手机号 → 400 CONTACT_IS_SELF，不占名额', async () => {
      const res = await request(http)
        .post(CONTACTS)
        .set(auth(d))
        .send({ name: '我自己', phone: d.phone })
        .expect(400);
      expect(res.body.code).toBe('CONTACT_IS_SELF');
      const list = await request(http).get(CONTACTS).set(auth(d)).expect(200);
      expect(list.body).toEqual([]);
    });

    it('同一号码第二次 → 409 CONTACT_DUPLICATE（名字不同也算）', async () => {
      const res = await request(http)
        .post(CONTACTS)
        .set(auth(d))
        .send({ name: '妈妈', phone: '13800001111' })
        .expect(201);
      first = res.body.id as string;
      const dup = await request(http)
        .post(CONTACTS)
        .set(auth(d))
        .send({ name: '妈妈备用', phone: '13800001111' })
        .expect(409);
      expect(dup.body.code).toBe('CONTACT_DUPLICATE');
      const other = await request(http)
        .post(CONTACTS)
        .set(auth(d))
        .send({ name: '爸爸', phone: '13800002222' })
        .expect(201);
      second = other.body.id as string;
    });

    it('改号码：改成别的联系人的号 409、改成本人号 400、保持自己的号 200', async () => {
      const dup = await request(http)
        .patch(`${CONTACTS}/${second}`)
        .set(auth(d))
        .send({ phone: '13800001111' })
        .expect(409);
      expect(dup.body.code).toBe('CONTACT_DUPLICATE');
      const self = await request(http)
        .patch(`${CONTACTS}/${second}`)
        .set(auth(d))
        .send({ phone: d.phone })
        .expect(400);
      expect(self.body.code).toBe('CONTACT_IS_SELF');
      const same = await request(http)
        .patch(`${CONTACTS}/${second}`)
        .set(auth(d))
        .send({ name: '父亲', phone: '13800002222' })
        .expect(200);
      expect(same.body).toMatchObject({ name: '父亲', phone: '13800002222' });
    });

    it('删掉再加回同一个号码可以（已删的不算重复）；第 6 个 409 带 details.limit = 5', async () => {
      await request(http)
        .delete(`${CONTACTS}/${first}`)
        .set(auth(d))
        .expect(204);
      await request(http)
        .post(CONTACTS)
        .set(auth(d))
        .send({ name: '妈妈', phone: '13800001111' })
        .expect(201);
      for (const phone of ['13800003333', '13800004444', '13800005555']) {
        await request(http)
          .post(CONTACTS)
          .set(auth(d))
          .send({ name: `联系人${phone.slice(-4)}`, phone })
          .expect(201);
      }
      const sixth = await request(http)
        .post(CONTACTS)
        .set(auth(d))
        .send({ name: '第六个', phone: '13800006666' })
        .expect(409);
      expect(sixth.body.code).toBe('EMERGENCY_CONTACT_LIMIT_REACHED');
      expect(sixth.body.details).toEqual({ limit: 5 });
    });
  });
});
