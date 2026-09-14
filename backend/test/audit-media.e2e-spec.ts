// 2026-09-13 全面审计 §9 媒体：video_ready 经 webhook 入库的 sizeBytes 边界（2^31 / 2^53±1 / 字符串 / 负数 / 浮点）、
// BigInt 序列化面（事件详情 / 换 URL）、relatedEventId 反查、跨账号 404、预签名 TTL、pending_upload 409、
// 绑定区间过滤（决策 #39）。MockStorage 返回的 URL 只是字符串，不代表对象可访问。
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { PrismaService } from '../src/prisma/prisma.service';
import {
  auth,
  bindDevice,
  buildApp,
  cleanupDevices,
  cleanupUsers,
  createUser,
  envelope,
  provisionDevice,
  sleep,
  type Http,
  type TestUser,
} from './helpers/hardening';
import { postWebhook } from './helpers/audit-voice';

jest.setTimeout(60_000);

const API_KEY = 'audit_0913_webhook_key';

describe('audit-media：媒体元数据与预签名 URL (e2e)', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  const users: TestUser[] = [];
  const devices: string[] = [];
  let owner: TestUser;
  let other: TestUser;
  const deviceA = `audit_media_a_${Date.now()}`;
  const deviceB = `audit_media_b_${Date.now()}`;
  const riskEventId = randomUUID();

  beforeAll(async () => {
    process.env.INGEST_WEBHOOK_API_KEY = API_KEY;
    process.env.MEDIA_URL_TTL_SECONDS = '1';
    ({ app, http, prisma } = await buildApp());
    owner = await createUser(app, http);
    other = await createUser(app, http);
    users.push(owner, other);
    await provisionDevice(prisma, deviceA);
    await provisionDevice(prisma, deviceB);
    devices.push(deviceA, deviceB);
    await bindDevice(http, owner.token, deviceA);
    await bindDevice(http, other.token, deviceB);
    const risk = await postWebhook(
      http,
      API_KEY,
      envelope(
        deviceA,
        'collision_risk',
        { riskLevel: 'high' },
        { eventId: riskEventId },
      ),
    ).expect(202);
    expect(risk.body).toMatchObject({ duplicate: false, invalid: false });
  });

  afterAll(async () => {
    await cleanupDevices(prisma, devices);
    await cleanupUsers(prisma, users);
    await app.close();
  });

  const videoReady = (
    videoId: string,
    extra: Record<string, unknown>,
    deviceId = deviceA,
  ) =>
    postWebhook(
      http,
      API_KEY,
      envelope(deviceId, 'video_ready', {
        videoId,
        storageKey: `mock/${deviceId}/${videoId}.mp4`,
        duration: 10,
        ...extra,
      }),
    );

  describe('sizeBytes 边界（webhook → JSON.parse → MediaRecorder → BigInt 列）', () => {
    it.each<[string, unknown, bigint | null]>([
      ['2^31（int4 溢出点，旧报告 #3 复验）', 2 ** 31, BigInt(2 ** 31)],
      ['2^32', 2 ** 32, BigInt(2 ** 32)],
      [
        '2^53-1（JS 安全上限）',
        Number.MAX_SAFE_INTEGER,
        BigInt(Number.MAX_SAFE_INTEGER),
      ],
      ['2^53+1（JSON.parse 已失真 → 非安全整数 → null）', 2 ** 53 + 1, null],
      ['1e30（浮点整数但非安全 → null）', 1e30, null],
      ['字符串 "123456"', '123456', null],
      ['负数 -1', -1, null],
      ['浮点 1.5', 1.5, null],
      ['0（合法）', 0, BigInt(0)],
    ])('%s', async (_label, sizeBytes, expectedStored) => {
      const videoId = `vid_${randomUUID().slice(0, 8)}`;
      const res = await videoReady(videoId, { sizeBytes }).expect(202);
      expect(res.body.invalid).toBe(false);
      const row = await prisma.media.findUniqueOrThrow({
        where: { deviceId_videoId: { deviceId: deviceA, videoId } },
      });
      expect(row.sizeBytes).toBe(expectedStored);
      expect(row.status).toBe('ready');
      // 序列化面：事件详情（media 数组不含 sizeBytes，BigInt 不会进 JSON）与换 URL 都 200
      const detail = await request(http)
        .get(`/api/v1/events/${row.eventId}`)
        .set(auth(owner.token))
        .expect(200);
      expect(detail.body.media[0]).toEqual({
        mediaId: row.id,
        status: 'ready',
        duration: 10,
      });
      expect(JSON.stringify(detail.body.media)).not.toContain('sizeBytes');
      await request(http)
        .get(`/api/v1/media/${row.id}/url`)
        .set(auth(owner.token))
        .expect(200);
    });

    it('sizeBytes 用原始 JSON 文本 9007199254740993 投递：body-parser 解析后失真为 2^53（静态口径：入口无法识别精确值）', async () => {
      const videoId = `vid_raw_${randomUUID().slice(0, 8)}`;
      const eventId = randomUUID();
      const raw = `{"schemaVersion":1,"eventId":"${eventId}","deviceId":"${deviceA}","eventType":"video_ready","timestamp":"${new Date().toISOString()}","firmwareVersion":"0.1.0-audit","payload":{"videoId":"${videoId}","storageKey":"mock/${deviceA}/${videoId}.mp4","sizeBytes":9007199254740993}}`;
      await request(http)
        .post('/api/v1/ingest/webhook')
        .set('X-Api-Key', API_KEY)
        .set('Content-Type', 'application/json')
        .send(raw)
        .expect(202);
      const row = await prisma.media.findUniqueOrThrow({
        where: { deviceId_videoId: { deviceId: deviceA, videoId } },
      });
      // 2^53 不是安全整数 → 置 null；raw_events 里也只剩失真后的数
      expect(row.sizeBytes).toBeNull();
      const rawEvent = await prisma.rawEvent.findUniqueOrThrow({
        where: { eventId },
      });
      expect(JSON.stringify(rawEvent.payload)).toContain('9007199254740992');
    });

    it('duration 边界：2^31-1 保留、2^31 置 null、负数置 null（媒体行仍入库）', async () => {
      for (const [dur, expected] of [
        [2 ** 31 - 1, 2 ** 31 - 1],
        [2 ** 31, null],
        [-5, null],
      ] as const) {
        const videoId = `vid_dur_${randomUUID().slice(0, 8)}`;
        await videoReady(videoId, { duration: dur }).expect(202);
        const row = await prisma.media.findUniqueOrThrow({
          where: { deviceId_videoId: { deviceId: deviceA, videoId } },
        });
        expect(row.duration).toBe(expected);
      }
    });
  });

  describe('关联反查、跨账号、TTL、pending_upload', () => {
    let ownMediaId: string;
    beforeAll(async () => {
      const videoId = 'vid_related';
      await videoReady(videoId, {
        relatedEventId: riskEventId,
        sizeBytes: 3_000_000_000,
      }).expect(202);
      const row = await prisma.media.findUniqueOrThrow({
        where: { deviceId_videoId: { deviceId: deviceA, videoId } },
      });
      ownMediaId = row.id;
    });

    it('危险事件详情按 relatedEventId 反查到本设备媒体；video_ready 事件自带条目', async () => {
      const detail = await request(http)
        .get(`/api/v1/events/${riskEventId}`)
        .set(auth(owner.token))
        .expect(200);
      expect(
        (detail.body.media as Array<{ mediaId: string }>).some(
          (m) => m.mediaId === ownMediaId,
        ),
      ).toBe(true);
    });

    it('同 videoId 在另一台设备：各自登记（复合唯一 deviceId+videoId）', async () => {
      await videoReady('vid_related', {}, deviceB).expect(202);
      expect(
        await prisma.media.count({
          where: {
            videoId: 'vid_related',
            deviceId: { in: [deviceA, deviceB] },
          },
        }),
      ).toBe(2);
    });

    it('跨账号：他人换 URL 404 且 body 不含 storageKey；他人查本设备事件详情 404', async () => {
      const res = await request(http)
        .get(`/api/v1/media/${ownMediaId}/url`)
        .set(auth(other.token))
        .expect(404);
      expect(res.body.code).toBe('NOT_FOUND');
      expect(JSON.stringify(res.body)).not.toContain('mock/');
      await request(http)
        .get(`/api/v1/events/${riskEventId}`)
        .set(auth(other.token))
        .expect(404);
    });

    it('预签名 TTL=1s：expiresAt ≈ now+1s、Mock URL 的 expires 同步；1.5s 后 expiresAt 已过期（服务端不校验，过期由存储侧执行）', async () => {
      const before = Date.now();
      const res = await request(http)
        .get(`/api/v1/media/${ownMediaId}/url`)
        .set(auth(owner.token))
        .expect(200);
      const expiresAt = new Date(res.body.expiresAt as string).getTime();
      expect(expiresAt).toBeGreaterThanOrEqual(before + 900);
      expect(expiresAt).toBeLessThanOrEqual(before + 2500);
      const url = new URL(res.body.url as string);
      expect(url.hostname).toBe('mock-storage.local'); // Mock：不可访问的占位主机
      const urlExpires = Number(url.searchParams.get('expires')) * 1000;
      expect(Math.abs(urlExpires - expiresAt)).toBeLessThanOrEqual(1500);
      await sleep(1500);
      expect(new Date(res.body.expiresAt as string).getTime()).toBeLessThan(
        Date.now(),
      );
      // 过期后重新换取得到新的 expiresAt（客户端职责：按 expiresAt 重新换）
      const again = await request(http)
        .get(`/api/v1/media/${ownMediaId}/url`)
        .set(auth(owner.token))
        .expect(200);
      expect(
        new Date(again.body.expiresAt as string).getTime(),
      ).toBeGreaterThan(expiresAt);
    });

    it('MEDIA_URL_TTL_SECONDS 非法（abc/0/-1）回落 600s', async () => {
      const saved = process.env.MEDIA_URL_TTL_SECONDS;
      for (const bad of ['abc', '0', '-1']) {
        process.env.MEDIA_URL_TTL_SECONDS = bad;
        const before = Date.now();
        const res = await request(http)
          .get(`/api/v1/media/${ownMediaId}/url`)
          .set(auth(owner.token))
          .expect(200);
        const expiresAt = new Date(res.body.expiresAt as string).getTime();
        expect(expiresAt).toBeGreaterThan(before + 595_000);
        expect(expiresAt).toBeLessThan(before + 605_000);
      }
      process.env.MEDIA_URL_TTL_SECONDS = saved;
    });

    it('storageKey 缺失 / 空串 / 非字符串 → pending_upload，换 URL 409 MEDIA_NOT_READY，响应不含 url', async () => {
      for (const [label, storageKey] of [
        ['缺失', undefined],
        ['空串', ''],
        ['空白', '   '],
        ['数字', 123],
      ] as const) {
        const videoId = `vid_pending_${randomUUID().slice(0, 6)}`;
        await postWebhook(
          http,
          API_KEY,
          envelope(deviceA, 'video_ready', {
            videoId,
            ...(storageKey === undefined ? {} : { storageKey }),
          }),
        ).expect(202);
        const row = await prisma.media.findUniqueOrThrow({
          where: { deviceId_videoId: { deviceId: deviceA, videoId } },
        });
        expect([label, row.status]).toEqual([label, 'pending_upload']);
        expect(row.storageKey).toBeNull();
        const res = await request(http)
          .get(`/api/v1/media/${row.id}/url`)
          .set(auth(owner.token))
          .expect(409);
        expect(res.body.code).toBe('MEDIA_NOT_READY');
        expect(res.body.url).toBeUndefined();
      }
    });

    it('StorageProvider 抛错 → 500 统一格式（不泄露 storageKey）', async () => {
      const storage = app.get<{
        getSignedUrl: (k: string, s: number) => Promise<string>;
      }>('STORAGE_PROVIDER');
      const spy = jest
        .spyOn(storage, 'getSignedUrl')
        .mockRejectedValueOnce(new Error('COS signing failed (simulated)'));
      const res = await request(http)
        .get(`/api/v1/media/${ownMediaId}/url`)
        .set(auth(owner.token));
      spy.mockRestore();
      expect(res.status).toBe(500);
      expect(res.body.code).toBeDefined();
      expect(JSON.stringify(res.body)).not.toContain('mock/');
      expect(JSON.stringify(res.body)).not.toContain('simulated');
    });
  });

  describe('绑定区间过滤（决策 #39）对媒体取 URL 的作用', () => {
    const deviceC = `audit_media_c_${Date.now()}`;
    let earlyMediaId: string;
    let lateMediaId: string;
    let owner2: TestUser;

    beforeAll(async () => {
      await provisionDevice(prisma, deviceC);
      devices.push(deviceC);
      owner2 = await createUser(app, http);
      users.push(owner2);
      // 绑定前登记的媒体
      await videoReady('vid_early', {}, deviceC).expect(202);
      earlyMediaId = (
        await prisma.media.findUniqueOrThrow({
          where: {
            deviceId_videoId: { deviceId: deviceC, videoId: 'vid_early' },
          },
        })
      ).id;
      await sleep(20);
      await bindDevice(http, owner2.token, deviceC);
      await sleep(20);
      await videoReady('vid_late', {}, deviceC).expect(202);
      lateMediaId = (
        await prisma.media.findUniqueOrThrow({
          where: {
            deviceId_videoId: { deviceId: deviceC, videoId: 'vid_late' },
          },
        })
      ).id;
    });

    it('绑定前登记的媒体 404；绑定后登记的 200', async () => {
      await request(http)
        .get(`/api/v1/media/${earlyMediaId}/url`)
        .set(auth(owner2.token))
        .expect(404);
      await request(http)
        .get(`/api/v1/media/${lateMediaId}/url`)
        .set(auth(owner2.token))
        .expect(200);
    });

    it('解绑后 404；同一人重新绑定后旧区间媒体重新可见；换绑他人后新主看不到旧主区间媒体', async () => {
      await request(http)
        .delete(`/api/v1/devices/${deviceC}/binding`)
        .set(auth(owner2.token))
        .expect(204);
      await request(http)
        .get(`/api/v1/media/${lateMediaId}/url`)
        .set(auth(owner2.token))
        .expect(404);
      await sleep(20);
      await bindDevice(http, owner2.token, deviceC);
      await request(http)
        .get(`/api/v1/media/${lateMediaId}/url`)
        .set(auth(owner2.token))
        .expect(200);
      await request(http)
        .delete(`/api/v1/devices/${deviceC}/binding`)
        .set(auth(owner2.token))
        .expect(204);
      await sleep(20);
      await bindDevice(http, other.token, deviceC);
      await request(http)
        .get(`/api/v1/media/${lateMediaId}/url`)
        .set(auth(other.token))
        .expect(404);
      await request(http)
        .get(`/api/v1/media/${earlyMediaId}/url`)
        .set(auth(other.token))
        .expect(404);
    });
  });
});
