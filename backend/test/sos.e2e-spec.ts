// SOS 状态机全路径集成测试（Testing Rules 硬指标）：
// 建单/幂等/合并规则/取消/确认/到期通知/重启接管/通知重试/位置快照回落/归属校验/WS 推送。
// 倒计时与扫描全部用短参数 + 手动 tick 驱动，确定性优先，不赌真实时钟。
import 'dotenv/config';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { WsAdapter } from '@nestjs/platform-ws';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { createHash, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { AppModule } from '../src/app.module';
import { UnifiedExceptionFilter } from '../src/common/http-exception.filter';
import { requestIdMiddleware } from '../src/common/request-id.middleware';
import { IngestService } from '../src/ingest/ingest.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { PUSH_PROVIDER } from '../src/providers/push.provider';
import { SMS_PROVIDER, type SmsMessage } from '../src/providers/sms.provider';
import { SosSchedulerService } from '../src/sos/sos-scheduler.service';
import { registerUser } from './helpers/register';

jest.setTimeout(30000);

const randomPhone = (): string =>
  `19${Math.floor(Math.random() * 1e9)
    .toString()
    .padStart(9, '0')}`;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

interface WsMsg {
  type: string;
  data: Record<string, unknown>;
  sentAt: string;
}

describe('SOS 状态机 (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let prisma: PrismaService;
  let ingest: IngestService;
  let scheduler: SosSchedulerService;
  let wsBase: string;

  const run = Date.now();
  const devMain = `e2e_sos_main_${run}`; // 主流程（owner）
  const devTakeover = `e2e_sos_boot_${run}`; // 重启接管（owner）
  const devUnbound = `e2e_sos_free_${run}`; // 未绑定
  const devRetry = `e2e_sos_retry_${run}`; // 通知重试（userB，单联系人）
  const devEmpty = `e2e_sos_empty_${run}`; // 零联系人 + 无位置快照（userC）
  const allDevices = [devMain, devTakeover, devUnbound, devRetry, devEmpty];

  let ownerToken: string;
  let ownerId: string;
  let otherToken: string;
  let userBToken: string;
  let userCToken: string;
  const userIds: string[] = [];

  const smsMock = { send: jest.fn() };
  const pushMock = { send: jest.fn() };

  let ownerWs: WebSocket;
  const ownerWsMessages: WsMsg[] = [];

  /** 轮询等待 WS 消息到达（本地链路毫秒级，超时即失败） */
  const waitWs = async (
    predicate: (m: WsMsg) => boolean,
    timeoutMs = 3000,
  ): Promise<WsMsg> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = ownerWsMessages.find(predicate);
      if (hit) return hit;
      if (Date.now() > deadline) {
        throw new Error(
          `等待 WS 消息超时；已收到：${JSON.stringify(ownerWsMessages.map((m) => [m.type, m.data.status]))}`,
        );
      }
      await sleep(50);
    }
  };

  const emergencyEnvelope = (
    deviceId: string,
    eventType: 'possible_fall' | 'manual_sos',
    opts: {
      eventId?: string;
      location?: Record<string, unknown> | null;
      timestamp?: string;
    } = {},
  ): string =>
    JSON.stringify({
      schemaVersion: 1,
      eventId: opts.eventId ?? randomUUID(),
      deviceId,
      eventType,
      timestamp: opts.timestamp ?? new Date().toISOString(),
      firmwareVersion: '0.1.0-e2e',
      payload:
        opts.location === null
          ? {}
          : {
              confidence: 0.9,
              location: opts.location ?? {
                latitude: 40.94901,
                longitude: 115.41802,
                coordinateSystem: 'wgs84',
                accuracy: 6,
              },
            },
    });

  const locationEnvelope = (deviceId: string): string =>
    JSON.stringify({
      schemaVersion: 1,
      eventId: randomUUID(),
      deviceId,
      eventType: 'location_update',
      timestamp: new Date().toISOString(),
      firmwareVersion: '0.1.0-e2e',
      payload: {
        latitude: 40.11111,
        longitude: 115.22222,
        coordinateSystem: 'wgs84',
        accuracy: 10,
        speed: 3.2,
        heading: 90,
      },
    });

  beforeAll(async () => {
    // 短倒计时跑全路径；扫描间隔调大 → 全部转换由测试手动 tick 驱动（确定性）
    process.env.SOS_COUNTDOWN_SECONDS = '1';
    process.env.SOS_SCAN_INTERVAL_MS = '600000';
    process.env.SOS_NOTIFY_MAX_ATTEMPTS = '3';
    // 手动 tick 逐轮驱动重试，不等真实退避（退避节奏本身在 sos-reliability 套件里测）
    process.env.SOS_NOTIFY_RETRY_DELAYS_SECONDS = '0';
    smsMock.send.mockResolvedValue(undefined);
    pushMock.send.mockResolvedValue(undefined);

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(SMS_PROVIDER)
      .useValue(smsMock)
      .overrideProvider(PUSH_PROVIDER)
      .useValue(pushMock)
      .compile();
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
    ingest = app.get(IngestService);
    scheduler = app.get(SosSchedulerService);

    await app.listen(0);
    const { port } = http.address() as AddressInfo;
    wsBase = `ws://127.0.0.1:${port}/ws`;

    // bind_code 全局唯一：按设备派生
    const bindCodeOf = (deviceId: string): string => `bc_${deviceId}`;
    for (const deviceId of allDevices) {
      await prisma.device.create({
        data: {
          deviceId,
          deviceSecretHash: createHash('sha256').update('e2e').digest('hex'),
          bindCode: bindCodeOf(deviceId),
        },
      });
    }

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
    otherToken = (await register()).token;
    userBToken = (await register()).token;
    userCToken = (await register()).token;

    const bind = (token: string, deviceId: string): request.Test =>
      request(http)
        .post('/api/v1/devices/bind')
        .set('Authorization', `Bearer ${token}`)
        .send({ deviceId, bindCode: bindCodeOf(deviceId) })
        .expect(200);
    await bind(ownerToken, devMain);
    await bind(ownerToken, devTakeover);
    await bind(userBToken, devRetry);
    await bind(userCToken, devEmpty);

    // owner 三个联系人、其中两个同号 → 通知去重断言用
    const addContact = (
      token: string,
      name: string,
      phone: string,
    ): request.Test =>
      request(http)
        .post('/api/v1/users/me/emergency-contacts')
        .set('Authorization', `Bearer ${token}`)
        .send({ name, phone })
        .expect(201);
    await addContact(ownerToken, '妈妈', '13800001111');
    await addContact(ownerToken, '爸爸', '13800002222');
    await addContact(ownerToken, '妈妈备用', '13800001111');
    await addContact(userBToken, '队友', '13800003333');
    // userC 故意零联系人

    // devMain 预置一条轨迹点：位置快照「回落最新轨迹点」断言用
    await ingest.ingestRaw(locationEnvelope(devMain), devMain, 'mqtt');

    // owner 挂 WS 收全程推送
    ownerWs = new WebSocket(
      `${wsBase}?token=${encodeURIComponent(ownerToken)}`,
    );
    await new Promise<void>((resolve, reject) => {
      ownerWs.once('open', resolve);
      ownerWs.once('error', reject);
    });
    ownerWs.on('message', (raw) => {
      ownerWsMessages.push(
        JSON.parse((raw as Buffer).toString('utf-8')) as WsMsg,
      );
    });
  });

  afterAll(async () => {
    ownerWs?.close();
    await prisma.sosNotification
      .deleteMany({ where: { sos: { deviceId: { in: allDevices } } } })
      .catch(() => undefined);
    await prisma.sosCase
      .deleteMany({ where: { deviceId: { in: allDevices } } })
      .catch(() => undefined);
    await prisma.locationPoint
      .deleteMany({ where: { deviceId: { in: allDevices } } })
      .catch(() => undefined);
    await prisma.rawEvent
      .deleteMany({ where: { deviceId: { in: allDevices } } })
      .catch(() => undefined);
    await prisma.emergencyContact
      .deleteMany({ where: { userId: { in: userIds } } })
      .catch(() => undefined);
    await prisma.device
      .deleteMany({ where: { deviceId: { in: allDevices } } })
      .catch(() => undefined);
    await app.close();
  });

  const activeOf = (token: string, deviceId: string): request.Test =>
    request(http)
      .get(`/api/v1/devices/${deviceId}/sos/active`)
      .set('Authorization', `Bearer ${token}`);

  // ============ 建单与幂等 ============

  it('possible_fall → 建单 pending：deadline 以服务器时间为准（设备时钟偏移 1 小时不影响），快照取自事件', async () => {
    const eventId = randomUUID();
    const before = Date.now();
    await ingest.ingestRaw(
      emergencyEnvelope(devMain, 'possible_fall', {
        eventId,
        // 设备时钟快 1 小时：clock_skew 场景
        timestamp: new Date(before - 3600_000).toISOString(),
      }),
      devMain,
      'mqtt',
    );

    const sosCase = await prisma.sosCase.findUniqueOrThrow({
      where: { triggerEventId: eventId },
    });
    expect(sosCase.status).toBe('pending');
    expect(sosCase.triggerType).toBe('possible_fall');
    // 服务器时间 + 1s（测试倒计时），与设备 timestamp 无关。
    // deadline 出自 JS 时钟、createdAt 出自 DB now()：允许毫秒级偏差；
    // 若误按设备时钟计算，这里会偏出 1 小时量级，区间断言足以拆穿
    const countdown = sosCase.deadline.getTime() - sosCase.createdAt.getTime();
    expect(countdown).toBeGreaterThanOrEqual(900);
    expect(countdown).toBeLessThanOrEqual(1500);
    expect(sosCase.deadline.getTime()).toBeGreaterThan(before);
    // 快照来自事件 payload.location
    expect(sosCase.locationSource).toBe('event');
    expect(sosCase.latitude).toBeCloseTo(40.94901, 5);
    expect(sosCase.accuracy).toBe(6);

    // WS 收到 pending；创建时本人 Push 已发（尽力而为通道）
    const msg = await waitWs(
      (m) => m.type === 'sos_update' && m.data.sosId === sosCase.id,
    );
    expect(msg.data.status).toBe('pending');
    expect(msg.data.deadline).toBe(sosCase.deadline.toISOString());
    expect(pushMock.send).toHaveBeenCalledWith(
      ownerId,
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ sosId: sosCase.id }),
      // iOS：带 App 注册的 "sos" 类别（远程推送上才有「取消」按钮）与时效性
      { category: 'sos', timeSensitive: true },
    );

    // active 返回进行中 SOS
    const active = await activeOf(ownerToken, devMain).expect(200);
    expect(active.body.sos.sosId).toBe(sosCase.id);

    // 同 eventId 重发：Ingest 幂等挡掉，不重复建单
    await ingest.ingestRaw(
      emergencyEnvelope(devMain, 'possible_fall', { eventId }),
      devMain,
      'mqtt',
    );
    // pending 中再来一个新 possible_fall（不同 eventId）：合并规则——只留档不建单
    await ingest.ingestRaw(
      emergencyEnvelope(devMain, 'possible_fall'),
      devMain,
      'mqtt',
    );
    expect(await prisma.sosCase.count({ where: { deviceId: devMain } })).toBe(
      1,
    );
  });

  // ============ 取消路径与归属 ============

  it('取消：非归属用户 404；归属用户成功；终态后再取消/确认 → 409 SOS_ALREADY_FINALIZED', async () => {
    const active = await activeOf(ownerToken, devMain).expect(200);
    const sosId = active.body.sos.sosId as string;

    // 非归属用户：不泄露存在性
    const alien = await request(http)
      .post(`/api/v1/sos/${sosId}/cancel`)
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(404);
    expect(alien.body.code).toBe('NOT_FOUND');

    const cancelled = await request(http)
      .post(`/api/v1/sos/${sosId}/cancel`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(cancelled.body.status).toBe('cancelled');

    const msg = await waitWs(
      (m) =>
        m.type === 'sos_update' &&
        m.data.sosId === sosId &&
        m.data.status === 'cancelled',
    );
    expect(msg.data.status).toBe('cancelled');

    // 取消后：active 为 null（200 + null 定稿口径）；终态不可再操作
    const empty = await activeOf(ownerToken, devMain).expect(200);
    expect(empty.body).toEqual({ sos: null });
    const again = await request(http)
      .post(`/api/v1/sos/${sosId}/cancel`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(409);
    expect(again.body.code).toBe('SOS_ALREADY_FINALIZED');
    await request(http)
      .post(`/api/v1/sos/${sosId}/confirm`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(409);

    // 取消的单没有铺任何通知行
    expect(await prisma.sosNotification.count({ where: { sosId } })).toBe(0);
  });

  // ============ 合并规则：pending 中 manual_sos 升级 ============

  it('终态后新事件建新单；pending 中设备 manual_sos → 立即通知（同号联系人去重）', async () => {
    // 上一单已 cancelled → 新 fall 正常建新单
    const eventId = randomUUID();
    await ingest.ingestRaw(
      emergencyEnvelope(devMain, 'possible_fall', { eventId }),
      devMain,
      'mqtt',
    );
    const fresh = await prisma.sosCase.findUniqueOrThrow({
      where: { triggerEventId: eventId },
    });
    expect(fresh.status).toBe('pending');

    smsMock.send.mockClear();
    // 倒计时中设备端按了实体 SOS 键 → 按 SOS Now 升级，不再等剩余秒数
    await ingest.ingestRaw(
      emergencyEnvelope(devMain, 'manual_sos'),
      devMain,
      'mqtt',
    );

    const escalated = await prisma.sosCase.findUniqueOrThrow({
      where: { id: fresh.id },
    });
    expect(escalated.status).toBe('notified');
    expect(escalated.finalizedAt).not.toBeNull();
    // manual_sos 没有建第二张单
    expect(
      await prisma.sosCase.count({
        where: { deviceId: devMain, status: 'pending' },
      }),
    ).toBe(0);

    // 通知行：3 个联系人、两个同号 → 去重成 2 条 SMS + 1 条本人 Push，全部 sent
    const rows = await prisma.sosNotification.findMany({
      where: { sosId: fresh.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows.map((r) => r.channel).sort()).toEqual(['push', 'sms', 'sms']);
    expect(rows.every((r) => r.status === 'sent' && r.attempts === 1)).toBe(
      true,
    );
    expect(smsMock.send).toHaveBeenCalledTimes(2);
    // 短信内容含触发方式与坐标（给紧急联系人的最小必要信息）
    const [phone, message] = smsMock.send.mock.calls[0] as [string, SmsMessage];
    expect(['13800001111', '13800002222']).toContain(phone);
    expect(message.template).toBe('sos_alert');
    if (message.template !== 'sos_alert') throw new Error('unreachable');
    expect(message.params.locationText).toContain('40.94901');

    await waitWs(
      (m) =>
        m.type === 'sos_update' &&
        m.data.sosId === fresh.id &&
        m.data.status === 'notified',
    );
  });

  // ============ SOS Now（App 端 confirm） ============

  it('confirm → 跳过剩余倒计时立即 notified', async () => {
    const eventId = randomUUID();
    await ingest.ingestRaw(
      emergencyEnvelope(devMain, 'possible_fall', { eventId }),
      devMain,
      'mqtt',
    );
    const sosCase = await prisma.sosCase.findUniqueOrThrow({
      where: { triggerEventId: eventId },
    });

    const res = await request(http)
      .post(`/api/v1/sos/${sosCase.id}/confirm`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(res.body.status).toBe('notified');

    const rows = await prisma.sosNotification.count({
      where: { sosId: sosCase.id, status: 'sent' },
    });
    expect(rows).toBe(3); // 2 sms + 1 push
  });

  // ============ 到期扫描（含重启接管） ============

  it('deadline 到期 → 扫描任务终态化并通知', async () => {
    const eventId = randomUUID();
    await ingest.ingestRaw(
      emergencyEnvelope(devMain, 'possible_fall', { eventId }),
      devMain,
      'mqtt',
    );
    const sosCase = await prisma.sosCase.findUniqueOrThrow({
      where: { triggerEventId: eventId },
    });
    expect(sosCase.status).toBe('pending');

    // 倒计时 1s：未到期先扫一轮 → 不动
    await scheduler.tick();
    expect(
      (await prisma.sosCase.findUniqueOrThrow({ where: { id: sosCase.id } }))
        .status,
    ).toBe('pending');

    await sleep(1100);
    await scheduler.tick();

    const done = await prisma.sosCase.findUniqueOrThrow({
      where: { id: sosCase.id },
    });
    expect(done.status).toBe('notified');
    expect(
      await prisma.sosNotification.count({
        where: { sosId: sosCase.id, status: 'sent' },
      }),
    ).toBe(3);
    await waitWs(
      (m) =>
        m.type === 'sos_update' &&
        m.data.sosId === sosCase.id &&
        m.data.status === 'notified',
    );
  });

  it('重启接管：直接入库一条 deadline 已过的 pending（模拟重启前遗留）→ 扫描即接管通知', async () => {
    // 决策 #8 的恢复机制本体就是「扫描只看数据库」：重启后第一轮 tick 天然捞起遗留单
    const orphan = await prisma.sosCase.create({
      data: {
        deviceId: devTakeover,
        userId: ownerId,
        triggerEventId: randomUUID(),
        triggerType: 'possible_fall',
        status: 'pending',
        deadline: new Date(Date.now() - 5000),
      },
    });

    await scheduler.tick();

    const taken = await prisma.sosCase.findUniqueOrThrow({
      where: { id: orphan.id },
    });
    expect(taken.status).toBe('notified');
    expect(
      await prisma.sosNotification.count({
        where: { sosId: orphan.id, status: 'sent' },
      }),
    ).toBe(3);
  });

  // ============ 通知失败重试 ============

  it('SMS 失败 → failed 留档（attempts/lastError）→ 扫描重试 → 最终 sent', async () => {
    smsMock.send
      .mockRejectedValueOnce(new Error('网关超时'))
      .mockRejectedValueOnce(new Error('网关超时'))
      .mockResolvedValue(undefined);

    const eventId = randomUUID();
    await ingest.ingestRaw(
      emergencyEnvelope(devRetry, 'manual_sos', { eventId }),
      devRetry,
      'mqtt',
    );
    const sosCase = await prisma.sosCase.findUniqueOrThrow({
      where: { triggerEventId: eventId },
    });
    // userB 单联系人 → 1 条 SMS 行
    await request(http)
      .post(`/api/v1/sos/${sosCase.id}/confirm`)
      .set('Authorization', `Bearer ${userBToken}`)
      .expect(200);

    const afterFirst = await prisma.sosNotification.findFirstOrThrow({
      where: { sosId: sosCase.id, channel: 'sms' },
    });
    expect(afterFirst.status).toBe('failed');
    expect(afterFirst.attempts).toBe(1);
    expect(afterFirst.lastError).toContain('网关超时');

    await scheduler.tick(); // 第 2 次：仍失败
    await scheduler.tick(); // 第 3 次：成功
    const finalRow = await prisma.sosNotification.findFirstOrThrow({
      where: { id: afterFirst.id },
    });
    expect(finalRow.status).toBe('sent');
    expect(finalRow.attempts).toBe(3);
    expect(finalRow.sentAt).not.toBeNull();
  });

  it('连续失败达上限 → 终态 failed，后续扫描不再投递', async () => {
    smsMock.send.mockRejectedValue(new Error('永久故障'));

    const orphan = await prisma.sosCase.create({
      data: {
        deviceId: devRetry,
        userId: userIds[2], // userB
        triggerEventId: randomUUID(),
        triggerType: 'manual_sos',
        status: 'pending',
        deadline: new Date(Date.now() - 1000),
      },
    });
    await scheduler.tick(); // 终态化 + 第 1 次投递（失败）
    await scheduler.tick(); // 第 2 次（失败）
    await scheduler.tick(); // 第 3 次（失败，达上限）

    const row = await prisma.sosNotification.findFirstOrThrow({
      where: { sosId: orphan.id, channel: 'sms' },
    });
    expect(row.status).toBe('failed');
    expect(row.attempts).toBe(3);

    smsMock.send.mockClear();
    await scheduler.tick(); // 上限已到：不再尝试
    const after = await prisma.sosNotification.findFirstOrThrow({
      where: { id: row.id },
    });
    expect(after.attempts).toBe(3);
    expect(
      smsMock.send.mock.calls.filter(([p]) => p === '13800003333'),
    ).toHaveLength(0);

    smsMock.send.mockResolvedValue(undefined); // 恢复默认
  });

  // ============ 位置快照回落 ============

  it('payload 无位置 → 回落最新轨迹点；轨迹也没有 → 空快照单照建', async () => {
    // devMain 有预置轨迹点：fall 不带 location → last_point
    const eventId = randomUUID();
    await ingest.ingestRaw(
      emergencyEnvelope(devMain, 'possible_fall', {
        eventId,
        location: null,
      }),
      devMain,
      'mqtt',
    );
    const fromPoint = await prisma.sosCase.findUniqueOrThrow({
      where: { triggerEventId: eventId },
    });
    expect(fromPoint.locationSource).toBe('last_point');
    expect(fromPoint.latitude).toBeCloseTo(40.11111, 5);
    await request(http)
      .post(`/api/v1/sos/${fromPoint.id}/cancel`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);

    // devEmpty 无任何轨迹：空快照，单照建
    const emptyEventId = randomUUID();
    await ingest.ingestRaw(
      emergencyEnvelope(devEmpty, 'possible_fall', {
        eventId: emptyEventId,
        location: null,
      }),
      devEmpty,
      'mqtt',
    );
    const noLoc = await prisma.sosCase.findUniqueOrThrow({
      where: { triggerEventId: emptyEventId },
    });
    expect(noLoc.status).toBe('pending');
    expect(noLoc.latitude).toBeNull();
    expect(noLoc.locationSource).toBeNull();
  });

  // ============ 零联系人 ============

  it('零联系人用户：notified 只有本人 Push 行，短信内容为「位置暂不可用」路径不炸', async () => {
    const active = await activeOf(userCToken, devEmpty).expect(200);
    const sosId = active.body.sos.sosId as string;

    smsMock.send.mockClear();
    await request(http)
      .post(`/api/v1/sos/${sosId}/confirm`)
      .set('Authorization', `Bearer ${userCToken}`)
      .expect(200);

    const rows = await prisma.sosNotification.findMany({
      where: { sosId },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].channel).toBe('push');
    expect(rows[0].status).toBe('sent');
    expect(smsMock.send).not.toHaveBeenCalled();
  });

  // ============ 未绑定设备 ============

  it('未绑定设备的 possible_fall：只留档不建单', async () => {
    await ingest.ingestRaw(
      emergencyEnvelope(devUnbound, 'possible_fall'),
      devUnbound,
      'mqtt',
    );
    expect(
      await prisma.sosCase.count({ where: { deviceId: devUnbound } }),
    ).toBe(0);
    // raw 留档在（未来可人工回放）
    expect(
      await prisma.rawEvent.count({
        where: { deviceId: devUnbound, eventType: 'possible_fall' },
      }),
    ).toBe(1);
  });

  // ============ active 端点归属 ============

  it('active：非绑定用户 404 DEVICE_NOT_FOUND；未登录 401', async () => {
    const res = await activeOf(otherToken, devMain).expect(404);
    expect(res.body.code).toBe('DEVICE_NOT_FOUND');
    await request(http)
      .get(`/api/v1/devices/${devMain}/sos/active`)
      .expect(401);
  });
});
