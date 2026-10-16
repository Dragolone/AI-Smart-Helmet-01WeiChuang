// video_ready → 媒体表：payload 逐字段校验、有无 storageKey 决定状态、重复宣告幂等、其他失败只告警。
import { Logger } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import type { ValidEnvelope } from '../ingest/envelope';
import type { PrismaService } from '../prisma/prisma.service';
import {
  MediaRecorderService,
  extractMediaPayload,
} from './media-recorder.service';

const env = (payload: Record<string, unknown>): ValidEnvelope => ({
  schemaVersion: 1,
  eventId: 'vid-evt',
  deviceId: 'helmet_001',
  eventType: 'video_ready',
  timestamp: new Date(),
  firmwareVersion: '1.0.0',
  payload,
});

describe('extractMediaPayload', () => {
  it('videoId 缺失 / 空白：null', () => {
    expect(extractMediaPayload({})).toBeNull();
    expect(extractMediaPayload({ videoId: '  ' })).toBeNull();
    expect(extractMediaPayload({ videoId: 7 })).toBeNull();
  });

  it('选填字段非法按缺失处理：负数 / 小数 / 超 int4 的时长、超安全整数的大小、空白 storageKey', () => {
    expect(
      extractMediaPayload({
        videoId: 'v1',
        relatedEventId: '',
        duration: 2_147_483_648,
        sizeBytes: Number.MAX_SAFE_INTEGER + 2,
        storageKey: ' ',
      }),
    ).toEqual({
      videoId: 'v1',
      relatedEventId: null,
      duration: null,
      sizeBytes: null,
      storageKey: null,
    });
    expect(
      extractMediaPayload({ videoId: 'v1', duration: -1, sizeBytes: 1.5 }),
    ).toMatchObject({ duration: null, sizeBytes: null });
  });

  it('合法值原样保留（边界：时长 0 与 int4 上限）', () => {
    expect(
      extractMediaPayload({
        videoId: 'v1',
        relatedEventId: 'fall-1',
        duration: 2_147_483_647,
        sizeBytes: 0,
        storageKey: 'media/helmet_001/v1.mp4',
      }),
    ).toEqual({
      videoId: 'v1',
      relatedEventId: 'fall-1',
      duration: 2_147_483_647,
      sizeBytes: 0,
      storageKey: 'media/helmet_001/v1.mp4',
    });
  });
});

describe('MediaRecorderService.record', () => {
  const create = jest.fn();
  let svc: MediaRecorderService;
  let warnSpy: jest.SpyInstance;
  let debugSpy: jest.SpyInstance;

  beforeEach(() => {
    create.mockReset().mockResolvedValue({});
    svc = new MediaRecorderService({
      media: { create },
    } as unknown as PrismaService);
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    debugSpy = jest.spyOn(Logger.prototype, 'debug').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  it('payload 不合法：不入库，告警', async () => {
    await svc.record(env({ duration: 3 }));
    expect(create).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      'video_ready payload 不合法（缺 videoId），不入媒体表（raw 已留档）：vid-evt',
    );
  });

  it('有 storageKey：status=ready，sizeBytes 转 BigInt', async () => {
    await svc.record(
      env({ videoId: 'v1', sizeBytes: 1024, storageKey: 'media/a.mp4' }),
    );
    expect(create).toHaveBeenCalledWith({
      data: {
        eventId: 'vid-evt',
        deviceId: 'helmet_001',
        videoId: 'v1',
        relatedEventId: null,
        duration: null,
        sizeBytes: BigInt(1024),
        storageKey: 'media/a.mp4',
        status: 'ready',
      },
    });
  });

  it('没有 storageKey：先登记为 pending_upload，sizeBytes 为空就是 null', async () => {
    await svc.record(env({ videoId: 'v1' }));
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: 'pending_upload',
        sizeBytes: null,
      }),
    });
  });

  it('重复宣告（P2002）：静默跳过（debug），不告警', async () => {
    create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('dup', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    await expect(svc.record(env({ videoId: 'v1' }))).resolves.toBeUndefined();
    expect(debugSpy).toHaveBeenCalledWith('重复媒体宣告已跳过：vid-evt');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('其他入库失败：只告警不抛（副表失败不影响主流程）', async () => {
    create.mockRejectedValue(new Error('value out of range'));
    await expect(svc.record(env({ videoId: 'v1' }))).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      '媒体元数据入库失败（raw 已留档）vid-evt：value out of range',
    );
  });
});
