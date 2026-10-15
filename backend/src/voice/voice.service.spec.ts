// 对讲频道服务的单测分支：建频道撞码重试 / 耗尽 / 其他错误，加入时锁内复查与唯一约束兜底，成员列表缺用户行，TRTC 未配置。
import { ConflictException, Logger } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { VoiceService } from './voice.service';

const uniqueErr = () =>
  new Prisma.PrismaClientKnownRequestError('dup', {
    code: 'P2002',
    clientVersion: 'test',
  });

const channelRow = (over: Record<string, unknown> = {}) => ({
  id: 'ch1',
  name: '车队',
  roomId: 1_234_567_890,
  inviteCode: 'ABC234',
  ownerId: 'u1',
  createdAt: new Date('2026-10-16T00:00:00Z'),
  _count: { members: 1 },
  ...over,
});

describe('VoiceService', () => {
  const tx = {
    $executeRaw: jest.fn(),
    voiceChannelMember: {
      findUnique: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
    },
  };
  const prisma = {
    voiceChannel: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
    },
    voiceChannelMember: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      deleteMany: jest.fn(),
    },
    user: { findMany: jest.fn() },
    $transaction: jest.fn((fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  let svc: VoiceService;
  const saved: Record<string, string | undefined> = {};
  const ENV = [
    'VOICE_CHANNEL_MEMBER_LIMIT',
    'TRTC_SDK_APP_ID',
    'TRTC_SECRET_KEY',
  ];

  beforeEach(() => {
    for (const k of ENV) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    for (const group of [
      prisma.voiceChannel,
      prisma.voiceChannelMember,
      prisma.user,
      tx.voiceChannelMember,
    ])
      for (const fn of Object.values(group)) fn.mockReset();
    tx.$executeRaw.mockReset().mockResolvedValue(1);
    svc = new VoiceService(prisma as unknown as PrismaService);
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
  });
  afterEach(() => {
    jest.restoreAllMocks();
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  describe('create', () => {
    it('邀请码 / 房间号撞车（P2002）：换一个重试，第二次成功；房间号落在 [1e9, 2^31)', async () => {
      prisma.voiceChannel.create
        .mockRejectedValueOnce(uniqueErr())
        .mockResolvedValueOnce(channelRow());
      const ch = await svc.create('u1', '车队');
      expect(ch).toEqual({
        channelId: 'ch1',
        name: '车队',
        roomId: 1_234_567_890,
        inviteCode: 'ABC234',
        ownerId: 'u1',
        memberCount: 1,
        createdAt: '2026-10-16T00:00:00.000Z',
      });
      expect(prisma.voiceChannel.create).toHaveBeenCalledTimes(2);
      for (const [arg] of prisma.voiceChannel.create.mock.calls as Array<
        [{ data: { roomId: number; inviteCode: string } }]
      >) {
        expect(arg.data.roomId).toBeGreaterThanOrEqual(1_000_000_000);
        expect(arg.data.roomId).toBeLessThan(2_147_483_647);
        expect(arg.data.inviteCode).toMatch(/^[A-Z0-9]{6}$/);
      }
    });

    it('连撞 5 次：抛「邀请码生成重试耗尽」', async () => {
      prisma.voiceChannel.create.mockRejectedValue(uniqueErr());
      await expect(svc.create('u1', 'x')).rejects.toThrow('邀请码生成重试耗尽');
      expect(prisma.voiceChannel.create).toHaveBeenCalledTimes(5);
    });

    it('非唯一约束错误：不重试，原样抛出', async () => {
      const err = new Error('db down');
      prisma.voiceChannel.create.mockRejectedValue(err);
      await expect(svc.create('u1', 'x')).rejects.toBe(err);
      expect(prisma.voiceChannel.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('join', () => {
    beforeEach(() => {
      prisma.voiceChannel.findUnique.mockResolvedValue(channelRow());
      prisma.voiceChannelMember.findUnique.mockResolvedValue(null);
      prisma.voiceChannel.findUniqueOrThrow.mockResolvedValue(
        channelRow({ _count: { members: 2 } }),
      );
      tx.voiceChannelMember.findUnique.mockResolvedValue(null);
      tx.voiceChannelMember.count.mockResolvedValue(1);
      tx.voiceChannelMember.create.mockResolvedValue({});
    });

    it('邀请码小写 / 易混字符先归一再查', async () => {
      await svc.join('u2', 'abc234');
      expect(prisma.voiceChannel.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { inviteCode: 'ABC234' } }),
      );
    });

    it('锁内复查发现已入座（同一人并发加入的后到者）：幂等返回，不计数不插入', async () => {
      tx.voiceChannelMember.findUnique.mockResolvedValue({ id: 'm1' });
      const ch = await svc.join('u2', 'ABC234');
      expect(tx.voiceChannelMember.count).not.toHaveBeenCalled();
      expect(tx.voiceChannelMember.create).not.toHaveBeenCalled();
      expect(ch.memberCount).toBe(2);
    });

    it('插入撞唯一约束：吞掉按幂等处理，返回最新人数', async () => {
      tx.voiceChannelMember.create.mockRejectedValue(uniqueErr());
      await expect(svc.join('u2', 'ABC234')).resolves.toMatchObject({
        memberCount: 2,
      });
    });

    it('插入遇到其他错误：抛出（事务回滚）', async () => {
      tx.voiceChannelMember.create.mockRejectedValue(new Error('deadlock'));
      await expect(svc.join('u2', 'ABC234')).rejects.toThrow('deadlock');
      expect(prisma.voiceChannel.findUniqueOrThrow).not.toHaveBeenCalled();
    });

    it('人数已到上限（env 调成 2）：409 CHANNEL_FULL，文案带上限', async () => {
      process.env.VOICE_CHANNEL_MEMBER_LIMIT = '2';
      tx.voiceChannelMember.count.mockResolvedValue(2);
      const err = await svc.join('u3', 'ABC234').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).getResponse()).toEqual({
        code: 'CHANNEL_FULL',
        message: '频道成员已达上限 2',
      });
    });
  });

  describe('members', () => {
    it('成员的用户行查不到：昵称 / 头像为 null、手机号空串，其余照常；有用户行的手机号脱敏', async () => {
      prisma.voiceChannelMember.findUnique.mockResolvedValue({
        channel: channelRow(),
      });
      prisma.voiceChannelMember.findMany.mockResolvedValue([
        { userId: 'u1', joinedAt: new Date('2026-10-16T00:00:00Z') },
        { userId: 'ghost', joinedAt: new Date('2026-10-16T00:01:00Z') },
      ]);
      prisma.user.findMany.mockResolvedValue([
        {
          id: 'u1',
          nickname: '老王',
          avatarUrl: null,
          phone: '13800001111',
        },
      ]);
      await expect(svc.members('u1', 'ch1')).resolves.toEqual([
        {
          userId: 'u1',
          nickname: '老王',
          avatarUrl: null,
          phone: '138****1111',
          joinedAt: '2026-10-16T00:00:00.000Z',
        },
        {
          userId: 'ghost',
          nickname: null,
          avatarUrl: null,
          phone: '',
          joinedAt: '2026-10-16T00:01:00.000Z',
        },
      ]);
    });
  });

  describe('token', () => {
    beforeEach(() => {
      prisma.voiceChannelMember.findUnique.mockResolvedValue({
        channel: channelRow(),
      });
    });

    it.each([
      ['都没配', {}],
      ['只有 AppId', { TRTC_SDK_APP_ID: '1400000000' }],
      ['AppId 不是正整数', { TRTC_SDK_APP_ID: '-1', TRTC_SECRET_KEY: 'k' }],
      ['AppId 是小数', { TRTC_SDK_APP_ID: '1.5', TRTC_SECRET_KEY: 'k' }],
    ])('%s：503 TRTC_NOT_CONFIGURED（不装死也不假成功）', async (_n, env) => {
      Object.assign(process.env, env);
      await expect(svc.token('u1', 'ch1')).rejects.toMatchObject({
        response: { code: 'TRTC_NOT_CONFIGURED' },
      });
    });

    it('非成员：404，不签发', async () => {
      prisma.voiceChannelMember.findUnique.mockResolvedValue(null);
      process.env.TRTC_SDK_APP_ID = '1400000000';
      process.env.TRTC_SECRET_KEY = 'fake-key';
      await expect(svc.token('u9', 'ch1')).rejects.toMatchObject({
        response: { code: 'NOT_FOUND' },
      });
    });
  });
});
