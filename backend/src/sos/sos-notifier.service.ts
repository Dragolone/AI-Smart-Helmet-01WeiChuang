import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PUSH_PROVIDER, type PushProvider } from '../providers/push.provider';
import {
  SMS_PROVIDER,
  maskPhone,
  type SmsProvider,
} from '../providers/sms.provider';
import { RealtimePushService } from '../realtime/realtime-push.service';
import type { SosCase, SosNotification } from '../generated/prisma/client';
import {
  NOTIFICATION_STATUS,
  SOS_STATUS,
  maxNotifyAttempts,
} from './sos.constants';
import { toWireSos } from './sos-wire';

/**
 * SOS 终态化与通知投递。confirm（SOS Now）、deadline 到期、pending 中设备再发 manual_sos
 * 三条路都走 finalizeNotified()——竞态安全全靠这里的条件更新。
 */
@Injectable()
export class SosNotifierService {
  private readonly logger = new Logger(SosNotifierService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimePushService,
    @Inject(SMS_PROVIDER) private readonly sms: SmsProvider,
    @Inject(PUSH_PROVIDER) private readonly push: PushProvider,
  ) {}

  /**
   * pending → notified（条件更新，cancel/重复终态化的竞态只有一方赢），并在同一事务里
   * 铺好通知任务行——事务提交后即使进程崩溃，扫描任务也能按行续投，通知不丢。
   * 返回 false = 没抢到转换（已取消或已通知）。
   */
  async finalizeNotified(sosId: string): Promise<boolean> {
    const finalized = await this.prisma.$transaction(async (tx) => {
      const won = await tx.sosCase.updateMany({
        where: { id: sosId, status: SOS_STATUS.pending },
        data: { status: SOS_STATUS.notified, finalizedAt: new Date() },
      });
      if (won.count === 0) return null;

      const sosCase = await tx.sosCase.findUniqueOrThrow({
        where: { id: sosId },
      });
      const contacts = await tx.emergencyContact.findMany({
        where: { userId: sosCase.userId, deletedAt: null },
        orderBy: { createdAt: 'asc' },
      });
      // 同号去重：两个联系人填同一手机号只发一条，避免同内容轰炸
      const seen = new Set<string>();
      for (const c of contacts) {
        if (seen.has(c.phone)) continue;
        seen.add(c.phone);
        await tx.sosNotification.create({
          data: {
            sosId,
            channel: 'sms',
            target: c.phone,
            contactName: c.name,
          },
        });
      }
      // 本人终态 Push 也走任务行（可重试留档）；WS 即时推送在事务外
      await tx.sosNotification.create({
        data: { sosId, channel: 'push', target: `user:${sosCase.userId}` },
      });
      return sosCase;
    });

    if (!finalized) return false;
    this.logger.warn(
      `SOS ${sosId} 已终态化 notified（device=${finalized.deviceId}），开始投递通知`,
    );
    this.realtime.pushSosUpdate(finalized.userId, toWireSos(finalized));
    await this.deliverPending(sosId);
    return true;
  }

  /**
   * 投递可重试的通知行（pending/failed 且 attempts < 上限；仅限已 notified 的 SOS）。
   * 扫描任务每轮也会调用——首投失败或进程崩溃后由这里续投。
   * attempts 先占位再发送（条件更新防重叠扫描双发）：宁可少发一次，不可无限重发。
   */
  async deliverPending(sosId?: string): Promise<void> {
    const rows = await this.prisma.sosNotification.findMany({
      where: {
        ...(sosId ? { sosId } : {}),
        status: {
          in: [NOTIFICATION_STATUS.pending, NOTIFICATION_STATUS.failed],
        },
        attempts: { lt: maxNotifyAttempts() },
        sos: { status: SOS_STATUS.notified },
      },
      include: { sos: true },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });

    for (const row of rows) {
      const claimed = await this.prisma.sosNotification.updateMany({
        where: {
          id: row.id,
          attempts: row.attempts,
          status: {
            in: [NOTIFICATION_STATUS.pending, NOTIFICATION_STATUS.failed],
          },
        },
        data: { attempts: { increment: 1 } },
      });
      if (claimed.count === 0) continue; // 另一轮扫描已抢走这一次投递

      try {
        await this.send(row, row.sos);
        await this.prisma.sosNotification.update({
          where: { id: row.id },
          data: { status: NOTIFICATION_STATUS.sent, sentAt: new Date() },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `SOS 通知投递失败（第 ${row.attempts + 1} 次，channel=${row.channel}，target=${this.maskTarget(row)}）：${message}`,
        );
        await this.prisma.sosNotification.update({
          where: { id: row.id },
          data: { status: NOTIFICATION_STATUS.failed, lastError: message },
        });
      }
    }
  }

  private async send(row: SosNotification, sosCase: SosCase): Promise<void> {
    if (row.channel === 'sms') {
      await this.sms.send(row.target, this.smsContent(row, sosCase));
      return;
    }
    // push target 形如 user:<id>
    await this.push.send(
      row.target.replace(/^user:/, ''),
      'SOS 已通知紧急联系人',
      `头盔 ${sosCase.deviceId} 的求救已于 ${sosCase.finalizedAt?.toISOString() ?? ''} 通知紧急联系人`,
      { sosId: sosCase.id, deviceId: sosCase.deviceId },
    );
  }

  /** 短信正文：给紧急联系人的最小必要信息（触发方式 + 位置）。真实 Provider 接入后原样照发。 */
  private smsContent(row: SosNotification, c: SosCase): string {
    const trigger =
      c.triggerType === 'manual_sos' ? '手动触发求救' : '疑似摔倒';
    const location =
      c.latitude !== null && c.longitude !== null
        ? `位置(${c.coordinateSystem ?? 'wgs84'})：${c.latitude.toFixed(5)},${c.longitude.toFixed(5)}`
        : '位置暂不可用';
    const name = row.contactName ? `${row.contactName}您好：` : '';
    return `【AI头盔】${name}您的联系人佩戴的头盔(${c.deviceId})${trigger}，倒计时结束未取消。${location}。请尽快联系确认安全。`;
  }

  /** 日志脱敏（Security Rules）：手机号打码；push target 本身不含敏感信息 */
  private maskTarget(row: SosNotification): string {
    return row.channel === 'sms' ? maskPhone(row.target) : row.target;
  }
}
