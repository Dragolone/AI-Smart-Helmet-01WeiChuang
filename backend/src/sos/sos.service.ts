import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  AccidentDetail,
  AccidentListItem,
  ActiveSosResponse,
  Paginated,
  Sos,
} from '@helmet/shared';
import { ensureDeviceOwned } from '../devices/device-access';
import type { SosCase } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimePushService } from '../realtime/realtime-push.service';
import { SOS_STATUS } from './sos.constants';
import { SosNotifierService } from './sos-notifier.service';
import { toWireAccident, toWireNotification, toWireSos } from './sos-wire';

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
    await ensureDeviceOwned(this.prisma, userId, deviceId);
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

  /** 事故记录列表（含已取消供留档，最新在前）；按 deviceId+userId 双过滤——换绑后新主看不到旧主的事故 */
  async accidents(
    userId: string,
    deviceId: string,
    page: number,
    pageSize: number,
  ): Promise<Paginated<AccidentListItem>> {
    await ensureDeviceOwned(this.prisma, userId, deviceId);
    const where = { deviceId, userId };
    const [total, cases] = await this.prisma.$transaction([
      this.prisma.sosCase.count({ where }),
      this.prisma.sosCase.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return { items: cases.map(toWireAccident), total, page, pageSize };
  }

  /** 事故详情：触发事件原始 payload（raw 留档）+ 通知发送记录（target 脱敏） */
  async accidentDetail(
    userId: string,
    accidentId: string,
  ): Promise<AccidentDetail> {
    const sosCase = await this.prisma.sosCase.findUnique({
      where: { id: accidentId },
    });
    if (!sosCase || sosCase.userId !== userId) {
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: '事故记录不存在',
      });
    }
    const [rawEvent, notifications] = await this.prisma.$transaction([
      this.prisma.rawEvent.findUnique({
        where: {
          deviceId_eventId: {
            deviceId: sosCase.deviceId,
            eventId: sosCase.triggerEventId,
          },
        },
        select: { payload: true },
      }),
      this.prisma.sosNotification.findMany({
        where: { sosId: accidentId },
        orderBy: { createdAt: 'asc' },
      }),
    ]);
    return {
      ...toWireAccident(sosCase),
      triggerPayload:
        (rawEvent?.payload as Record<string, unknown> | undefined) ?? null,
      notifications: notifications.map(toWireNotification),
    };
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
