import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomInt } from 'node:crypto';
import type {
  VoiceChannel as WireChannel,
  VoiceChannelMemberPublic,
  VoiceTokenResponse,
} from '@helmet/shared';
import { envPositiveInt } from '../common/env';
import { isUniqueViolation } from '../common/prisma-errors';
import { Prisma } from '../generated/prisma/client';
import { lockLiveUser } from '../common/live-user';
import { PrismaService } from '../prisma/prisma.service';
import { maskPhone } from '../providers/sms.provider';
import { generateInviteCode, normalizeInviteCode } from './invite-code';
import { genPrivateMapKey, genUserSig } from './trtc-sig';

/** 成员上限（口径 #27⑤：20；env 可调，测试用小值验证满员路径） */
const memberLimit = (): number =>
  envPositiveInt('VOICE_CHANNEL_MEMBER_LIMIT', 20);

const sigExpireSeconds = (): number =>
  envPositiveInt('TRTC_SIG_EXPIRE_SECONDS', 86400);

/**
 * 房间权限钥匙有效期（决策 #56）：进房和断线重连重新进房时校验。App 进房前现取 /token，
 * 在房期间每 5 分钟再取一把交给 SDK（决策 #60），离开房间后最多这么久手里那把就作废
 */
const roomKeyExpireSeconds = (): number =>
  envPositiveInt('TRTC_ROOM_KEY_EXPIRE_SECONDS', 600);

/**
 * 房间号随机 10 位（决策 #56）：自增号可猜，配合不绑房间的 UserSig 就能挨个房间偷听。
 * TRTC 数字房间号上限 4294967294，但列是 int4，取 [1e9, 2^31) 约 11 亿个，撞车走与邀请码同一个重试
 */
const randomRoomId = (): number => randomInt(1_000_000_000, 2_147_483_647);

const channelNotFound = () =>
  new NotFoundException({ code: 'NOT_FOUND', message: '频道不存在' });

type ChannelWithCount = Prisma.VoiceChannelGetPayload<{
  include: { _count: { select: { members: true } } };
}>;

