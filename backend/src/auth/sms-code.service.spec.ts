import { Test } from '@nestjs/testing';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { SMS_PROVIDER, type SmsMessage } from '../providers/sms.provider';
import { SmsCodeService } from './sms-code.service';

const hash = (code: string, salt: string): string =>
  createHash('sha256').update(`${salt}:${code}`).digest('hex');

describe('SmsCodeService（单测，mock 数据层与短信通道）', () => {
  const prismaMock = {
    // issue() 在事务内持咨询锁（审计 AUTH-04）：单测里事务回调直接拿到同一个 mock
    $executeRaw: jest.fn(),
    $transaction: jest.fn(),
    smsCode: {
      findFirst: jest.fn(),
      count: jest.fn(),
      deleteMany: jest.fn(),
      create: jest.fn(),
      delete: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
  };
  const smsMock = { send: jest.fn() };
  let service: SmsCodeService;

  beforeEach(async () => {
    jest.resetAllMocks();
    jest.useRealTimers();
    delete process.env.SMS_CODE_RESEND_INTERVAL_SECONDS;
    delete process.env.SMS_CODE_DAILY_LIMIT;
    delete process.env.SMS_SEND_TIMEOUT_MS;
    prismaMock.$executeRaw.mockResolvedValue(1);
    prismaMock.$transaction.mockImplementation(
      (fn: (tx: typeof prismaMock) => Promise<unknown>) => fn(prismaMock),
    );
    prismaMock.smsCode.count.mockResolvedValue(0);
    prismaMock.smsCode.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock.smsCode.create.mockResolvedValue({ id: 'c1' });
    smsMock.send.mockResolvedValue(undefined);
    const moduleRef = await Test.createTestingModule({
      providers: [
        SmsCodeService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: SMS_PROVIDER, useValue: smsMock },
      ],
    }).compile();
    service = moduleRef.get(SmsCodeService);
  });

  it('issue：生成 6 位数字码，库存哈希不存明文，短信收到明文', async () => {
    prismaMock.smsCode.findFirst.mockResolvedValue(null);
    await service.issue('13800138000', 'register');
    const created = prismaMock.smsCode.create.mock.calls[0][0].data as {
      codeHash: string;
      salt: string;
      expiresAt: Date;
    };
    const [phone, message] = smsMock.send.mock.calls[0] as [string, SmsMessage];
    expect(phone).toBe('13800138000');
    expect(message.template).toBe('verify_code');
    if (message.template !== 'verify_code') throw new Error('unreachable');
    expect(message.params.code).toMatch(/^\d{6}$/);
    expect(created.codeHash).toBe(hash(message.params.code, created.salt));
    expect(created.codeHash).not.toContain(message.params.code);
    expect(created.expiresAt.getTime()).toBeGreaterThan(Date.now() + 290_000);
  });

  it('issue：事务内先按「用途+号码」取咨询锁再查写（并发发码只放行一条，审计 AUTH-04）；短信在事务外发', async () => {
    prismaMock.smsCode.findFirst.mockResolvedValue(null);
    await service.issue('13800138000', 'register');
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    const lockSql = prismaMock.$executeRaw.mock
      .calls[0][0] as TemplateStringsArray;
    expect(lockSql.join('?')).toContain('pg_advisory_xact_lock');
    expect(prismaMock.$executeRaw.mock.calls[0][1]).toBe(
      'sms:register:13800138000',
    );
    const order = (fn: jest.Mock) => fn.mock.invocationCallOrder[0];
    expect(order(prismaMock.$executeRaw)).toBeLessThan(
      order(prismaMock.smsCode.findFirst),
    );
    expect(order(prismaMock.smsCode.create)).toBeLessThan(order(smsMock.send));
  });

  it('issue：短信通道挂起 → SMS_SEND_TIMEOUT_MS 后按失败处理：删记录 + 503（不占 60s 限频，审计 AUTH-11）', async () => {
    jest.useFakeTimers();
    process.env.SMS_SEND_TIMEOUT_MS = '2000';
    prismaMock.smsCode.findFirst.mockResolvedValue(null);
    smsMock.send.mockReturnValue(new Promise<void>(() => undefined)); // 永不 resolve
    const pending = service.issue('13800138000', 'register');
    const assertion = expect(pending).rejects.toMatchObject({
      response: { code: 'SMS_SEND_FAILED' },
      status: 503,
    });
    await jest.advanceTimersByTimeAsync(2_001);
    await assertion;
    expect(prismaMock.smsCode.delete).toHaveBeenCalledWith({
      where: { id: 'c1' },
    });
  });

  it('issue：60s 内重发 → 429 SMS_CODE_TOO_FREQUENT，不发短信', async () => {
    prismaMock.smsCode.findFirst.mockResolvedValue({
      createdAt: new Date(Date.now() - 10_000),
    });
    await expect(
      service.issue('13800138000', 'register'),
    ).rejects.toMatchObject({
      response: { code: 'SMS_CODE_TOO_FREQUENT' },
      status: 429,
    });
    expect(smsMock.send).not.toHaveBeenCalled();
  });

  it('issue：日上限 → 429 SMS_CODE_DAILY_LIMIT', async () => {
    prismaMock.smsCode.findFirst.mockResolvedValue(null);
    prismaMock.smsCode.count.mockResolvedValue(10);
    await expect(
      service.issue('13800138000', 'register'),
    ).rejects.toMatchObject({
      response: { code: 'SMS_CODE_DAILY_LIMIT' },
      status: 429,
    });
  });

  it('issue：短信通道失败 → 删掉记录并 503 SMS_SEND_FAILED（不占用限频）', async () => {
    prismaMock.smsCode.findFirst.mockResolvedValue(null);
    smsMock.send.mockRejectedValue(new Error('网关超时'));
    await expect(
      service.issue('13800138000', 'register'),
    ).rejects.toMatchObject({
      response: { code: 'SMS_SEND_FAILED' },
      status: 503,
    });
    expect(prismaMock.smsCode.delete).toHaveBeenCalledWith({
      where: { id: 'c1' },
    });
  });

  const row = (over: Partial<Record<string, unknown>> = {}) => ({
    id: 'c1',
    salt: 'abcd',
    codeHash: hash('123456', 'abcd'),
    expiresAt: new Date(Date.now() + 60_000),
    attempts: 0,
    consumedAt: null,
    ...over,
  });

  it('verify：正确 → 条件更新消费；并发第二次消费失败', async () => {
    prismaMock.smsCode.findFirst.mockResolvedValue(row());
    prismaMock.smsCode.updateMany.mockResolvedValueOnce({ count: 1 });
    await expect(
      service.verifyAndConsume('13800138000', 'register', '123456'),
    ).resolves.toBeUndefined();
    expect(prismaMock.smsCode.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'c1', consumedAt: null } }),
    );
    prismaMock.smsCode.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      service.verifyAndConsume('13800138000', 'register', '123456'),
    ).rejects.toMatchObject({ response: { code: 'SMS_CODE_INVALID' } });
  });

  it('verify：错误码 → attempts+1 并 SMS_CODE_INVALID', async () => {
    prismaMock.smsCode.findFirst.mockResolvedValue(row());
    await expect(
      service.verifyAndConsume('13800138000', 'register', '654321'),
    ).rejects.toMatchObject({ response: { code: 'SMS_CODE_INVALID' } });
    expect(prismaMock.smsCode.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { attempts: { increment: 1 } } }),
    );
    expect(prismaMock.smsCode.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    ['不存在', null],
    ['已过期', row({ expiresAt: new Date(Date.now() - 1) })],
    ['已消费', row({ consumedAt: new Date() })],
    ['超过 5 次错误', row({ attempts: 5 })],
  ])(
    'verify：%s → SMS_CODE_INVALID（同一错误码，不给探测信息）',
    async (_, r) => {
      prismaMock.smsCode.findFirst.mockResolvedValue(r);
      await expect(
        service.verifyAndConsume('13800138000', 'register', '123456'),
      ).rejects.toMatchObject({ response: { code: 'SMS_CODE_INVALID' } });
      expect(prismaMock.smsCode.updateMany).not.toHaveBeenCalled();
    },
  );
});
