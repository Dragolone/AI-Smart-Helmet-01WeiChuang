import { Inject, Injectable, Logger } from '@nestjs/common';
import { errorMessage } from '../common/error-text';
import { withTimeout } from '../common/with-timeout';
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
  notifyTimeoutMs,
} from './sos.constants';
import { toWireSos } from './sos-wire';

/** 本人终态 Push 的标题按联系人短信的实际投递结果生成（审计 SOS-04：不能把「任务已创建」说成「已收到通知」） */
export const PUSH_TITLE = {
  contactsNotified: 'SOS 已通知紧急联系人',
  contactsFailed: 'SOS 紧急联系人通知发送失败',
  noContacts: 'SOS 未设置紧急联系人',
} as const;

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
  async finalizeNotified(
    sosId: string,
    options: { deliverInline?: boolean } = {},
  ): Promise<boolean> {
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
    // 扫描任务传 deliverInline=false：到期终态化只写库、不在这里等第三方，投递由扫描的独立阶段负责。
    // 内联首投的异常不能外抛（审计 SOS-06）：终态化已提交即视为成功，投递问题由扫描按通知行续投；
    // 否则 confirm 会给 App 回 500，而服务端其实已 notified，用户再点一次只会得到 409。
    if (options.deliverInline !== false) {
      try {
        await this.deliverPending(sosId);
      } catch (err) {
        this.logger.error(
          `SOS ${sosId} 终态化后首轮投递异常（状态已 notified，由扫描续投）：${errorMessage(err)}`,
        );
      }
    }
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
      // 顺序是业务约束不是口味：push 正文按「此刻短信的真实结果」生成（见 pushText），
      // 短信必须先投，否则用户会收到「短信全部失败，请直接拨打电话求助」而短信其实马上就成功了。
      // 两行在同一事务创建 → Postgres now() 取事务开始时间 → createdAt 完全相同，单按它排序
      // 区分不了先后（同 DBOPS-01 的缺少唯一次序键）。channel desc 把 'sms' 排在 'push' 前，
      // id 兜底保证全序稳定；take 也因此优先装满短信行。
      orderBy: [{ channel: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
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
        // 挂起的第三方调用按失败记 lastError=…timeout，走既有重试，不占住扫描任务（审计 SOS-05）
        await withTimeout(
          this.send(row, row.sos),
          notifyTimeoutMs(),
          `sos.notify(${row.channel})`,
        );
        await this.prisma.sosNotification.update({
          where: { id: row.id },
          // 重试成功后清掉上一次的错误：详情页不能同时显示「已发送」和旧错误文本（审计 SOS-08）
          data: {
            status: NOTIFICATION_STATUS.sent,
            sentAt: new Date(),
            lastError: null,
          },
        });
      } catch (err) {
        const message = errorMessage(err);
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
    // push target 形如 user:<id>。标题/正文按此刻联系人短信的真实结果生成：
    // 通知行按 createdAt 顺序投递，短信行在本人 Push 之前，所以这里读到的是本轮投递后的状态
    const { title, body } = await this.pushText(sosCase);
    await this.push.send(row.target.replace(/^user:/, ''), title, body, {
      sosId: sosCase.id,
      deviceId: sosCase.deviceId,
    });
  }

  /** 四层语义区分（审计 SOS-04）：任务已创建 ≠ Provider 已接收 ≠ 联系人已收到；文案只承诺前两者 */
  private async pushText(
    sosCase: SosCase,
  ): Promise<{ title: string; body: string }> {
    const sms = await this.prisma.sosNotification.findMany({
      where: { sosId: sosCase.id, channel: 'sms' },
      select: { status: true },
    });
    const at = sosCase.finalizedAt?.toISOString() ?? '';
    if (sms.length === 0) {
      return {
        title: PUSH_TITLE.noContacts,
        body: `头盔 ${sosCase.deviceId} 的求救已于 ${at} 确认，但你尚未设置紧急联系人，无人会收到短信，请直接拨打电话求助`,
      };
    }
    const sent = sms.filter(
      (r) => r.status === NOTIFICATION_STATUS.sent,
    ).length;
    if (sent === 0) {
      return {
        title: PUSH_TITLE.contactsFailed,
        body: `头盔 ${sosCase.deviceId} 的求救已于 ${at} 确认，向 ${sms.length} 位紧急联系人发送短信全部失败，系统会自动重试，请直接拨打电话求助`,
      };
    }
    return {
      title: PUSH_TITLE.contactsNotified,
      body: `头盔 ${sosCase.deviceId} 的求救已于 ${at} 向 ${sent}/${sms.length} 位紧急联系人发出短信通知${sent < sms.length ? '（其余失败，系统会自动重试）' : ''}`,
    };
  }

  /**
   * SOS 通知消息：短信本身是固定文案、不带变量（决策 #46，腾讯云新建通知类模板禁止变量）；
   * 昵称 / 触发时间 / 位置照常算好放进 params，给后续带位置的渠道用（语音通知 / 分享链接）。
   * 昵称截 10 字、时间短格式沿用原变量限长口径，渠道接入时不用再改。
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
