// 对讲频道服务的单测分支：建频道撞码重试 / 耗尽 / 其他错误，加入时锁内复查与唯一约束兜底，成员列表缺用户行，TRTC 未配置。
import {
  ConflictException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { RealtimePushService } from '../realtime/realtime-push.service';
import { verifyUserSig } from './trtc-sig';
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
    $queryRaw: jest.fn(),
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
  // 建频道在事务里写：事务客户端上的 voiceChannel 就用同一组 mock
  Object.assign(tx, { voiceChannel: prisma.voiceChannel });
  const push = { pushVoiceTakenOver: jest.fn() };
  let svc: VoiceService;
  const saved: Record<string, string | undefined> = {};
  const ENV = [
    'VOICE_CHANNEL_MEMBER_LIMIT',
    'TRTC_SDK_APP_ID',
    'TRTC_SECRET_KEY',
    'TRTC_SIG_EXPIRE_SECONDS',
    'TRTC_ROOM_KEY_EXPIRE_SECONDS',
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
    tx.$queryRaw.mockReset().mockResolvedValue([{ deleted_at: null }]);
    push.pushVoiceTakenOver.mockReset();
    svc = new VoiceService(
      prisma as unknown as PrismaService,
      push as unknown as RealtimePushService,
    );
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
    it('写入后发现账号已被注销：401（事务回滚，频道与成员身份都不留）', async () => {
      prisma.voiceChannel.create.mockResolvedValue(channelRow());
      tx.$queryRaw.mockResolvedValue([{ deleted_at: new Date() }]);
      await expect(svc.create('u1', '车队')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(prisma.$transaction).toHaveBeenCalled();
    });

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

    it('锁内发现账号已被注销：401，不计数不插入', async () => {
      tx.$queryRaw.mockResolvedValue([{ deleted_at: new Date() }]);
      const err = await svc.join('u2', 'ABC234').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UnauthorizedException);
      expect(tx.voiceChannelMember.count).not.toHaveBeenCalled();
      expect(tx.voiceChannelMember.create).not.toHaveBeenCalled();
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

  describe('listMine / join 早退 / leave', () => {
    it('listMine：按加入时间倒序，映射成线上格式', async () => {
      prisma.voiceChannelMember.findMany.mockResolvedValue([
        { channel: channelRow({ id: 'a' }) },
        { channel: channelRow({ id: 'b', _count: { members: 3 } }) },
      ]);
      const list = await svc.listMine('u1');
      expect(list.map((c) => [c.channelId, c.memberCount])).toEqual([
        ['a', 1],
        ['b', 3],
      ]);
      expect(prisma.voiceChannelMember.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'u1' },
          orderBy: { joinedAt: 'desc' },
        }),
      );
    });

    it('join：邀请码不存在 → 404，不开事务', async () => {
      prisma.voiceChannel.findUnique.mockResolvedValue(null);
      prisma.$transaction.mockClear();
      await expect(svc.join('u2', 'ZZZZZZ')).rejects.toMatchObject({
        status: 404,
        response: { message: '频道不存在' },
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('join：已经是成员 → 直接幂等返回，不开事务（也不受满员影响）', async () => {
      prisma.voiceChannel.findUnique.mockResolvedValue(channelRow());
      prisma.voiceChannelMember.findUnique.mockResolvedValue({ id: 'm1' });
      prisma.$transaction.mockClear();
      await expect(svc.join('u1', 'ABC234')).resolves.toMatchObject({
        channelId: 'ch1',
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('leave：删到了就成功；不是成员（删了 0 行）→ 404', async () => {
      prisma.voiceChannelMember.deleteMany.mockResolvedValueOnce({ count: 1 });
      await expect(svc.leave('u1', 'ch1')).resolves.toBeUndefined();
      expect(prisma.voiceChannelMember.deleteMany).toHaveBeenCalledWith({
        where: { channelId: 'ch1', userId: 'u1' },
      });
      prisma.voiceChannelMember.deleteMany.mockResolvedValueOnce({ count: 0 });
      await expect(svc.leave('u1', 'ch1')).rejects.toMatchObject({
        status: 404,
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

    it('配置齐全：签发绑定本用户的 UserSig（默认 24h）与只对本房间有效的房间钥匙（默认 10 分钟）', async () => {
      jest.useFakeTimers({ now: new Date('2026-10-16T00:00:00Z') });
      process.env.TRTC_SDK_APP_ID = '1400000000';
      process.env.TRTC_SECRET_KEY = 'fake-secret-for-test';
      const t = await svc.token('u1', 'ch1');
      expect(t).toMatchObject({
        sdkAppId: 1400000000,
        userId: 'u1',
        roomId: 1_234_567_890,
        expiresAt: '2026-10-17T00:00:00.000Z',
      });
      const cfg = {
        sdkAppId: 1400000000,
        secretKey: 'fake-secret-for-test',
        expireSeconds: 86400,
      };
      expect(verifyUserSig(cfg, t.userSig)).toMatchObject({
        identifier: 'u1',
        sdkAppId: 1400000000,
        expire: 86400,
      });
      const key = verifyUserSig(cfg, t.privateMapKey);
      expect(key.room).toMatchObject({ roomId: 1_234_567_890 });
      expect(key.room!.expireAt - key.time).toBe(600);
      jest.useRealTimers();
    });

    it('有效期可由环境变量调', async () => {
      process.env.TRTC_SDK_APP_ID = '1400000000';
      process.env.TRTC_SECRET_KEY = 'k';
      process.env.TRTC_SIG_EXPIRE_SECONDS = '3600';
      process.env.TRTC_ROOM_KEY_EXPIRE_SECONDS = '60';
      const t = await svc.token('u1', 'ch1');
      const cfg = { sdkAppId: 1400000000, secretKey: 'k', expireSeconds: 0 };
      expect(verifyUserSig(cfg, t.userSig).expire).toBe(3600);
      const key = verifyUserSig(cfg, t.privateMapKey);
      expect(key.room!.expireAt - key.time).toBe(60);
    });

    it('非成员：404，不签发', async () => {
      prisma.voiceChannelMember.findUnique.mockResolvedValue(null);
      process.env.TRTC_SDK_APP_ID = '1400000000';
      process.env.TRTC_SECRET_KEY = 'fake-key';
      await expect(svc.token('u9', 'ch1')).rejects.toMatchObject({
        response: { code: 'NOT_FOUND' },
      });
    });

    describe('一个账号只留一台在通话（决策 #62）', () => {
      beforeEach(() => {
        process.env.TRTC_SDK_APP_ID = '1400000000';
        process.env.TRTC_SECRET_KEY = 'k';
      });

      it('enter：通知同账号的连接（带频道与发起方 clientId）', async () => {
        await svc.token('u1', 'ch1', {
          clientId: 'phoneA-1',
          purpose: 'enter',
        });
        expect(push.pushVoiceTakenOver).toHaveBeenCalledWith('u1', {
          channelId: 'ch1',
          clientId: 'phoneA-1',
        });
      });

      it('另一台 enter 之后，先进那台的 renew：409 VOICE_TAKEN_OVER；后进那台 renew 照常', async () => {
        await svc.token('u1', 'ch1', {
          clientId: 'phoneA-1',
          purpose: 'enter',
        });
        await svc.token('u1', 'ch1', {
          clientId: 'phoneB-1',
          purpose: 'enter',
        });
        await expect(
          svc.token('u1', 'ch1', { clientId: 'phoneA-1', purpose: 'renew' }),
        ).rejects.toMatchObject({
          status: 409,
          response: { code: 'VOICE_TAKEN_OVER' },
        });
        await expect(
          svc.token('u1', 'ch1', { clientId: 'phoneB-1', purpose: 'renew' }),
        ).resolves.toMatchObject({ userId: 'u1' });
      });

      it('renew 不通知别的手机；还没人 enter 过（如服务端刚重启）时 renew 照常', async () => {
        await expect(
          svc.token('u1', 'ch1', { clientId: 'phoneA-1', purpose: 'renew' }),
        ).resolves.toMatchObject({ userId: 'u1' });
        expect(push.pushVoiceTakenOver).not.toHaveBeenCalled();
      });

      it('按账号分开：别的账号 enter 不影响本账号 renew', async () => {
        await svc.token('u1', 'ch1', {
          clientId: 'phoneA-1',
          purpose: 'enter',
        });
        await svc.token('u2', 'ch1', {
          clientId: 'phoneC-1',
          purpose: 'enter',
        });
        await expect(
          svc.token('u1', 'ch1', { clientId: 'phoneA-1', purpose: 'renew' }),
        ).resolves.toMatchObject({ userId: 'u1' });
      });

      it('不带请求体（旧包）：照常签发，不通知、不记录，也不会让别的手机 renew 409', async () => {
        await svc.token('u1', 'ch1', {
          clientId: 'phoneA-1',
          purpose: 'enter',
        });
        push.pushVoiceTakenOver.mockClear();
        await svc.token('u1', 'ch1');
        expect(push.pushVoiceTakenOver).not.toHaveBeenCalled();
        await expect(
          svc.token('u1', 'ch1', { clientId: 'phoneA-1', purpose: 'renew' }),
        ).resolves.toMatchObject({ userId: 'u1' });
      });

      it('TRTC 未配置的 enter：503，不记录也不通知（别的手机不能因为一次失败的进房被挤掉）', async () => {
        delete process.env.TRTC_SECRET_KEY;
        await expect(
          svc.token('u1', 'ch1', { clientId: 'phoneB-1', purpose: 'enter' }),
        ).rejects.toMatchObject({ response: { code: 'TRTC_NOT_CONFIGURED' } });
        expect(push.pushVoiceTakenOver).not.toHaveBeenCalled();
      });
    });
  });
});
