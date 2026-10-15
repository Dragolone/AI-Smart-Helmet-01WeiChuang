// 两个 HTTP 入口控制器（API.md §12 / §12.1）：只做归属 + 计数 / 字段浅取，校验与幂等统一交给 Ingest。
import { NotFoundException } from '@nestjs/common';
import { BLE_RELAY_EVENT_TYPES } from '@helmet/shared';
import type { AuthenticatedRequest } from '../auth/jwt-auth.guard';
import type { PrismaService } from '../prisma/prisma.service';
import { AppRelayController } from './app-relay.controller';
import type { IngestService } from './ingest.service';
import { WebhookController } from './webhook.controller';

const req = { user: { userId: 'u1' } } as AuthenticatedRequest;

describe('AppRelayController', () => {
  const findUnique = jest.fn();
  const ingestRaw = jest.fn();
  const ctl = new AppRelayController(
    { device: { findUnique } } as unknown as PrismaService,
    { ingestRaw } as unknown as IngestService,
  );
  beforeEach(() => {
    findUnique.mockReset().mockResolvedValue({ bindUserId: 'u1' });
    ingestRaw.mockReset();
  });

  it('逐条按顺序交给 Ingest（source=app_relay、蓝牙版 7 种白名单），按结果分别计数', async () => {
    ingestRaw
      .mockResolvedValueOnce('stored')
      .mockResolvedValueOnce('duplicate')
      .mockResolvedValueOnce('stored_invalid')
      .mockResolvedValueOnce('stored');
    const envelopes = [
      { eventId: 'a' },
      { eventId: 'b' },
      'not-an-object',
      { eventId: 'd' },
    ];
    await expect(
      ctl.relay(req, { deviceId: 'helmet_001', envelopes }),
    ).resolves.toEqual({ accepted: 2, duplicate: 1, invalid: 1 });
    expect(ingestRaw.mock.calls.map((c) => (c as [string])[0])).toEqual([
      '{"eventId":"a"}',
      '{"eventId":"b"}',
      '"not-an-object"',
      '{"eventId":"d"}',
    ]);
    const [, deviceId, source, opts] = ingestRaw.mock.calls[0] as [
      string,
      string,
      string,
      { allowedEventTypes: Set<string> },
    ];
    expect(deviceId).toBe('helmet_001');
    expect(source).toBe('app_relay');
    expect([...opts.allowedEventTypes].sort()).toEqual(
      [...BLE_RELAY_EVENT_TYPES].sort(),
    );
  });

  it('设备不归本人：404，一条都不入库', async () => {
    findUnique.mockResolvedValue({ bindUserId: 'u2' });
    await expect(
      ctl.relay(req, { deviceId: 'helmet_001', envelopes: [{}] }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(ingestRaw).not.toHaveBeenCalled();
  });

  it('中途某条入库抛错（数据库故障）：整批抛出（App 会按原 eventId 重传，幂等兜底）', async () => {
    ingestRaw
      .mockResolvedValueOnce('stored')
      .mockRejectedValueOnce(new Error('db down'));
    await expect(
      ctl.relay(req, {
        deviceId: 'helmet_001',
        envelopes: [{}, {}, {}],
      }),
    ).rejects.toThrow('db down');
    expect(ingestRaw).toHaveBeenCalledTimes(2);
  });
});

describe('WebhookController', () => {
  const ingestRaw = jest.fn();
  const ctl = new WebhookController({ ingestRaw } as unknown as IngestService);
  beforeEach(() => ingestRaw.mockReset().mockResolvedValue('stored'));

  it('从 envelope 浅取 deviceId / eventId 作外层来源，原文 JSON 交给 Ingest（source=webhook）', async () => {
    const body = {
      deviceId: 'helmet_001',
      eventId: 'e1',
      eventType: 'collision_risk',
    };
    await expect(ctl.webhook(body)).resolves.toEqual({
      eventId: 'e1',
      duplicate: false,
      invalid: false,
    });
    expect(ingestRaw).toHaveBeenCalledWith(
      JSON.stringify(body),
      'helmet_001',
      'webhook',
    );
  });

  it('重复 / 校验失败：只在响应里标出来，不报错', async () => {
    ingestRaw.mockResolvedValueOnce('duplicate');
    await expect(
      ctl.webhook({ deviceId: 'd', eventId: 'e' }),
    ).resolves.toMatchObject({
      duplicate: true,
      invalid: false,
    });
    ingestRaw.mockResolvedValueOnce('stored_invalid');
    await expect(ctl.webhook({})).resolves.toEqual({
      eventId: null,
      duplicate: false,
      invalid: true,
    });
  });

  it.each([
    ['请求体为空（非 JSON Content-Type）', undefined, ''],
    ['请求体是 null', null, 'null'],
    ['请求体是数组', [1], '[1]'],
    [
      'deviceId / eventId 不是字符串',
      { deviceId: 1, eventId: 2 },
      '{"deviceId":1,"eventId":2}',
    ],
  ])(
    '%s：deviceId 记 unknown、eventId=null，原文照交 Ingest 留档',
    async (_n, body, raw) => {
      ingestRaw.mockResolvedValue('stored_invalid');
      await expect(ctl.webhook(body)).resolves.toMatchObject({
        eventId: null,
        invalid: true,
      });
      expect(ingestRaw).toHaveBeenCalledWith(raw, 'unknown', 'webhook');
    },
  );
});
