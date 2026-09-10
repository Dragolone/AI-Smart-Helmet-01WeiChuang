import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PUSH_PROVIDER, type PushProvider } from '../providers/push.provider';
import {
  SMS_PROVIDER,
  maskPhone,
  type SmsMessage,
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
      await this.sms.send(row.target, await this.smsMessage(sosCase));
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

  /**
   * 短信模板变量（sos_alert：{1} 佩戴者昵称 {2} 触发时间 {3} 位置）——运营商模板只收变量不收自由文本。
   * 昵称截到 10 字、时间用短格式：腾讯云模板变量默认限长（THIRD_PARTY.md §4），超长整条拒发。
   */
  private async smsMessage(c: SosCase): Promise<SmsMessage> {
    const user = await this.prisma.user.findUnique({
      where: { id: c.userId },
      select: { nickname: true, phone: true },
    });
    // 没昵称时回落为脱敏手机号（11 字符，在腾讯云变量默认 12 字符限内；家属认得出号码，认不出 deviceId）
    const nickname =
      user?.nickname?.trim().slice(0, 10) ||
      (user ? maskPhone(user.phone) : c.deviceId.slice(0, 10));
    const at = c.finalizedAt ?? new Date();
    const triggeredAt = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
      .format(at)
      .replace(/\//g, '-');
    const locationText =
      c.latitude !== null && c.longitude !== null
        ? `${c.latitude.toFixed(5)},${c.longitude.toFixed(5)}`
        : '暂不可用';
    return {
      template: 'sos_alert',
      params: { nickname, triggeredAt, locationText },
    };
  }

  /** 日志脱敏（Security Rules）：手机号打码；push target 本身不含敏感信息 */
  private maskTarget(row: SosNotification): string {
    return row.channel === 'sms' ? maskPhone(row.target) : row.target;
  }
}
