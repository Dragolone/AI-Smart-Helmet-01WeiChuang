import { Test } from '@nestjs/testing';
import { createHash } from 'node:crypto';
import { EmqxHookService } from './emqx-hook.service';
import { PrismaService } from '../prisma/prisma.service';

describe('EmqxHookService（认证与 Topic 授权）', () => {
  const findUnique = jest.fn();
  let service: EmqxHookService;

  beforeEach(async () => {
    jest.resetAllMocks();
    process.env.MQTT_BACKEND_USERNAME = 'backend_ingest';
    process.env.MQTT_BACKEND_PASSWORD = 'svc_pass';
    const moduleRef = await Test.createTestingModule({
      providers: [
        EmqxHookService,
        { provide: PrismaService, useValue: { device: { findUnique } } },
      ],
    }).compile();
    service = moduleRef.get(EmqxHookService);
  });

  describe('authenticate', () => {
    it('服务账号密码正确 → allow；错误 → deny', async () => {
      await expect(
        service.authenticate('backend_ingest', 'svc_pass'),
      ).resolves.toEqual({ result: 'allow' });
      await expect(
        service.authenticate('backend_ingest', 'wrong'),
      ).resolves.toEqual({ result: 'deny' });
    });

    it('设备密钥正确 → allow', async () => {
      findUnique.mockResolvedValue({
        deviceSecretHash: createHash('sha256').update('secret1').digest('hex'),
      });
      await expect(
        service.authenticate('helmet_001', 'secret1'),
      ).resolves.toEqual({ result: 'allow' });
    });

    it('设备密钥错误 / 未知设备 / 缺参数 → deny', async () => {
      findUnique.mockResolvedValue({
        deviceSecretHash: createHash('sha256').update('secret1').digest('hex'),
      });
      await expect(
        service.authenticate('helmet_001', 'wrong'),
      ).resolves.toEqual({ result: 'deny' });

      findUnique.mockResolvedValue(null);
      await expect(service.authenticate('ghost', 'whatever')).resolves.toEqual({
        result: 'deny',
      });

      await expect(service.authenticate(undefined, 'x')).resolves.toEqual({
        result: 'deny',
      });
    });
  });

  describe('authorize', () => {
    it('设备发布自己的合法叶子 → allow', () => {
      for (const leaf of ['status', 'location', 'event', 'cmd_ack']) {
        expect(
          service.authorize(
            'helmet_001',
            `helmet/helmet_001/${leaf}`,
            'publish',
          ),
        ).toEqual({ result: 'allow' });
      }
    });

    it('跨设备 Topic → deny（防伪装串号）', () => {
      expect(
        service.authorize('helmet_001', 'helmet/helmet_002/event', 'publish'),
      ).toEqual({ result: 'deny' });
    });

    it('设备订阅自己的 cmd → allow；订阅别的 → deny', () => {
      expect(
        service.authorize('helmet_001', 'helmet/helmet_001/cmd', 'subscribe'),
      ).toEqual({ result: 'allow' });
      expect(
        service.authorize('helmet_001', 'helmet/+/event', 'subscribe'),
      ).toEqual({ result: 'deny' });
    });

    it('设备发布 cmd（下行专用）→ deny', () => {
      expect(
        service.authorize('helmet_001', 'helmet/helmet_001/cmd', 'publish'),
      ).toEqual({ result: 'deny' });
    });

    it('服务账号任意 Topic → allow', () => {
      expect(
        service.authorize('backend_ingest', 'helmet/+/event', 'subscribe'),
      ).toEqual({ result: 'allow' });
    });
  });
});
