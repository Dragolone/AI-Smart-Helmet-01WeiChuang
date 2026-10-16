// EMQX 认证的 clientId 规则（审计 MQTT-01）：后端保留的 clientId 只允许服务账号用，服务账号也只能用保留 clientId，
// 否则持有一台设备密钥的人就能用消费者的 clientId 把后端顶下线。
import { Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { PrismaService } from '../prisma/prisma.service';
import { EmqxHookService } from './emqx-hook.service';

describe('EmqxHookService.authenticate：clientId 规则', () => {
  const findUnique = jest.fn();
  let svc: EmqxHookService;
  let warnSpy: jest.SpyInstance;
  const ENV = [
    'MQTT_BACKEND_USERNAME',
    'MQTT_BACKEND_PASSWORD',
    'MQTT_BACKEND_CLIENT_ID',
  ];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV) saved[k] = process.env[k];
    process.env.MQTT_BACKEND_USERNAME = 'svc';
    process.env.MQTT_BACKEND_PASSWORD = 'svc_pass';
    process.env.MQTT_BACKEND_CLIENT_ID = 'backend_cid';
    findUnique.mockReset().mockResolvedValue({
      deviceSecretHash: createHash('sha256').update('dev_secret').digest('hex'),
    });
    svc = new EmqxHookService({
      device: { findUnique },
    } as unknown as PrismaService);
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });
  afterEach(() => {
    jest.restoreAllMocks();
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('服务账号 + 保留 clientId + 正确密码：allow（超级用户）', async () => {
    await expect(
      svc.authenticate('svc', 'svc_pass', 'backend_cid'),
    ).resolves.toEqual({ result: 'allow', is_superuser: true });
  });

  it('服务账号用了别的 clientId：即使密码正确也 deny，并告警', async () => {
    await expect(
      svc.authenticate('svc', 'svc_pass', 'random_cid'),
    ).resolves.toEqual({ result: 'deny' });
    expect(warnSpy).toHaveBeenCalledWith(
      'MQTT 认证拒绝：服务账号使用了非保留 clientId（random_cid）',
    );
  });

  it('设备密钥正确但想用后端保留 clientId：deny，不查库', async () => {
    await expect(
      svc.authenticate('helmet_001', 'dev_secret', 'backend_cid'),
    ).resolves.toEqual({ result: 'deny' });
    expect(findUnique).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      'MQTT 认证拒绝：设备 helmet_001 试图使用后端保留的 clientId',
    );
  });

  it('设备用自己的 clientId：按密钥判定', async () => {
    await expect(
      svc.authenticate('helmet_001', 'dev_secret', 'helmet_001'),
    ).resolves.toEqual({ result: 'allow' });
  });

  it('服务账号密码未配置（空）：一律 deny，空密码也撞不进来', async () => {
    process.env.MQTT_BACKEND_PASSWORD = '';
    await expect(svc.authenticate('svc', 'x', 'backend_cid')).resolves.toEqual({
      result: 'deny',
    });
  });

  describe('authorize', () => {
    it.each([
      [undefined, 'helmet/helmet_001/event', 'publish'],
      ['helmet_001', undefined, 'publish'],
      ['helmet_001', 'helmet/helmet_001/event', undefined],
    ])('缺参数（username=%p topic=%p action=%p）：deny', (u, t, a) => {
      expect(svc.authorize(u, t, a)).toEqual({ result: 'deny' });
    });

    it('设备：只能发自己的上行叶子、订阅自己的 cmd；其余一律 deny 并告警', () => {
      for (const leaf of ['status', 'location', 'event', 'cmd_ack']) {
        expect(
          svc.authorize('helmet_001', `helmet/helmet_001/${leaf}`, 'publish'),
        ).toEqual({
          result: 'allow',
        });
      }
      expect(
        svc.authorize('helmet_001', 'helmet/helmet_001/cmd', 'subscribe'),
      ).toEqual({
        result: 'allow',
      });
      expect(
        svc.authorize('helmet_001', 'helmet/helmet_001/cmd', 'publish'),
      ).toEqual({
        result: 'deny',
      });
      expect(
        svc.authorize('helmet_001', 'helmet/helmet_001/event', 'subscribe'),
      ).toEqual({
        result: 'deny',
      });
      expect(
        svc.authorize('helmet_001', 'helmet/helmet_002/event', 'publish'),
      ).toEqual({
        result: 'deny',
      });
      expect(svc.authorize('helmet_001', 'other/topic', 'publish')).toEqual({
        result: 'deny',
      });
      expect(warnSpy).toHaveBeenCalledWith(
        'MQTT 越权拒绝：helmet_001 → publish helmet/helmet_002/event',
      );
    });

    it('服务账号：任意 Topic 放行', () => {
      expect(svc.authorize('svc', 'helmet/+/event', 'subscribe')).toEqual({
        result: 'allow',
      });
    });
  });
});
