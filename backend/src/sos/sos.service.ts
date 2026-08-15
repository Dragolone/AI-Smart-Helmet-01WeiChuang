import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { ActiveSosResponse, Sos } from '@helmet/shared';
import type { SosCase } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimePushService } from '../realtime/realtime-push.service';
import { SOS_STATUS } from './sos.constants';
import { SosNotifierService } from './sos-notifier.service';
import { toWireSos } from './sos-wire';

const notFound = () =>
  new NotFoundException({ code: 'NOT_FOUND', message: 'SOS 不存在' });

const alreadyFinalized = () =>
  new ConflictException({
    code: 'SOS_ALREADY_FINALIZED',
    message: 'SOS 已是终态（已通知或已取消）',
  });

@Injectable()
export class SosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifier: SosNotifierService,
    private readonly realtime: RealtimePushService,
  ) {}

  /** 当前进行中 SOS；无则 sos: null（200，与 locations/latest 同口径，定稿） */
  async active(userId: string, deviceId: string): Promise<ActiveSosResponse> {
    // 归属校验与 §4/§5 同口径：非本人绑定设备一律 DEVICE_NOT_FOUND，不泄露存在性
    const device = await this.prisma.device.findUnique({
      where: { deviceId },
      select: { bindUserId: true },
    });
    if (!device || device.bindUserId !== userId) {
      throw new NotFoundException({
        code: 'DEVICE_NOT_FOUND',
        message: '设备不存在或未绑定到当前用户',
      });
    }
    const active = await this.prisma.sosCase.findFirst({
      where: { deviceId, userId, status: SOS_STATUS.pending },
    });
    return { sos: active ? toWireSos(active) : null };
  }

  /** 取消（仅 pending；与扫描到期竞态时条件更新只有一方赢） */
  async cancel(userId: string, sosId: string): Promise<Sos> {
    const sosCase = await this.getOwned(userId, sosId);
    if (sosCase.status !== SOS_STATUS.pending) throw alreadyFinalized();

    const won = await this.prisma.sosCase.updateMany({
      where: { id: sosId, status: SOS_STATUS.pending },
      data: { status: SOS_STATUS.cancelled, finalizedAt: new Date() },
    });
    // 没抢到 = 扫描任务刚把它通知了：如实返回 409，App 拉取最新状态
    if (won.count === 0) throw alreadyFinalized();

    const cancelled = await this.prisma.sosCase.findUniqueOrThrow({
      where: { id: sosId },
    });
    this.realtime.pushSosUpdate(userId, toWireSos(cancelled));
    return toWireSos(cancelled);
  }

  /** SOS Now：跳过剩余倒计时立即通知（仅 pending） */
  async confirm(userId: string, sosId: string): Promise<Sos> {
    const sosCase = await this.getOwned(userId, sosId);
    if (sosCase.status !== SOS_STATUS.pending) throw alreadyFinalized();

    const won = await this.notifier.finalizeNotified(sosId);
    if (!won) throw alreadyFinalized();

    const notified = await this.prisma.sosCase.findUniqueOrThrow({
      where: { id: sosId },
    });
    return toWireSos(notified);
  }

  /** 归属：取消/确认权限以建单时固化的 userId 为准（解绑不影响进行中 SOS 的处置权） */
  private async getOwned(userId: string, sosId: string): Promise<SosCase> {
    const sosCase = await this.prisma.sosCase.findUnique({
      where: { id: sosId },
    });
    if (!sosCase || sosCase.userId !== userId) throw notFound();
    return sosCase;
  }
}
