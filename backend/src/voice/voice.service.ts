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
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { maskPhone } from '../providers/sms.provider';
import { genUserSig } from './trtc-sig';

/** 成员上限（口径 #27⑤：20；env 可调，测试用小值验证满员路径） */
const memberLimit = (): number => {
  const n = Number(process.env.VOICE_CHANNEL_MEMBER_LIMIT);
  return Number.isInteger(n) && n > 0 ? n : 20;
};

const sigExpireSeconds = (): number => {
  const n = Number(process.env.TRTC_SIG_EXPIRE_SECONDS);
  return Number.isInteger(n) && n > 0 ? n : 86400;
};

const channelNotFound = () =>
  new NotFoundException({ code: 'NOT_FOUND', message: '频道不存在' });

type ChannelWithCount = Prisma.VoiceChannelGetPayload<{
  include: { _count: { select: { members: true } } };
}>;

@Injectable()
export class VoiceService {
  private readonly logger = new Logger(VoiceService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** 建频道：创建者自动入频道；6 位邀请码，撞码重试 */
  async create(userId: string, name: string): Promise<WireChannel> {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const channel = await this.prisma.voiceChannel.create({
          data: {
            name,
            ownerId: userId,
            inviteCode: String(randomInt(100_000, 1_000_000)),
            members: { create: { userId } },
          },
          include: { _count: { select: { members: true } } },
        });
        return this.toWire(channel);
      } catch (err) {
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2002'
        ) {
          continue; // 邀请码撞车，换一个重试
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

  /** 凭邀请码加入：满员 409；重复加入幂等返回频道 */
  async join(userId: string, inviteCode: string): Promise<WireChannel> {
    const channel = await this.prisma.voiceChannel.findUnique({
      where: { inviteCode },
      include: { _count: { select: { members: true } } },
    });
    if (!channel) throw channelNotFound();

    const existing = await this.prisma.voiceChannelMember.findUnique({
      where: { channelId_userId: { channelId: channel.id, userId } },
    });
    if (existing) return this.toWire(channel);

    if (channel._count.members >= memberLimit()) {
      throw new ConflictException({
        code: 'CHANNEL_FULL',
        message: `频道成员已达上限 ${memberLimit()}`,
      });
    }
    try {
      await this.prisma.voiceChannelMember.create({
        data: { channelId: channel.id, userId },
      });
    } catch (err) {
      // 并发重复加入：唯一约束兜底，幂等
      if (!(
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      )) {
        throw err;
      }
    }
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
      select: { id: true, nickname: true, phone: true },
    });
    const byId = new Map(users.map((u) => [u.id, u]));
    return members.map((m) => {
      const u = byId.get(m.userId);
      return {
        userId: m.userId,
        nickname: u?.nickname ?? null,
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
    this.logger.log(`已签发进房凭证：user=${userId} room=${channel.roomId}`);
    return {
      sdkAppId,
      userId,
      roomId: channel.roomId,
      userSig,
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
