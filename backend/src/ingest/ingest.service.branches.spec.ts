// IngestService 的剩余分支：数据库拒绝的三类 Prisma 错误、未知 schemaVersion 的留档降级、危险事件未知 objectType 告警。
import { Logger } from '@nestjs/common';
import { DeviceSnapshotService } from '../devices/device-snapshot.service';
import { Prisma } from '../generated/prisma/client';
import { LocationRecorderService } from '../locations/location-recorder.service';
import { MediaRecorderService } from '../media/media-recorder.service';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimePushService } from '../realtime/realtime-push.service';
import { SosTriggerService } from '../sos/sos-trigger.service';
import { IngestService } from './ingest.service';

const envelope = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    schemaVersion: 1,
    eventId: 'evt-1',
    deviceId: 'helmet_001',
    eventType: 'device_status',
    timestamp: new Date().toISOString(),
    firmwareVersion: '1.0.0',
    payload: { battery: 80 },
    ...over,
  });

const known = (code: string) =>
  new Prisma.PrismaClientKnownRequestError(`err ${code}`, {
    code,
    clientVersion: 'test',
  });

describe('IngestService：剩余分支', () => {
  const create = jest.fn();
  const findUnique = jest.fn();
  const applyEvent = jest.fn();
  const record = jest.fn();
  const handleTrigger = jest.fn();
  const recordMedia = jest.fn();
  const push = {
    pushLocation: jest.fn(),
    pushDeviceStatus: jest.fn(),
    pushRiskEvent: jest.fn(),
    pushDeviceEvent: jest.fn(),
  };
  let service: IngestService;
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    for (const m of [
      create,
      findUnique,
      applyEvent,
      record,
      handleTrigger,
      recordMedia,
      ...Object.values(push),
    ])
      m.mockReset();
    applyEvent.mockResolvedValue(null);
    service = new IngestService(
      { rawEvent: { create, findUnique } } as unknown as PrismaService,
      { applyEvent } as unknown as DeviceSnapshotService,
      { record } as unknown as LocationRecorderService,
      push as unknown as RealtimePushService,
      { handleTrigger } as unknown as SosTriggerService,
      { record: recordMedia } as unknown as MediaRecorderService,
    );
    jest.spyOn(Logger.prototype, 'debug').mockImplementation();
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  /** 第 n 次 create 写进去的 data */
  const createdData = (n: number) =>
    (create.mock.calls[n] as [{ data: Record<string, unknown> }])[0].data;

  describe('数据库拒绝单条数据 → 降级 _invalid 留档', () => {
    it.each([
      [
        'PrismaClientUnknownRequestError',
        () =>
          new Prisma.PrismaClientUnknownRequestError('bad', {
            clientVersion: 'test',
          }),
        'db_rejected_unknown',
      ],
      [
        'PrismaClientValidationError',
        () =>
          new Prisma.PrismaClientValidationError('bad', {
            clientVersion: 'test',
          }),
        'db_rejected_validation',
      ],
      ['P2000（值超列长）', () => known('P2000'), 'db_rejected_P2000'],
    ])(
      '%s：返回 stored_invalid，原因码写进 payload，不分发',
      async (_n, makeErr, reason) => {
        create
          .mockRejectedValueOnce(makeErr())
          .mockResolvedValueOnce({ id: 1 });
        await expect(
          service.ingestRaw(envelope(), 'helmet_001', 'app_relay'),
        ).resolves.toBe('stored_invalid');
        expect(create).toHaveBeenCalledTimes(2);
        expect(createdData(1)).toMatchObject({
          eventType: '_invalid',
          deviceId: 'helmet_001',
          source: 'app_relay',
          payload: expect.objectContaining({ reason }),
        });
        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining(
            `事件入库被数据库拒绝（已按 _invalid 留档）：${reason.replace('db_rejected_', '')}`,
          ),
        );
        expect(applyEvent).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['P1001 连不上库', () => known('P1001')],
      ['普通 Error（连接池耗尽等）', () => new Error('pool timeout')],
    ])(
      '%s：不算「拒绝这条数据」，原样抛出给入口（MQTT 侧据此重试）',
      async (_n, makeErr) => {
        const err = makeErr();
        create.mockRejectedValueOnce(err);
        await expect(
          service.ingestRaw(envelope(), 'helmet_001', 'mqtt'),
        ).rejects.toBe(err);
        expect(create).toHaveBeenCalledTimes(1);
      },
    );
  });

  describe('未知 schemaVersion：只留档不分发', () => {
    it('按原 eventId / eventType 留档，返回 stored_invalid，不进快照', async () => {
      create.mockResolvedValue({ id: 1 });
      await expect(
        service.ingestRaw(
          envelope({ schemaVersion: 2, eventType: 'possible_fall' }),
          'helmet_001',
          'mqtt',
        ),
      ).resolves.toBe('stored_invalid');
      expect(createdData(0)).toMatchObject({
        eventId: 'evt-1',
        eventType: 'possible_fall',
        schemaVersion: 2,
      });
      expect(applyEvent).not.toHaveBeenCalled();
      expect(handleTrigger).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('未知 schemaVersion=2'),
      );
    });

    it('留档被数据库拒绝：再降级为 _invalid（db_rejected_<code>）', async () => {
      create.mockRejectedValueOnce(known('P2000')).mockResolvedValueOnce({});
      await expect(
        service.ingestRaw(
          envelope({ schemaVersion: 3 }),
          'helmet_001',
          'webhook',
        ),
      ).resolves.toBe('stored_invalid');
      expect(createdData(1)).toMatchObject({
        eventType: '_invalid',
        source: 'webhook',
        payload: expect.objectContaining({ reason: 'db_rejected_P2000' }),
      });
    });

    it('留档遇到连接类故障：抛出，不吞', async () => {
      create.mockRejectedValueOnce(known('P1017'));
      await expect(
        service.ingestRaw(envelope({ schemaVersion: 9 }), 'helmet_001', 'mqtt'),
      ).rejects.toThrow('err P1017');
    });

    it('重复的未知版本事件（P2002）：按重复跳过，仍返回 stored_invalid', async () => {
      create.mockRejectedValueOnce(known('P2002'));
      await expect(
        service.ingestRaw(envelope({ schemaVersion: 2 }), 'helmet_001', 'mqtt'),
      ).resolves.toBe('stored_invalid');
      expect(create).toHaveBeenCalledTimes(1);
    });
  });

  describe('危险事件 objectType 数据质量告警', () => {
    const device = { bindUserId: 'u1' };
    const risk = (objectType: unknown) =>
      envelope({
        eventType: 'collision_risk',
        payload: { riskLevel: 'high', objectType },
      });

    beforeEach(() => {
      create.mockResolvedValue({ id: 1 });
      applyEvent.mockResolvedValue(device);
    });

    it('未知 objectType：原样留档 + 告警，照常推送', async () => {
      await expect(
        service.ingestRaw(risk('drone'), 'helmet_001', 'mqtt'),
      ).resolves.toBe('stored');
      expect(warnSpy).toHaveBeenCalledWith(
        '危险事件携带未知 objectType="drone"（已原样留档）：evt-1',
      );
      expect(push.pushRiskEvent).toHaveBeenCalledWith(
        'u1',
        expect.objectContaining({ eventType: 'collision_risk' }),
      );
    });

    it.each([['vehicle'], ['pedestrian'], [42], [undefined]])(
      'objectType=%p（已知值或非字符串）：不告警',
      async (objectType) => {
        await service.ingestRaw(risk(objectType), 'helmet_001', 'mqtt');
        expect(warnSpy).not.toHaveBeenCalledWith(
          expect.stringContaining('未知 objectType'),
        );
        expect(push.pushRiskEvent).toHaveBeenCalledTimes(1);
      },
    );

    it('risk_cleared 同样按危险事件推送；设备未绑定时不推送', async () => {
      await service.ingestRaw(
        envelope({ eventType: 'risk_cleared', payload: {} }),
        'helmet_001',
        'mqtt',
      );
      expect(push.pushRiskEvent).toHaveBeenCalledTimes(1);
      applyEvent.mockResolvedValue({ bindUserId: null });
      await service.ingestRaw(
        envelope({ eventId: 'evt-2', eventType: 'obstacle_risk', payload: {} }),
        'helmet_001',
        'mqtt',
      );
      expect(push.pushRiskEvent).toHaveBeenCalledTimes(1);
    });
  });

  describe('分发：其余事件类型', () => {
    beforeEach(() => {
      create.mockResolvedValue({ id: 1 });
      applyEvent.mockResolvedValue({ bindUserId: 'u1' });
    });

    it('video_ready：写媒体表并按设备事件推送', async () => {
      await service.ingestRaw(
        envelope({ eventType: 'video_ready', payload: { mediaId: 'm1' } }),
        'helmet_001',
        'mqtt',
      );
      expect(recordMedia).toHaveBeenCalledTimes(1);
      expect(push.pushDeviceEvent).toHaveBeenCalledTimes(1);
    });

    it('device_status：推刚刷新过的设备快照；location_update 推位置点；位置不合法（record 返回 null）不推', async () => {
      const snap = { bindUserId: 'u1', battery: 50 };
      applyEvent.mockResolvedValue(snap);
      await service.ingestRaw(envelope(), 'helmet_001', 'mqtt');
      expect(push.pushDeviceStatus).toHaveBeenCalledWith(
        'u1',
        'helmet_001',
        snap,
      );
      record.mockResolvedValueOnce({ latitude: 1 }).mockResolvedValueOnce(null);
      await service.ingestRaw(
        envelope({
          eventId: 'loc-1',
          eventType: 'location_update',
          payload: {},
        }),
        'helmet_001',
        'mqtt',
      );
      expect(push.pushLocation).toHaveBeenCalledWith('u1', 'helmet_001', {
        latitude: 1,
      });
      await service.ingestRaw(
        envelope({
          eventId: 'loc-2',
          eventType: 'location_update',
          payload: {},
        }),
        'helmet_001',
        'mqtt',
      );
      expect(push.pushLocation).toHaveBeenCalledTimes(1);
    });

    it('未列入任何推送集合的类型（如 future_type）：入库但不推送', async () => {
      await expect(
        service.ingestRaw(
          envelope({ eventType: 'future_type' }),
          'helmet_001',
          'mqtt',
        ),
      ).resolves.toBe('stored');
      for (const fn of Object.values(push)) expect(fn).not.toHaveBeenCalled();
    });

    it('入口白名单之外的类型：按 event_type_not_allowed 留档，不分发', async () => {
      await expect(
        service.ingestRaw(envelope(), 'helmet_001', 'app_relay', {
          allowedEventTypes: new Set(['possible_fall']),
        }),
      ).resolves.toBe('stored_invalid');
      expect(createdData(0)).toMatchObject({
        eventType: '_invalid',
        payload: expect.objectContaining({ reason: 'event_type_not_allowed' }),
      });
      expect(applyEvent).not.toHaveBeenCalled();
    });
  });
});
