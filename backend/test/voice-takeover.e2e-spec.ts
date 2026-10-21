// 对讲「一个账号同一时间只留一台在通话」（决策 #62，REGRESSION 6.14）：purpose=enter 经 WS 通知同账号的连接、
// 先进那台续钥匙 409 VOICE_TAKEN_OVER、旧包不带请求体照旧、入参校验。
import 'dotenv/config';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { WsAdapter } from '@nestjs/platform-ws';
import { Test } from '@nestjs/testing';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { WebSocket } from 'ws';
import { AppModule } from '../src/app.module';
import { UnifiedExceptionFilter } from '../src/common/http-exception.filter';
import { requestIdMiddleware } from '../src/common/request-id.middleware';
import { PrismaService } from '../src/prisma/prisma.service';
import { RealtimeGateway } from '../src/realtime/realtime.gateway';
import { waitFor } from './helpers/audit-ingest';
import { registerUser } from './helpers/register';

jest.setTimeout(30000);

const randomPhone = (): string =>
  `19${Math.floor(Math.random() * 1e9)
    .toString()
    .padStart(9, '0')}`;

const BASE = '/api/v1/voice/channels';

interface WsMsg {
  type: string;
  data: { channelId?: string; clientId?: string };
}

describe('对讲同账号只留一台 (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let prisma: PrismaService;
  let wsBase: string;
  const userIds: string[] = [];
  const sockets: WebSocket[] = [];

  let gateway: RealtimeGateway;
  let riderToken: string;
  let riderId: string;
  let friendToken: string;
  let friendId: string;
  let channelId: string;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  /** 服务端登记进推送表的连接数：客户端 open 之后还要查一次库才登记（realtime.gateway handleConnection） */
  const registered = (userId: string): number =>
    (gateway as unknown as { byUser: Map<string, Set<unknown>> }).byUser.get(
      userId,
    )?.size ?? 0;

  /** 同一账号的一条实时连接（一台手机），收到的消息都记下来；等服务端登记好才返回 */
  const connect = async (token: string, userId: string): Promise<WsMsg[]> => {
    const before = registered(userId);
    const ws = new WebSocket(`${wsBase}?token=${encodeURIComponent(token)}`);
    sockets.push(ws);
    const got: WsMsg[] = [];
    ws.on('message', (raw) => {
      got.push(JSON.parse((raw as Buffer).toString('utf-8')) as WsMsg);
    });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    await waitFor(() => registered(userId) > before);
    return got;
  };

  const takeovers = (got: WsMsg[]) =>
    got.filter((m) => m.type === 'voice_taken_over').map((m) => m.data);

  const token = (t: string, body?: Record<string, unknown>) => {
    const req = request(http).post(`${BASE}/${channelId}/token`).set(auth(t));
    return body ? req.send(body) : req;
  };

  beforeAll(async () => {
    process.env.TRTC_SDK_APP_ID = '1400000042';
    process.env.TRTC_SECRET_KEY = 'e2e_trtc_secret';

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
    gateway = app.get(RealtimeGateway);
    await app.listen(0);
    const { port } = http.address() as AddressInfo;
    wsBase = `ws://127.0.0.1:${port}/ws`;

    const register = async (): Promise<[string, string]> => {
      const res = await registerUser(app, http, {
        phone: randomPhone(),
        password: 'e2e_password_1',
      });
      userIds.push(res.body.user.id as string);
      return [res.body.accessToken as string, res.body.user.id as string];
    };
    [riderToken, riderId] = await register();
    [friendToken, friendId] = await register();

    const ch = await request(http)
      .post(BASE)
      .set(auth(riderToken))
      .send({ name: '同号两机' })
      .expect(201);
    channelId = ch.body.channelId as string;
    await request(http)
      .post(`${BASE}/join`)
      .set(auth(friendToken))
      .send({ inviteCode: ch.body.inviteCode as string })
      .expect(200);
  });

  afterAll(async () => {
    for (const ws of sockets) ws.close();
    await prisma.voiceChannelMember
      .deleteMany({ where: { userId: { in: userIds } } })
      .catch(() => undefined);
    await prisma.voiceChannel
      .deleteMany({ where: { ownerId: { in: userIds } } })
      .catch(() => undefined);
    await app.close();
  });

  it('A 进房、B 进房：同账号两条连接都收到通知（带发起方 clientId），别的账号收不到；先进的 A 续钥匙 409，B 续钥匙照常', async () => {
    const phoneA = await connect(riderToken, riderId);
    const phoneB = await connect(riderToken, riderId);
    const friend = await connect(friendToken, friendId);

    await token(riderToken, {
      clientId: 'phoneA-0001',
      purpose: 'enter',
    }).expect(200);
    await waitFor(
      () => takeovers(phoneA).length === 1 && takeovers(phoneB).length === 1,
    );
    expect(takeovers(phoneB)[0]).toEqual({
      channelId,
      clientId: 'phoneA-0001',
    });

    await token(riderToken, {
      clientId: 'phoneB-0001',
      purpose: 'enter',
    }).expect(200);
    await waitFor(() => takeovers(phoneA).length === 2);
    expect(takeovers(phoneA)[1]).toEqual({
      channelId,
      clientId: 'phoneB-0001',
    });

    const renewA = await token(riderToken, {
      clientId: 'phoneA-0001',
      purpose: 'renew',
    }).expect(409);
    expect(renewA.body.code).toBe('VOICE_TAKEN_OVER');
    const renewB = await token(riderToken, {
      clientId: 'phoneB-0001',
      purpose: 'renew',
    }).expect(200);
    expect(typeof renewB.body.privateMapKey).toBe('string');

    // 续钥匙不通知任何人；朋友的账号从头到尾收不到这个账号的接管通知
    await new Promise((r) => setTimeout(r, 200));
    expect(takeovers(phoneA)).toHaveLength(2);
    expect(takeovers(phoneB)).toHaveLength(2);
    expect(takeovers(friend)).toHaveLength(0);
  });

  it('别的账号进房不影响本账号：朋友 enter 后，本账号 B 续钥匙照常', async () => {
    await token(friendToken, {
      clientId: 'friend-0001',
      purpose: 'enter',
    }).expect(200);
    await token(riderToken, {
      clientId: 'phoneB-0001',
      purpose: 'renew',
    }).expect(200);
  });

  it('旧包不带请求体：照常签发', async () => {
    const res = await token(riderToken).expect(200);
    expect(typeof res.body.userSig).toBe('string');
  });

  it.each([
    ['带 purpose 不带 clientId', { purpose: 'enter' }],
    ['clientId 太短', { clientId: 'abc', purpose: 'enter' }],
    ['clientId 含非法字符', { clientId: 'phone A 0001', purpose: 'renew' }],
    ['purpose 不认识', { clientId: 'phoneA-0001', purpose: 'kick' }],
  ])('%s：400 VALIDATION_FAILED', async (_n, body) => {
    const res = await token(riderToken, body).expect(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
  });
});