@Injectable()
export class VoiceService {
  private readonly logger = new Logger(VoiceService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** 建频道：创建者自动入频道；6 位字母 / 数字邀请码（决策 #57），撞码重试 */
  async create(userId: string, name: string): Promise<WireChannel> {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const channel = await this.prisma.$transaction(async (tx) => {
          const created = await tx.voiceChannel.create({
            data: {
              name,
              ownerId: userId,
              roomId: randomRoomId(),
              inviteCode: generateInviteCode(),
              members: { create: { userId } },
            },
            include: { _count: { select: { members: true } } },
          });
          // 提交前确认账号还在：否则注销退出全部频道之后，这个频道连同成员身份才写进去
          await lockLiveUser(tx, userId);
          return created;
        });
        return this.toWire(channel);
      } catch (err) {
        if (isUniqueViolation(err)) {
          continue; // 邀请码 / 房间号撞车，换一个重试
        }
        throw err;
      }
    }
    throw new Error('邀请码生成重试耗尽');
  }

  async listMine(userId: string): Promise<WireChannel[]> {
    const memberships = await this.prisma.voiceChannelMember.findMany({
      where: { userId },
      orderBy: { joinedAt: 'desc' },
      include: {
        channel: { include: { _count: { select: { members: true } } } },
      },
    });
    return memberships.map((m) => this.toWire(m.channel));
  }

  /** 凭邀请码加入（大小写不敏感，O/I/L 兜底旧数字码）：满员 409；重复加入幂等返回频道 */
  async join(userId: string, inviteCode: string): Promise<WireChannel> {
    const channel = await this.prisma.voiceChannel.findUnique({
      where: { inviteCode: normalizeInviteCode(inviteCode) },
      include: { _count: { select: { members: true } } },
    });
    if (!channel) throw channelNotFound();

    const existing = await this.prisma.voiceChannelMember.findUnique({
      where: { channelId_userId: { channelId: channel.id, userId } },
    });
    if (existing) return this.toWire(channel);

    // 事务级咨询锁按频道串行化「计数 → 加入」：并发加入不会突破成员上限（TRTC 房间超员）
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`voice:${channel.id}`}))`;
      // 注销同时在进行时，不能让已注销账号成为幽灵成员占名额（审计 VOICE-02 同症状）
      await lockLiveUser(tx, userId);
      // 锁内再查一次成员身份：同一人并发加入时，先到者已入座，后到者必须幂等返回而不是撞名额 409（审计 VOICE-01）
      const alreadyMember = await tx.voiceChannelMember.findUnique({
        where: { channelId_userId: { channelId: channel.id, userId } },
        select: { id: true },
      });
      if (alreadyMember) return;
      const members = await tx.voiceChannelMember.count({
        where: { channelId: channel.id },
      });
      if (members >= memberLimit()) {
        throw new ConflictException({
          code: 'CHANNEL_FULL',
          message: `频道成员已达上限 ${memberLimit()}`,
        });
      }
      try {
        await tx.voiceChannelMember.create({
          data: { channelId: channel.id, userId },
        });
      } catch (err) {
        // 并发重复加入：唯一约束兜底，幂等
        if (!isUniqueViolation(err)) {
          throw err;
        }
      }
    });
    const fresh = await this.prisma.voiceChannel.findUniqueOrThrow({
      where: { id: channel.id },
      include: { _count: { select: { members: true } } },
    });
    return this.toWire(fresh);
  }

  /** 退出频道；频道保留（MVP 不做解散/空频道回收） */
  async leave(userId: string, channelId: string): Promise<void> {
    const deleted = await this.prisma.voiceChannelMember.deleteMany({
      where: { channelId, userId },
    });
    if (deleted.count === 0) throw channelNotFound();
  }

  /** 成员列表（仅成员可见）：手机号脱敏 */
  async members(
    userId: string,
    channelId: string,
  ): Promise<VoiceChannelMemberPublic[]> {
    await this.ensureMember(userId, channelId);
    const members = await this.prisma.voiceChannelMember.findMany({
      where: { channelId },
      orderBy: { joinedAt: 'asc' },
    });
    const users = await this.prisma.user.findMany({
      where: { id: { in: members.map((m) => m.userId) } },
      select: { id: true, nickname: true, avatarUrl: true, phone: true },
    });
    const byId = new Map(users.map((u) => [u.id, u]));
    return members.map((m) => {
      const u = byId.get(m.userId);
      return {
        userId: m.userId,
        nickname: u?.nickname ?? null,
        avatarUrl: u?.avatarUrl ?? null,
        phone: u ? maskPhone(u.phone) : '',
        joinedAt: m.joinedAt.toISOString(),
      };
    });
  }

  /** 进房凭证（仅成员）：UserSig 服务端签发（决策 #27⑥） */
  async token(userId: string, channelId: string): Promise<VoiceTokenResponse> {
    const channel = await this.ensureMember(userId, channelId);

    const sdkAppId = Number(process.env.TRTC_SDK_APP_ID);
    const secretKey = process.env.TRTC_SECRET_KEY;
    if (!Number.isInteger(sdkAppId) || sdkAppId <= 0 || !secretKey) {
      // 个人测试应用 Key 未配置时给明确信号，不装死也不假成功
      throw new ServiceUnavailableException({
        code: 'TRTC_NOT_CONFIGURED',
        message: 'TRTC 凭证未配置（TRTC_SDK_APP_ID / TRTC_SECRET_KEY）',
      });
    }
    const expireSeconds = sigExpireSeconds();
    const userSig = genUserSig({ sdkAppId, secretKey, expireSeconds }, userId);
    // 绑定这一个房间：成员身份在这里校验过，钥匙只对这个房间号有效（决策 #56）
    const privateMapKey = genPrivateMapKey(
      { sdkAppId, secretKey, expireSeconds: roomKeyExpireSeconds() },
      userId,
      channel.roomId,
    );
    this.logger.log(`已签发进房凭证：user=${userId} room=${channel.roomId}`);
    return {
      sdkAppId,
      userId,
      roomId: channel.roomId,
      userSig,
      privateMapKey,
      expiresAt: new Date(Date.now() + expireSeconds * 1000).toISOString(),
    };
  }

  /** 非成员访问一律 404（不泄露频道存在性） */
  private async ensureMember(userId: string, channelId: string) {
    const membership = await this.prisma.voiceChannelMember.findUnique({
      where: { channelId_userId: { channelId, userId } },
      include: { channel: true },
    });
    if (!membership) throw channelNotFound();
    return membership.channel;
  }

  private toWire(c: ChannelWithCount): WireChannel {
    return {
      channelId: c.id,
      name: c.name,
      roomId: c.roomId,
      inviteCode: c.inviteCode,
      ownerId: c.ownerId,
      memberCount: c._count.members,
      createdAt: c.createdAt.toISOString(),
    };
  }
}
